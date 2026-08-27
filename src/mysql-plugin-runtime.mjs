import mysql from 'mysql2/promise';
import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';
import { validateMysqlSelect, validateMysqlExplain, applyMysqlRowLimit } from './mysql-policy.mjs';
import { parseOffsetCursor } from './pagination-cursor.mjs';

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const MYSQL_TIMEOUT_CODES = new Set(['PROTOCOL_SEQUENCE_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const MYSQL_CONNECTION_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
]);
const MYSQL_TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const MYSQL_DATABASE_LIST_DENIED_CODES = new Set([
  'ER_DBACCESS_DENIED_ERROR',
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_ERROR',
]);
const MYSQL_SYNTAX_CODES = new Set(['ER_PARSE_ERROR', 'ER_SYNTAX_ERROR']);

function mysqlError(error, fallbackMessage = 'MySQL 操作失败。') {
  if (error instanceof AppError) return error;
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  if (code === 'ER_ACCESS_DENIED_ERROR') return new AppError('AUTHENTICATION_FAILED', 'MySQL 用户名或密码认证失败。');
  if (code === 'ER_BAD_FIELD_ERROR') {
    return new AppError('DATABASE_UNKNOWN_COLUMN', '查询引用了不存在的字段，请先使用 mysql_search_schema 或 mysql_describe_table 核对结构。');
  }
  if (code === 'ER_NO_SUCH_TABLE') {
    return new AppError('DATABASE_UNKNOWN_TABLE', '查询引用了不存在的表，请先使用 mysql_search_schema 核对表名。');
  }
  if (MYSQL_SYNTAX_CODES.has(code)) {
    return new AppError('DATABASE_SYNTAX_ERROR', 'MySQL 查询语法无效，请检查或简化 SQL。');
  }
  if (MYSQL_TLS_CODES.has(code)) return new AppError('TLS_CERTIFICATE_INVALID', 'MySQL TLS 证书校验失败。');
  if (MYSQL_TIMEOUT_CODES.has(code) || /(?:query|operation|socket).*tim(?:e|ed) ?out/i.test(message)) {
    return new AppError('DATABASE_QUERY_TIMEOUT', 'MySQL 操作超时，当前连接已关闭并将按环境策略重新建立。');
  }
  if (MYSQL_CONNECTION_CODES.has(code) || /connection.*(?:closed|lost|reset)|socket.*(?:closed|ended)/i.test(message)) {
    return new AppError('ROUTE_UNAVAILABLE', 'MySQL 连接已经中断，将按环境连接策略重试。');
  }
  return new AppError('DATABASE_OPERATION_FAILED', fallbackMessage);
}

