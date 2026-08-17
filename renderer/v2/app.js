const api = window.aiOps.v2;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name, className = 'icon') => `<svg class="${className}"><use href="#i-${name}"/></svg>`;
const STORED_PASSWORD_MASK = '*****';
const PROJECT_ORDER_KEY = 'ai-ops-project-order-v1';
const PROJECT_RAIL_WIDTH_KEY = 'ai-ops-project-rail-width-v1';
const PROJECT_RAIL_DEFAULT_WIDTH = 328;
const PROJECT_RAIL_MIN_WIDTH = 260;
const PROJECT_RAIL_MAX_WIDTH = 520;

function storedProjectRailWidth() {
  try {
    const value = Number(localStorage.getItem(PROJECT_RAIL_WIDTH_KEY));
    return Number.isFinite(value) && value > 0
      ? Math.min(PROJECT_RAIL_MAX_WIDTH,Math.max(PROJECT_RAIL_MIN_WIDTH,value))
      : PROJECT_RAIL_DEFAULT_WIDTH;
  } catch { return PROJECT_RAIL_DEFAULT_WIDTH; }
}

const state = {
  projects: [], environments: [], plugins: [], auditEntries: [], projectId: null,
  environmentId: null, pluginId: null, view: 'plugins', runtime: null,
  editingPlugin: null, editingEnvironmentId: undefined, environmentDeletePrompt: null, detailTabs: {}, navigationGeneration: 0,
  runbookContent: '', runbookRevision: null, runbookScopeKey: null, runbookEditing: false, pendingCount: 0,
  projectEnvironmentMemory: {}, scopePluginMemory: {},
  databaseDiscoverySignature: null, databaseCredentialRevision: 0, databaseQueryGeneration: 0,
  credentialProbeGeneration: 0,
  deletingPluginScope: null,
  runtimeByScope: {},
  environmentsByProject: {},
  projectOverviewActive: true,
  projectOverviewActivityProjectId: null,
  projectOverviewActivityEntries: [],
  projectOverviewActivityLoading: false,
  projectOverviewActivityRefreshing: false,
  projectOverviewActivityGeneration: 0,
  overviewEditingProjectId: null,
  overviewEditingEnvironmentId: null,
  overviewEnvironmentDeletePrompt: null,
  managingProjectId: null,
  managedProjectId: null,
  managedEnvironments: [],
  projectOrder: (() => { try { const value = JSON.parse(localStorage.getItem(PROJECT_ORDER_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } })(),
  dragSort: null,
  sortSaving: false,
  suppressRailClickUntil: 0,
  railRefreshPending: false,
  workspaceOverviewGeneration: 0,
  loadedScopeKey: null,
  pluginFormInitial: null,
  mobileDetail: false,
  projectRailExpanded: (() => { try { return localStorage.getItem('ai-ops-project-rail-expanded') === '1'; } catch { return false; } })(),
  projectRailWidth: storedProjectRailWidth(),
};

let pluginFormTransitionGeneration = 0;
let pluginFormTransitionTimer = null;

const typeNames = { server: 'Server', mysql: 'MySQL', redis: 'Redis' };
const typeIcons = { server: 'server', mysql: 'db', redis: 'redis' };
const phaseNames = { disconnected:'未连接',connecting:'连接中',connected:'已连接',partial:'部分可用',failed:'连接失败',reconnecting:'网络变化 · 重连中',blocked:'依赖不可用',error:'连接失败',waitingDependency:'等待隧道',disconnecting:'断开中' };
const permissionRules = {
  server: [
    { mode:'auto', label:'读取服务器文件与目录', icon:'eye', detail:'任意绝对路径；敏感内容也原样返回；查询有硬上限' },
    { mode:'auto', label:'状态、服务、Journal 与容器检查', icon:'plan', detail:'有界只读动作，不改变服务或容器状态' },
    { mode:'auto', label:'查找、搜索与下载普通文件', icon:'search', detail:'不读取设备、FIFO、Socket 等特殊文件' },
    { mode:'confirm', label:'上传、创建或覆盖文件', icon:'file', detail:'显示路径、大小和内容摘要后只确认一次' },
    { mode:'confirm', label:'移动、重命名或删除路径', icon:'file', detail:'确认后目标状态变化会要求重新确认' },
    { mode:'confirm', label:'启动、停止、重启或 reload 服务', icon:'plan', detail:'显示 systemd unit 和具体动作' },
    { mode:'strong', label:'执行任意 Shell', icon:'shield', detail:'最高风险；显示完整命令并进行二次确认' },
    { mode:'deny', label:'隐式或未登记操作', icon:'lock', detail:'未知能力默认拒绝；目录删除不递归' },
  ],
  mysql: [
    { mode:'auto', label:'查看表结构、SELECT 与 EXPLAIN', icon:'eye', detail:'固定数据库、单语句、有界结果' },
    { mode:'deny', label:'写入、DDL、切库与多语句', icon:'lock', detail:'当前版本未向 Agent 暴露' },
  ],
  redis: [
    { mode:'auto', label:'SCAN、读取值与 TTL', icon:'eye', detail:'已登记 Key pattern，有界返回' },
    { mode:'deny', label:'写入、脚本、管理命令与切库', icon:'lock', detail:'当前版本未向 Agent 暴露' },
  ],
};

async function call(promise) {
  const response = await promise;
  if (!response?.ok) {
    const error = new Error(response?.error?.message ?? '操作失败');
    error.code = response?.error?.code;
    error.details = response?.error?.details;
    throw error;
  }
  return response.data;
}

function resetPasswordControl(id) {
  const input = $(`#${id}`);
  input.type = 'password';
  input.value = '';
  input.dataset.credentialState = 'empty';
  updatePasswordToggle(id);
}

function markPasswordStored(id) {
  const input = $(`#${id}`);
  input.type = 'password';
  input.value = STORED_PASSWORD_MASK;
  input.dataset.credentialState = 'stored';
  updatePasswordToggle(id);
}

function updatePasswordToggle(id) {
  const input = $(`#${id}`);
  const button = $(`[data-password-target="${id}"]`);
  if (!button) return;
  const visible = input.type === 'text';
  button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  button.title = visible ? '隐藏密码' : '显示密码';
  button.classList.toggle('active', visible);
}

function editedPasswordValue(id) {
  const input = $(`#${id}`);
  return ['edited','revealed'].includes(input.dataset.credentialState) ? input.value : '';
}

function primaryCredentialField(plugin, authType = null) {
  const resolvedAuthType = authType ?? (plugin?.pluginType === 'server' ? plugin.auth?.type : null);
  return plugin?.pluginType === 'server' && resolvedAuthType === 'privateKey' ? 'privateKeyPassphrase' : 'password';
}

async function loadCredentialIndicators(plugin, generation) {
  if (!plugin) return;
  const status = await call(api.credentialStatus({
    projectId:plugin.projectId, environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId,
  }));
  if (generation !== state.credentialProbeGeneration || state.editingPlugin?.pluginInstanceId !== plugin.pluginInstanceId || !$('#pluginDialog').open) return;
  if (status.fields?.primary && $('#pluginPassword').dataset.credentialState === 'empty') markPasswordStored('pluginPassword');
  if (status.fields?.proxy && $('#pluginProxyPassword').dataset.credentialState === 'empty') markPasswordStored('pluginProxyPassword');
}

async function togglePasswordVisibility(button) {
  const id = button.dataset.passwordTarget;
  const input = $(`#${id}`);
  const credentialState = input.dataset.credentialState;
  if (credentialState === 'stored') {
    const plugin = state.editingPlugin;
    if (!plugin) return;
    button.disabled = true;
    try {
      const field = id === 'pluginProxyPassword' ? 'proxyPassword' : primaryCredentialField(plugin, $('#pluginAuthType').value);
      const result = await call(api.revealCredential({
        projectId:state.projectId, environmentId:state.environmentId, pluginInstanceId:plugin.pluginInstanceId, field,
      }));
      input.value = result.value;
      input.type = 'text';
      input.dataset.credentialState = 'revealed';
    } finally {
      button.disabled = false;
      updatePasswordToggle(id);
    }
    return;
  }
  if (credentialState === 'revealed' && input.type === 'text') {
    markPasswordStored(id);
    return;
  }
  input.type = input.type === 'password' ? 'text' : 'password';
  updatePasswordToggle(id);
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]); }
function escapeAttr(value) { return escapeHtml(value); }
function scopeKey(projectId = state.projectId, environmentId = state.environmentId) { return `${projectId}/${environmentId}`; }
function activeProject() { return state.projects.find((item) => item.projectId === state.projectId); }
function activeEnvironment() { return state.environments.find((item) => item.environmentId === state.environmentId); }
function activePlugin() { return state.plugins.find((item) => item.pluginInstanceId === state.pluginId); }
function pluginRuntime(id) { return state.runtime?.plugins?.[id] ?? { phase:'disconnected' }; }

function runtimeFacts(runtime = {}) {
  const pluginEntries = Object.entries(runtime.plugins ?? {});
  const manualIds = new Set(Object.entries(runtime.manualDisconnected ?? {}).filter(([,value]) => value).map(([id]) => id));
  for (const [id,plugin] of pluginEntries) if (plugin?.reason === 'USER_DISCONNECTED') manualIds.add(id);
  const pluginErrors = pluginEntries.filter(([,plugin]) => plugin?.phase === 'error').length;
  const pluginBlocked = pluginEntries.filter(([,plugin]) => plugin?.phase === 'blocked').length;
  const connectedCount = Number(runtime.connectedCount ?? pluginEntries.filter(([,plugin]) => plugin?.phase === 'connected').length);
  const eligibleCount = Number(runtime.eligibleCount ?? pluginEntries.length);
  const errorCount = Math.max(Number(runtime.errorCount ?? 0),pluginErrors);
  const blockedCount = Math.max(Number(runtime.blockedCount ?? 0),pluginBlocked);
  const fallbackFailures = runtime.phase === 'failed' && errorCount + blockedCount === 0 && manualIds.size === 0
    ? Math.max(1,eligibleCount - connectedCount)
    : 0;
  return {
    connectedCount,
    eligibleCount,
    manualDisconnectedCount:manualIds.size,
    errorCount,
    blockedCount,
    failureCount:errorCount + blockedCount + fallbackFailures,
  };
}

function runtimePresentationPhase(runtime = {}) {
  const facts = runtimeFacts(runtime);
  if (runtime.phase === 'partial' && facts.failureCount === 0) return facts.connectedCount > 0 ? 'connected' : 'disconnected';
  return runtime.phase ?? 'disconnected';
}

function toast(message, error = false, action = null) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  element.dataset.action = action ?? '';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), action ? 7000 : 3200);
}
function showError(error) { toast(error?.message ?? String(error), true); }

function normalizeProjectOrder(projects) {
  const ids = new Set(projects.map((item) => item.projectId));
  const saved = [...new Set(state.projectOrder)].filter((id) => ids.has(id));
  const missing = projects.map((item) => item.projectId).filter((id) => !saved.includes(id));
  state.projectOrder = [...saved, ...missing];
  // Project order is only a local navigation preference. Storage failures
  // must never prevent the workspace from opening.
  try { localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(state.projectOrder)); } catch {}
  const byId = new Map(projects.map((item) => [item.projectId,item]));
  return state.projectOrder.map((id) => byId.get(id)).filter(Boolean);
}

function environmentFor(projectId, environmentId) {
  return (state.environmentsByProject[projectId] ?? []).find((item) => item.environmentId === environmentId);
}

function environmentRuntime(projectId, environmentId) {
  const environment = environmentFor(projectId, environmentId);
  return state.runtimeByScope[scopeKey(projectId,environmentId)] ?? environment?.runtime ?? {
    projectId, environmentId, phase:'disconnected', desiredConnected:false,
    eligibleCount:environment?.readyPluginCount ?? 0, connectedCount:0,
    draftCount:Math.max(0,(environment?.pluginCount ?? 0) - (environment?.readyPluginCount ?? 0)),
    errorCount:0, blockedCount:0, plugins:{},
  };
}

function applyWorkspaceOverview(projects) {
  const ordered = normalizeProjectOrder(projects);
  state.projects = ordered.map(({ environments, ...project }) => project);
  state.environmentsByProject = Object.fromEntries(ordered.map((project) => [project.projectId,project.environments ?? []]));
  for (const project of ordered) {
    for (const environment of project.environments ?? []) {
      const key = scopeKey(project.projectId,environment.environmentId);
      const current = state.runtimeByScope[key];
      const incoming = environment.runtime;
      const currentTime = current?.updatedAt ? new Date(current.updatedAt).getTime() : 0;
      const incomingTime = incoming?.updatedAt ? new Date(incoming.updatedAt).getTime() : 0;
      if (incoming && (!current || !Number.isFinite(currentTime) || incomingTime > currentTime)) state.runtimeByScope[key] = incoming;
    }
  }
}

async function loadProjects(preferredId = state.projectId, generation = ++state.navigationGeneration) {
  const overviewGeneration = ++state.workspaceOverviewGeneration;
  const projects = await call(api.workspaceOverview());
  if (generation !== state.navigationGeneration || overviewGeneration !== state.workspaceOverviewGeneration) return;
  applyWorkspaceOverview(projects);
  state.projectId = preferredId && state.projects.some((item) => item.projectId === preferredId) ? preferredId : state.projects[0]?.projectId ?? null;
  state.environments = state.environmentsByProject[state.projectId] ?? [];
  if (!state.projectId || state.projectOverviewActive) {
    state.environmentId = null;
    state.pluginId = null;
    state.plugins = [];
    state.runtime = null;
    renderShell();
    return;
  }
  await loadProject(state.projectEnvironmentMemory[state.projectId], state.projectId, generation);
}

async function refreshWorkspaceOverview({ render = true } = {}) {
  const overviewGeneration = ++state.workspaceOverviewGeneration;
  const projects = await call(api.workspaceOverview());
  if (overviewGeneration !== state.workspaceOverviewGeneration) return false;
  applyWorkspaceOverview(projects);
  const projectSelectionChanged = !state.projectId || !state.projects.some((project) => project.projectId === state.projectId);
  if (projectSelectionChanged) {
    state.projectId = state.projects[0]?.projectId ?? null;
    state.projectOverviewActive = true;
    state.environmentId = null;
    state.pluginId = null;
    state.plugins = [];
    state.runtime = null;
    state.loadedScopeKey = null;
    resetScopeUi();
  }
  state.environments = state.environmentsByProject[state.projectId] ?? [];
  if (state.environmentId && !state.projectOverviewActive) state.runtime = environmentRuntime(state.projectId,state.environmentId);
  if (render || projectSelectionChanged) renderShell();
  return true;
}

async function loadProject(preferredEnvironment = state.environmentId, projectId = state.projectId, generation = ++state.navigationGeneration) {
  let environments = state.environmentsByProject[projectId];
  if (!environments) {
    environments = await call(api.listEnvironments(projectId));
    state.environmentsByProject[projectId] = environments;
  }
  if (generation !== state.navigationGeneration || projectId !== state.projectId) return;
  state.environments = environments;
  if (state.projectOverviewActive) {
    state.environmentId = null;
    state.pluginId = null;
    state.plugins = [];
    state.runtime = null;
    renderShell();
    return;
  }
  state.environmentId = preferredEnvironment && environments.some((item) => item.environmentId === preferredEnvironment) ? preferredEnvironment : environments[0]?.environmentId ?? null;
  state.pluginId = null;
  if (state.environmentId) await loadEnvironment(state.scopePluginMemory[scopeKey()], { projectId, environmentId:state.environmentId }, generation);
  else renderShell();
}

async function loadEnvironment(preferredPlugin = state.pluginId, scope = { projectId:state.projectId, environmentId:state.environmentId }, generation = ++state.navigationGeneration) {
  let plugins;
  let runtime;
  try {
    [plugins, runtime] = await Promise.all([call(api.listPlugins(scope)), call(api.environmentStatus(scope))]);
  } catch (error) {
    if (generation !== state.navigationGeneration || scope.projectId !== state.projectId || scope.environmentId !== state.environmentId) return false;
    throw error;
  }
  if (generation !== state.navigationGeneration || scope.projectId !== state.projectId || scope.environmentId !== state.environmentId) return false;
  state.plugins = plugins;
  state.runtime = runtime;
  state.runtimeByScope[scopeKey(scope.projectId, scope.environmentId)] = runtime;
  state.pluginId = plugins.some((item) => item.pluginInstanceId === preferredPlugin) ? preferredPlugin : plugins[0]?.pluginInstanceId ?? null;
  state.scopePluginMemory[scopeKey()] = state.pluginId;
  state.loadedScopeKey = scopeKey(scope.projectId,scope.environmentId);
  state.mobileDetail = false;
  renderShell();
  return true;
}

async function refreshEnvironmentMetadata() {
  const currentId = state.environmentId;
  state.environments = await call(api.listEnvironments(state.projectId));
  state.environmentsByProject[state.projectId] = state.environments;
  if (!state.environments.some((item) => item.environmentId === currentId)) {
    state.environmentId = state.environments[0]?.environmentId ?? null;
  }
}

