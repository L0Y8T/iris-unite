#!/usr/bin/env node
/* 一键跑全部验收。
 *
 *   npm run test:all                 # 全部（含真实模型调用，约 10–15 分钟，会消耗少量额度）
 *   npm run test:all -- --skip-live  # 跳过真实模型调用（离线可重复，约 4 分钟）
 *   npm run test:all -- --only=unit,retry,exec-gate
 *
 * 判据：
 *   - 进程退出码为 0；
 *   - 带 "passed":true 的脚本必须真的出现这个字段；
 *   - 输出里出现 FAILED: 一律算失败（哪怕退出码是 0）。
 *
 * 结果同时写到 artifacts/verification-report.json，便于对比历次。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const skipLive = argv.includes('--skip-live');
const onlyArg = argv.find(item => item.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean) : null;

/* live=true 表示会向真实模型发请求，消耗额度。 */
const STEPS = [
  { id: 'unit', name: '单元测试（211 项）', kind: 'npm', script: 'test', spend: '无', expect: 'fail 0', seconds: 75 },
  { id: 'platform', name: '三平台分支与路径', kind: 'node', file: 'tests/platform.test.cjs', spend: '无', expect: 'fail 0', seconds: 3 },
  { id: 'platform-runtime', name: '平台注入到渲染进程', kind: 'node', file: 'tests/runtime-probe.cjs', spend: '无（隔离数据目录）', expect: '"passed": true', seconds: 15 },
  { id: 'history', name: '本机历史读取', kind: 'node', file: 'tests/history-check.cjs', spend: '无', seconds: 9 },
  { id: 'live', name: '模型通道连通', kind: 'node', file: 'tests/live-check.cjs', spend: '真实调用 2 次', live: true, seconds: 16 },
  { id: 'retry', name: '重新生成与旧答案保留', kind: 'node', file: 'tests/retry-check.cjs', spend: '无（本地假模型）', expect: '"passed": true', seconds: 8 },
  { id: 'research-run', name: '科研 草稿→核验→发布', kind: 'node', file: 'tests/research-run-check.cjs', spend: '无（本地假模型）', expect: '"passed": true', seconds: 7 },
  { id: 'research-ui', name: '档位选择与计划预览', kind: 'node', file: 'tests/research-ui-check.cjs', spend: '无', expect: '"passed": true', seconds: 7 },
  { id: 'plan-ipc', name: '计划/档位接口', kind: 'node', file: 'tests/plan-ipc-check.cjs', spend: '无', expect: '"passed": true', seconds: 2 },
  { id: 'exec-ui', name: '实验面板（真跑一次）', kind: 'node', file: 'tests/exec-ui-check.cjs', spend: '无（真跑 Python）', expect: '"passed": true', seconds: 7 },
  { id: 'exec-gate', name: '实验→答案→数字门禁', kind: 'node', file: 'tests/exec-gate-check.cjs', spend: '无（真跑 Python + 假模型）', expect: '"passed": true', seconds: 5 },
  { id: 'export-ui', name: '一键导出结果', kind: 'node', file: 'tests/export-ui-check.cjs', spend: '无（隔离数据目录）', expect: '"passed": true', seconds: 20 },
  { id: 'pricing-ui', name: '花费估算（单价→金额）', kind: 'node', file: 'tests/pricing-ui-check.cjs', spend: '无（隔离数据目录）', expect: '"passed": true', seconds: 15 },
  { id: 'resume-flow', name: '接着跑实验（不重跑前序）', kind: 'node', file: 'tests/resume-flow-check.cjs', spend: '无（假模型 + 真跑 env-smoke）', expect: '"passed": true', seconds: 40 },
  { id: 'visual', name: '界面与可访问性（axe）', kind: 'node', file: 'tests/dsh-visual-check.cjs', spend: '无', expect: '"passed": true', seconds: 20 },
  { id: 'smoke', name: '应用内建 UI 冒烟', kind: 'npm', script: 'test:ui', spend: '真实协作 8 次调用', live: true, seconds: 90 },
  { id: 'frontend', name: '应用内建前端验收', kind: 'npm', script: 'test:frontend', spend: '无（本地）', seconds: 18 },
  { id: 'packaged-build', name: '打包产物验收 build', kind: 'node', file: 'tests/packaged-check.cjs', spend: '真实协作 8 次调用', live: true, exe: 'build/IrisUnite-win32-x64/IrisUnite.exe', seconds: 55 },
  { id: 'packaged-release', name: '打包产物验收 release', kind: 'node', file: 'tests/packaged-check.cjs', spend: '真实协作 8 次调用', live: true, exe: 'release/IrisUnite-win32-x64/IrisUnite.exe', seconds: 55 }
];

function selected(step) {
  if (only) return only.includes(step.id);
  if (skipLive && step.live) return false;
  return true;
}

function runStep(step) {
  const started = Date.now();
  const env = { ...process.env };
  if (step.exe) env.DUET_VERIFY_EXE = path.join(root, step.exe);
  let command;
  let args;
  /* Windows 上 npm 是 .cmd，spawnSync 不加 shell 会直接 ENOENT（表现为 0 秒退出码 1）。 */
  let shell = false;
  if (step.kind === 'npm') {
    command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    args = ['run', step.script];
    shell = process.platform === 'win32';
  } else {
    command = process.execPath;
    args = [path.join(root, step.file)];
  }
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  const code = result.status === null ? 1 : result.status;
  const reasons = [];
  if (code !== 0) reasons.push(`exit=${code}`);
  if (step.expect && !output.includes(step.expect)) reasons.push(`缺少 "${step.expect}"`);
  if (/FAILED:/.test(output)) reasons.push('输出含 FAILED');
  return { step, ok: reasons.length === 0, reasons, seconds, output };
}

const plan = STEPS.filter(selected);
if (!plan.length) {
  console.error('没有匹配的检查项。可用：' + STEPS.map(s => s.id).join(', '));
  process.exit(2);
}

console.log(`Iris Unite 验收：共 ${plan.length} 项${skipLive ? '（已跳过真实模型调用）' : ''}${only ? `（仅 ${only.join(',')}）` : ''}`);
console.log('');

const records = [];
for (const [index, step] of plan.entries()) {
  process.stdout.write(`[${index + 1}/${plan.length}] ${step.name} … `);
  const result = runStep(step);
  records.push({ id: step.id, name: step.name, ok: result.ok, seconds: result.seconds, spend: step.spend, reasons: result.reasons });
  if (result.ok) {
    console.log(`通过  ${result.seconds}s`);
  } else {
    console.log(`失败  ${result.seconds}s  (${result.reasons.join('；')})`);
    const tail = result.output.split(/\r?\n/).filter(line => line.trim()).slice(-8);
    for (const line of tail) console.log('        ' + line.trimEnd());
  }
}

const failed = records.filter(item => !item.ok);
console.log('');
console.log('汇总');
for (const item of records) {
  console.log(`  ${item.ok ? '通过' : '失败'}  ${item.name.padEnd(24, ' ')} ${String(item.seconds).padStart(5)}s  ${item.spend}`);
}
console.log(`\n共 ${records.length} 项，失败 ${failed.length} 项`);

const reportPath = path.join(root, 'artifacts', 'verification-report.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  skippedLiveCalls: skipLive,
  only: only || null,
  passed: failed.length === 0,
  total: records.length,
  failed: failed.map(item => item.id),
  steps: records
}, null, 2), 'utf8');
console.log('报告：' + path.relative(root, reportPath));

process.exit(failed.length ? 1 : 0);
