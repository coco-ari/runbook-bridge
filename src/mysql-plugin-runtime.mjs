import mysql from 'mysql2/promise';
import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';
import { validateMysqlSelect, validateMysqlExplain, applyMysqlRowLimit } from './mysql-policy.mjs';

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const MYSQL_TIMEOUT_CODES = new Set(['PROTOCOL_SEQUENCE_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const MYSQL_CONNECTION_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
]);
const MYSQL_TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function mysqlError(error, fallbackMessage = 'MySQL 操作失败。') {
  if (error instanceof AppError) return error;
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  if (code === 'ER_ACCESS_DENIED_ERROR') return new AppError('AUTHENTICATION_FAILED', 'MySQL 用户名或密码认证失败。');
  if (MYSQL_TLS_CODES.has(code)) return new AppError('TLS_IDENTITY_FAILED', 'MySQL TLS 身份校验失败。');
  if (MYSQL_TIMEOUT_CODES.has(code) || /(?:query|operation|socket).*tim(?:e|ed) ?out/i.test(message)) {
    return new AppError('DATABASE_QUERY_TIMEOUT', 'MySQL 操作超时，当前连接已关闭并将按环境策略重新建立。');
  }
  if (MYSQL_CONNECTION_CODES.has(code) || /connection.*(?:closed|lost|reset)|socket.*(?:closed|ended)/i.test(message)) {
    return new AppError('ROUTE_UNAVAILABLE', 'MySQL 连接已经中断，将按环境连接策略重试。');
  }
  return new AppError('DATABASE_OPERATION_FAILED', fallbackMessage);
}

function invalidatesSession(error) {
  if (!error) return false;
  if (error instanceof AppError) return ['DATABASE_QUERY_TIMEOUT', 'ROUTE_UNAVAILABLE', 'PLUGIN_UNAVAILABLE'].includes(error.code);
  const code = String(error.code ?? '');
  return MYSQL_TIMEOUT_CODES.has(code)
    || MYSQL_CONNECTION_CODES.has(code)
    || error.fatal === true
    || /(?:query|operation|socket).*tim(?:e|ed) ?out|connection.*(?:closed|lost|reset)|socket.*(?:closed|ended)/i.test(String(error.message ?? ''));
}

function key(plugin) {
  return `${plugin.projectId}/${plugin.environmentId}/${plugin.pluginInstanceId}`;
}

function sslOptions(plugin, secrets) {
  const mode = plugin.tls?.mode ?? 'preferred';
  if (mode === 'disabled') return undefined;
  return {
    rejectUnauthorized: mode === 'verifyIdentity',
    servername: plugin.target.host,
    ...(secrets.caPem ? { ca: secrets.caPem } : {}),
    ...(secrets.clientCertPem ? { cert: secrets.clientCertPem } : {}),
    ...(secrets.clientKeyPem ? { key: secrets.clientKeyPem } : {}),
    ...(secrets.tlsPassphrase ? { passphrase: secrets.tlsPassphrase } : {}),
  };
}

function normalizeParams(params) {
  if (params === undefined) return [];
  if (!Array.isArray(params) || params.length > 100) throw new AppError('INVALID_ARGUMENT', 'SQL 参数必须是最多 100 项的数组。');
  return params.map((value) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 64 * 1024) throw new AppError('INVALID_ARGUMENT', '单个 SQL 参数不能超过 64 KiB。');
      if (typeof value === 'number' && !Number.isFinite(value)) throw new AppError('INVALID_ARGUMENT', 'SQL 数字参数无效。');
      return value;
    }
    throw new AppError('INVALID_ARGUMENT', 'SQL 参数只允许字符串、数字、布尔值或 null。');
  });
}