function projectMark(project) { return [...(project.name || '项目')].slice(0,2).join(''); }
function projectRailWidthBounds() {
  const compact = window.innerWidth <= 760;
  const min = compact ? 220 : PROJECT_RAIL_MIN_WIDTH;
  const contentMinimum = compact ? 320 : 560;
  const max = Math.max(min,Math.min(PROJECT_RAIL_MAX_WIDTH,window.innerWidth - contentMinimum));
  return { min, max };
}
function applyProjectRailWidth(width = state.projectRailWidth) {
  const app = $('#app');
  const handle = $('#projectRailResizeHandle');
  const { min, max } = projectRailWidthBounds();
  const effectiveWidth = Math.round(Math.min(max,Math.max(min,Number(width) || PROJECT_RAIL_DEFAULT_WIDTH)));
  app.style.setProperty('--project-rail-width',`${effectiveWidth}px`);
  handle.setAttribute('aria-valuemin',String(min));
  handle.setAttribute('aria-valuemax',String(max));
  handle.setAttribute('aria-valuenow',String(effectiveWidth));
  return effectiveWidth;
}
function renderProjectRailState() {
  const app = $('#app');
  app.classList.toggle('rail-expanded', state.projectRailExpanded);
  const toggle = $('#toggleProjectRail');
  const handle = $('#projectRailResizeHandle');
  toggle.setAttribute('aria-expanded', String(state.projectRailExpanded));
  toggle.setAttribute('aria-label', state.projectRailExpanded ? '收起项目列表' : '展开项目列表');
  toggle.title = state.projectRailExpanded ? '收起项目列表' : '展开项目列表';
  handle.tabIndex = state.projectRailExpanded ? 0 : -1;
  handle.setAttribute('aria-hidden',String(!state.projectRailExpanded));
  applyProjectRailWidth();
}

function animateProjectRailLayout(change) {
  const items = [...document.querySelectorAll('#projectList > .project-tree-item')];
  const before = new Map(items.map((item) => [item.dataset.treeProject,item.getBoundingClientRect().top]));
  for (const item of items) item.getAnimations().forEach((animation) => animation.cancel());
  change();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const item of items) {
    const previousTop = before.get(item.dataset.treeProject);
    if (!Number.isFinite(previousTop)) continue;
    const delta = previousTop - item.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;
    item.animate(
      [{ transform:`translateY(${delta}px)` },{ transform:'translateY(0)' }],
      { duration:300,easing:'linear' },
    );
  }
}

function projectSummary(projectId) {
  const environments = state.environmentsByProject[projectId] ?? [];
  const runtimes = environments.map((item) => environmentRuntime(projectId,item.environmentId));
  const facts = runtimes.map(runtimeFacts);
  const connected = facts.filter((item) => item.connectedCount > 0).length;
  const reconnecting = runtimes.filter((runtime) => runtime.phase === 'reconnecting').length;
  const failed = facts.filter((item,index) => runtimes[index].phase !== 'reconnecting' && item.failureCount > 0 && item.connectedCount === 0).length;
  const attention = facts.filter((item,index) => runtimes[index].phase !== 'reconnecting' && item.failureCount > 0 && item.connectedCount > 0).length;
  const draft = environments.reduce((sum,item) => sum + Math.max(0,(item.pluginCount ?? 0) - (item.readyPluginCount ?? 0)),0);
  const connectedPlugins = runtimes.reduce((sum,runtime) => sum + Number(runtime.connectedCount ?? 0),0);
  const plugins = environments.reduce((sum,item) => sum + Number(item.pluginCount ?? 0),0);
  return { environments,connected,reconnecting,failed,attention,draft,connectedPlugins,plugins };
}

function projectState(projectId) {
  const summary = projectSummary(projectId);
  if (summary.failed) return 'failed';
  if (summary.attention) return 'attention';
  if (summary.reconnecting) return 'reconnecting';
  if (summary.connected) return 'connected';
  if (summary.draft) return 'draft';
  return 'disconnected';
}

function projectSubtitle(projectId) {
  const summary = projectSummary(projectId);
  const parts = [`${summary.environments.length} 个环境`];
  if (summary.connected) parts.push(`${summary.connected} 已连接`);
  if (summary.attention + summary.failed) parts.push(`${summary.attention + summary.failed} 需处理`);
  if (summary.reconnecting) parts.push(`${summary.reconnecting} 重连中`);
  if (summary.draft) parts.push(`${summary.draft} 待完善`);
  if (parts.length === 1) parts.push('未连接');
  return parts.join(' · ');
}

function environmentStatusText(projectId, environment) {
  const runtime = environmentRuntime(projectId,environment.environmentId);
  const facts = runtimeFacts(runtime);
  const ready = Number(environment.readyPluginCount ?? 0);
  const draft = Math.max(0,Number(environment.pluginCount ?? 0) - ready);
  if (!ready) return draft ? `${draft} 个插件待完善` : '尚未添加插件';
  if (runtime.phase === 'reconnecting') return `重连中 ${facts.connectedCount}/${facts.eligibleCount}`;
  if (runtime.phase === 'connecting') return `连接中 ${facts.connectedCount}/${facts.eligibleCount}`;
  if (runtime.phase === 'disconnecting') return `断开中 ${facts.connectedCount}/${facts.eligibleCount || ready}`;
  if (facts.failureCount > 0 && facts.connectedCount > 0) return `${facts.connectedCount}/${facts.eligibleCount} 已连接 · ${facts.failureCount} 个异常`;
  if (facts.failureCount > 0) return `0/${facts.eligibleCount} 连接失败`;
  if (facts.connectedCount > 0) return `${facts.connectedCount}/${facts.eligibleCount} 已连接${facts.manualDisconnectedCount ? ` · ${facts.manualDisconnectedCount} 个主动断开` : ''}${draft ? ` · ${draft} 待完善` : ''}`;
  if (facts.manualDisconnectedCount) return `${facts.manualDisconnectedCount} 个插件已主动断开`;
  return `${ready} 个插件 · 未连接${draft ? ` · ${draft} 待完善` : ''}`;
}

function railEnvironmentAction(projectId, environment) {
  const runtime = environmentRuntime(projectId,environment.environmentId);
  const facts = runtimeFacts(runtime);
  const ready = Number(environment.readyPluginCount ?? 0);
  const draft = Math.max(0,Number(environment.pluginCount ?? 0) - ready);
  if (!ready) return { action:'configure',label:environment.pluginCount ? '完善' : '添加',primary:false };
  if (runtime.phase === 'connecting') return { action:'cancel',label:'取消',primary:false };
  if (runtime.phase === 'disconnecting') return { action:'none',label:'断开中',primary:false,disabled:true };
  if (runtime.phase === 'reconnecting') return { action:'none',label:'重连中',primary:false,disabled:true };
  if (facts.failureCount > 0) return { action:'retry',label:'重试',primary:true };
  if (facts.manualDisconnectedCount > 0 || (facts.connectedCount > 0 && facts.connectedCount < facts.eligibleCount)) return { action:'connect',label:'连接未连接项',primary:true };
  if (facts.connectedCount > 0) return { action:'disconnect',label:'断开',primary:false };
  return { action:'connect',label:'连接',primary:true };
}

function currentEnvironmentAction() {
  const environment = activeEnvironment();
  if (!environment) return { action:'none',label:'未连接',primary:false,disabled:true };
  const runtime = state.runtime ?? environmentRuntime(state.projectId,environment.environmentId);
  if (!runtime.desiredConnected && Number(runtime.eligibleCount ?? 0) === 0) {
    return { action:'configure',label:state.plugins.length ? '完善' : '添加',primary:false };
  }
  return railEnvironmentAction(state.projectId,environment);
}

function renderProjects() {
  renderProjectRailState();
  $('#projectList').innerHTML = state.projects.map((project) => {
    const projectActive = project.projectId === state.projectId;
    const settingsAction = projectActive ? `<button type="button" class="rail-project-manage" data-project-settings="${escapeAttr(project.projectId)}" aria-label="设置项目 ${escapeAttr(project.name)}" title="项目设置">${icon('edit')}<span>设置</span></button>` : '';
    return `<section class="project-tree-item ${projectActive ? 'active' : ''}" data-tree-project="${escapeAttr(project.projectId)}" data-project-state="${escapeAttr(projectState(project.projectId))}"><div class="project-tree-head"><button type="button" class="rail-button ${projectActive ? 'active' : ''}" draggable="true" data-project-id="${escapeAttr(project.projectId)}" aria-label="打开 ${escapeAttr(project.name)} 的项目概览" title="${escapeAttr(project.name)}"><span class="rail-letter">${escapeHtml(projectMark(project))}</span><span class="rail-project-copy"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(projectSubtitle(project.projectId))}</small></span><span class="project-tooltip">${escapeHtml(project.name)}</span></button>${settingsAction}</div></section>`;
  }).join('');
}

function openProjectSettings(projectId) {
  const project = state.projects.find((item) => item.projectId === projectId);
  if (!project) return;
  state.managingProjectId = projectId;
  $('#projectSettingsName').value = project.name;
  $('#projectSettingsSummary').textContent = `${project.environmentCount ?? projectSummary(projectId).environments.length} 个环境 · ${project.pluginCount ?? projectSummary(projectId).plugins} 个插件`;
  $('#projectSettingsDialog').showModal();
  $('#projectSettingsName').focus();
  $('#projectSettingsName').select();
}

function openDeleteProject() {
  const project = state.projects.find((item) => item.projectId === state.managingProjectId);
  if (!project) return;
  const summary = projectSummary(project.projectId);
  state.managingProjectId = project.projectId;
  $('#deleteProjectScope').textContent = project.name;
  $('#deleteProjectMessage').textContent = `将永久删除 ${summary.environments.length} 个环境、${project.pluginCount ?? summary.plugins} 个插件及相关运维说明。此操作无法撤销；如有环境仍在连接，请先断开。`;
  $('#deleteProjectConfirmation').value = '';
  $('#confirmDeleteProject').disabled = true;
  $('#deleteProjectDialog').showModal();
  $('#deleteProjectConfirmation').focus();
}

function visibleEnvironments() {
  const current = activeEnvironment();
  if (state.environments.length <= 4 || !current) return state.environments.slice(0, 4);
  const first = state.environments.slice(0, 4);
  return first.some((item) => item.environmentId === current.environmentId) ? first : state.environments.slice(0, 3).concat(current);
}

function projectOverviewSummary(projectId) {
  const summary = projectSummary(projectId);
  const parts = [`${summary.environments.length} 个环境`];
  if (summary.connected) parts.push(`${summary.connected} 个已连接`);
  if (summary.attention + summary.failed) parts.push(`${summary.attention + summary.failed} 个需处理`);
  if (summary.reconnecting) parts.push(`${summary.reconnecting} 个重连中`);
  if (summary.draft) parts.push(`${summary.draft} 个插件待完善`);
  if (parts.length === 1) parts.push('当前均未连接');
  return parts.join(' · ');
}

function runtimeIssue(runtime) {
  if (runtime.phase === 'reconnecting') return '网络发生变化，正在恢复连接';
  const facts = runtimeFacts(runtime);
  if (facts.failureCount > 0 && facts.connectedCount > 0) return `${facts.failureCount} 个插件连接异常，已连接项仍可使用`;
  if (facts.failureCount > 0) return runtime.error?.message ?? '所有插件均未能连接';
  return '';
}

function overviewActions(projectId, environment) {
  const runtime = environmentRuntime(projectId,environment.environmentId);
  const action = railEnvironmentAction(projectId,environment);
  const connected = Number(runtime.connectedCount ?? 0);
  const scopeData = `data-overview-project-id="${escapeAttr(projectId)}"`;
  const open = `<button class="button small" ${scopeData} data-overview-enter="${escapeAttr(environment.environmentId)}">打开</button>`;
  if (action.action === 'configure') return `${open}<button class="button small primary" ${scopeData} data-overview-complete="${escapeAttr(environment.environmentId)}">${environment.pluginCount ? '完善配置' : '添加插件'}</button>`;
  if (runtime.phase === 'disconnecting') return `${open}<button class="button small" disabled>断开中</button>`;
  const primary = action.primary ? ' primary' : '';
  const main = `<button class="button small${primary}" ${scopeData} data-overview-runtime="${escapeAttr(action.action)}" data-runtime-environment-id="${escapeAttr(environment.environmentId)}" ${action.disabled ? 'disabled' : ''}>${escapeHtml(action.label === '重试' ? '重试失败项' : action.label === '连接' ? '连接环境' : action.label)}</button>`;
  const canStopConnection = connected > 0 || runtime.phase === 'reconnecting';
  const disconnectLabel = runtime.phase === 'reconnecting' && connected === 0 ? '停止重连' : '断开';
  const disconnect = runtime.desiredConnected && canStopConnection && !['connecting','disconnecting'].includes(runtime.phase) && action.action !== 'disconnect' ? `<button class="text-button" ${scopeData} data-overview-runtime="disconnect" data-runtime-environment-id="${escapeAttr(environment.environmentId)}">${disconnectLabel}</button>` : '';
  return `${open}${main}${disconnect}`;
}

function projectOverviewMetrics(projectId) {
  const environments = state.environmentsByProject[projectId] ?? [];
  const types = environments.reduce((counts,environment) => {
    for (const type of ['server','mysql','redis']) counts[type] += Number(environment.pluginTypeCounts?.[type] ?? 0);
    return counts;
  },{ server:0,mysql:0,redis:0 });
  const resources = environments.reduce((sum,environment) => sum + Number(environment.pluginCount ?? 0),0);
  const ready = environments.reduce((sum,environment) => sum + Number(environment.readyPluginCount ?? 0),0);
  const runtimes = environments.map((environment) => environmentRuntime(projectId,environment.environmentId));
  const eligible = runtimes.reduce((sum,runtime) => sum + Number(runtime.eligibleCount ?? 0),0);
  const connected = runtimes.reduce((sum,runtime) => sum + Number(runtime.connectedCount ?? 0),0);
  const attention = environments.filter((environment,index) => {
    const draft = Number(environment.pluginCount ?? 0) - Number(environment.readyPluginCount ?? 0);
    return draft > 0 || runtimeFacts(runtimes[index]).failureCount > 0 || runtimes[index].phase === 'reconnecting';
  }).length;
  return { environments:environments.length,types,resources,ready,eligible,connected,attention };
}

function renderProjectOverviewStats(projectId) {
  const metrics = projectOverviewMetrics(projectId);
  const typeParts = [['server','Server'],['mysql','MySQL'],['redis','Redis']]
    .filter(([type]) => metrics.types[type] > 0)
    .map(([type,label]) => `${label} ${metrics.types[type]}`);
  const values = [
    { label:'环境',value:metrics.environments,detail:metrics.attention ? `${metrics.attention} 个需要关注` : '没有配置或连接异常',tone:metrics.attention ? 'attention' : 'normal' },
    { label:'资源',value:metrics.resources,detail:typeParts.join(' · ') || '尚未添加资源',tone:'normal' },
    { label:'已配置',value:`${metrics.ready}/${metrics.resources}`,detail:metrics.ready < metrics.resources ? `${metrics.resources - metrics.ready} 个待完善` : metrics.resources ? '全部配置完成' : '等待添加插件',tone:metrics.ready < metrics.resources ? 'attention' : 'normal' },
    { label:'当前连接',value:`${metrics.connected}/${metrics.eligible}`,detail:metrics.eligible ? (metrics.connected === metrics.eligible ? '可用资源均已连接' : `${metrics.eligible - metrics.connected} 个尚未连接`) : '暂无可连接资源',tone:metrics.connected && metrics.connected === metrics.eligible ? 'success' : 'normal' },
  ];
  $('#projectOverviewStats').innerHTML = values.map((item) => `<div class="project-stat ${item.tone}"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(String(item.value))}</dd><small>${escapeHtml(item.detail)}</small></div>`).join('');
}

function resourceTargetText(resource) {
  const target = resource.resource ?? {};
  if (resource.pluginType === 'server') return target.host ? `${target.host}${target.port ? `:${target.port}` : ''}` : '服务器地址待配置';
  if (resource.pluginType === 'mysql') return target.database ? `数据库 ${target.database}` : '数据库待配置';
  if (resource.pluginType === 'redis') return Number.isInteger(target.db) ? `DB ${target.db}` : 'Redis DB 待配置';
  return '资源详情';
}

function resourcePhase(resource,runtime) {
  if (resource.configState !== 'ready') return 'draft';
  return runtime.plugins?.[resource.pluginInstanceId]?.phase ?? 'disconnected';
}

