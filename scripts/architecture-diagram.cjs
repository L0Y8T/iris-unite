/* 生成「当前科研流程」图（SVG），再由 Electron 离屏渲染成 PNG。
 *
 * 为什么用脚本画：环节名、顺序、哪些环节消耗调用，全部从 core/research.cjs 的
 * STAGES 读取。改了流程重跑一次就同步，不会出现「图和代码对不上」。
 * 产出物与说明文字是人工撰写的语义描述，改动流程时请一起检查。
 *
 * 文字按估算宽度折行，并且所有列宽加起来不超过画布宽度 —— 否则 SVG 里的文字
 * 会溢出 viewBox，把导出的 PNG 一起撑宽、错位。
 *
 *   node scripts/architecture-diagram.cjs
 *   → docs/research-architecture.svg
 */
const fs = require('node:fs');
const path = require('node:path');
const { STAGES } = require('../core/research.cjs');
const profiles = require('../core/profiles.cjs');

const PHASE_ORDER = ['检索', '推演', '成文', '校验'];

const PHASE_NOTE = {
  检索: '真实学术接口，无需密钥；这一阶段决定后面能用什么证据。',
  推演: '每个环节独立选模型与强度；同阶段任务并行，任一失败即取消其余。',
  成文: '只产出一份可交付答案，中间材料不进正文。',
  校验: '机械环节：不调用模型、不消耗预算，但结论写进答案页脚。'
};

/* 每个阶段的产出。跟 STAGES 的 phase 对应。 */
const OUTPUTS = {
  检索: [
    { title: '研究问题与检索式', detail: '目标、研究问题、2–6 条检索式、纳入与排除标准' },
    { title: '资料库 S1…Sn', detail: '真实题录：标题、作者、年份、期刊、DOI 或 arXiv、摘要', strong: true },
    { title: '证据表', detail: '结论对应引用键；强度分强 / 中 / 弱；单列证据缺口' }
  ],
  推演: [
    { title: '任务分配', detail: '每项任务的职责、交付物、依赖的证据键' },
    { title: '并行研究成果', detail: '各项任务的路线、机制、可证伪方案与风险' },
    { title: '筛选与深化', detail: '保留候选、深化要求、缺乏证据的结论' }
  ],
  成文: [
    { title: '唯一完整答案', detail: '结论、假设、待验证问题分层；正文引用只写 [S3] 形式' }
  ],
  校验: [
    { title: '核验报告', detail: '可核验 X 处 / 移除 Y 处无法核验的引用', strong: true },
    { title: '自检结论', detail: '预算、证据覆盖、编造痕迹；可选一次模型复核' }
  ]
};

const FILL = { 检索: '#eef4ff', 推演: '#f4f5f7', 成文: '#ffffff', 校验: '#f7f8fa' };
const C = {
  ink: '#0f1115', secondary: '#61666b', muted: '#6d7278',
  hair: '#0000001f', soft: '#00000012', accent: '#2563eb', accentSoft: '#eaf2ff',
  canvas: '#ffffff', band: '#f9fafb'
};

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* 画布与三栏几何：各列宽度相加必须 ≤ WIDTH - 2*PAD */
const WIDTH = 1240;
const PAD = 56;
const GAP = 26;
const COL_LABEL = PAD + 22;
const LABEL_W = 210;
const COL_STAGE = PAD + 258;
const STAGE_W = 452;
const COL_OUT = COL_STAGE + STAGE_W + 34;
const OUT_W = WIDTH - PAD - COL_OUT;
const STAGE_H = 52;
const STAGE_GAP = 9;
const OUT_H = 58;
const OUT_GAP = 8;

/** 估算一段文字的像素宽度：中日韩字符按 1em，其余按 0.55em。 */
function textWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    w += (code > 0x2e80 && code < 0xfe70) || code === 0x2014 || code === 0x2018 || code === 0x2019 || code === 0x201c || code === 0x201d ? fontSize : fontSize * 0.55;
  }
  return w;
}

