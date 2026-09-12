import mysql from 'mysql2';

const guards = new WeakMap();

function connectionLost() {
  return Object.assign(new Error('MySQL 连接已经中断。'), {code:'PROTOCOL_CONNECTION_LOST', fatal:true});
}

function destroyStream(raw) {
  // mysql2 的 destroy() 仍会调用 Socket.end()，失效连接必须先销毁底层流。
  try { raw.stream?.destroy?.(); } catch { /* 底层流可能已经关闭。 */ }
}

export function guardMysqlConnection(connection) {
  const raw = connection.connection ?? connection;
  if (guards.has(raw)) {
    const existing = guards.get(raw);
    existing.bindStream();
    return existing;
  }
  const guard = {
    error:null,
    closing:false,
    destroyed:false,
    onLost:null,
    assertOpen() {
      if (this.error) throw this.error;
      if (this.closing || raw.stream?.destroyed) throw connectionLost();
    },
  };
  guards.set(raw, guard);
  const fail = (error) => {
    const firstFailure = !guard.closing && !guard.error;
    if (firstFailure) guard.error = error;
    destroyStream(raw);
    if (firstFailure) guard.onLost?.(error);
  };
  // 监听器覆盖握手、查询间隙和关闭后的迟到事件，不随单次 Promise 完成而移除。
  raw.on?.('error', fail);
  raw.on?.('end', () => fail(connectionLost()));
  const streamClosed = () => {
    // 必须先于驱动的 close 回调释放失效句柄，避免再次 shutdown 导致 EINVAL。
    destroyStream(raw);
    fail(connectionLost());
  };
  const streams = new WeakSet();
  guard.bindStream = () => {
    const stream = raw.stream;
    if (!stream?.prependListener || streams.has(stream)) return;
    streams.add(stream);
    stream.prependListener('error', fail);
    stream.prependListener('close', streamClosed);
  };
  // TLS 握手会替换 raw.stream，连接就绪和重新取得守卫时都补齐新流监听。
  raw.on?.('connect', guard.bindStream);
  guard.bindStream();
  return guard;
}

export function destroyMysqlConnection(connection) {
  if (!connection) return;
  const raw = connection.connection ?? connection;
  const guard = guardMysqlConnection(connection);
  guard.closing = true;
  guard.onLost = null;
  if (guard.destroyed) return;
  guard.destroyed = true;
  if (typeof raw.stream?.destroy === 'function') destroyStream(raw);
  else {
    try { raw.destroy?.(); } catch { /* 驱动可能已经关闭。 */ }
  }
}

export async function endMysqlConnection(connection) {
  if (!connection) return;
  const raw = connection.connection ?? connection;
  const guard = guardMysqlConnection(connection);
  guard.closing = true;
  guard.onLost = null;
  try {
    if (!guard.error && !raw.stream?.destroyed) await connection.end?.();
  } catch { /* 关闭失败仍须释放连接，且不覆盖原始操作错误。 */ }
  finally { destroyMysqlConnection(connection); }
}

export async function createMysqlConnection(options) {
  // 使用同步工厂取得原始连接，在握手完成前注册持续的错误监听。
  const raw = mysql.createConnection(options);
  const guard = guardMysqlConnection(raw);
  try {
    await new Promise((resolve, reject) => raw.connect((error) => error ? reject(error) : resolve()));
    guardMysqlConnection(raw).assertOpen();
    return raw.promise();
  } catch (error) {
    destroyMysqlConnection(raw);
    throw error;
  }
}