function resourceAction(resource,phase) {
  if (resource.configState !== 'ready') return { action:'configure',label:'待完善',disabled:true };
  if (phase === 'connected') return { action:'disconnect',label:'断开',disabled:false };
  if (['connecting','waitingDependency','reconnecting'].includes(phase)) return { action:'connect',label:'连接中',disabled:true };
  if (phase === 'disconnecting') return { action:'disconnect',label:'断开中',disabled:true };
  if (['failed','error','blocked'].includes(phase)) return { action:'connect',label:'重试',disabled:false };
  return { action:'connect',label:'连接',disabled:false };
}

function renderEnvironmentResources(projectId,environment,runtime) {
  const resources = Array.isArray(environment.resourcePreview) ? environment.resourcePreview.slice(0,4) : [];
  if (!resources.length) {
    const message = environment.pluginCount ? '打开环境查看资源详情' : '此环境尚未添加资源';
    return `<div class="environment-resource-empty"><span>${message}</span><button class="environment-resource-add" data-overview-project-id="${escapeAttr(projectId)}" data-overview-environment-id="${escapeAttr(environment.environmentId)}" data-overview-add-resource>添加资源</button></div>`;
  }
  const rows = resources.map((resource) => {
    const phase = resourcePhase(resource,runtime);
    const action = resourceAction(resource,phase);
    const actionTitle = action.action === 'disconnect' ? '断开此资源；依赖它的资源也可能同时断开' : '单独连接此资源；需要的隧道会自动建立';
    return `<div class="environment-resource-row"><button class="environment-resource-open" data-overview-project-id="${escapeAttr(projectId)}" data-overview-environment-id="${escapeAttr(environment.environmentId)}" data-overview-plugin="${escapeAttr(resource.pluginInstanceId)}"><span class="environment-resource-icon ${escapeAttr(resource.pluginType)}">${icon(typeIcons[resource.pluginType] ?? 'plug')}</span><span class="environment-resource-copy"><strong>${escapeHtml(resource.displayName)}</strong><small>${escapeHtml(resourceTargetText(resource))}</small></span></button><button class="environment-resource-action ${escapeAttr(phase)}" data-overview-project-id="${escapeAttr(projectId)}" data-overview-environment-id="${escapeAttr(environment.environmentId)}" data-overview-plugin-id="${escapeAttr(resource.pluginInstanceId)}" data-overview-plugin-action="${escapeAttr(action.action)}" aria-label="${escapeAttr(`${action.label} ${resource.displayName}`)}" title="${escapeAttr(actionTitle)}" ${action.disabled ? 'disabled' : ''}>${escapeHtml(action.label)}</button></div>`;
  }).join('');
  const remaining = Math.max(0,Number(environment.pluginCount ?? 0) - resources.length);
  const more = remaining ? `<button class="environment-resource-more" data-overview-project-id="${escapeAttr(projectId)}" data-overview-enter="${escapeAttr(environment.environmentId)}">还有 ${remaining} 个资源，打开查看</button>` : '';
  const add = `<button class="environment-resource-add footer" data-overview-project-id="${escapeAttr(projectId)}" data-overview-environment-id="${escapeAttr(environment.environmentId)}" data-overview-add-resource>＋ 添加资源</button>`;
  return `${rows}${more}${add}`;
}

function projectAttentionItems(projectId) {
  const items = [];
  for (const environment of state.environmentsByProject[projectId] ?? []) {
    const runtime = environmentRuntime(projectId,environment.environmentId);
    const facts = runtimeFacts(runtime);
    const draft = Math.max(0,Number(environment.pluginCount ?? 0) - Number(environment.readyPluginCount ?? 0));
    if (draft) items.push({ environment,kind:'draft',title:`${draft} 个插件待完善`,detail:'补齐地址、账号或数据库等配置' });
    if (runtime.phase === 'reconnecting') items.push({ environment,kind:'warning',title:'正在恢复连接',detail:'网络变化后正在自动重连' });
    else if (facts.failureCount > 0 && facts.connectedCount > 0) items.push({ environment,kind:'warning',title:'部分插件连接异常',detail:`当前 ${facts.connectedCount}/${facts.eligibleCount} 可用` });
    else if (facts.failureCount > 0) items.push({ environment,kind:'error',title:'环境当前不可用',detail:runtimeIssue(runtime) || '检查网络、凭据或依赖关系' });
  }
  return items;
}

function renderProjectOverviewAttention(projectId) {
  const items = projectAttentionItems(projectId);
  if (!items.length) {
    $('#projectOverviewAttention').innerHTML = '<div class="overview-healthy"><span>✓</span><div><strong>当前无需处理</strong><small>没有配置缺失或连接异常</small></div></div>';
    return;
  }
  const visible = items.slice(0,5);
  $('#projectOverviewAttention').innerHTML = visible.map((item) => `<button class="overview-attention-row ${item.kind}" data-overview-project-id="${escapeAttr(projectId)}" data-overview-enter="${escapeAttr(item.environment.environmentId)}"><span class="overview-attention-dot"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.environment.name)} · ${escapeHtml(item.detail)}</small></span><b>打开</b></button>`).join('') + (items.length > visible.length ? `<div class="overview-panel-more">另有 ${items.length - visible.length} 项</div>` : '');
}

function overviewActivityVisible(entry) {
  if (entry.type === 'plugin-operation-started' || entry.type === 'connect') return false;
  if (entry.type === 'disconnect' && entry.result !== 'connection-lost') return false;
  if (entry.type === 'environment-disconnected' && entry.reason === 'app-exit') return false;
  return entry.type?.startsWith('environment-') || ['plugin-added','plugin-operation','plugin-operation-decision','plugin-connected','plugin-disconnected','plugin-policy-updated','runbook-updated','confirmation-approved','confirmation-rejected','mysql-query','policy-denied','host-key-change-approved','auto-reconnect'].includes(entry.type) || (entry.type === 'disconnect' && entry.result === 'connection-lost');
}

function overviewActivityTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return '刚刚';
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return date.toLocaleString('zh-CN',{ month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' });
}

function renderProjectOverviewActivity(projectId) {
  const panel = $('#projectOverviewActivity');
  if (state.projectOverviewActivityLoading && !state.projectOverviewActivityRefreshing && state.projectOverviewActivityProjectId === projectId) {
    panel.innerHTML = '<div class="overview-panel-empty">正在读取本机操作记录…</div>';
    return;
  }
  const entries = state.projectOverviewActivityProjectId === projectId
    ? state.projectOverviewActivityEntries.filter(overviewActivityVisible).slice(0,5)
    : [];
  if (!entries.length) {
    panel.innerHTML = '<div class="overview-panel-empty">暂无项目操作记录</div>';
    return;
  }
  panel.innerHTML = entries.map((entry) => {
    const environment = environmentFor(projectId,entry.environmentId);
    const target = entry.pluginNameSnapshot ?? environment?.name ?? '当前项目';
    const result = auditResult(entry);
    const content = `<span class="overview-activity-dot ${escapeAttr(result)}"></span><span class="overview-activity-copy"><strong>${escapeHtml(auditOperationName(entry))}</strong><small>${escapeHtml(target)} · ${escapeHtml(auditActorName(entry))}</small></span><time>${escapeHtml(overviewActivityTime(entry.time))}</time>`;
    return environment
      ? `<button class="overview-activity-row" data-overview-project-id="${escapeAttr(projectId)}" data-overview-enter="${escapeAttr(environment.environmentId)}">${content}</button>`
      : `<div class="overview-activity-row">${content}</div>`;
  }).join('');
}

async function loadProjectOverviewActivity(projectId,{ force = false } = {}) {
  if (!force && state.projectOverviewActivityProjectId === projectId && !state.projectOverviewActivityLoading) return;
  const refreshing = Boolean(force && state.projectOverviewActivityProjectId === projectId && state.projectOverviewActivityEntries.length);
  const overview = $('#projectOverviewView');
  const preservedScrollTop = refreshing ? overview.scrollTop : null;
  const generation = ++state.projectOverviewActivityGeneration;
  state.projectOverviewActivityProjectId = projectId;
  state.projectOverviewActivityLoading = true;
  state.projectOverviewActivityRefreshing = refreshing;
  const refreshButton = $('[data-refresh-overview-activity]');
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy','true');
  }
  if (state.projectId === projectId && state.projectOverviewActive) renderProjectOverviewActivity(projectId);
  try {
    const result = await call(api.listAudit({ projectId,limit:20 }));
    if (generation !== state.projectOverviewActivityGeneration || state.projectOverviewActivityProjectId !== projectId) return;
    state.projectOverviewActivityEntries = result.entries ?? [];
  } finally {
    if (generation === state.projectOverviewActivityGeneration && state.projectOverviewActivityProjectId === projectId) {
      state.projectOverviewActivityLoading = false;
      state.projectOverviewActivityRefreshing = false;
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.setAttribute('aria-busy','false');
      }
      if (state.projectId === projectId && state.projectOverviewActive) {
        renderProjectOverviewActivity(projectId);
        if (preservedScrollTop !== null) overview.scrollTop = preservedScrollTop;
      }
    }
  }
}

function renderOverviewEnvironmentMain(projectId,environment) {
  if (state.overviewEditingProjectId === projectId && state.overviewEditingEnvironmentId === environment.environmentId) {
    return `<form class="environment-card-editor" data-overview-environment-editor="${escapeAttr(environment.environmentId)}" data-overview-project-id="${escapeAttr(projectId)}"><input maxlength="120" autocomplete="off" aria-label="环境名称" value="${escapeAttr(environment.name)}"><button type="button" class="text-button" data-overview-cancel-environment-edit>取消</button><button type="submit" class="text-button primary">保存</button></form>`;
  }
  const prompt = state.overviewEnvironmentDeletePrompt?.environmentId === environment.environmentId ? state.overviewEnvironmentDeletePrompt : null;
  if (prompt) {
    return `<span class="environment-card-name">${escapeHtml(environment.name)}</span><span class="environment-card-delete-prompt ${prompt.confirmable ? '' : 'blocked'}"><span>${escapeHtml(prompt.message)}</span><button class="text-button" data-overview-cancel-environment-delete>${prompt.confirmable ? '取消' : '关闭'}</button>${prompt.confirmable ? `<button class="text-button danger" data-overview-confirm-delete-environment="${escapeAttr(environment.environmentId)}" data-overview-project-id="${escapeAttr(projectId)}">确认删除</button>` : ''}</span>`;
  }
  return `<button class="overview-environment-link" data-overview-project-id="${escapeAttr(projectId)}" data-overview-enter="${escapeAttr(environment.environmentId)}">${escapeHtml(environment.name)}</button><span class="environment-card-actions"><button class="text-button" data-overview-rename-environment="${escapeAttr(environment.environmentId)}">重命名</button><button class="text-button danger" data-overview-delete-environment="${escapeAttr(environment.environmentId)}" data-overview-project-id="${escapeAttr(projectId)}">删除</button></span>`;
}

async function saveOverviewEnvironmentName(form) {
  const projectId = form.dataset.overviewProjectId;
  const environmentId = form.dataset.overviewEnvironmentEditor;
  const environment = (state.environmentsByProject[projectId] ?? []).find((item) => item.environmentId === environmentId);
  const name = form.querySelector('input').value.trim();
  if (!environment) return;
  if (!name) throw new Error('请输入环境名称。');
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await call(api.updateEnvironment({projectId,environmentId,patch:{name},expectedRevision:environment.revision}));
    state.overviewEditingProjectId = null;
    state.overviewEditingEnvironmentId = null;
    await refreshWorkspaceOverview({render:false});
    state.environments = state.environmentsByProject[state.projectId] ?? [];
    renderShell();
    toast('环境名称已更新。');
  } finally {
    if (submit.isConnected) submit.disabled = false;
  }
}

function renderProjectOverview() {
  const project = activeProject();
  if (!project) return;
  $('#projectOverviewSummary').textContent = projectOverviewSummary(project.projectId);
  $('#projectOverviewEnvironmentCount').textContent = `${state.environments.length} 个环境`;
  renderProjectOverviewStats(project.projectId);
  renderProjectOverviewAttention(project.projectId);
  renderProjectOverviewActivity(project.projectId);
  $('#projectOverviewList').innerHTML = state.environments.map((environment) => {
    const runtime = environmentRuntime(project.projectId,environment.environmentId);
    const issue = runtimeIssue(runtime);
    const pluginCount = Number(environment.pluginCount ?? 0);
    const readyCount = Number(environment.readyPluginCount ?? 0);
    const eligibleCount = Number(runtime.eligibleCount ?? readyCount);
    const connectedCount = Number(runtime.connectedCount ?? 0);
    const issueRow = issue
      ? `<p class="environment-overview-issue" title="${escapeAttr(issue)}">${escapeHtml(issue)}</p>`
      : '<p class="environment-overview-issue empty" aria-hidden="true">&nbsp;</p>';
    const presentationPhase = runtimePresentationPhase(runtime);
    return `<article class="environment-overview-row" data-overview-project="${escapeAttr(project.projectId)}" data-overview-environment="${escapeAttr(environment.environmentId)}" data-state="${escapeAttr(presentationPhase)}"><div class="environment-overview-main">${renderOverviewEnvironmentMain(project.projectId,environment)}</div><div class="environment-overview-state" data-state="${escapeAttr(presentationPhase)}"><strong>${escapeHtml(environmentStatusText(project.projectId,environment))}</strong></div><dl class="environment-overview-metrics"><div><dt>插件</dt><dd>${pluginCount}</dd></div><div><dt>已配置</dt><dd>${readyCount}/${pluginCount}</dd></div><div><dt>已连接</dt><dd>${connectedCount}/${eligibleCount}</dd></div></dl><div class="environment-overview-resources">${renderEnvironmentResources(project.projectId,environment,runtime)}</div>${issueRow}<div class="environment-overview-actions">${overviewActions(project.projectId,environment)}</div></article>`;
  }).join('');
  $('.environment-card-editor')?.addEventListener('submit', (event) => { event.preventDefault(); saveOverviewEnvironmentName(event.currentTarget).catch(showError); });
  if (!state.projectOverviewActivityLoading && state.projectOverviewActivityProjectId !== project.projectId) loadProjectOverviewActivity(project.projectId).catch(showError);
}

function renderShell() {
  renderProjects();
  const project = activeProject();
  const environment = activeEnvironment();
  const overview = Boolean(project && state.projectOverviewActive);
  $('#app').classList.toggle('project-overview-active',overview);
  $('#projectTitle').textContent = project?.name ?? '选择项目';
  $('#emptyState').classList.toggle('hidden', Boolean(project));
  $('#environmentRuntime').classList.toggle('hidden', !environment);
  if (!project) {
    $('#environmentTabs').innerHTML = '';
    $('#moreEnvironments').classList.add('hidden');
    renderConfirmationButton();
    ['projectOverviewView','pluginsView','runbookView','auditView'].forEach((id) => $(`#${id}`).classList.add('hidden'));
    return;
  }
  $('#environmentTabs').innerHTML = overview ? '' : visibleEnvironments().map((item) => `<button class="environment-tab ${item.environmentId === state.environmentId ? 'active' : ''}" data-environment-id="${escapeAttr(item.environmentId)}" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</button>`).join('');
  const hiddenEnvironmentCount = overview ? 0 : Math.max(0, state.environments.length - visibleEnvironments().length);
  $('#moreEnvironments').classList.toggle('hidden', hiddenEnvironmentCount === 0);
  $('#moreEnvironments').textContent = `更多 ${hiddenEnvironmentCount}`;
  renderConfirmationButton();
  if (overview) {
    $('#projectOverviewView').classList.remove('hidden');
    ['pluginsView','runbookView','auditView'].forEach((id) => $(`#${id}`).classList.add('hidden'));
    renderProjectOverview();
    return;
  }
  $('#projectOverviewView').classList.add('hidden');
  if (!environment) return;
  renderRuntime();
  renderView();
}

function renderRuntime() {
  const runtime = state.runtime ?? { phase:'disconnected', eligibleCount:0, connectedCount:0 };
  const facts = runtimeFacts(runtime);
  const status = $('#environmentStatus');
  status.dataset.state = runtimePresentationPhase(runtime);
  const total = facts.eligibleCount;
  const connected = facts.connectedCount;
  if (runtime.phase === 'reconnecting') status.textContent = total ? `网络变化 · 重连中 ${connected}/${total}` : '网络变化 · 重连中';
  else if (runtime.phase === 'connecting') status.textContent = total ? `连接中 ${connected}/${total}` : '正在准备连接';
  else if (runtime.phase === 'disconnecting') status.textContent = phaseNames[runtime.phase];
  else if (facts.failureCount > 0 && connected > 0) status.textContent = `${connected}/${total} 可用 · ${facts.failureCount} 个异常`;
  else if (facts.failureCount > 0) status.textContent = total ? `连接失败 · 0/${total}` : '没有可连接的插件';
  else if (connected > 0) status.textContent = `${connected}/${total} 已连接${facts.manualDisconnectedCount ? ` · ${facts.manualDisconnectedCount} 主动断开` : ''}`;
  else if (facts.manualDisconnectedCount) status.textContent = `${facts.manualDisconnectedCount} 个插件已主动断开`;
  else status.textContent = phaseNames[runtime.phase] ?? '未连接';
  const action = $('#environmentAction');
  const disconnect = $('#environmentDisconnect');
  const environmentAction = currentEnvironmentAction();
  const canStopConnection = connected > 0 || runtime.phase === 'reconnecting';
  disconnect.textContent = runtime.phase === 'reconnecting' && connected === 0 ? '停止重连' : '断开';
  disconnect.classList.toggle('hidden', !runtime.desiredConnected || !canStopConnection || ['connecting','disconnecting'].includes(runtime.phase) || environmentAction.action === 'disconnect');
  if (environmentAction.action === 'configure') action.textContent = state.plugins.length ? '完善插件' : '添加插件';
  else if (environmentAction.action === 'cancel') action.textContent = '取消';
  else if (environmentAction.action === 'disconnect') action.textContent = '断开环境';
  else if (environmentAction.action === 'retry') action.textContent = '重试失败项';
  else if (environmentAction.action === 'connect') action.textContent = environmentAction.label === '连接未连接项' ? environmentAction.label : '连接全部插件';
  else action.textContent = environmentAction.label;
  action.disabled = Boolean(environmentAction.disabled);
}

