import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = await import(pathToFileURL(path.join(
  root,
  'renderer',
  'v2',
  'src',
  'features',
  'confirmations',
  'confirmation-execution-model.ts',
)).href);
const countModel = await import(pathToFileURL(path.join(
  root,
  'renderer',
  'v2',
  'src',
  'features',
  'confirmations',
  'confirmation-count-model.ts',
)).href);
const presentationModel = await import(pathToFileURL(path.join(root,
  'renderer/v2/src/features/confirmations/confirmation-presentation-model.ts',
)).href);

test('完整命令保留长尾并在脱敏后仍完整展示', () => {
  for (const length of [4001, 5000, presentationModel.SHELL_CONFIRMATION_COMMAND_LIMIT]) {
    const tail = '尾部检查END';
    const command = 'x'.repeat(length - tail.length) + tail;
    assert.equal(command.length,length);
    const view = presentationModel.shellConfirmationPresentation({kind:'shell',command});
    assert.equal(view.complete,true);
    assert.equal(view.command,command);
    assert.equal(view.redacted,false);
  }
  const command = ('password=x ').repeat(1200) + '尾部检查END';
  const view = presentationModel.shellConfirmationPresentation({kind:'shell',command});
  assert.equal(view.complete,true);
  assert.equal(view.redacted,true);
  assert.equal(view.command.includes('password=x'),false);
  assert.equal(view.command.endsWith('尾部检查END'),true,'脱敏长度增长不能截断尾部');
  assert.equal(presentationModel.redactConfirmationText('x'.repeat(5000)).length,4000,
    '普通摘要仍有独立边界');
});

test('完整展示沿用 URL、认证头、赋值和私钥的敏感片段隐藏规则', () => {
  const command = 'echo https://demo:synthetic-ui-value@example.invalid/fixture Bearer synthetic0123456789 password=synthetic-ui-value api_key=synthetic-api-value';
  const view = presentationModel.shellConfirmationPresentation({kind:'shell',command});
  assert.equal(view.complete,true);
  assert.equal(view.redacted,true);
  for (const marker of ['synthetic-ui-value','synthetic0123456789','synthetic-api-value']) {
    assert.equal(view.command.includes(marker),false);
  }
  const privateKeyView = presentationModel.shellConfirmationPresentation({kind:'shell',command:'echo -----BEGIN PRIVATE KEY----- synthetic-key-content'});
  assert.equal(privateKeyView.complete,false,'未闭合私钥不能声称已完整核对');
  assert.equal(privateKeyView.command.includes('synthetic-key-content'),false);
  assert.equal(privateKeyView.command.endsWith('[私钥内容已隐藏]'),true);
});

test('同标签闭合 PEM 只隐藏密钥块，多个块与其后命令仍能完整核对', () => {
  const first = '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC-KEY-CONTENT-A\n-----END RSA PRIVATE KEY-----';
  const second = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nSYNTHETIC-KEY-CONTENT-B\n-----END ENCRYPTED PRIVATE KEY-----';
  const command = "echo prefix; printf '%s' '" + first + "'; echo BETWEEN; printf '%s' '" + second + "'; echo VISIBLE_TAIL";
  const view = presentationModel.shellConfirmationPresentation({kind:'shell',command});
  assert.equal(view.complete,true); assert.equal(view.redacted,true);
  assert.equal(view.command,"echo prefix; printf '%s' '[私钥内容已隐藏]'; echo BETWEEN; printf '%s' '[私钥内容已隐藏]'; echo VISIBLE_TAIL");
  assert.equal(view.command.includes('SYNTHETIC-KEY-CONTENT'),false);
  const assigned = 'password=' + first + '; echo VISIBLE_TAIL';
  const assignedView = presentationModel.shellConfirmationPresentation({kind:'shell',command:assigned});
  assert.equal(assignedView.complete,true);
  assert.equal(assignedView.command,'password=[已隐藏]; echo VISIBLE_TAIL','赋值与 PEM 同时出现不能先破坏标记边界');
  assert.equal(presentationModel.redactConfirmationText(command,'',Number.POSITIVE_INFINITY),view.command);
});

