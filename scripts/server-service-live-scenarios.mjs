import assert from 'node:assert/strict';
import path from 'node:path';
import { V2Service } from '../src/v2-service.mjs';
import { EnvironmentContextManager } from '../src/context-manager.mjs';
import { ConfirmationManager } from '../src/confirmation-manager.mjs';
import { evaluateCommandPolicy } from '../src/command-policy.mjs';

// 只管理本次随机目录对应的新建临时单元；服务命令固定为 /bin/true。
export async function runServiceControlScenarios({ runtime, plugin, operations, store, scope, root, owned, measure, waitFor, reconnect }) {
  assert.match(root, /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u);
  assert.ok(owned.has(root));
  const base = path.posix.basename(root), unit = base + '.service', timer = base + '.timer';
  const units = new Set([unit, timer]);
  const command = `systemd-run --quiet --unit=${base} --description=${base} --on-active=1h --timer-property=RemainAfterElapse=no --property=Type=oneshot --property=RemainAfterExit=yes --property=ExecReload=/bin/true --property=WorkingDirectory=${root} --property=TimeoutStartSec=10s --property=TimeoutStopSec=10s /bin/true`;
  assert.equal(evaluateCommandPolicy(command).allowed, true);
  const scopedStore = { ...store,
    getEnvironment: async (projectId, environmentId) => { assert.equal(projectId, scope.projectId); assert.equal(environmentId, scope.environmentId); return { projectId, environmentId, name: '临时服务测试' }; },
    getProject: async projectId => { assert.equal(projectId, scope.projectId); return { projectId, name: '隔离测试' }; },
    listPlugins: async (projectId, environmentId) => { assert.equal(projectId, scope.projectId); assert.equal(environmentId, scope.environmentId); return [plugin]; },
    publicPlugin: value => ({ pluginInstanceId: value.pluginInstanceId, pluginType: value.pluginType, displayName: value.displayName }),
  };
  const contexts = new EnvironmentContextManager(scopedStore), confirmations = new ConfirmationManager();
  const service = new V2Service({ workspaceStore: scopedStore, contextManager: contexts, confirmationManager: confirmations, serverOperations: operations,
    connectionManager: { snapshot: () => ({ plugins: { [scope.pluginInstanceId]: { phase: runtime.status(plugin).connected ? 'connected' : 'disconnected' } } }) } });
  const clientInstanceId = 'owned-service-probe';
  let params, attempted = false;
  async function inspect(name) {
    assert.ok(units.has(name));
    const result = await operations.inspectService(plugin, { unit: name, view: 'show' });
    assert.equal(result.truncated, false);
    return Object.fromEntries(result.stdout.split(/\r?\n/u).filter(line => line.includes('=')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  }
  function requireOwned(name, properties) {
    assert.ok(units.has(name));
    assert.equal(properties.Transient, 'yes');
    assert.equal(properties.FragmentPath, '/run/systemd/transient/' + name);
    if (name === unit) { assert.equal(properties.WorkingDirectory, root); assert.ok(properties.ExecStart.includes('path=/bin/true')); }
    else assert.equal(properties.Unit, unit);
  }
  async function confirmed(capability, args, { expectFailure = false } = {}) {
    if (capability === 'shell.execute') assert.deepEqual(args, { command, workingDirectory: root });
    else { assert.equal(capability, 'service.control'); assert.ok(units.has(args.unit)); requireOwned(args.unit, await inspect(args.unit)); }
    let requestId;
    await assert.rejects(service.invoke(params, capability, args), error => { if (error.code !== 'CONFIRMATION_REQUIRED') return false; requestId = error.details.requestId; return true; });
    if (capability === 'shell.execute') assert.equal(confirmations.pending.get(requestId).approvalLevel, 'strong');
    const { approvalToken } = confirmations.approve(requestId);
    if (expectFailure) {
      await assert.rejects(service.invoke({ ...params, approvalToken }, capability, args), { code: 'SERVICE_CONTROL_FAILED' });
      assert.equal((await service.confirmationStatus({ ...params, confirmationId: requestId })).status, 'failed');
      return;
    }
    const result = await service.invoke({ ...params, approvalToken }, capability, args);
    assert.equal(result.exitCode, 0);
    assert.equal((await service.confirmationStatus({ ...params, confirmationId: requestId })).status, 'succeeded');
    return result;
  }
  const control = (action, options) => confirmed('service.control', { unit, action }, options);
  try {
    const opened = await service.openEnvironment({ ...scope, clientInstanceId });
    params = { ...scope, clientInstanceId, contextToken: opened.contextToken };
    await measure('services.new-unit-preconditions', async () => {
      for (const name of units) assert.equal((await inspect(name)).LoadState, 'not-found');
      await assert.rejects(runtime.statRemotePath(plugin, root + '/never-created'), { code: 'SOURCE_NOT_FOUND' });
    });
    await measure('services.create-owned-transient-units', async () => {
      attempted = true;
      await confirmed('shell.execute', { command, workingDirectory: root });
      for (const name of units) requireOwned(name, await inspect(name));
      assert.equal((await inspect(unit)).ActiveState, 'inactive');
    });
    await measure('services.start-from-inactive', async () => {
      await control('start'); assert.equal((await inspect(unit)).ActiveState, 'active');
    });
    await measure('services.inspect-status-show-cat', async () => {
      for (const view of ['status', 'show', 'cat']) {
        const result = await operations.inspectService(plugin, { unit, view });
        assert.equal(result.exitCode, 0); assert.equal(result.truncated, false);
      }
    });
    await measure('services.restart-active', async () => {
      const before = await inspect(unit); await control('restart'); const after = await inspect(unit);
      assert.equal(after.ActiveState, 'active'); assert.notEqual(after.InvocationID, before.InvocationID);
    });
    await measure('services.reload-active', async () => {
      await control('reload'); assert.equal((await inspect(unit)).ActiveState, 'active');
    });
    await measure('services.owned-journal', async () => {
      const result = await operations.queryJournal(plugin, { unit, since: '-5 min', lines: 20 });
      assert.equal(result.exitCode, 0); assert.equal(result.truncated, false);
    });
    await measure('services.stop-active', async () => {
      await control('stop'); assert.equal((await inspect(unit)).ActiveState, 'inactive');
    });
    await measure('services.reload-inactive-reports-failure', () => control('reload', { expectFailure: true }));
    await measure('services.start-after-stop', async () => {
      await control('start'); assert.equal((await inspect(unit)).ActiveState, 'active');
    });
  } finally {
    try {
      if (attempted) await measure('services.cleanup-owned-transient-units', async () => {
        if (!runtime.status(plugin).connected) {
          await reconnect(); const opened = await service.openEnvironment({ ...scope, clientInstanceId }); params = { ...scope, clientInstanceId, contextToken: opened.contextToken };
        }
        // 定时器仅持有本次服务的引用，便于停止后再启动；先停服务再停定时器并核实单元已回收。
        for (const name of [unit, timer]) {
          const properties = await inspect(name);
          if (properties.LoadState === 'not-found') continue;
          requireOwned(name, properties);
          await confirmed('service.control', { unit: name, action: 'stop' });
        }
        await waitFor(async () => (await inspect(unit)).LoadState === 'not-found' && (await inspect(timer)).LoadState === 'not-found');
      });
    } catch (error) {
      console.log(JSON.stringify({ status: 'service-cleanup-required', testUnits: [...units] }));
      throw error;
    } finally { contexts.clear(); confirmations.invalidateEnvironment(scope.projectId, scope.environmentId); }
  }
}