/** 按像素宽度折行，最多 maxLines 行，超出用省略号。 */
function wrap(text, maxPx, fontSize, maxLines = 1) {
  const lines = [];
  let line = '';
  for (const ch of String(text)) {
    const next = line + ch;
    if (textWidth(next, fontSize) > maxPx && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else line = next;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    const consumed = lines.join('').length;
    if (consumed < String(text).length) lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, '…');
  }
  return lines.length ? lines : [''];
}

function groups() {
  return PHASE_ORDER
    .map(phase => ({ phase, stages: STAGES.filter(s => s.phase === phase), outputs: OUTPUTS[phase] || [] }))
    .filter(g => g.stages.length);
}

function bandHeight(g) {
  const stagesH = g.stages.length * STAGE_H + (g.stages.length - 1) * STAGE_GAP;
  const outsH = g.outputs.length * OUT_H + (g.outputs.length - 1) * OUT_GAP;
  return 56 + Math.max(stagesH, outsH) + 18;
}

/* 三档路线：路线与预算都从 core/profiles.cjs 取，图上不另写一份规则。 */
function profileRows() {
  return profiles.PROFILE_IDS.map(id => {
    const info = profiles.PROFILE_INFO[id];
    const config = profiles.defaultsFor(id, {}, () => null);
    const stages = profiles.stagesOf(id, { allowRefinement: info.refinementAllowed });
    const chain = stages.map(stageId => profiles.STAGE_META[stageId].label).join(' → ');
    return { id, name: info.name, chain, base: profiles.baseCalls(config), implemented: profiles.isImplemented(id), outputRole: profiles.STAGE_META[profiles.ROLE_STAGE[info.outputRole]]?.label || info.outputRole };
  });
}
const PROFILE_ROW_H = 30;
const PROFILE_BAND_H = 52 + PROFILE_ROW_H * 3 + 14;