test('未闭合、标签不匹配与嵌套 PEM 保守隐藏尾部并阻止强确认', () => {
  const malformed = [
    '-----BEGIN PRIVATE KEY----- synthetic-key-content; echo HIDDEN_TAIL',
    '-----BEGIN RSA PRIVATE KEY----- synthetic-key-content -----END PRIVATE KEY-----; echo HIDDEN_TAIL',
    '-----BEGIN PRIVATE KEY----- -----BEGIN PRIVATE KEY----- synthetic-key-content -----END PRIVATE KEY-----; echo HIDDEN_TAIL',
    'synthetic-key-content -----END PRIVATE KEY-----; echo HIDDEN_TAIL',
    '-----BEGIN PRIVATE KEY----- synthetic-key-content -----END PRIVATE KEY----; echo HIDDEN_TAIL',
  ];
  for (const command of malformed) {
    const view = presentationModel.shellConfirmationPresentation({kind:'shell',command});
    assert.equal(view.complete,false); assert.equal(view.redacted,true);
    assert.equal(view.command.includes('synthetic-key-content'),false);
    assert.equal(view.command.includes('HIDDEN_TAIL'),false);
    assert.equal(presentationModel.redactConfirmationText(command).includes('synthetic-key-content'),false);
  }
  const mixed = '-----BEGIN PRIVATE KEY----- synthetic-closed -----END PRIVATE KEY-----; echo BETWEEN; -----BEGIN EC PRIVATE KEY----- synthetic-open; echo HIDDEN_TAIL';
  const view = presentationModel.shellConfirmationPresentation({kind:'shell',command:mixed});
  assert.equal(view.complete,false);
  assert.equal(view.command,'[私钥内容已隐藏]; echo BETWEEN; [私钥内容已隐藏]');
});

test('工作目录省略仍是合法后端默认语义，展示校验不改写请求', () => {
  for (const directory of [undefined,null,'']) {
    const value = {kind:'shell',command:'echo done',...(directory === undefined ? {} : {workingDirectory:directory})};
    const before = structuredClone(value);
    assert.equal(presentationModel.shellConfirmationPresentation(value).complete,true);
    assert.deepEqual(value,before);
  }
});

test('命令或目录不可完整核对时拒绝强确认展示', () => {
  for (const value of [undefined,{}, {kind:'shell'}, {kind:'shell',command:''},
    {kind:'shell',command:'x'.repeat(16_385)}, {kind:'shell',command:'echo\0done'},
    {kind:'shell',command:'echo done',workingDirectory:42},
    {kind:'shell',command:'echo done',workingDirectory:'x'.repeat(4097)},
    {kind:'file-write',command:'echo done'}]) {
    assert.deepEqual(presentationModel.shellConfirmationPresentation(value),
      {command:'',complete:false,redacted:false});
  }
  assert.equal(presentationModel.shellConfirmationPresentation({kind:'shell',command:'echo done',workingDirectory:'/' + 'x'.repeat(4095)}).complete,true);
});

test('确认计数区分未选择、加载、读取失败和已知空队列', () => {
  const scope = {projectId:'example',environmentId:'production'};
  assert.deepEqual(countModel.confirmationCountSnapshot(null,scope),{count:null,loading:false,unavailable:true});
  assert.deepEqual(countModel.confirmationCountSnapshot([],scope),{count:0,loading:false,unavailable:false});
  assert.deepEqual(countModel.confirmationCountSnapshot(null,{projectId:'example',environmentId:null}),{count:null,loading:false,unavailable:false});
  assert.deepEqual(countModel.confirmationCountForScope({scopeKey:countModel.confirmationCountScopeKey(scope),count:3,loading:false,unavailable:false},
    {...scope,environmentId:'test'}),{count:null,loading:true,unavailable:false},'范围切换当帧不能显示旧环境计数');
});

