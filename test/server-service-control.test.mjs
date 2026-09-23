import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerOperations } from '../src/server-operations.mjs';
import { V2Service } from '../src/v2-service.mjs';
import { ConfirmationManager } from '../src/confirmation-manager.mjs';
import { AppError, toPublicError } from '../src/errors.mjs';

function fixture(execute) {
  const plugin = { projectId: 'p', environmentId: 'e', pluginInstanceId: 's', pluginType: 'server', displayName: '测试服务器', sources: [] };
  const audits = [], changes = [], calls = [];
  const store = { getProject: async () => ({ name: '测试' }), getPlugin: async () => plugin, appendAudit: async (_id, event) => { audits.push(event); } };
  const operations = new ServerOperations({ executeApproved: async (...args) => { calls.push(args); return execute(...args); } }, store);
  const confirmations = new ConfirmationManager();
  const service = new V2Service({ workspaceStore: store, confirmationManager: confirmations, serverOperations: operations,
    connectionManager: { snapshot: () => ({ plugins: { s: { phase: 'connected' } } }) },
    contextManager: { verify: async () => ({ plugin, environment: { name: '测试' }, runbook: { content: '' } }) },
    workspaceChanged: event => changes.push(event),
  });
  const params = { projectId: 'p', environmentId: 'e', pluginInstanceId: 's', clientInstanceId: 'test', contextToken: 'fixture' };
  async function approve(capability, args) {
    let requestId;
    await assert.rejects(service.invoke(params, capability, args), error => { if (error.code !== 'CONFIRMATION_REQUIRED') return false; requestId = error.details.requestId; return true; });
    const { approvalToken } = confirmations.approve(requestId);
    return { requestId, invoke: () => service.invoke({ ...params, approvalToken }, capability, args) };
  }
  return { plugin, service, params, approve, confirmations, calls, audits, changes };
}

test('服务动作逐次确认，退出码零才标记执行成功', async t => {
  for (const action of ['start', 'stop', 'restart', 'reload']) await t.test(action, async () => {
    const result = { exitCode: 0, signal: null, stdout: '', stderr: '', operationId: 'fixture-operation' };
    const f = fixture(() => result), args = { unit: 'fixture.service', action };
    const approved = await f.approve('service.control', args);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await approved.invoke(), result);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][1], `LC_ALL=C systemctl ${action} -- 'fixture.service'`);
    assert.equal((await f.confirmations.status(f.params, approved.requestId)).status, 'succeeded');
    assert.deepEqual(f.changes.map(event => event.status), ['running', 'success']);
  });
});

test('服务命令非零或无退出码均返回稳定失败并更新确认、审计及界面事件', async t => {
  for (const exitCode of [1, 5, null]) await t.test(String(exitCode), async () => {
    const remoteText = '合成远端正文，不得进入错误或审计';
    const f = fixture(() => ({ exitCode, signal: exitCode === null ? 'TERM' : null, stdout: remoteText, stderr: remoteText }));
    const args = { unit: 'fixture.service', action: 'reload' }, approved = await f.approve('service.control', args);
    await assert.rejects(approved.invoke(), error => {
      assert.equal(error.code, 'SERVICE_CONTROL_FAILED');
      assert.deepEqual(error.details, { unit: 'fixture.service', action: 'reload', exitCode });
      assert.ok(!JSON.stringify(toPublicError(error)).includes(remoteText)); return true;
    });
    assert.equal((await f.confirmations.status(f.params, approved.requestId)).status, 'failed');
    assert.deepEqual(f.changes.map(event => event.status), ['running', 'error']);
    assert.equal(f.changes.at(-1).errorCode, 'SERVICE_CONTROL_FAILED');
    assert.equal(f.audits.at(-1).result, 'error');
    assert.equal(f.audits.at(-1).errorCode, 'SERVICE_CONTROL_FAILED');
    assert.ok(!JSON.stringify(f.audits).includes(remoteText));
    await assert.rejects(approved.invoke(), { code: 'CONFIRMATION_REQUIRED' });
    assert.equal(f.calls.length, 1);
  });
});

test('服务控制保留 SSH 传输错误且不隐式重试', async () => {
  const failure = new AppError('SSH_EXEC_FAILED', '连接中断');
  const f = fixture(() => { throw failure; });
  const approved = await f.approve('service.control', { unit: 'fixture.service', action: 'restart' });
  await assert.rejects(approved.invoke(), error => error === failure);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.confirmations.status(f.params, approved.requestId)).status, 'failed');
});

test('通用 Shell 仍返回退出码供调用方解释', async () => {
  const result = { exitCode: 1, stdout: '', stderr: '', signal: null };
  const f = fixture(() => result);
  const approved = await f.approve('shell.execute', { command: 'false' });
  assert.deepEqual(await approved.invoke(), result);
});
