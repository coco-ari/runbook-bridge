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
  assert.match(countHook, /countActiveConfirmations/u);
  assert.match(countHook, /if \(!scope\.projectId \|\| !scope\.environmentId\)/u);
  assert.match(countHook, /setState\(\{ count: 0, loading: true \}\)/u);
  assert.match(countHook, /window\.setInterval/u);
  assert.match(countHook, /window\.clearInterval\(timer\)/u);
  assert.match(source, /feedbackRef/u);
  assert.match(source, /item\.expiresAt > now/u);
  assert.match(source, /CONFIRMATION_EXPIRED/u);
  assert.match(source, /approvalLevel === "strong"/u);
  assert.match(source, /<Checkbox/u);
  assert.match(source, /strong && !acknowledgedStrong/u);
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
  assert.match(source, /\[已隐藏\]/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|console\.(?:log|debug|info|warn|error)/u);
});
