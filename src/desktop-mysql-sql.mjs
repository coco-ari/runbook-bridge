import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { prepareMysqlSqlScript, mysqlSqlRequest } from './desktop-mysql-sql-policy.mjs';
import { assertMysqlSqlTables } from './mysql-sql-write-policy.mjs';
import { capRows } from './mysql-results.mjs';
import { mysqlSqlPublicError, mysqlSqlUnsafeError } from './mysql-sql-diagnostics.mjs';

const SCOPE = ['projectId', 'environmentId', 'pluginInstanceId'];
const MODES = ['atomic', 'autocommit', 'manual'];
const FIELDS = {prepare:['sql','mode'], execute:['planId','confirmed'], status:[], stop:['planId'], release:[]};
const fail = (code, message) => new AppError(code, message);
const binding = plugin => JSON.stringify([...SCOPE.map(key => plugin[key]), plugin.revision, plugin.target.database]);
const publicError = (error, operation) => mysqlSqlPublicError(error, 'SQL 执行失败，请检查语法、字段约束或数据库账号权限。', {operation});
const LIMIT = {statements:100, bytes:4 * 1024 * 1024, idle:5 * 60_000, plan:2 * 60_000, sessions:24, transactionEntries:100};

export function prepareMysqlSqlRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(FIELDS, payload.operation)) throw fail('INVALID_ARGUMENT', 'SQL 操作请求无效。');
  if (Object.keys(payload).some(key => ![...SCOPE, 'operation', 'documentId', ...FIELDS[payload.operation]].includes(key))) throw fail('INVALID_ARGUMENT', 'SQL 操作包含不允许的参数。');
  for (const key of [...SCOPE, 'documentId']) if (typeof payload[key] !== 'string' || !payload[key].trim() || payload[key].length > 128 || /[\u0000-\u001f\u007f]/u.test(payload[key])) throw fail('INVALID_ARGUMENT', 'SQL 标签或目标范围无效。');
  if (payload.operation === 'prepare' && (typeof payload.sql !== 'string' || !MODES.includes(payload.mode))) throw fail('INVALID_ARGUMENT', 'SQL 或事务模式无效。');
  if (['execute', 'stop'].includes(payload.operation) && (typeof payload.planId !== 'string' || !/^[a-f0-9-]{36}$/u.test(payload.planId))) throw fail('INVALID_ARGUMENT', 'SQL 执行计划无效。');
  if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean') throw fail('INVALID_ARGUMENT', 'SQL 确认参数无效。');
  return Object.fromEntries(SCOPE.map(key => [key, payload[key]]));
}

