import { AppError } from './errors.mjs';

export const QUICK_QUESTION_SCHEMA_VERSION = 1;
export const QUICK_QUESTION_LIMIT = 8;
export const QUICK_QUESTION_TEXT_LIMIT = 1200;
export const QUICK_QUESTION_OPENING_SCHEMA_VERSION = 1;
export const QUICK_QUESTION_OPENING_TEXT_LIMIT = 500;
export const DEFAULT_QUICK_QUESTION_OPENING = '请使用 AI Ops MCP，在以下项目和环境中排查问题。'.normalize('NFKC');

const INVALID_TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const REDACTION = '[已脱敏]';
const SAFE_PLACEHOLDER_RE = /^(?:\*{3,}|\[?已脱敏\]?|<redacted>|\{(?:密码|凭据|密钥)\})$/iu;

function redactUnlessPlaceholder(value, replacement) {
  const raw = String(value ?? '').trim();
  const quote = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0]
    ? raw[0]
    : '';
  const unquoted = quote ? raw.slice(1,-1) : raw;
  if (SAFE_PLACEHOLDER_RE.test(unquoted)) return value;
  return quote ? `${quote}${replacement}${quote}` : replacement;
}

function redactKeyValue(_match, prefix, value) {
  return `${prefix}${redactUnlessPlaceholder(value, REDACTION)}`;
}