function renderView() {
  $$('.page-tab').forEach((item) => item.classList.toggle('active', item.dataset.view === state.view));
  $('#pluginsView').classList.toggle('hidden', state.view !== 'plugins');
  $('#runbookView').classList.toggle('hidden', state.view !== 'runbook');
  $('#auditView').classList.toggle('hidden', state.view !== 'audit');
  if (state.view === 'plugins') renderPlugins();
  else if (state.view === 'runbook') {
    if (state.runbookScopeKey === scopeKey()) renderRunbook();
    else loadRunbook().catch(showError);
  }
  else loadAudit().catch(showError);
}

function pluginTarget(plugin) {
  if (plugin.pluginType === 'server') return `${plugin.auth?.username || '未配置'}@${plugin.target?.host || '未配置'}:${plugin.target?.port ?? 22}`;
  if (plugin.pluginType === 'mysql') return `${plugin.target?.database || '未配置数据库'} · ${transportName(plugin)}`;
  return `DB ${plugin.target?.db ?? 0} · ${transportName(plugin)}`;
}
function providerName(id) { return state.plugins.find((item) => item.pluginInstanceId === id)?.displayName ?? id; }
function transportName(plugin) { if (plugin.transport?.kind === 'serverTunnel') return `经 ${providerName(plugin.transport.serverPluginInstanceId)} 隧道`; if (plugin.transport?.kind === 'windowsVpn') return `Windows VPN · ${plugin.transport.interfaceAlias || '未配置网卡'}`; return '直接连接'; }
function familyName(value) { return ({ ipv4Preferred:'IPv4 优先，失败尝试 IPv6',ipv4Only:'仅 IPv4',ipv6Preferred:'IPv6 优先，失败尝试 IPv4',ipv6Only:'仅 IPv6' })[value] ?? value ?? 'IPv4 优先，失败尝试 IPv6'; }
function uplinkName(plugin) { const uplink = plugin.uplink ?? { type:'direct' }; if (uplink.type === 'direct') return '直接连接'; if (uplink.type === 'windowsVpn') return `Windows VPN · ${uplink.interfaceAlias || '未配置网卡'}`; return `${uplink.type.toUpperCase()} · ${uplink.host}:${uplink.port}`; }

function renderPlugins() {
  $('#pluginsView').classList.toggle('mobile-detail-open', state.mobileDetail);
  $('#pluginCount').textContent = state.plugins.length || '';
  const groups = ['server','mysql','redis'].map((type) => {
    const items = state.plugins.filter((item) => item.pluginType === type);
    if (!items.length) return '';
    return `<section class="plugin-group"><div class="plugin-group-label">${typeNames[type]} · ${items.length}</div>${items.map(pluginItem).join('')}</section>`;
  }).join('');
  $('#pluginList').innerHTML = groups || '<div class="detail-empty"><div><p>当前环境还没有插件</p><button class="button primary" data-action="add-plugin">添加插件</button></div></div>';
  renderPluginDetail();
}

function pluginItem(plugin) {
  const runtime = pluginRuntime(plugin.pluginInstanceId);
  const status = plugin.configState === 'ready' ? (phaseNames[runtime.phase] ?? runtime.phase) : '待配置';
  const stateClass = plugin.configState === 'ready' ? runtime.phase : 'draft';
  return `<button class="plugin-item ${plugin.pluginInstanceId === state.pluginId ? 'active' : ''}" data-plugin-id="${escapeAttr(plugin.pluginInstanceId)}"><span class="plugin-icon">${icon(typeIcons[plugin.pluginType])}</span><span class="plugin-copy"><strong>${escapeHtml(plugin.displayName)}</strong><small>${escapeHtml(pluginTarget(plugin))}</small></span><span class="state-dot ${escapeAttr(stateClass)}" title="${escapeAttr(status)}"></span></button>`;
}

function detailTab(plugin) { return state.detailTabs[plugin.pluginInstanceId] ?? (plugin.pluginType === 'mysql' ? 'permissions' : 'connection'); }
function renderPluginDetail() {
  const plugin = activePlugin();
  if (!plugin) { $('#pluginDetail').innerHTML = '<div class="detail-empty"><div>选择一个插件查看详情</div></div>'; return; }
  const runtime = pluginRuntime(plugin.pluginInstanceId);
  const tab = detailTab(plugin);
  state.detailTabs[plugin.pluginInstanceId] = tab;
  const error = runtime.error?.message ? `<div class="inline-error"><span>${escapeHtml(runtime.error.message)}</span>${runtime.reason === 'SSH_HOST_KEY_CONFIRM_REQUIRED' ? '<button class="button small" data-action="trust-host">确认指纹并重试</button>' : '<button class="button small" data-action="test-plugin">检查连接</button>'}</div>` : '';
  const connected = ['connected','connecting','reconnecting','waitingDependency'].includes(runtime.phase);
  const runtimeAction = plugin.configState !== 'ready'
    ? '<button class="button primary" data-action="edit-plugin">完善配置</button>'
    : connected
    ? `<button class="button" data-action="disconnect-plugin" ${['connecting','reconnecting'].includes(runtime.phase) ? 'disabled' : ''}>断开</button>`
    : '<button class="button primary" data-action="connect-plugin">连接</button>';
  const configAction = plugin.configState === 'ready' ? '<button class="button" data-action="edit-plugin">配置</button>' : '';
  const status = plugin.configState === 'ready' ? (phaseNames[runtime.phase] ?? runtime.phase) : '待配置';
  const stateClass = plugin.configState === 'ready' ? runtime.phase : 'draft';
  $('#pluginDetail').innerHTML = `<header class="detail-head"><button class="square-button mobile-back" data-action="mobile-plugin-list" aria-label="返回插件列表">←</button><div class="detail-title-line"><span class="detail-icon">${icon(typeIcons[plugin.pluginType])}</span><div class="detail-title"><div class="detail-title-top"><h1>${escapeHtml(plugin.displayName)}</h1><span class="type-label">${typeNames[plugin.pluginType]}</span><span class="health ${escapeAttr(stateClass)}">${escapeHtml(status)}</span></div><p class="detail-summary">${escapeHtml(pluginTarget(plugin))}</p></div><div class="detail-actions">${runtimeAction}<button class="button" data-action="test-plugin" ${plugin.configState !== 'ready' ? 'disabled' : ''}>检查连接</button>${configAction}<button class="button danger" data-action="prepare-delete-plugin">删除插件</button></div></div><nav class="detail-tabs"><button class="detail-tab ${tab === 'connection' ? 'active' : ''}" data-detail-tab="connection">连接</button><button class="detail-tab ${tab === 'permissions' ? 'active' : ''}" data-detail-tab="permissions">Agent 权限</button></nav></header><div class="detail-content">${error}${tab === 'connection' ? renderConnection(plugin) : renderPermissions(plugin)}</div>`;
}

function renderConnection(plugin) {
  const fields = plugin.pluginType === 'server'
    ? [['SSH 目标',`${plugin.auth?.username || ''}@${plugin.target.host}:${plugin.target.port}`],['上行方式',uplinkName(plugin)],['地址族',familyName(plugin.target.addressFamily)],['主机指纹',plugin.target.hostKeyFingerprint || '首次连接时确认']]
    : [['目标',`${plugin.target.host}:${plugin.target.port}`],[plugin.pluginType === 'mysql' ? '固定数据库' : '固定 Logical DB',plugin.pluginType === 'mysql' ? plugin.target.database : String(plugin.target.db)],['连接方式',transportName(plugin)],['地址族',familyName(plugin.target.addressFamily)],['TLS',plugin.tls?.mode ?? 'disabled']];
  const route = plugin.pluginType === 'server' ? ['本机', uplinkName(plugin), `${plugin.target.host}:${plugin.target.port}`] : plugin.transport?.kind === 'serverTunnel' ? ['本机',providerName(plugin.transport.serverPluginInstanceId),'SSH 隧道',`${plugin.target.host}:${plugin.target.port}`] : ['本机',transportName(plugin),`${plugin.target.host}:${plugin.target.port}`];
  const dependents = plugin.pluginType === 'server' ? state.plugins.filter((item) => item.transport?.serverPluginInstanceId === plugin.pluginInstanceId) : [];
  return `<div class="content-title"><h2>连接</h2></div><section class="connection-section"><h3>连接目标</h3><dl class="field-list">${fields.map(([key,value]) => `<dt>${escapeHtml(key)}</dt><dd class="mono">${escapeHtml(value)}</dd>`).join('')}</dl></section><section class="connection-section"><h3>连接路径</h3><div class="route-line">${route.map((node,index) => `${index ? '<span class="route-arrow">→</span>' : ''}<span class="route-node">${escapeHtml(node)}</span>`).join('')}</div></section>${plugin.pluginType === 'server' ? `<section class="connection-section"><h3>隧道复用</h3><div class="consumer-list">${dependents.length ? dependents.map((item) => `<div class="consumer-row">${icon(typeIcons[item.pluginType])}<strong>${escapeHtml(item.displayName)}</strong><span>${typeNames[item.pluginType]} · ${escapeHtml(item.pluginType === 'mysql' ? item.target.database : `DB ${item.target.db}`)}</span></div>`).join('') : '<span class="muted">暂无插件复用该隧道</span>'}</div></section>` : ''}`;
}

const permissionModeNames = { auto:'自动放行', confirm:'每次确认', strong:'强确认', deny:'默认拒绝' };
function limitSummary(plugin) { if (plugin.pluginType === 'mysql') return `只读固定数据库 ${plugin.target.database} · 单语句 · 最多 ${plugin.limits?.maxRows ?? 100} 行 · ${Math.round((plugin.limits?.timeoutMs ?? 10000)/1000)} 秒超时`; if (plugin.pluginType === 'redis') return `只读固定 DB ${plugin.target.db} · 最多 ${plugin.limits?.maxKeys ?? 100} 个 Key · 不允许 Agent 切库`; return '权限由应用内置风险表判定，Agent 不能自行声明“安全”；所有读取有资源上限，所有服务器变更逐次确认。'; }
function renderPermissions(plugin) {
  const rows = permissionRules[plugin.pluginType].map((rule) => `<div class="policy-row"><span class="policy-row-icon">${icon(rule.icon)}</span><strong>${escapeHtml(rule.label)}</strong><span class="policy-detail">${escapeHtml(rule.detail)}</span><span class="policy-state ${escapeAttr(rule.mode)}">${escapeHtml(permissionModeNames[rule.mode])}</span></div>`).join('');
  return `<div class="content-title"><div><h2>Agent 权限</h2><p class="muted">这是应用强制执行的风险规则，不由 Agent 或插件数据源决定。</p></div></div><section class="policy-section"><div class="policy-section-title">固定执行规则</div>${rows}</section><div class="policy-limits">${icon('shield')}<span>${escapeHtml(limitSummary(plugin))}</span></div>`;
}

