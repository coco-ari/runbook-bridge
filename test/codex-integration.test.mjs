import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'smol-toml';
import { CodexIntegration, codexConfigPath, registerCodexIntegrationIpc } from '../src/codex-integration.mjs';

async function fixture(t, content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-codex-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'codex', 'config.toml');
  const copied = [];
  if (content !== undefined) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, content);
  }
  const service = new CodexIntegration({
    configPath, executablePath: 'C:\\应用 目录\\Agent运维工作台.exe',
    entryPath: 'C:\\应用 目录\\resources\\app.asar\\src\\mcp-v2.mjs',
    dataRoot: 'C:\\演示 数据\\AIOpsTool', clipboard: { writeText: value => copied.push(value) },
  });
  return { service, configPath, root, copied };
}

async function install(service, owner = 1) {
  const state = await service.status(owner);
  assert.equal(state.status, 'available');
  return service.install(owner, state.approvalId);
}

test('Codex home honors the host environment without depending on a CLI', () => {
  assert.equal(codexConfigPath({}, '/fixture-home'), path.join('/fixture-home', '.codex', 'config.toml'));
  assert.equal(codexConfigPath({ CODEX_HOME: '/custom-codex' }, '/fixture-home'), path.join(path.resolve('/custom-codex'), 'config.toml'));
});

test('first install creates a valid MCP entry with actual paths and detects it afterwards', async t => {
  const { service, configPath } = await fixture(t);
  const result = await install(service);
  assert.equal(result.status, 'configured');
  assert.equal(result.backupPath, null);
  assert.equal(result.approvalId, null);
  const text = await fs.readFile(configPath, 'utf8');
  assert.deepEqual(JSON.parse(JSON.stringify(parse(text).mcp_servers['agent-ops'])), service.entry);
  assert.equal((await service.status(1)).status, 'configured');
  assert.equal((await fs.stat(configPath)).nlink, 1);
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config.toml']);
});

test('append preserves comments, BOM, CRLF, unrelated settings and exact backup bytes', async t => {
  const original = '\uFEFF# 用户偏好\r\nmodel = "example-model"\r\n[mcp_servers.other]\r\ncommand = "other-tool"\r\n';
  const { service, configPath } = await fixture(t, original);
  const state = await install(service);
  assert.equal(state.status, 'configured');
  assert.equal(await fs.readFile(state.backupPath, 'utf8'), original);
  const updated = await fs.readFile(configPath, 'utf8');
  assert.ok(updated.startsWith(original));
  assert.equal(parse(updated.replace(/^\uFEFF/u, '')).mcp_servers.other.command, 'other-tool');
  assert.doesNotMatch(updated, /(?<!\r)\n/u);
  if (process.platform !== 'win32') assert.equal((await fs.stat(state.backupPath)).mode & 0o777, 0o600);
});

test('rechecking and copying are read-only and copied content only contains our entry', async t => {
  const original = 'model = "fixture-model"\n[mcp_servers.other]\ncommand = "fixture-tool"\n';
  const { service, configPath, copied } = await fixture(t, original);
  await service.status(1);
  await service.status(1);
  assert.deepEqual(service.copy(), { copied: true });
  assert.equal(copied[0], service.configSnippet);
  assert.deepEqual(Object.keys(parse(copied[0]).mcp_servers), ['agent-ops']);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config.toml']);
});

test('existing different, disabled and inline entries are not overwritten', async t => {
  for (const original of [
    '[mcp_servers.agent-ops]\ncommand = "other"\n',
    'mcp_servers = {}\n',
  ]) {
    const { service, configPath } = await fixture(t, original);
    assert.equal((await service.status(1)).status, 'conflict');
    await assert.rejects(service.install(1, 'forged'), { code: 'CODEX_APPROVAL_EXPIRED' });
    assert.equal(await fs.readFile(configPath, 'utf8'), original);
  }
  const { service, configPath } = await fixture(t);
  await install(service);
  await fs.writeFile(configPath, stringify({ mcp_servers: { 'agent-ops': { ...service.entry, enabled: false } } }));
  assert.equal((await service.status(1)).status, 'conflict');
});

test('malformed, oversized and non-regular configuration fail closed without exposing content', async t => {
  for (const content of ['model = "synthetic-private-marker"\n[bad', '#'.repeat(1024 * 1024 + 1), Buffer.from([0xff])]) {
    const { service } = await fixture(t, content);
    const result = await service.status(1);
    assert.equal(result.status, 'error');
    assert.equal(result.approvalId, null);
    assert.ok(!JSON.stringify(result).includes('synthetic-private-marker'));
  }
  const { service, configPath } = await fixture(t);
  await fs.mkdir(configPath, { recursive: true });
  assert.equal((await service.status(1)).status, 'error');
});

