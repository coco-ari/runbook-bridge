import { AppError } from './errors.mjs';

const hasStrictMode = mode => typeof mode === 'string' && mode.split(',').some(value => /^STRICT_(?:TRANS|ALL)_TABLES$/iu.test(value.trim()));

// 仅供桌面写入连接内部调用；保留已有模式，绝不修改全局配置。
export async function ensureMysqlWriteSession(query) {
  try {
    const [[current]] = await query('SELECT @@SESSION.sql_mode AS sqlMode');
    if (hasStrictMode(current?.sqlMode)) return;
    if (typeof current?.sqlMode !== 'string') throw new Error();
    const mode = [current.sqlMode, 'STRICT_TRANS_TABLES'].filter(Boolean).join(',');
    await query('SET SESSION sql_mode = ?', [mode]);
    const [[verified]] = await query('SELECT @@SESSION.sql_mode AS sqlMode');
    if (!hasStrictMode(verified?.sqlMode)) throw new Error();
  } catch {
    // 驱动错误可能包含连接信息和参数，仅返回应用拥有的固定说明。
    throw new AppError('MYSQL_SQL_WRITE_UNSAFE', '暂时无法准备保存连接，请重试。', {reason:'strict_mode'});
  }
}
