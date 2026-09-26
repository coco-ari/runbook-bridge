import { AppError } from './errors.mjs';

function unsupported(message) {
  throw new AppError('DATABASE_QUERY_UNSUPPORTED', message);
}

// This lexer is also used in the renderer. Keep it independent of Node APIs.
// Offsets use JavaScript UTF-16 indices, matching textarea / CodeMirror ranges.
export function splitMysqlScript(input) {
  const source = String(input ?? '');
  if (source.includes('\0')) unsupported('SQL 不能包含空字符。');
  const statements = [];
  let segmentStart = 0;
  let firstCode = -1;
  let cursor = 0;

  const finish = (end) => {
    if (firstCode !== -1) {
      let start = segmentStart;
      while (start < end && /\s/u.test(source[start])) start += 1;
      while (end > start && /\s/u.test(source[end - 1])) end -= 1;
      const sql = source.slice(start, end);
      statements.push({ sql, start, end, line: source.slice(0, firstCode).split(/\r\n|\n|\r/u).length });
    }
    firstCode = -1;
  };

  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/u.test(char)) { cursor += 1; continue; }
    if (char === '#' || (char === '-' && source[cursor + 1] === '-' && (cursor + 2 === source.length || source.charCodeAt(cursor + 2) <= 32))) {
      while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') cursor += 1;
      continue;
    }
    if (char === '/' && source[cursor + 1] === '*') {
      if (source[cursor + 2] === '!' || source[cursor + 2] === '+' || /^M!/iu.test(source.slice(cursor + 2, cursor + 4))) {
        unsupported('暂不支持可执行注释或优化器提示，请将实际 SQL 写成普通语句。');
      }
      const end = source.indexOf('*/', cursor + 2);
      if (end === -1) unsupported('SQL 注释未闭合，请补全 */ 后再执行。');
      if (source.slice(cursor + 2, end).includes('/*')) unsupported('暂不支持嵌套块注释，请使用独立注释。');
      cursor = end + 2;
      continue;
    }
    if (char === ';') {
      finish(cursor);
      segmentStart = ++cursor;
      continue;
    }
    if (firstCode === -1) {
      firstCode = cursor;
      if (/^delimiter\b/iu.test(source.slice(cursor))) unsupported('首版不支持 DELIMITER 或存储程序脚本，请使用分号分隔普通 SQL。');
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      cursor += 1;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          unsupported('暂不支持引号中的反斜杠转义，避免不同 SQL 模式产生歧义；单引号请双写为两个单引号。');
        }
        if (source[cursor] === quote) {
          if (source[cursor + 1] === quote) { cursor += 2; continue; }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) unsupported('SQL 引号未闭合，请补全字符串或标识符后再执行。');
      continue;
    }
    cursor += 1;
  }
  finish(source.length);
  return statements;
}

export function selectMysqlScript(input, start, end, kind = 'current') {
  const source = String(input ?? '');
  if (!['current', 'selection', 'all'].includes(kind)) throw new AppError('INVALID_ARGUMENT', 'SQL 执行范围无效。');
  if (kind === 'all') return source.trim();
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) {
    throw new AppError('INVALID_ARGUMENT', 'SQL 光标或选中范围无效。');
  }
  if (kind === 'selection') {
    const selection = source.slice(start, end).trim();
    if (!selection) throw new AppError('INVALID_ARGUMENT', '请先选中要执行的 SQL。');
    return selection;
  }
  const statements = splitMysqlScript(source);
  const statement = statements.find((item) => start >= item.start && start <= item.end)
    ?? statements.find((item) => item.start > start)
    ?? statements.at(-1);
  return statement?.sql ?? '';
}
