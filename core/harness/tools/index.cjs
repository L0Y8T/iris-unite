/* 工具箱：把工作区、执行器、核验器包成模型能调用的动作。
 *
 * 一条设计约束：能力靠注入，不靠 import。
 * 工具的存在与否就是这一轮的能力边界——没有注入 runExperiment，run_experiment 这个工具
 * 根本不会出现在提示词里。这比"注册全部工具、执行时再拒绝"诚实：模型不会反复尝试一个
 * 注定失败的动作，提示词也不会为不存在的能力浪费 token。
 *
 * 所有工具都返回 { ok, ... }，错误带 hint。模型据此自我纠正，见 protocol.cjs 的说明。
 */
const { createRegistry, ToolError } = require('./registry.cjs');

const DEFAULT_READ_LIMIT = 8000;

function clipResult(text, limit = DEFAULT_READ_LIMIT) {
  const body = String(text == null ? '' : text);
  if (body.length <= limit) return { text: body, truncated: false, chars: body.length };
  return {
    text: body.slice(0, limit) + `\n…〔已截断，原文 ${body.length} 字，只返回前 ${limit} 字〕`,
    truncated: true,
    chars: body.length
  };
}

/**
 * 建一个工具箱。
 * workspace   RunWorkspace 实例（必需）
 * capabilities 可选能力：{ listTemplates, checkBudget, runExperiment, verifyClaims,
 *                          checkIntegrity, searchLiterature }
 */