const CREDENTIAL_REDACTORS = Object.freeze([
  (text) => text.replace(
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu,
    REDACTION,
  ),
  (text) => text.replace(
    /((?:["']?\bauthorization\b["']?)\s*(?:=|:|：)\s*)(["']?)((?:bearer|basic)\s+[^"'\r\n,;]+)\2/giu,
    (_match, prefix, quote, value) => `${prefix}${quote}${redactUnlessPlaceholder(value, REDACTION)}${quote}`,
  ),
  (text) => text.replace(
    /((?:["']?\bauthorization\b["']?)\s*(?:=|:|：)\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&]+)/giu,
    redactKeyValue,
  ),
  (text) => text.replace(
    /((?:["']?\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|refresh[_-]?token|auth[_-]?token|id[_-]?token|private[_-]?key)\b["']?)\s*(?:=|:|：)\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&]+)/giu,
    redactKeyValue,
  ),
  (text) => text.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^@\s/]+)(@)/giu,
    (_match, prefix, value, suffix) => `${prefix}${redactUnlessPlaceholder(value, REDACTION)}${suffix}`,
  ),
  (text) => text.replace(
    /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/giu,
    REDACTION,
  ),
  (text) => text.replace(
    /\b(?:sk-(?:proj-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}|akia[0-9a-z]{16})\b/giu,
    REDACTION,
  ),
  (text) => text.replace(
    /\beyj[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/giu,
    REDACTION,
  ),
]);

export function redactQuickQuestionCredentials(value) {
  let text = String(value ?? '');
  for (const redact of CREDENTIAL_REDACTORS) text = redact(text);
  return text;
}

export function containsQuickQuestionCredential(value) {
  const text = String(value ?? '');
  return redactQuickQuestionCredentials(text) !== text;
}

export function normalizeQuickQuestionText(value, { allowEmpty = false } = {}) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if ((!text && !allowEmpty) || Array.from(text).length > QUICK_QUESTION_TEXT_LIMIT
    || INVALID_TEXT_CONTROL_RE.test(text)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `提问不能为空、不能超过 ${QUICK_QUESTION_TEXT_LIMIT} 个字符或包含非法控制字符。`,
    );
  }
  return text;
}

export function normalizeQuickQuestionOpening(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text) {
    throw new AppError('QUICK_QUESTION_OPENING_REQUIRED', '快捷提问开场白不能为空。');
  }
  if (Array.from(text).length > QUICK_QUESTION_OPENING_TEXT_LIMIT) {
    throw new AppError(
      'QUICK_QUESTION_OPENING_TOO_LONG',
      `快捷提问开场白不能超过 ${QUICK_QUESTION_OPENING_TEXT_LIMIT} 个字符。`,
    );
  }
  if (INVALID_TEXT_CONTROL_RE.test(text)) {
    throw new AppError('QUICK_QUESTION_OPENING_INVALID', '快捷提问开场白包含非法控制字符。');
  }
  if (containsQuickQuestionCredential(text)) {
    throw new AppError(
      'QUICK_QUESTION_OPENING_CONTAINS_CREDENTIAL',
      '快捷提问开场白中不能包含密码、授权头、Token 或密钥等明确凭据。',
    );
  }
  if (!/\bAI(?:\s*-\s*|\s+)Ops\s+MCP\b/i.test(text)) {
    throw new AppError(
      'QUICK_QUESTION_OPENING_MISSING_AI_OPS_MCP',
      '快捷提问开场白必须包含“AI Ops MCP”或“AI-Ops MCP”。',
    );
  }
  return text;
}

function validCompactDate(value) {
  if (!/^\d{8}$/u.test(value)) return false;
  const year = Number(value.slice(0,4));
  if (year < 1000) return false;
  const month = Number(value.slice(4,6));
  const day = Number(value.slice(6,8));
  const date = new Date(Date.UTC(year,month - 1,day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parameterizeCabinetNumbers(text) {
  const replaceNumber = (number) => (validCompactDate(number) ? number : '{机柜号}');
  return text
    .replace(
      /((?:机柜号|机柜编号|柜号|机柜|cabinet)\s*(?:number|no\.?|号|编号|号码)?\s*[:：#-]?\s*)(\d{8})(?!\d)/giu,
      (_match, prefix, number) => `${prefix}${replaceNumber(number)}`,
    )
    .replace(
      /(?<!\d)(\d{8})(\s*(?:号)?\s*(?:机柜号|机柜编号|柜号|机柜|cabinet))/giu,
      (_match, number, suffix) => `${replaceNumber(number)}${suffix}`,
    );
}

export function parameterizeQuickQuestion(value) {
  let text = normalizeQuickQuestionText(value);
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"',;。！？、()\[\]{}]+/giu, '{URL}');
  text = text.replace(/\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/giu, '{邮箱}');
  text = text.replace(/(?<!\d)20\d{14}(?!\d)/gu, '{订单号}');
  text = text.replace(/\bU\d{5,}\b/gu, '{用户ID}');
  return parameterizeCabinetNumbers(text);
}

export function prepareQuickQuestionForSave(value) {
  const text = normalizeQuickQuestionText(value);
  if (containsQuickQuestionCredential(text)) {
    throw new AppError(
      'QUICK_QUESTION_CONTAINS_CREDENTIAL',
      '检测到密码、授权头、Token 或密钥等明确凭据，不能保存为常用提问。',
    );
  }
  return parameterizeQuickQuestion(text);
}

export function normalizeQuickQuestionDiscoveredDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) throw new AppError('INVALID_ARGUMENT', '问题发现时间必须是有效日期。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year,month - 1,day));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppError('INVALID_ARGUMENT', '问题发现时间必须是有效日期。');
  }
  return text;
}

export function formatQuickQuestionDiscoveredDate(value) {
  const normalized = normalizeQuickQuestionDiscoveredDate(value);
  if (!normalized) return '';
  const [,month,day] = normalized.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

export function buildQuickQuestionCopyText({ openingText, projectName, environmentName, question, discoveredDate }) {
  const opening = normalizeQuickQuestionOpening(openingText);
  const project = String(projectName ?? '').normalize('NFKC').trim();
  const environment = String(environmentName ?? '').normalize('NFKC').trim();
  if (!project || !environment) throw new AppError('INVALID_ARGUMENT', '项目和环境名称不能为空。');
  if (containsQuickQuestionCredential(project) || containsQuickQuestionCredential(environment)) {
    throw new AppError(
      'QUICK_QUESTION_SCOPE_NAME_CONTAINS_CREDENTIAL',
      '项目或环境名称中包含疑似凭据，请先重命名后再复制。',
    );
  }
  const normalized = normalizeQuickQuestionText(question);
  const safeQuestion = redactQuickQuestionCredentials(normalized);
  const formattedDiscoveredDate = formatQuickQuestionDiscoveredDate(discoveredDate);
  return [
    opening,
    '',
    '【当前范围】',
    `项目：${project}`,
    `环境：${environment}`,
    ...(formattedDiscoveredDate ? [`问题发现时间：${formattedDiscoveredDate}`] : []),
    '',
    '【问题】',
    safeQuestion,
  ].join('\n');
}
