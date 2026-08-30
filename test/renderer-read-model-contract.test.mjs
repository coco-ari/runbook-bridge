import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname,'..');
const read = (relativePath) => fs.readFileSync(path.join(root,relativePath),'utf8');

async function importTypeScriptModule(relativePath) {
  return import(pathToFileURL(path.join(root,relativePath)).href);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise,resolve};
}

test('post-save selection waits for refreshed scope data rather than rejecting a stale snapshot', () => {
  const plugins = read('renderer/v2/src/features/workspace/use-environment-plugins.ts');
  const overview = read('renderer/v2/src/features/workspace/use-workspace-overview.ts');
  const shell = read('renderer/v2/src/components/app-shell/AppShell.tsx');
  const pluginReload = plugins.slice(plugins.indexOf('const reload = useCallback'),plugins.indexOf('useEffect',plugins.indexOf('const reload = useCallback')));
  assert.match(pluginReload,/setSnapshot\([\s\S]*loading: true/u);
  assert.ok(pluginReload.indexOf('setSnapshot') < pluginReload.indexOf('setReloadGeneration'));
  const overviewReload = overview.slice(overview.indexOf('const reload = useCallback'),overview.indexOf('useEffect',overview.indexOf('const reload = useCallback')));
  assert.match(overviewReload,/setSnapshot\(beginStaleRefresh\)/u);
  const selectionEffect = shell.slice(shell.indexOf('if (!pendingSelection'),shell.indexOf('const dirtyLeave'));
  assert.match(selectionEffect,/workspace\.loading \|\| workspace\.error\) return/u);
  assert.match(selectionEffect,/pluginList\.loading \|\| pluginList\.error \|\| pluginList\.scopeKey !== expectedScopeKey/u);
  assert.match(shell,/setQuickQuestionsDirty\(false\)[\s\S]*setPendingSelection\(null\)[\s\S]*navigation\?\.\(\)/u);
});

function workspaceFixture() {
  const runtime = (projectId,environmentId,phase = 'disconnected',sequence = 1) => ({
    projectId,environmentId,phase,sequence,plugins:{},
    connectedCount:phase === 'connected' ? 1 : 0,
    eligibleCount:1,draftCount:0,errorCount:0,blockedCount:0,
  });
  const plugin = (pluginInstanceId,displayName = pluginInstanceId) => ({
    pluginInstanceId,displayName,pluginType:'server',configState:'ready',revision:1,
    assessment:{primaryStatus:{kind:'connected',label:'safe'}},
  });
  const environment = (projectId,environmentId,pluginInstanceId) => ({
    projectId,environmentId,name:environmentId,revision:1,pluginCount:1,readyPluginCount:1,
    resourcePreview:[plugin(pluginInstanceId)],runtime:runtime(projectId,environmentId,'connected'),
  });
  return {
    projects:[
      {
        projectId:'project-isolated',name:'隔离项目',revision:0,configurationError:{
          code:'PROJECT_CONFIG_INVALID',message:'do not expose path C:/secret',source:'C:/secret',
        },environments:[],
      },
      {
        projectId:'project-one',name:'项目一',revision:1,
        environments:[environment('project-one','environment-one','plugin-one')],
      },
      {
        projectId:'project-two',name:'项目二',revision:1,
        environments:[environment('project-two','environment-two','plugin-two')],
      },
    ],
  };
}

test('workspace read model uses a strict display allowlist and exact scopes', async () => {
  const modelModule = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/workspace-read-model.ts',
  );
  const raw = workspaceFixture().projects;
  raw[1].password = 'never-render-this';
  raw[1].environments[0].runbook = 'private operational text';
  raw[1].environments[0].resourcePreview[0].target = {host:'10.0.0.8'};
  raw[1].environments.push({
    ...raw[1].environments[0],
    projectId:'project-two',
    environmentId:'environment-mismatch',
  });

  const model = modelModule.normalizeWorkspaceOverview(raw);
  assert.equal(model.projects.length,3);
  assert.equal(model.projects[0].isolated,true);
  assert.equal(model.projects[0].environments.length,0);
  assert.equal(model.projects[1].environments.length,1);
  assert.equal(model.projects[1].environments[0].resourcePreview.length,1);
  const serialized = JSON.stringify(model);
  assert.doesNotMatch(serialized,/never-render-this|private operational text|10\.0\.0\.8|C:\/secret/u);
  assert.doesNotMatch(serialized,/password|runbook|target|configurationError/u);

  assert.equal(modelModule.normalizeEnvironmentRuntime({
    projectId:'project-two',environmentId:'environment-one',phase:'connected',sequence:2,
  },{projectId:'project-one',environmentId:'environment-one'}),null);
});