function mysqlConnectError(error, plugin, fallbackMessage = 'MySQL 连接初始化失败。') {
  if (error instanceof AppError) return error;
  const code = String(error?.code ?? '');
  const host = plugin?.target?.host || '目标主机';
  const port = plugin?.target?.port ?? 3306;
  if (['ENOTFOUND','EAI_AGAIN'].includes(code)) {
    return new AppError('MYSQL_DNS_LOOKUP_FAILED',`无法解析 MySQL 主机 ${host}，请检查地址是否完整、是否有多余空格。`);
  }
  if (code === 'ECONNREFUSED') {
    return new AppError('MYSQL_CONNECTION_REFUSED',`${host}:${port} 拒绝连接，请检查端口、RDS 公网地址和访问白名单。`);
  }
  if (['ETIMEDOUT','ESOCKETTIMEDOUT','EHOSTUNREACH','ENETUNREACH'].includes(code)) {
    return new AppError('CONNECT_TIMEOUT',`无法访问 ${host}:${port}，请检查公网/内网地址、VPN、RDS 白名单和防火墙。`);
  }
  if (code === 'ER_BAD_DB_ERROR') {
    return new AppError('DATABASE_NOT_FOUND',`数据库 ${plugin?.target?.database || '当前选择'} 不存在或当前账号无权访问，请重新查询数据库。`);
  }
  if (code === 'ER_DBACCESS_DENIED_ERROR') {
    return new AppError('MYSQL_DATABASE_ACCESS_DENIED',`当前账号无权访问数据库 ${plugin?.target?.database || '当前选择'}。`);
  }
  if (code === 'HANDSHAKE_NO_SSL_SUPPORT') {
    return new AppError('MYSQL_TLS_NOT_SUPPORTED','目标 MySQL 不支持 TLS，请将 TLS 调整为“关闭”后重试。');
  }
  if (MYSQL_TLS_CODES.has(code) || /(?:ssl|tls|certificate|certificate verify)/i.test(String(error?.message ?? ''))) {
    return new AppError(
      MYSQL_TLS_CODES.has(code) ? 'TLS_CERTIFICATE_INVALID' : 'TLS_PROTOCOL_ERROR',
      MYSQL_TLS_CODES.has(code) ? 'MySQL TLS 证书校验失败。' : 'MySQL TLS 协商失败，请核对 TLS 模式和证书配置。',
    );
  }
  const mapped = mysqlError(error,fallbackMessage);
  if (mapped.code !== 'DATABASE_OPERATION_FAILED') return mapped;
  return new AppError('PLUGIN_UNAVAILABLE',`${fallbackMessage} 请检查主机、端口、账号、TLS 和数据库选择。`);
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

async function createMysqlRoute(routeManager, plugin, options = {}) {
  if (typeof routeManager.createStreamRoute === 'function') {
    return routeManager.createStreamRoute(plugin, options);
  }
  return routeManager.createRelay(plugin, options);
}

function mysqlConnectionOptions(plugin, secrets, route, {includeDatabase = true} = {}) {
  return {
    host: route.stream ? plugin.target.host : route.host,
    port: route.stream ? plugin.target.port : route.port,
    ...(route.stream ? { stream:route.stream } : {}),
    user: plugin.auth.username,
    password: secrets.password,
    database: includeDatabase ? plugin.target.database || undefined : undefined,
    connectTimeout: Math.min(plugin.limits.timeoutMs, 20_000),
    multipleStatements: false,
    namedPlaceholders: false,
    supportBigNumbers: true,
    decimalNumbers: false,
    ...(sslOptions(plugin, secrets) ? { ssl:sslOptions(plugin, secrets) } : {}),
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

function normalizeSchemaKeywords(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) {
    throw new AppError('INVALID_ARGUMENT', 'Schema 搜索需要 1 到 10 个关键词。');
  }
  const keywords = [];
  const seen = new Set();
  for (const value of input) {
    if (typeof value !== 'string') throw new AppError('INVALID_ARGUMENT', 'Schema 搜索关键词必须是字符串。');
    const keyword = value.trim().normalize('NFKC');
    if (!keyword || [...keyword].length > 64 || /[\u0000-\u001f\u007f]/u.test(keyword)) {
      throw new AppError('INVALID_ARGUMENT', 'Schema 搜索关键词不能为空、包含控制字符或超过 64 个字符。');
    }
    const signature = keyword.toLocaleLowerCase('zh-CN');
    if (!seen.has(signature)) {
      seen.add(signature);
      keywords.push(keyword);
    }
  }
  return keywords;
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
    this.connectAttempts = new Map();
  }

  status(plugin) {
    const session = this.sessions.get(key(plugin));
    return { connected: Boolean(session && !session.closing), connectedAt: session?.connectedAt ?? null, routeGeneration: session?.routeGeneration ?? 0 };
  }

  require(plugin) {
    const session = this.sessions.get(key(plugin));
    if (!session || session.closing) throw new AppError('PLUGIN_NOT_CONNECTED', 'MySQL 插件尚未连接。');
    return session;
  }

  async invalidateSession(plugin, session, error) {
    if (!session || session.closing || this.sessions.get(key(plugin)) !== session) return;
    session.closing = true;
    this.sessions.delete(key(plugin));
    if (this.connectAttempts.get(key(plugin)) === session.attemptToken) this.connectAttempts.delete(key(plugin));
    const raw = session.connection?.connection ?? session.connection;
    try {
      raw?.destroy?.();
    } catch {
      // The socket may already have been closed by mysql2.
    }
    await this.routeManager.closeRelay(plugin, session.routeGeneration).catch(() => undefined);
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

  async connect(plugin, suppliedSecrets = {}, { signal = null, attemptToken = null, validationPurpose = null } = {}) {
    const includeResource = !['tls-probe','server-auth'].includes(validationPurpose);
    if (plugin.pluginType !== 'mysql' || (includeResource && plugin.configState !== 'ready')) throw new AppError('PLUGIN_CONFIG_INCOMPLETE', 'MySQL 插件配置不完整。');
    if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
    const resource = key(plugin);
    const owner = attemptToken ?? Symbol('mysql-connect');
    this.connectAttempts.set(resource, owner);
    let connected = false;
    let relay;
    let connection;
    const assertOwned = () => {
      if (signal?.aborted || this.connectAttempts.get(resource) !== owner) throw new AppError('CONNECT_CANCELLED', '连接已被更新的尝试取代。');
    };
    const abort = () => {
      if (this.connectAttempts.get(resource) !== owner) return;
      const managed = this.sessions.get(resource);
      if (managed) {
        this.sessions.delete(resource);
        managed.closing = true;
        const managedRaw = managed.connection?.connection ?? managed.connection;
        try { managedRaw?.destroy?.(); } catch { /* Driver may already be closed. */ }
        void this.routeManager.closeRelay(plugin, managed.routeGeneration).catch(() => undefined);
      }
      const raw = connection?.connection ?? connection;
      try { raw?.destroy?.(); } catch { /* Driver may already be closed. */ }
      if (relay?.generation !== undefined) void this.routeManager.closeRelay(plugin, relay.generation).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, {once:true});
    try {
    await this.disconnect(plugin, 'superseded-connect', {preserveAttemptToken:owner});
    assertOwned();
    let saved = null;
    try {
      saved = await this.credentialVault.load(plugin);
    } catch (error) {
      if (!Object.keys(suppliedSecrets).length) throw error;
    }
    assertOwned();
    const secrets = { ...(saved ?? {}), ...suppliedSecrets };
    if (!secrets.password) throw new AppError('CREDENTIAL_UNAVAILABLE', 'MySQL 密码尚未保存。');
    try {
      if (signal?.aborted) throw new AppError('CONNECT_CANCELLED', '连接已取消。');
      relay = await createMysqlRoute(this.routeManager, plugin, {signal});
      assertOwned();
      connection = await this.client.createConnection(mysqlConnectionOptions(plugin, secrets, relay,{includeDatabase:includeResource}));
      assertOwned();
      if (includeResource) {
        const [selectedRows] = await connection.query({
          sql:'SELECT DATABASE() AS ai_ops_database',
          timeout:plugin.limits.timeoutMs,
        });
        const selectedDatabase = String(selectedRows?.[0]?.ai_ops_database ?? '');
        if (selectedDatabase !== plugin.target.database) {
          throw new AppError(
            'MYSQL_DATABASE_ACCESS_DENIED',
            `MySQL 会话未进入固定数据库 ${plugin.target.database}，已拒绝建立正式连接。`,
          );
        }
        assertOwned();
      }
      await connection.query({ sql: 'SELECT 1 AS ai_ops_health', timeout: plugin.limits.timeoutMs });
      assertOwned();
      const session = { connection, connectedAt: new Date().toISOString(), routeGeneration: relay.generation, bindingHash: plugin.revision, closing:false, attemptToken:owner };
      this.sessions.set(key(plugin), session);
      const raw = connection.connection ?? connection;
      const lost = (error) => {
        if (session.closing || this.sessions.get(key(plugin)) !== session) return;
        void this.invalidateSession(plugin, session, mysqlError(error, 'MySQL 连接已经中断。'));
      };
      raw.on?.('error', (error) => { if (invalidatesSession(error)) lost(error); });
      raw.on?.('end', () => lost(new AppError('ROUTE_UNAVAILABLE', 'MySQL 连接已中断。')));
      connected = true;
      return { connected: true, connectedAt: this.sessions.get(key(plugin)).connectedAt, routeGeneration: relay.generation };
    } catch (error) {
      try { await connection?.end?.(); } catch { /* Preserve the original connection error. */ }
      if (relay?.generation !== undefined) await this.routeManager.closeRelay(plugin, relay.generation).catch(() => undefined);
      throw mysqlConnectError(error,plugin,'MySQL 连接初始化失败。');
    } finally {}
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!connected && this.connectAttempts.get(resource) === owner) this.connectAttempts.delete(resource);
    }
  }

  async listDatabases(plugin, suppliedSecrets = {}, {signal = null} = {}) {
    if (plugin.pluginType !== 'mysql' || !plugin.target?.host || !plugin.auth?.username) {
      throw new AppError('PLUGIN_CONFIG_INCOMPLETE', '请先填写 MySQL 主机地址、用户名和连接方式。');
    }
    const secrets = { ...suppliedSecrets };
    if (!secrets.password) throw new AppError('CREDENTIAL_UNAVAILABLE', '请先填写 MySQL 密码。');
    if (signal?.aborted) throw new AppError('PLUGIN_VALIDATION_CANCELLED','数据库发现已取消。');
    const relay = await createMysqlRoute(this.routeManager, plugin, {signal});
    let connection;
    const abort = () => {
      const raw = connection?.connection ?? connection;
      try { raw?.destroy?.(); } catch { /* Driver may already be closed. */ }
    };
    signal?.addEventListener('abort',abort,{once:true});
    try {
      connection = await this.client.createConnection(mysqlConnectionOptions(plugin, secrets, relay));
      if (signal?.aborted) throw new AppError('PLUGIN_VALIDATION_CANCELLED','数据库发现已取消。');
      let rows;
      try {
        [rows] = await connection.query({ sql: 'SHOW DATABASES', timeout: plugin.limits.timeoutMs });
      } catch (error) {
        if (MYSQL_DATABASE_LIST_DENIED_CODES.has(String(error?.code ?? ''))) {
          throw new AppError(
            'MYSQL_DATABASE_LIST_FORBIDDEN',
            '当前账号无权加载数据库列表，请手工输入准确数据库名称并验证。',
            {manualInputAllowed:true},
          );
        }
        throw error;
      }
      if (signal?.aborted) throw new AppError('PLUGIN_VALIDATION_CANCELLED','数据库发现已取消。');
      const visible = [...new Set(rows
        .flatMap((row) => Object.values(row).slice(0, 1))
        .map((value) => String(value ?? '').trim())
        .filter((name) => name && name.length <= 128 && !SYSTEM_DATABASES.has(name.toLocaleLowerCase())))]
        .sort((left, right) => left.localeCompare(right, 'zh-CN'));
      return { databases: visible.slice(0, 200), truncated: visible.length > 200 };
    } catch (error) {
      throw mysqlConnectError(error,plugin,'无法连接 MySQL 并查询数据库列表。');
    } finally {
      signal?.removeEventListener('abort',abort);
      await connection?.end().catch(() => undefined);
      await this.routeManager.closeRelay(plugin, relay.generation);
    }
  }

  async disconnect(plugin, _reason = 'user', {preserveAttemptToken = null} = {}) {
    if (preserveAttemptToken === null) this.connectAttempts.delete(key(plugin));
    const session = this.sessions.get(key(plugin));
    if (session) session.closing = true;
    try {
      await session?.connection?.end().catch(() => undefined);
    } finally {
      if (this.sessions.get(key(plugin)) === session) this.sessions.delete(key(plugin));
      await this.routeManager.closeRelay(plugin, session?.routeGeneration ?? null);
    }
    return { connected: false };
  }

  async forceDisconnect(plugin, _reason = 'forced-disconnect', {attemptToken = null} = {}) {
    const session = this.sessions.get(key(plugin));
    if (attemptToken !== null && session?.attemptToken !== attemptToken) return {connected:Boolean(session),forced:false,stale:true};
    this.sessions.delete(key(plugin));
    if (attemptToken === null || this.connectAttempts.get(key(plugin)) === attemptToken) this.connectAttempts.delete(key(plugin));
    if (session) session.closing = true;
    const raw = session?.connection?.connection ?? session?.connection;
    try { raw?.destroy?.(); } catch { /* Driver may already be closed. */ }
    if (session?.routeGeneration !== undefined) await this.routeManager.closeRelay(plugin, session.routeGeneration).catch(() => undefined);
    return { connected:false, forced:true };
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
      if (!type) throw new AppError('DATABASE_TABLE_UNAVAILABLE', `表 ${table} 不存在或当前账号不可访问，请先使用 mysql_search_schema 核对。`, {table});
      if (type !== 'BASE TABLE') throw new AppError('HARD_POLICY_DENIED', `V1 禁止查询 View：${table}。`);
    }
  }

  async listTables(plugin, { cursor, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const offset = parseOffsetCursor(cursor);
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

  async searchSchema(plugin, { keywords: inputKeywords, limit = 50 } = {}) {
    const keywords = normalizeSchemaKeywords(inputKeywords);
    const safeLimit = limit;
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > 100) {
      throw new AppError('INVALID_ARGUMENT', 'Schema 搜索结果上限必须是 1 到 100 之间的整数。');
    }
    const tablePredicate = keywords
      .map(() => "(INSTR(LOWER(t.TABLE_NAME), LOWER(?)) > 0 OR INSTR(LOWER(COALESCE(t.TABLE_COMMENT, '')), LOWER(?)) > 0)")
      .join(' OR ');
    const columnPredicate = keywords
      .map(() => "(INSTR(LOWER(c.COLUMN_NAME), LOWER(?)) > 0 OR INSTR(LOWER(COALESCE(c.COLUMN_COMMENT, '')), LOWER(?)) > 0)")
      .join(' OR ');
    const [rows] = await this.querySession(plugin, {
      sql: `SELECT 'table' AS match_kind, t.TABLE_NAME AS table_name, t.TABLE_COMMENT AS table_comment,
        NULL AS column_name, NULL AS column_type, NULL AS column_comment, NULL AS column_key
        FROM information_schema.TABLES t
        WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE' AND (${tablePredicate})
        UNION ALL
        SELECT 'column' AS match_kind, c.TABLE_NAME AS table_name, t.TABLE_COMMENT AS table_comment,
        c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type, c.COLUMN_COMMENT AS column_comment, c.COLUMN_KEY AS column_key
        FROM information_schema.COLUMNS c
        INNER JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE' AND (${columnPredicate})
        ORDER BY table_name, match_kind DESC, column_name
        LIMIT ?`,
      timeout: plugin.limits.timeoutMs,
      values: [
        plugin.target.database,
        ...keywords.flatMap((keyword) => [keyword, keyword]),
        plugin.target.database,
        ...keywords.flatMap((keyword) => [keyword, keyword]),
        safeLimit + 1,
      ],
    }, { fallbackMessage:'MySQL Schema 搜索失败。' });
    const matches = rows.slice(0, safeLimit).map((row) => ({
      kind:row.match_kind,
      table:row.table_name,
      tableComment:row.table_comment || null,
      ...(row.match_kind === 'column' ? {column:{
        name:row.column_name,
        type:row.column_type,
        key:row.column_key || null,
        comment:row.column_comment || null,
      }} : {}),
    }));
    const capped = capRows(matches, safeLimit, plugin.limits.maxBytes);
    return {
      keywords,
      matches:capped.rows,
      matchCount:capped.rowCount,
      bytes:capped.bytes,
      truncated:rows.length > safeLimit || capped.truncated,
      limitsApplied:{maxMatches:safeLimit,maxBytes:plugin.limits.maxBytes,timeoutMs:plugin.limits.timeoutMs},
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
  key, normalizeParams, normalizeSchemaKeywords, capRows, sslOptions, createMysqlRoute, mysqlConnectionOptions, SYSTEM_DATABASES, mysqlError, mysqlConnectError, invalidatesSession,
};
