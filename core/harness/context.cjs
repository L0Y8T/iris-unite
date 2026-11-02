/* 上下文装配：Inline & Spill。
 *
 * 这个模块解决的是"每一轮模型到底该看见多少东西"。
 *
 * 现状（可测的事实）：
 *   - core/collaboration.cjs 第 41 行：每阶段把 outlines / reviews / revisions 全部
 *     JSON.stringify 进 prompt，每个参与者都收一份全量；
 *   - core/research.cjs 第 506 行：同样 JSON.stringify(materials)；
 *   - 两侧都再接 24 万字符的历史（providers.cjs 的 contextFor）。
 * 于是 token 随"阶段数 × 模型数"增长，而其中大部分内容这一步根本用不到。
 *
 * Inline & Spill 的思路（借自 dsh-superagent 的 docs/001-domain.md 与团队文章）：
 *   高频用到的信息直接内联进上下文；长内容截断后留续读入口；每个对象内联下一跳的 id，
 *   模型可以顺着 id 链式召回。文章原话是"浪费上下文窗口，就是浪费模型的智能"。
 *
 * 落到本模块的三条规则：
 *   1. 单项不超过 itemInline 就全文内联——短材料不该付二跳的成本；
 *   2. 超过就只放头部（+尾部），并附一行可直接照抄的续读句柄；
 *   3. 总预算超了，从最长的那项开始降级，直到落回预算内。
 *
 * 装配结果是确定的：同样的输入必然得到同样的文本与 digest。账本记 digest，
 * 于是"这一步模型看到的是哪份上下文"可以事后核对。
 */
const { createHash } = require('node:crypto');

const DEFAULT_LIMITS = {
  /* 整段上下文软上限（字符）。与 providers.cjs 的 24 万历史预算同量级，
     但这是"材料部分"的独立预算，不再和历史抢额度。 */
  total: 120000,
  /* 单项全文内联的上限：再长就溢出。 */
  itemInline: 6000,
  /* 溢出项保留的头部与尾部长度。头部给结论，尾部常是结论/表格收口。 */
  itemHead: 1200,
  itemTail: 400
};

function clipped(text, head, tail) {
  const body = String(text == null ? '' : text);
  if (body.length <= head + tail + 16) return { text: body, clipped: false, omitted: 0 };
  const headPart = body.slice(0, head).trimEnd();
  const tailPart = tail > 0 ? body.slice(body.length - tail).trimStart() : '';
  const omitted = body.length - headPart.length - tailPart.length;
  return {
    text: tailPart ? `${headPart}\n…〔此处省略 ${omitted} 字〕…\n${tailPart}` : `${headPart}\n…〔此处省略 ${omitted} 字〕…`,
    clipped: true,
    omitted
  };
}

function digestOf(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

function normalize(part, index) {
  const text = String(part.text == null ? '' : part.text);
  const summary = String(part.summary == null ? '' : part.summary);
  return {
    index,
    kind: part.kind || (part.id ? 'artifact' : 'text'),
    title: String(part.title || `材料 ${index + 1}`).slice(0, 120),
    id: part.id || null,
    chars: text.length || summary.length,
    text,
    /* 只有摘要没有全文时，摘要就是全部可内联的内容。 */
    summary,
    hasFullText: text.length > 0,
    mode: 'inline',
    note: part.note || ''
  };
}

/**
 * 装配上下文。
 *
 * 入参：
 *   task      本步任务说明（必填，放最前）
 *   question  原始问题（可选；与材料里的同名文本不做去重，由调用方决定要不要传）
 *   parts     材料数组，每项 { title, text, summary?, id?, kind? }
 *   limits    覆盖 DEFAULT_LIMITS 的任意项
 *
 * 返回：
 *   text      可直接作为一条消息发出的完整文本
 *   stats     字符数、内联数、溢出数、降级次数
 *   spill     被溢出的材料清单（id / 标题 / 总字数 / 续读句柄）
 *   digest    装配结果指纹，记账本用
 */
function assemble({ task, question, parts = [], limits = {} } = {}) {
  const bound = { ...DEFAULT_LIMITS, ...limits };
  const items = parts.map(normalize);
  let downgraded = 0;

  for (const item of items) {
    if (!item.hasFullText && item.summary) {
      // 只有摘要的情况：摘要本身就是"可内联的限量版本"。
      item.mode = 'summary';
    } else if (item.chars <= bound.itemInline) {
      item.mode = 'inline';
    } else {
      item.mode = 'spill';
    }
  }

  const cost = () => items.reduce((sum, item) => {
    if (item.mode === 'inline') return sum + item.chars;
    if (item.mode === 'summary') return sum + item.summary.length;
    return sum + Math.min(item.chars, bound.itemHead + bound.itemTail);
  }, 0);

  // 超预算时按"当前占用最大"顺序降级：先砍最占地方的那项，降级次数最少。
  while (cost() > bound.total) {
    const candidates = items.filter(item => item.mode === 'inline');
    if (!candidates.length) break;
    candidates.sort((a, b) => b.chars - a.chars);
    candidates[0].mode = 'spill';
    downgraded += 1;
  }

  const blocks = [];
  if (task) blocks.push(`【任务】\n${String(task).trim()}`);
  if (question) blocks.push(`【原始问题】\n${String(question).trim()}`);

  const spill = [];
  if (items.length) {
    const rendered = items.map((item, i) => {
      const label = `[M${i + 1}]`;
      const meta = [item.id, `${item.chars} 字`].filter(Boolean).join('，');
      const head = `${label} ${item.title}${meta ? `（${meta}）` : ''}`;

      if (item.mode === 'inline') {
        return `${head}\n${item.text.trim()}`;
      }
      if (item.mode === 'summary') {
        return `${head}\n摘要：${item.summary.trim()}${item.note ? `\n${item.note}` : ''}`;
      }
      const { text } = clipped(item.text, bound.itemHead, bound.itemTail);
      /* 续读句柄：模型可以原样照抄调用。没有 id 的溢出项只能靠调用方另行提供，明确说出来。 */
      const handle = item.id
        ? `〔全文 ${item.chars} 字，此处只给首尾；续读：read_artifact id=${item.id} offset=${bound.itemHead}〕`
        : `〔全文 ${item.chars} 字，此处只给首尾；本项无产物 id，无法续读，需要细节请重新索取〕`;
      spill.push({ id: item.id, title: item.title, chars: item.chars, offsetHint: bound.itemHead });
      return `${head}\n${text}\n${handle}`;
    });
    blocks.push(`【材料】\n${rendered.join('\n\n')}`);
  }

  const text = blocks.join('\n\n');
  return {
    text,
    digest: digestOf(text),
    stats: {
      chars: text.length,
      budget: bound.total,
      items: items.length,
      inlined: items.filter(item => item.mode === 'inline').length,
      summarized: items.filter(item => item.mode === 'summary').length,
      spilled: items.filter(item => item.mode === 'spill').length,
      downgraded
    },
    spill
  };
}

module.exports = { assemble, clipped, digestOf, DEFAULT_LIMITS };