test('read errors never expose operational messages or details', async () => {
  const modelModule = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/workspace-read-model.ts',
  );
  const error = modelModule.createWorkspaceReadError('workspace',{
    code:'WORKSPACE_READ_FAILED',
    message:'secret filesystem payload',
    details:{path:'C:/customer'},
  });
  assert.deepEqual(error,{
    code:'WORKSPACE_READ_FAILED',
    message:'无法读取工作区。请重试。',
  });
});

test('runtime resolution preserves a known full plugin map and replaces partial previews', async () => {
  const model = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/workspace-read-model.ts',
  );
  const scope = {projectId:'project-one',environmentId:'environment-one'};
  const full = {
    ...scope,phase:'connected',sequence:7,pluginsPartial:false,
    connectedCount:2,eligibleCount:2,draftCount:0,errorCount:0,blockedCount:0,
    plugins:{
      'plugin-one':{phase:'connected'},
      'plugin-two':{phase:'connected'},
    },
  };
  const initial = model.resolveEnvironmentRuntimeEvent(full,scope,null);
  assert.equal(initial.reason,'accepted');
  assert.equal(initial.value.data.plugins.length,2);

  const partial = {
    ...scope,phase:'partial',sequence:8,pluginsPartial:true,
    connectedCount:1,eligibleCount:2,draftCount:0,errorCount:1,blockedCount:0,
    plugins:{'plugin-one':{phase:'error'}},
  };
  const merged = model.resolveEnvironmentRuntimeEvent(partial,scope,initial.value);
  assert.equal(merged.reason,'accepted');
  assert.equal(merged.value.data.pluginsPartial,false);
  assert.deepEqual(
    merged.value.data.plugins.map((plugin) => [plugin.pluginInstanceId,plugin.status]),
    [['plugin-one','error'],['plugin-two','connected']],
  );
  assert.deepEqual(Object.keys(merged.value.raw.plugins),['plugin-one','plugin-two']);
  assert.equal(merged.value.raw.plugins['plugin-two'].phase,'connected');

  const partialOnly = model.resolveEnvironmentRuntimeEvent(partial,scope,null);
  const nextPartial = model.resolveEnvironmentRuntimeEvent({
    ...scope,phase:'disconnected',sequence:9,pluginsPartial:true,
    plugins:{'plugin-three':{phase:'disconnected'}},
  },scope,partialOnly.value);
  assert.equal(nextPartial.value.data.pluginsPartial,true);
  assert.deepEqual(
    nextPartial.value.data.plugins.map((plugin) => plugin.pluginInstanceId),
    ['plugin-three'],
  );
  assert.deepEqual(Object.keys(nextPartial.value.raw.plugins),['plugin-three']);
});

test('poll resolution rejects malformed and older snapshots after a newer event', async () => {
  const model = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/workspace-read-model.ts',
  );
  const coordinator = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/workspace-refresh-coordinator.ts',
  );
  const scope = {projectId:'project-one',environmentId:'environment-one'};
  const event = model.resolveEnvironmentRuntimeEvent({
    ...scope,phase:'connected',sequence:12,pluginsPartial:false,
    plugins:{'plugin-one':{phase:'connected'}},
  },scope,null);

  const malformed = model.resolveEnvironmentRuntimePoll(
    {...scope,phase:'connected'},
    scope,
    event.value,
    11,
  );
  assert.equal(malformed.reason,'superseded');
  assert.strictEqual(malformed.value,event.value);

  const older = model.resolveEnvironmentRuntimePoll({
    ...scope,phase:'error',sequence:10,pluginsPartial:false,
    plugins:{'plugin-one':{phase:'error'}},
  },scope,event.value,12);
  assert.equal(older.reason,'stale');
  assert.strictEqual(older.value,event.value);

  const settled = coordinator.settleRefresh({
    data:event.value.data,error:null,loading:true,raw:event.value.raw,
  });
  assert.equal(settled.loading,false);
  assert.strictEqual(settled.data,event.value.data);
  assert.strictEqual(settled.raw,event.value.raw);
});