function render() {
  const all = groups();
  const modelCalls = STAGES.filter(s => s.kind === 'model').length;
  const localStages = STAGES.filter(s => s.kind === 'local').length;
  const rows = profileRows();
  const p = [];

  const intro1 = '先检索真实文献建立资料库，再在证据范围内推演，最后把每处引用核对回资料库。';
  const intro2 = `共 ${STAGES.length} 个环节，其中 ${localStages} 个是机械环节；档位决定这一轮跑哪几个环节，环节内部的模型与推理强度逐个可选。`;
  const intro3 = '本图由 core/research.cjs 的 STAGES 与 core/profiles.cjs 的三档规则生成：改完流程重跑 npm run diagram 即可同步。';
  const introLines = [
    ...wrap(intro1, WIDTH - PAD * 2, 14.5, 1),
    ...wrap(intro2, WIDTH - PAD * 2, 13.5, 1),
    ...wrap(intro3, WIDTH - PAD * 2, 12, 1)
  ];
  const headerH = 92 + introLines.length * 22;
  const footerH = 128;
  const bandsH = all.reduce((sum, g) => sum + bandHeight(g), 0) + GAP * (all.length - 1);
  const height = headerH + PROFILE_BAND_H + 20 + bandsH + footerH + 40;

  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">`);
  p.push(`<rect width="${WIDTH}" height="${height}" fill="${C.canvas}"/>`);

  /* 标题区 */
  p.push(`<text x="${PAD}" y="56" font-size="29" font-weight="600" fill="${C.ink}">Iris Unite 科研流程</text>`);
  introLines.forEach((line, i) => {
    const size = [14.5, 13.5, 12][i] || 12;
    p.push(`<text x="${PAD}" y="${84 + i * 22}" font-size="${size}" fill="${i === 0 ? C.secondary : C.muted}">${esc(line)}</text>`);
  });

  /* 三档路线带 */
  const py = headerH;
  const bw = WIDTH - PAD * 2;
  p.push(`<rect x="${PAD}" y="${py}" width="${bw}" height="${PROFILE_BAND_H}" rx="16" fill="${C.band}" stroke="${C.hair}" stroke-width="0.5"/>`);
  p.push(`<text x="${PAD + 20}" y="${py + 26}" font-size="13" font-weight="600" fill="${C.ink}">三档路线</text>`);
  p.push(`<text x="${PAD + 96}" y="${py + 26}" font-size="11" fill="${C.muted}">同一套环节，按档位裁剪；基准调用是正常成功路径，不含可选深化</text>`);
  rows.forEach((row, i) => {
    const ry = py + 52 + i * PROFILE_ROW_H;
    p.push(`<text x="${PAD + 20}" y="${ry}" font-size="12.5" font-weight="600" fill="${row.implemented ? C.ink : C.muted}">${esc(row.name)}</text>`);
    const tag = row.implemented ? `基准 ${row.base} 次` : '本期未实现';
    const tagW = row.implemented ? 62 : 66;
    const tagX = PAD + bw - tagW - 20;
    p.push(`<rect x="${tagX}" y="${ry - 15}" width="${tagW}" height="20" rx="10" fill="${row.implemented ? C.accentSoft : C.soft}" stroke="${row.implemented ? '#c7dcff' : C.hair}" stroke-width="0.5"/>`);
    p.push(`<text x="${tagX + tagW / 2}" y="${ry - 1}" font-size="10.5" text-anchor="middle" fill="${row.implemented ? C.accent : C.muted}">${esc(tag)}</text>`);
    wrap(row.chain, tagX - (PAD + 78) - 16, 11, 1).forEach(line => {
      p.push(`<text x="${PAD + 78}" y="${ry}" font-size="11" fill="${row.implemented ? C.secondary : C.muted}">${esc(line)}</text>`);
    });
  });

  /* 栏头 */
  const colY = headerH + PROFILE_BAND_H + 20;
  p.push(`<text x="${COL_STAGE}" y="${colY - 16}" font-size="11.5" font-weight="600" fill="${C.muted}">环节（★ 可独立选模型）</text>`);
  p.push(`<text x="${COL_OUT}" y="${colY - 16}" font-size="11.5" font-weight="600" fill="${C.muted}">产出物</text>`);

  let y = colY;
  all.forEach((g, index) => {
    const h = bandHeight(g);
    p.push(`<rect x="${PAD}" y="${y}" width="${WIDTH - PAD * 2}" height="${h}" rx="16" fill="${FILL[g.phase] || C.canvas}" stroke="${C.hair}" stroke-width="0.5"/>`);

    /* 阶段名与说明 */
    p.push(`<text x="${COL_LABEL}" y="${y + 28}" font-size="14" font-weight="600" fill="${C.ink}">${esc(g.phase)}</text>`);
    wrap(PHASE_NOTE[g.phase] || '', LABEL_W, 11, 3).forEach((line, i) => {
      p.push(`<text x="${COL_LABEL}" y="${y + 47 + i * 15}" font-size="11" fill="${C.muted}">${esc(line)}</text>`);
    });

    /* 环节卡片 */
    let sy = y + 44;
    for (const stage of g.stages) {
      const local = stage.kind === 'local';
      p.push(`<rect x="${COL_STAGE}" y="${sy}" width="${STAGE_W}" height="${STAGE_H}" rx="11" fill="${C.canvas}" stroke="${C.hair}" stroke-width="0.5"/>`);
      p.push(`<text x="${COL_STAGE + 16}" y="${sy + 22}" font-size="13.5" font-weight="600" fill="${C.ink}">${esc((local ? '' : '★ ') + stage.label)}</text>`);
      const tag = local ? '不消耗调用' : '1 次调用';
      const tagW = local ? 78 : 64;
      const tagX = COL_STAGE + STAGE_W - tagW - 14;
      p.push(`<rect x="${tagX}" y="${sy + 16}" width="${tagW}" height="20" rx="10" fill="${local ? C.accentSoft : C.band}" stroke="${C.hair}" stroke-width="0.5"/>`);
      p.push(`<text x="${tagX + tagW / 2}" y="${sy + 30}" font-size="10.5" text-anchor="middle" fill="${local ? C.accent : C.secondary}">${tag}</text>`);
      const detailMax = STAGE_W - 32 - tagW - 12;
      wrap(stage.detail, detailMax, 11, 1).forEach(line => {
        p.push(`<text x="${COL_STAGE + 16}" y="${sy + 39}" font-size="11" fill="${C.muted}">${esc(line)}</text>`);
      });
      sy += STAGE_H + STAGE_GAP;
    }

    /* 产出物卡片 */
    let oy = y + 44;
    for (const out of g.outputs) {
      p.push(`<rect x="${COL_OUT}" y="${oy}" width="${OUT_W}" height="${OUT_H}" rx="10" fill="${out.strong ? C.accentSoft : C.canvas}" stroke="${out.strong ? '#c7dcff' : C.soft}" stroke-width="0.5"/>`);
      p.push(`<text x="${COL_OUT + 14}" y="${oy + 21}" font-size="12" font-weight="600" fill="${out.strong ? C.accent : C.ink}">${esc(out.title)}</text>`);
      wrap(out.detail, OUT_W - 28, 10.5, 2).forEach((line, i) => {
        p.push(`<text x="${COL_OUT + 14}" y="${oy + 38 + i * 14}" font-size="10.5" fill="${C.muted}">${esc(line)}</text>`);
      });
      oy += OUT_H + OUT_GAP;
    }

    /* 段间箭头 */
    if (index < all.length - 1) {
      const cx = COL_STAGE + 36;
      p.push(`<path d="M ${cx} ${y + h + 3} L ${cx} ${y + h + GAP - 4}" stroke="${C.soft}" stroke-width="1.5" fill="none"/>`);
      p.push(`<path d="M ${cx - 4.5} ${y + h + GAP - 10} L ${cx} ${y + h + GAP - 4} L ${cx + 4.5} ${y + h + GAP - 10}" stroke="${C.soft}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    y += h + (index < all.length - 1 ? GAP : 0);
  });

  /* 底部：贯穿全程的三件事 */
  const fy = y + 20;
  const fw = WIDTH - PAD * 2;
  p.push(`<rect x="${PAD}" y="${fy}" width="${fw}" height="88" rx="14" fill="${C.band}" stroke="${C.hair}" stroke-width="0.5"/>`);
  const items = [
    ['预算计数器', '每次调用前计数，失败也计数；终审固定预留一次，深化按余额裁剪并写明原因。'],
    ['低成本监控', '只读内存快照：停滞、重复产物、反复失败时停下并留下现场；破坏性动作需两次确认。'],
    ['核验回路', '引用核验阶段回查资料库：DOI、arXiv 号、引用键对不上的当场移除，绝不留在正文。']
  ];
  const colW = (fw - 48 - 32) / 3;
  items.forEach(([title, detail], i) => {
    const x = PAD + 24 + i * (colW + 16);
    p.push(`<text x="${x}" y="${fy + 28}" font-size="12" font-weight="600" fill="${C.ink}">${esc(title)}</text>`);
    wrap(detail, colW, 10.5, 3).forEach((line, li) => {
      p.push(`<text x="${x}" y="${fy + 47 + li * 14}" font-size="10.5" fill="${C.muted}">${esc(line)}</text>`);
    });
  });

  p.push(`<text x="${PAD}" y="${height - 16}" font-size="10.5" fill="${C.muted}">模型调用环节 ${modelCalls} 个 · 机械环节 ${localStages} 个 · 基准调用：速查 3 / 综述 任务数+5 / 教学 章数+5</text>`);
  p.push('</svg>');
  return p.join('\n');
}

const outDir = path.join(__dirname, '..', 'docs');
fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, 'research-architecture.svg');
fs.writeFileSync(target, render(), 'utf8');
console.log('wrote ' + target + '  (' + STAGES.length + ' stages, ' + WIDTH + 'px wide)');