test('hardlinked configuration and linked configuration directories are not modified', async t => {
  const { service, configPath, root } = await fixture(t, 'model = "fixture"\n');
  await fs.link(configPath, path.join(root, 'hardlink.toml'));
  assert.equal((await service.status(1)).status, 'error');
  const linked = path.join(root, 'linked-codex');
  await fs.symlink(path.dirname(configPath), linked, process.platform === 'win32' ? 'junction' : 'dir');
  service.configPath = path.join(linked, 'config.toml');
  assert.equal((await service.status(1)).status, 'error');
});

test('approval is single-use, owner-bound, expiring and invalidated by another check', async t => {
  const { service } = await fixture(t);
  let state = await service.status(1);
  await assert.rejects(service.install(2, state.approvalId), { code: 'CODEX_APPROVAL_EXPIRED' });
  const old = state.approvalId;
  state = await service.status(1);
  await assert.rejects(service.install(1, old), { code: 'CODEX_APPROVAL_EXPIRED' });
  state = await service.status(1);
  service.approvals.get(1).expires = 0;
  await assert.rejects(service.install(1, state.approvalId), { code: 'CODEX_APPROVAL_EXPIRED' });
  state = await service.status(1);
  await service.install(1, state.approvalId);
  await assert.rejects(service.install(1, state.approvalId), { code: 'CODEX_APPROVAL_EXPIRED' });
});

test('external edits and newly created config invalidate pending installation', async t => {
  for (const initial of [undefined, 'model = "before"\n']) {
    const { service, configPath } = await fixture(t, initial);
    const state = await service.status(1);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'model = "after"\n');
    await assert.rejects(service.install(1, state.approvalId), { code: 'CODEX_CONFIG_CHANGED' });
    assert.equal(await fs.readFile(configPath, 'utf8'), 'model = "after"\n');
    assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config.toml']);
  }
});

test('an edit during staging is preserved and temporary files are cleaned', async t => {
  const { service, configPath } = await fixture(t, '# 原配置\n');
  const state = await service.status(1);
  const snapshot = service.snapshot.bind(service);
  let reads = 0;
  service.snapshot = async () => {
    if (++reads === 2) await fs.writeFile(configPath, '# 外部编辑\n');
    return snapshot();
  };
  await assert.rejects(service.install(1, state.approvalId), { code: 'CODEX_CONFIG_CHANGED' });
  assert.equal(await fs.readFile(configPath, 'utf8'), '# 外部编辑\n');
  const files = await fs.readdir(path.dirname(configPath));
  assert.equal(files.some(file => file.endsWith('.tmp')), false);
  assert.equal(files.filter(file => file.endsWith('.bak')).length, 1);
});

test('parallel install attempts only consume one approval and produce one entry', async t => {
  const { service, configPath } = await fixture(t);
  const state = await service.status(1);
  const results = await Promise.allSettled([service.install(1, state.approvalId), service.install(1, state.approvalId)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(Object.keys(parse(await fs.readFile(configPath, 'utf8')).mcp_servers), ['agent-ops']);
});

test('IPC accepts only the trusted main frame and fixed actions with no arbitrary paths', async t => {
  const { service } = await fixture(t);
  const handlers = new Map();
  const sender = { id: 5, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  registerCodexIntegrationIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    codexIntegration: service, isWorkspaceRenderer: candidate => candidate === sender,
  });
  const call = handlers.get('v2:codex-integration');
  assert.equal((await call({}, { action: 'status' })).error.code, 'FORBIDDEN');
  assert.equal((await call({ sender, senderFrame: {} }, { action: 'status' })).error.code, 'FORBIDDEN');
  for (const payload of [null, [], { action: 'remove' }, { action: 'install' }, { action: 'status', configPath: '/other' }, { action: 'copy', content: 'injected' }]) {
    assert.equal((await call(event, payload)).error.code, 'INVALID_ARGUMENT');
  }
  const state = await call(event, { action: 'status' });
  assert.equal(state.ok, true);
  const installed = await call(event, { action: 'install', approvalId: state.data.approvalId });
  assert.equal(installed.ok, true);
  assert.equal(installed.data.status, 'configured');
  assert.deepEqual(await call(event, { action: 'copy' }), { ok: true, data: { copied: true } });
});


test('repository IPC only opens the fixed destination from the trusted main frame', async () => {
  const handlers = new Map();
  const sender = { id: 1, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  let opens = 0;
  registerCodexIntegrationIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    isWorkspaceRenderer: candidate => candidate === sender, openRepository: async () => { opens += 1; },
  });
  const call = handlers.get('v2:open-repository');
  assert.equal((await call({}, {})).error.code, 'FORBIDDEN');
  assert.equal((await call({ sender, senderFrame: {} })).error.code, 'FORBIDDEN');
  assert.equal((await call(event, 'https://other.example.invalid')).error.code, 'INVALID_ARGUMENT');
  assert.equal(opens, 0);
  assert.deepEqual(await call(event), { ok: true, data: { opened: true } });
  assert.equal(opens, 1);
  const main = await fs.readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /openRepository: \(\) => shell\.openExternal\('https:\/\/github\.com\/coco-ari\/runbook-bridge'\)/u);
});