test('navigation runtime cache is bounded, exact-scoped, normalized, and prunes removed scopes', async () => {
  const model = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/workspace-read-model.ts',
  );
  const workspace = model.normalizeWorkspaceOverview(workspaceFixture().projects);
  let cache = model.reconcileWorkspaceRuntimeCache(workspace,new Map());
  assert.equal(cache.size,2,'one bounded cache entry is seeded per workspace environment');

  const accepted = model.acceptWorkspaceRuntimeEvent(workspace,cache,{
    projectId:'project-two',environmentId:'environment-two',phase:'error',sequence:4,
    pluginsPartial:false,connectedCount:0,eligibleCount:2,draftCount:0,errorCount:1,
    blockedCount:0,password:'must-not-survive',target:{host:'10.0.0.8'},
    plugins:{
      'plugin-two':{phase:'error',credential:'must-not-survive'},
      'plugin-outside-preview':{phase:'connected',secret:'must-not-survive'},
    },
  });
  assert.equal(accepted.accepted,true);
  cache = accepted.cache;
  const projectTwoRuntime = cache.get(
    model.workspaceRuntimeScopeKey('project-two','environment-two'),
  );
  assert.deepEqual(
    projectTwoRuntime.plugins.map((plugin) => [plugin.pluginInstanceId,plugin.status]),
    [['plugin-two','error']],
  );
  assert.doesNotMatch(
    JSON.stringify([...cache.values()]),
    /must-not-survive|10\.0\.0\.8|password|credential|target|plugin-outside-preview/u,
  );

  const projects = model.overlayWorkspaceRuntimeStatuses(workspace.projects,cache);
  const projectOne = projects.find((project) => project.projectId === 'project-one');
  const projectTwo = projects.find((project) => project.projectId === 'project-two');
  assert.equal(projectOne.status,'connected','unaffected project status stays intact');
  assert.equal(projectTwo.status,'error');
  assert.equal(projectTwo.environments[0].status,'error');
  assert.equal(projectTwo.environments[0].resourcePreview[0].status,'error');

  const beforeRejected = JSON.stringify([...cache]);
  const crossScope = model.acceptWorkspaceRuntimeEvent(workspace,cache,{
    projectId:'project-one',environmentId:'environment-two',phase:'connected',sequence:20,
    pluginsPartial:false,plugins:{},
  });
  assert.equal(crossScope.accepted,false,'an environment from another project is rejected');
  assert.equal(JSON.stringify([...crossScope.cache]),beforeRejected);

  const older = model.acceptWorkspaceRuntimeEvent(workspace,cache,{
    projectId:'project-two',environmentId:'environment-two',phase:'connected',sequence:3,
    pluginsPartial:false,plugins:{'plugin-two':{phase:'connected'}},
  });
  assert.equal(older.accepted,false);
  assert.equal(
    older.cache.get(model.workspaceRuntimeScopeKey('project-two','environment-two')).status,
    'error',
  );

  const withoutProjectTwoEnvironment = {
    projects:workspace.projects.map((project) => project.projectId === 'project-two'
      ? {...project,environments:[],environmentCount:0,pluginCount:0}
      : project),
  };
  const pruned = model.reconcileWorkspaceRuntimeCache(
    withoutProjectTwoEnvironment,
    cache,
  );
  assert.equal(pruned.size,1);
  assert.equal(
    pruned.has(model.workspaceRuntimeScopeKey('project-two','environment-two')),
    false,
  );
});

