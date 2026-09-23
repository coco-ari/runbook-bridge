import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';
import { registerServerWorkspaceIpc } from '../src/server-workspace-ipc.mjs';

// 真实变更仅限本次随机目录；配置和凭据留在内存，屏幕不截图，清理逐项经过产品确认。
export async function openLiveFileUiProbe(scope, { transfers = false } = {}) {
  const host = process.env.RUNBOOK_LIVE_HOST, username = process.env.RUNBOOK_LIVE_USER, password = process.env.RUNBOOK_LIVE_PASSWORD;
  delete process.env.RUNBOOK_LIVE_PASSWORD;
  assert.ok(net.isIP(host ?? '') === 4 && username && password && process.env.RUNBOOK_LIVE_MUTATIONS === 'new-resources-only');
  assert.ok(!process.env.RUNBOOK_BRIDGE_SCREENSHOT_DIR, '真实文件专项禁止截图');
  const plugin = { ...scope, pluginType: 'server', configState: 'ready', revision: 1, displayName: '隔离文件界面实测',
    target: { host, port: 22 }, auth: { type: 'password', username }, uplink: { type: 'direct' }, limits: { timeoutMs: 10000, maxBytes: 65536 }, sources: [], actions: [] };
  let auditCount = 0;
  const store = {
    getPlugin: async (...keys) => { assert.deepEqual(keys, Object.values(scope)); return plugin; },
    updatePlugin: async (_project, _environment, _id, patch) => Object.assign(plugin, patch),
    appendAudit: async (_project, entry) => { assert.ok(!JSON.stringify(entry).includes(password)); auditCount += 1; },
  };
  const runtime = new ServerPluginRuntime(store, { load: async () => null }, { resolver: { resolve: async value => {
    assert.equal(value, host); return [{ address: host, family: 4 }];
  } } });
  const operations = new ServerOperations(runtime, store);
  const files = new ServerWorkspaceFiles({ workspaceStore: store, serverRuntime: runtime, serverOperations: operations });
  const root = '/tmp/runbookbridge-probe-' + crypto.randomUUID(), owner = 'renderer:file-ui-setup';
  const owned = new Set(), pending = new Map(), events = [], localNames = new Set(), contents = new Map();
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runbook-file-ui-'));
  let closing = false, transferProbe;
  const target = name => { assert.match(name, /^ui-(?:[a-z-]+(?:\.(?:txt|bin))?|中文 空格)$/u); return root + '/' + name; };
  async function action(kind, selected, name) {
    const prep = await files.prepareFileAction(owner, { ...scope, kind, path: selected, ...(name ? { name } : {}) });
    if (kind !== 'delete') owned.add(prep.destinationPath);
    const result = await files.confirmFileAction(owner, { ...scope, operationId: prep.operationId });
    if (kind !== 'mkdir') owned.delete(selected);
    return result;
  }
  async function waitFor(check) {
    const deadline = performance.now() + 15000;
    while (!await check()) { assert.ok(performance.now() < deadline, '合成文件准备超时'); await delay(20); }
  }
  async function seed(destination, names) {
    const selected = [];
    for (const name of names) {
      assert.match(name, /^ui-[a-z-]+\.txt$/u);
      const local = path.join(localRoot, name); localNames.add(name);
      const body = 'synthetic UI file ' + name + '\n';
      contents.set(path.posix.join(destination, name), body);
      await fs.writeFile(local, body, { flag: 'wx', mode: 0o600 }); selected.push(local);
    }
    const review = await files.beginUploadReview(owner, { ...scope, path: destination }, selected);
    let checked;
    await waitFor(async () => {
      checked = await files.readUploadReview(owner, { ...scope, reviewId: review.reviewId });
      assert.notEqual(checked.status, 'error'); return checked.status === 'ready';
    });
    for (const file of checked.files) { assert.equal(file.exists, false); assert.equal(path.posix.dirname(file.remotePath), destination); owned.add(file.remotePath); }
    const { jobs } = await files.confirmUpload(owner, { ...scope, preparationId: checked.preparationId, overwrite: false });
    await waitFor(() => jobs.every(job => !files.jobs.get(job.jobId).inFlight && ['completed', 'error', 'cancelled'].includes(files.jobs.get(job.jobId).status)));
    assert.ok(jobs.every(job => files.jobs.get(job.jobId).status === 'completed'));
  }
  const dispose = async () => {
    closing = true;
    let failure;
    try {
      for (const job of files.jobs.values()) if (['queued', 'running'].includes(job.status)) files.cancelUpload(job.ownerId, { ...scope, jobId: job.jobId });
      await waitFor(() => files.running === 0);
      if (owned.size && !runtime.status(plugin).connected) await runtime.connect(plugin, { password });
      for (const selected of [...owned].sort((a, b) => b.length - a.length)) {
        assert.ok(selected === root || selected.startsWith(root + '/'));
        try { await runtime.statRemotePath(plugin, selected); }
        catch (error) { if (error.code !== 'SOURCE_NOT_FOUND') throw error; owned.delete(selected); continue; }
        const info = await runtime.statRemotePath(plugin, selected);
        if (info.type === 'file' && !await transferProbe?.checkOwnedFile(selected, info)) {
          assert.ok(contents.has(selected), '清理只接收本次有正文记录的文件');
          assert.ok((await files.readFile(owner, { ...scope, path: selected })).content === contents.get(selected), '合成文件已变化时停止清理');
        } else assert.ok(['file', 'directory'].includes(info.type));
        await action('delete', selected);
      }
      assert.equal(owned.size, 0);
      await assert.rejects(runtime.statRemotePath(plugin, root), { code: 'SOURCE_NOT_FOUND' });
      process.stdout.write(JSON.stringify({ liveFileUiCleanup: 'passed', auditEvents: auditCount }) + '\n');
    } catch (error) { failure = error; }
    finally {
      transferProbe?.dispose(); files.dispose(); operations.docker.dispose(); await runtime.broker.closeAll();
      const actual = await fs.realpath(localRoot);
      assert.equal(actual, path.resolve(localRoot)); assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir())); assert.match(path.basename(actual), /^runbook-file-ui-[A-Za-z0-9]+$/u);
      for (const name of localNames) { const selected = path.join(actual, name); const stat = await fs.lstat(selected).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); if (!stat) continue; assert.ok(stat.isFile() && !stat.isSymbolicLink()); await fs.unlink(selected); }
      await fs.rmdir(actual);
    }
    if (failure) throw Object.assign(new Error('真实文件界面专项清理失败'), { code: failure.code ?? failure.name });
  };
  try {
    await assert.rejects(runtime.connect(plugin, { password }), error => {
      if (error.code !== 'SSH_HOST_KEY_CONFIRM_REQUIRED' || !error.details?.fingerprint) return false;
      plugin.target.hostKeyFingerprint = error.details.fingerprint; return true;
    });
    await runtime.connect(plugin, { password });
    await action('mkdir', '/tmp', path.posix.basename(root));
    assert.equal((await files.listDirectory(owner, { ...scope, path: root })).entries.length, 0);
    await action('mkdir', root, 'ui-nonempty');
    await seed(root, ['ui-source.txt', 'ui-existing.txt']);
    await seed(target('ui-nonempty'), ['ui-inside.txt']);
    if (transfers) {
      const { createLiveTransferUi } = await import('./server-live-transfer-ui.mjs');
      transferProbe = await createLiveTransferUi({ runtime, plugin, files, scope, owner, root, owned, localRoot, localNames });
    }
    const adapters = {
      closeOwner: id => files.closeOwner(id),
      async listDirectory(id, input) {
        assert.ok(['/', '/tmp'].includes(input.path) || input.path === root || owned.has(input.path));
        return files.listDirectory(id, input);
      },
      async fileInfo(id, input) { assert.ok(owned.has(input.path)); return files.fileInfo(id, input); },
      async readFile(id, input) { assert.ok(owned.has(input.path)); return files.readFile(id, input); },
      async prepareFileAction(id, input) {
        assert.ok(owned.has(input.path) && (input.path === root ? input.kind === 'mkdir' : input.path.startsWith(root + '/')));
        if (input.kind !== 'delete') assert.match(input.name, /^ui-(?:[a-z-]+(?:\.(?:txt|bin))?|中文 空格)$/u);
        if (input.kind === 'rename') assert.ok(![...owned].some(value => value.startsWith(input.path + '/')), '本专项只重命名文件或空目录');
        const prepared = await files.prepareFileAction(id, input);
        pending.set(prepared.operationId, { ...input, destination: prepared.destinationPath });
        return prepared;
      },
      async confirmFileAction(id, input) {
        const prepared = pending.get(input.operationId); assert.ok(prepared);
        if (prepared.kind !== 'delete') { assert.ok(prepared.destination.startsWith(root + '/')); owned.add(prepared.destination); }
        const result = await files.confirmFileAction(id, input);
        pending.delete(input.operationId);
        if (prepared.kind === 'rename' && contents.has(prepared.path)) { contents.set(prepared.destination, contents.get(prepared.path)); contents.delete(prepared.path); }
        if (prepared.kind !== 'mkdir') owned.delete(prepared.path);
        return result;
      },
      cancelFileAction(id, input) { pending.delete(input.operationId); return files.cancelFileAction(id, input); },
    };
    const channels = new Map([
      ['server-workspace-list-directory', 'listDirectory'], ['server-workspace-file-info', 'fileInfo'],
      ['server-workspace-read-file', 'readFile'], ['server-workspace-prepare-file-action', 'prepareFileAction'],
      ['server-workspace-confirm-file-action', 'confirmFileAction'], ['server-workspace-cancel-file-action', 'cancelFileAction'],
    ]);
    if (transferProbe) {
      Object.assign(adapters, transferProbe.adapters);
      for (const channel of transferProbe.channels) channels.set(channel, null);
    }
    for (const method of [...channels.values()].filter(Boolean)) {
      const callback = adapters[method];
      adapters[method] = async (id, input) => {
        assert.equal(closing, false);
        const started = performance.now();
        try {
          const result = await callback(id, input);
          assert.ok(!JSON.stringify(result).includes(password));
          events.push({ method, status: 'passed', ms: Math.round((performance.now() - started) * 10) / 10 });
          return result;
        } catch (error) {
          events.push({ method, status: 'rejected', code: error.code ?? error.name, ms: Math.round((performance.now() - started) * 10) / 10 });
          throw error;
        }
      };
    }
    return {
      root, target, transfers: transferProbe,
      register(ipcMain, isWorkspaceRenderer) {
        for (const channel of channels.keys()) ipcMain.removeHandler('v2:' + channel);
        registerServerWorkspaceIpc({ handle: (channel, callback) => {
          if (channels.has(channel.slice(3))) ipcMain.handle(channel, callback);
        } }, { isWorkspaceRenderer, serverWorkspaceFiles: adapters, ...transferProbe?.services });
      },
      async absent(name) { await assert.rejects(runtime.statRemotePath(plugin, target(name)), { code: 'SOURCE_NOT_FOUND' }); },
      async present(name) {
        const selected = target(name); assert.ok(owned.has(selected));
        const info = await runtime.statRemotePath(plugin, selected);
        if (info.type === 'file') assert.ok((await files.readFile(owner, { ...scope, path: selected })).content === contents.get(selected), '文件内容保持本次合成值');
        return info.type;
      },
      summary: () => ({ events: [...events], pending: pending.size, auditEvents: auditCount }),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw Object.assign(new Error('真实文件界面专项初始化失败'), { code: error.code ?? error.name });
  }
}