function createToolbox({ workspace, capabilities = {} } = {}) {
  if (!workspace) throw new Error('工具箱需要工作区');
  const registry = createRegistry();
  const has = name => typeof capabilities[name] === 'function';

  /* ---- 读取类：默认全部可用，它们只是查工作区 ---- */

  registry.define({
    name: 'read_artifact',
    summary: '按 id 读取一个产物的正文，支持从指定字符偏移续读。',
    permission: 'read',
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '产物 id，形如 art-1f4c7d9e' },
        offset: { type: 'integer', minimum: 0, maximum: 100000000, description: '从第几个字符开始读，默认 0' },
        limit: { type: 'integer', minimum: 1, maximum: 40000, description: '最多读多少字符，默认 8000' }
      },
      required: ['id'],
      additionalProperties: false
    },
    async execute({ id, offset = 0, limit = DEFAULT_READ_LIMIT }) {
      const page = workspace.readArtifact(id, { offset, limit });
      const tail = page.next == null
        ? `（已到结尾，共 ${page.total} 字）`
        : `（本次 ${page.offset}–${page.end} 字，共 ${page.total} 字；继续读用 offset=${page.next}）`;
      return {
        ok: true,
        result: {
          id: page.record.id,
          title: page.record.title,
          stage: page.record.stage,
          chars: page.total,
          offset: page.offset,
          next: page.next,
          text: page.text,
          note: tail
        }
      };
    }
  });

  registry.define({
    name: 'list_artifacts',
    summary: '列出本轮已有的产物（id、阶段、标题、字数、摘要）。不知道有什么可读时先调它。',
    permission: 'read',
    params: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: '只列某个阶段，例如 research-explore' },
        kind: { type: 'string', enum: ['note', 'final', 'data', 'log'], description: '只列某一类产物' }
      },
      additionalProperties: false
    },
    async execute({ stage, kind }) {
      const items = workspace.listArtifacts({ stage, kind });
      return {
        ok: true,
        result: items.map(item => ({
          id: item.id,
          stage: item.stage,
          title: item.title,
          kind: item.kind,
          chars: item.chars,
          summary: item.summary.slice(0, 200)
        }))
      };
    }
  });

  registry.define({
    name: 'search_artifacts',
    summary: '在所有产物里按关键词搜索，返回命中的行与上下文。比逐个读全文省得多。',
    permission: 'read',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '要搜的字词，不区分大小写' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回多少条命中，默认 12' }
      },
      required: ['query'],
      additionalProperties: false
    },
    async execute({ query, limit = 12 }) {
      const needle = String(query).toLowerCase();
      const hits = [];
      for (const record of workspace.listArtifacts()) {
        if (hits.length >= limit) break;
        let page;
        try { page = workspace.readArtifact(record.id); }
        catch { continue; }
        const lines = page.text.split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
          if (!lines[i].toLowerCase().includes(needle)) continue;
          hits.push({
            id: record.id,
            title: record.title,
            stage: record.stage,
            line: i + 1,
            text: lines.slice(Math.max(0, i - 1), i + 2).join('\n').slice(0, 600)
          });
        }
      }
      return { ok: true, result: { query, hits, note: hits.length ? '' : '没有命中；换个词，或先用 list_artifacts 看有什么。' } };
    }
  });

  /* ---- 写入类：模型可以在工作区里留笔记，这是它跨步的"草稿纸" ---- */

  registry.define({
    name: 'write_note',
    summary: '把一段中间结论写进本轮工作区（不占上下文），之后可用 id 再读回来。',
    permission: 'write',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120, description: '这段笔记的标题' },
        text: { type: 'string', minLength: 1, maxLength: 200000, description: '笔记正文' },
        stage: { type: 'string', description: '归到哪个阶段，默认 misc' }
      },
      required: ['title', 'text'],
      additionalProperties: false
    },
    async execute({ title, text, stage = 'misc' }) {
      const record = workspace.writeArtifact({ stage, title, text, kind: 'note' });
      return { ok: true, result: { id: record.id, title: record.title, chars: record.chars, stage: record.stage } };
    }
  });

  /* ---- 核验类：确定性检查交给程序，别让模型自己算 ---- */

  if (has('checkIntegrity')) {
    registry.define({
      name: 'check_integrity',
      summary: '重算全部产物的 sha256，确认盘上文件没有被改动过。',
      permission: 'read',
      params: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { ok: true, result: await capabilities.checkIntegrity() };
      }
    });
  }

  if (has('verifyClaims')) {
    registry.define({
      name: 'verify_claims',
      summary: '把一段正文里的实验数字与真实运行记录逐句核对，返回无法溯源的断言。',
      permission: 'read',
      params: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 100000, description: '待核验的正文' }
        },
        required: ['text'],
        additionalProperties: false
      },
      async execute({ text }) {
        const report = await capabilities.verifyClaims(text);
        return { ok: true, result: report };
      }
    });
  }

  /* ---- 实验类：执行是重能力，只在注入了执行器时出现 ---- */

  if (has('listTemplates')) {
    registry.define({
      name: 'list_templates',
      summary: '列出可运行的实验模板、它们的指标与参数范围。',
      permission: 'read',
      params: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { ok: true, result: await capabilities.listTemplates() };
      }
    });
  }

  if (has('checkBudget')) {
    registry.define({
      name: 'check_budget',
      summary: '查询今天的实验额度还剩多少，决定还能不能开新实验。',
      permission: 'read',
      params: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { ok: true, result: await capabilities.checkBudget() };
      }
    });
  }

  if (has('runExperiment')) {
    registry.define({
      name: 'run_experiment',
      summary: '按模板真跑一次实验，返回带 sha256 的运行记录（E 编号由记录侧分配）。',
      permission: 'execute',
      /* 它起子进程、吃 GPU、抢同一份运行目录与额度：同一时刻跑两个，测出来的数字互相污染，
         而且第二个大概率因抢显存失败。执行器在 loop.cjs 里会给它单开一道屏障。 */
      parallelSafe: false,
      /* 十件工具里只有这一件花真钱、占真机器，且跑完不可回滚——所以只有它要人点头。
         exec/budget.cjs 的日限额是事后兜底，等它拦住时钱已经花出去了。 */
      requiresConfirmation: true,
      params: {
        type: 'object',
        properties: {
          template: { type: 'string', minLength: 1, description: '模板 id，先调 list_templates 确认' },
          params: { type: 'object', description: '模板参数，键名与范围见 list_templates' },
          label: { type: 'string', maxLength: 80, description: '这次运行的展示名，例如 baseline' }
        },
        required: ['template'],
        additionalProperties: false
      },
      async execute({ template, params = {}, label }, ctx = {}) {
        /* 键名要对齐调用方的解构：main.cjs 的 experimentTools.run 收的是 templateId。
           这里传 template 的话，真机路径上 templateById(undefined) 会抛
           「未知的实验模板：undefined」——工具永远失败，而单元测试用假执行器发现不了。 */
        const manifest = await capabilities.runExperiment({ templateId: template, params, label, signal: ctx.signal });
        const summary = manifest && manifest.metrics
          ? Object.fromEntries(Object.entries(manifest.metrics).slice(0, 12))
          : null;
        return {
          ok: true,
          result: {
            runId: manifest && manifest.runId,
            status: manifest && manifest.status,
            exitCode: manifest && manifest.exitCode,
            metrics: summary,
            note: '数字只能引用这里出现过的值；要写进结论请附上对应的运行编号。'
          }
        };
      }
    });
  }

  /* ---- 检索类：联网能力单独挂，默认不启用 ---- */

  if (has('searchLiterature')) {
    registry.define({
      name: 'search_literature',
      summary: '检索公开学术题录（OpenAlex / Crossref / arXiv / PubMed），返回题录与摘要。',
      permission: 'network',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 400, description: '检索式' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多几条，默认 8' },
          yearFrom: { type: 'integer', minimum: 1900, maximum: 2200, description: '只要这一年及以后的文献' }
        },
        required: ['query'],
        additionalProperties: false
      },
      async execute({ query, limit = 8, yearFrom }, ctx = {}) {
        const result = await capabilities.searchLiterature({ query, limit, yearFrom, signal: ctx.signal });
        const records = (result && result.records) || [];
        return {
          ok: true,
          result: {
            records: records.slice(0, limit).map(item => ({
              title: item.title,
              authors: (item.authors || []).slice(0, 6),
              year: item.year,
              venue: item.venue,
              doi: item.doi,
              arxiv: item.arxiv,
              abstract: clipResult(item.abstract || '', 700).text
            })),
            errors: (result && result.errors) || [],
            note: records.length ? '' : '没有检索到记录；换检索式或放宽年份。'
          }
        };
      }
    });
  }

  return {
    specs: options => registry.specs(options),
    invoke: (name, args, ctx) => registry.invoke(name, args, ctx),
    has: name => registry.has(name),
    /* 执行器要按 parallelSafe 分组调度，所以要能按名字查到注册项（含 execute 与 parallelSafe）。 */
    get: name => registry.get(name)
  };
}

module.exports = { createToolbox, ToolError, clipResult, DEFAULT_READ_LIMIT };
