import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { assertMysqlSqlTables } from '../src/mysql-sql-write-policy.mjs';
import { mysqlSqlPublicError, mysqlSqlUnsafeError } from '../src/mysql-sql-diagnostics.mjs';

const PRIVATE = 'synthetic-private-driver-text';
const item = {kind:'update',write:true,tables:['fixture_table']};

function metadata({tableRows,grants,triggers,relations,failAt,errorCode = 'ER_TABLEACCESS_DENIED_ERROR'} = {}) {
  const calls = [];
  const query = async (sql, values) => {
    calls.push({sql,values});
    if (failAt?.(sql)) throw Object.assign(new Error(PRIVATE),{code:errorCode,sql:PRIVATE,sqlMessage:PRIVATE});
    if (sql.startsWith('SELECT TABLE_TYPE, ENGINE')) return [tableRows ?? [{TABLE_TYPE:'BASE TABLE',ENGINE:'InnoDB'}]];
    if (sql.endsWith(' LIMIT 0')) return [[]];
    if (sql.includes(' AS effective_grants ')) return [grants ?? [{PRIVILEGE_TYPE:'TRIGGER'}]];
    if (sql.includes('information_schema.TRIGGERS')) return [triggers ?? []];
    if (sql.includes('information_schema.INNODB_FOREIGN')) return [relations ?? []];
    assert.fail('Unexpected metadata query.');
  };
  return {query,calls};
}

test('业务表和字段权限错误按已知操作分类，公开结果不携带驱动正文', () => {
  for (const code of ['ER_TABLEACCESS_DENIED_ERROR','ER_COLUMNACCESS_DENIED_ERROR','ER_SPECIFIC_ACCESS_DENIED_ERROR','ER_DBACCESS_DENIED_ERROR']) {
    for (const [operation,reason] of [['write','write_privilege'],['read','select_privilege'],[undefined,'operation_privilege']]) {
      const error = Object.assign(new Error(PRIVATE),{code,sql:PRIVATE,sqlMessage:PRIVATE,details:{password:PRIVATE,username:PRIVATE,host:PRIVATE,sql:PRIVATE}});
      const result = mysqlSqlPublicError(error,undefined,{operation});
      assert.equal(result.code,'MYSQL_SQL_WRITE_UNSAFE');
      assert.deepEqual(result.details,{reason});
      assert.doesNotMatch(JSON.stringify(result),new RegExp(PRIVATE,'u'));
    }
  }
});

test('认证错误与未知数据库错误不被错误归类为业务写权限不足', () => {
  assert.equal(mysqlSqlPublicError(Object.assign(new Error(PRIVATE),{code:'ER_ACCESS_DENIED_ERROR'}),undefined,{operation:'write'}).code,'AUTHENTICATION_FAILED');
  const unknown = mysqlSqlPublicError(Object.assign(new Error(PRIVATE),{code:'ER_UNKNOWN_SYNTHETIC',sqlMessage:PRIVATE}));
  assert.equal(unknown.code,'DATABASE_OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(unknown),new RegExp(PRIVATE,'u'));
});

test('前置检查仅公开白名单 reason，额外详情和错误正文不能注入权限提示', () => {
  const reasons = ['trigger_visibility','cascade_visibility','write_privilege','select_privilege','operation_privilege','table_unavailable','table_type','non_transactional','trigger_side_effect','cascade_side_effect','strict_mode'];
  for (const reason of reasons) {
    const source = new AppError('MYSQL_SQL_WRITE_UNSAFE',PRIVATE,{reason,sql:PRIVATE,guidance:PRIVATE,username:PRIVATE});
    const result = mysqlSqlPublicError(source);
    assert.equal(result.code,'MYSQL_SQL_WRITE_UNSAFE');
    assert.deepEqual(result.details,{reason});
    assert.doesNotMatch(JSON.stringify(result),new RegExp(PRIVATE,'u'));
    assert.equal(mysqlSqlUnsafeError(reason).message,result.message);
  }
  for (const reason of [PRIVATE,'constructor','__proto__',{},null]) {
    const result = mysqlSqlPublicError(new AppError('MYSQL_SQL_WRITE_UNSAFE',PRIVATE,{reason}));
    assert.equal(result.details,undefined);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(PRIVATE,'u'));
  }
});

