import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../src/workspace-store.mjs';
import { pluginConnectionFingerprint } from '../src/plugin-change-classifier.mjs';
import { OperationGate, capabilityRule } from '../src/operation-gate.mjs';
import { PluginManager } from '../src/plugin-manager.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginRegistry } from '../src/plugin-registry.mjs';
import { builtinPluginRegistry } from '../src/plugins/builtins.mjs';
import { normalizePlugin, sanitizePluginSnapshot } from '../src/plugin-config-model.mjs';

const scope = {projectId:'test-project', environmentId:'test-environment'};
const queueDefinition = {
  type:'test-queue',
  connectionFields:['endpoint', 'namespace'],
  connectionAdapter:{
    assessConfiguration:() => ({state:'complete', issues:[]}),
    resourceScope:plugin => ({state:'selected-unverified',kind:'queue-namespace',value:plugin.namespace}),
    dependencyRefs:() => [],
    credentialIdentity:plugin => ({endpoint:plugin.endpoint}),
    validationDigest:plugin => JSON.stringify([plugin.endpoint,plugin.namespace]),
    classifyChangedPath:() => 'session-affecting',
    validate:async () => ({ok:true}),
  },
  connectionNestedFields:{endpoint:['host']},
  normalizeConfiguration(input, existing, base) {
    const namespace = String(input.namespace ?? existing?.namespace ?? '').trim();
    if (!namespace) throw new TypeError('测试队列必须指定命名空间。');
    return {...base, configState:'ready', namespace, endpoint:{host:input.endpoint?.host ?? existing?.endpoint?.host}};
  },
  publicResource: plugin => ({namespace:plugin.namespace}),
  capabilities:{peek:{decision:'auto', risk:'read', label:'查看测试队列'}},
  invoke: ({runtime, plugin, capability, args}) => runtime.peek(plugin.namespace, args.limit),
};

test('第四种插件可以贡献独立配置结构，不受数据库或服务器字段限制', () => {
  const registry = createPluginRegistry([queueDefinition]);
  const plugin = normalizePlugin({
    pluginType:'test-queue', pluginInstanceId:'queue-main', displayName:'测试队列',
    namespace:' orders ', endpoint:{host:'queue.invalid'}, password:'discard-this',
  }, scope, null, registry);
  assert.equal(plugin.namespace, 'orders');
  assert.deepEqual(plugin.endpoint, {host:'queue.invalid'});
  assert.equal(plugin.projectId, scope.projectId);
  assert.equal(plugin.environmentId, scope.environmentId);
  assert.equal(plugin.revision, 1);
  assert.equal(plugin.password, undefined);
  assert.equal(plugin.target, undefined);
  assert.deepEqual(registry.get(plugin.pluginType).publicResource(plugin), {namespace:'orders'});
});

test('未知、原型链和未登记能力默认拒绝，注册表不能被运行时配置改写', () => {
  const registry = createPluginRegistry([queueDefinition]);
  for (const type of ['missing', 'constructor', '__proto__']) {
    assert.equal(registry.has(type), false);
    assert.throws(() => registry.get(type), {code:'PLUGIN_TYPE_UNSUPPORTED'});
    assert.equal(registry.capabilityRule(type, 'peek').decision, 'deny');
  }
  for (const capability of ['publish', 'constructor', '__proto__']) {
    assert.equal(registry.capabilityRule('test-queue', capability).decision, 'deny');
  }
  assert.throws(() => { registry.get('test-queue').capabilities.peek.decision = 'confirm'; }, TypeError);
  assert.throws(() => registry.types.push('untrusted'), TypeError);
  assert.throws(() => createPluginRegistry([queueDefinition, queueDefinition]), TypeError);
  assert.throws(() => createPluginRegistry([{...queueDefinition, invoke:null}]), TypeError);
  assert.throws(() => createPluginRegistry([{...queueDefinition, capabilities:{peek:{decision:'allow'}}}]), TypeError);
});

test('内置插件仍通过白名单清理配置和恢复快照', () => {
  for (const type of builtinPluginRegistry.types) {
    const input = {
      pluginType:type, pluginInstanceId:'main-plugin', displayName:'测试插件',
      target:{host:'example.invalid', database:'example', db:0, password:'discard-this'},
      auth:{username:'example', password:'discard-this'}, secrets:{password:'discard-this'},
    };
    const plugin = normalizePlugin(input, scope);
    assert.equal(plugin.configState, 'ready');
    assert.equal(plugin.pluginType, type);
    assert.doesNotMatch(JSON.stringify(plugin), /discard-this|"password":|"secrets":/);
    const snapshot = sanitizePluginSnapshot({...plugin, ciphertext:'discard-this'});
    assert.equal(snapshot.revision, plugin.revision);
    assert.equal(snapshot.updatedAt, plugin.updatedAt);
    assert.doesNotMatch(JSON.stringify(snapshot), /discard-this|ciphertext/);
  }
});

