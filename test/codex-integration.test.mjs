import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'smol-toml';
import { defaultDataRoot } from '../src/paths.mjs';
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
  assert.equal(typeof result.approvalId, 'string');
  const text = await fs.readFile(configPath, 'utf8');
  assert.deepEqual(JSON.parse(JSON.stringify(parse(text).mcp_servers['agent-ops'])), service.entry);
  assert.equal((await service.status(1)).status, 'configured');
  assert.equal((await fs.stat(configPath)).nlink, 1);
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config.toml']);
});

test('default data directory may be omitted without requiring reconnect or changing the file', async t => {
  const { service, configPath } = await fixture(t, '');
  service.entry.env.AI_OPS_DATA_DIR = defaultDataRoot({ env: { LOCALAPPDATA: process.env.LOCALAPPDATA } });
  const current = { ...service.entry, env: { ELECTRON_RUN_AS_NODE: '1' }, disabled_tools: ['blocked'], startup_timeout_sec: 30 };
  const original = '# 已有的本机配置\n' + stringify({ mcp_servers: { 'agent-ops': current } });
  await fs.writeFile(configPath, original);
  const state = await service.status(1);
  assert.equal(state.status, 'configured');
  assert.match(state.message, /无需重复配置/u);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config.toml']);
  const result = await service.install(1, state.approvalId);
  assert.equal(result.status, 'configured');
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), original);
});

test('missing data directory does not hide a custom root or other startup differences', async t => {
  const { service, configPath, root } = await fixture(t, '');
  const fallback = defaultDataRoot({ env: { LOCALAPPDATA: process.env.LOCALAPPDATA } });
  service.entry.env.AI_OPS_DATA_DIR = path.join(root, 'custom-data');
  const current = { ...service.entry, env: { ELECTRON_RUN_AS_NODE: '1' } };
  await fs.writeFile(configPath, stringify({ mcp_servers: { 'agent-ops': current } }));
  assert.equal((await service.status(1)).status, 'outdated');
  service.entry.env.AI_OPS_DATA_DIR = fallback;
  for (const change of [
    { command: 'old-workbench' },
    { args: ['old-entry.mjs'] },
    { enabled: false },
    { env: { ELECTRON_RUN_AS_NODE: '0' } },
    { env: { ELECTRON_RUN_AS_NODE: '1', AI_OPS_DATA_DIR: path.join(root, 'other-data') } },
  ]) {
    await fs.writeFile(configPath, stringify({ mcp_servers: { 'agent-ops': { ...current, ...change } } }));
    assert.equal((await service.status(1)).status, 'outdated');
  }
});

test('the configured default directory respects explicit Windows local app data overrides', { skip: process.platform !== 'win32' }, async t => {
  const { service, configPath, root } = await fixture(t, '');
  service.entry.env.AI_OPS_DATA_DIR = defaultDataRoot({ env: { LOCALAPPDATA: process.env.LOCALAPPDATA } });
  await fs.writeFile(configPath, stringify({ mcp_servers: { 'agent-ops': { ...service.entry, env: { ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: root } } } }));
  assert.equal((await service.status(1)).status, 'outdated');
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

test('reconnect updates stale paths and enables the server while preserving restrictions and unrelated text', async t => {
  const prefix = '\uFEFF# 用户偏好\r\nmodel = "fixture"\r\n[mcp_servers.other]\r\ncommand = "keep-tool"\r\n';
  const suffix = '[profiles.work]\r\nmodel = "keep-model" # 保留注释\r\n';
  const original = prefix + '[mcp_servers."agent-ops"] # 旧接入\r\ncommand = "old-tool"\r\nargs = ["--old"]\r\nenabled = false\r\ndisabled_tools = ["blocked"]\r\nstartup_timeout_sec = 30\r\n'
    + suffix + '[mcp_servers."agent-ops".env]\r\nCUSTOM = "fixture-value"\r\n';
  const { service, configPath } = await fixture(t, original);
  let state = await service.status(1);
  assert.equal(state.status, 'outdated');
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  assert.ok(!JSON.stringify(state).includes('fixture-value'));
  const result = await service.install(1, state.approvalId);
  assert.equal(result.status, 'configured');
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), original);
  const updated = await fs.readFile(configPath, 'utf8');
  assert.ok(updated.startsWith(prefix + suffix));
  assert.doesNotMatch(updated, /(?<!\r)\n/u);
  const entry = parse(updated.replace(/^\uFEFF/u, '')).mcp_servers['agent-ops'];
  assert.equal(entry.command, service.entry.command);
  assert.deepEqual(entry.args, service.entry.args);
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.disabled_tools, ['blocked']);
  assert.equal(entry.startup_timeout_sec, 30);
  assert.equal(entry.env.CUSTOM, 'fixture-value');
  state = await service.status(1);
  const reconnected = await service.install(1, state.approvalId);
  assert.equal(reconnected.status, 'configured');
  assert.equal(await fs.readFile(reconnected.backupPath, 'utf8'), updated);
  assert.equal(await fs.readFile(configPath, 'utf8'), updated);
});