export class DesktopMysqlSql {
  constructor(runtime, store, {now = Date.now} = {}) {
    this.runtime = runtime; this.store = store; this.now = now; this.sessions = new Map(); this.timer = null;
  }
  key(owner, scope, documentId) { return JSON.stringify([owner, ...SCOPE.map(key => scope[key]), documentId]); }
  snapshot(s) {
    return {documentId:s.documentId, mode:s.mode, transaction:s.transaction, status:s.status, results:structuredClone(s.results),
      ...(s.transactionInfo && ['active','unknown'].includes(s.transaction) ? {transactionSummary:{...structuredClone(s.transactionInfo),
        serverNow:this.now(), idleTimeoutMs:LIMIT.idle,
        idleExpiresAt:s.transaction === 'active' && !s.busy ? s.touched + LIMIT.idle : null,
        omittedCount:s.transactionInfo.statementCount - s.transactionInfo.entries.length}} : {}),
      ...(s.plan ? {plan:{planId:s.plan.id, requiresConfirmation:s.plan.requiresConfirmation, dangerous:s.plan.dangerous, statementCount:s.plan.items.length,
        writeCount:s.plan.items.filter(item => item.write).length, statements:s.plan.items.map((item, index) => ({index:index + 1, line:item.line, kind:item.kind, tables:item.tables, dangerous:item.dangerous}))}} : {}),
      ...(s.error ? {error:s.error} : {}), ...(s.message ? {message:s.message} : {})};
  }
  require(owner, scope, documentId) {
    const s = this.sessions.get(this.key(owner, scope, documentId));
    if (!s) throw fail('MYSQL_SQL_SESSION_STALE', 'SQL 标签会话已结束，请重新执行。');
    return s;
  }
  assert(s, plugin, assertOwner) {
    assertOwner();
    if (s.released || binding(plugin) !== s.binding || this.runtime.require(plugin) !== s.parent) throw fail('MYSQL_SQL_SESSION_STALE', 'SQL 会话的目标配置或连接已变化，请重新打开标签。');
    s.child?.assertActive();
  }
  lost(s, error) {
    if (s.released || s.status === 'unknown') return;
    const uncertain = s.transaction === 'active' || s.committing || s.executingWrite;
    s.transaction = uncertain ? 'unknown' : 'none';
    s.error = uncertain ? {code:'MYSQL_SQL_OUTCOME_UNKNOWN', message:'连接已中断，事务或写入结果尚未确认。请使用新的查询标签核实，不要直接重复执行。'} : publicError(error);
    s.status = uncertain ? 'unknown' : 'error';
    for (const result of s.results) if (result.transactionEffect === 'pending') result.transactionEffect = 'unknown';
    s.abort?.abort();
  }
  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const s of this.sessions.values()) {
        if (s.released || s.busy || !s.child) continue;
        try { this.assert(s, s.plugin, () => {}); } catch (error) { this.lost(s, error); void this.closeConnection(s); continue; }
        if (this.now() - s.touched > LIMIT.idle) {
          s.busy = true;
          void this.rollback(s).then(() => {
            s.status = 'cancelled'; s.message = 'SQL 会话闲置超过 5 分钟，未提交事务已回滚，连接已释放。';
          }, error => this.lost(s, error)).finally(async () => { await this.closeConnection(s); s.busy = false; });
        }
      }
    }, 1000);
    this.timer.unref?.();
  }
  async closeConnection(s) {
    const child = s.child; s.child = null;
    // Intentional release is not an unexpected connection loss. Abort remains
    // necessary for a connection which is still being opened.
    if (child) child.onLost = null;
    await child?.close();
    s.abort?.abort(); s.abort = null;
  }
  async connection(s, assertOwner) {
    this.assert(s, s.plugin, assertOwner);
    if (!s.child) {
      s.abort = new AbortController();
      const child = await this.runtime.openSqlConnection(s.plugin, s.parent, {signal:s.abort.signal});
      if (s.released || s.cancelled) { await child.close(); throw fail('MYSQL_SQL_CANCELLED', 'SQL 执行已停止。'); }
      s.child = child; child.onLost = error => this.lost(s, error);
      this.assert(s, s.plugin, assertOwner);
    }
    return s.child;
  }
  async query(s, sql, values = []) {
    if (!s.child) throw fail('MYSQL_SQL_SESSION_CLOSED', 'SQL 会话连接已结束。');
    s.child.assertActive();
    return s.child.connection.query({sql, values, timeout:Math.min(s.plugin.limits.timeoutMs, 30_000), supportBigNumbers:true, bigNumberStrings:true, dateStrings:true,
      typeCast:(field, next) => field.type === 'JSON' ? field.string('utf8') : next()});
  }
  async begin(s) {
    if (s.transaction === 'active') throw fail('MYSQL_SQL_TRANSACTION_ACTIVE', '当前事务尚未结束，请先提交或回滚。');
    await this.query(s, 'START TRANSACTION'); s.transaction = 'active';
    s.transactionInfo = {id:crypto.randomUUID(), startedAt:this.now(), statementCount:0, writeCount:0, affectedRows:0, entries:[]};
  }
  recordTransaction(s, item, row) {
    const info = s.transactionInfo;
    if (s.transaction !== 'active' || !info) return;
    info.statementCount += 1;
    if (item.write) { info.writeCount += 1; info.affectedRows += row.affectedRows; }
    // This is a bounded in-memory summary, never a SQL/value history or audit payload.
    info.entries.push({sequence:info.statementCount, kind:item.kind, tables:item.tables.slice(0,20), tableCount:item.tables.length, executedAt:this.now(),
      ...(item.write ? {affectedRows:row.affectedRows} : {})});
    if (info.entries.length > LIMIT.transactionEntries) info.entries.shift();
  }
  effects(s, effect) { for (const row of s.results) if (row.transactionEffect === 'pending') row.transactionEffect = effect; }
  async commit(s) {
    if (s.transaction !== 'active') throw fail('MYSQL_SQL_NO_TRANSACTION', '当前没有可提交的事务。');
    s.committing = true;
    try { await this.query(s, 'COMMIT'); s.transaction = 'none'; s.transactionInfo = null; this.effects(s, 'committed'); }
    catch { this.lost(s, fail('MYSQL_SQL_OUTCOME_UNKNOWN', '提交结果不确定。')); throw fail('MYSQL_SQL_OUTCOME_UNKNOWN', '提交结果不确定，请重新查询核实，勿重复提交。'); }
    finally { s.committing = false; }
  }
  async rollback(s) {
    if (s.transaction !== 'active') return;
    await this.query(s, 'ROLLBACK'); s.transaction = 'none'; s.transactionInfo = null; this.effects(s, 'rolledBack');
  }
  controls(s, items, mode) {
    let active = s.transaction === 'active';
    if (active && mode !== 'manual') throw fail('MYSQL_SQL_TRANSACTION_ACTIVE', '有未提交事务，先提交或回滚后再切换执行模式。');
    for (const item of items) {
      if (['begin','commit','rollback'].includes(item.kind)) {
        if (mode !== 'manual') throw fail('MYSQL_SQL_TRANSACTION_MODE', '事务控制语句请使用手动事务模式；整批事务由应用统一管理。');
        if (item.kind === 'begin') { if (active) throw fail('MYSQL_SQL_TRANSACTION_ACTIVE', '不支持嵌套事务，请先结束当前事务。'); active = true; }
        else { if (!active) throw fail('MYSQL_SQL_NO_TRANSACTION', '脚本中的提交或回滚之前没有活动事务。'); active = false; }
      } else if (mode === 'manual') active = true;
    }
  }
  prepare(owner, plugin, environment, payload, assertOwner = () => {}) {
    const items = prepareMysqlSqlScript(payload.sql);
    const key = this.key(owner, plugin, payload.documentId);
    let s = this.sessions.get(key);
    if (!s) {
      if (this.sessions.size >= LIMIT.sessions || [...this.sessions.values()].filter(x => x.owner === owner && x.binding === binding(plugin)).length >= 6) throw fail('MYSQL_SQL_SESSION_LIMIT', 'SQL 会话数量已达上限，请先关闭其他标签。');
      s = {key, owner, documentId:payload.documentId, plugin:structuredClone(plugin), binding:binding(plugin), parent:this.runtime.require(plugin), mode:payload.mode,
        transaction:'none', status:'idle', results:[], child:null, plan:null, busy:false, touched:this.now(), released:false};
      this.sessions.set(key, s); this.ensureTimer();
    }
    this.assert(s, plugin, assertOwner);
    if (s.busy) throw fail('MYSQL_SQL_BUSY', '当前 SQL 标签正在执行，请等待或停止。');
    if (s.transaction === 'unknown' || s.status === 'unknown') throw fail('MYSQL_SQL_OUTCOME_UNKNOWN', '上次执行结果尚未确认，请在新的查询标签核实后关闭此标签。');
    this.controls(s, items, payload.mode);
    const writeCount = items.filter(item => item.write).length;
    s.plan = {id:crypto.randomUUID(), items, environmentRevision:environment?.revision, environmentType:environment?.environmentType,
      requiresConfirmation:items.some(item => item.dangerous) || (environment?.environmentType === 'production' && writeCount > 0),
      dangerous:items.some(item => item.dangerous), expires:this.now() + LIMIT.plan, used:false,
      fingerprint:crypto.createHash('sha256').update(payload.sql).digest('hex')};
    s.mode = payload.mode; s.status = 'prepared'; s.error = null; s.message = null; s.touched = this.now();
    return this.snapshot(s);
  }
  async execute(owner, plugin, environment, payload, assertOwner = () => {}) {
    const s = this.require(owner, plugin, payload.documentId), plan = s.plan;
    if (!plan || plan.id !== payload.planId) throw fail('MYSQL_SQL_PLAN_STALE', 'SQL 执行计划已变化，请重新执行。');
    assertOwner();
    if (s.released || binding(plugin) !== s.binding) throw fail('MYSQL_SQL_SESSION_STALE', 'SQL 执行目标已变化。');
    if (plan.used) return this.snapshot(s); // Re-delivery never replays a write.
    this.assert(s, plugin, assertOwner);
    if (s.busy || plan.expires <= this.now() || plan.environmentRevision !== environment?.revision || plan.environmentType !== environment?.environmentType) throw fail('MYSQL_SQL_PLAN_STALE', 'SQL 确认已过期或环境已变化，请重新执行。');
    if (plan.requiresConfirmation && payload.confirmed !== true) throw fail('CONFIRMATION_REQUIRED', '请确认当前目标和本批 SQL 的写入范围。');
    plan.used = true; s.busy = true; s.cancelled = false; s.status = 'running'; s.results = []; s.error = null; s.message = null;
    let bytes = 0, current = -1, started = this.now(), rolledBack = false;
    const maxRows = Math.min(plugin.limits.maxRows, 1000);
    const control = plan.items.length === 1 && ['begin','commit','rollback'].includes(plan.items[0].kind) ? plan.items[0].kind : null;
    const audit = {type:'plugin-operation', actor:'user', environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId, pluginType:'mysql', pluginNameSnapshot:plugin.displayName,
      operationId:plan.id, auditAction:'mysql.sql.' + (control ?? (plan.items.some(item => item.write) ? 'write' : 'read')), auditTarget:'固定数据库 ' + plugin.target.database, statementCount:plan.items.length, sqlFingerprint:plan.fingerprint, transactionMode:s.mode};
    try {
      await this.store.appendAudit(plugin.projectId, {...audit, type:'plugin-operation-started', result:'started'});
      await this.connection(s, assertOwner);
      const q = (sql, values) => this.query(s, sql, values);
      if (plan.items.some(item => item.write)) {
        const [[mode]] = await q('SELECT @@SESSION.sql_mode AS sqlMode');
        if (!/(?:^|,)STRICT_(?:TRANS|ALL)_TABLES(?:,|$)/u.test(mode.sqlMode ?? '')) throw mysqlSqlUnsafeError('strict_mode');
      }
      if (s.mode === 'atomic') { await this.begin(s); await assertMysqlSqlTables(q, plugin.target.database, plan.items); }
      for (let index = 0; index < plan.items.length; index++) {
        current = index; const item = plan.items[index]; started = this.now();
        this.assert(s, plugin, assertOwner);
        if (s.cancelled) throw fail('MYSQL_SQL_CANCELLED', 'SQL 执行已停止。');
        const row = {index:index + 1, line:item.line, kind:item.kind, status:'success', durationMs:0, transactionEffect:'none'};
        if (item.kind === 'begin') await this.begin(s);
        else if (item.kind === 'commit') await this.commit(s);
        else if (item.kind === 'rollback') await this.rollback(s);
        else {
          if (s.mode === 'manual' && s.transaction !== 'active') await this.begin(s);
          if (s.mode === 'autocommit' && item.write) await this.begin(s);
          if (s.mode !== 'atomic') await assertMysqlSqlTables(q, plugin.target.database, [item]);
          const request = mysqlSqlRequest(item, {database:plugin.target.database, maxRows});
          s.executingWrite = item.write;
          const [rows, fields] = await q(request.sql, request.values);
          s.executingWrite = false;
          if (item.write) {
            row.affectedRows = Number(rows.affectedRows ?? 0); row.warningCount = Number(rows.warningStatus ?? 0);
            if (row.warningCount) throw fail('MYSQL_SQL_WRITE_WARNING', '数据库报告写入警告，本事务已停止并尝试回滚，请检查字段值和约束。');
            row.transactionEffect = 'pending';
          } else {
            const maxBytes = Math.max(1, Math.min(plugin.limits.maxBytes, LIMIT.bytes - bytes));
            const data = capRows(rows, maxRows, maxBytes);
            bytes += data.bytes;
            row.data = {...data, columns:(fields ?? []).map(field => ({name:field.name, table:field.table || null, type:field.type})), durationMs:this.now() - started,
              fingerprint:crypto.createHash('sha256').update(item.sql).digest('hex'), limitsApplied:{maxRows, maxBytes, timeoutMs:Math.min(plugin.limits.timeoutMs, 30_000)}};
            if (s.transaction === 'active') row.transactionEffect = 'pending';
          }
          this.recordTransaction(s, item, row);
          if (s.mode === 'autocommit' && item.write) { await this.commit(s); row.transactionEffect = 'committed'; }
        }
        row.durationMs = this.now() - started; s.results.push(row);
      }
      this.assert(s, plugin, assertOwner);
      if (s.cancelled) throw fail('MYSQL_SQL_CANCELLED', 'SQL 执行已停止。');
      if (s.mode === 'atomic') await this.commit(s);
      s.status = 'success';
      s.message = s.transaction === 'active' ? '事务尚未提交。继续查询可查看当前事务内的数据，完成后请选择提交或回滚。' : '执行完成。';
    } catch (error) {
      s.executingWrite = false;
      let uncertain = s.status === 'unknown' || s.transaction === 'unknown';
      if (!uncertain && s.transaction === 'active') {
        try { await this.rollback(s); rolledBack = true; } catch (rollbackError) { this.lost(s, rollbackError); uncertain = true; }
      }
      s.error = uncertain ? {code:'MYSQL_SQL_OUTCOME_UNKNOWN', message:'执行或提交期间连接中断，结果尚未确认。请在新查询标签核实，不要重复执行。'} : publicError(error, current >= 0 ? plan.items[current]?.write ? 'write' : 'read' : undefined);
      s.status = uncertain ? 'unknown' : s.cancelled ? 'cancelled' : 'error';
      s.message = uncertain ? s.error.message : s.mode === 'autocommit' ? '已停止，之前成功提交的语句保持生效。' : rolledBack ? '已停止；当前未提交事务已回滚。' : '已停止，请查看各条语句的执行及提交状态。';
      const index = Math.max(0, current), item = plan.items[index];
      if (s.results.length <= index && item) s.results.push({index:index + 1, line:item.line, kind:item.kind, status:'error', durationMs:this.now() - started, error:s.error, transactionEffect:uncertain ? 'unknown' : 'none'});
      for (let next = s.results.length; next < plan.items.length; next++) { const skipped = plan.items[next]; s.results.push({index:next + 1, line:skipped.line, kind:skipped.kind, status:'skipped', durationMs:0, transactionEffect:'none'}); }
      if (uncertain || s.cancelled) await this.closeConnection(s);
    } finally {
      s.busy = false; s.touched = this.now();
      const saved = await this.store.appendAudit(plugin.projectId, {...audit, result:s.status, ...(s.error ? {errorCode:s.error.code} : {}), affectedRows:s.results.reduce((sum, item) => sum + (item.affectedRows ?? 0), 0), transaction:s.transaction}).then(() => true, () => false);
      if (!saved) s.message = (s.message ?? '') + ' 操作记录未能保存。';
    }
    return this.snapshot(s);
  }
  status(owner, scope, documentId) {
    const s = this.require(owner, scope, documentId);
    if (s.child && !s.busy) { try { this.assert(s, s.plugin, () => {}); } catch (error) { this.lost(s, error); void this.closeConnection(s); } }
    return this.snapshot(s);
  }
  async stop(owner, scope, payload) {
    const s = this.require(owner, scope, payload.documentId);
    if (s.plan?.id !== payload.planId) throw fail('MYSQL_SQL_PLAN_STALE', '正在执行的 SQL 已变化。');
    if (!s.busy) return this.snapshot(s);
    s.cancelled = true;
    // Interrupt only this tab's physical connection; never the plugin/MCP connection.
    this.lost(s, fail('MYSQL_SQL_CANCELLED', 'SQL 执行已停止。'));
    await this.closeConnection(s);
    return this.snapshot(s);
  }
  async release(owner, scope, documentId) {
    const key = this.key(owner, scope, documentId), s = this.sessions.get(key);
    if (!s) return {documentId, mode:'atomic', transaction:'none', status:'idle', results:[]};
    s.released = true; s.cancelled = true;
    await this.closeConnection(s);
    this.sessions.delete(key);
    if (!this.sessions.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    return {documentId, mode:s.mode, transaction:'none', status:'idle', results:[], message:'SQL 标签连接已释放；未提交事务将随连接关闭回滚。'};
  }
  closeOwner(owner) { return Promise.all([...this.sessions.values()].filter(s => s.owner === owner).map(s => this.release(owner, s.plugin, s.documentId))); }
  closeAll() { return Promise.all([...this.sessions.values()].map(s => this.release(s.owner, s.plugin, s.documentId))); }
  assertScopeIdle(scope) {
    const active = [...this.sessions.values()].some(s => s.plugin.projectId === scope.projectId
      && (!scope.environmentId || s.plugin.environmentId === scope.environmentId)
      && (s.busy || s.transaction === 'active' || s.transaction === 'unknown'));
    if (active) throw fail('MYSQL_SQL_TRANSACTION_ACTIVE', '此范围仍有 SQL 正在执行、未提交事务或待核实结果，请回到 SQL 标签提交、回滚或核实后关闭标签，再进行此操作。');
  }
  exitSummary() { return {active:[...this.sessions.values()].filter(s => s.busy || s.transaction === 'active' || s.transaction === 'unknown').length}; }
}