test('workspace refresh coordinator coalesces bursts and retains failed intent for retry', async () => {
  const module = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/workspace-refresh-coordinator.ts',
  );
  const gates = [];
  const refresh = module.createWorkspaceRefreshCoordinator(async () => {
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });

  const first = refresh.request();
  const second = refresh.request();
  assert.strictEqual(first,second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gates.length,1,'a synchronous event burst uses one overview request');

  const during = refresh.request();
  assert.strictEqual(during,first);
  gates[0].resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gates.length,2,'an event arriving during the request schedules one follow-up');
  gates[1].resolve(true);
  assert.equal(await first,true);
  assert.equal(refresh.hasPending(),false);
  assert.equal(refresh.inFlight(),false);

  const outcomes = [false,true];
  let attempts = 0;
  const retrying = module.createWorkspaceRefreshCoordinator(async () => {
    attempts += 1;
    return outcomes.shift();
  });
  assert.equal(await retrying.request(),false);
  assert.equal(retrying.hasPending(),true,'failure retains the unhandled change intent');
  assert.equal(await retrying.request(),true);
  assert.equal(attempts,2);
  assert.equal(retrying.hasPending(),false);

  const staleData = {projects:[{projectId:'project-one'}]};
  const started = module.beginStaleRefresh({data:staleData,error:{code:'OLD'},loading:false});
  assert.strictEqual(started.data,staleData);
  assert.equal(started.error,null);
  assert.equal(started.loading,true);
  const failed = module.failStaleRefresh(started,{code:'WORKSPACE_READ_FAILED'});
  assert.strictEqual(failed.data,staleData);
  assert.deepEqual(failed.error,{code:'WORKSPACE_READ_FAILED'});
  assert.equal(failed.loading,false);
});

test('selection initializes once and never falls across project or environment scope', async () => {
  const modelModule = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/workspace-read-model.ts',
  );
  const selectionModule = await importTypeScriptModule(
    'renderer/v2/src/features/workspace/selection-reducer.ts',
  );
  const workspace = modelModule.normalizeWorkspaceOverview(workspaceFixture().projects);
  let state = selectionModule.workspaceSelectionReducer(
    selectionModule.INITIAL_WORKSPACE_SELECTION,
    {type:'workspace-loaded',workspace},
  );
  assert.deepEqual(state,{
    projectId:'project-one',environmentId:null,pluginInstanceId:null,initialized:true,
  });

  state = selectionModule.workspaceSelectionReducer(state,{
    type:'select-plugin',workspace,projectId:'project-one',
    environmentId:'environment-one',pluginInstanceId:'plugin-one',
  });
  assert.equal(state.pluginInstanceId,'plugin-one');

  state = selectionModule.workspaceSelectionReducer(state,{
    type:'select-environment',workspace,projectId:'project-one',environmentId:'environment-two',
  });
  assert.deepEqual(state,{
    projectId:'project-one',environmentId:null,pluginInstanceId:null,initialized:true,
  });

  const withoutProjectOne = {
    projects:workspace.projects.filter((project) => project.projectId !== 'project-one'),
  };
  state = selectionModule.workspaceSelectionReducer(state,{
    type:'workspace-loaded',workspace:withoutProjectOne,
  });
  assert.deepEqual(state,{
    projectId:null,environmentId:null,pluginInstanceId:null,initialized:true,
  });
  state = selectionModule.workspaceSelectionReducer(state,{
    type:'workspace-loaded',workspace:withoutProjectOne,
  });
  assert.equal(state.projectId,null,'a later refresh must not silently select project-two');
});

