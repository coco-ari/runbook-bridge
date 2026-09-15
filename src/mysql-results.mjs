import { AppError } from './errors.mjs';

export function capRows(rows, maxRows, maxBytes) {
  if (!Array.isArray(rows)) return { rows: [], rowCount: 0, bytes: 2, truncated: false };
  const output = [];
  let bytes = 2;
  let truncated = false;
  for (const row of rows) {
    if (output.length >= maxRows) {
      truncated = true;
      break;
    }
    const serialized = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(serialized, 'utf8') + (output.length ? 1 : 0);
    if (rowBytes > maxBytes || bytes + rowBytes > maxBytes) {
      if (!output.length) throw new AppError('RESULT_LIMIT_EXCEEDED', '单行查询结果超过插件字节上限。');
      truncated = true;
      break;
    }
    output.push(row);
    bytes += rowBytes;
  }
  if (rows.length > output.length) truncated = true;
  return { rows: output, rowCount: output.length, bytes, truncated };
}