function renderMarkdown(source) {
  const lines = String(source ?? '').split(/\r?\n/);
  const output = [];
  let list = false;
  for (const line of lines) {
    if (line.startsWith('# ')) { if (list) { output.push('</ul>'); list = false; } output.push(`<h1>${escapeHtml(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { if (list) { output.push('</ul>'); list = false; } output.push(`<h2>${escapeHtml(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('- ')) { if (!list) { output.push('<ul>'); list = true; } output.push(`<li>${escapeHtml(line.slice(2))}</li>`); continue; }
    if (list) { output.push('</ul>'); list = false; }
    if (line.trim()) output.push(`<p>${escapeHtml(line)}</p>`);
  }
  if (list) output.push('</ul>');
  return output.join('') || '<p class="muted">暂未填写运维说明</p>';
}

async function loadRunbook() {
  const requestedScope = scopeKey();
  state.runbookContent = '';
  state.runbookRevision = null;
  state.runbookScopeKey = requestedScope;
  state.runbookEditing = false;
  renderRunbook();
  const result = await call(api.readRunbook({ projectId:state.projectId, environmentId:state.environmentId }));
  if (state.view !== 'runbook' || requestedScope !== scopeKey()) return;
  state.runbookContent = result.content ?? '';
  state.runbookRevision = activeEnvironment()?.revision ?? null;
  state.runbookScopeKey = requestedScope;
  state.runbookEditing = false;
  renderRunbook();
}
function renderRunbook() {
  const environment = activeEnvironment();
  if (!environment) return;
  $('#runbookTitle').textContent = `${environment.name} · 运维说明`;
  $('#runbookScope').textContent = activeProject().name;
  $('#runbookPreview').innerHTML = renderMarkdown(state.runbookContent);
  $('#runbookEditor').value = state.runbookContent;
  const bytes = new TextEncoder().encode(state.runbookContent).length;
  $('#runbookBytes').textContent = `${bytes.toLocaleString()} / 65,536 字节`;
  $('#runbookBytes').classList.toggle('error-text', bytes > 65_536);
  $('#saveRunbook').disabled = bytes > 65_536;
  $('#runbookPreview').classList.toggle('hidden', state.runbookEditing);
  $('#runbookEditor').classList.toggle('hidden', !state.runbookEditing);
  $('#editRunbook').classList.toggle('hidden', state.runbookEditing);
  $('#saveRunbook').classList.toggle('hidden', !state.runbookEditing);
  $('#cancelRunbook').classList.toggle('hidden', !state.runbookEditing);
}

async function loadAudit() {
  const requestedScope = scopeKey();
  const result = await call(api.listAudit({ projectId:state.projectId, environmentId:state.environmentId, limit:200 }));
  if (state.view !== 'audit' || requestedScope !== scopeKey()) return;
  state.auditEntries = result.entries ?? [];
  renderAudit();
}
function auditResult(entry) {
  const value = String(entry.result ?? (entry.errorCode ? 'error' : 'success')).toLowerCase();
  if (['success','connected','disconnected','complete','completed'].includes(value)) return 'success';
  if (['partial','warning','pending-confirmation'].includes(value)) return 'warning';
  if (['blocked','denied'].includes(value)) return 'blocked';
  return 'error';
}
function auditPluginName(entry) {
  if (!entry.pluginInstanceId) return activeEnvironment()?.name ?? '当前环境';
  return entry.pluginNameSnapshot ?? state.plugins.find((item) => item.pluginInstanceId === entry.pluginInstanceId)?.displayName ?? '已删除的插件';
}
function auditCapabilityName(value) {
  return ({status:'查看系统状态',diagnostics:'运行安全诊断','service.inspect':'查看服务','journal.read':'查询 Journal','container.inspect':'查看容器',logs:'查询日志',config:'查看配置',download:'下载文件','fs.stat':'查看文件属性','fs.list':'列出目录','fs.find':'查找文件','fs.read':'读取文件','fs.search':'搜索文件内容','fs.download':'下载文件','fs.upload':'上传文件','fs.write':'写入文件','fs.move':'移动或重命名','fs.delete':'删除路径','service.control':'控制服务','shell.execute':'执行任意 Shell',describe:'查看表结构',select:'查询数据',explain:'查看执行计划',scan:'扫描缓存键',read:'读取缓存',ttl:'查看过期时间'})[value] ?? value;
}
function auditErrorName(value) {
  return ({POLICY_DENIED:'操作规则禁止',CONFIRMATION_REQUIRED:'等待人工确认',PLUGIN_NOT_CONNECTED:'插件尚未连接',PLUGIN_UNAVAILABLE:'插件当前不可用',AUTHENTICATION_FAILED:'身份认证失败',ROUTE_UNAVAILABLE:'网络不可达',CONNECT_TIMEOUT:'连接超时'})[value] ?? value;
}
function auditActorName(entry) {
  if (entry.actor === 'agent' || entry.type === 'plugin-operation' || entry.type === 'policy-denied' || entry.type === 'mysql-query') return 'Agent';
  if (entry.actor === 'system' || entry.type === 'auto-reconnect' || entry.result === 'connection-lost') return '系统';
  return '用户';
}
function auditOperationName(entry) {
  if (entry.type === 'plugin-added') return '添加插件';
  if (entry.type === 'plugin-connected') return '连接插件';
  if (entry.type === 'plugin-disconnected') return '断开插件';
  if (entry.type === 'plugin-policy-updated') return '修改 Agent 权限';
  if (entry.type === 'runbook-updated') return '更新运维说明';
  if (entry.type === 'confirmation-approved') return '确认 Agent 操作';
  if (entry.type === 'confirmation-rejected') return '拒绝 Agent 操作';
  if (entry.type === 'plugin-operation-decision') return auditCapabilityName(entry.capability ?? 'Agent 操作');
  if (entry.type === 'environment-disconnected') return '断开环境';
  if (entry.type?.startsWith('environment-')) return '连接环境';
  if (entry.type === 'host-key-change-approved') return '确认服务器指纹';
  if (entry.type === 'auto-reconnect') return '自动恢复连接';
  if (entry.type === 'disconnect' && entry.result === 'connection-lost') return '连接意外中断';
  if (entry.type === 'plugin-operation') return auditCapabilityName(entry.capability ?? entry.operation ?? '执行插件操作');
  return auditCapabilityName(entry.operation ?? entry.capability ?? ({'mysql-query':'查询数据','policy-denied':'操作被规则拦截'})[entry.type] ?? '未知操作');
}
function auditDescription(entry) {
  if (entry.detail) return entry.detail;
  if (entry.type?.startsWith('environment-')) {
    if (entry.type === 'environment-disconnected') return '当前环境的插件连接已断开';
    const connected = Number(entry.connectedCount ?? 0);
    const eligible = Number(entry.eligibleCount ?? connected);
    return `${connected}/${eligible} 个插件已连接${connected < eligible ? '，其余插件不可用' : ''}`;
  }
  if (entry.type === 'auto-reconnect') return entry.errorCode ? auditErrorName(entry.errorCode) : `第 ${entry.attempt ?? 1} 次尝试已完成`;
  if (entry.type === 'disconnect' && entry.result === 'connection-lost') return '网络或远端连接中断';
  if (entry.type === 'runbook-updated') return `已保存 ${Number(entry.bytes ?? 0).toLocaleString()} 字节`;
  if (entry.type === 'plugin-added') return entry.operationSummary ?? (entry.configState === 'ready' ? '插件已配置并保持断开' : '插件草稿已创建，等待补充配置');
  if (entry.errorCode) return auditErrorName(entry.errorCode);
  if (entry.operationSummary) return `${entry.actor === 'agent' ? 'Agent' : '用户'} · ${entry.operationSummary}${Number.isFinite(entry.durationMs) ? ` · ${entry.durationMs} ms` : ''}`;
  if (Number.isFinite(entry.durationMs)) return `耗时 ${entry.durationMs} ms`;
  return '已完成';
}
function visibleAuditEntries() {
  return state.auditEntries.filter((entry) => {
    if (entry.type === 'plugin-operation-started' || entry.type === 'connect') return false;
    if (entry.type === 'disconnect' && entry.result !== 'connection-lost') return false;
    if (entry.type === 'environment-disconnected' && entry.reason === 'app-exit') return false;
    return entry.type?.startsWith('environment-') || ['plugin-operation','plugin-operation-decision','plugin-connected','plugin-disconnected','plugin-policy-updated','runbook-updated','confirmation-approved','confirmation-rejected','mysql-query','policy-denied','host-key-change-approved','auto-reconnect'].includes(entry.type) || (entry.type === 'disconnect' && entry.result === 'connection-lost');
  }).sort((left,right) => new Date(right.time).getTime() - new Date(left.time).getTime());
}
function renderAudit() {
  const environment = activeEnvironment();
  if (!environment) return;
  $('#auditTitle').textContent = `${environment.name} · 操作记录`;
  const query = $('#auditSearch').value.trim().toLocaleLowerCase('zh-CN');
  const resultFilter = $('#auditResult').value;
  const rows = visibleAuditEntries().filter((entry) => {
    const result = auditResult(entry);
    const text = [auditOperationName(entry),auditPluginName(entry),auditDescription(entry)].join(' ').toLocaleLowerCase('zh-CN');
    return (!resultFilter || result === resultFilter) && (!query || text.includes(query));
  });
  const resultNames = { success:'成功',warning:'部分成功',blocked:'已拦截',error:'失败' };
  $('#auditBody').innerHTML = rows.map((entry) => { const result = auditResult(entry); return `<tr><td>${escapeHtml(new Date(entry.time).toLocaleString())}</td><td><span class="audit-actor ${escapeAttr(auditActorName(entry).toLowerCase())}">${escapeHtml(auditActorName(entry))}</span></td><td><strong>${escapeHtml(auditOperationName(entry))}</strong></td><td>${escapeHtml(auditPluginName(entry))}</td><td><span class="result ${escapeAttr(result)}">${resultNames[result]}</span></td><td>${escapeHtml(auditDescription(entry))}</td></tr>`; }).join('');
  $('#auditEmpty').classList.toggle('hidden', rows.length > 0);
  $('.audit-table-wrap table').classList.toggle('hidden', rows.length === 0);
}

function environmentInlineEditor(environment = null) {
  return `<form class="manager-inline-editor" id="environmentInlineForm" data-environment-editor="${environment ? escapeAttr(environment.environmentId) : 'new'}"><input id="managerEnvironmentName" maxlength="120" autocomplete="off" aria-label="环境名称" placeholder="输入环境名称" value="${escapeAttr(environment?.name ?? '')}"><span class="manager-inline-actions"><button type="button" class="button small" data-cancel-environment-editor>取消</button><button id="saveEnvironment" type="submit" class="button small primary">${environment ? '保存' : '创建'}</button></span></form>`;
}
function environmentManagerActions(item) {
  const prompt = state.environmentDeletePrompt?.environmentId === item.environmentId ? state.environmentDeletePrompt : null;
  if (prompt) return `<span class="manager-delete-prompt ${prompt.confirmable ? '' : 'blocked'}"><span>${escapeHtml(prompt.message)}</span><button class="button small" data-cancel-environment-delete>${prompt.confirmable ? '取消' : '关闭'}</button>${prompt.confirmable ? `<button class="button small danger" data-confirm-delete-environment="${escapeAttr(item.environmentId)}">确认删除</button>` : ''}</span>`;
  return `<span class="manager-actions"><button class="button small" data-edit-environment="${escapeAttr(item.environmentId)}">重命名</button><button class="button small danger" data-delete-environment="${escapeAttr(item.environmentId)}">删除</button></span>`;
}
function renderEnvironmentManager() {
  const project = state.projects.find((item) => item.projectId === state.managedProjectId);
  const environments = state.managedEnvironments;
  if (!project) return;
  $('#environmentManagerDialog').dataset.managedProjectId = project.projectId;
  $('#environmentManagerScope').textContent = `${project.name} · ${environments.length} 个环境`;
  const creating = state.editingEnvironmentId === null ? environmentInlineEditor() : '';
  $('#environmentManagerList').innerHTML = creating + environments.map((item) => state.editingEnvironmentId === item.environmentId ? environmentInlineEditor(item) : `<div class="manager-row" data-managed-environment-id="${escapeAttr(item.environmentId)}"><span><strong>${escapeHtml(item.name)}</strong><small>${item.pluginCount} 个插件</small></span>${environmentManagerActions(item)}</div>`).join('');
  const form = $('#environmentInlineForm');
  form?.addEventListener('submit', (event) => { event.preventDefault(); saveEnvironmentFromManager().catch(showError); });
}
function openEnvironmentManager(projectId = state.projectId, editorId = undefined) {
  if (!projectId) return;
  state.managedProjectId = projectId;
  state.managedEnvironments = state.environmentsByProject[projectId] ?? [];
  state.editingEnvironmentId = editorId;
  state.environmentDeletePrompt = null;
  renderEnvironmentManager();
  if (!$('#environmentManagerDialog').open) $('#environmentManagerDialog').showModal();
  if (editorId !== undefined) requestAnimationFrame(() => { $('#managerEnvironmentName')?.focus(); $('#managerEnvironmentName')?.select(); });
}
function openEnvironmentEditor(id = null) {
  openEnvironmentManager(state.managedProjectId ?? state.projectId,id);
}
async function saveEnvironmentFromManager() {
  const button = $('#saveEnvironment');
  if (!button || button.disabled) return;
  button.disabled = true;
  const editingId = state.editingEnvironmentId;
  const projectId = state.managedProjectId;
  try {
    const name = $('#managerEnvironmentName').value.trim();
    if (!name) throw new Error('请输入环境名称。');
    if (editingId) {
      const environment = state.managedEnvironments.find((item) => item.environmentId === editingId);
      await call(api.updateEnvironment({projectId,environmentId:environment.environmentId,patch:{name},expectedRevision:environment.revision}));
    } else await call(api.createEnvironment({projectId,input:{name}}));
    state.editingEnvironmentId = undefined;
    await refreshWorkspaceOverview({render:false});
    state.managedEnvironments = state.environmentsByProject[projectId] ?? [];
    state.environments = state.environmentsByProject[state.projectId] ?? [];
    renderShell();
    renderEnvironmentManager();
    toast(editingId ? '环境名称已更新。' : '环境已创建。');
  } finally {
    const current = $('#saveEnvironment');
    if (current) current.disabled = false;
  }
}

function resetPluginFormTransition() {
  pluginFormTransitionGeneration += 1;
  clearTimeout(pluginFormTransitionTimer);
  pluginFormTransitionTimer = null;
  const grid = $('#pluginFormGrid');
  grid?.classList.remove('form-switch-out','form-switch-in');
}

function transitionPluginForm(update) {
  const dialog = $('#pluginDialog');
  const grid = $('#pluginFormGrid');
  const body = $('.plugin-dialog-body', dialog);
  if (!dialog.open || !grid || !body || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const generation = ++pluginFormTransitionGeneration;
  clearTimeout(pluginFormTransitionTimer);
  const scrollTop = body.scrollTop;
  grid.classList.remove('form-switch-in');
  grid.classList.add('form-switch-out');
  pluginFormTransitionTimer = setTimeout(() => {
    if (generation !== pluginFormTransitionGeneration) return;
    update();
    body.scrollTop = Math.min(scrollTop,Math.max(0,body.scrollHeight - body.clientHeight));
    grid.classList.remove('form-switch-out');
    void grid.offsetWidth;
    grid.classList.add('form-switch-in');
    pluginFormTransitionTimer = setTimeout(() => {
      if (generation === pluginFormTransitionGeneration) grid.classList.remove('form-switch-in');
    },160);
  },60);
}

function openPluginDialog(plugin = null) {
  resetPluginFormTransition();
  state.editingPlugin = plugin;
  $('#savePlugin').disabled = false;
  state.databaseQueryGeneration += 1;
  const credentialProbeGeneration = ++state.credentialProbeGeneration;
  clearPluginDialogError();
  const type = plugin?.pluginType ?? 'server';
  $('#pluginDialogTitle').textContent = plugin ? '配置插件' : '添加插件';
  $('#pluginDialogScope').textContent = `${activeProject().name} / ${activeEnvironment().name}`;
  $('#pluginType').value = type;
  $$('[name=pluginTypeChoice]').forEach((radio) => { radio.checked = radio.value === type; radio.disabled = Boolean(plugin); });
  $('#pluginDisplayName').value = plugin?.displayName ?? '';
  $('#pluginHost').value = plugin?.target?.host ?? '';
  $('#pluginPort').value = plugin?.target?.port ?? (type === 'server' ? 22 : type === 'mysql' ? 3306 : 6379);
  const database = plugin?.target?.database ?? '';
  $('#pluginDatabase').innerHTML = database ? `<option value="${escapeAttr(database)}">${escapeHtml(database)}</option>` : '<option value="">先填写连接信息并查询</option>';
  $('#pluginDatabase').value = database;
  $('#pluginDatabase').disabled = !database;
  $('#databaseHint').textContent = database ? '当前已保存数据库；连接信息变化后请重新查询' : '只显示当前账号实际可见的普通数据库';
  state.databaseCredentialRevision = 0;
  $('#pluginRedisDb').value = plugin?.target?.db ?? 0;
  $('#pluginUsername').value = plugin?.auth?.username ?? '';
  resetPasswordControl('pluginPassword');
  $('#pluginAddressFamily').value = plugin?.target?.addressFamily ?? 'ipv4Preferred';
  $('#pluginTransport').value = plugin?.transport?.kind ?? 'direct';
  $('#pluginVpnAlias').value = plugin?.transport?.interfaceAlias ?? '';
  $('#pluginAuthType').value = plugin?.auth?.type ?? 'password';
  $('#pluginPrivateKeyPath').value = plugin?.auth?.privateKeyPath ?? '';
  $('#pluginUplink').value = plugin?.uplink?.type ?? 'direct';
  $('#pluginProxyHost').value = plugin?.uplink?.host ?? '';
  $('#pluginProxyPort').value = plugin?.uplink?.port ?? 1080;
  $('#pluginProxyUsername').value = plugin?.uplink?.username ?? '';
  resetPasswordControl('pluginProxyPassword');
  $('#pluginServerVpnAlias').value = plugin?.uplink?.interfaceAlias ?? '';
  $('#pluginTls').value = plugin?.tls?.mode ?? 'disabled';
  renderPluginForm();
  if (plugin?.transport?.serverPluginInstanceId) $('#pluginProvider').value = plugin.transport.serverPluginInstanceId;
  state.databaseDiscoverySignature = plugin?.pluginType === 'mysql' ? databaseConnectionSignature() : null;
  state.pluginFormInitial = pluginFormSignature();
  $('#pluginDialog').showModal();
  loadCredentialIndicators(plugin, credentialProbeGeneration).catch(showPluginDialogError);
}

function clearPluginDialogError() {
  const element = $('#pluginDialogError');
  element.textContent = '';
  element.classList.add('hidden');
}

function showPluginDialogError(error) {
  const element = $('#pluginDialogError');
  element.textContent = error?.message ?? String(error);
  element.classList.remove('hidden');
  element.scrollIntoView({ block:'nearest' });
}

function databaseConnectionSignature() {
  return JSON.stringify({
    host:$('#pluginHost').value.trim(), port:Number($('#pluginPort').value), username:$('#pluginUsername').value.trim(),
    addressFamily:$('#pluginAddressFamily').value, transport:$('#pluginTransport').value,
    provider:$('#pluginProvider').value, vpn:$('#pluginVpnAlias').value.trim(), tls:$('#pluginTls').value,
    credentialRevision:state.databaseCredentialRevision,
  });
}

function pluginFormSignature() {
  const ids = ['pluginType','pluginDisplayName','pluginHost','pluginPort','pluginDatabase','pluginRedisDb','pluginUsername','pluginAddressFamily','pluginTransport','pluginProvider','pluginVpnAlias','pluginAuthType','pluginPrivateKeyPath','pluginUplink','pluginProxyHost','pluginProxyPort','pluginProxyUsername','pluginServerVpnAlias','pluginTls'];
  const values = Object.fromEntries(ids.map((id) => [id,$(`#${id}`).value]));
  values.primaryCredential = $('#pluginPassword').dataset.credentialState === 'edited' ? $('#pluginPassword').value : null;
  values.proxyCredential = $('#pluginProxyPassword').dataset.credentialState === 'edited' ? $('#pluginProxyPassword').value : null;
  return JSON.stringify(values);
}

function pluginFormDirty() {
  return $('#pluginDialog').open && state.pluginFormInitial !== null && pluginFormSignature() !== state.pluginFormInitial;
}

function invalidateDatabaseDiscovery() {
  if ($('#pluginType').value !== 'mysql' || !$('#pluginDialog').open) return;
  if (state.databaseDiscoverySignature === databaseConnectionSignature()) return;
  state.databaseQueryGeneration += 1;
  state.databaseDiscoverySignature = null;
  $('#queryDatabases').disabled = false;
  $('#queryDatabases').textContent = '查询数据库';
  $('#savePlugin').disabled = false;
  $('#pluginDatabase').innerHTML = '<option value="">连接信息已变化，请重新查询</option>';
  $('#pluginDatabase').disabled = true;
  $('#databaseHint').textContent = '数据库列表已失效，请重新查询';
}

async function queryDatabases() {
  const host = $('#pluginHost').value.trim();
  const port = Number($('#pluginPort').value);
  const username = $('#pluginUsername').value.trim();
  if (!host || !port || !username) throw new Error('请先填写主机地址、端口和用户名。');
  if ($('#pluginTransport').value === 'serverTunnel' && !$('#pluginProvider').value) throw new Error('请选择要复用的 Server 隧道。');
  const button = $('#queryDatabases');
  const saveButton = $('#savePlugin');
  const queryGeneration = ++state.databaseQueryGeneration;
  const dialogGeneration = state.credentialProbeGeneration;
  const requestedScope = { projectId:state.projectId, environmentId:state.environmentId, pluginInstanceId:state.editingPlugin?.pluginInstanceId ?? null };
  const requestedSignature = databaseConnectionSignature();
  clearPluginDialogError();
  button.disabled = true;
  saveButton.disabled = true;
  button.textContent = '查询中…';
  try {
    const input = {
      pluginType:'mysql', displayName:$('#pluginDisplayName').value.trim() || 'MySQL 数据库',
      target:{ host, port, database:'', addressFamily:$('#pluginAddressFamily').value },
      auth:{ username }, transport:{ kind:$('#pluginTransport').value }, tls:{ mode:$('#pluginTls').value },
    };
    if (input.transport.kind === 'serverTunnel') input.transport.serverPluginInstanceId = $('#pluginProvider').value;
    if (input.transport.kind === 'windowsVpn') input.transport.interfaceAlias = $('#pluginVpnAlias').value.trim();
    const password = editedPasswordValue('pluginPassword');
    const result = await call(api.listPluginDatabases({
      projectId:requestedScope.projectId, environmentId:requestedScope.environmentId,
      pluginInstanceId:state.editingPlugin?.pluginType === 'mysql' ? requestedScope.pluginInstanceId : null,
      input, secrets:password ? {password} : {},
    }));
    if (queryGeneration !== state.databaseQueryGeneration || dialogGeneration !== state.credentialProbeGeneration || !$('#pluginDialog').open || requestedScope.projectId !== state.projectId || requestedScope.environmentId !== state.environmentId || requestedScope.pluginInstanceId !== (state.editingPlugin?.pluginInstanceId ?? null) || requestedSignature !== databaseConnectionSignature()) return;
    const databases = result.databases ?? [];
    $('#pluginDatabase').innerHTML = databases.length
      ? `<option value="">请选择数据库</option>${databases.map((name) => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('')}`
      : '<option value="">没有可选择的数据库</option>';
    $('#pluginDatabase').disabled = !databases.length;
    const previous = state.editingPlugin?.target?.database;
    if (previous && databases.includes(previous)) $('#pluginDatabase').value = previous;
    else if (databases.length === 1) $('#pluginDatabase').value = databases[0];
    state.databaseDiscoverySignature = requestedSignature;
    $('#databaseHint').textContent = databases.length ? `已查询到 ${databases.length} 个数据库${result.truncated ? '（仅显示前 200 个）' : ''}` : '当前账号没有可见的普通数据库';
  } finally {
    if (queryGeneration === state.databaseQueryGeneration) {
      button.disabled = false;
      saveButton.disabled = false;
      button.textContent = '查询数据库';
    }
  }
}
function renderPluginForm() {
  const type = $('#pluginType').value;
  const data = type !== 'server';
  const authType = $('#pluginAuthType').value;
  $('#databaseField').classList.toggle('hidden', type !== 'mysql');
  $('#redisDbField').classList.toggle('hidden', type !== 'redis');
  $('#transportField').classList.toggle('hidden', !data);
  $('#authTypeField').classList.toggle('hidden', type !== 'server');
  $('#privateKeyField').classList.toggle('hidden', type !== 'server' || authType !== 'privateKey');
  $('#primaryCredentialField').classList.toggle('hidden', type === 'server' && authType === 'agent');
  $('#primaryCredentialLabel').textContent = type === 'server' && authType === 'privateKey' ? '私钥密码（可选）' : '密码';
  $('#uplinkField').classList.toggle('hidden', type !== 'server');
  const proxy = type === 'server' && ['socks5','http'].includes($('#pluginUplink').value);
  ['proxyHostField','proxyPortField','proxyUsernameField','proxyPasswordField'].forEach((id) => $(`#${id}`).classList.toggle('hidden', !proxy));
  $('#serverVpnField').classList.toggle('hidden', type !== 'server' || $('#pluginUplink').value !== 'windowsVpn');
  $('#tlsField').classList.toggle('hidden', !data);
  const tls = $('#pluginTls');
  const currentTls = tls.value;
  tls.innerHTML = '<option value="disabled">关闭</option><option value="preferred">加密（不校验证书）</option><option value="required">必须加密</option><option value="verifyIdentity">加密并校验证书身份</option>';
  tls.value = ['disabled','preferred','required','verifyIdentity'].includes(currentTls) ? currentTls : 'disabled';
  $('#providerField').classList.toggle('hidden', !data || $('#pluginTransport').value !== 'serverTunnel');
  $('#vpnField').classList.toggle('hidden', !data || $('#pluginTransport').value !== 'windowsVpn');
  const selectedProvider = $('#pluginProvider').value;
  $('#pluginProvider').innerHTML = state.plugins.filter((item) => item.pluginType === 'server').map((item) => `<option value="${escapeAttr(item.pluginInstanceId)}">${escapeHtml(item.displayName)}</option>`).join('');
  if (selectedProvider) $('#pluginProvider').value = selectedProvider;
}

async function savePlugin() {
  const type = $('#pluginType').value;
  const input = { pluginType:type, displayName:$('#pluginDisplayName').value.trim(), target:{ host:$('#pluginHost').value.trim(), port:Number($('#pluginPort').value), addressFamily:$('#pluginAddressFamily').value }, auth:{ username:$('#pluginUsername').value.trim() } };
  if (!input.displayName) throw new Error('请填写插件名称。');
  if (type === 'server') {
    input.auth.type = $('#pluginAuthType').value;
    if (input.auth.type === 'privateKey') {
      input.auth.privateKeyPath = $('#pluginPrivateKeyPath').value.trim();
    }
    input.uplink = { type:$('#pluginUplink').value };
    if (['socks5','http'].includes(input.uplink.type)) {
      Object.assign(input.uplink,{host:$('#pluginProxyHost').value.trim(),port:Number($('#pluginProxyPort').value),username:$('#pluginProxyUsername').value.trim()});
    }
    if (input.uplink.type === 'windowsVpn') {
      input.uplink.interfaceAlias = $('#pluginServerVpnAlias').value.trim();
    }
    input.sources = state.editingPlugin?.sources ?? [];
  } else {
    input.transport = { kind:$('#pluginTransport').value };
    if (input.transport.kind === 'serverTunnel') {
      input.transport.serverPluginInstanceId = $('#pluginProvider').value;
    }
    if (input.transport.kind === 'windowsVpn') {
      input.transport.interfaceAlias = $('#pluginVpnAlias').value.trim();
    }
    input.tls = { mode:$('#pluginTls').value };
    if (type === 'mysql') {
      input.target.database = $('#pluginDatabase').value;
    } else input.target.db = Number($('#pluginRedisDb').value);
  }
  const primaryPassword = editedPasswordValue('pluginPassword');
  const proxyPassword = editedPasswordValue('pluginProxyPassword');
  const secrets = primaryPassword ? (type === 'server' && input.auth.type === 'privateKey' ? {privateKeyPassphrase:primaryPassword} : {password:primaryPassword}) : {};
  if (type === 'server' && proxyPassword) secrets.proxyPassword = proxyPassword;
  const scope = { projectId:state.projectId,environmentId:state.environmentId };
  const plugin = state.editingPlugin ? await call(api.updatePlugin({...scope,pluginInstanceId:state.editingPlugin.pluginInstanceId,patch:input,expectedRevision:state.editingPlugin.revision,secrets})) : await call(api.createPlugin({...scope,input,secrets}));
  $('#pluginDialog').close();
  await refreshEnvironmentMetadata();
  await loadEnvironment(plugin.pluginInstanceId);
  toast(plugin.configState === 'ready' ? '插件已保存；不会自动连接。' : '插件草稿已保存；补齐配置后才能连接。');
}

async function environmentAction() {
  const environment = activeEnvironment();
  if (!environment) return;
  const action = currentEnvironmentAction().action;
  await handleEnvironmentRuntimeAction(action,state.projectId,environment.environmentId);
}

function diagnosticScopeName(plugin) {
  if (plugin.pluginType === 'server') return '网络路由、SSH 认证与主机指纹';
  if (plugin.pluginType === 'mysql') return '连接路由、数据库认证与固定数据库';
  return '连接路由、Redis 认证与 PING';
}
function diagnosticRouteName(plugin) { return plugin.pluginType === 'server' ? uplinkName(plugin) : transportName(plugin); }
function diagnosticMarkup(plugin, status, reused = false) {
  const pending = status === 'pending';
  const title = pending ? '正在检查连接' : status === 'success' ? (reused ? '当前已连接' : '连接正常') : '连接检查失败';
  const subtitle = pending ? '等待真实连接结果…' : status === 'success' ? (reused ? '读取当前环境的活动连接状态' : '临时连接检查已完成') : '未通过连接检查';
  const statusIcon = pending ? 'loader' : status === 'success' ? 'check' : 'x';
  return `<div class="diagnostic-state ${status}"><span class="diagnostic-state-icon">${icon(statusIcon)}</span><span><strong>${title}</strong><small>${subtitle}</small></span></div><dl class="diagnostic-facts"><dt>目标</dt><dd>${escapeHtml(pluginTarget(plugin))}</dd><dt>连接方式</dt><dd>${escapeHtml(diagnosticRouteName(plugin))}</dd><dt>${reused ? '结果依据' : '实际检查'}</dt><dd>${escapeHtml(reused ? '当前环境的活动连接状态' : diagnosticScopeName(plugin))}</dd></dl>`;
}
async function testPlugin() {
  const plugin = activePlugin();
  const environment = activeEnvironment();
  $('#diagnosticTitle').textContent = `${plugin.displayName} · 连接检查`;
  $('#diagnosticScope').textContent = `${activeProject().name} / ${environment.name}`;
  $('#diagnosticList').innerHTML = diagnosticMarkup(plugin,'pending');
  $('#diagnosticSummary').className = 'diagnostic-summary';
  $('#diagnosticSummary').textContent = '正在建立临时连接…';
  $('#diagnosticDialog').showModal();
  try {
    const result = await call(api.testPlugin({projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId}));
    $('#diagnosticList').innerHTML = diagnosticMarkup(plugin,'success',Boolean(result.reused));
    $('#diagnosticSummary').className = 'diagnostic-summary success';
    $('#diagnosticSummary').textContent = result.reused ? '复用当前环境连接完成检查，没有新建或断开连接。' : '已建立一次临时连接并立即释放；环境连接状态未改变。';
  } catch (error) {
    $('#diagnosticList').innerHTML = diagnosticMarkup(plugin,'failure');
    $('#diagnosticSummary').className = 'diagnostic-summary failure';
    $('#diagnosticSummary').textContent = error.message;
  }
}

async function openConfirmations() {
  const pending = await call(api.listConfirmations());
  state.pendingCount = pending.length;
  renderConfirmationButton();
  $('#confirmationList').innerHTML = pending.length ? pending.map((item) => {
    const project = state.projects.find((entry) => entry.projectId === item.projectId);
    const environment = state.environments.find((entry) => entry.environmentId === item.environmentId);
    const plugin = state.plugins.find((entry) => entry.pluginInstanceId === item.pluginInstanceId);
    const strong = item.approvalLevel === 'strong';
    const riskName = ({write:'写入',destructive:'破坏性变更',service:'服务变更',critical:'最高风险'})[item.riskLevel] ?? '服务器变更';
    return `<article class="confirmation-row ${strong ? 'critical' : ''}"><div class="confirmation-copy"><span class="confirmation-source">Agent 请求 · ${escapeHtml(item.projectNameSnapshot ?? project?.name ?? '项目')} / ${escapeHtml(item.environmentNameSnapshot ?? environment?.name ?? '环境')}</span><div class="confirmation-title"><strong>${escapeHtml(item.capabilityLabel ?? auditCapabilityName(item.capability))}</strong><span class="risk-badge ${strong ? 'critical' : ''}">${escapeHtml(riskName)}</span></div><p>${escapeHtml(item.summary || '对服务器执行一次变更操作')}</p>${strong ? '<small class="critical-warning">请逐字核对命令；Shell 可以绕过结构化工具的所有保护。</small>' : ''}<small>目标：${escapeHtml(item.pluginNameSnapshot ?? plugin?.displayName ?? '插件')} · 只授权本次操作 · ${escapeHtml(new Date(item.createdAt).toLocaleTimeString())}</small></div><div class="confirmation-actions"><button class="button small" data-reject-confirmation="${escapeAttr(item.requestId)}">拒绝</button><button class="button small ${strong ? 'danger' : 'primary'}" data-approve-confirmation="${escapeAttr(item.requestId)}" data-approval-level="${strong ? 'strong' : 'standard'}">${strong ? '核对后确认' : '确认一次'}</button></div></article>`;
  }).join('') : '<div class="dialog-empty">当前没有等待确认的操作</div>';
  if (!$('#confirmationDialog').open) $('#confirmationDialog').showModal();
}

function renderConfirmationButton() {
  const button = $('#confirmationButton');
  if (!button) return;
  button.classList.toggle('hidden', state.pendingCount === 0);
  $('#confirmationCount').textContent = state.pendingCount;
}

function openEnvironmentSwitcher() {
  $('#environmentSwitcherList').innerHTML = state.environments.map((item) => {
    const runtime = state.runtimeByScope[scopeKey(state.projectId,item.environmentId)];
    const phase = runtimePresentationPhase(runtime);
    const connection = runtime ? environmentStatusText(state.projectId,item) : '未连接';
    return `<button class="switcher-row ${item.environmentId === state.environmentId ? 'active' : ''}" data-environment-id="${escapeAttr(item.environmentId)}"><span class="state-dot ${escapeAttr(phase)}"></span><strong>${escapeHtml(item.name)}</strong><small>${item.pluginCount} 个插件 · ${escapeHtml(connection)}</small></button>`;
  }).join('');
  $('#environmentSwitcherDialog').showModal();
}

function openDeletePlugin(plugin = activePlugin()) {
  if (!plugin) return;
  state.deletingPluginScope = { projectId:plugin.projectId, environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId, displayName:plugin.displayName };
  const dependents = plugin.pluginType === 'server' ? state.plugins.filter((item) => item.transport?.serverPluginInstanceId === plugin.pluginInstanceId) : [];
  $('#deletePluginScope').textContent = `${activeProject().name} / ${activeEnvironment().name}`;
  $('#deletePluginMessage').textContent = `确定删除“${plugin.displayName}”？插件连接配置将被删除；本机保存的凭据会继续保留。`;
  $('#deletePluginBlockers').classList.toggle('hidden', dependents.length === 0);
  $('#deletePluginBlockers').innerHTML = dependents.length ? `<strong>暂时不能删除</strong><p>以下插件正在复用它的隧道：${dependents.map((item) => escapeHtml(item.displayName)).join('、')}</p>` : '';
  $('#confirmDeletePlugin').disabled = dependents.length > 0;
  $('#deletePluginDialog').showModal();
}

function mayLeaveCurrentScope() {
  return !state.runbookEditing || confirm('运维说明尚未保存，确定离开当前环境？');
}

function rememberCurrentScope() {
  if (!state.projectId) return;
  if (state.environmentId) {
    state.projectEnvironmentMemory[state.projectId] = state.environmentId;
    state.scopePluginMemory[scopeKey()] = state.pluginId;
  }
}

function resetScopeUi() {
  state.runbookScopeKey = null;
  state.runbookEditing = false;
  state.mobileDetail = false;
}

async function showProjectOverview(projectId) {
  if (!projectId) return;
  if (state.projectId === projectId && state.projectOverviewActive) return;
  if (!mayLeaveCurrentScope()) return;
  rememberCurrentScope();
  ++state.navigationGeneration;
  state.projectId = projectId;
  state.projectOverviewActive = true;
  state.environmentId = null;
  state.pluginId = null;
  state.environments = state.environmentsByProject[projectId] ?? [];
  state.plugins = [];
  state.runtime = null;
  state.loadedScopeKey = null;
  resetScopeUi();
  renderShell();
}

async function openScope(projectId,environmentId,{ pluginId = null, skipLeaveCheck = false } = {}) {
  if (!projectId || !environmentId || !environmentFor(projectId,environmentId)) return false;
  const requestedScopeKey = scopeKey(projectId,environmentId);
  const sameScope = state.projectId === projectId && state.environmentId === environmentId && !state.projectOverviewActive;
  if (sameScope && state.loadedScopeKey === requestedScopeKey) {
    if (pluginId && state.plugins.some((plugin) => plugin.pluginInstanceId === pluginId)) {
      state.pluginId = pluginId;
      state.scopePluginMemory[scopeKey()] = pluginId;
      renderShell();
    }
    return true;
  }
  if (!sameScope && !skipLeaveCheck && !mayLeaveCurrentScope()) return false;
  const generation = ++state.navigationGeneration;
  if (!sameScope) {
    rememberCurrentScope();
    state.projectId = projectId;
    state.projectOverviewActive = false;
    state.environmentId = environmentId;
    state.pluginId = null;
    state.environments = state.environmentsByProject[projectId] ?? [];
    state.plugins = [];
    state.runtime = environmentRuntime(projectId,environmentId);
    state.loadedScopeKey = null;
    state.projectEnvironmentMemory[projectId] = environmentId;
    resetScopeUi();
    // Switch the visible shell immediately so controls from the previous scope
    // cannot run while the new environment is loading.
    renderShell();
  }
  const preferred = pluginId ?? state.scopePluginMemory[requestedScopeKey];
  const loaded = await loadEnvironment(preferred,{ projectId,environmentId },generation);
  return Boolean(loaded && generation === state.navigationGeneration && state.projectId === projectId && state.environmentId === environmentId && !state.projectOverviewActive);
}

async function switchProject(id) { await showProjectOverview(id); }
async function switchEnvironment(id) { await openScope(state.projectId,id); }

async function handleEnvironmentRuntimeAction(action,projectId,environmentId) {
  const environment = environmentFor(projectId,environmentId);
  if (!environment) throw new Error('目标环境已经不存在，请刷新后重试。');
  if (action === 'configure') {
    const opened = await openScope(projectId,environmentId);
    if (!opened || state.projectId !== projectId || state.environmentId !== environmentId || state.projectOverviewActive) return;
    const incomplete = state.plugins.find((plugin) => plugin.configState !== 'ready');
    if (incomplete) {
      state.pluginId = incomplete.pluginInstanceId;
      state.scopePluginMemory[scopeKey()] = state.pluginId;
      renderPlugins();
      openPluginDialog(incomplete);
    } else openPluginDialog();
    return;
  }
  const scope = { projectId,environmentId };
  let runtime;
  if (action === 'cancel') runtime = await call(api.cancelEnvironment(scope));
  else if (action === 'disconnect') runtime = await call(api.disconnectEnvironment(scope));
  else if (action === 'retry') runtime = await call(api.retryEnvironment(scope));
  else if (action === 'connect') {
    try {
      runtime = await call(api.connectEnvironment({...scope,expectedRevision:environment.revision}));
    } catch (error) {
      if (error.code !== 'CONFIG_REVISION_CONFLICT') throw error;
      await refreshWorkspaceOverview({render:false});
      const current = environmentFor(projectId,environmentId);
      runtime = await call(api.connectEnvironment({...scope,expectedRevision:current.revision}));
    }
  } else return;
  state.runtimeByScope[scopeKey(projectId,environmentId)] = runtime;
  if (projectId === state.projectId && environmentId === state.environmentId && !state.projectOverviewActive) state.runtime = runtime;
  renderShell();
}

async function handleOverviewPluginRuntimeAction(action,projectId,environmentId,pluginInstanceId) {
  const environment = environmentFor(projectId,environmentId);
  const resource = environment?.resourcePreview?.find((item) => item.pluginInstanceId === pluginInstanceId);
  if (!environment || !resource) throw new Error('目标资源已经不存在，请刷新后重试。');
  const scope = { projectId,environmentId,pluginInstanceId };
  const runtime = action === 'disconnect'
    ? await call(api.disconnectPlugin(scope))
    : await call(api.connectPlugin(scope));
  state.runtimeByScope[scopeKey(projectId,environmentId)] = runtime;
  if (state.projectId === projectId && state.environmentId === environmentId && !state.projectOverviewActive) state.runtime = runtime;
  renderShell();
  const phase = runtime.plugins?.[pluginInstanceId]?.phase ?? 'disconnected';
  if (action === 'disconnect') toast(`${resource.displayName}已断开。`);
  else toast(`${resource.displayName}：${phase === 'connected' ? '已连接' : '连接失败'}`,phase !== 'connected');
  loadProjectOverviewActivity(projectId,{force:true}).catch(() => undefined);
}

function sameOrder(left,right) {
  return left.length === right.length && left.every((value,index) => value === right[index]);
}

function moveBeforeOrAfter(ids,sourceId,targetId,after) {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return [...ids];
  const next = ids.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (after ? 1 : 0),0,sourceId);
  return next;
}

function clearDragClasses() {
  $$('.sort-dragging,.sort-drop-before,.sort-drop-after').forEach((item) => item.classList.remove('sort-dragging','sort-drop-before','sort-drop-after'));
}

function finishRailDrag() {
  const completedDrag = Boolean(state.dragSort);
  state.dragSort = null;
  if (completedDrag) {
    // Suppress only the click synthesized by the browser for this drag gesture.
    // A time window also swallowed a genuine click made immediately after sorting.
    state.suppressRailClickUntil = Number.POSITIVE_INFINITY;
    setTimeout(() => {
      state.suppressRailClickUntil = 0;
    }, 0);
  }
  clearDragClasses();
  if (state.railRefreshPending && !state.sortSaving) {
    state.railRefreshPending = false;
    renderProjects();
    if (state.projectOverviewActive) renderProjectOverview();
    else if (state.environmentId) {
      renderRuntime();
      if (state.view === 'plugins') renderPlugins();
    }
  }
}

async function persistEnvironmentOrder(projectId,original,next) {
  state.sortSaving = true;
  // Invalidate overview requests that started before this order was committed.
  ++state.workspaceOverviewGeneration;
  try {
    const project = state.projects.find((item) => item.projectId === projectId);
    const value = await call(api.reorderEnvironments({projectId,environmentIds:next,expectedRevision:project?.revision ?? null}));
    if (value?.projectId === projectId && project) Object.assign(project,value);
    $('#projectSortLive').textContent = '环境顺序已保存';
  } catch (error) {
    let authoritativeRestored = false;
    try {
      authoritativeRestored = await refreshWorkspaceOverview({render:false});
    } catch {}
    if (!authoritativeRestored) {
      const current = state.environmentsByProject[projectId] ?? [];
      const byId = new Map(current.map((item) => [item.environmentId,item]));
      const unknown = current.map((item) => item.environmentId).filter((id) => !original.includes(id));
      state.environmentsByProject[projectId] = [...original,...unknown].map((id) => byId.get(id)).filter(Boolean);
      if (projectId === state.projectId) state.environments = state.environmentsByProject[projectId];
    }
    renderShell();
    toast(`${error.message}，已恢复原顺序。`,true);
  } finally {
    state.sortSaving = false;
    if (state.railRefreshPending) {
      state.railRefreshPending = false;
      refreshWorkspaceOverview().catch(showError);
    }
  }
}

document.addEventListener('dragstart',(event) => {
  if (state.sortSaving) { event.preventDefault(); return; }
  const projectButton = event.target.closest('.rail-button[data-project-id][draggable="true"]');
  if (!projectButton) return;
  state.dragSort = {kind:'project',id:projectButton.dataset.projectId,original:[...state.projectOrder]};
  projectButton.closest('.project-tree-item')?.classList.add('sort-dragging');
  state.suppressRailClickUntil = Number.POSITIVE_INFINITY;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain',`${state.dragSort.kind}:${state.dragSort.id}`);
  }
});

document.addEventListener('dragover',(event) => {
  const drag = state.dragSort;
  if (!drag) return;
  const target = event.target.closest('.project-tree-item');
  if (!target) return;
  event.preventDefault();
  clearDragClasses();
  const sourceSelector = `.project-tree-item[data-tree-project="${CSS.escape(drag.id)}"]`;
  $(sourceSelector)?.classList.add('sort-dragging');
  const rect = target.getBoundingClientRect();
  target.classList.add(event.clientY > rect.top + rect.height / 2 ? 'sort-drop-after' : 'sort-drop-before');
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
});

document.addEventListener('drop',(event) => {
  const drag = state.dragSort;
  if (!drag) return;
  try {
    const target = event.target.closest('.project-tree-item');
    if (!target) return;
    event.preventDefault();
    const targetId = target.dataset.treeProject;
    const after = target.classList.contains('sort-drop-after');
    const next = moveBeforeOrAfter(state.projectOrder,drag.id,targetId,after);
    if (!sameOrder(next,state.projectOrder)) {
      const previousOrder = [...state.projectOrder];
      const previousProjects = [...state.projects];
      try {
        localStorage.setItem(PROJECT_ORDER_KEY,JSON.stringify(next));
        state.projectOrder = next;
        const byId = new Map(state.projects.map((item) => [item.projectId,item]));
        state.projects = next.map((id) => byId.get(id)).filter(Boolean);
        $('#projectSortLive').textContent = '项目顺序已保存';
        renderProjects();
      } catch (error) {
        state.projectOrder = previousOrder;
        state.projects = previousProjects;
        try { localStorage.setItem(PROJECT_ORDER_KEY,JSON.stringify(previousOrder)); } catch {}
        renderProjects();
        toast(`${error?.message ?? '项目顺序保存失败'}，已恢复原顺序。`,true);
      }
    }
  } finally {
    finishRailDrag();
  }
});

document.addEventListener('dragend',finishRailDrag);

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (Date.now() < state.suppressRailClickUntil && target.closest('.rail-button')) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (target.dataset.passwordTarget) { await togglePasswordVisibility(target); return; }
    if (target.dataset.overviewPluginAction) {
      target.disabled = true;
      try {
        await handleOverviewPluginRuntimeAction(target.dataset.overviewPluginAction,target.dataset.overviewProjectId,target.dataset.overviewEnvironmentId,target.dataset.overviewPluginId);
      } finally {
        if (target.isConnected) target.disabled = false;
      }
      return;
    }
    if ('refreshOverviewActivity' in target.dataset) {
      if (state.projectId && state.projectOverviewActive) await loadProjectOverviewActivity(state.projectId,{force:true});
      return;
    }
    if (target.dataset.close) {
      if (target.dataset.close === 'pluginDialog' && pluginFormDirty() && !confirm('插件配置尚未保存，确定放弃更改？')) return;
      $(`#${target.dataset.close}`).close();
      return;
    }
    if (target.dataset.projectSettings) { openProjectSettings(target.dataset.projectSettings); return; }
    if (target.dataset.manageProjectId) { openEnvironmentManager(target.dataset.manageProjectId); return; }
    if (target.dataset.overviewRenameEnvironment) {
      state.overviewEnvironmentDeletePrompt = null;
      state.overviewEditingProjectId = state.projectId;
      state.overviewEditingEnvironmentId = target.dataset.overviewRenameEnvironment;
      renderProjectOverview();
      requestAnimationFrame(() => { const input = $('.environment-card-editor input'); input?.focus(); input?.select(); });
      return;
    }
    if (target.hasAttribute('data-overview-cancel-environment-edit')) {
      state.overviewEditingProjectId = null;
      state.overviewEditingEnvironmentId = null;
      renderProjectOverview();
      return;
    }
    if (target.dataset.overviewDeleteEnvironment) {
      const projectId = target.dataset.overviewProjectId;
      const environments = state.environmentsByProject[projectId] ?? [];
      const environment = environments.find((item) => item.environmentId === target.dataset.overviewDeleteEnvironment);
      if (!environment) return;
      let message = `确定删除“${environment.name}”？`;
      let confirmable = true;
      if (environments.length <= 1) { message = '项目至少需要保留一个环境'; confirmable = false; }
      else if (environment.pluginCount) { message = `请先处理该环境的 ${environment.pluginCount} 个插件`; confirmable = false; }
      const runtime = state.runtimeByScope[scopeKey(projectId,environment.environmentId)];
      if (confirmable && (runtime?.desiredConnected || (runtime && runtime.phase !== 'disconnected'))) { message = '请先断开该环境'; confirmable = false; }
      state.overviewEditingProjectId = null;
      state.overviewEditingEnvironmentId = null;
      state.overviewEnvironmentDeletePrompt = {projectId,environmentId:environment.environmentId,message,confirmable};
      renderProjectOverview();
      return;
    }
    if (target.hasAttribute('data-overview-cancel-environment-delete')) {
      state.overviewEnvironmentDeletePrompt = null;
      renderProjectOverview();
      return;
    }
    if (target.dataset.overviewConfirmDeleteEnvironment) {
      const projectId = target.dataset.overviewProjectId;
      const environmentId = target.dataset.overviewConfirmDeleteEnvironment;
      const environments = state.environmentsByProject[projectId] ?? [];
      const environment = environments.find((item) => item.environmentId === environmentId);
      const prompt = state.overviewEnvironmentDeletePrompt;
      if (!environment || prompt?.projectId !== projectId || prompt?.environmentId !== environmentId || !prompt.confirmable) return;
      const index = environments.findIndex((item) => item.environmentId === environmentId);
      const nextEnvironmentId = environments[index + 1]?.environmentId ?? environments[index - 1]?.environmentId ?? null;
      const deletingCurrent = projectId === state.projectId && environmentId === state.environmentId;
      if (deletingCurrent && !mayLeaveCurrentScope()) return;
      try {
        await call(api.deleteEnvironment({projectId,environmentId}));
        state.overviewEnvironmentDeletePrompt = null;
        await refreshWorkspaceOverview({render:false});
        state.environments = state.environmentsByProject[state.projectId] ?? [];
        if (deletingCurrent) {
          state.environmentId = nextEnvironmentId;
          if (nextEnvironmentId) state.projectEnvironmentMemory[projectId] = nextEnvironmentId;
        }
        renderShell();
        toast(`“${environment.name}”已删除。`);
      } catch (error) {
        state.overviewEnvironmentDeletePrompt = {projectId,environmentId,message:error?.message ?? '删除失败',confirmable:false};
        renderProjectOverview();
      }
      return;
    }
    if (target.hasAttribute('data-overview-add-resource')) {
      await openScope(target.dataset.overviewProjectId,target.dataset.overviewEnvironmentId);
      openPluginDialog();
      return;
    }
    if (target.dataset.environmentRuntimeAction) {
      target.disabled = true;
      try {
        await handleEnvironmentRuntimeAction(target.dataset.environmentRuntimeAction,target.dataset.actionProjectId,target.dataset.actionEnvironmentId);
      } finally {
        if (target.isConnected) target.disabled = false;
      }
      return;
    }
    if (target.dataset.overviewPlugin) {
      await openScope(target.dataset.overviewProjectId,target.dataset.overviewEnvironmentId,{pluginId:target.dataset.overviewPlugin});
      return;
    }
    if (target.dataset.overviewEnter) { await openScope(target.dataset.overviewProjectId,target.dataset.overviewEnter); return; }
    if (target.dataset.overviewComplete) {
      await handleEnvironmentRuntimeAction('configure',target.dataset.overviewProjectId,target.dataset.overviewComplete);
      return;
    }
    if (target.dataset.overviewRuntime) {
      target.disabled = true;
      try {
        await handleEnvironmentRuntimeAction(target.dataset.overviewRuntime,target.dataset.overviewProjectId,target.dataset.runtimeEnvironmentId);
      } finally {
        if (target.isConnected) target.disabled = false;
      }
      return;
    }
    if (target.dataset.projectId) { await switchProject(target.dataset.projectId); return; }
    if (target.dataset.environmentId) { await switchEnvironment(target.dataset.environmentId); if ($('#environmentSwitcherDialog').open) $('#environmentSwitcherDialog').close(); return; }
    if (target.dataset.pluginId) { state.pluginId = target.dataset.pluginId; state.mobileDetail = true; state.scopePluginMemory[scopeKey()] = state.pluginId; renderPlugins(); return; }
    if (target.dataset.view) { if (state.runbookEditing && target.dataset.view !== 'runbook' && !confirm('运维说明尚未保存，确定离开？')) return; state.view = target.dataset.view; renderView(); return; }
    if (target.dataset.detailTab) { const plugin = activePlugin(); state.detailTabs[plugin.pluginInstanceId] = target.dataset.detailTab; renderPluginDetail(); return; }
    if (target.dataset.editEnvironment) { openEnvironmentEditor(target.dataset.editEnvironment); return; }
    if (target.hasAttribute('data-cancel-environment-editor')) { state.editingEnvironmentId = undefined; renderEnvironmentManager(); return; }
    if (target.hasAttribute('data-cancel-environment-delete')) { state.environmentDeletePrompt = null; renderEnvironmentManager(); return; }
    if (target.dataset.deleteEnvironment) {
      const projectId = state.managedProjectId;
      const environments = state.managedEnvironments;
      const environment = environments.find((item) => item.environmentId === target.dataset.deleteEnvironment);
      if (!environment) return;
      let message = `确定删除“${environment.name}”？`;
      let confirmable = true;
      if (environments.length <= 1) { message = '项目至少需要保留一个环境'; confirmable = false; }
      else if (environment.pluginCount) { message = `请先处理该环境的 ${environment.pluginCount} 个插件`; confirmable = false; }
      const runtime = state.runtimeByScope[scopeKey(projectId,environment?.environmentId)];
      if (confirmable && (runtime?.desiredConnected || (runtime && runtime.phase !== 'disconnected'))) { message = '请先断开该环境'; confirmable = false; }
      state.environmentDeletePrompt = { projectId,environmentId:environment.environmentId,message,confirmable };
      renderEnvironmentManager();
      return;
    }
    if (target.dataset.confirmDeleteEnvironment) {
      const projectId = state.managedProjectId;
      const environmentId = target.dataset.confirmDeleteEnvironment;
      const environments = state.managedEnvironments;
      const environment = environments.find((item) => item.environmentId === environmentId);
      if (!environment || state.environmentDeletePrompt?.projectId !== projectId || state.environmentDeletePrompt?.environmentId !== environmentId || !state.environmentDeletePrompt.confirmable) return;
      const index = environments.findIndex((item) => item.environmentId === environmentId);
      const nextEnvironmentId = environments[index + 1]?.environmentId ?? environments[index - 1]?.environmentId ?? null;
      const deletingCurrent = projectId === state.projectId && environmentId === state.environmentId;
      if (deletingCurrent && !mayLeaveCurrentScope()) return;
      try {
        await call(api.deleteEnvironment({projectId,environmentId}));
        state.environmentDeletePrompt = null;
        await refreshWorkspaceOverview({render:false});
        state.managedEnvironments = state.environmentsByProject[projectId] ?? [];
        state.environments = state.environmentsByProject[state.projectId] ?? [];
        if (deletingCurrent && nextEnvironmentId) await openScope(projectId,nextEnvironmentId,{skipLeaveCheck:true});
        else renderShell();
        renderEnvironmentManager();
      } catch (error) {
        state.environmentDeletePrompt = { projectId,environmentId,message:error?.message ?? '删除失败',confirmable:false };
        renderEnvironmentManager();
      }
      return;
    }
    if (target.dataset.approveConfirmation) {
      if (target.dataset.approvalLevel === 'strong' && !window.confirm('这是任意 Shell 命令，可能修改或删除数据、停止服务。确认已经逐字核对并仅授权本次执行？')) return;
      await call(api.approveConfirmation(target.dataset.approveConfirmation)); await openConfirmations(); toast('已确认一次。'); return;
    }
    if (target.dataset.rejectConfirmation) { await call(api.rejectConfirmation(target.dataset.rejectConfirmation)); await openConfirmations(); toast('操作已拒绝。'); return; }
    if (target.dataset.action === 'new-project') { $('#projectName').value=''; $('#firstEnvironmentName').value=''; $('#projectDialog').showModal(); return; }
    if (target.dataset.action === 'add-plugin') { openPluginDialog(); return; }
    if (target.dataset.action === 'mobile-plugin-list') { state.mobileDetail = false; renderPlugins(); return; }
    if (target.dataset.action === 'edit-plugin') { openPluginDialog(activePlugin()); return; }
    if (target.dataset.action === 'prepare-delete-plugin') { openDeletePlugin(); return; }
    if (target.dataset.action === 'test-plugin') { await testPlugin(); return; }
    if (target.dataset.action === 'connect-plugin') {
      const plugin = activePlugin();
      state.runtime = await call(api.connectPlugin({projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId}));
      renderShell();
      toast(`${plugin.displayName}：${pluginRuntime(plugin.pluginInstanceId).phase === 'connected' ? '已连接' : '连接失败'}`);
      return;
    }
    if (target.dataset.action === 'disconnect-plugin') {
      const plugin = activePlugin();
      state.runtime = await call(api.disconnectPlugin({projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId}));
      renderShell();
      toast(`${plugin.displayName}已断开。`);
      return;
    }
    if (target.dataset.action === 'trust-host') {
      const plugin = activePlugin();
      const fingerprint = pluginRuntime(plugin.pluginInstanceId).error?.details?.fingerprint;
      if (!fingerprint) throw new Error('没有可确认的服务器指纹。');
      const value = await call(api.updatePlugin({projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId,patch:{target:{...plugin.target,hostKeyFingerprint:fingerprint}},expectedRevision:plugin.revision}));
      Object.assign(plugin,value);
      state.runtime = await call(api.retryEnvironment({projectId:state.projectId,environmentId:state.environmentId,secretsByPlugin:{[plugin.pluginInstanceId]:{acceptHostKey:fingerprint}}}));
      renderShell();
      return;
    }
  } catch (error) { if ($('#pluginDialog').open) showPluginDialogError(error); else showError(error); }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.matches('[name=pluginTypeChoice]')) {
    const type = target.value;
    transitionPluginForm(() => {
      $('#pluginType').value = type;
      $('#pluginPort').value = type === 'server' ? 22 : type === 'mysql' ? 3306 : 6379;
      renderPluginForm();
    });
  }
});

