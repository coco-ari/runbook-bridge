import assert from 'node:assert/strict';
import net from 'node:net';
import { ServerPluginRuntime } from '../src/server-plugin-runtime.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { ServerWorkspaceFiles } from '../src/server-workspace-files.mjs';

// 仅恢复本次文件状态专项的确切目录；未知条目保留，不使用 Shell 或递归删除。
const host = process.env.RUNBOOK_LIVE_HOST, username = process.env.RUNBOOK_LIVE_USER, password = process.env.RUNBOOK_LIVE_PASSWORD;
const root = process.env.RUNBOOK_LIVE_CLEANUP_ROOT;
delete process.env.RUNBOOK_LIVE_PASSWORD;
assert.equal(net.isIP(host ?? ''), 4);
assert.ok(username && password && process.env.RUNBOOK_LIVE_MUTATIONS === 'new-resources-only');
assert.match(root ?? '', /^\/tmp\/runbookbridge-probe-[a-f0-9-]{36}$/u);
const scope = { projectId:'owned-cleanup-probe', environmentId:'isolated', pluginInstanceId:'probe-server' };
const plugin = { ...scope, pluginType:'server', configState:'ready', revision:1, displayName:'本次资源清理',
  target:{ host, port:22 }, auth:{ type:'password', username }, uplink:{ type:'direct' },
  limits:{ timeoutMs:10000, maxBytes:65536 }, sources:[], actions:[] };
let auditEvents = 0, stage = 'connecting';
const phase = value => { stage = value; console.log(JSON.stringify({ status:'cleanup-progress', stage })); };
const store = {
  getPlugin:async (...keys) => { assert.deepEqual(keys, Object.values(scope)); return plugin; },
  updatePlugin:async (_p, _e, _id, patch) => { Object.assign(plugin, patch); return plugin; },
  appendAudit:async () => { auditEvents += 1; },
};
const runtime = new ServerPluginRuntime(store, { load:async () => null }, {
  resolver:{ resolve:async value => { assert.equal(value, host); return [{ address:host, family:4 }]; } },
});
runtime.on('lifecycle', event => { if (['lost','disconnected'].includes(event.type)) console.log(JSON.stringify({ status:'cleanup-connection-event', stage, type:event.type })); });
const operations = new ServerOperations(runtime, store);
const files = new ServerWorkspaceFiles({ workspaceStore:store, serverRuntime:runtime, serverOperations:operations });
const owner = 'renderer:owned-state-cleanup';
const expected = new Map([
  ['state-source.txt', ['synthetic initial file\n', 'synthetic independently replaced content with a different size\n']],
  ['state-conflict.txt', ['synthetic conflicting destination\n']],
]);
const unexpected = () => Object.assign(new Error('存在未确认属于本次测试的条目，已保留。'), { code:'CLEANUP_UNEXPECTED_ENTRY' });
async function verify(entry) {
  const match = /^(state-(?:source|conflict)\.txt)(?:\.part-([a-f0-9]{24}))?$/u.exec(entry.name);
  if (!match || entry.type !== 'file' || entry.size > 512) throw unexpected();
  const target = root + '/' + entry.name;
  assert.equal(entry.path, target);
  const info = await files.fileInfo(owner, { ...scope, path:target });
  if (info.type !== 'file' || info.canonicalPath !== target || info.size > 512) throw unexpected();
  const read = await files.readFile(owner, { ...scope, path:target });
  assert.equal(read.canonicalPath, target); assert.equal(read.truncated, false);
  const bodies = expected.get(match[1]);
  if (!bodies.some(body => match[2] ? body.startsWith(read.content) : body === read.content)) throw unexpected();
  return target;
}
async function remove(target) {
  assert.ok(target === root || target.startsWith(root + '/'));
  const prepared = await files.prepareFileAction(owner, { ...scope, kind:'delete', path:target });
  await files.confirmFileAction(owner, { ...scope, operationId:prepared.operationId });
}
try {
  await assert.rejects(runtime.connect(plugin, { password }), error => {
    if (error.code !== 'SSH_HOST_KEY_CONFIRM_REQUIRED' || !error.details?.fingerprint) return false;
    plugin.target.hostKeyFingerprint = error.details.fingerprint; return true;
  });
  await runtime.connect(plugin, { password });
  phase('list-owned-directory');
  let page;
  try { page = await files.listDirectory(owner, { ...scope, path:root, deferLinks:true }); }
  catch (error) { if (error.code !== 'SOURCE_NOT_FOUND') throw error; }
  if (page) {
    assert.equal(page.canonicalPath, root); assert.equal(page.nextCursor, null); assert.equal(page.truncated, false);
    assert.ok(page.entries.length <= 6);
    const verified = [];
    phase('verify-owned-content');
    for (const entry of page.entries) { verified.push(await verify(entry)); console.log(JSON.stringify({ status:'verified-owned-file', count:verified.length })); }
    console.log(JSON.stringify({ status:'verified-owned-content', files:verified.length }));
    phase('remove-verified-files');
    for (const target of verified) {
      await remove(target);
      console.log(JSON.stringify({ status:'removed-owned-file' }));
    }
    phase('remove-empty-directory');
    await remove(root);
  }
  phase('verify-directory-absent');
  await assert.rejects(runtime.statRemotePath(plugin, root), { code:'SOURCE_NOT_FOUND' });
  console.log(JSON.stringify({ status:'cleanup-finished', auditEvents }));
} catch (error) {
  console.log(JSON.stringify({ status:'cleanup-incomplete', stage, code:error.code ?? error.name })); process.exitCode = 1;
} finally { files.dispose(); operations.docker.dispose(); await runtime.broker.closeAll(); }