test('普通 SQL 诊断只保留可验证的阶段与数值，不复制任意 details', () => {
  const result = mysqlSqlPublicError(new AppError('DATABASE_QUERY_TIMEOUT','合成超时',{
    phase:'metadata',operation:'table_check',timeoutMs:3000,line:2,statementIndex:0,retryable:false,queryStarted:false,
    sql:PRIVATE,sqlMessage:PRIVATE,driverError:PRIVATE,username:PRIVATE,host:PRIVATE,guidance:PRIVATE,
  }));
  assert.deepEqual(result.details,{phase:'metadata',operation:'table_check',statementIndex:0,line:2,timeoutMs:3000,retryable:false,queryStarted:false});
  assert.doesNotMatch(JSON.stringify(result),new RegExp(PRIVATE,'u'));
  assert.equal(mysqlSqlPublicError(new AppError('DATABASE_QUERY_TIMEOUT','合成超时',{phase:PRIVATE,operation:PRIVATE,timeoutMs:Infinity,line:PRIVATE})).details,undefined);
});

for (const [name,options,reason] of [
  ['表不可见',{tableRows:[]},'table_unavailable'],
  ['表结构读取权限不足',{failAt:sql => sql.startsWith('SELECT TABLE_TYPE')},'table_unavailable'],
  ['视图不支持',{tableRows:[{TABLE_TYPE:'VIEW',ENGINE:null}]},'table_type'],
  ['非事务引擎不支持',{tableRows:[{TABLE_TYPE:'BASE TABLE',ENGINE:'MyISAM'}]},'non_transactional'],
  ['校验表读取权限不足',{failAt:sql => sql.endsWith(' LIMIT 0')},'select_privilege'],
  ['无法确认直接触发器授权',{grants:[]},'trigger_visibility'],
  ['触发器权限检查失败',{failAt:sql => sql.includes(' AS effective_grants ')},'trigger_visibility'],
  ['触发器目录读取失败',{failAt:sql => sql.includes('information_schema.TRIGGERS')},'trigger_visibility'],
  ['相关触发器不支持',{triggers:[{EVENT_MANIPULATION:'UPDATE'}]},'trigger_side_effect'],
  ['级联目录不可见',{failAt:sql => sql.includes('information_schema.INNODB_FOREIGN')},'cascade_visibility'],
  ['数据库版本无法提供级联接口',{failAt:sql => sql.includes('information_schema.INNODB_FOREIGN'),errorCode:'ER_UNKNOWN_TABLE'},'cascade_visibility'],
  ['相关级联不支持',{relations:[{TYPE:4}]},'cascade_side_effect'],
]) {
  test(`${name} 保持拒绝执行并给出独立原因`, async () => {
    const f = metadata(options);
    await assert.rejects(assertMysqlSqlTables(f.query,'fixture_db',[item]),error => {
      assert.equal(error.code,'MYSQL_SQL_WRITE_UNSAFE');
      assert.deepEqual(error.details,{reason});
      assert.doesNotMatch(JSON.stringify(mysqlSqlPublicError(error)),new RegExp(PRIVATE,'u'));
      return true;
    });
    assert.equal(f.calls.some(call => /^(?:GRANT|SET|INSERT|UPDATE|DELETE) /u.test(call.sql)),false);
  });
}

test('可执行范围和元数据请求保持不变，没有新增全库权限探测或自动授权', async () => {
  const f = metadata({triggers:[{EVENT_MANIPULATION:'INSERT'}]});
  await assertMysqlSqlTables(f.query,'fixture_db',[item]);
  assert.equal(f.calls.length,6);
  assert.deepEqual(f.calls[0].values,['fixture_db','fixture_table']);
  assert.equal(f.calls[1].sql,'SELECT * FROM `fixture_db`.`fixture_table` LIMIT 0');
  assert.deepEqual(f.calls[3].values,['fixture_db','fixture_db','fixture_table']);
  assert.deepEqual(f.calls[4].values,['fixture_db','fixture_table']);
  assert.deepEqual(f.calls[5].values,['fixture_db/fixture_table',12]);
  assert.equal(f.calls.some(call => /SHOW GRANTS|GRANT |SET /u.test(call.sql)),false);
  const read = metadata({tableRows:[{TABLE_TYPE:'BASE TABLE',ENGINE:'MyISAM'}]});
  await assertMysqlSqlTables(read.query,'fixture_db',[{...item,kind:'select',write:false}]);
  assert.equal(read.calls.length,1,'Read-only requests do not gain new write privilege requirements.');
});

test('普通网络错误仍保持连接诊断，不伪装成 SELECT 权限不足', async () => {
  const f = metadata({failAt:sql => sql.endsWith(' LIMIT 0'),errorCode:'ECONNRESET'});
  await assert.rejects(assertMysqlSqlTables(f.query,'fixture_db',[item]),error => {
    assert.equal(mysqlSqlPublicError(error).code,'ROUTE_UNAVAILABLE');
    return true;
  });
});