$('#createProjectButton').addEventListener('click', () => { $('#projectName').value=''; $('#firstEnvironmentName').value=''; $('#projectDialog').showModal(); });
$('#toggleProjectRail').addEventListener('click', () => {
  state.projectRailExpanded = !state.projectRailExpanded;
  try { localStorage.setItem('ai-ops-project-rail-expanded', state.projectRailExpanded ? '1' : '0'); } catch {}
  animateProjectRailLayout(renderProjectRailState);
});
{
  const app = $('#app');
  const rail = $('.project-rail');
  const handle = $('#projectRailResizeHandle');
  let resize = null;

  const saveWidth = () => {
    try { localStorage.setItem(PROJECT_RAIL_WIDTH_KEY,String(Math.round(state.projectRailWidth))); } catch {}
  };
  const finishResize = (event) => {
    if (!resize || (event?.pointerId !== undefined && event.pointerId !== resize.pointerId)) return;
    const pointerId = resize.pointerId;
    resize = null;
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    app.classList.remove('rail-resizing');
    document.documentElement.classList.remove('rail-resizing');
    saveWidth();
  };

  handle.addEventListener('pointerdown', (event) => {
    if (!state.projectRailExpanded || event.button !== 0) return;
    event.preventDefault();
    resize = { pointerId:event.pointerId, startX:event.clientX, startWidth:rail.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    app.classList.add('rail-resizing');
    document.documentElement.classList.add('rail-resizing');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    state.projectRailWidth = applyProjectRailWidth(resize.startWidth + event.clientX - resize.startX);
  });
  handle.addEventListener('pointerup', finishResize);
  handle.addEventListener('pointercancel', finishResize);
  handle.addEventListener('lostpointercapture', finishResize);
  handle.addEventListener('dblclick', () => {
    if (!state.projectRailExpanded) return;
    state.projectRailWidth = PROJECT_RAIL_DEFAULT_WIDTH;
    applyProjectRailWidth();
    saveWidth();
  });
  handle.addEventListener('keydown', (event) => {
    const { min, max } = projectRailWidthBounds();
    const currentWidth = rail.getBoundingClientRect().width;
    let next = null;
    if (event.key === 'ArrowLeft') next = currentWidth - (event.shiftKey ? 32 : 8);
    if (event.key === 'ArrowRight') next = currentWidth + (event.shiftKey ? 32 : 8);
    if (event.key === 'Home') next = min;
    if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    state.projectRailWidth = applyProjectRailWidth(next);
    saveWidth();
  });
}
$('#moreEnvironments').addEventListener('click', openEnvironmentSwitcher);
$('#confirmationButton').addEventListener('click', () => openConfirmations().catch(showError));
$('#managerAddEnvironment').addEventListener('click', () => openEnvironmentEditor());
$('#overviewAddEnvironment').addEventListener('click', () => openEnvironmentManager(state.projectId,null));
$('#addPlugin').addEventListener('click', () => openPluginDialog());
$('#pluginAuthType').addEventListener('change', () => {
  const plugin = state.editingPlugin;
  const authType = $('#pluginAuthType').value;
  transitionPluginForm(() => {
    resetPasswordControl('pluginPassword');
    renderPluginForm();
    if (plugin?.pluginType === 'server' && plugin.auth?.type === authType) {
      const generation = ++state.credentialProbeGeneration;
      loadCredentialIndicators(plugin, generation).catch(showPluginDialogError);
    }
  });
});
$('#pluginTransport').addEventListener('change', () => transitionPluginForm(renderPluginForm));
$('#pluginUplink').addEventListener('change', () => transitionPluginForm(renderPluginForm));
$('#queryDatabases').addEventListener('click', () => queryDatabases().catch(showPluginDialogError));
['pluginHost','pluginPort','pluginUsername','pluginAddressFamily','pluginTransport','pluginProvider','pluginVpnAlias','pluginTls'].forEach((id) => {
  $(`#${id}`).addEventListener(id === 'pluginHost' || id === 'pluginUsername' || id === 'pluginVpnAlias' ? 'input' : 'change', invalidateDatabaseDiscovery);
});
['pluginPassword','pluginProxyPassword'].forEach((id) => {
  const input = $(`#${id}`);
  input.addEventListener('beforeinput', () => {
    if (input.dataset.credentialState === 'stored') {
      input.value = '';
      input.dataset.credentialState = 'edited';
    }
  });
  input.addEventListener('input', () => {
    input.dataset.credentialState = 'edited';
    updatePasswordToggle(id);
    if (id === 'pluginPassword') {
      state.databaseCredentialRevision += 1;
      invalidateDatabaseDiscovery();
    }
  });
});
$('#environmentAction').addEventListener('click', () => environmentAction().catch(showError));
$('#environmentDisconnect').addEventListener('click', () => handleEnvironmentRuntimeAction('disconnect',state.projectId,state.environmentId).catch(showError));

$('#saveProject').addEventListener('click', async (event) => {
  event.preventDefault();
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  try {
    const name = $('#projectName').value.trim();
    const environmentName = $('#firstEnvironmentName').value.trim();
    if (!name || !environmentName) throw new Error('请填写项目名称和第一个环境。');
    const project = await call(api.createProject({name,environmentName}));
    $('#projectDialog').close();
    state.projectOverviewActive = true;
    await loadProjects(project.projectId);
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});

$('#saveProjectSettings').addEventListener('click', async (event) => {
  event.preventDefault();
  const button = event.currentTarget;
  const project = state.projects.find((item) => item.projectId === state.managingProjectId);
  if (!project || button.disabled) return;
  button.disabled = true;
  try {
    const name = $('#projectSettingsName').value.trim();
    if (!name) throw new Error('请填写项目名称。');
    const value = await call(api.updateProject({projectId:project.projectId,patch:{name},expectedRevision:project.revision}));
    Object.assign(project,value);
    $('#projectSettingsDialog').close();
    renderShell();
    toast('项目名称已更新。');
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});

$('#prepareDeleteProject').addEventListener('click', openDeleteProject);
$('#deleteProjectConfirmation').addEventListener('input', () => {
  const project = state.projects.find((item) => item.projectId === state.managingProjectId);
  $('#confirmDeleteProject').disabled = !project || $('#deleteProjectConfirmation').value.trim() !== project.name;
});
$('#confirmDeleteProject').addEventListener('click', async () => {
  const project = state.projects.find((item) => item.projectId === state.managingProjectId);
  const button = $('#confirmDeleteProject');
  if (!project || button.disabled || $('#deleteProjectConfirmation').value.trim() !== project.name) return;
  if (project.projectId === state.projectId && !mayLeaveCurrentScope()) return;
  button.disabled = true;
  try {
    await call(api.deleteProject({projectId:project.projectId}));
    $('#deleteProjectDialog').close();
    $('#projectSettingsDialog').close();
    delete state.environmentsByProject[project.projectId];
    for (const key of Object.keys(state.runtimeByScope)) if (key.startsWith(`${project.projectId}/`)) delete state.runtimeByScope[key];
    state.projectOrder = state.projectOrder.filter((id) => id !== project.projectId);
    try { localStorage.setItem(PROJECT_ORDER_KEY,JSON.stringify(state.projectOrder)); } catch {}
    state.projectOverviewActive = true;
    state.environmentId = null;
    state.pluginId = null;
    state.loadedScopeKey = null;
    await loadProjects(null);
    toast(`“${project.name}”已删除。`);
  } catch (error) {
    showError(error);
    button.disabled = false;
  }
});

$('#savePlugin').addEventListener('click', async (event) => {
  event.preventDefault();
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  clearPluginDialogError();
  try { await savePlugin(); } catch (error) { showPluginDialogError(error); }
  finally { if ($('#pluginDialog').open) button.disabled = false; }
});
$('#confirmDeletePlugin').addEventListener('click', async () => {
  const scope = state.deletingPluginScope;
  if (!scope) { $('#deletePluginDialog').close(); return; }
  try {
    await call(api.deletePlugin(scope));
    $('#deletePluginDialog').close();
    await refreshEnvironmentMetadata();
    await loadEnvironment();
    toast(`“${scope.displayName}”已删除。`);
  } catch (error) { showError(error); }
});
$('#projectDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#saveProject').click(); });
$('#projectSettingsDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#saveProjectSettings').click(); });
$('#pluginDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#savePlugin').click(); });
$('#pluginDialog').addEventListener('close', resetPluginFormTransition);
$('#editRunbook').addEventListener('click', () => { state.runbookEditing = true; renderRunbook(); $('#runbookEditor').focus(); });
$('#runbookEditor').addEventListener('input', () => {
  const bytes = new TextEncoder().encode($('#runbookEditor').value).length;
  $('#runbookBytes').textContent = `${bytes.toLocaleString()} / 65,536 字节`;
  $('#runbookBytes').classList.toggle('error-text', bytes > 65_536);
  $('#saveRunbook').disabled = bytes > 65_536;
});
$('#cancelRunbook').addEventListener('click', () => { state.runbookEditing = false; $('#runbookEditor').value = state.runbookContent; renderRunbook(); });
$('#saveRunbook').addEventListener('click', async () => {
  try {
    const content = $('#runbookEditor').value;
    if (new TextEncoder().encode(content).length > 65_536) throw new Error('运维说明不能超过 64 KiB。');
    const requestedScope = { projectId:state.projectId, environmentId:state.environmentId };
    const environment = activeEnvironment();
    const value = await call(api.saveRunbook({...requestedScope,content,expectedRevision:environment.revision}));
    if (requestedScope.projectId !== state.projectId || requestedScope.environmentId !== state.environmentId) return;
    Object.assign(environment,value.environment);
    state.runbookContent = content;
    state.runbookRevision = value.environment.revision;
    state.runbookEditing = false;
    renderRunbook();
    toast('运维说明已保存。');
  } catch (error) { showError(error); }
});
$('#refreshAudit').addEventListener('click', () => loadAudit().catch(showError));
$('#auditSearch').addEventListener('input', renderAudit);
$('#auditResult').addEventListener('change', renderAudit);
$('#toast').addEventListener('click', () => { if ($('#toast').dataset.action === 'confirmations') openConfirmations().catch(showError); });