function capRows(rows, maxRows, maxBytes) {
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

export class MysqlPluginRuntime extends EventEmitter {
  constructor(routeManager, credentialVault, { client = mysql } = {}) {
    super();
    this.routeManager = routeManager;
    this.credentialVault = credentialVault;
    this.client = client;
    this.sessions = new Map();
  }

  status(plugin) {
    const session = this.sessions.get(key(plugin));
    return { connected: Boolean(session), connectedAt: session?.connectedAt ?? null, routeGeneration: session?.routeGeneration ?? 0 };
  }

  require(plugin) {
    const session = this.sessions.get(key(plugin));
    if (!session) throw new AppError('PLUGIN_NOT_CONNECTED', 'MySQL 插件尚未连接。');
    return session;
  }

  async invalidateSession(plugin, session, error) {
    if (!session || session.closing || this.sessions.get(key(plugin)) !== session) return;
    session.closing = true;
    this.sessions.delete(key(plugin));
    const raw = session.connection?.connection ?? session.connection;
    try {
      raw?.destroy?.();
    } catch {
      // The socket may already have been closed by mysql2.
    }
    await this.routeManager.closeRelay(plugin).catch(() => undefined);
    this.emit('lifecycle', {
      type: 'lost',
      projectId: plugin.projectId,
      environmentId: plugin.environmentId,
      pluginInstanceId: plugin.pluginInstanceId,
      error,
    });
  }

  async querySession(plugin, request, { invalidateOnAnyError = false, fallbackMessage } = {}) {
    const session = this.require(plugin);
    try {
      return await session.connection.query(request);
    } catch (error) {
      const mapped = mysqlError(error, fallbackMessage);
      if (invalidateOnAnyError || invalidatesSession(error) || invalidatesSession(mapped)) {
        await this.invalidateSession(plugin, session, mapped);
      }
      throw mapped;
    }
  }

  async connect(plugin, suppliedSecrets = {}) {
    if (plugin.pluginType !== 'mysql' || plugin.configState !== 'ready') throw new AppError('PLUGIN_CONFIG_INCOMPLETE', 'MySQL 插件配置不完整。');
    await this.disconnect(plugin);
    let saved = null;
    try {
      saved = await this.credentialVault.load(plugin);
    } catch (error) {
      if (!Object.keys(suppliedSecrets).length) throw error;
    }
    const secrets = { ...(saved ?? {}), ...suppliedSecrets };
    if (!secrets.password) throw new AppError('CREDENTIAL_UNAVAILABLE', 'MySQL 密码尚未保存。');
    const relay = await this.routeManager.createRelay(plugin);
    let connection;
    try {
      connection = await this.client.createConnection({
        host: relay.host,
        port: relay.port,
        user: plugin.auth.username,
        password: secrets.password,
        database: plugin.target.database,
        connectTimeout: Math.min(plugin.limits.timeoutMs, 20_000),
        multipleStatements: false,
        namedPlaceholders: false,
        supportBigNumbers: true,
        decimalNumbers: false,
        ...(sslOptions(plugin, secrets) ? { ssl: sslOptions(plugin, secrets) } : {}),
      });
      await connection.query({ sql: 'SELECT 1 AS ai_ops_health', timeout: plugin.limits.timeoutMs });
      const session = { connection, connectedAt: new Date().toISOString(), routeGeneration: relay.generation, bindingHash: plugin.revision, closing:false };
      this.sessions.set(key(plugin), session);
      const raw = connection.connection ?? connection;
      const lost = (error) => {
        if (session.closing || this.sessions.get(key(plugin)) !== session) return;
        void this.invalidateSession(plugin, session, mysqlError(error, 'MySQL 连接已经中断。'));
      };
      raw.on?.('error', (error) => { if (invalidatesSession(error)) lost(error); });
      raw.on?.('end', () => lost(new AppError('ROUTE_UNAVAILABLE', 'MySQL 连接已中断。')));
      return { connected: true, connectedAt: this.sessions.get(key(plugin)).connectedAt, routeGeneration: relay.generation };
    } catch (error) {
      await connection?.end().catch(() => undefined);
      await this.routeManager.closeRelay(plugin);
      const mapped = mysqlError(error, 'MySQL 连接初始化失败。');
      if (mapped.code === 'DATABASE_OPERATION_FAILED') throw new AppError('PLUGIN_UNAVAILABLE', mapped.message);
      throw mapped;
    }
  }

  async listDatabases(plugin, suppliedSecrets = {}) {
    if (plugin.pluginType !== 'mysql' || !plugin.target?.host || !plugin.auth?.username) {
      throw new AppError('PLUGIN_CONFIG_INCOMPLETE', '请先填写 MySQL 主机地址、用户名和连接方式。');
    }
    const secrets = { ...suppliedSecrets };
    if (!secrets.password) throw new AppError('CREDENTIAL_UNAVAILABLE', '请先填写 MySQL 密码。');
    const relay = await this.routeManager.createRelay(plugin);
    let connection;
    try {
      connection = await this.client.createConnection({
        host: relay.host,
        port: relay.port,
        user: plugin.auth.username,
        password: secrets.password,
        connectTimeout: Math.min(plugin.limits.timeoutMs, 20_000),
        multipleStatements: false,
        namedPlaceholders: false,
        supportBigNumbers: true,
        decimalNumbers: false,
        ...(sslOptions(plugin, secrets) ? { ssl: sslOptions(plugin, secrets) } : {}),
      });
      const [rows] = await connection.query({ sql: 'SHOW DATABASES', timeout: plugin.limits.timeoutMs });
      const visible = [...new Set(rows
        .flatMap((row) => Object.values(row).slice(0, 1))
        .map((value) => String(value ?? '').trim())
        .filter((name) => name && name.length <= 128 && !SYSTEM_DATABASES.has(name.toLocaleLowerCase())))]
        .sort((left, right) => left.localeCompare(right, 'zh-CN'));
      return { databases: visible.slice(0, 200), truncated: visible.length > 200 };
    } catch (error) {
      const mapped = mysqlError(error, '无法连接 MySQL 并查询数据库列表。');
      if (mapped.code === 'DATABASE_OPERATION_FAILED') throw new AppError('PLUGIN_UNAVAILABLE', mapped.message);
      throw mapped;
    } finally {
      await connection?.end().catch(() => undefined);
      await this.routeManager.closeRelay(plugin);
    }
  }

  async disconnect(plugin) {
    const session = this.sessions.get(key(plugin));
    this.sessions.delete(key(plugin));
    if (session) session.closing = true;
    await session?.connection?.end().catch(() => undefined);
    await this.routeManager.closeRelay(plugin);
    return { connected: false };
  }

  async health(plugin) {
    await this.querySession(
      plugin,
      { sql:'SELECT 1 AS ai_ops_health', timeout:Math.min(plugin.limits.timeoutMs, 5000) },
      { invalidateOnAnyError:true, fallbackMessage:'MySQL 连接检查失败。' },
    );
    return { connected:true, checkedAt:new Date().toISOString() };
  }

  async assertBaseTables(plugin, tables) {
    if (!tables.length) return;
    const placeholders = tables.map(() => '?').join(',');
    const [rows] = await this.querySession(plugin, {
      sql: `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, ...tables],
    }, { fallbackMessage:'MySQL 表访问检查失败。' });
    const types = new Map(rows.map((row) => [String(row.TABLE_NAME), String(row.TABLE_TYPE)]));
    for (const table of tables) {
      const type = types.get(table);
      if (!type) throw new AppError('HARD_POLICY_DENIED', `表 ${table} 不存在或不可访问。`);
      if (type !== 'BASE TABLE') throw new AppError('HARD_POLICY_DENIED', `V1 禁止查询 View：${table}。`);
    }
  }

  async listTables(plugin, { cursor = 0, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const offset = Math.max(Number(cursor) || 0, 0);
    const [rows] = await this.querySession(plugin, {
      sql: 'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ? OFFSET ?',
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, safeLimit + 1, offset],
    }, { fallbackMessage:'MySQL 数据表列表读取失败。' });
    const truncated = rows.length > safeLimit;
    return {
      tables: rows.slice(0, safeLimit).map((row) => ({ name: row.TABLE_NAME, type: row.TABLE_TYPE, queryable: row.TABLE_TYPE === 'BASE TABLE' })),
      nextCursor: truncated ? String(offset + safeLimit) : null,
      truncated,
    };
  }

  async describeTable(plugin, tableName) {
    const table = String(tableName ?? '').trim();
    if (!table || table.length > 128 || /[\u0000-\u001f\u007f]/.test(table)) throw new AppError('INVALID_ARGUMENT', '表名无效。');
    await this.assertBaseTables(plugin, [table]);
    const [rows] = await this.querySession(plugin, {
      sql: 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, table],
    }, { fallbackMessage:'MySQL 表结构读取失败。' });
    return { table, columns: rows.map((row) => ({ name: row.COLUMN_NAME, type: row.COLUMN_TYPE, nullable: row.IS_NULLABLE === 'YES', key: row.COLUMN_KEY || null, default: row.COLUMN_DEFAULT, extra: row.EXTRA || null })) };
  }

  async queryReadonly(plugin, sql, params) {
    const validated = validateMysqlSelect(sql);
    await this.assertBaseTables(plugin, validated.tables);
    const statement = applyMysqlRowLimit(validated, plugin.limits.maxRows);
    const started = Date.now();
    const [rows, fields] = await this.querySession(
      plugin,
      { sql: statement, timeout: plugin.limits.timeoutMs, values: normalizeParams(params) },
      { fallbackMessage:'MySQL 只读查询执行失败。' },
    );
    const capped = capRows(rows, plugin.limits.maxRows, plugin.limits.maxBytes);
    return {
      ...capped,
      columns: (fields ?? []).map((field) => ({ name: field.name, table: field.table || null, type: field.type })),
      durationMs: Date.now() - started,
      fingerprint: validated.fingerprint,
      limitsApplied: { maxRows: plugin.limits.maxRows, maxBytes: plugin.limits.maxBytes, timeoutMs: plugin.limits.timeoutMs },
    };
  }

  async explain(plugin, sql, params) {
    const validated = validateMysqlExplain(sql);
    await this.assertBaseTables(plugin, validated.tables);
    const [rows] = await this.querySession(
      plugin,
      { sql: validated.statement, timeout: plugin.limits.timeoutMs, values: normalizeParams(params) },
      { fallbackMessage:'MySQL 执行计划读取失败。' },
    );
    return { plan: capRows(rows, 200, plugin.limits.maxBytes), fingerprint: validated.fingerprint };
  }

  async closeAll() {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(entries.map(async ([, session]) => { session.closing = true; await session.connection.end().catch(() => undefined); }));
  }
}

export const mysqlRuntimeInternals = {
  key, normalizeParams, capRows, sslOptions, SYSTEM_DATABASES, mysqlError, invalidatesSession,
};
