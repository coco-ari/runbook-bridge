import { createMysqlConnection, guardMysqlConnection, destroyMysqlConnection, endMysqlConnection } from './mysql-connection.mjs';
import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';
import { validateMysqlSelect, validateMysqlExplain, applyMysqlRowLimit } from './mysql-policy.mjs';
import { capRows } from './mysql-results.mjs';
import { MysqlSchemaReader, normalizeSchemaKeywords } from './mysql-schema-reader.mjs';
import { BoundedReadScheduler } from './bounded-read-scheduler.mjs';
import { BoundedReadCache } from './bounded-read-cache.mjs';

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const MYSQL_TIMEOUT_CODES = new Set(['PROTOCOL_SEQUENCE_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const MYSQL_CONNECTION_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE',
]);
const MYSQL_TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const MYSQL_DATABASE_LIST_DENIED_CODES = new Set([
  'ER_DBACCESS_DENIED_ERROR',
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_ERROR',
]);
const MYSQL_SYNTAX_CODES = new Set(['ER_PARSE_ERROR', 'ER_SYNTAX_ERROR']);

function isSocketShutdownError(error) {
  return error?.code === 'EINVAL' && (error.syscall === 'shutdown' || /^shutdown EINVAL\b/.test(String(error.message ?? '')));
}

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
  if (MYSQL_CONNECTION_CODES.has(code) || isSocketShutdownError(error) || /connection.*(?:closed|lost|reset)|socket.*(?:closed|ended)/i.test(message)) {
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
    || isSocketShutdownError(error)
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

export class MysqlPluginRuntime extends EventEmitter {
  constructor(routeManager, credentialVault, { client = {createConnection:createMysqlConnection}, now = Date.now, metadataTtlMs = 60_000, queueTimeoutMs = 10_000 } = {}) {
    super();
    this.routeManager = routeManager;
    this.credentialVault = credentialVault;
    this.client = client;
    this.sessions = new Map();
    this.connectAttempts = new Map();
    this.readScheduler = new BoundedReadScheduler({ maxConcurrent:4, maxQueued:32, queueTimeoutMs });
    this.metadataCache = new BoundedReadCache({ now, ttlMs:metadataTtlMs });
    this.sessionIds = new WeakMap();
    this.pendingTableChecks = new WeakMap();
    this.nextSessionId = 0;
    this.schemaReader = new MysqlSchemaReader({
      querySession:(plugin, request, options) => this.querySession(plugin, request, { ...options, phase:'metadata' }),
      assertBaseTables:(plugin, tables) => this.assertBaseTables(plugin, tables),
    });
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
    destroyMysqlConnection(session.connection);
    // 先发布失效，再等待旧路由清理，避免迟到通知覆盖新连接状态。
    this.emit('lifecycle', {
      type: 'lost',
      projectId: plugin.projectId,
      environmentId: plugin.environmentId,
      pluginInstanceId: plugin.pluginInstanceId,
      error,
    });
    await this.routeManager.closeRelay(plugin, session.routeGeneration).catch(() => undefined);
  }

  async querySession(plugin, request, { invalidateOnAnyError = false, fallbackMessage, phase = 'query', operation = phase, expectedSession, timing } = {}) {
    const started = performance.now();
    let executionStarted;
    let executionFinished;
    const updateTiming = () => {
      const now = performance.now();
      const value = {
        queueMs:Math.max(0,Math.round((executionStarted ?? now) - started)),
        executionMs:executionStarted === undefined ? 0 : Math.max(0,Math.round((executionFinished ?? now) - executionStarted)),
        totalMs:Math.max(0,Math.round(now - started)),
        executionStarted:executionStarted !== undefined,
      };
      if (timing) Object.assign(timing,value);
      return value;
    };
    try {
      const session = this.require(plugin);
      if (expectedSession && session !== expectedSession) throw new AppError('PLUGIN_RECONNECTING', '表访问检查后数据库连接已更新，请重新查询。', { phase:'metadata', operation:'table_check' });
      return await this.readScheduler.run(key(plugin), 1, async () => {
        if (this.require(plugin) !== session) throw new AppError('PLUGIN_RECONNECTING', '排队期间数据库连接已更新，请重新发起查询。', { phase:'queue' });
        executionStarted = performance.now();
        try {
          const result = await session.connection.query(request);
          executionFinished = performance.now();
          return result;
        } catch (error) {
          executionFinished = performance.now();
          const mapped = mysqlError(error, fallbackMessage);
          if (mapped.code === 'DATABASE_QUERY_TIMEOUT') {
            const guidance = operation === 'table_check'
              ? '查询尚未执行，超时发生在基础表访问检查；等待连接恢复后重试，持续出现时检查数据库元数据访问和网络延迟。不要仅调整业务 SQL 或反复原样重试。'
              : phase === 'metadata' ? '指定准确表名，或先仅搜索表名；避免反复扫描全库字段。' : '先调用 mysql_explain 检查执行计划，缩小时间范围或筛选条件后再查询。';
            mapped.details = { phase, operation, timeoutMs:request.timeout, retryable:false, guidance };
          }
          // 先记录数据库等待时间，连接清理耗时单独计入总耗时。
          mapped.details = {...mapped.details, timing:updateTiming()};
          if (invalidateOnAnyError || invalidatesSession(error) || invalidatesSession(mapped)) {
            await this.invalidateSession(plugin, session, mapped);
          }
          throw mapped;
        } finally {
          updateTiming();
        }
      });
    } catch (error) {
      if (error instanceof AppError) error.details = {
        phase, operation, ...error.details,
        timing:error.details?.timing ?? updateTiming(),
      };
      throw error;
    } finally {
      updateTiming();
    }
  }

  async desktopEditSession(plugin, expectedSession, operation) {
    const session = this.require(plugin);
    if (expectedSession && expectedSession !== session) throw new AppError('MYSQL_EDIT_STALE', '数据库连接已变化，请重新加载后编辑。');
    // 整个编辑事务占用同一插件的串行名额，健康检查和普通查询不能插入事务。
    return this.readScheduler.run(key(plugin), 1, async () => {
      if (this.require(plugin) !== session) throw new AppError('MYSQL_EDIT_STALE', '数据库连接已变化，请重新加载后编辑。');
      const query = (sql, values = [], options = {}) => {
        // 事务控制使用固定无参数语句；业务值始终走服务端预处理，兼容 NO_BACKSLASH_ESCAPES。
        const method = ["START TRANSACTION","COMMIT","ROLLBACK"].includes(sql) ? "query" : "execute";
        return session.connection[method]({sql,values,timeout:Math.min(plugin.limits.timeoutMs,15000),...options});
      };
      try { return await operation(query, session); }
      catch (error) {
        if (invalidatesSession(error)) await this.invalidateSession(plugin,session,mysqlError(error));
        throw error;
      }
    });
  }

  async readMetadata(plugin, signature, load, { refresh = false } = {}) {
    if (typeof refresh !== 'boolean') throw new AppError('INVALID_ARGUMENT', 'refresh 必须是布尔值。');
    const session = this.sessions.get(key(plugin));
    if (!session) return load();
    this.require(plugin);
    if (!this.sessionIds.has(session)) this.sessionIds.set(session, ++this.nextSessionId);
    const cacheKey = JSON.stringify([key(plugin), this.sessionIds.get(session), plugin.revision, plugin.target.database, plugin.limits, signature]);
    const cached = await this.metadataCache.read(cacheKey, load, { refresh });
    if (this.require(plugin) !== session) throw new AppError('PLUGIN_RECONNECTING', '元数据读取期间连接已更新，请重新查询。');
    return { ...cached.value, cache:{ hit:cached.hit, ageMs:cached.ageMs, ttlMs:this.metadataCache.ttlMs } };
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
    let guard;
    const assertOwned = () => {
      if (signal?.aborted || this.connectAttempts.get(resource) !== owner) throw new AppError('CONNECT_CANCELLED', '连接已被更新的尝试取代。');
      guard?.assertOpen();
    };
    const abort = () => {
      if (this.connectAttempts.get(resource) !== owner) return;
      const managed = this.sessions.get(resource);
      if (managed) {
        this.sessions.delete(resource);
        managed.closing = true;
        destroyMysqlConnection(managed.connection);
        void this.routeManager.closeRelay(plugin, managed.routeGeneration).catch(() => undefined);
      }
      destroyMysqlConnection(connection);
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
      guard = guardMysqlConnection(connection);
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
      const lost = (error) => {
        if (session.closing || this.sessions.get(key(plugin)) !== session) return;
        void this.invalidateSession(plugin, session, mysqlError(error, 'MySQL 连接已经中断。'));
      };
      guard.onLost = lost;
      connected = true;
      return { connected: true, connectedAt: this.sessions.get(key(plugin)).connectedAt, routeGeneration: relay.generation };
    } catch (error) {
      await endMysqlConnection(connection);
      if (relay?.generation !== undefined) await this.routeManager.closeRelay(plugin, relay.generation).catch(() => undefined);
      throw mysqlConnectError(error,plugin,'MySQL 连接初始化失败。');
    }
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
      destroyMysqlConnection(connection);
    };
    signal?.addEventListener('abort',abort,{once:true});
    try {
      connection = await this.client.createConnection(mysqlConnectionOptions(plugin, secrets, relay));
      const guard = guardMysqlConnection(connection);
      if (signal?.aborted) throw new AppError('PLUGIN_VALIDATION_CANCELLED','数据库发现已取消。');
      guard.assertOpen();
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
      guard.assertOpen();
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
      await endMysqlConnection(connection);
      await this.routeManager.closeRelay(plugin, relay.generation);
    }
  }

  async disconnect(plugin, _reason = 'user', {preserveAttemptToken = null} = {}) {
    if (preserveAttemptToken === null) this.connectAttempts.delete(key(plugin));
    const session = this.sessions.get(key(plugin));
    if (session) session.closing = true;
    try {
      await endMysqlConnection(session?.connection);
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
    destroyMysqlConnection(session?.connection);
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
    const session = this.sessions.get(key(plugin));
    if (!session) return this.checkBaseTables(plugin, tables);
    this.require(plugin);
    let pending = this.pendingTableChecks.get(session);
    if (!pending) this.pendingTableChecks.set(session, pending = new Map());
    const names = [...new Set(tables)].sort();
    const signature = JSON.stringify([plugin.revision, plugin.target.database, plugin.limits, names]);
    let check = pending.get(signature);
    if (!check) {
      // 只合并同一连接内尚未完成的检查，完成后立即移除，后续查询仍重新验证表类型。
      check = this.checkBaseTables(plugin, names).finally(() => pending.delete(signature));
      pending.set(signature, check);
    }
    await check;
    if (this.require(plugin) !== session) throw new AppError('PLUGIN_RECONNECTING', '表访问检查期间数据库连接已更新，请重新查询。', { phase:'metadata', operation:'table_check' });
    return session;
  }

  async checkBaseTables(plugin, tables) {
    const placeholders = tables.map(() => '?').join(',');
    const [rows] = await this.querySession(plugin, {
      sql: `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
      timeout: plugin.limits.timeoutMs,
      values: [plugin.target.database, ...tables],
    }, { fallbackMessage:'MySQL 表访问检查失败。', phase:'metadata', operation:'table_check' });
    const types = new Map(rows.map((row) => [String(row.TABLE_NAME), String(row.TABLE_TYPE)]));
    for (const table of tables) {
      const type = types.get(table);
      if (!type) throw new AppError('DATABASE_TABLE_UNAVAILABLE', `表 ${table} 不存在或当前账号不可访问，请先使用 mysql_search_schema 核对。`, {table});
      if (type !== 'BASE TABLE') throw new AppError('HARD_POLICY_DENIED', `V1 禁止查询 View：${table}。`);
    }
  }


  listTables(plugin, options = {}) {
    return this.readMetadata(plugin, ['tables', { ...options, refresh:undefined }], () => this.schemaReader.listTables(plugin, options), options);
  }

  searchSchema(plugin, options = {}) {
    return this.readMetadata(plugin, ['search', { ...options, refresh:undefined }], () => this.schemaReader.searchSchema(plugin, options), options);
  }

  describeTable(plugin, table, options = {}) {
    return this.readMetadata(plugin, ['describe', table, { ...options, refresh:undefined }], () => this.schemaReader.describeTable(plugin, table, options), options);
  }

  async queryReadonly(plugin, sql, params, { lossless = false } = {}) {
    const totalStarted = performance.now();
    const validated = validateMysqlSelect(sql);
    let tableCheckMs = 0;
    const queryTiming = {};
    let checkedSession;
    const timingSummary = () => ({
      tableCheckMs, queryQueueMs:queryTiming.queueMs ?? 0, queryMs:queryTiming.executionMs ?? 0,
      totalMs:Math.max(0,Math.round(performance.now() - totalStarted)),
    });
    try {
      const checkStarted = performance.now();
      try { checkedSession = await this.assertBaseTables(plugin, validated.tables); }
      finally { tableCheckMs = Math.max(0,Math.round(performance.now() - checkStarted)); }
      const statement = applyMysqlRowLimit(validated, plugin.limits.maxRows);
      const started = Date.now();
      const [rows, fields] = await this.querySession(
        plugin,
        { sql: statement, timeout: plugin.limits.timeoutMs, values: normalizeParams(params),
          // 桌面结果必须保留主键、日期小数位与 JSON 数值文本，供原位编辑精确核对。
          ...(lossless ? {supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,typeCast:(field,next)=>field.type === 'JSON' ? field.string('utf8') : next()} : {}),
        },
        { fallbackMessage:'MySQL 只读查询执行失败。', expectedSession:checkedSession, timing:queryTiming },
      );
      const capped = capRows(rows, plugin.limits.maxRows, plugin.limits.maxBytes);
      return {
        ...capped,
        columns: (fields ?? []).map((field) => ({ name: field.name, table: field.table || null, type: field.type })),
        durationMs: Date.now() - started,
        timings:timingSummary(),
        fingerprint: validated.fingerprint,
        limitsApplied: { maxRows: plugin.limits.maxRows, maxBytes: plugin.limits.maxBytes, timeoutMs: plugin.limits.timeoutMs },
      };
    } catch (error) {
      if (error instanceof AppError) error.details = {
        ...error.details, queryStarted:queryTiming.executionStarted === true, timings:timingSummary(),
      };
      throw error;
    }
  }

  async explain(plugin, sql, params) {
    const validated = validateMysqlExplain(sql);
    const checkedSession = await this.assertBaseTables(plugin, validated.tables);
    const [rows] = await this.querySession(
      plugin,
      { sql: validated.statement, timeout: plugin.limits.timeoutMs, values: normalizeParams(params) },
      { fallbackMessage:'MySQL 执行计划读取失败。', operation:'explain', expectedSession:checkedSession },
    );
    return { plan: capRows(rows, 200, plugin.limits.maxBytes), fingerprint: validated.fingerprint };
  }

  async closeAll() {
    this.metadataCache.clear();
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(entries.map(async ([, session]) => { session.closing = true; await endMysqlConnection(session.connection); }));
  }
}

export const mysqlRuntimeInternals = {
  key, normalizeParams, normalizeSchemaKeywords, capRows, sslOptions, createMysqlRoute, mysqlConnectionOptions, SYSTEM_DATABASES, mysqlError, mysqlConnectError, invalidatesSession,
};
