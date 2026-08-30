import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const importModel = () => import(pathToFileURL(path.join(
  root,'renderer','v2','src','features','audit','audit-request-model.ts',
)).href);
const importCopy = () => import(pathToFileURL(path.join(
  root,'renderer','v2','src','lib','operation-copy.ts',
)).href);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve,onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise,resolve,reject};
}

test('Audit same-scope refresh is singleflight and a stale scope cannot commit',async () => {
  const {AuditRequestCoordinator} = await importModel();
  const coordinator = new AuditRequestCoordinator();
  const firstResult = deferred();
  let calls = 0;
  coordinator.activateScope('scope-a');
  const first = coordinator.start('scope-a',() => {
    calls += 1;
    return firstResult.promise;
  });
  const duplicate = coordinator.start('scope-a',() => {
    calls += 1;
    return Promise.resolve({entries:['duplicate']});
  });
  assert.equal(first.started,true);
  assert.equal(duplicate.started,false);
  assert.equal(duplicate.lease,first.lease);
  assert.equal(calls,0,'task begins on the next microtask');
  await Promise.resolve();
  assert.equal(calls,1);

  coordinator.activateScope('scope-b');
  firstResult.resolve({entries:['stale']});
  await first.lease.promise;
  assert.equal(coordinator.isCurrent(first.lease.ticket),false);
});

test('Audit clear invalidates the older scan without letting it delete the fresh lease',async () => {
  const {AuditRequestCoordinator} = await importModel();
  const coordinator = new AuditRequestCoordinator();
  const oldResult = deferred();
  const freshResult = deferred();
  coordinator.activateScope('scope-a');
  const old = coordinator.start('scope-a',() => oldResult.promise);
  const pending = coordinator.invalidateScope('scope-a');
  assert.equal(pending,old.lease.promise);
  assert.equal(coordinator.isCurrent(old.lease.ticket),false);

  const fresh = coordinator.start('scope-a',() => freshResult.promise);
  assert.equal(fresh.started,true);
  assert.notEqual(fresh.lease,old.lease);
  oldResult.resolve({entries:['old']});
  await pending;
  assert.equal(coordinator.inflightCount,1);
  assert.equal(coordinator.isCurrent(fresh.lease.ticket),true);

  freshResult.resolve({entries:['fresh']});
  assert.deepEqual(await fresh.lease.promise,{entries:['fresh']});
  assert.equal(coordinator.inflightCount,0);
});

test('operation presentation copy localizes known values and never exposes unknown enums or error codes',async () => {
  const copy = await importCopy();

  assert.equal(copy.auditOperationLabel('plugin-connected'),'连接插件');
  assert.equal(copy.auditOperationLabel('future-internal-event'),'其他受控操作');
  assert.equal(copy.capabilityLabel('fs.delete'),'删除服务器路径');
  assert.equal(copy.capabilityLabel('internal.capability'),'未识别的服务器操作');
  assert.equal(copy.serviceActionLabel('restart'),'重新启动');
  assert.equal(copy.serviceActionLabel('internal-action'),'服务变更');
  assert.equal(copy.remoteTypeLabel('symlink'),'符号链接');
  assert.equal(copy.remoteTypeLabel('internal-type'),'服务器路径');
  assert.equal(
    copy.publicErrorLabel('CONFIRMATION_EXPIRED'),
    '本次确认已过期，请让 Agent 重新发起。',
  );
  assert.equal(
    copy.publicErrorLabel('FUTURE_INTERNAL_ERROR_CODE'),
    '操作未完成，请检查目标状态后重试。',
  );
  assert.doesNotMatch(copy.publicErrorLabel('FUTURE_INTERNAL_ERROR_CODE'),/FUTURE|ERROR_CODE/u);
  assert.equal(
    copy.localizeOperationalSummary('restart systemd 服务 / fs.write'),
    '重新启动 systemd 服务 / 写入服务器文件',
  );
});

test('React audit feature keeps scope, search, filter, clear and request contracts',async () => {
  const [source,model] = await Promise.all([
    fs.readFile(path.join(
      root,'renderer','v2','src','features','audit','AuditFeature.tsx',
    ),'utf8'),
    fs.readFile(path.join(
      root,'renderer','v2','src','features','audit','audit-request-model.ts',
    ),'utf8'),
  ]);
  const all = `${source}\n${model}`;

  assert.match(source,/readonly projectId: string/u);
  assert.match(source,/readonly environmentId: string/u);
  assert.match(source,/readonly pluginInstanceId: string \| null/u);
  assert.match(source,/JSON\.stringify\(\[projectId, environmentId, pluginInstanceId\]\)/u);
  assert.match(source,/getAiOpsV2\(\)\.listAudit/u);
  assert.match(source,/getAiOpsV2\(\)\.clearAudit/u);
  assert.match(source,/new AuditRequestCoordinator<AuditPage>/u);
  assert.match(source,/coordinator\.start\(requestedKey/u);
  assert.match(source,/coordinator\.isCurrent\(lease\.ticket\)/u);
  assert.match(source,/coordinator\.invalidateScope\(requestedKey\)/u);
  assert.match(source,/if \(pending\) await pending\.catch/u);
  assert.match(source,/await loadAudit\(\)/u);
  assert.match(source,/useDeferredValue/u);
  assert.match(source,/resultFilter/u);
  assert.match(source,/<Select/u);
  assert.match(source,/@container\/audit/u);
  assert.match(source,/<ItemGroup[\s\S]*?@lg\/audit:hidden/u);
  assert.match(source,/data-audit-layout="compact"/u);
  assert.match(source,/data-audit-layout="table"/u);
  assert.match(source,/hidden @lg\/audit:block/u);
  assert.match(source,/<Table/u);
  assert.match(source,/<AlertDialog/u);
  assert.match(source,/if \(clearInFlightRef\.current\) return/u);
  assert.match(source,/clearInFlightRef\.current = true/u);
  assert.match(source,/focusWorkspaceElement\(clearDialogRef\.current\)[\s\S]*clearInFlightRef\.current = true/u);
  const confirmation = source.slice(source.indexOf('<AlertDialog open={clearDialog}'));
  assert.match(confirmation,/data-testid="audit-clear-confirmation"/u);
  assert.match(confirmation,/onEscapeKeyDown=[\s\S]*if \(clearing\) event\.preventDefault\(\)/u);
  assert.match(confirmation,/<AlertTitle>记录尚未清除<\/AlertTitle>/u);
  assert.match(confirmation,/focusWorkspaceElement\(trigger\)/u);
  assert.match(confirmation,/audit-refresh-trigger/u);
  assert.match(source,/redactOperationalText/u);
  assert.match(source,/publicErrorLabel/u);
  assert.doesNotMatch(source,/names\[entry\.type\] \?\? redactOperationalText\(entry\.type\)/u);
  assert.doesNotMatch(all,/dangerouslySetInnerHTML|console\.(?:log|debug|info|warn|error)/u);
});