test('订阅先到后旧读取不得覆写最新状态，范围切换与卸载隔离迟到响应', () => {
  const coordinator = new countModel.ConfirmationCountReadCoordinator();
  const scope = {projectId:'example',environmentId:'production'};
  const first = coordinator.activateScope(scope);
  let snapshot = countModel.confirmationCountLoading(scope);
  assert.equal(coordinator.acceptSubscription(first),true);
  snapshot = countModel.confirmationCountSnapshot([{requestId:'active',...scope,expiresAt:200}],scope,100);
  for (const lateResult of [null,[]]) {
    if (coordinator.isReadCurrent(first)) snapshot = countModel.confirmationCountSnapshot(lateResult,scope,100);
    assert.deepEqual(snapshot,{count:1,loading:false,unavailable:false});
  }
  const second = coordinator.activateScope({...scope,environmentId:'test'});
  assert.equal(coordinator.isReadCurrent(first),false);
  assert.equal(coordinator.acceptSubscription(first),false);
  assert.equal(coordinator.isReadCurrent(second),true);
  coordinator.deactivateScope(first);
  assert.equal(coordinator.isReadCurrent(second),true,'旧范围清理不得取消新范围');
  coordinator.deactivateScope(second);
  assert.equal(coordinator.isReadCurrent(second),false);
  assert.equal(coordinator.acceptSubscription(second),false);
});

function confirmationItem(index) {
  return {
    requestId: `execution-${index}`,
    projectId: 'project-example',
    environmentId: 'environment-example',
    pluginInstanceId: 'plugin-example',
  };
}

function executionEvent(index, status = 'success') {
  return {
    confirmationId: `execution-${index}`,
    status,
    projectId: 'project-example',
    environmentId: 'environment-example',
    pluginInstanceId: 'plugin-example',
  };
}

test('confirmation execution cache stays bounded while retaining active feedback', () => {
  let cache = new Map();
  for (let index = 0; index < 150; index += 1) {
    cache = new Map(model.rememberConfirmationExecution(
      cache,
      executionEvent(index),
      'execution-0',
    ));
  }

  assert.equal(cache.size, model.CONFIRMATION_EXECUTION_CACHE_LIMIT + 1);
  assert.equal(cache.has('execution-0'), true, 'active feedback remains available');
  assert.equal(cache.has('execution-149'), true, 'newest execution remains available');
  assert.equal(cache.has('execution-1'), false, 'old inactive execution is evicted');

  const boundedItems = model.boundedConfirmationItems(
    Array.from({ length: 150 }, (_, index) => confirmationItem(index)),
    confirmationItem(0),
  );
  assert.equal(boundedItems.size, model.CONFIRMATION_EXECUTION_CACHE_LIMIT + 1);
  assert.equal(boundedItems.has('execution-0'), true);
  assert.equal(boundedItems.has('execution-149'), true);
  assert.equal(boundedItems.has('execution-1'), false);
});

test('confirmation execution feedback is normalized and bound to its exact known scope', () => {
  const item = confirmationItem(7);
  const event = model.normalizeConfirmationExecution({
    type: 'confirmation-execution',
    ...executionEvent(7),
    durationMs: 25,
    errorCode: 'OPERATION_FAILED',
  });

  assert.deepEqual(event, {
    ...executionEvent(7),
    durationMs: 25,
    errorCode: 'OPERATION_FAILED',
  });
  assert.equal(model.confirmationExecutionMatchesItem(event, item), true);
  assert.equal(model.confirmationExecutionMatchesItem(
    { ...event, environmentId: 'different-environment' },
    item,
  ), false);
  assert.equal(model.confirmationMatchesEnvironment(
    item,'project-example','environment-example',
  ),true);
  assert.equal(model.confirmationMatchesEnvironment(
    item,'project-example','different-environment',
  ),false);
  assert.equal(model.confirmationMatchesScope(item,{
    mode:'environment',projectId:'project-example',environmentId:'environment-example',
    pluginInstanceId:null,
  }),true);
  assert.equal(model.confirmationMatchesScope(item,{
    mode:'plugin',projectId:'project-example',environmentId:'environment-example',
    pluginInstanceId:'plugin-example',
  }),true);
  assert.equal(model.confirmationMatchesScope(item,{
    mode:'plugin',projectId:'project-example',environmentId:'environment-example',
    pluginInstanceId:'different-plugin',
  }),false);
  assert.equal(model.confirmationMatchesScope(item,{
    mode:'plugin',projectId:'project-example',environmentId:'environment-example',
    pluginInstanceId:null,
  }),false,'plugin mode fails closed without a plugin id');
  assert.deepEqual(model.confirmationFilterModes('plugin','plugin-example'),['plugin']);
  assert.deepEqual(model.confirmationFilterModes('plugin',null),['plugin'],
    'plugin mode never offers an environment fallback');
  assert.deepEqual(
    model.confirmationFilterModes('environment','plugin-example'),
    ['environment','plugin'],
  );
  assert.deepEqual(model.confirmationFilterModes('environment',null),['environment']);
  assert.deepEqual(model.applyConfirmationExecution(
    { item, status: 'waiting' },
    item,
    event,
  ), {
    item,
    status: 'success',
    durationMs: 25,
    errorCode: 'OPERATION_FAILED',
  });
});