test('inline entries and ambiguous dotted assignments remain read-only', async t => {
  for (const original of [
    'mcp_servers = {}\n',
    'mcp_servers = { agent-ops = { command = "old" } }\n',
    '[mcp_servers]\nagent-ops.command = "old"\n',
    '[mcp_servers]\nagent-ops.command = "old"\n[mcp_servers.agent-ops.env]\nCUSTOM = "value"\n',
  ]) {
    const { service, configPath } = await fixture(t, original);
    assert.equal((await service.status(1)).status, 'conflict');
    await assert.rejects(service.install(1, 'forged'), { code: 'CODEX_APPROVAL_EXPIRED' });
    assert.equal(await fs.readFile(configPath, 'utf8'), original);
  }
});

test('header-like content in strings and arrays is preserved during reconnect', async t => {
  const original = [
    '# 前缀注释', 'note = ' + '"'.repeat(3), '[mcp_servers.agent-ops]', 'text with \\" quote', '"'.repeat(3),
    "literal = " + "'".repeat(3), '[mcp_servers.agent-ops.env]', "'".repeat(3),
    'values = [', '["[mcp_servers.agent-ops]"],', ']',
    '[mcp_servers.other]', 'command = "keep"',
    '[mcp_servers.agent-ops]', 'command = "old"',
    '[mcp_servers.agent-ops-extra]', 'command = "also-keep"', '',
  ].join('\n');
  const { service, configPath } = await fixture(t, original);
  const state = await service.status(1);
  assert.equal(state.status, 'outdated');
  await service.install(1, state.approvalId);
  const updated = await fs.readFile(configPath, 'utf8');
  assert.ok(updated.startsWith(original.slice(0, original.indexOf('[mcp_servers.agent-ops]\ncommand'))));
  const parsed = parse(updated);
  for (const key of ['note', 'literal', 'values']) assert.deepEqual(parsed[key], parse(original)[key]);
  assert.equal(parsed.mcp_servers['agent-ops-extra'].command, 'also-keep');
});

test('reconnect removes HTTP transport while preserving tool approval settings', async t => {
  const { service, configPath } = await fixture(t, '[mcp_servers.agent-ops]\nurl = "https://fixture.invalid/mcp"\nbearer_token_env_var = "FIXTURE_TOKEN"\nenabled_tools = ["safe"]\ndefault_tools_approval_mode = "prompt"\n[mcp_servers.agent-ops.http_headers]\nX-Fixture = "fixture-value"\n');
  const state = await service.status(1);
  assert.equal(state.status, 'outdated');
  await service.install(1, state.approvalId);
  const entry = parse(await fs.readFile(configPath, 'utf8')).mcp_servers['agent-ops'];
  assert.equal(entry.url, undefined);
  assert.equal(entry.http_headers, undefined);
  assert.equal(entry.bearer_token_env_var, undefined);
  assert.deepEqual(entry.enabled_tools, ['safe']);
  assert.equal(entry.default_tools_approval_mode, 'prompt');
});

test('an external edit invalidates reconnect without overwriting the new content', async t => {
  const { service, configPath } = await fixture(t, '[mcp_servers.agent-ops]\ncommand = "old"\n');
  const state = await service.status(1);
  const external = '[mcp_servers.agent-ops]\ncommand = "external"\n';
  await fs.writeFile(configPath, external);
  await assert.rejects(service.install(1, state.approvalId), { code: 'CODEX_CONFIG_CHANGED' });
  assert.equal(await fs.readFile(configPath, 'utf8'), external);
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
