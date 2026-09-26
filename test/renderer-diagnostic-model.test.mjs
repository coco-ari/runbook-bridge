import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticFor, diagnosticCopy } from '../renderer/v2/src/features/connections/diagnostic-model.ts';

test('diagnostics identify only known error stages and keep cancellation, timeout and uncertain writes distinct', () => {
  const cases = [
    ['ADDRESS_FAMILY_UNAVAILABLE','地址解析'],['ROUTE_UNAVAILABLE','网络与路由'],
    ['TUNNEL_PROVIDER_UNAVAILABLE','上游与隧道'],['SSH_HOST_KEY_CHANGED','主机身份与加密'],
    ['AUTHENTICATION_FAILED','身份认证'],['MYSQL_DATABASE_ACCESS_DENIED','资源与权限'],
    ['DATABASE_UNKNOWN_COLUMN','查询执行'],['CREDENTIAL_UNAVAILABLE','配置与凭据'],
  ];
  for (const [code,stage] of cases) assert.equal(diagnosticFor({code}).stage,stage);
  assert.equal(diagnosticFor({code:'DATABASE_UNKNOWN_COLUMN'}).outcome,'未完成');
  assert.equal(diagnosticFor({code:'CONNECT_CANCELLED'}).neutral,true);
  assert.equal(diagnosticFor({code:'CONNECT_TIMEOUT'}).outcome,'等待超时');
  assert.equal(diagnosticFor({code:'MYSQL_WRITE_OUTCOME_UNKNOWN'}).outcome,'结果待核实');
  assert.match(diagnosticFor({code:'MYSQL_WRITE_OUTCOME_UNKNOWN'},'operation').guidance,/不要直接重复写入/);
  assert.equal(diagnosticFor({code:'SSH_CONNECTION_FAILED'}).stage,'阶段尚未确定');
  assert.equal(diagnosticFor({code:'DATABASE_QUERY_TIMEOUT',details:{phase:'queue'}}).stage,'等待执行');
  assert.equal(diagnosticFor({code:'CLOUD_AUTH_FAILED'},'cloud').stage,'云配置');
  assert.match(diagnosticFor({code:'CLOUD_AUTH_FAILED'},'cloud').guidance,/所选仓库/);
});

test('copied diagnosis excludes arbitrary details, business content and secret-shaped codes', () => {
  const detail = diagnosticFor({code:'DATABASE_QUERY_TIMEOUT',details:{phase:'query',password:'secret-test-value',sql:'select private_business',guidance:'override-unsafe'}});
  assert.doesNotMatch(diagnosticCopy(detail),/secret-test-value|private_business|override-unsafe/);
  assert.equal(diagnosticFor({code:'secret=value',details:{phase:'password=secret'}}).code,'UNKNOWN_ERROR');
});

test('SQL 诊断明确区分权限无法核实、访问拒绝和当前版本不支持', () => {
  const trigger = diagnosticFor({code:'MYSQL_SQL_WRITE_UNSAFE',details:{reason:'trigger_visibility'}},'operation');
  assert.equal(trigger.stage,'触发器检查');
  assert.equal(trigger.outcome,'权限或可见性待确认');
  assert.match(trigger.guidance,/TRIGGER/u);
  assert.match(trigger.guidance,/角色授权可能无法核实/u);
  const cascade = diagnosticFor({code:'MYSQL_SQL_WRITE_UNSAFE',details:{reason:'cascade_visibility'}},'operation');
  assert.equal(cascade.outcome,'元数据无法核实');
  assert.match(cascade.guidance,/PROCESS/u);
  assert.match(cascade.guidance,/数据库版本/u);
  for (const [reason,permission] of [['write_privilege','INSERT / UPDATE / DELETE'],['select_privilege','SELECT']]) {
    const result = diagnosticFor({code:'MYSQL_SQL_WRITE_UNSAFE',details:{reason}},'operation');
    assert.equal(result.outcome,'数据库拒绝访问');
    assert.ok(result.guidance.includes(permission));
  }
  for (const reason of ['table_type','non_transactional','trigger_side_effect','cascade_side_effect']) {
    assert.equal(diagnosticFor({code:'MYSQL_SQL_WRITE_UNSAFE',details:{reason}},'operation').outcome,'当前版本不支持');
  }
  const strict = diagnosticFor({code:'MYSQL_SQL_WRITE_UNSAFE',details:{reason:'strict_mode'}},'operation');
  assert.equal(strict.outcome,'执行条件未满足');
  assert.match(strict.guidance,/STRICT_TRANS_TABLES/u);
  assert.match(strict.guidance,/不会自动修改/u);
});

test('SQL 诊断仅使用 code 与白名单 reason，复制结果不包含其他详情', () => {
  const diagnosis = diagnosticFor({code:'MYSQL_SQL_WRITE_UNSAFE',details:{reason:'write_privilege',phase:'metadata',sql:'sensitive-sql-marker',driverMessage:'sensitive-driver-marker',guidance:'unsafe-override',username:'private-username',host:'private-host'}},'operation');
  assert.equal(diagnosis.stage,'SQL 写入权限');
  assert.doesNotMatch(diagnosticCopy(diagnosis),/sensitive-|unsafe-override|private-/u);
  for (const reason of ['unknown-private-value','constructor','__proto__']) {
    const result = diagnosticFor({code:'MYSQL_SQL_WRITE_UNSAFE',details:{reason,phase:'__proto__'}},'operation');
    assert.equal(result.stage,'SQL 执行检查');
    assert.doesNotMatch(diagnosticCopy(result),/unknown-private-value|constructor|__proto__/u);
  }
  const unrelated = diagnosticFor({code:'AUTHENTICATION_FAILED',details:{reason:'write_privilege'}},'operation');
  assert.equal(unrelated.stage,'身份认证');
  assert.equal(diagnosticFor({code:'MYSQL_SQL_TRANSACTION_ACTIVE'},'operation').stage,'事务状态');
  assert.equal(diagnosticFor({code:'MYSQL_SQL_BUSY'},'operation').stage,'等待执行');
});
