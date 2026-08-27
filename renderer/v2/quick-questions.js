export const QUICK_QUESTION_OPENING_MAX_LENGTH = 500;

export function quickQuestionHasStrictCredential(text) {
  const value = String(text ?? '');
  return [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/i,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:[^@\s\/]+@/i,
    /\bAuthorization\b["']?\s*[:=：]?\s*["']?(?:Bearer|Basic)\s+[^\s,;"']+/i,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]{8,}/i,
    /\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret)\b["']?\s*[:=：]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/i,
    /\b(?:sk-(?:proj-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}|akia[0-9a-z]{16})\b/i,
    /\beyj[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/i,
  ].some((pattern) => pattern.test(value));
}

export function quickQuestionOpeningIssue(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text) return '开场词不能为空。';
  if (Array.from(text).length > QUICK_QUESTION_OPENING_MAX_LENGTH) return '开场词不能超过 500 个字符。';
  if (quickQuestionHasStrictCredential(text)) return '开场词不能包含密码、密钥或其他明确凭据。';
  if (!/\bAI(?:\s*-\s*|\s+)Ops\s+MCP\b/i.test(text)) return '开场词必须明确包含“AI Ops MCP”。';
  return null;
}

export function normalizeQuickQuestionOpening(value) {
  const issue = quickQuestionOpeningIssue(value?.text);
  if (issue) throw new TypeError(issue);
  const defaultIssue = quickQuestionOpeningIssue(value?.defaultText);
  if (defaultIssue) throw new TypeError('默认开场词无效。');
  if (!Number.isInteger(value?.revision) || value.revision < 0) throw new TypeError('开场词版本无效。');
  return {
    text:String(value.text).normalize('NFKC').trim(),
    defaultText:String(value.defaultText).normalize('NFKC').trim(),
    revision:value.revision,
  };
}

export function normalizeQuickQuestionResponse(value) {
  const source = Array.isArray(value?.items) ? value.items : [];
  const items = source.flatMap((item) => {
    if (typeof item?.questionId !== 'string' || !item.questionId || typeof item.text !== 'string' || !item.text.trim()) return [];
    return [{ questionId:item.questionId, text:item.text.trim(), ...(item.createdAt ? {createdAt:item.createdAt} : {}) }];
  }).slice(0,8);
  return {
    items,
    revision:Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
  };
}

export function formatQuickQuestionDiscoveredDate(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year,month - 1,day));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return new Intl.DateTimeFormat('zh-CN',{
    month:'long',
    day:'numeric',
    timeZone:'UTC',
  }).format(date);
}

export function buildQuickQuestionPreview({ opening, projectName, environmentName, question, discoveredDate }) {
  const normalizedOpening = String(opening ?? '').trim();
  const normalizedProject = String(projectName ?? '').trim();
  const normalizedEnvironment = String(environmentName ?? '').trim();
  const normalizedQuestion = String(question ?? '').trim() || '（请先输入问题）';
  const formattedDiscoveredDate = formatQuickQuestionDiscoveredDate(discoveredDate);
  return [
    normalizedOpening,
    '',
    '【当前范围】',
    `项目：${normalizedProject}`,
    `环境：${normalizedEnvironment}`,
    ...(formattedDiscoveredDate ? [`问题发现时间：${formattedDiscoveredDate}`] : []),
    '',
    '【问题】',
    normalizedQuestion,
  ].join('\n');
}
