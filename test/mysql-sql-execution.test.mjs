import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DesktopMysqlSql, prepareMysqlSqlRequest } from '../src/desktop-mysql-sql.mjs';
import { AppError } from '../src/errors.mjs';

const scope = {projectId:'fixture-project',environmentId:'fixture-environment',pluginInstanceId:'fixture-mysql'};
const plugin = {...scope,revision:1,pluginType:'mysql',displayName:'合成数据库',target:{database:'fixture'},limits:{maxRows:100,maxBytes:65536,timeoutMs:3000}};
const environment = {environmentType:'test',revision:1};
const owner = 'fixture-window';
const insert = (id, label = 'synthetic-private-' + id) => `INSERT INTO items (id, label) VALUES (${id}, '${label}')`;
const update = "UPDATE items SET label = 'synthetic-changed' WHERE id = 1";
const select = 'SELECT id, label FROM items';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise,resolve,reject};
}

function fixture(t, options = {}) {
  let clock = 1000;
  let committed = structuredClone(options.initialRows ?? []);
  const parent = {bindingHash:plugin.revision};
  let currentParent = parent;
  const children = [];
  const requests = [];
  const audits = [];
  const runtime = {
    require(value) {
      if (value.projectId !== scope.projectId || value.environmentId !== scope.environmentId || value.pluginInstanceId !== scope.pluginInstanceId || !currentParent) throw new AppError('PLUGIN_NOT_CONNECTED','Synthetic parent is unavailable.');
      return currentParent;
    },
    async openSqlConnection(value, expected, {signal} = {}) {
      assert.equal(expected,currentParent);
      const interrupted = deferred();
      void interrupted.promise.catch(() => undefined);
      const child = {
        id:children.length + 1, active:true, transaction:null, closes:0, onLost:null,
        assertActive() { if (!this.active) throw new AppError('MYSQL_SQL_SESSION_CLOSED','Synthetic child is closed.'); },
        close() { close(new AppError('MYSQL_SQL_SESSION_CLOSED','Synthetic child is closed.'),false); },
        lose(error = Object.assign(new Error('synthetic-private-driver-error'),{code:'ECONNRESET'})) { close(error,true); },
      };
      const abort = () => close(new AppError('MYSQL_SQL_CANCELLED','Synthetic child was cancelled.'),true);
      const close = (error, notify) => {
        if (!child.active) return;
        child.active = false; child.closes += 1; child.transaction = null;
        signal?.removeEventListener('abort',abort);
        interrupted.reject(error);
        if (notify) child.onLost?.(error);
      };
      signal?.addEventListener('abort',abort,{once:true});
      child.connection = {query:async (request) => {
        child.assertActive();
        const record = {...request,childId:child.id};
        requests.push(record);
        const work = (async () => {
          if (options.beforeQuery) await options.beforeQuery(record,child);
          child.assertActive();
          const sql = request.sql;
          if (sql === 'START TRANSACTION') {
            assert.equal(child.transaction,null,'Fixture refuses nested transactions.');
            child.transaction = structuredClone(committed);
            return [{affectedRows:0},[]];
          }
          if (sql === 'COMMIT') {
            assert.notEqual(child.transaction,null);
            committed = child.transaction; child.transaction = null;
            if (options.afterCommit) await options.afterCommit(record,child);
            return [{affectedRows:0},[]];
          }
          if (sql === 'ROLLBACK') { child.transaction = null; return [{affectedRows:0},[]]; }
          if (sql.includes('@@SESSION.sql_mode')) return [[{sqlMode:options.sqlMode ?? 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'}],[]];
          if (sql.includes('SELECT TABLE_TYPE, ENGINE')) return [options.tableRows ?? [{TABLE_TYPE:'BASE TABLE',ENGINE:options.engine ?? 'InnoDB'}],[]];
          if (sql.includes(' AS effective_grants ')) {
            if (options.grantsError) throw Object.assign(new Error('synthetic-private-metadata-error'),{code:'ER_TABLEACCESS_DENIED_ERROR'});
            return [options.grants ?? [{PRIVILEGE_TYPE:'TRIGGER'}],[]];
          }
          if (sql.includes('information_schema.TRIGGERS')) return [options.triggers ?? [],[]];
          if (sql.includes('information_schema.INNODB_FOREIGN')) {
            if (options.cascadeError) throw Object.assign(new Error('synthetic-private-metadata-error'),{code:'ER_SPECIFIC_ACCESS_DENIED_ERROR'});
            return [options.cascades ?? [],[]];
          }
          if (/ LIMIT 0$/u.test(sql)) return [[],[]];
          if (/^INSERT /iu.test(sql)) {
            const match = /VALUES\s*\((\d+),\s*'([^']*)'\)/iu.exec(sql);
            assert.ok(match,'Fixture INSERT must use fixed synthetic values.');
            const rows = child.transaction ?? committed;
            if (rows.some(row => row.id === Number(match[1]))) throw Object.assign(new Error('synthetic-private-duplicate-value'),{code:'ER_DUP_ENTRY'});
            rows.push({id:Number(match[1]),label:match[2]});
            return [{affectedRows:1,warningStatus:options.warningCount ?? 0},[]];
          }
          if (/^UPDATE /iu.test(sql)) {
            const rows = child.transaction ?? committed;
            const row = rows.find(item => item.id === 1);
            if (row) row.label = 'synthetic-changed';
            return [{affectedRows:row ? 1 : 0,warningStatus:0},[]];
          }
          if (/^DELETE /iu.test(sql)) {
            const rows = child.transaction ?? committed;
            const removed = rows.filter(item => item.id === 1).length;
            const kept = rows.filter(item => item.id !== 1);
            if (child.transaction) child.transaction = kept; else committed = kept;
            return [{affectedRows:removed,warningStatus:0},[]];
          }
          if (/^SELECT /u.test(sql)) return [structuredClone(child.transaction ?? committed),[{name:'id',table:'items',type:3},{name:'label',table:'items',type:253}]];
          throw new Error('Unexpected synthetic query: ' + sql);
        })();
        return Promise.race([work,interrupted.promise]);
      }};
      children.push(child);
      return child;
    },
  };
  const executor = new DesktopMysqlSql(runtime,{appendAudit:async (projectId,event) => {
    audits.push({projectId,...structuredClone(event)});
    if (options.auditFailure?.(event)) throw new Error('synthetic-audit-failure');
  }},{now:() => clock});
  t.after(() => executor.closeAll());
  return {
    executor,runtime,children,requests,audits,parent,
    rows:() => structuredClone(committed), advance:(ms) => { clock += ms; }, replaceParent:() => { currentParent = {...parent}; },
    prepare:(sql, mode = 'atomic', documentId = 'sql-a', env = environment) => executor.prepare(owner,plugin,env,{sql,mode,documentId}),
    execute:(plan, documentId = 'sql-a', env = environment, confirmed = true) => executor.execute(owner,plugin,env,{documentId,planId:plan.plan.planId,confirmed}),
    async run(sql, mode = 'atomic', documentId = 'sql-a', env = environment) {
      const plan = this.prepare(sql,mode,documentId,env);
      return this.execute(plan,documentId,env);
    },
  };
}

test('整批事务仅在所有语句成功后提交，并逐条返回提交状态', async t => {
  const f = fixture(t);
  const result = await f.run([insert(1),insert(2),select].join(';\n'));
  assert.equal(result.status,'success');
  assert.equal(result.transaction,'none');
  assert.deepEqual(f.rows().map(row => row.id),[1,2]);
  assert.deepEqual(result.results.map(row => row.transactionEffect),['committed','committed','committed']);
  assert.equal(result.results[0].affectedRows,1);
  assert.equal(result.results[2].data.rows.length,2);
  assert.deepEqual(f.requests.filter(request => ['START TRANSACTION','COMMIT','ROLLBACK'].includes(request.sql)).map(request => request.sql),['START TRANSACTION','COMMIT']);
});

test('手动事务摘要跨请求累计写入与查询，轮询不推迟闲置期限，也不保存数据值', async t => {
  const f = fixture(t);
  const first = await f.run(insert(1),'manual');
  const original = first.transactionSummary;
  assert.equal(original.startedAt,1000);
  assert.equal(original.idleTimeoutMs,300000);
  assert.equal(original.idleExpiresAt,301000);
  assert.equal(original.statementCount,1);
  assert.equal(original.writeCount,1);
  assert.equal(original.affectedRows,1);
  f.advance(60000);
  const polled = f.executor.status(owner,plugin,'sql-a').transactionSummary;
  assert.equal(polled.idleExpiresAt,original.idleExpiresAt);
  assert.equal(polled.serverNow,61000);
  const ownRead = await f.run(select,'manual');
  const summary = ownRead.transactionSummary;
  assert.equal(summary.id,original.id);
  assert.equal(summary.startedAt,original.startedAt);
  assert.equal(summary.idleExpiresAt,361000);
  assert.equal(summary.statementCount,2);
  assert.equal(summary.writeCount,1);
  assert.equal(summary.affectedRows,1);
  assert.deepEqual(summary.entries.map(row => [row.sequence,row.kind,row.tables,row.affectedRows]),[[1,'insert',['items'],1],[2,'select',['items'],undefined]]);
  assert.equal(summary.omittedCount,0);
  assert.doesNotMatch(JSON.stringify(summary),/synthetic-private|INSERT INTO|SELECT id|label/u);
  summary.entries[0].tables.push('mutated');
  assert.deepEqual(f.executor.status(owner,plugin,'sql-a').transactionSummary.entries[0].tables,['items']);
  const repeated = await f.executor.execute(owner,plugin,environment,{documentId:'sql-a',planId:ownRead.plan.planId,confirmed:true});
  assert.equal(repeated.transactionSummary.statementCount,2,'重复交付不重复累计');
});

test('只读事务与空事务的写入计数为零，标签之间的摘要互相隔离', async t => {
  const f = fixture(t);
  const empty = await f.run('BEGIN','manual');
  assert.equal(empty.transactionSummary.statementCount,0);
  assert.equal(empty.transactionSummary.writeCount,0);
  const read = await f.run(select,'manual');
  assert.equal(read.transactionSummary.statementCount,1);
  assert.equal(read.transactionSummary.writeCount,0);
  assert.equal(read.transactionSummary.affectedRows,0);
  const other = await f.run(insert(2),'manual','sql-b');
  assert.notEqual(other.transactionSummary.id,read.transactionSummary.id);
  assert.equal(other.transactionSummary.writeCount,1);
  assert.equal(f.executor.status(owner,plugin,'sql-a').transactionSummary.writeCount,0);
});

test('事务摘要最多保留最近一百条，计数仍覆盖整个事务，同一行重复修改累计为行次', async t => {
  const f = fixture(t,{initialRows:[{id:1,label:'original'}]});
  await f.run(Array.from({length:100},() => update).join(';'),'manual');
  const result = await f.run(update + ';' + select,'manual');
  assert.equal(result.transactionSummary.statementCount,102);
  assert.equal(result.transactionSummary.writeCount,101);
  assert.equal(result.transactionSummary.affectedRows,101);
  assert.equal(result.transactionSummary.entries.length,100);
  assert.equal(result.transactionSummary.entries[0].sequence,3);
  assert.equal(result.transactionSummary.omittedCount,2);
  assert.equal(result.transactionSummary.entries.at(-1).kind,'select');
});

test('提交、回滚和执行失败后清空待提交摘要，再次开启事务使用新摘要', async t => {
  const f = fixture(t);
  const first = await f.run(insert(1),'manual');
  assert.equal((await f.run('COMMIT','manual')).transactionSummary,undefined);
  const second = await f.run(insert(2),'manual');
  assert.notEqual(second.transactionSummary.id,first.transactionSummary.id);
  assert.equal(second.transactionSummary.writeCount,1);
  assert.equal((await f.run('ROLLBACK','manual')).transactionSummary,undefined);
  await f.run(insert(3),'manual');
  const failed = await f.run(insert(1),'manual');
  assert.equal(failed.status,'error');
  assert.equal(failed.transactionSummary,undefined);
  assert.equal((await f.run(select,'atomic')).transactionSummary,undefined);
  assert.equal((await f.run(select,'autocommit')).transactionSummary,undefined);
});

test('执行期间暂停闲置倒计时，完成后按后端时间重新开始', async t => {
  const entered = deferred(), gate = deferred(); let hold = false;
  const f = fixture(t,{beforeQuery:async request => {
    if (hold && request.sql.startsWith('SELECT `id`')) { entered.resolve(); await gate.promise; }
  }});
  await f.run(insert(1),'manual');
  f.advance(299000); hold = true;
  const executing = f.run(select,'manual');
  await entered.promise;
  const busy = f.executor.status(owner,plugin,'sql-a');
  assert.equal(busy.status,'running');
  assert.equal(busy.transactionSummary.idleExpiresAt,null);
  assert.equal(busy.transactionSummary.writeCount,1);
  f.advance(120000); gate.resolve();
  const complete = await executing;
  assert.equal(complete.transactionSummary.idleExpiresAt,720000);
  assert.equal(complete.transactionSummary.statementCount,2);
});

test('空闲自动回滚清空摘要，待确认的新计划不被当作已执行操作', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const f = fixture(t);
  await f.run(insert(1),'manual');
  const prepared = f.prepare(insert(2),'manual');
  assert.equal(prepared.transactionSummary.writeCount,1);
  f.advance(300001); t.mock.timers.tick(1000); await nextTurn();
  const expired = f.executor.status(owner,plugin,'sql-a');
  assert.equal(expired.status,'cancelled');
  assert.equal(expired.transactionSummary,undefined);
  assert.deepEqual(f.rows(),[]);
});

test('断线或提交应答丢失保留待核实摘要，但不再提供回滚倒计时', async t => {
  const f = fixture(t);
  const first = await f.run(insert(1),'manual');
  f.children[0].lose();
  const lost = f.executor.status(owner,plugin,'sql-a');
  assert.equal(lost.transaction,'unknown');
  assert.equal(lost.transactionSummary.id,first.transactionSummary.id);
  assert.equal(lost.transactionSummary.writeCount,1);
  assert.equal(lost.transactionSummary.idleExpiresAt,null);
  const g = fixture(t,{afterCommit:async (_request,child) => child.lose()});
  await g.run(insert(1),'manual');
  const uncertain = await g.run('COMMIT','manual');
  assert.equal(uncertain.status,'unknown');
  assert.equal(uncertain.transactionSummary.writeCount,1);
  assert.equal(uncertain.transactionSummary.idleExpiresAt,null);
  assert.equal(g.rows().length,1,'实际已提交也不能把没有应答的摘要当成已回滚');
  assert.equal((await g.executor.release(owner,plugin,'sql-a')).transactionSummary,undefined);
});

test('整批后续语句失败回滚前面的修改，未执行的语句标记跳过', async t => {
  const f = fixture(t);
  const result = await f.run([insert(1),insert(1),insert(2)].join(';'));
  assert.equal(result.status,'error');
  assert.equal(result.transaction,'none');
  assert.deepEqual(f.rows(),[]);
  assert.deepEqual(result.results.map(row => row.status),['success','error','skipped']);
  assert.equal(result.results[0].transactionEffect,'rolledBack');
  assert.equal(f.requests.filter(request => request.sql === 'ROLLBACK').length,1);
  assert.equal(f.requests.filter(request => request.sql === 'COMMIT').length,0);
  assert.doesNotMatch(JSON.stringify(result.error),/synthetic-private-duplicate/u);
});

test('逐条提交遇错停止，保留已提交语句且不执行后续写入', async t => {
  const f = fixture(t);
  const result = await f.run([insert(1),insert(1),insert(2)].join(';'),'autocommit');
  assert.equal(result.status,'error');
  assert.deepEqual(f.rows().map(row => row.id),[1]);
  assert.deepEqual(result.results.map(row => row.status),['success','error','skipped']);
  assert.equal(result.results[0].transactionEffect,'committed');
  assert.equal(f.requests.filter(request => request.sql === 'COMMIT').length,1);
  assert.equal(f.requests.filter(request => request.sql === 'ROLLBACK').length,1);
});

test('手动事务跨请求复用同一标签连接，其他标签看不到未提交写入', async t => {
  const f = fixture(t);
  const pending = await f.run(insert(1),'manual');
  assert.equal(pending.transaction,'active');
  assert.deepEqual(f.rows(),[]);
  const ownRead = await f.run(select,'manual');
  assert.equal(ownRead.results[0].data.rows.length,1);
  const otherRead = await f.run(select,'autocommit','sql-b');
  assert.equal(otherRead.results[0].data.rows.length,0);
  assert.equal(f.children.length,2);
  assert.equal(f.executor.exitSummary().active,1);
  assert.throws(() => f.prepare(select,'atomic'),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  const committed = await f.run('COMMIT','manual');
  assert.equal(committed.transaction,'none');
  assert.equal(f.rows().length,1);
  assert.equal(f.requests.filter(request => request.childId === 1 && request.sql === 'START TRANSACTION').length,1);
  assert.equal(f.executor.exitSummary().active,0);
});

test('手动事务可显式 BEGIN 和 ROLLBACK，整个未提交事务被撤回', async t => {
  const f = fixture(t);
  await f.run('BEGIN; ' + insert(1),'manual');
  assert.throws(() => f.prepare('BEGIN','manual'),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  const result = await f.run('ROLLBACK','manual');
  assert.equal(result.status,'success');
  assert.equal(result.transaction,'none');
  assert.deepEqual(f.rows(),[]);
  assert.throws(() => f.prepare('COMMIT','manual'),{code:'MYSQL_SQL_NO_TRANSACTION'});
});

test('生产写入必须确认整批一次，确认缺失不打开连接也不消费计划', async t => {
  const f = fixture(t);
  const production = {...environment,environmentType:'production'};
  const plan = f.prepare(insert(1) + ';' + insert(2),'atomic','sql-a',production);
  assert.equal(plan.plan.requiresConfirmation,true);
  assert.equal(plan.plan.writeCount,2);
  await assert.rejects(f.execute(plan,'sql-a',production,false),{code:'CONFIRMATION_REQUIRED'});
  assert.equal(f.children.length,0);
  assert.equal(f.audits.length,0);
  const result = await f.execute(plan,'sql-a',production,true);
  assert.equal(result.status,'success');
  assert.equal(f.rows().length,2);
});

test('无 WHERE 的 UPDATE 和 DELETE 即使测试环境也要求确认', async t => {
  const f = fixture(t);
  for (const sql of ["UPDATE items SET label = 'fixture'",'DELETE FROM items']) {
    const prepared = f.prepare(sql);
    assert.equal(prepared.plan.requiresConfirmation,true);
    assert.equal(prepared.plan.dangerous,true);
    await assert.rejects(f.execute(prepared,'sql-a',environment,false),{code:'CONFIRMATION_REQUIRED'});
  }
  assert.equal(f.children.length,0);
});

test('执行计划只消费一次，重复交付返回状态并不重放写入或审计', async t => {
  const f = fixture(t);
  const plan = f.prepare(insert(1));
  const first = await f.execute(plan);
  const count = f.requests.length;
  const repeated = await f.execute(plan);
  assert.deepEqual(repeated,first);
  assert.equal(f.requests.length,count);
  assert.equal(f.audits.length,2);
  assert.equal(f.rows().length,1);
});

test('过期、环境版本变化或环境分类变化都使未执行的计划失效', async t => {
  for (const change of ['expiry','revision','type']) {
    const f = fixture(t);
    const plan = f.prepare(insert(1));
    if (change === 'expiry') f.advance(120000);
    const env = {...environment,...(change === 'revision' ? {revision:2} : change === 'type' ? {environmentType:'production'} : {})};
    await assert.rejects(f.execute(plan,'sql-a',env),{code:'MYSQL_SQL_PLAN_STALE'});
    assert.equal(f.children.length,0);
    assert.equal(f.audits.length,0);
  }
});

test('确认绑定当前计划，重新准备不能执行之前的 SQL', async t => {
  const f = fixture(t);
  const old = f.prepare(insert(1));
  const current = f.prepare(insert(2));
  await assert.rejects(f.execute(old),{code:'MYSQL_SQL_PLAN_STALE'});
  await f.execute(current);
  assert.deepEqual(f.rows().map(row => row.id),[2]);
});

test('窗口、项目、环境、插件和标签标识均隔离执行权限', async t => {
  const f = fixture(t);
  const plan = f.prepare(insert(1));
  const payload = {documentId:'sql-a',planId:plan.plan.planId,confirmed:true};
  for (const mismatch of ['owner','projectId','environmentId','pluginInstanceId','documentId']) {
    await assert.rejects(f.executor.execute(mismatch === 'owner' ? 'other-window' : owner,
      ['projectId','environmentId','pluginInstanceId'].includes(mismatch) ? {...plugin,[mismatch]:'other'} : plugin,
      environment,mismatch === 'documentId' ? {...payload,documentId:'other-doc'} : payload),{code:'MYSQL_SQL_SESSION_STALE'});
  }
  assert.equal(f.children.length,0);
  await f.execute(plan);
  assert.equal(f.rows().length,1);
});

test('已消费计划的重复交付仍验证当前窗口和目标配置', async t => {
  const f = fixture(t);
  const plan = f.prepare(insert(1));
  await f.execute(plan);
  const payload = {documentId:'sql-a',planId:plan.plan.planId,confirmed:true};
  await assert.rejects(f.executor.execute(owner,{...plugin,revision:2},environment,payload),{code:'MYSQL_SQL_SESSION_STALE'});
  await assert.rejects(f.executor.execute(owner,plugin,environment,payload,() => { throw new AppError('DESKTOP_OWNER_STALE','Synthetic owner closed.'); }),{code:'DESKTOP_OWNER_STALE'});
  assert.equal(f.rows().length,1);
});

test('父连接重连后禁止准备和执行旧标签，写入从未开始', async t => {
  const f = fixture(t);
  const plan = f.prepare(insert(1));
  f.replaceParent();
  assert.throws(() => f.prepare(insert(2)),{code:'MYSQL_SQL_SESSION_STALE'});
  await assert.rejects(f.execute(plan),{code:'MYSQL_SQL_SESSION_STALE'});
  assert.equal(f.children.length,0);
});

test('审计只保存指纹和操作统计，不包含 SQL、参数、结果行或驱动正文', async t => {
  const f = fixture(t);
  await f.run(insert(1) + ';' + select);
  assert.equal(f.audits.length,2);
  for (const entry of f.audits) {
    assert.equal(entry.auditAction,'mysql.sql.write');
    assert.equal(entry.actor,'user');
    assert.match(entry.sqlFingerprint,/^[a-f0-9]{64}$/u);
    assert.equal(entry.statementCount,2);
  }
  const serialized = JSON.stringify(f.audits);
  assert.doesNotMatch(serialized,/synthetic-private|INSERT INTO|SELECT id|"rows"|"values"/u);
  assert.equal(f.audits[1].affectedRows,1);
});

for (const [name,configuration,reason] of [
  ['非事务存储引擎',{engine:'MyISAM'},'non_transactional'],
  ['非基础表',{tableRows:[{TABLE_TYPE:'VIEW',ENGINE:null}]},'table_type'],
  ['不可见表',{tableRows:[]},'table_unavailable'],
  ['缺少触发器可见权限',{grants:[]},'trigger_visibility'],
  ['触发器权限查询失败',{grantsError:true},'trigger_visibility'],
  ['相关触发器',{triggers:[{EVENT_MANIPULATION:'INSERT'}]},'trigger_side_effect'],
  ['非严格 SQL 模式',{sqlMode:'NO_ENGINE_SUBSTITUTION'},'strict_mode'],
]) {
  test(`${name} 在业务写入前拒绝并回滚`, async t => {
    const f = fixture(t,configuration);
    const result = await f.run(insert(1));
    assert.equal(result.status,'error');
    assert.equal(result.error.code,'MYSQL_SQL_WRITE_UNSAFE');
    assert.deepEqual(result.error.details,{reason});
    assert.equal(f.requests.some(request => /^INSERT /u.test(request.sql)),false);
    assert.deepEqual(f.rows(),[]);
    assert.doesNotMatch(JSON.stringify(result.error),/synthetic-private/u);
  });
}

test('实际语句拒绝按读写操作诊断，预检读取拒绝不误报为写入权限不足', async t => {
  for (const [sql,match,reason] of [
    [insert(1),/^INSERT /u,'write_privilege'],
    [select,/^SELECT `id`/u,'select_privilege'],
    [insert(1),/ LIMIT 0$/u,'select_privilege'],
  ]) {
    const f = fixture(t,{beforeQuery:request => {
      if (match.test(request.sql)) throw Object.assign(new Error('synthetic-private-permission-error'),{code:'ER_TABLEACCESS_DENIED_ERROR',sql:request.sql});
    }});
    const result = await f.run(sql,'manual');
    assert.equal(result.status,'error');
    assert.equal(result.transaction,'none');
    assert.equal(result.transactionSummary,undefined);
    assert.equal(result.error.code,'MYSQL_SQL_WRITE_UNSAFE');
    assert.deepEqual(result.error.details,{reason});
    assert.doesNotMatch(JSON.stringify(result.error),/synthetic-private|INSERT INTO|SELECT `/u);
  }
});

for (const [name,configuration] of [['入向级联外键',{cascades:[{TYPE:1}]}],['级联元数据不可见',{cascadeError:true}]]) {
  test(`${name} 阻止 UPDATE 和 DELETE，避免未审查副作用`, async t => {
    for (const sql of [update,'DELETE FROM items WHERE id = 1']) {
      const f = fixture(t,{...configuration,initialRows:[{id:1,label:'fixture-original'}]});
      const result = await f.run(sql);
      assert.equal(result.error.code,'MYSQL_SQL_WRITE_UNSAFE');
      assert.equal(f.requests.some(request => /^(?:UPDATE|DELETE) /u.test(request.sql)),false);
      assert.deepEqual(f.rows(),[{id:1,label:'fixture-original'}]);
    }
  });
}

test('无关触发器不拒绝 INSERT，元数据值都绑定当前库和当前表', async t => {
  const f = fixture(t,{triggers:[{EVENT_MANIPULATION:'DELETE'}]});
  const result = await f.run(insert(1));
  assert.equal(result.status,'success');
  const tables = f.requests.filter(request => request.sql.includes('SELECT TABLE_TYPE, ENGINE'));
  assert.equal(tables.length,2);
  assert.ok(tables.every(request => JSON.stringify(request.values) === JSON.stringify(['fixture','items'])));
  const grant = f.requests.find(request => request.sql.includes(' AS effective_grants '));
  assert.deepEqual(grant.values,['fixture','fixture','items']);
  const start = f.requests.findIndex(request => request.sql === 'START TRANSACTION');
  const lock = f.requests.findIndex(request => request.sql === 'SELECT * FROM `fixture`.`items` LIMIT 0');
  const write = f.requests.findIndex(request => /^INSERT /u.test(request.sql));
  assert.ok(start < lock && lock < write);
});

test('数据库写入警告停止当前事务，避免静默截断被提交', async t => {
  const f = fixture(t,{warningCount:1});
  const result = await f.run(insert(1));
  assert.equal(result.error.code,'MYSQL_SQL_WRITE_WARNING');
  assert.deepEqual(f.rows(),[]);
  assert.equal(f.requests.some(request => request.sql === 'COMMIT'),false);
});

test('COMMIT 已生效但应答丢失标记 unknown，禁止重复提交和重放', async t => {
  const f = fixture(t,{afterCommit:async (_request,child) => {
    child.lose();
    throw Object.assign(new Error('synthetic-private-driver-error'),{code:'ECONNRESET'});
  }});
  const plan = f.prepare(insert(1));
  const result = await f.execute(plan);
  assert.equal(result.status,'unknown');
  assert.equal(result.transaction,'unknown');
  assert.equal(result.error.code,'MYSQL_SQL_OUTCOME_UNKNOWN');
  assert.equal(result.results[0].transactionEffect,'unknown');
  assert.equal(f.rows().length,1,'Server commit happened even though response was lost.');
  assert.equal(f.children[0].active,false);
  assert.throws(() => f.prepare(insert(1)),{code:'MYSQL_SQL_OUTCOME_UNKNOWN'});
  const before = f.requests.length;
  assert.equal((await f.execute(plan)).status,'unknown');
  assert.equal(f.requests.length,before);
});

test('手动事务空闲断线保留 unknown 状态，后续请求不会自动重开重放', async t => {
  const f = fixture(t);
  await f.run(insert(1),'manual');
  f.children[0].lose();
  const status = f.executor.status(owner,plugin,'sql-a');
  assert.equal(status.status,'unknown');
  assert.equal(status.transaction,'unknown');
  assert.deepEqual(f.rows(),[]);
  assert.throws(() => f.prepare(insert(1),'manual'),{code:'MYSQL_SQL_OUTCOME_UNKNOWN'});
});

test('停止当前标签仅销毁该连接，其他标签及其手动事务仍可提交', {timeout:3000}, async t => {
  const entered = deferred();
  const gate = deferred();
  const f = fixture(t,{beforeQuery:async (request,child) => {
    if (child.id === 2 && /^SELECT /u.test(request.sql) && !request.sql.includes('information_schema')) { entered.resolve(); await gate.promise; }
  }});
  await f.run(insert(1),'manual','sql-a');
  const plan = f.prepare(select,'autocommit','sql-b');
  const running = f.execute(plan,'sql-b');
  await entered.promise;
  await f.executor.stop(owner,plugin,{documentId:'sql-b',planId:plan.plan.planId});
  const result = await running;
  assert.equal(result.status,'cancelled');
  assert.equal(f.children[1].active,false);
  assert.equal(f.children[0].active,true);
  assert.equal(f.executor.status(owner,plugin,'sql-a').transaction,'active');
  await f.run('COMMIT','manual','sql-a');
  assert.equal(f.rows().length,1);
  gate.resolve();
  await nextTurn();
});

test('执行中重复交付仅返回 running 状态，后续计划必须等待', {timeout:3000}, async t => {
  const entered = deferred();
  const gate = deferred();
  const f = fixture(t,{beforeQuery:async request => {
    if (/^INSERT /u.test(request.sql)) { entered.resolve(); await gate.promise; }
  }});
  const plan = f.prepare(insert(1));
  const running = f.execute(plan);
  await entered.promise;
  assert.equal((await f.execute(plan)).status,'running');
  assert.throws(() => f.prepare(insert(2)),{code:'MYSQL_SQL_BUSY'});
  gate.resolve();
  await running;
  assert.equal(f.rows().length,1);
  assert.equal(f.requests.filter(request => /^INSERT /u.test(request.sql)).length,1);
});

test('释放标签或窗口关闭时释放独立连接及未提交事务', async t => {
  const f = fixture(t);
  await f.run(insert(1),'manual','sql-a');
  await f.run(insert(2),'manual','sql-b');
  const released = await f.executor.release(owner,plugin,'sql-a');
  assert.equal(released.status,'idle');
  assert.equal(f.children[0].active,false);
  assert.equal(f.children[1].active,true);
  assert.deepEqual(f.rows(),[]);
  assert.throws(() => f.executor.status(owner,plugin,'sql-a'),{code:'MYSQL_SQL_SESSION_STALE'});
  await f.executor.closeOwner('other-owner');
  assert.equal(f.children[1].active,true);
  await f.executor.closeOwner(owner);
  assert.equal(f.children[1].active,false);
  assert.equal(f.executor.sessions.size,0);
  assert.equal(f.executor.timer,null);
});

test('闲置手动事务自动回滚并正常释放，不误报连接错误', async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const f = fixture(t);
  await f.run(insert(1),'manual');
  f.advance(300001);
  t.mock.timers.tick(1000);
  await nextTurn();
  const status = f.executor.status(owner,plugin,'sql-a');
  assert.equal(status.status,'cancelled');
  assert.equal(status.transaction,'none');
  assert.equal(status.error,undefined);
  assert.equal(f.children[0].active,false);
  assert.equal(f.requests.filter(request => request.sql === 'ROLLBACK').length,1);
  assert.deepEqual(f.rows(),[]);
});

test('开始审计失败阻止连接和写入，结束审计失败不伪装成回滚', async t => {
  const blocked = fixture(t,{auditFailure:event => event.type === 'plugin-operation-started'});
  const result = await blocked.run(insert(1));
  assert.equal(result.status,'error');
  assert.equal(blocked.children.length,0);
  assert.deepEqual(blocked.rows(),[]);
  const completed = fixture(t,{auditFailure:event => event.type === 'plugin-operation'});
  const committed = await completed.run(insert(1));
  assert.equal(committed.status,'success');
  assert.match(committed.message,/操作记录未能保存/u);
  assert.equal(completed.rows().length,1);
});

test('请求边界拒绝注入字段、伪造确认及缺失作用域', () => {
  const valid = {...scope,documentId:'sql-a',operation:'prepare',mode:'atomic',sql:select};
  assert.deepEqual(prepareMysqlSqlRequest(valid),scope);
  for (const invalid of [
    {...valid,actor:'agent'}, {...valid,allowWrites:true}, {...valid,projectId:''}, {...valid,documentId:'bad\nname'},
    {...scope,documentId:'sql-a',operation:'execute',planId:'not-a-plan',confirmed:true},
    {...scope,documentId:'sql-a',operation:'execute',planId:'00000000-0000-0000-0000-000000000000',confirmed:'true'},
  ]) assert.throws(() => prepareMysqlSqlRequest(invalid),{code:'INVALID_ARGUMENT'});
});

test('写入进行中断线不承诺回滚成功，计划结果为 unknown 且不能重放', {timeout:3000}, async t => {
  const entered = deferred();
  const gate = deferred();
  const f = fixture(t,{beforeQuery:async request => {
    if (/^INSERT /u.test(request.sql)) { entered.resolve(); await gate.promise; }
  }});
  const plan = f.prepare(insert(1));
  const executing = f.execute(plan);
  await entered.promise;
  f.children[0].lose();
  const result = await executing;
  assert.equal(result.status,'unknown');
  assert.equal(result.transaction,'unknown');
  assert.equal(result.results[0].transactionEffect,'unknown');
  assert.equal(result.error.code,'MYSQL_SQL_OUTCOME_UNKNOWN');
  assert.equal(result.transactionSummary.statementCount,0,'未收到成功应答的写入不能计为已确认，但计数为零也不能证明未写入');
  assert.equal(result.transactionSummary.writeCount,0);
  assert.deepEqual(result.transactionSummary.entries,[]);
  assert.equal(result.transactionSummary.idleExpiresAt,null);
  const count = f.requests.length;
  assert.equal((await f.execute(plan)).status,'unknown');
  assert.equal(f.requests.length,count);
  assert.deepEqual(f.rows(),[]);
  gate.resolve();
  await nextTurn();
  assert.deepEqual(f.rows(),[],'A late query continuation cannot revive a closed connection.');
});

test('逐条提交中第二次 COMMIT 应答丢失时保留前一条的已提交标记', async t => {
  let commits = 0;
  const f = fixture(t,{afterCommit:async (_request,child) => {
    commits += 1;
    if (commits === 2) {
      child.lose();
      throw Object.assign(new Error('synthetic-private-driver-error'),{code:'ECONNRESET'});
    }
  }});
  const result = await f.run([insert(1),insert(2),insert(3)].join(';'),'autocommit');
  assert.equal(result.status,'unknown');
  assert.deepEqual(result.results.map(row => row.transactionEffect),['committed','unknown','none']);
  assert.deepEqual(result.results.map(row => row.status),['success','error','skipped']);
  assert.deepEqual(f.rows().map(row => row.id),[1,2]);
});

test('手动事务后续语句失败回滚前一个请求的未提交修改', async t => {
  const f = fixture(t);
  await f.run(insert(1),'manual');
  const result = await f.run(insert(1),'manual');
  assert.equal(result.status,'error');
  assert.equal(result.transaction,'none');
  assert.deepEqual(f.rows(),[]);
  assert.equal(f.requests.filter(request => request.sql === 'ROLLBACK').length,1);
});

test('元数据锁之后再次核对表，存储引擎改变时拒绝执行', async t => {
  let tableChecks = 0;
  const tableRows = [{TABLE_TYPE:'BASE TABLE',ENGINE:'InnoDB'}];
  const f = fixture(t,{tableRows,beforeQuery:async request => {
    if (request.sql.includes('SELECT TABLE_TYPE, ENGINE') && ++tableChecks === 2) tableRows[0].ENGINE = 'MyISAM';
  }});
  const result = await f.run(insert(1));
  assert.equal(result.error.code,'MYSQL_SQL_WRITE_UNSAFE');
  assert.equal(tableChecks,2);
  assert.equal(f.requests.some(request => /^INSERT /u.test(request.sql)),false);
  assert.deepEqual(f.rows(),[]);
});

test('后面的语句不能通过安全检查时不会执行前面合法的写入', t => {
  const f = fixture(t);
  assert.throws(() => f.prepare(insert(1) + '; DROP TABLE items'),{code:'HARD_POLICY_DENIED'});
  assert.equal(f.executor.sessions.size,0);
  assert.equal(f.children.length,0);
  assert.equal(f.audits.length,0);
});

test('同一窗口同一插件限制六个标签，释放后能再次使用', async t => {
  const f = fixture(t);
  for (let index = 0; index < 6; index++) f.prepare(select,'autocommit','sql-' + index);
  assert.throws(() => f.prepare(select,'autocommit','sql-over'),{code:'MYSQL_SQL_SESSION_LIMIT'});
  await f.executor.release(owner,plugin,'sql-0');
  assert.equal(f.prepare(select,'autocommit','sql-over').status,'prepared');
  assert.equal(f.children.length,0);
});

test('闲置清理不会打断仍在执行的查询', {timeout:3000}, async t => {
  t.mock.timers.enable({apis:['setInterval']});
  const entered = deferred();
  const gate = deferred();
  const f = fixture(t,{beforeQuery:async request => {
    if (/^INSERT /u.test(request.sql)) { entered.resolve(); await gate.promise; }
  }});
  const plan = f.prepare(insert(1));
  const executing = f.execute(plan);
  await entered.promise;
  f.advance(300001);
  t.mock.timers.tick(1000);
  await nextTurn();
  assert.equal(f.children[0].active,true);
  assert.equal(f.requests.some(request => request.sql === 'ROLLBACK'),false);
  gate.resolve();
  assert.equal((await executing).status,'success');
  assert.equal(f.rows().length,1);
});

test('查询结果使用插件的行数和字节预算，执行器只返回有界结果', async t => {
  const f = fixture(t,{initialRows:Array.from({length:105},(_,id) => ({id,label:'fixture-row-' + id}))});
  const result = await f.run(select,'autocommit');
  assert.equal(result.results[0].data.rows.length,100);
  assert.equal(result.results[0].data.truncated,true);
  assert.ok(result.results[0].data.bytes <= plugin.limits.maxBytes);
  const request = f.requests.find(value => value.sql.startsWith('SELECT `id`'));
  assert.ok(request);
  assert.match(request.sql,/LIMIT 101$/u);
  assert.equal(request.bigNumberStrings,true);
  assert.equal(request.dateStrings,true);
  assert.equal(request.timeout,3000);
});

test('范围空闲检查覆盖真实执行状态：同环境全部插件和整项目，处理事务或释放后解除', {timeout:3000}, async t => {
  const entered = deferred();
  const gate = deferred();
  let blockRead = false;
  const f = fixture(t,{beforeQuery:async request => {
    if (blockRead && request.sql.startsWith('SELECT `id`')) { entered.resolve(); await gate.promise; }
  }});
  const sameEnvironmentOtherPlugin = {...scope,pluginInstanceId:'another-plugin'};
  await f.run(insert(1),'manual');
  assert.throws(() => f.executor.assertScopeIdle(sameEnvironmentOtherPlugin),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  assert.throws(() => f.executor.assertScopeIdle({projectId:scope.projectId}),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  assert.doesNotThrow(() => f.executor.assertScopeIdle({...scope,environmentId:'another-environment'}));
  assert.doesNotThrow(() => f.executor.assertScopeIdle({...scope,projectId:'another-project'}));
  await f.run('ROLLBACK','manual');
  assert.doesNotThrow(() => f.executor.assertScopeIdle(sameEnvironmentOtherPlugin));
  await f.run(insert(1),'manual');
  f.children[0].lose();
  assert.throws(() => f.executor.assertScopeIdle({projectId:scope.projectId}),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  await f.executor.release(owner,plugin,'sql-a');
  assert.doesNotThrow(() => f.executor.assertScopeIdle(sameEnvironmentOtherPlugin));
  blockRead = true;
  const plan = f.prepare(select,'autocommit','busy-doc');
  const running = f.execute(plan,'busy-doc');
  await entered.promise;
  assert.throws(() => f.executor.assertScopeIdle(sameEnvironmentOtherPlugin),{code:'MYSQL_SQL_TRANSACTION_ACTIVE'});
  gate.resolve();
  assert.equal((await running).status,'success');
  assert.doesNotThrow(() => f.executor.assertScopeIdle({projectId:scope.projectId}));
});