test('内置能力保留变更审批与数据库只读限制', () => {
  assert.equal(builtinPluginRegistry.capabilityRule('server', 'fs.write').decision, 'confirm');
  assert.equal(builtinPluginRegistry.capabilityRule('server', 'shell.execute').approvalLevel, 'strong');
  assert.equal(builtinPluginRegistry.capabilityRule('mysql', 'select').decision, 'auto');
  assert.equal(builtinPluginRegistry.capabilityRule('mysql', 'update').decision, 'deny');
  assert.equal(builtinPluginRegistry.capabilityRule('redis', 'write').decision, 'deny');
});

test('第四种插件的定制操作经公共调度执行，未登记操作不能到达运行时', async () => {
  const calls = [];
  const runtime = {peek(namespace, limit) { calls.push({namespace, limit}); return {messages:[]}; }};
  const registry = createPluginRegistry([queueDefinition]);
  const manager = new PluginManager({registry, runtimes:{'test-queue':runtime}});
  const plugin = normalizePlugin({pluginType:'test-queue', pluginInstanceId:'queue-main', namespace:'orders'}, scope, null, registry);
  assert.deepEqual(await manager.invoke(plugin, 'peek', {limit:3}), {messages:[]});
  assert.deepEqual(calls, [{namespace:'orders', limit:3}]);
  await assert.rejects(manager.invoke(plugin, 'publish', {}), {code:'CAPABILITY_NOT_IMPLEMENTED'});
  assert.equal(calls.length, 1);
  assert.throws(() => manager.runtime({...plugin, pluginType:'constructor'}), {code:'PLUGIN_TYPE_UNSUPPORTED'});
});

test('插件能力声明与既有安全规则一致，注册新插件不能自行授予 Agent 权限', () => {
  for (const type of builtinPluginRegistry.types) {
    for (const capability of Object.keys(builtinPluginRegistry.get(type).capabilities)) {
      assert.deepEqual(builtinPluginRegistry.capabilityRule(type, capability), capabilityRule(type, capability));
    }
  }
  const gate = new OperationGate({});
  assert.throws(() => gate.authorize({scope, plugin:{pluginType:'test-queue'}, capability:'peek', args:{}}), {code:'POLICY_DENIED'});
});


test('第四种插件通过公共存储创建、重载、更新和清理快照，定制字段参与连接指纹', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-plugin-extension-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const registry = createPluginRegistry([...builtinPluginRegistry.types.map(type => builtinPluginRegistry.get(type)),queueDefinition]);
  const store = new WorkspaceStore(root, {registry});
  await store.init();
  const project = await store.createProject({name:'扩展验收',environmentName:'测试环境'});
  const [environment] = await store.listEnvironments(project.projectId);
  const plugin = await store.createPlugin(project.projectId, environment.environmentId, {
    pluginType:'test-queue', pluginInstanceId:'queue-main', displayName:'队列',
    namespace:'orders', endpoint:{host:'queue.invalid'}, password:'discard-this',
  });
  const reloaded = new WorkspaceStore(root, {registry});
  assert.deepEqual(await reloaded.getPlugin(project.projectId, environment.environmentId, plugin.pluginInstanceId), plugin);
  const preview = (await reloaded.listEnvironments(project.projectId))[0].resourcePreview[0];
  assert.deepEqual(preview.resource, {namespace:'orders'});
  const prepared = await reloaded.preparePluginConnectionUpdate(project.projectId, environment.environmentId,
    plugin.pluginInstanceId, {namespace:'events'}, plugin.revision);
  assert.equal(prepared.change.kind, 'session-affecting');
  assert.deepEqual(prepared.change.changedPaths, ['namespace']);
  assert.notEqual(pluginConnectionFingerprint(plugin, registry), pluginConnectionFingerprint(prepared.after, registry));
  assert.equal(pluginConnectionFingerprint(plugin, registry), pluginConnectionFingerprint({...plugin, displayName:'新名称'}, registry));
  const updated = await reloaded.commitPluginSnapshot(prepared.after, prepared.before.revision);
  assert.equal(updated.namespace, 'events');
  assert.equal(updated.revision, 2);
  assert.equal(sanitizePluginSnapshot({...updated,password:'discard-this'}, registry).password, undefined);
  await assert.rejects(reloaded.preparePluginConnectionUpdate(project.projectId, environment.environmentId,
    plugin.pluginInstanceId, {policy:{peek:'auto'}}, updated.revision), {code:'INVALID_ARGUMENT'});
  await assert.rejects(reloaded.preparePluginConnectionUpdate(project.projectId, environment.environmentId,
    plugin.pluginInstanceId, {endpoint:{password:'discard-this'}}, updated.revision), {code:'INVALID_ARGUMENT'});
});