test('read hooks call only the four allowed APIs and guard cleanup and late results', () => {
  const workspaceHook = read('renderer/v2/src/features/workspace/use-workspace-overview.ts');
  const environmentHook = read('renderer/v2/src/features/workspace/use-environment-status.ts');
  const pluginHook = read('renderer/v2/src/features/workspace/use-environment-plugins.ts');
  const runtimeCacheHook = read(
    'renderer/v2/src/features/workspace/use-workspace-runtime-cache.ts',
  );
  const hooks = `${workspaceHook}\n${environmentHook}\n${pluginHook}\n${runtimeCacheHook}`;
  assert.match(workspaceHook,/getAiOpsV2\(\)/u);
  assert.match(workspaceHook,/\.workspaceOverview\(\)/u);
  assert.match(workspaceHook,/\.onWorkspaceChanged\(/u);
  assert.match(environmentHook,/getAiOpsV2\(\)/u);
  assert.match(environmentHook,/\.environmentStatus\(\{ projectId, environmentId \}\)/u);
  assert.match(environmentHook,/\.onEnvironmentStatus\(/u);
  assert.match(pluginHook,/getAiOpsV2\(\)/u);
  assert.match(pluginHook,/\.listPlugins\(\{ projectId, environmentId \}\)/u);
  assert.match(pluginHook,/\.onWorkspaceChanged\(/u);
  assert.match(pluginHook,/plugin\.projectId === projectId/u);
  assert.match(pluginHook,/plugin\.environmentId === environmentId/u);
  assert.match(runtimeCacheHook,/\.onEnvironmentStatus\(/u);
  assert.doesNotMatch(runtimeCacheHook,/\.environmentStatus\(|\.workspaceOverview\(/u);
  assert.match(hooks,/generationRef/u);
  assert.match(environmentHook,/latestSequenceRef/u);
  assert.match(environmentHook,/runtime\.projectId !== projectId/u);
  assert.match(environmentHook,/runtime\.environmentId !== environmentId/u);
  assert.equal((hooks.match(/unsubscribe\(\)/gu) ?? []).length,4);
  assert.doesNotMatch(
    `${workspaceHook}\n${environmentHook}\n${runtimeCacheHook}`,
    /\.listProjects\(|\.listEnvironments\(|\.listPlugins\(|\.readRunbook\(|\.listAudit\(|\.credentialStatus\(/u,
  );
  assert.doesNotMatch(pluginHook,/\.listProjects\(|\.listEnvironments\(|\.readRunbook\(|\.listAudit\(|\.credentialStatus\(/u);
  assert.doesNotMatch(hooks,/JSON\.stringify|console\./u);
});

test('AppShell feeds live-overlaid projects to every navigation surface', () => {
  const shell = read('renderer/v2/src/components/app-shell/AppShell.tsx');
  assert.match(shell,/useWorkspaceRuntimeCache\(workspace\.data\)/u);
  assert.match(shell,/overlayWorkspaceRuntimeStatuses\(/u);
  assert.match(shell,/<ProjectRail[\s\S]*?projects=\{navigationProjects\}/u);
  assert.match(shell,/<ResourcePane[\s\S]*?project=\{navigationProject\}/u);
  assert.match(shell,/<GlobalCommand[\s\S]*?projects=\{navigationProjects\}/u);
});

test('overview components are prop-driven shadcn compositions', () => {
  const projectOverview = read('renderer/v2/src/features/projects/ProjectOverview.tsx');
  const projectActivity = read('renderer/v2/src/features/projects/ProjectRecentActivity.tsx');
  const environmentOverview = read('renderer/v2/src/features/environments/EnvironmentOverview.tsx');
  const components = [
    projectOverview,
    environmentOverview,
    read('renderer/v2/src/features/plugins/PluginOverview.tsx'),
  ].join('\n');
  assert.match(components,/@\/components\/ui\/badge/u);
  assert.match(components,/@\/components\/ui\/skeleton/u);
  assert.match(components,/@\/components\/ui\/table/u);
  assert.match(components,/<Alert\b/u);
  for (const source of [projectOverview,environmentOverview]) {
    assert.match(source,/@\/components\/ui\/alert/u);
    assert.match(source,/@\/components\/ui\/empty/u);
    assert.doesNotMatch(source,/border-y|grid-cols-[34]/u);
  }
  assert.match(projectOverview,/@\/components\/ui\/card/u);
  assert.match(projectOverview,/@\/components\/ui\/item/u);
  assert.match(projectOverview,/data-testid="project-overview-error"/u);
  assert.match(projectOverview,/data-testid="project-overview-empty"/u);
  assert.match(projectOverview,/data-testid="project-overview-isolated"/u);
  assert.match(projectOverview,/<ProjectRecentActivity/u);
  assert.match(projectActivity,/data-testid="project-recent-activity"/u);
  assert.match(projectActivity,/\.listAudit\(\{ projectId, limit: 6 \}\)/u);
  for (const primitive of ['Alert','Badge','Button','Card','Empty','Item','ItemGroup','Skeleton']) {
    assert.match(projectActivity,new RegExp(`\\b${primitive}\\b`,'u'));
  }
  assert.doesNotMatch(projectActivity,/environmentId|pluginInstanceId|clearAudit|dangerouslySetInnerHTML/u);
  assert.match(environmentOverview,/data-testid="environment-overview-error"/u);
  assert.match(environmentOverview,/data-testid="environment-overview-empty"/u);
  assert.doesNotMatch(components,/getAiOpsV2|window\.aiOps|JSON\.stringify|\.details/u);
  assert.doesNotMatch(components,/\{error\.message\}/u);
  assert.doesNotMatch(components,/[—–]/u);
});
