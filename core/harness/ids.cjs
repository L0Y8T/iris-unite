/* 运行标识：runId、artifactId、callId。
 *
 * 为什么单独成模块：账本、工作区、上下文装配、门禁、前端面板都要用同一套 id 规则。
 * 散落在各处的结果是 id 格式悄悄分叉，而 id 是链式召回（沿引用逐跳找回历史）
 * 唯一的键——格式一旦不可校验，从磁盘或用户输入读回来的引用就无法判定真伪。
 *
 * 格式：
 *   run-<base36 毫秒时间戳>-<8 位十六进制>   例：run-mf3k9a2b-1f4c7d9e
 *   art-<8 位十六进制>                        例：art-1f4c7d9e
 *   call-<8 位十六进制>                       例：call-9a2b3c4d
 * 都能被正则校验：时间戳让同一目录下的 run 天然按创建顺序排序，随机后缀防撞。
 */
const { randomUUID } = require('node:crypto');

const RUN_RE = /^run-([0-9a-z]+)-([0-9a-f]{8})$/;
const ARTIFACT_RE = /^art-([0-9a-f]{8})$/;
const CALL_RE = /^call-([0-9a-f]{8})$/;

function suffix() {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/** 新建一个 run 标识。时间戳用 base36 是为了短，同时保持字典序等于时间序。 */
function newRunId() {
  return `run-${Date.now().toString(36)}-${suffix()}`;
}

function newArtifactId() {
  return `art-${suffix()}`;
}

function newCallId() {
  return `call-${suffix()}`;
}

function isRunId(value) {
  return typeof value === 'string' && RUN_RE.test(value);
}

function isArtifactId(value) {
  return typeof value === 'string' && ARTIFACT_RE.test(value);
}

function isCallId(value) {
  return typeof value === 'string' && CALL_RE.test(value);
}

/** 解析 runId 里的创建毫秒数；不是合法 runId 时返回 null，绝不抛错（调用方常用于容错分支）。 */
function runCreatedAt(value) {
  const match = typeof value === 'string' ? RUN_RE.exec(value) : null;
  if (!match) return null;
  const ms = parseInt(match[1], 36);
  return Number.isFinite(ms) ? ms : null;
}

/** 把任意字符串收敛成合法的 stage 目录名：只留字母数字与连字符，避免路径穿越。 */
function safeSegment(value, fallback = 'misc') {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  const cleaned = text.replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned ? cleaned.slice(0, 64) : fallback;
}

module.exports = {
  newRunId, newArtifactId, newCallId,
  isRunId, isArtifactId, isCallId,
  runCreatedAt, safeSegment
};