test('confirmation execution normalization omits unsafe arbitrary error text', () => {
  const event = model.normalizeConfirmationExecution({
    type: 'confirmation-execution',
    ...executionEvent(2, 'error'),
    errorCode: 'not a stable public code',
  });

  assert.deepEqual(event, executionEvent(2, 'error'));
  assert.equal(model.normalizeConfirmationExecution({
    type: 'confirmation-execution',
    ...executionEvent(2, 'unknown'),
  }), null);
});

test('confirmation badge counts only unexpired requests in the selected environment', () => {
  const scope = {projectId:'project-example',environmentId:'environment-example'};
  const now = 10_000;
  assert.equal(countModel.countActiveConfirmations([
    {requestId:'active',...scope,expiresAt:now + 1},
    {requestId:'expired',...scope,expiresAt:now},
    {requestId:'invalid-expiry',...scope,expiresAt:'later'},
    {requestId:'other-environment',projectId:scope.projectId,environmentId:'other',expiresAt:now + 1},
    {requestId:'active',...scope,expiresAt:now + 2},
  ],scope,now),1);
});

test('React confirmation center preserves subscription, scope, expiry and approval gates', async () => {
  const [source,countHook,toggleGroup] = await Promise.all([
    fs.readFile(path.join(
      root, 'renderer', 'v2', 'src', 'features', 'confirmations', 'ConfirmationsFeature.tsx',
    ), 'utf8'),
    fs.readFile(path.join(
      root, 'renderer', 'v2', 'src', 'features', 'confirmations', 'use-confirmation-count.ts',
    ), 'utf8'),
    fs.readFile(path.join(
      root, 'renderer', 'v2', 'src', 'components', 'ui', 'toggle-group.tsx',
    ), 'utf8'),
  ]);

  assert.match(source, /readonly projectId: string/u);
  assert.match(source, /readonly environmentId: string/u);
  assert.match(source, /readonly pluginInstanceId: string \| null/u);
  assert.match(source, /readonly scopeMode\?: ConfirmationScopeMode/u);
  assert.match(source, /listConfirmations/u);
  assert.match(source, /onConfirmations/u);
  assert.match(source, /onWorkspaceChanged/u);
  assert.match(source, /unsubscribeConfirmations\(\)/u);
  assert.match(source, /unsubscribeWorkspace\(\)/u);
  assert.match(source, /window\.clearInterval\(timer\)/u);
  assert.match(source, /normalizeConfirmationExecution\(change\)/u);
  assert.match(source, /confirmationExecutionMatchesItem\(event, item\)/u,
    'execution feedback is bound to a known request and scope');
  assert.match(source, /rememberConfirmationExecution/u);
  assert.match(source, /boundedConfirmationItems/u);
  assert.match(source, /normalizeConfirmations\(value\)\.filter\(matchesCurrentScope\)/u);
  assert.match(source, /normalizeConfirmations\(pending\)\.filter\(matchesCurrentScope\)/u);
  assert.match(source, /\.filter\(matchesCurrentScope\)/u);
  assert.match(source, /items\.filter\(matchesCurrentScope\)\.length/u);
  assert.match(source, /confirmationFilterModes\(scopeMode, pluginInstanceId\)/u);
  assert.match(source, /if \(scopeMode === "plugin" && filter !== "plugin"\)/u);
  assert.doesNotMatch(source, /\["all", "全部"|\["project", projectName/u);
  assert.match(source, /if \(!matchesCurrentScope\(item\)\) return/u);
  assert.match(countHook, /confirmationCountSnapshot/u);
  assert.match(countHook, /if \(!scope\.projectId \|\| !scope\.environmentId\)/u);
  assert.match(countHook, /commit\(confirmationCountLoading\(scope\)\)/u);
  assert.match(countHook, /confirmationCountForScope\(state, scope\)/u);
  assert.match(countHook, /coordinator\.isReadCurrent\(ticket\)/u);
  assert.match(countHook, /coordinator\.acceptSubscription\(ticket\)/u);
  assert.match(countHook, /current\.loading \|\| current\.unavailable/u);
  assert.match(countHook, /retryEpoch/u);
  assert.match(countHook, /window\.setInterval/u);
  assert.match(countHook, /window\.clearInterval\(timer\)/u);
  assert.match(source, /feedbackRef/u);
  assert.match(source, /item\.expiresAt > now/u);
  assert.match(source, /CONFIRMATION_EXPIRED/u);
  assert.match(source, /approvalLevel === "strong"/u);
  assert.match(source, /<Checkbox/u);
  assert.match(source, /strong && \(!acknowledgedStrong \|\| !shell\.complete\)/u);
  assert.match(source, /decision === "approve" && item\.approvalLevel === "strong" && !shellConfirmationPresentation\(item\.presentation\)\.complete/u);
  assert.match(source, /data-testid="confirmation-full-command"[^>]*tabIndex=\{0\}/u);
  assert.match(source, /approveConfirmation\(item\.requestId\)/u);
  assert.match(source, /rejectConfirmation\(item\.requestId\)/u);
  assert.match(source, /@\/components\/ui\/toggle-group/u);
  assert.match(source, /<ToggleGroup[\s\S]*?type="single"[\s\S]*?value=\{filter\}/u);
  assert.match(source, /if \(value\) setFilter\(value as ConfirmationFilter\)/u);
  assert.match(source, /data-testid="confirmation-scope-filter"/u);
  assert.match(source, /filterOptions\.length > 1/u);
  assert.match(source, /@\/components\/ui\/alert/u);
  assert.match(source, /@\/components\/ui\/empty/u);
  assert.match(source, /@\/components\/ui\/card/u);
  assert.match(source, /@\/components\/ui\/item/u);
  assert.match(source, /@\/components\/ui\/table/u);
  assert.match(source, /<ItemGroup[\s\S]*?@md\/confirmations:hidden/u);
  assert.match(source, /hidden @md\/confirmations:block/u);
  assert.match(source, /<Table aria-label=\{capabilityLabel\(item\) \+ "操作参数"\}/u);
  assert.match(source, /@\/components\/ui\/button-group/u);
  assert.match(source, /<ButtonGroup[\s\S]*?aria-label=\{capabilityLabel\(item\) \+ "确认操作"\}/u);
  assert.match(source, /operationCapabilityLabel\(item\.capability\)/u);
  assert.match(source, /publicErrorLabel\(feedback\.errorCode/u);
  assert.match(source, /remoteTypeLabel\(value\.remoteType\)/u);
  assert.match(source, /serviceActionLabel\(value\.action\)/u);
  assert.doesNotMatch(source, /names\[item\.capability\] \?\? safeText\(item\.capability\)/u);
  assert.doesNotMatch(source, /safeText\(feedback\.errorCode/u);
  assert.doesNotMatch(source, /aria-pressed=|divide-y|gap-px/u);
  assert.match(toggleGroup, /ToggleGroup as ToggleGroupPrimitive/u);
  assert.match(toggleGroup, /data-slot="toggle-group"/u);
  assert.match(toggleGroup, /data-slot="toggle-group-item"/u);
  assert.match(source, /safeText/u);
  assert.match(source, /redactConfirmationText as safeText/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|console\.(?:log|debug|info|warn|error)/u);
});