window.addEventListener('online', () => api.notifyNetworkChanged());
window.addEventListener('offline', () => api.notifyNetworkChanged());
window.addEventListener('resize', () => applyProjectRailWidth());
api.onEnvironmentStatus((runtime) => {
  state.runtimeByScope[scopeKey(runtime.projectId,runtime.environmentId)] = runtime;
  const currentScope = runtime.projectId === state.projectId && runtime.environmentId === state.environmentId && !state.projectOverviewActive;
  if (currentScope) state.runtime = runtime;
  if (state.dragSort || state.sortSaving) {
    state.railRefreshPending = true;
    if (currentScope) {
      renderRuntime();
      if (state.view === 'plugins') renderPlugins();
    }
    return;
  }
  renderProjects();
  if (runtime.projectId === state.projectId && state.projectOverviewActive) renderProjectOverview();
  if (currentScope) {
    renderRuntime();
    if (state.view === 'plugins') renderPlugins();
  }
});
api.onWorkspaceChanged((change) => {
  if (change.projectId === state.projectOverviewActivityProjectId) {
    ++state.projectOverviewActivityGeneration;
    state.projectOverviewActivityProjectId = null;
    state.projectOverviewActivityEntries = [];
    state.projectOverviewActivityLoading = false;
  }
  refreshWorkspaceOverview({render:false}).then(async () => {
    if ($('#environmentManagerDialog').open && state.managedProjectId === change.projectId) {
      state.managedEnvironments = state.environmentsByProject[change.projectId] ?? [];
      renderEnvironmentManager();
    }
    if (change.projectId === state.projectId && change.environmentId === state.environmentId && !state.projectOverviewActive) {
      await loadEnvironment(change.pluginInstanceId);
      toast(`Agent 已添加插件：${change.pluginName}`);
      return;
    }
    if (state.dragSort || state.sortSaving) state.railRefreshPending = true;
    else {
      renderProjects();
      if (change.projectId === state.projectId && state.projectOverviewActive) renderProjectOverview();
    }
  }).catch(showError);
});
api.onConfirmations((pending) => { state.pendingCount = pending.length; renderConfirmationButton(); if ($('#confirmationDialog').open) openConfirmations().catch(showError); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const openDialogs = $$('dialog[open]');
  const open = openDialogs[openDialogs.length - 1];
  if (!open) return;
  event.preventDefault();
  if (open.id === 'pluginDialog' && pluginFormDirty() && !confirm('插件配置尚未保存，确定放弃更改？')) return;
  open.close();
});

loadProjects().catch(showError);
