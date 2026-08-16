import mysql from 'mysql2/promise';
import { AppError } from './errors.mjs';
import { validateMysqlSelect, validateMysqlExplain, applyMysqlRowLimit } from './mysql-policy.mjs';

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

export class MysqlPluginRuntime {
  constructor(routeManager, credentialVault, { client = mysql } = {}) {
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
      const [grantRows] = await connection.query({ sql: 'SHOW GRANTS FOR CURRENT_USER', timeout: plugin.limits.timeoutMs });
      const grants = grantRows.flatMap((row) => Object.values(row).map(String)).join('\n');
      if (/\b(?:ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|TRIGGER|EVENT|EXECUTE|FILE|PROCESS|SUPER|GRANT OPTION)\b/i.test(grants)) {
        throw new AppError('DATABASE_ACCOUNT_NOT_READONLY', 'MySQL 账号拥有写入或高权限，拒绝建立只读插件连接。');
      }
      this.sessions.set(key(plugin), { connection, connectedAt: new Date().toISOString(), routeGeneration: relay.generation, bindingHash: plugin.revision });
      return { connected: true, connectedAt: this.sessions.get(key(plugin)).connectedAt, routeGeneration: relay.generation };
    } catch (error) {
      await connection?.end().catch(() => undefined);
      await this.routeManager.closeRelay(plugin);
      if (error instanceof AppError) throw error;
      if (error?.code === 'ER_ACCESS_DENIED_ERROR') throw new AppError('AUTHENTICATION_FAILED', 'MySQL 用户名或密码认证失败。');
      if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error?.code)) throw new AppError('TLS_IDENTITY_FAILED', 'MySQL TLS 身份校验失败。');
      throw new AppError('PLUGIN_UNAVAILABLE', 'MySQL 连接或只读校验失败。');
    }
  }

  async disconnect(plugin) {
    const session = this.sessions.get(key(plugin));
    this.sessions.delete(key(plugin));
    await session?.connection?.end().catch(() => undefined);
    await this.routeManager.closeRelay(plugin);
    return { connected: false };
  }

  async assertBaseTables(plugin, tables) {
    if (!tables.length) return;
    const session = this.require(plugin);
    const placeholders = tables.map(() => '?').join(',');
    const [rows] = await session.connection.query({
      sql: `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, ...tables],
    });
    const types = new Map(rows.map((row) => [String(row.TABLE_NAME), String(row.TABLE_TYPE)]));
    for (const table of tables) {
      const type = types.get(table);
      if (!type) throw new AppError('HARD_POLICY_DENIED', `表 ${table} 不存在或不可访问。`);
      if (type !== 'BASE TABLE') throw new AppError('HARD_POLICY_DENIED', `V1 禁止查询 View：${table}。`);
    }
  }

  async listTables(plugin, { cursor = 0, limit = 100 } = {}) {
    const session = this.require(plugin);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const offset = Math.max(Number(cursor) || 0, 0);
    const [rows] = await session.connection.query({
      sql: 'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ? OFFSET ?',
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, safeLimit + 1, offset],
    });
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
    const session = this.require(plugin);
    const [rows] = await session.connection.query({
      sql: 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, table],
    });
    return { table, columns: rows.map((row) => ({ name: row.COLUMN_NAME, type: row.COLUMN_TYPE, nullable: row.IS_NULLABLE === 'YES', key: row.COLUMN_KEY || null, default: row.COLUMN_DEFAULT, extra: row.EXTRA || null })) };
  }

  async queryReadonly(plugin, sql, params) {
    const validated = validateMysqlSelect(sql);
    await this.assertBaseTables(plugin, validated.tables);
    const statement = applyMysqlRowLimit(validated, plugin.limits.maxRows);
    const session = this.require(plugin);
    const started = Date.now();
    const [rows, fields] = await session.connection.query({ sql: statement, timeout: plugin.limits.timeoutMs, values: normalizeParams(params) });
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
    const session = this.require(plugin);
    const [rows] = await session.connection.query({ sql: validated.statement, timeout: plugin.limits.timeoutMs, values: normalizeParams(params) });
    return { plan: capRows(rows, 200, plugin.limits.maxBytes), fingerprint: validated.fingerprint };
  }

  async closeAll() {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(entries.map(async ([, session]) => session.connection.end().catch(() => undefined)));
  }
}

export const mysqlRuntimeInternals = { key, normalizeParams, capRows, sslOptions };
