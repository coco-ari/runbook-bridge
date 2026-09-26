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
