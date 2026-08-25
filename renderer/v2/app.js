import { pluginConnectionViewModel } from './connection-view-model.js';
import { pluginCatalog, pluginDefinition, pluginTypeIcons, pluginTypeNames } from './plugin-catalog.js';
import {
  buildQuickQuestionPreview,
  normalizeQuickQuestionOpening,
  normalizeQuickQuestionResponse,
  quickQuestionHasStrictCredential,
  quickQuestionOpeningIssue,
} from './quick-questions.js';

const api = window.aiOps.v2;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name, className = 'icon') => `<svg class="${className}"><use href="#i-${name}"/></svg>`;
const PROJECT_ORDER_KEY = 'ai-ops-project-order-v1';
const PROJECT_RAIL_WIDTH_KEY = 'ai-ops-project-rail-width-v2';
const PROJECT_RAIL_DEFAULT_WIDTH = 260;
const PROJECT_RAIL_MIN_WIDTH = 220;
const PROJECT_RAIL_MAX_WIDTH = 340;
const RESOURCE_PANE_WIDTH_KEY = 'ai-ops-resource-pane-width-v1';
const RESOURCE_PANE_DEFAULT_WIDTH = 420;
const RESOURCE_PANE_MIN_WIDTH = 340;
const RESOURCE_PANE_MAX_WIDTH = 560;
const CONFIRMATION_EXECUTION_CACHE_LIMIT = 100;

function storedProjectRailWidth() {
  try {
    const value = Number(localStorage.getItem(PROJECT_RAIL_WIDTH_KEY));
    return Number.isFinite(value) && value > 0
      ? Math.min(PROJECT_RAIL_MAX_WIDTH,Math.max(PROJECT_RAIL_MIN_WIDTH,value))
      : PROJECT_RAIL_DEFAULT_WIDTH;
  } catch { return PROJECT_RAIL_DEFAULT_WIDTH; }
}

function storedResourcePaneWidth() {
  try {
    const value = Number(localStorage.getItem(RESOURCE_PANE_WIDTH_KEY));
    return Number.isFinite(value) && value > 0
      ? Math.min(RESOURCE_PANE_MAX_WIDTH,Math.max(RESOURCE_PANE_MIN_WIDTH,value))
      : RESOURCE_PANE_DEFAULT_WIDTH;
  } catch { return RESOURCE_PANE_DEFAULT_WIDTH; }
}

const state = {
  projects: [], environments: [], plugins: [], auditEntries: [], projectId: null,
  environmentId: null, pluginId: null, view: 'plugins', runtime: null,
  editingPlugin: null, detailTabs: {}, navigationGeneration: 0,
  runbookContent: '', runbookDraft: '', runbookRevision: null, runbookScopeKey: null, runbookEditing: false,
  runbookDirty: false, runbookLoading: false, runbookLoadGeneration: 0, pendingCount: 0,
  confirmations: [], confirmationsLoaded: false, confirmationCenterActive: false,
  confirmationFilter: { kind:'all' }, confirmationFeedback: null, confirmationExecutions: {},
  projectEnvironmentMemory: {}, scopePluginMemory: {},
  databaseDiscoverySignature: null, databaseCredentialRevision: 0, databaseQueryGeneration: 0,
  credentialProbeGeneration: 0,
  credentialMigration: null,
  deletingPluginScope: null,
  clearingAuditScope: null,
  runtimeByScope: {},
  connectionIntentOwners: {},
  connectionActionsByScope: {},
  environmentsByProject: {},
  projectOverviewActive: false,
  projectOverviewActivityProjectId: null,
  projectOverviewActivityEntries: [],
  projectOverviewActivityLoading: false,
  projectOverviewActivityRefreshing: false,
  projectOverviewActivityGeneration: 0,
  overviewEditingProjectId: null,
  overviewEditingEnvironmentId: null,
  overviewEnvironmentDeletePrompt: null,
  managingProjectId: null,
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
  resourcePaneWidth: storedResourcePaneWidth(),
  detailPaneCollapsed: (() => { try { return localStorage.getItem('ai-ops-detail-pane-collapsed') === '1'; } catch { return false; } })(),
  selectionKind: 'environment',
  expandedEnvironmentId: null,
  environmentDetailTab: 'information',
  projectTitleEditing: false,
  projectTitleDraft: '',
  scopeInformationSupplementKey: null,
  scopeInformationSupplement: null,
  scopeInformationSupplementLoading: false,
  scopeInformationSupplementLoadedAt: 0,
  scopeInformationSupplementGeneration: 0,
  creatingEnvironmentInline: false,
  resourceEnvironmentEditor: null,
  resourceEnvironmentDeletePrompt: null,
  resourceEnvironmentEditSequence: 0,
  pluginFormMode: 'inline',
  inlineConfigPluginId: null,
  pluginFormDiagnostic: null,
  pluginEditPreparation: null,
  pluginEditSession: null,
  newPluginType: null,
  pluginFormInstanceId: null,
  newPluginInstanceId: null,
  pluginProbe: null,
  pluginValidationSequence: 0,
  metadataEditingPluginId: null,
  agentEditingPluginId: null,
  credentialRevealGeneration: 0,
  auditLoadGeneration: 0,
  quickQuestionItems: [],
  quickQuestionRevision: null,
  quickQuestionLoading: false,
  quickQuestionDraft: '',
  quickQuestionDiscoveredDate: '',
  quickQuestionScopeKey: null,
  quickQuestionScopeGeneration: 0,
  quickQuestionLoadGeneration: 0,
  quickQuestionRefreshPending: false,
  quickQuestionEditingId: null,
  quickQuestionOpeningText: null,
  quickQuestionOpeningDefaultText: null,
  quickQuestionOpeningRevision: null,
  quickQuestionOpeningLoading: false,
  quickQuestionOpeningLoaded: false,
  quickQuestionOpeningLoadGeneration: 0,
  quickQuestionOpeningRefreshPending: false,
  quickQuestionOpeningEditorStale: false,
  confirmationLoadGeneration: 0,
  confirmationOpenGeneration: 0,
};

let pluginFormTransitionGeneration = 0;
let pluginFormTransitionTimer = null;
const inFlightOperations = new Map();
const runtimeMutationGenerations = new Map();
const environmentMetadataGenerations = new Map();
let runtimeRenderFrame = null;
const dirtyRuntimeScopes = new Set();
let layoutResizeFrame = null;
let workspaceChangeRefreshPromise = null;
const queuedWorkspaceChanges = [];
const auditLoadPromises = new Map();

const typeNames = pluginTypeNames;
const typeIcons = pluginTypeIcons;
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
  if (!input) return;
  input.type = 'password';
  input.value = '';
  input.dataset.credentialState = 'empty';
  updateCredentialComponent(id);
  updatePasswordToggle(id);
}

function markPasswordStored(id) {
  const input = $(`#${id}`);
  if (!input) return;
  input.type = 'password';
  input.value = '';
  input.dataset.credentialState = 'stored';
  updateCredentialComponent(id);
  updatePasswordToggle(id);
}

function credentialComponentIds(id) {
  return id === 'pluginProxyPassword'
    ? {status:'proxyCredentialStatus',button:'replaceProxyCredential'}
    : {status:'primaryCredentialStatus',button:'replacePrimaryCredential'};
}

function updateCredentialComponent(id) {
  const input = $(`#${id}`);
  if (!input) return;
  const {status,button} = credentialComponentIds(id);
  const statusElement = $(`#${status}`);
  const replaceButton = $(`#${button}`);
  const editor = $(`[data-credential-editor="${id}"]`);
  const edited = input.dataset.credentialState === 'edited';
  const stored = input.dataset.credentialState === 'stored';
  editor?.classList.toggle('hidden',!edited);
  if (statusElement) {
    statusElement.textContent = edited ? '将替换' : stored ? '已保存 · 未修改' : '未设置 · 未修改';
    statusElement.dataset.state = edited ? 'replace' : stored ? 'stored' : 'empty';
  }
  if (replaceButton) replaceButton.textContent = edited ? '撤销更换' : '更换密码';
}

function toggleCredentialReplacement(id) {
  const input = $(`#${id}`);
  if (!input) return;
  if (input.dataset.credentialState === 'edited') {
    input.value = '';
    input.type = 'password';
    input.dataset.credentialState = input.dataset.hadStoredCredential === 'true' ? 'stored' : 'empty';
  } else {
    input.value = '';
    input.type = 'password';
    input.dataset.hadStoredCredential = String(input.dataset.credentialState === 'stored');
    input.dataset.credentialState = 'edited';
  }
  updateCredentialComponent(id);
  updatePasswordToggle(id);
  if (input.dataset.credentialState === 'edited') input.focus();
}

function clearTransientRevealedCredentials({ discardEdited = false } = {}) {
  state.credentialRevealGeneration += 1;
  for (const id of ['pluginPassword','pluginProxyPassword']) {
    const input = $(`#${id}`);
    if (!input) continue;
    setElementBusy($(`[data-password-target="${id}"]`),false);
    if (input.dataset.credentialState === 'revealed') markPasswordStored(id);
    else if (discardEdited && input.dataset.credentialState === 'edited') resetPasswordControl(id);
  }
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
  return input?.dataset.credentialState === 'edited' && input.value ? input.value : '';
}

function pluginRuntimeWarningMessage(result,action = 'save',displayName = '插件') {
  if (result?.persistenceWarning) {
    const detail = String(result.persistenceWarning.message ?? '').trim();
    return detail
      ? `${/(?:配置|密码).*已(?:安全)?保存/u.test(detail) ? '' : '配置和密码已保存。'}${detail} 请重启应用完成恢复检查，不要重复保存。`
      : '配置和密码已保存，但本地恢复记录暂时无法清理。请重启应用完成恢复检查，不要重复保存。';
  }
  if (!result?.runtimeWarning && !result?.manualReconnectRequired) return null;
  if (action === 'delete') return `“${displayName}”已删除且本机凭据仍保留，但旧连接清理异常，请手动断开并重新连接环境。`;
  if (result.runtimeWarning?.message) return result.runtimeWarning.message;
  return '配置和密码已保存，但连接失败。请从只读详情重试连接，不要重新保存。';
}

function primaryCredentialField(plugin, authType = null) {
  const resolvedAuthType = authType ?? (plugin?.pluginType === 'server' ? plugin.auth?.type : null);
  return plugin?.pluginType === 'server' && resolvedAuthType === 'privateKey' ? 'privateKeyPassphrase' : 'password';
}

async function loadCredentialIndicators(plugin, generation) {
  if (!plugin) return;
  const requestedScope = {
    projectId:plugin.projectId,
    environmentId:plugin.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,
  };
  let status;
  try {
    status = await call(api.credentialStatus({...requestedScope}));
  } catch (error) {
    if (generation === state.credentialProbeGeneration
      && scopeMatches(requestedScope)
      && state.editingPlugin?.pluginInstanceId === requestedScope.pluginInstanceId
      && pluginFormVisible()) throw error;
    return;
  }
  if (generation !== state.credentialProbeGeneration
    || !scopeMatches(requestedScope)
    || state.editingPlugin?.pluginInstanceId !== requestedScope.pluginInstanceId
    || !pluginFormVisible()) return;
  if (status.fields?.primary && $('#pluginPassword').dataset.credentialState === 'empty') markPasswordStored('pluginPassword');
  if (status.fields?.proxy && $('#pluginProxyPassword').dataset.credentialState === 'empty') markPasswordStored('pluginProxyPassword');
  state.credentialMigration = status.migration ? {...status.migration,scope:requestedScope} : null;
  renderCredentialMigrationNotice();
}

function credentialMigrationBindingLabel(binding) {
  const host = binding?.host ?? binding?.ssh?.host ?? binding?.target?.host ?? '';
  const port = binding?.port ?? binding?.ssh?.port ?? binding?.target?.port ?? '';
  const username = binding?.username ?? binding?.ssh?.username ?? '';
  if (!host) return '未知目标';
  return `${username ? `${username}@` : ''}${host}${port ? `:${port}` : ''}`;
}

function credentialMigrationChangedLabels(changedFields = {}) {
  const labels = {
    host:'主机',port:'端口',username:'用户名',authType:'认证方式',privateKeyPath:'私钥配置',
    proxyType:'代理方式',proxyHost:'代理主机',proxyPort:'代理端口',proxyUsername:'代理用户名',
  };
  return Object.entries(labels).filter(([key]) => changedFields[key]).map(([,label]) => label);
}

function renderCredentialMigrationNotice() {
  const host = $('#credentialMigrationNotice');
  if (!host) return;
  const migration = state.credentialMigration;
  if (!migration || !state.editingPlugin || !scopeMatches(migration.scope)
    || state.editingPlugin.pluginInstanceId !== migration.scope.pluginInstanceId) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  const source = credentialMigrationBindingLabel(migration.sourceBinding);
  const current = credentialMigrationBindingLabel(migration.currentBinding);
  const changed = credentialMigrationChangedLabels(migration.changedFields);
  const confirmable = migration.status === 'confirmation-required';
  const title = confirmable ? '发现可沿用的旧凭据' : migration.status === 'import-pending' ? '旧凭据等待安全迁移' : '旧凭据已安全保留';
  const detail = confirmable
    ? `旧凭据属于 ${source}，当前配置为 ${current}。${changed.length ? `变化项：${changed.join('、')}。` : ''}只有你确认后才会沿用到当前目标，不需要重新输入密码。`
    : migration.status === 'import-pending'
      ? '原加密文件未被修改；本次自动导入尚未完成，重启应用后会安全重试。'
      : '当前无法安全读取或识别旧凭据格式。原加密文件不会被覆盖，请先保留现场并检查 Windows 安全存储。';
  host.innerHTML = `<span class="credential-migration-icon">${icon(confirmable ? 'shield' : 'lock')}</span><span class="credential-migration-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span>${confirmable ? '<button type="button" class="button small" data-confirm-credential-migration>沿用旧凭据</button>' : ''}`;
  host.classList.remove('hidden');
}

async function confirmCredentialMigration(button) {
  const migration = state.credentialMigration;
  const plugin = state.editingPlugin;
  if (!migration || migration.status !== 'confirmation-required' || !plugin || !scopeMatches(migration.scope)
    || plugin.pluginInstanceId !== migration.scope.pluginInstanceId) return;
  const source = credentialMigrationBindingLabel(migration.sourceBinding);
  const current = credentialMigrationBindingLabel(migration.currentBinding);
  const changed = credentialMigrationChangedLabels(migration.changedFields);
  if (!confirm(`旧凭据目标：${source}\n当前插件目标：${current}${changed.length ? `\n变化项：${changed.join('、')}` : ''}\n\n确认沿用旧凭据到当前插件吗？原加密文件仍会保留。`)) return;
  const operationKey = `credential-migration:${migration.scope.projectId}/${migration.scope.environmentId}/${migration.scope.pluginInstanceId}`;
  const token = beginOperation(operationKey);
  if (!token) return;
  const generation = state.credentialProbeGeneration;
  setElementBusy(button,true);
  try {
    await call(api.confirmCredentialMigration({
      ...migration.scope,
      expectedRevision:migration.expectedRevision,
      sourceSha256:migration.sourceSha256,
    }));
    if (generation !== state.credentialProbeGeneration
      || !scopeMatches(migration.scope)
      || state.editingPlugin?.pluginInstanceId !== migration.scope.pluginInstanceId
      || !pluginFormVisible()) return;
    state.credentialMigration = null;
    renderCredentialMigrationNotice();
    const nextGeneration = ++state.credentialProbeGeneration;
    await loadCredentialIndicators(plugin,nextGeneration);
    toast('旧凭据已安全沿用；原加密文件仍保留。');
  } finally {
    finishOperation(operationKey,token);
    if (button.isConnected) setElementBusy(button,false);
  }
}

async function togglePasswordVisibility(button) {
  const id = button.dataset.passwordTarget;
  const input = $(`#${id}`);
  const credentialState = input.dataset.credentialState;
  if (credentialState === 'stored') {
    const plugin = state.editingPlugin;
    if (!plugin) return;
    const generation = ++state.credentialRevealGeneration;
    const requestedScope = {
      projectId:state.projectId,
      environmentId:state.environmentId,
      pluginInstanceId:plugin.pluginInstanceId,
    };
    setElementBusy(button,true);
    try {
      const field = id === 'pluginProxyPassword' ? 'proxyPassword' : primaryCredentialField(plugin, $('#pluginAuthType').value);
      const result = await call(api.revealCredential({
        ...requestedScope, field,
      }));
      if (generation !== state.credentialRevealGeneration
        || !scopeMatches(requestedScope)
        || state.editingPlugin?.pluginInstanceId !== requestedScope.pluginInstanceId
        || !pluginFormVisible()
        || $(`#${id}`) !== input
        || input.dataset.credentialState !== 'stored') return;
      input.value = result.value;
      input.type = 'text';
      input.dataset.credentialState = 'revealed';
    } catch (error) {
      if (generation === state.credentialRevealGeneration
        && scopeMatches(requestedScope)
        && state.editingPlugin?.pluginInstanceId === requestedScope.pluginInstanceId
        && pluginFormVisible()) throw error;
    } finally {
      if (generation === state.credentialRevealGeneration) {
        setElementBusy(button,false);
        updatePasswordToggle(id);
      }
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
function projectConfigurationError(projectOrId) {
  const project = typeof projectOrId === 'string'
    ? state.projects.find((item) => item.projectId === projectOrId)
    : projectOrId;
  return project?.configurationError ?? null;
}
function projectIsIsolated(projectOrId) { return Boolean(projectConfigurationError(projectOrId)); }
function activeEnvironment() { return state.environments.find((item) => item.environmentId === state.environmentId); }
function activePlugin() { return state.plugins.find((item) => item.pluginInstanceId === state.pluginId); }
function pluginRuntime(id) { return state.runtime?.plugins?.[id] ?? { phase:'disconnected' }; }
function pluginStateKey(pluginOrId,projectId = state.projectId,environmentId = state.environmentId) {
  const plugin = typeof pluginOrId === 'object' ? pluginOrId : null;
  return JSON.stringify([
    plugin?.projectId ?? projectId,
    plugin?.environmentId ?? environmentId,
    plugin?.pluginInstanceId ?? pluginOrId,
  ]);
}
function pluginStateCoordinates(key) {
  try {
    const [projectId,environmentId,pluginInstanceId] = JSON.parse(key);
    return {projectId,environmentId,pluginInstanceId};
  } catch { return {}; }
}
function scopeMatches(scope, { plugin = false } = {}) {
  return Boolean(scope)
    && scope.projectId === state.projectId
    && scope.environmentId === state.environmentId
    && (!plugin || scope.pluginInstanceId === state.pluginId);
}
function runtimeOperationKey(projectId,environmentId,action,pluginInstanceId = null) {
  return `runtime:${scopeKey(projectId,environmentId)}:${pluginInstanceId ?? 'environment'}:${action}`;
}
function connectionIntentOwnerKey(projectId,environmentId,pluginInstanceId = null) {
  return `${scopeKey(projectId,environmentId)}:${pluginInstanceId ?? 'environment'}`;
}
function newConnectionCommandId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}
function renewRuntimeConnectionIntent(operation) {
  operation.requestId = newConnectionCommandId('request');
  operation.planId = newConnectionCommandId('plan');
  operation.operationId = null;
  state.connectionIntentOwners ??= {};
  state.connectionIntentOwners[operation.ownerKey] = {
    requestId:operation.requestId,
    planId:operation.planId,
    operationId:null,
  };
}
function runtimeActionInFlight(projectId,environmentId,action,pluginInstanceId = null) {
  return operationInFlight(runtimeOperationKey(projectId,environmentId,action,pluginInstanceId));
}
function beginRuntimeOperation(projectId,environmentId,action,pluginInstanceId = null) {
  const operationKey = runtimeOperationKey(projectId,environmentId,action,pluginInstanceId);
  const token = beginOperation(operationKey);
  if (!token) return null;
  const generationKey = scopeKey(projectId,environmentId);
  const generation = (runtimeMutationGenerations.get(generationKey) ?? 0) + 1;
  runtimeMutationGenerations.set(generationKey,generation);
  state.connectionIntentOwners ??= {};
  const targetOwnerKey = connectionIntentOwnerKey(projectId,environmentId,pluginInstanceId);
  const environmentOwnerKey = connectionIntentOwnerKey(projectId,environmentId);
  const previousOwnerKey = state.connectionIntentOwners[targetOwnerKey]
    ? targetOwnerKey
    : action === 'cancel' ? environmentOwnerKey : targetOwnerKey;
  const previousOwner = state.connectionIntentOwners[targetOwnerKey]
    ?? (action === 'cancel' ? state.connectionIntentOwners[environmentOwnerKey] : null);
  const operation = {
    operationKey,token,generationKey,generation,ownerKey:previousOwnerKey,
    ownerInherited:previousOwnerKey !== targetOwnerKey,
    requestId:newConnectionCommandId('request'),
    planId:previousOwner?.planId ?? null,
    operationId:previousOwner?.operationId
      ?? (action === 'cancel' && pluginInstanceId
        ? state.runtimeByScope?.[scopeKey(projectId,environmentId)]?.plugins?.[pluginInstanceId]?.operationId ?? null
        : null),
  };
  if (['connect','retry'].includes(action)) renewRuntimeConnectionIntent(operation);
  return operation;
}
function runtimeOperationIsLatest(operation) {
  return runtimeMutationGenerations.get(operation.generationKey) === operation.generation;
}
function scopeDiagnosticPending(projectId,environmentId,pluginInstanceId = null) {
  const formDiagnostic = state.pluginFormDiagnostic;
  return Boolean(formDiagnostic?.status === 'pending'
    && formDiagnostic.scope?.projectId === projectId
    && formDiagnostic.scope?.environmentId === environmentId
    && (!pluginInstanceId || formDiagnostic.scope?.pluginInstanceId === pluginInstanceId));
}
function operationInFlight(key) { return inFlightOperations.has(key); }
function beginOperation(key) {
  if (inFlightOperations.has(key)) return null;
  const token = {};
  inFlightOperations.set(key,token);
  return token;
}
function finishOperation(key,token) {
  if (inFlightOperations.get(key) === token) inFlightOperations.delete(key);
}
function environmentDeleteOperationKey(projectId,environmentId) {
  return `environment-delete:${scopeKey(projectId,environmentId)}`;
}
async function deleteEnvironmentOnce(projectId,environmentId,button,onDeleted) {
  const operationKey = environmentDeleteOperationKey(projectId,environmentId);
  const token = beginOperation(operationKey);
  if (!token) return false;
  setElementBusy(button,true);
  try {
    await call(api.deleteEnvironment({projectId,environmentId}));
    try { await onDeleted(); }
    catch (error) {
      toast(`环境配置已删除，本机加密凭据仍保留；但列表刷新失败，请手动刷新。${error?.message ? `（${error.message}）` : ''}`,true);
    }
    return true;
  } finally {
    finishOperation(operationKey,token);
    setElementBusy(button,false);
  }
}
function setElementBusy(element,busy) {
  if (!element) return;
  element.disabled = Boolean(busy);
  if (busy) element.setAttribute('aria-busy','true');
  else element.removeAttribute('aria-busy');
}
function runtimeTimestamp(runtime) {
  const value = runtime?.updatedAt ? new Date(runtime.updatedAt).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : Number.NaN;
}
function runtimeSnapshotIsCurrent(incoming,current) {
  if (!incoming || !current) return Boolean(incoming);
  const incomingSequence = Number(incoming.sequence ?? incoming.version);
  const currentSequence = Number(current.sequence ?? current.version);
  if (Number.isFinite(incomingSequence) && Number.isFinite(currentSequence)) return incomingSequence >= currentSequence;
  const incomingTime = runtimeTimestamp(incoming);
  const currentTime = runtimeTimestamp(current);
  return !Number.isFinite(incomingTime) || !Number.isFinite(currentTime) || incomingTime >= currentTime;
}
function mergeRuntimeSnapshot(incoming,current) {
  if (!incoming?.pluginsPartial) return incoming;
  const preservesFullPluginState = Boolean(current && !current.pluginsPartial);
  if (!preservesFullPluginState) return incoming;
  return {
    ...(current ?? {}),
    ...incoming,
    plugins:{...(current?.plugins ?? {}),...(incoming.plugins ?? {})},
    pluginsPartial:false,
  };
}
function acceptRuntimeSnapshot(runtime) {
  if (!runtime?.projectId || !runtime?.environmentId) return false;
  const key = scopeKey(runtime.projectId,runtime.environmentId);
  const current = state.runtimeByScope[key];
  if (!runtimeSnapshotIsCurrent(runtime,current)) return false;
  const merged = mergeRuntimeSnapshot(runtime,current);
  state.runtimeByScope[key] = merged;
  const transitional = Object.values(merged.plugins ?? {}).some((plugin) => (
    ['connecting','reconnecting','waitingDependency','disconnecting'].includes(plugin.phase)
  ));
  if (!transitional) {
    for (const ownerKey of Object.keys(state.connectionIntentOwners ?? {})) {
      if (ownerKey.startsWith(`${key}:`)) delete state.connectionIntentOwners[ownerKey];
    }
  }
  if (scopeMatches(runtime) && !state.projectOverviewActive) state.runtime = mergeRuntimeSnapshot(runtime,state.runtime ?? current);
  return true;
}
function pendingConfirmations() { const now = Date.now(); return state.confirmations.filter((item) => confirmationExpiresAt(item) > now); }
function confirmationCount({ projectId = null, environmentId = null, pluginInstanceId = null } = {}) {
  return pendingConfirmations().filter((item) => (!projectId || item.projectId === projectId) && (!environmentId || item.environmentId === environmentId) && (!pluginInstanceId || item.pluginInstanceId === pluginInstanceId)).length;
}
function confirmationScopeData(kind = 'all', projectId = null, environmentId = null, pluginInstanceId = null) {
  return { kind, ...(projectId ? {projectId} : {}), ...(environmentId ? {environmentId} : {}), ...(pluginInstanceId ? {pluginInstanceId} : {}) };
}
function confirmationScopeAttributes(scope) {
  return `data-open-confirmations="${escapeAttr(scope.kind)}"${scope.projectId ? ` data-confirmation-project="${escapeAttr(scope.projectId)}"` : ''}${scope.environmentId ? ` data-confirmation-environment="${escapeAttr(scope.environmentId)}"` : ''}${scope.pluginInstanceId ? ` data-confirmation-plugin="${escapeAttr(scope.pluginInstanceId)}"` : ''}`;
}

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
  element.setAttribute('role',error ? 'alert' : action ? 'button' : 'status');
  element.setAttribute('aria-live',error ? 'assertive' : 'polite');
  if (action) {
    element.tabIndex = 0;
    element.setAttribute('aria-label',`${message}，按回车查看`);
  } else {
    element.removeAttribute('tabindex');
    element.removeAttribute('aria-label');
  }
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.classList.add('hidden');
    element.setAttribute('role','status');
    element.setAttribute('aria-live','polite');
    element.removeAttribute('tabindex');
    element.removeAttribute('aria-label');
  }, action ? 7000 : 3200);
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
      if (runtimeSnapshotIsCurrent(incoming,current)) state.runtimeByScope[key] = mergeRuntimeSnapshot(incoming,current);
    }
  }
  const validProjectIds = new Set(ordered.map((project) => project.projectId));
  const validScopeKeys = new Set(ordered.flatMap((project) => (project.environments ?? []).map((environment) => scopeKey(project.projectId,environment.environmentId))));
  for (const key of Object.keys(state.runtimeByScope)) if (!validScopeKeys.has(key)) delete state.runtimeByScope[key];
  for (const key of Object.keys(state.connectionActionsByScope ?? {})) if (!validScopeKeys.has(key)) delete state.connectionActionsByScope[key];
  for (const key of Object.keys(state.connectionIntentOwners ?? {})) {
    if (![...validScopeKeys].some((scope) => key.startsWith(`${scope}:`))) delete state.connectionIntentOwners[key];
  }
  for (const key of runtimeMutationGenerations.keys()) if (!validScopeKeys.has(key)) runtimeMutationGenerations.delete(key);
  for (const projectId of environmentMetadataGenerations.keys()) if (!validProjectIds.has(projectId)) environmentMetadataGenerations.delete(projectId);
  for (const key of Object.keys(state.scopePluginMemory)) if (!validScopeKeys.has(key)) delete state.scopePluginMemory[key];
  for (const projectId of Object.keys(state.projectEnvironmentMemory)) if (!validProjectIds.has(projectId)) delete state.projectEnvironmentMemory[projectId];
  for (const key of Object.keys(state.detailTabs)) {
    const coordinates = pluginStateCoordinates(key);
    if (!validScopeKeys.has(scopeKey(coordinates.projectId,coordinates.environmentId))) delete state.detailTabs[key];
  }
}

function prunePluginScopeCaches(scope,plugins) {
  const validPluginIds = new Set(plugins.map((plugin) => plugin.pluginInstanceId));
  for (const key of Object.keys(state.detailTabs)) {
    const coordinates = pluginStateCoordinates(key);
    if (coordinates.projectId === scope.projectId
      && coordinates.environmentId === scope.environmentId
      && !validPluginIds.has(coordinates.pluginInstanceId)) delete state.detailTabs[key];
  }
}

async function loadProjects(preferredId = state.projectId, generation = ++state.navigationGeneration) {
  const overviewGeneration = ++state.workspaceOverviewGeneration;
  const projects = await call(api.workspaceOverview());
  if (generation !== state.navigationGeneration || overviewGeneration !== state.workspaceOverviewGeneration) return;
  applyWorkspaceOverview(projects);
  const selectableProjects = state.projects.filter((item) => !projectIsIsolated(item));
  state.projectId = preferredId && selectableProjects.some((item) => item.projectId === preferredId) ? preferredId : selectableProjects[0]?.projectId ?? null;
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
  const projectSelectionChanged = !state.projectId || !state.projects.some((project) => project.projectId === state.projectId && !projectIsIsolated(project));
  if (projectSelectionChanged) {
    state.projectId = state.projects.find((project) => !projectIsIsolated(project))?.projectId ?? null;
    state.projectOverviewActive = false;
    state.environmentId = null;
    state.pluginId = null;
    state.selectionKind = 'environment';
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
  state.selectionKind = 'environment';
  state.expandedEnvironmentId = state.environmentId;
  if (state.environmentId) await loadEnvironment(state.scopePluginMemory[scopeKey()], { projectId, environmentId:state.environmentId }, generation);
  else renderShell();
}

async function loadEnvironment(preferredPlugin = state.pluginId, scope = { projectId:state.projectId, environmentId:state.environmentId }, generation = ++state.navigationGeneration) {
  let plugins;
  let runtime;
  try {
    [plugins,runtime] = await Promise.all([
      call(api.listPlugins(scope)),call(api.environmentStatus(scope)),
    ]);
  } catch (error) {
    if (generation !== state.navigationGeneration || scope.projectId !== state.projectId || scope.environmentId !== state.environmentId) return false;
    throw error;
  }
  if (generation !== state.navigationGeneration || scope.projectId !== state.projectId || scope.environmentId !== state.environmentId) return false;
  state.plugins = plugins;
  prunePluginScopeCaches(scope,plugins);
  const normalizedRuntime = {...runtime,projectId:runtime.projectId ?? scope.projectId,environmentId:runtime.environmentId ?? scope.environmentId};
  acceptRuntimeSnapshot(normalizedRuntime);
  state.runtime = state.runtimeByScope[scopeKey(scope.projectId, scope.environmentId)] ?? normalizedRuntime;
  state.pluginId = plugins.some((item) => item.pluginInstanceId === preferredPlugin) ? preferredPlugin : plugins[0]?.pluginInstanceId ?? null;
  if (state.pluginId) state.scopePluginMemory[scopeKey()] = state.pluginId;
  state.loadedScopeKey = scopeKey(scope.projectId,scope.environmentId);
  state.mobileDetail = false;
  renderShell();
  return true;
}

async function refreshEnvironmentMetadata(scope = { projectId:state.projectId, environmentId:state.environmentId }) {
  const generation = (environmentMetadataGenerations.get(scope.projectId) ?? 0) + 1;
  environmentMetadataGenerations.set(scope.projectId,generation);
  const environments = await call(api.listEnvironments(scope.projectId));
  if (environmentMetadataGenerations.get(scope.projectId) !== generation) return null;
  state.environmentsByProject[scope.projectId] = environments;
  if (state.projectId === scope.projectId) {
    state.environments = environments;
    if (!environments.some((item) => item.environmentId === state.environmentId)) {
      state.environmentId = environments[0]?.environmentId ?? null;
    }
  }
  return environments;
}

function projectMark(project) { return [...(project.name || '项目')].slice(0,2).join(''); }
function projectRailWidthBounds() {
  const overlay = window.innerWidth <= 1100;
  const min = overlay ? 220 : PROJECT_RAIL_MIN_WIDTH;
  const contentMinimum = overlay ? 96 : 980;
  const stablePaneMax = PROJECT_RAIL_DEFAULT_WIDTH + state.resourcePaneWidth - RESOURCE_PANE_MIN_WIDTH;
  const max = Math.max(min,Math.min(overlay ? 300 : PROJECT_RAIL_MAX_WIDTH,window.innerWidth - contentMinimum,overlay ? 300 : stablePaneMax));
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
  toggle.querySelector('use').setAttribute('href',state.projectRailExpanded ? '#i-panel-left-close' : '#i-panel-left-open');
  handle.tabIndex = state.projectRailExpanded ? 0 : -1;
  handle.setAttribute('aria-hidden',String(!state.projectRailExpanded));
  applyProjectRailWidth();
}

function resourcePaneWidthBounds() {
  const compactLayout = window.innerWidth <= 1100;
  const railWidth = compactLayout ? 72 : PROJECT_RAIL_DEFAULT_WIDTH;
  const detailMinimum = state.detailPaneCollapsed ? 58 : 560;
  const available = Math.max(280,window.innerWidth - railWidth - detailMinimum);
  const max = Math.min(RESOURCE_PANE_MAX_WIDTH,available);
  const stableMinimum = compactLayout ? RESOURCE_PANE_MIN_WIDTH : RESOURCE_PANE_MIN_WIDTH + state.projectRailWidth - PROJECT_RAIL_DEFAULT_WIDTH;
  return { min:Math.min(stableMinimum,max), max };
}

function applyResourcePaneWidth(width = state.resourcePaneWidth) {
  const { min, max } = resourcePaneWidthBounds();
  const effectiveWidth = Math.round(Math.min(max,Math.max(min,Number(width) || RESOURCE_PANE_DEFAULT_WIDTH)));
  state.resourcePaneWidth = effectiveWidth;
  $('#app').style.setProperty('--resource-pane-width',`${effectiveWidth}px`);
  const handle = $('#resourcePaneResizeHandle');
  handle.setAttribute('aria-valuemin',String(min));
  handle.setAttribute('aria-valuemax',String(max));
  handle.setAttribute('aria-valuenow',String(effectiveWidth));
  return effectiveWidth;
}

function renderDetailPaneState() {
  $('#app').classList.toggle('detail-collapsed',state.detailPaneCollapsed);
  const toggle = $('#toggleDetailPane');
  toggle.setAttribute('aria-expanded',String(!state.detailPaneCollapsed));
  toggle.setAttribute('aria-label',state.detailPaneCollapsed ? '展开详情栏' : '折叠详情栏');
  toggle.title = state.detailPaneCollapsed ? '展开详情栏' : '折叠详情栏';
  applyResourcePaneWidth();
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
  if (projectIsIsolated(projectId)) return 'failed';
  const summary = projectSummary(projectId);
  if (summary.failed) return 'failed';
  if (summary.attention) return 'attention';
  if (summary.reconnecting) return 'reconnecting';
  if (summary.connected) return 'connected';
  if (summary.draft) return 'draft';
  return 'disconnected';
}

function projectSubtitle(projectId) {
  if (projectIsIsolated(projectId)) return '配置损坏，已隔离';
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
    const configurationError = projectConfigurationError(project);
    const isolated = Boolean(configurationError);
    const approvals = confirmationCount({projectId:project.projectId});
    const description = isolated ? `${projectSubtitle(project.projectId)}：${configurationError.message}` : projectSubtitle(project.projectId);
    return `<section class="project-tree-item ${projectActive ? 'active' : ''}" data-tree-project="${escapeAttr(project.projectId)}" data-project-state="${escapeAttr(projectState(project.projectId))}"${isolated ? ' data-project-isolated="true"' : ''}><div class="project-tree-head"><button type="button" class="rail-button ${projectActive ? 'active' : ''}" draggable="${isolated ? 'false' : 'true'}" data-project-id="${escapeAttr(project.projectId)}" aria-label="${escapeAttr(isolated ? `项目 ${project.name}，${description}` : `打开项目 ${project.name}${approvals ? `，${approvals} 项操作待确认` : ''}`)}" title="${escapeAttr(isolated ? description : project.name)}" ${isolated ? 'disabled' : ''}><span class="rail-letter">${escapeHtml(projectMark(project))}</span><span class="rail-project-copy"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(projectSubtitle(project.projectId))}</small></span>${!isolated && approvals ? `<span class="project-confirmation-count" title="${approvals} 项操作待确认">${approvals}</span>` : ''}<span class="project-tooltip">${escapeHtml(project.name)} · ${escapeHtml(description)}</span></button></div></section>`;
  }).join('');
}

function openProjectSettings(projectId) {
  const project = state.projects.find((item) => item.projectId === projectId);
  if (!project) return;
  if (projectIsIsolated(project)) { toast(project.configurationError.message,true); return; }
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
  $('#deleteProjectMessage').textContent = `将永久删除 ${summary.environments.length} 个环境、${project.pluginCount ?? summary.plugins} 个插件及相关运维说明。本机加密凭据不会随项目删除，旧版凭据文件会单独归档。此操作无法撤销；如有环境仍在连接，请先断开。`;
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
  if (projectIsIsolated(projectId)) return '配置损坏，已隔离';
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
  const busy = runtimeActionInFlight(projectId,environment.environmentId,action.action);
  const disconnectBusy = runtimeActionInFlight(projectId,environment.environmentId,'disconnect');
  const diagnosticPending = scopeDiagnosticPending(projectId,environment.environmentId);
  const connected = Number(runtime.connectedCount ?? 0);
  const scopeData = `data-overview-project-id="${escapeAttr(projectId)}"`;
  const open = `<button class="button small" ${scopeData} data-overview-enter="${escapeAttr(environment.environmentId)}">打开</button>`;
  if (action.action === 'configure') return `${open}<button class="button small primary" ${scopeData} data-overview-complete="${escapeAttr(environment.environmentId)}">${environment.pluginCount ? '完善配置' : '添加插件'}</button>`;
  if (runtime.phase === 'disconnecting') return `${open}<button class="button small" disabled>断开中</button>`;
  const primary = action.primary ? ' primary' : '';
  const main = `<button class="button small${primary}" ${scopeData} data-overview-runtime="${escapeAttr(action.action)}" data-runtime-environment-id="${escapeAttr(environment.environmentId)}" ${action.disabled || busy || diagnosticPending ? 'disabled aria-disabled="true"' : ''}${busy ? ' aria-busy="true"' : ''}>${escapeHtml(action.label === '重试' ? '重试失败项' : action.label === '连接' ? '连接环境' : action.label)}</button>`;
  const canStopConnection = connected > 0 || runtime.phase === 'reconnecting';
  const disconnectLabel = runtime.phase === 'reconnecting' && connected === 0 ? '停止重连' : '断开';
  const disconnect = runtime.desiredConnected && canStopConnection && !['connecting','disconnecting'].includes(runtime.phase) && action.action !== 'disconnect' ? `<button class="text-button" ${scopeData} data-overview-runtime="disconnect" data-runtime-environment-id="${escapeAttr(environment.environmentId)}" ${disconnectBusy || diagnosticPending ? 'disabled aria-disabled="true"' : ''}${disconnectBusy ? ' aria-busy="true"' : ''}>${disconnectLabel}</button>` : '';
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
  if (resource.pluginType === 'mysql') return `${target.host || '未配置主机'}:${target.port ?? 3306} · ${target.database ? `数据库 ${target.database}` : '未选择数据库'}`;
  if (resource.pluginType === 'redis') return Number.isInteger(target.db) ? `DB ${target.db}` : 'Redis DB 待配置';
  return '资源详情';
}

function resourcePhase(resource,runtime) {
  return pluginConnectionViewModel(
    resource,
    runtime.plugins?.[resource.pluginInstanceId] ?? {phase:'disconnected'},
  ).stateClass;
}

function resourceAction(resource,phase,runtimeEntry = null) {
  const presentation = pluginConnectionViewModel(resource,runtimeEntry ?? {phase});
  if (presentation.action === 'continue-configuration') return {action:'configure',label:'待完善',disabled:true};
  if (presentation.action === 'view-provider') return {action:'configure',label:'依赖不可用',disabled:true};
  if (presentation.action === 'view-recovery') return {action:'configure',label:'需要恢复',disabled:true};
  if (presentation.action === 'disconnect') return {action:'disconnect',label:'断开',disabled:false};
  if (presentation.action === 'retry') return {action:'connect',label:'重试',disabled:false};
  if (presentation.action === 'cancel') return {action:'connect',label:presentation.label,disabled:true};
  if (!presentation.action) return {action:'connect',label:presentation.label,disabled:true};
  return { action:'connect',label:'连接',disabled:false };
}

function renderEnvironmentResources(projectId,environment,runtime) {
  const resources = Array.isArray(environment.resourcePreview) ? environment.resourcePreview.slice(0,4) : [];
  if (!resources.length) {
    const message = environment.pluginCount ? '打开环境查看资源详情' : '此环境尚未添加资源';
    return `<div class="environment-resource-empty"><span>${message}</span><button class="environment-resource-add" data-overview-project-id="${escapeAttr(projectId)}" data-overview-environment-id="${escapeAttr(environment.environmentId)}" data-overview-add-resource>添加资源</button></div>`;
  }
  const rows = resources.map((resource) => {
    const runtimeEntry = runtime.plugins?.[resource.pluginInstanceId] ?? {phase:'disconnected'};
    const phase = resourcePhase(resource,runtime);
    const action = resourceAction(resource,phase,runtimeEntry);
    const actionTitle = action.action === 'disconnect' ? '断开此资源；依赖它的资源也可能同时断开' : '单独连接此资源；需要的隧道会自动建立';
    const busy = runtimeActionInFlight(projectId,environment.environmentId,action.action,resource.pluginInstanceId);
    const diagnosticPending = scopeDiagnosticPending(projectId,environment.environmentId,resource.pluginInstanceId);
    return `<div class="environment-resource-row"><button class="environment-resource-open" data-overview-project-id="${escapeAttr(projectId)}" data-overview-environment-id="${escapeAttr(environment.environmentId)}" data-overview-plugin="${escapeAttr(resource.pluginInstanceId)}"><span class="environment-resource-icon ${escapeAttr(resource.pluginType)}">${icon(typeIcons[resource.pluginType] ?? 'plug')}</span><span class="environment-resource-copy"><strong>${escapeHtml(resource.displayName)}</strong><small>${escapeHtml(resourceTargetText(resource))}</small></span></button><button class="environment-resource-action ${escapeAttr(phase)}" data-overview-project-id="${escapeAttr(projectId)}" data-overview-environment-id="${escapeAttr(environment.environmentId)}" data-overview-plugin-id="${escapeAttr(resource.pluginInstanceId)}" data-overview-plugin-action="${escapeAttr(action.action)}" aria-label="${escapeAttr(`${action.label} ${resource.displayName}`)}" title="${escapeAttr(actionTitle)}" ${action.disabled || busy || diagnosticPending ? 'disabled aria-disabled="true"' : ''}${busy ? ' aria-busy="true"' : ''}>${escapeHtml(action.label)}</button></div>`;
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
  return auditEntryVisible(entry);
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
  const prompt = state.overviewEnvironmentDeletePrompt?.projectId === projectId
    && state.overviewEnvironmentDeletePrompt?.environmentId === environment.environmentId
    ? state.overviewEnvironmentDeletePrompt
    : null;
  if (prompt) {
    const deleting = operationInFlight(environmentDeleteOperationKey(projectId,environment.environmentId));
    return `<span class="environment-card-name">${escapeHtml(environment.name)}</span><span class="environment-card-delete-prompt ${prompt.confirmable ? '' : 'blocked'}"><span>${escapeHtml(prompt.message)}</span><button class="text-button" data-overview-cancel-environment-delete>${prompt.confirmable ? '取消' : '关闭'}</button>${prompt.confirmable ? `<button class="text-button danger" data-overview-confirm-delete-environment="${escapeAttr(environment.environmentId)}" data-overview-project-id="${escapeAttr(projectId)}"${deleting ? ' disabled aria-busy="true"' : ''}>确认删除</button>` : ''}</span>`;
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
  if (name === environment.name) {
    state.overviewEditingProjectId = null;
    state.overviewEditingEnvironmentId = null;
    renderProjectOverview();
    return;
  }
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
  const configurationError = projectConfigurationError(project);
  if (configurationError) {
    $('#projectOverviewSummary').textContent = '配置损坏，已隔离';
    $('#projectOverviewEnvironmentCount').textContent = '0 个环境';
    $('#projectOverviewStats').innerHTML = '';
    $('#projectOverviewAttention').innerHTML = `<div class="overview-healthy"><span>!</span><div><strong>配置损坏，已隔离</strong><small>${escapeHtml(configurationError.message)}</small></div></div>`;
    $('#projectOverviewActivity').innerHTML = '<div class="overview-panel-empty">为保护其他项目，当前项目不会被加载或修改</div>';
    $('#projectOverviewList').innerHTML = '';
    return;
  }
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

function resourcePanePlugins(environment) {
  if (environment.environmentId === state.environmentId && state.loadedScopeKey === scopeKey()) return state.plugins;
  return Array.isArray(environment.resourcePreview) ? environment.resourcePreview : [];
}

function resourcePluginTarget(plugin) {
  if ('resource' in plugin) return resourceTargetText(plugin);
  return pluginTarget(plugin);
}

function resourcePluginPhase(plugin,runtime) {
  return pluginConnectionViewModel(
    plugin,
    runtime.plugins?.[plugin.pluginInstanceId] ?? {phase:'disconnected'},
  ).stateClass;
}

function renderResourcePlugin(projectId,environment,plugin,runtime) {
  const runtimeEntry = runtime.plugins?.[plugin.pluginInstanceId] ?? {phase:'disconnected'};
  const presentation = pluginConnectionViewModel(plugin,runtimeEntry);
  const phase = resourcePluginPhase(plugin,runtime);
  const action = resourceAction(plugin,phase,runtimeEntry);
  const selected = state.selectionKind === 'plugin' && environment.environmentId === state.environmentId && plugin.pluginInstanceId === state.pluginId;
  const approvalScope = confirmationScopeData('plugin',projectId,environment.environmentId,plugin.pluginInstanceId);
  const approvals = confirmationCount(approvalScope);
  const busy = runtimeActionInFlight(projectId,environment.environmentId,action.action,plugin.pluginInstanceId);
  const diagnosticPending = scopeDiagnosticPending(projectId,environment.environmentId,plugin.pluginInstanceId);
  const approvalButton = approvals ? `<button class="scope-confirmation-badge compact" ${confirmationScopeAttributes(approvalScope)} title="查看${plugin.displayName}的待确认操作" aria-label="${plugin.displayName}有${approvals}项操作待确认">${icon('shield')}<span>${approvals}</span></button>` : '';
  return `<div class="resource-plugin-row ${selected ? 'selected' : ''}"><button class="resource-plugin-open" data-resource-project-id="${escapeAttr(projectId)}" data-resource-environment-id="${escapeAttr(environment.environmentId)}" data-resource-plugin-id="${escapeAttr(plugin.pluginInstanceId)}"><span class="resource-plugin-icon ${escapeAttr(plugin.pluginType)}">${icon(typeIcons[plugin.pluginType] ?? 'plug')}</span><span class="resource-plugin-copy"><strong>${escapeHtml(plugin.displayName)}</strong><small>${escapeHtml(resourcePluginTarget(plugin))}</small></span><span class="state-dot ${escapeAttr(phase)}" title="${escapeAttr(presentation.label)}"></span></button>${approvalButton}<button class="resource-plugin-action ${escapeAttr(phase)}" data-overview-project-id="${escapeAttr(projectId)}" data-overview-environment-id="${escapeAttr(environment.environmentId)}" data-overview-plugin-id="${escapeAttr(plugin.pluginInstanceId)}" data-overview-plugin-action="${escapeAttr(action.action)}" ${action.disabled || busy || diagnosticPending ? 'disabled aria-disabled="true"' : ''}${busy ? ' aria-busy="true"' : ''}>${escapeHtml(action.label)}</button></div>`;
}

function environmentActionLabel(action) {
  if (action.action === 'connect') return action.label === '连接未连接项' ? action.label : '连接全部';
  if (action.action === 'disconnect') return '断开全部';
  if (action.action === 'retry') return '重试失败';
  if (action.action === 'configure') return '完善配置';
  return action.label;
}

function resourceEnvironmentEditorFor(projectId,environmentId) {
  const editor = state.resourceEnvironmentEditor;
  return editor?.projectId === projectId && editor.environmentId === environmentId ? editor : null;
}

function resourceEnvironmentDeletePromptFor(projectId,environmentId) {
  const prompt = state.resourceEnvironmentDeletePrompt;
  return prompt?.projectId === projectId && prompt.environmentId === environmentId ? prompt : null;
}

function renderResourceEnvironmentEditor(projectId,environment,editor) {
  const environmentLabel = escapeAttr(environment.name);
  return `<form class="scope-information-editor resource-environment-rename-form" data-resource-environment-editor="${escapeAttr(environment.environmentId)}" data-resource-project-id="${escapeAttr(projectId)}" novalidate><label class="field full"><span>环境名称</span><input maxlength="120" autocomplete="off" aria-label="环境名称" value="${escapeAttr(editor.name)}"><span class="resource-environment-rename-error field-error" role="alert"></span></label><div class="scope-information-editor-actions"><button type="button" class="button" data-resource-cancel-environment-rename>取消</button><button type="submit" class="button primary" aria-label="保存${environmentLabel}的新名称">保存修改</button></div></form>`;
}

function renderResourceEnvironment(projectId,environment) {
  const runtime = environmentRuntime(projectId,environment.environmentId);
  const presentationPhase = runtimePresentationPhase(runtime);
  const connectionLabel = phaseNames[presentationPhase] ?? '未连接';
  const action = railEnvironmentAction(projectId,environment);
  const busy = runtimeActionInFlight(projectId,environment.environmentId,action.action);
  const diagnosticPending = scopeDiagnosticPending(projectId,environment.environmentId);
  const expanded = state.expandedEnvironmentId === environment.environmentId;
  const selectedEnvironment = state.selectionKind === 'environment' && state.environmentId === environment.environmentId;
  const plugins = resourcePanePlugins(environment);
  const grouped = ['server','mysql','redis'].map((type) => {
    const items = plugins.filter((plugin) => plugin.pluginType === type);
    if (!items.length) return '';
    return `<section class="resource-plugin-group"><div class="resource-plugin-group-label"><span>${typeNames[type]}</span><b>${items.length}</b></div>${items.map((plugin) => renderResourcePlugin(projectId,environment,plugin,runtime)).join('')}</section>`;
  }).join('');
  const previewMissing = Math.max(0,Number(environment.pluginCount ?? 0) - plugins.length);
  const body = expanded ? `<div class="resource-environment-body">${grouped}${!grouped ? '<p class="resource-empty">当前环境还没有插件</p>' : ''}${previewMissing ? `<button class="resource-preview-more" data-resource-environment-id="${escapeAttr(environment.environmentId)}">打开后查看另外 ${previewMissing} 个插件</button>` : ''}<button class="resource-add-plugin" data-resource-add-plugin="${escapeAttr(environment.environmentId)}">${icon('plus')}添加插件</button></div>` : '';
  const environmentLabel = escapeAttr(environment.name);
  const approvalScope = confirmationScopeData('environment',projectId,environment.environmentId);
  const approvals = confirmationCount(approvalScope);
  const approvalButton = approvals ? `<button class="scope-confirmation-badge" ${confirmationScopeAttributes(approvalScope)} title="查看${environment.name}的${approvals}项待确认操作" aria-label="${environment.name}有${approvals}项操作待确认">${icon('shield')}<b>${approvals}</b></button>` : '';
  const headerContent = `<button class="resource-environment-select" data-resource-environment-id="${escapeAttr(environment.environmentId)}" aria-expanded="${expanded}" title="点击${expanded ? '收起' : '展开'}${environmentLabel}"><span class="resource-environment-icon">${icon('environment')}</span><span class="resource-environment-copy"><strong>${escapeHtml(environment.name)}</strong><small>${Number(environment.pluginCount ?? 0)} 个插件</small></span></button><span class="resource-environment-status" data-state="${escapeAttr(presentationPhase)}"><i></i><span>${escapeHtml(connectionLabel)}</span></span>${approvalButton}<button class="button small resource-runtime-action ${action.primary && state.environmentId === environment.environmentId ? 'primary' : ''} ${action.action === 'disconnect' ? 'danger-subtle' : ''}" data-environment-runtime-action="${escapeAttr(action.action)}" data-action-project-id="${escapeAttr(projectId)}" data-action-environment-id="${escapeAttr(environment.environmentId)}" ${action.disabled || busy || diagnosticPending ? 'disabled aria-disabled="true"' : ''}${busy ? ' aria-busy="true"' : ''}>${escapeHtml(environmentActionLabel(action))}</button>`;
  return `<article class="resource-environment-card ${expanded ? 'expanded' : ''} ${selectedEnvironment ? 'selected' : ''}" data-state="${escapeAttr(presentationPhase)}"><header class="resource-environment-head">${headerContent}</header>${body}</article>`;
}

function renderInlineEnvironmentCreate(project) {
  const creating = Boolean(project && state.creatingEnvironmentInline);
  $('#showInlineEnvironmentCreate').disabled = !project;
  $('#showInlineEnvironmentCreate').classList.toggle('hidden',creating);
  $('#resourceEnvironmentCreateForm').classList.toggle('hidden',!creating);
}

function renderResourcePane() {
  const project = activeProject();
  $('#projectTitle').textContent = project?.name ?? '选择项目';
  renderInlineEnvironmentCreate(project);
  if (!project) {
    $('#projectResourceSummary').textContent = '0 个环境 · 0 个插件';
    $('#resourceEnvironmentCount').textContent = '';
    $('#resourceEnvironmentList').innerHTML = '<div class="resource-pane-empty">选择项目后在这里管理环境与插件</div>';
    return;
  }
  const pluginCount = state.environments.reduce((sum,environment) => sum + Number(environment.pluginCount ?? 0),0);
  $('#projectResourceSummary').textContent = `${state.environments.length} 个环境 · ${pluginCount} 个插件`;
  $('#resourceEnvironmentCount').textContent = `${state.environments.length} 个环境`;
  $('#resourceEnvironmentList').innerHTML = state.environments.map((environment) => renderResourceEnvironment(project.projectId,environment)).join('') || '<div class="resource-pane-empty">当前项目还没有环境</div>';
}

function beginInlineEnvironmentCreate() {
  if (!activeProject()) return;
  state.creatingEnvironmentInline = true;
  $('#resourceEnvironmentName').value = '';
  $('#resourceEnvironmentCreateError').textContent = '';
  renderInlineEnvironmentCreate(activeProject());
  requestAnimationFrame(() => $('#resourceEnvironmentName').focus());
}

function cancelInlineEnvironmentCreate() {
  state.creatingEnvironmentInline = false;
  $('#resourceEnvironmentName').value = '';
  $('#resourceEnvironmentCreateError').textContent = '';
  renderInlineEnvironmentCreate(activeProject());
}

async function saveInlineEnvironmentCreate(event) {
  event.preventDefault();
  const project = activeProject();
  const button = $('#saveInlineEnvironmentCreate');
  if (!project || button.disabled) return;
  const name = $('#resourceEnvironmentName').value.trim();
  if (!name) {
    $('#resourceEnvironmentCreateError').textContent = '请输入环境名称。';
    $('#resourceEnvironmentName').focus();
    return;
  }
  button.disabled = true;
  $('#resourceEnvironmentCreateError').textContent = '';
  try {
    await call(api.createEnvironment({projectId:project.projectId,input:{name}}));
    state.creatingEnvironmentInline = false;
    await refreshWorkspaceOverview({render:false});
    state.environments = state.environmentsByProject[state.projectId] ?? [];
    renderShell();
    toast('环境已创建。');
  } catch (error) {
    $('#resourceEnvironmentCreateError').textContent = error?.message || '创建环境失败。';
  } finally {
    button.disabled = false;
  }
}

function formatScopeTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
}

function formatScopeBytes(value) {
  const bytes = Math.max(0,Number(value) || 0);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function pluginTypeSummary(counts = {}) {
  return [['server','Server'],['mysql','MySQL'],['redis','Redis']]
    .filter(([type]) => Number(counts[type] ?? 0) > 0)
    .map(([type,label]) => `${label} ${Number(counts[type])}`)
    .join(' · ') || '尚未添加插件';
}

function projectScopeStatus(projectId) {
  const value = projectState(projectId);
  return ({
    connected:{ label:'运行中',tone:'success' },
    reconnecting:{ label:'正在重连',tone:'active' },
    attention:{ label:'部分异常',tone:'warning' },
    failed:{ label:'需要处理',tone:'error' },
    draft:{ label:'待完善',tone:'warning' },
    disconnected:{ label:'未连接',tone:'neutral' },
  })[value] ?? { label:'未连接',tone:'neutral' };
}

function environmentScopeStatus(projectId,environment) {
  const runtime = environmentRuntime(projectId,environment.environmentId);
  const facts = runtimeFacts(runtime);
  const phase = runtimePresentationPhase(runtime);
  if (runtime.phase === 'reconnecting' || runtime.phase === 'connecting') return { label:phaseNames[runtime.phase],tone:'active',phase };
  if (facts.failureCount > 0 && facts.connectedCount > 0) return { label:'部分异常',tone:'warning',phase:'partial' };
  if (facts.failureCount > 0) return { label:'连接失败',tone:'error',phase:'failed' };
  if (facts.connectedCount > 0) return { label:`${facts.connectedCount}/${facts.eligibleCount} 已连接`,tone:'success',phase:'connected' };
  const draft = Math.max(0,Number(environment.pluginCount ?? 0) - Number(environment.readyPluginCount ?? 0));
  if (draft || !Number(environment.pluginCount ?? 0)) return { label:draft ? '待完善' : '尚无插件',tone:'warning',phase:'draft' };
  return { label:'未连接',tone:'neutral',phase:'disconnected' };
}

function renderScopeMetric({scope,name,label,value,detail,tone = 'neutral'}) {
  return `<div class="scope-overview-stat" data-${scope}-stat="${escapeAttr(name)}" data-tone="${escapeAttr(tone)}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd><small>${escapeHtml(detail)}</small></div>`;
}

function scopeInformationDataKey(project,environment = null) {
  return environment
    ? `environment:${project.projectId}:${environment.environmentId}`
    : `project:${project.projectId}`;
}

function scopeInformationSupplementFor(project,environment = null) {
  return state.scopeInformationSupplementKey === scopeInformationDataKey(project,environment)
    ? state.scopeInformationSupplement
    : null;
}

function scopeInformationKeyIsCurrent(key) {
  if (state.view !== 'scope-info') return false;
  const project = activeProject();
  if (!project) return false;
  const environment = state.selectionKind === 'project' ? null : activeEnvironment();
  return scopeInformationDataKey(project,environment) === key;
}

async function loadScopeInformationSupplement(project,environment = null) {
  const key = scopeInformationDataKey(project,environment);
  const sameKey = state.scopeInformationSupplementKey === key;
  const fresh = sameKey && state.scopeInformationSupplement
    && Date.now() - state.scopeInformationSupplementLoadedAt < 30_000;
  if ((sameKey && state.scopeInformationSupplementLoading) || fresh) return;
  const generation = ++state.scopeInformationSupplementGeneration;
  state.scopeInformationSupplementKey = key;
  state.scopeInformationSupplementLoading = true;
  if (!sameKey) state.scopeInformationSupplement = null;
  const activityRequest = environment
    ? Promise.resolve({entries:[]})
    : call(api.listAudit({projectId:project.projectId,limit:20}));
  const runbookRequest = environment
    ? call(api.readRunbook({projectId:project.projectId,environmentId:environment.environmentId}))
    : Promise.resolve(null);
  const [activityResult,runbookResult] = await Promise.allSettled([activityRequest,runbookRequest]);
  if (generation !== state.scopeInformationSupplementGeneration || state.scopeInformationSupplementKey !== key) return;
  state.scopeInformationSupplement = {
    activityEntries:activityResult.status === 'fulfilled' ? activityResult.value.entries ?? [] : [],
    activityError:activityResult.status === 'rejected',
    runbook:runbookResult.status === 'fulfilled' ? runbookResult.value : null,
    runbookError:Boolean(environment && runbookResult.status === 'rejected'),
  };
  state.scopeInformationSupplementLoading = false;
  state.scopeInformationSupplementLoadedAt = Date.now();
  if (scopeInformationKeyIsCurrent(key)) renderScopeInformation();
}

function renderScopeActivity(project,environment = null) {
  const supplement = scopeInformationSupplementFor(project,environment);
  if (!supplement) return '<div class="scope-overview-empty">正在读取最近操作…</div>';
  if (supplement.activityError) return '<div class="scope-overview-empty">最近操作暂时无法读取</div>';
  const entries = supplement.activityEntries.filter(auditEntryVisible).slice(0,5);
  if (!entries.length) return '<div class="scope-overview-empty">暂无操作记录</div>';
  return entries.map((entry) => {
    const result = auditResult(entry);
    const entryEnvironment = environmentFor(project.projectId,entry.environmentId);
    const target = entry.pluginNameSnapshot ?? entryEnvironment?.name ?? environment?.name ?? project.name;
    return `<div class="scope-activity-row"><span class="scope-activity-dot ${escapeAttr(result)}"></span><span class="scope-activity-copy"><strong>${escapeHtml(auditOperationName(entry))}</strong><small>${escapeHtml(target)} · ${escapeHtml(auditActorName(entry))}</small></span><time>${escapeHtml(overviewActivityTime(entry.time))}</time></div>`;
  }).join('');
}

function renderHealthyOverview(title,detail) {
  return `<div class="scope-healthy"><span>${icon('check')}</span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div></div>`;
}

function renderProjectAttention(projectId) {
  const items = projectAttentionItems(projectId).slice(0,5);
  const approvals = confirmationCount({projectId});
  if (!items.length && !approvals) return renderHealthyOverview('当前无需处理','没有配置缺失、连接异常或待确认操作');
  const rows = items.map((item) => `<div class="scope-attention-row ${escapeAttr(item.kind)}"><i></i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.environment.name)} · ${escapeHtml(item.detail)}</small></span></div>`);
  if (approvals) rows.unshift(`<div class="scope-attention-row warning"><i></i><span><strong>${approvals} 项操作等待确认</strong><small>确认中心中有尚未处理的 Agent 操作</small></span></div>`);
  return rows.join('');
}

function environmentAttentionItems(projectId,environment,runtime) {
  const items = [];
  const facts = runtimeFacts(runtime);
  const pluginCount = Number(environment.pluginCount ?? 0);
  const ready = Number(environment.readyPluginCount ?? 0);
  const draft = Math.max(0,pluginCount - ready);
  if (!pluginCount) items.push({tone:'warning',title:'尚未添加插件',detail:'当前环境没有可用的运维资源'});
  else if (draft) items.push({tone:'warning',title:`${draft} 个插件待完善`,detail:'补齐连接目标、认证或资源范围'});
  if (runtime.phase === 'reconnecting') items.push({tone:'warning',title:'正在恢复连接',detail:'网络变化后正在自动重连'});
  else if (facts.failureCount > 0) items.push({tone:facts.connectedCount ? 'warning' : 'error',title:facts.connectedCount ? '部分插件连接异常' : '环境当前不可用',detail:runtimeIssue(runtime) || '检查网络、凭据和插件依赖'});
  if (facts.manualDisconnectedCount) items.push({tone:'neutral',title:`${facts.manualDisconnectedCount} 个插件已主动断开`,detail:'这些插件不会自动恢复连接'});
  const approvals = confirmationCount({projectId,environmentId:environment.environmentId});
  if (approvals) items.push({tone:'warning',title:`${approvals} 项操作等待确认`,detail:'确认后 Agent 才能继续执行'});
  return items;
}

function renderEnvironmentAttention(projectId,environment,runtime) {
  const items = environmentAttentionItems(projectId,environment,runtime);
  if (!items.length) return renderHealthyOverview('当前无需处理','配置完整，运行状态没有异常');
  return items.slice(0,5).map((item) => `<div class="scope-attention-row ${escapeAttr(item.tone)}"><i></i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span></div>`).join('');
}

function renderMetadataRows(rows) {
  return `<dl class="scope-metadata-list">${rows.map(([label,value,kind = 'text']) => `<div><dt>${escapeHtml(label)}</dt><dd class="${kind === 'code' ? 'scope-metadata-code' : ''}">${escapeHtml(String(value))}</dd></div>`).join('')}</dl>`;
}

function renderProjectEnvironmentRows(project) {
  const environments = state.environmentsByProject[project.projectId] ?? [];
  if (!environments.length) return '<div class="scope-overview-empty">当前项目还没有环境</div>';
  return environments.map((environment) => {
    const runtime = environmentRuntime(project.projectId,environment.environmentId);
    const facts = runtimeFacts(runtime);
    const status = environmentScopeStatus(project.projectId,environment);
    const pluginCount = Number(environment.pluginCount ?? 0);
    const ready = Number(environment.readyPluginCount ?? 0);
    return `<div class="scope-environment-row"><span class="scope-row-icon">${icon('environment')}</span><span class="scope-row-copy"><strong>${escapeHtml(environment.name)}</strong><small>${escapeHtml(pluginTypeSummary(environment.pluginTypeCounts))}</small></span><span class="scope-row-status" data-tone="${escapeAttr(status.tone)}"><i></i>${escapeHtml(status.label)}</span><span class="scope-row-metrics"><b>配置 ${ready}/${pluginCount}</b><b>连接 ${facts.connectedCount}/${facts.eligibleCount}</b></span></div>`;
  }).join('');
}

function renderEnvironmentPluginRows(project,environment,runtime) {
  const plugins = resourcePanePlugins(environment);
  const rows = [];
  for (const plugin of plugins) {
    const runtimeEntry = runtime.plugins?.[plugin.pluginInstanceId] ?? {phase:'disconnected'};
    const presentation = pluginConnectionViewModel(plugin,runtimeEntry);
    rows.push(`<div class="scope-plugin-row"><span class="scope-plugin-icon ${escapeAttr(plugin.pluginType)}">${icon(typeIcons[plugin.pluginType] ?? 'plug')}</span><span class="scope-row-copy"><strong>${escapeHtml(plugin.displayName)}</strong><small>${escapeHtml(typeNames[plugin.pluginType] ?? '插件')} · ${escapeHtml(resourcePluginTarget(plugin))}</small></span><span class="scope-row-status" data-tone="${escapeAttr(presentation.stateClass)}"><i></i>${escapeHtml(presentation.label)}</span></div>`);
  }
  if (!rows.length) return '<div class="scope-overview-empty">当前环境尚未添加插件</div>';
  const visible = rows.slice(0,3);
  if (rows.length > visible.length) visible.push(`<div class="scope-overview-more">另有 ${rows.length - visible.length} 个插件，可在左侧资源栏查看</div>`);
  return visible.join('');
}

function renderRunbookOverview(project,environment) {
  const supplement = scopeInformationSupplementFor(project,environment);
  if (!supplement) return `<div class="scope-runbook-summary loading"><span class="scope-panel-symbol">${icon('file')}</span><div><strong>正在读取运维说明…</strong><small>读取当前环境的本地 Markdown</small></div></div>`;
  if (supplement.runbookError) return `<div class="scope-runbook-summary warning"><span class="scope-panel-symbol">${icon('file')}</span><div><strong>运维说明暂时无法读取</strong><small>可切换到“运维说明”标签重试</small></div></div>`;
  const runbook = supplement.runbook ?? {empty:true,bytes:0};
  return `<div class="scope-runbook-summary ${runbook.empty ? 'warning' : 'ready'}"><span class="scope-panel-symbol">${icon('file')}</span><div><strong>${runbook.empty ? '尚未填写运维说明' : '运维说明已填写'}</strong><small>${formatScopeBytes(runbook.bytes)} · 可在上方“运维说明”标签查看和编辑</small></div></div>`;
}

function renderProjectInformation(project) {
  const metrics = projectOverviewMetrics(project.projectId);
  const summary = projectSummary(project.projectId);
  const status = projectScopeStatus(project.projectId);
  const approvals = confirmationCount({projectId:project.projectId});
  const editor = state.projectTitleEditing
    ? `<div class="scope-overview-inline"><form id="projectTitleEditor" class="scope-information-editor" novalidate><label class="field full"><span>项目名称</span><input id="projectTitleInput" maxlength="120" autocomplete="off" aria-label="项目名称" value="${escapeAttr(state.projectTitleDraft || project.name)}"><span id="projectTitleError" class="field-error" role="alert"></span></label><div class="scope-information-editor-actions"><button id="cancelProjectTitle" type="button" class="button">取消</button><button id="saveProjectTitle" type="submit" class="button primary">保存修改</button></div></form></div>`
    : '';
  const actions = state.projectTitleEditing ? '' : `<div class="scope-information-actions" aria-label="项目操作"><button id="projectSettingsShortcut" type="button" class="button">${icon('edit')}修改名称</button><button id="projectDeleteShortcut" type="button" class="button danger-subtle">${icon('trash')}删除项目</button></div>`;
  const stats = [
    renderScopeMetric({scope:'project',name:'environment-count',label:'环境',value:metrics.environments,detail:metrics.attention ? `${metrics.attention} 个需要关注` : '当前没有异常环境',tone:metrics.attention ? 'warning' : 'neutral'}),
    renderScopeMetric({scope:'project',name:'configuration-count',label:'已配置',value:`${metrics.ready}/${metrics.resources}`,detail:metrics.ready < metrics.resources ? `${metrics.resources - metrics.ready} 个插件待完善` : metrics.resources ? '全部插件配置完整' : '尚未添加插件',tone:metrics.ready < metrics.resources ? 'warning' : 'neutral'}),
    renderScopeMetric({scope:'project',name:'connection-count',label:'当前连接',value:`${metrics.connected}/${metrics.eligible}`,detail:metrics.eligible ? (metrics.connected === metrics.eligible ? '可用插件均已连接' : `${metrics.eligible - metrics.connected} 个尚未连接`) : '暂无可连接插件',tone:metrics.connected && metrics.connected === metrics.eligible ? 'success' : 'neutral'}),
    renderScopeMetric({scope:'project',name:'attention-count',label:'需要处理',value:metrics.attention + approvals,detail:approvals ? `${approvals} 项操作等待确认` : metrics.attention ? '配置或连接需要处理' : '没有待处理事项',tone:metrics.attention + approvals ? 'warning' : 'success'}),
  ].join('');
  const typeCounts = summary.environments.reduce((counts,environment) => {
    for (const type of ['server','mysql','redis']) counts[type] += Number(environment.pluginTypeCounts?.[type] ?? 0);
    return counts;
  },{server:0,mysql:0,redis:0});
  const metadata = renderMetadataRows([
    ['项目 ID',project.projectId,'code'],
    ['创建时间',formatScopeTimestamp(project.createdAt)],
    ['配置更新时间',formatScopeTimestamp(project.updatedAt)],
    ['插件类型',pluginTypeSummary(typeCounts)],
  ]);
  return `<div class="scope-information-page scope-overview-page"><span class="sr-only">项目信息</span><header class="scope-information-head scope-overview-head"><span class="scope-information-icon scope-overview-icon">${icon('plan')}</span><div class="scope-overview-title"><span class="scope-information-kind">项目概览</span><div><h1>${escapeHtml(project.name)}</h1><span class="scope-status-badge" data-tone="${escapeAttr(status.tone)}"><i></i>${escapeHtml(status.label)}</span></div><p>${escapeHtml(project.projectId)} · 配置更新于 ${escapeHtml(formatScopeTimestamp(project.updatedAt))}</p></div>${actions}</header>${editor}<dl class="scope-overview-stats">${stats}</dl><div class="scope-overview-layout"><div class="scope-overview-main"><section class="scope-overview-panel"><header><div><h2>环境状态</h2><p>汇总每个环境的配置和实时连接情况</p></div><span>${metrics.environments} 个环境</span></header><div class="scope-overview-list">${renderProjectEnvironmentRows(project)}</div></section><section class="scope-overview-panel"><header><div><h2>最近操作</h2><p>项目内用户、Agent 与系统的重要记录</p></div></header><div class="scope-overview-list">${renderScopeActivity(project)}</div></section></div><aside class="scope-overview-aside"><section class="scope-overview-panel"><header><div><h2>需要处理</h2><p>配置缺失、连接异常与待确认操作</p></div></header><div class="scope-overview-list">${renderProjectAttention(project.projectId)}</div></section><section class="scope-overview-panel"><header><div><h2>项目资料</h2><p>本机保存的非敏感配置元数据</p></div></header>${metadata}</section></aside></div></div>`;
}

function renderEnvironmentDeleteDecision(projectId,environment,prompt) {
  const deleting = operationInFlight(environmentDeleteOperationKey(projectId,environment.environmentId));
  return `<div class="scope-delete-decision ${prompt.confirmable ? '' : 'blocked'}" data-resource-environment-delete-prompt="${escapeAttr(environment.environmentId)}"><div><strong>${escapeHtml(prompt.message)}</strong><small>${prompt.confirmable ? '删除后本机加密凭据继续保留。' : '处理完成后再删除此环境。'}</small></div><div><button type="button" class="button" data-resource-cancel-environment-delete>${prompt.confirmable ? '取消' : '关闭'}</button>${prompt.confirmable ? `<button type="button" class="button danger" data-resource-confirm-environment-delete="${escapeAttr(environment.environmentId)}" data-resource-project-id="${escapeAttr(projectId)}"${deleting ? ' disabled aria-busy="true"' : ''}>确认删除</button>` : ''}</div></div>`;
}

function renderEnvironmentInformation(project,environment) {
  const runtime = environmentRuntime(project.projectId,environment.environmentId);
  const facts = runtimeFacts(runtime);
  const editor = resourceEnvironmentEditorFor(project.projectId,environment.environmentId);
  const prompt = resourceEnvironmentDeletePromptFor(project.projectId,environment.environmentId);
  const status = environmentScopeStatus(project.projectId,environment);
  const pluginCount = Number(environment.pluginCount ?? 0);
  const ready = Number(environment.readyPluginCount ?? 0);
  const approvals = confirmationCount({projectId:project.projectId,environmentId:environment.environmentId});
  const editing = Boolean(editor || prompt);
  const actions = editing ? '' : `<div class="scope-information-actions" aria-label="环境操作"><button type="button" class="button" data-resource-rename-environment="${escapeAttr(environment.environmentId)}">${icon('edit')}修改名称</button><button type="button" class="button danger-subtle" data-resource-delete-environment="${escapeAttr(environment.environmentId)}">${icon('trash')}删除环境</button></div>`;
  const inline = editor
    ? `<div class="scope-overview-inline">${renderResourceEnvironmentEditor(project.projectId,environment,editor)}</div>`
    : prompt ? `<div class="scope-overview-inline">${renderEnvironmentDeleteDecision(project.projectId,environment,prompt)}</div>` : '';
  const metadata = renderMetadataRows([
    ['所属项目',project.name],
    ['环境 ID',environment.environmentId,'code'],
    ['创建时间',formatScopeTimestamp(environment.createdAt)],
    ['最近更新',formatScopeTimestamp(environment.updatedAt)],
  ]);
  const summary = `${pluginCount} 个插件 · ${ready} 个已配置 · ${facts.connectedCount} 个已连接 · ${approvals} 个待确认`;
  return `<div class="scope-information-page scope-overview-page environment-summary-page"><span class="sr-only">环境信息</span><header class="scope-information-head scope-overview-head"><span class="scope-information-icon scope-overview-icon">${icon('environment')}</span><div class="scope-overview-title"><span class="scope-information-kind">环境概览</span><div><h1>${escapeHtml(environment.name)}</h1><span class="scope-status-badge" data-tone="${escapeAttr(status.tone)}"><i></i>${escapeHtml(status.label)}</span></div><p class="environment-summary-copy">${escapeHtml(summary)}</p></div>${actions}</header>${inline}<div class="environment-overview-content"><main class="environment-overview-primary"><section class="environment-overview-section environment-overview-attention"><header><div><h2>需要处理</h2><p>配置缺失、连接异常和待确认操作</p></div></header><div class="scope-overview-list">${renderEnvironmentAttention(project.projectId,environment,runtime)}</div></section><section class="environment-overview-section environment-plugin-summary"><header><div><h2>插件状态</h2><p>当前环境中的配置与连接状态</p></div><span>${pluginCount} 个插件</span></header><div class="scope-overview-list">${renderEnvironmentPluginRows(project,environment,runtime)}</div></section></main><aside class="environment-overview-support"><section class="environment-overview-section environment-profile-summary"><header><div><h2>环境资料</h2><p>用于识别当前环境的基本信息</p></div></header>${metadata}</section><section class="environment-overview-section environment-runbook-section"><header><div><h2>运维说明</h2><p>Agent 进入环境时读取的本地说明</p></div></header>${renderRunbookOverview(project,environment)}</section></aside></div></div>`;
}

function renderScopeInformation() {
  const project = activeProject();
  const content = $('#scopeInfoContent');
  if (!project) { content.innerHTML = ''; return; }
  if (state.selectionKind === 'project') {
    content.innerHTML = renderProjectInformation(project);
    loadScopeInformationSupplement(project).catch(() => {});
    return;
  }
  const environment = activeEnvironment();
  content.innerHTML = environment ? renderEnvironmentInformation(project,environment) : '';
  if (!environment) return;
  loadScopeInformationSupplement(project,environment).catch(() => {});
}

function beginProjectTitleEdit() {
  const project = activeProject();
  if (!project) return;
  if (projectIsIsolated(project)) { toast(project.configurationError.message,true); return; }
  state.projectTitleEditing = true;
  state.projectTitleDraft = project.name;
  renderScopeInformation();
  requestAnimationFrame(() => { const input = $('#projectTitleInput'); input?.focus(); input?.select(); });
}

function cancelProjectTitleEdit() {
  state.projectTitleEditing = false;
  state.projectTitleDraft = '';
  renderScopeInformation();
}

async function saveProjectTitleEdit() {
  const project = activeProject();
  if (!project || !state.projectTitleEditing) return;
  if (projectIsIsolated(project)) throw new Error(project.configurationError.message);
  const name = $('#projectTitleInput').value.trim();
  if (!name) {
    $('#projectTitleError').textContent = '请输入项目名称。';
    $('#projectTitleInput').focus();
    return;
  }
  const operationKey = `project-title-save:${project.projectId}`;
  const token = beginOperation(operationKey);
  if (!token) return;
  const saveButton = $('#saveProjectTitle');
  setElementBusy(saveButton,true);
  try {
    if (name !== project.name) {
      const value = await call(api.updateProject({projectId:project.projectId,patch:{name},expectedRevision:project.revision}));
      if (state.projectId !== project.projectId) return;
      Object.assign(project,value);
    }
    if (state.projectId !== project.projectId) return;
    state.projectTitleEditing = false;
    state.projectTitleDraft = '';
    renderShell();
    toast('项目名称已更新。');
  } finally {
    finishOperation(operationKey,token);
    if (saveButton.isConnected) setElementBusy(saveButton,false);
  }
}

function renderDetailTopbar() {
  if (state.confirmationCenterActive) {
    $('#detailTopTabs').innerHTML = '<button class="detail-top-tab active" data-confirmation-center-current>操作确认</button>';
    return;
  }
  const plugin = state.selectionKind === 'plugin' ? activePlugin() : null;
  const creatingPlugin = state.selectionKind === 'new-plugin';
  const projectSelected = state.selectionKind === 'project';
  const tabs = projectSelected
    ? [['information','项目信息']]
    : creatingPlugin
    ? [['configuration','添加插件']]
    : plugin
    ? [['connection','插件详情'],['configuration','配置'],['permissions','Agent 权限'],['audit','操作记录']]
    : [['information','概览'],['runbook','运维说明'],['audit','环境操作记录'],['quick-questions','快捷提问']];
  const active = projectSelected ? 'information' : creatingPlugin ? 'configuration' : plugin ? detailTab(plugin) : state.environmentDetailTab;
  $('#detailTopTabs').innerHTML = tabs.map(([value,label]) => `<button class="detail-top-tab ${active === value ? 'active' : ''}" data-detail-tab="${value}">${label}</button>`).join('');
}

function renderShell() {
  renderProjects();
  renderDetailPaneState();
  renderResourcePane();
  renderConfirmationButton();
  const project = activeProject();
  const environment = activeEnvironment();
  const scopeSelected = Boolean(project && (state.selectionKind === 'project' || environment));
  $('#emptyState').classList.toggle('hidden',Boolean(state.confirmationCenterActive || scopeSelected));
  if (state.confirmationCenterActive) {
    renderDetailTopbar();
    renderView();
    return;
  }
  if (!scopeSelected) {
    $('#detailTopTabs').innerHTML = '';
    ['pluginsView','pluginConfigView','scopeInfoView','runbookView','auditView','quickQuestionsView','confirmationView'].forEach((id) => $(`#${id}`).classList.add('hidden'));
    return;
  }
  renderDetailTopbar();
  renderView();
}

function continuitySelector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const attributes = [...element.attributes]
    .filter((attribute) => attribute.name.startsWith('data-') && attribute.value)
    .map((attribute) => `[${attribute.name}="${CSS.escape(attribute.value)}"]`)
    .join('');
  return attributes ? `${element.localName}${attributes}` : null;
}

function withUiContinuity(render) {
  const regions = ['projectList','resourceEnvironmentList','scopeInfoContent','pluginDetail','confirmationCenter','auditBody']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const scrollPositions = regions.map((element) => [element.id,element.scrollTop]);
  const active = document.activeElement;
  const activeRegion = regions.find((element) => element.contains(active));
  const activeSelector = activeRegion && continuitySelector(active);
  render();
  for (const [id,scrollTop] of scrollPositions) {
    const element = document.getElementById(id);
    if (element) element.scrollTop = scrollTop;
  }
  if (activeRegion && !active.isConnected && activeSelector) {
    const currentRegion = document.getElementById(activeRegion.id);
    currentRegion?.querySelector(activeSelector)?.focus({preventScroll:true});
    for (const [id,scrollTop] of scrollPositions) {
      const element = document.getElementById(id);
      if (element) element.scrollTop = scrollTop;
    }
  }
}

function scheduleRuntimeRender(runtime) {
  dirtyRuntimeScopes.add(scopeKey(runtime.projectId,runtime.environmentId));
  if (runtimeRenderFrame !== null) return;
  runtimeRenderFrame = requestAnimationFrame(() => {
    runtimeRenderFrame = null;
    const changedScopes = new Set(dirtyRuntimeScopes);
    dirtyRuntimeScopes.clear();
    withUiContinuity(() => {
      if (state.dragSort || state.sortSaving) state.railRefreshPending = true;
      else renderProjects();
      const currentProjectChanged = [...changedScopes].some((key) => key.startsWith(`${state.projectId}/`));
      if (state.projectOverviewActive && currentProjectChanged) renderProjectOverview();
      const currentScopeChanged = changedScopes.has(scopeKey());
      if (!state.projectOverviewActive && currentScopeChanged) renderRuntime();
    });
  });
}

function renderRuntime() {
  renderResourcePane();
  if (!state.confirmationCenterActive && state.view === 'plugins' && state.selectionKind === 'plugin') renderPluginDetail();
  else if (!state.confirmationCenterActive && state.view === 'plugin-config' && pluginFormVisible()) renderPluginFormDiagnostic();
  else if (!state.confirmationCenterActive && state.view === 'scope-info') renderScopeInformation();
}

function renderView() {
  const plugin = state.selectionKind === 'plugin' ? activePlugin() : null;
  if (state.confirmationCenterActive) state.view = 'confirmations';
  else if (state.selectionKind === 'project') state.view = 'scope-info';
  else if (state.selectionKind === 'new-plugin') state.view = 'plugin-config';
  else if (plugin) state.view = detailTab(plugin) === 'audit'
    ? 'audit'
    : detailTab(plugin) === 'configuration' && state.pluginEditSession?.scope?.pluginInstanceId === plugin.pluginInstanceId
      ? 'plugin-config'
      : 'plugins';
  else state.view = state.environmentDetailTab === 'information' ? 'scope-info' : state.environmentDetailTab;
  $('#pluginsView').classList.toggle('hidden',state.view !== 'plugins');
  $('#pluginConfigView').classList.toggle('hidden',state.view !== 'plugin-config');
  $('#scopeInfoView').classList.toggle('hidden',state.view !== 'scope-info');
  $('#runbookView').classList.toggle('hidden',state.view !== 'runbook');
  $('#auditView').classList.toggle('hidden',state.view !== 'audit');
  $('#quickQuestionsView').classList.toggle('hidden',state.view !== 'quick-questions');
  $('#confirmationView').classList.toggle('hidden',state.view !== 'confirmations');
  if (state.view === 'confirmations') renderConfirmationCenter();
  else if (state.view === 'plugins') renderPlugins();
  else if (state.view === 'plugin-config') renderInlinePluginConfig();
  else if (state.view === 'scope-info') renderScopeInformation();
  else if (state.view === 'runbook') {
    if (state.runbookScopeKey === scopeKey()) renderRunbook();
    else loadRunbook().catch(showError);
  } else if (state.view === 'quick-questions') {
    renderQuickQuestions();
    if (!state.quickQuestionOpeningLoaded && !state.quickQuestionOpeningLoading) loadQuickQuestionOpening().catch(showError);
    if (state.quickQuestionScopeKey !== scopeKey() && !state.quickQuestionLoading) loadQuickQuestions().catch(showError);
  } else loadAudit().catch(showError);
}

function pluginTarget(plugin) {
  if (plugin.pluginType === 'server') return `${plugin.auth?.username || '未配置'}@${plugin.target?.host || '未配置'}:${plugin.target?.port ?? 22}`;
  if (plugin.pluginType === 'mysql') return `${plugin.target?.host || '未配置主机'}:${plugin.target?.port ?? 3306} · ${plugin.target?.database || '未选择数据库'} · ${transportName(plugin)}`;
  return `DB ${plugin.target?.db ?? 0} · ${transportName(plugin)}`;
}
function providerName(id) { return state.plugins.find((item) => item.pluginInstanceId === id)?.displayName ?? id; }
function transportName(plugin) { if (plugin.transport?.kind === 'serverTunnel') return `经 ${providerName(plugin.transport.serverPluginInstanceId)} 隧道`; if (plugin.transport?.kind === 'windowsVpn') return `Windows VPN · ${plugin.transport.interfaceAlias || '未配置网卡'}`; return '直接连接'; }
function familyName(value) { return ({ ipv4Preferred:'IPv4 优先，失败尝试 IPv6',ipv4Only:'仅 IPv4',ipv6Preferred:'IPv6 优先，失败尝试 IPv4',ipv6Only:'仅 IPv6' })[value] ?? value ?? 'IPv4 优先，失败尝试 IPv6'; }
function uplinkName(plugin) { const uplink = plugin.uplink ?? { type:'direct' }; if (uplink.type === 'direct') return '直接连接'; if (uplink.type === 'windowsVpn') return `Windows VPN · ${uplink.interfaceAlias || '未配置网卡'}`; return `${uplink.type.toUpperCase()} · ${uplink.host}:${uplink.port}`; }

function pluginDiagnosticConfigurationIssue(plugin) {
  if (!plugin?.target?.host) return '缺少主机地址';
  if (plugin.pluginType === 'server') {
    if (!plugin.auth?.username) return '缺少 SSH 用户名';
    if (plugin.auth?.type === 'privateKey' && !plugin.auth.privateKeyPath) return '缺少 SSH 私钥文件';
    if (['socks5','http'].includes(plugin.uplink?.type) && !plugin.uplink.host) return '缺少代理地址';
    if (plugin.uplink?.type === 'windowsVpn' && !plugin.uplink.interfaceAlias) return '缺少 Windows VPN 网卡名称';
    return null;
  }
  if (plugin.pluginType === 'mysql' && !plugin.auth?.username) return '缺少 MySQL 用户名';
  if (plugin.transport?.kind === 'serverTunnel' && !plugin.transport.serverPluginInstanceId) return '未选择 Server 隧道';
  if (plugin.transport?.kind === 'windowsVpn' && !plugin.transport.interfaceAlias) return '缺少 Windows VPN 网卡名称';
  return null;
}

function pluginDiagnosticAvailable(plugin) { return !pluginDiagnosticConfigurationIssue(plugin); }
function mysqlDatabaseSelectionPending(plugin) { return plugin?.pluginType === 'mysql' && !plugin.target?.database && pluginDiagnosticAvailable(plugin); }

function renderPlugins() {
  renderPluginDetail();
}

function pluginItem(plugin) {
  const runtime = pluginRuntime(plugin.pluginInstanceId);
  const presentation = pluginConnectionViewModel(plugin,runtime);
  const status = presentation.label;
  const stateClass = presentation.stateClass;
  return `<button class="plugin-item ${plugin.pluginInstanceId === state.pluginId ? 'active' : ''}" data-plugin-id="${escapeAttr(plugin.pluginInstanceId)}"><span class="plugin-icon">${icon(typeIcons[plugin.pluginType])}</span><span class="plugin-copy"><strong>${escapeHtml(plugin.displayName)}</strong><small>${escapeHtml(pluginTarget(plugin))}</small></span><span class="state-dot ${escapeAttr(stateClass)}" title="${escapeAttr(status)}"></span></button>`;
}

function detailTab(plugin) { return state.detailTabs[pluginStateKey(plugin)] ?? 'connection'; }
function renderPluginDetail() {
  const plugin = activePlugin();
  if (!plugin) { $('#pluginDetail').innerHTML = '<div class="detail-empty"><div>选择一个插件查看详情</div></div>'; return; }
  const runtime = pluginRuntime(plugin.pluginInstanceId);
  const presentation = pluginConnectionViewModel(plugin,runtime);
  const tab = detailTab(plugin);
  const connectBusy = runtimeActionInFlight(plugin.projectId,plugin.environmentId,'connect',plugin.pluginInstanceId);
  const disconnectBusy = runtimeActionInFlight(plugin.projectId,plugin.environmentId,'disconnect',plugin.pluginInstanceId);
  const trustBusy = runtimeActionInFlight(plugin.projectId,plugin.environmentId,'trust-host',plugin.pluginInstanceId);
  const diagnosticBusy = scopeDiagnosticPending(plugin.projectId,plugin.environmentId,plugin.pluginInstanceId);
  state.detailTabs[pluginStateKey(plugin)] = tab;
  const error = runtime.error?.message ? `<div class="inline-error"><span>${escapeHtml(runtime.error.message)}</span>${runtime.reason === 'SSH_HOST_KEY_CONFIRM_REQUIRED' ? `<button class="button small" data-action="trust-host" ${trustBusy || diagnosticBusy ? 'disabled' : ''}${trustBusy ? ' aria-busy="true"' : ''}>确认指纹并重试</button>` : '<button class="button small" data-action="edit-plugin">检查配置</button>'}</div>` : '';
  const runtimeAction = presentation.action === 'continue-configuration'
    ? `<button class="button primary" data-action="edit-plugin">${mysqlDatabaseSelectionPending(plugin) ? '选择数据库' : '完善配置'}</button>`
    : presentation.action === 'disconnect'
    ? `<button class="button" data-action="disconnect-plugin" ${disconnectBusy || diagnosticBusy ? 'disabled' : ''}${disconnectBusy ? ' aria-busy="true"' : ''}>断开</button>`
    : ['connect','retry'].includes(presentation.action)
    ? `<button class="button primary" data-action="connect-plugin" ${connectBusy || diagnosticBusy ? 'disabled' : ''}${connectBusy ? ' aria-busy="true"' : ''}>${presentation.action === 'retry' ? '重试' : '连接'}</button>`
    : `<button class="button" disabled aria-disabled="true">${escapeHtml(presentation.label)}</button>`;
  const status = presentation.label;
  const stateClass = presentation.stateClass;
  const approvalScope = confirmationScopeData('plugin',plugin.projectId,plugin.environmentId,plugin.pluginInstanceId);
  const approvals = confirmationCount(approvalScope);
  const approvalButton = approvals ? `<button class="detail-confirmation-badge" ${confirmationScopeAttributes(approvalScope)}>${icon('shield')}<span>${approvals} 项待确认</span></button>` : '';
  const content = tab === 'configuration' ? renderConfiguration(plugin) : tab === 'permissions' ? renderPermissions(plugin) : renderConnection(plugin);
  $('#pluginDetail').innerHTML = `<header class="detail-head"><div class="detail-title-line"><span class="detail-icon">${icon(typeIcons[plugin.pluginType])}</span><div class="detail-title"><div class="detail-title-top"><h1>${escapeHtml(plugin.displayName)}</h1><span class="type-label">${typeNames[plugin.pluginType]}</span><span class="health ${escapeAttr(stateClass)}">${escapeHtml(status)}</span>${approvalButton}</div></div><div class="detail-actions">${runtimeAction}</div></div></header><div class="detail-content">${error}${content}</div>`;
}

function renderConfiguration(plugin) {
  const target = plugin.target ?? {};
  const presentation = pluginConnectionViewModel(plugin,pluginRuntime(plugin.pluginInstanceId));
  const rows = [
    ['配置完整性',presentation.configurationState === 'complete' ? '已配置' : '待完善'],
    ['主机',target.host ? `${target.host}:${target.port ?? ''}` : '未配置'],
    ['连接方式',plugin.pluginType === 'server' ? uplinkName(plugin) : transportName(plugin)],
    ['地址族',familyName(target.addressFamily)],
  ];
  if (plugin.pluginType === 'mysql') rows.push(['固定数据库',target.database || '未配置']);
  if (plugin.pluginType === 'redis') rows.push(['Logical DB',String(target.db ?? 0)]);
  if (plugin.pluginType !== 'server') rows.push(['TLS',plugin.tls?.mode ?? 'disabled']);
  const editingMetadata = state.metadataEditingPluginId === plugin.pluginInstanceId;
  const metadata = editingMetadata
    ? `<div class="inline-settings-form"><label class="field full">插件名称<input id="pluginMetadataName" maxlength="120" value="${escapeAttr(plugin.displayName)}"></label><div class="inline-settings-actions"><button class="button" data-action="cancel-plugin-metadata">取消</button><button class="button primary" data-action="save-plugin-metadata">保存名称</button></div></div>`
    : `<dl class="field-list"><dt>插件名称</dt><dd>${escapeHtml(plugin.displayName)}</dd></dl>`;
  const metadataActions = editingMetadata ? '' : `<div class="scope-information-actions" aria-label="插件操作"><button type="button" class="button" data-action="edit-plugin-metadata">${icon('edit')}修改名称</button><button type="button" class="button danger-subtle" data-action="prepare-delete-plugin">${icon('trash')}删除插件</button></div>`;
  return `<section class="connection-section plugin-information-section"><div class="content-title"><div><h2>基本信息</h2></div>${metadataActions}</div>${metadata}</section><section class="connection-section"><div class="content-title"><div><h2>连接配置</h2><p class="muted">当前为只读详情；修改前会预览影响并安装连接门禁。</p></div><button class="button" data-action="edit-plugin">${icon('edit')}修改连接配置</button></div><dl class="field-list">${rows.map(([key,value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl></section><section class="configuration-note">${icon('shield')}<span>密码和私钥口令只保存在本机安全存储中，不会在详情页显示。</span></section>`;
}

function diagnosticStepDefinitions(plugin) {
  if (plugin.pluginType === 'mysql') {
    return [
      { id:'configuration',label:'目标地址',detail:'检查主机、端口和连接路径' },
      { id:'connection',label:'身份认证',detail:'建立临时连接并完成 MySQL 认证' },
      { id:'protocol',label:'数据库访问',detail:'确认所选数据库可访问并能正常响应' },
    ];
  }
  const connectionLabel = plugin.pluginType === 'server' ? '网络、SSH 与认证' : plugin.pluginType === 'mysql' ? '路由、MySQL 与认证' : '路由、Redis 与认证';
  const protocolLabel = plugin.pluginType === 'server' ? 'SSH 会话确认' : plugin.pluginType === 'mysql' ? 'SELECT 1 健康检查' : 'PING 健康检查';
  return [
    { id:'configuration',label:'配置与依赖',detail:'检查必填项、凭据和上游依赖' },
    { id:'connection',label:connectionLabel,detail:'建立一次真实连接并完成认证' },
    { id:'protocol',label:protocolLabel,detail:'确认目标服务能够正常响应' },
  ];
}

function createPendingDiagnostic(plugin, requestId) {
  return {
    requestId,
    status:'pending',
    summary:'正在按顺序执行检查…',
    checks:diagnosticStepDefinitions(plugin).map((step,index) => ({...step,status:index === 0 ? 'pending' : 'queued',elapsedMs:null})),
  };
}

function diagnosticChecks(plugin, diagnostic) {
  const current = new Map((diagnostic.checks ?? []).map((check) => [check.id,check]));
  return diagnosticStepDefinitions(plugin).map((step) => ({...step,...current.get(step.id)}));
}

function elapsedText(elapsedMs) {
  if (!Number.isFinite(elapsedMs)) return '';
  if (elapsedMs < 1) return '<1 ms';
  return `${Math.round(elapsedMs).toLocaleString()} ms`;
}

function diagnosticIcon(check, index) {
  if (check.status === 'success') return icon('check');
  if (check.status === 'failure') return icon('x');
  if (check.status === 'pending') return icon('loader');
  return `<span>${index + 1}</span>`;
}

function renderDiagnosticContent(plugin, diagnostic) {
  const checks = diagnosticChecks(plugin,diagnostic);
  const completed = checks.filter((check) => check.status === 'success').length;
  const failed = checks.find((check) => check.status === 'failure');
  const status = diagnostic.status ?? 'idle';
  const title = status === 'success' ? `${completed} 项检查通过` : status === 'failure' ? `检查停在“${failed?.label ?? '连接'}”` : status === 'pending' ? '正在检查连接' : '确认当前配置能否实际使用';
  const subtitle = status === 'success'
    ? `${diagnostic.reused ? '复用活动连接' : '临时连接已释放'} · 环境状态未改变`
    : status === 'failure' ? '后续检查未继续执行' : status === 'pending' ? '上一项成功后才会开始下一项' : '依次检查配置、连接和协议响应';
  const total = Number.isFinite(diagnostic.totalElapsedMs) ? elapsedText(diagnostic.totalElapsedMs) : '';
  const steps = checks.map((check,index) => {
    const timing = check.status === 'pending' ? '检查中' : check.status === 'queued' ? '等待' : elapsedText(check.elapsedMs);
    return `<div class="diagnostic-step ${escapeAttr(check.status ?? 'queued')}"><span class="diagnostic-step-marker">${diagnosticIcon(check,index)}</span><span class="diagnostic-step-copy"><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></span><span class="diagnostic-step-time">${escapeHtml(timing)}</span></div>`;
  }).join('');
  const summaryText = status === 'success' && mysqlDatabaseSelectionPending(plugin)
    ? '基础连接正常。下一步查询并选择固定数据库，保存后即可连接环境。'
    : diagnostic.summary;
  const summary = summaryText ? `<p class="diagnostic-message ${escapeAttr(status)}">${escapeHtml(summaryText)}</p>` : '';
  return `<div class="diagnostic-overview ${escapeAttr(status)}"><span class="diagnostic-overview-icon">${icon(status === 'success' ? 'check' : status === 'failure' ? 'x' : status === 'pending' ? 'loader' : 'route')}</span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle)}</small></span>${total ? `<b>${escapeHtml(total)}</b>` : ''}</div><div class="diagnostic-steps">${steps}</div>${summary}`;
}

function serverAuthName(plugin) {
  return ({password:'密码',privateKey:'私钥',agent:'SSH Agent'})[plugin.auth?.type] ?? '未配置';
}

function tlsName(mode) {
  return ({disabled:'关闭',preferred:'加密（不校验证书）',required:'必须加密',verifyIdentity:'加密并校验证书身份'})[mode] ?? '关闭';
}

function renderConnection(plugin) {
  const fields = plugin.pluginType === 'server'
    ? [
      ['SSH 目标',`${plugin.auth?.username || ''}@${plugin.target.host}:${plugin.target.port}`,''],
      ['认证方式',serverAuthName(plugin),''],
      ['地址策略',familyName(plugin.target.addressFamily),''],
      ['主机指纹',plugin.target.hostKeyFingerprint || '首次成功连接时确认','wide mono'],
    ]
    : [
      ['服务端点',`${plugin.target.host}:${plugin.target.port}`,'mono'],
      [plugin.pluginType === 'mysql' ? '固定数据库' : 'Logical DB',plugin.pluginType === 'mysql' ? plugin.target.database : String(plugin.target.db),''],
      ['地址策略',familyName(plugin.target.addressFamily),''],
      ['TLS',tlsName(plugin.tls?.mode),''],
    ];
  const route = plugin.pluginType === 'server' ? ['本机', uplinkName(plugin), `${plugin.target.host}:${plugin.target.port}`] : plugin.transport?.kind === 'serverTunnel' ? ['本机',providerName(plugin.transport.serverPluginInstanceId),'SSH 隧道',`${plugin.target.host}:${plugin.target.port}`] : ['本机',transportName(plugin),`${plugin.target.host}:${plugin.target.port}`];
  const dependents = plugin.pluginType === 'server' ? state.plugins.filter((item) => item.transport?.serverPluginInstanceId === plugin.pluginInstanceId) : [];
  const facts = fields.map(([key,value,className]) => `<div class="connection-fact ${escapeAttr(className)}"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  const consumers = dependents.length ? `<div class="connection-consumers"><div class="connection-section-heading"><div><h3>隧道复用</h3><p>这些插件依赖当前 SSH 连接</p></div><span class="connection-count">${dependents.length}</span></div><div class="consumer-list">${dependents.map((item) => `<div class="consumer-row">${icon(typeIcons[item.pluginType])}<strong>${escapeHtml(item.displayName)}</strong><span>${typeNames[item.pluginType]} · ${escapeHtml(item.pluginType === 'mysql' ? item.target.database : `DB ${item.target.db}`)}</span></div>`).join('')}</div></div>` : '';
  return `<div class="connection-page"><section class="connection-information"><div class="connection-section-heading"><div><span class="connection-section-eyebrow">当前保存配置</span><h3>连接信息</h3><p>用于确认实际目标、认证边界与网络路径</p></div><button class="button" data-action="edit-plugin">${icon('edit')}修改连接配置</button></div><dl class="connection-facts">${facts}</dl><div class="connection-route-section"><div class="connection-route-heading"><strong>连接路径</strong><small>${escapeHtml(plugin.pluginType === 'server' ? 'SSH 上行' : '数据源访问路径')}</small></div><div class="route-line">${route.map((node,index) => `${index ? '<span class="route-arrow">→</span>' : ''}<span class="route-node">${escapeHtml(node)}</span>`).join('')}</div></div>${consumers}</section></div>`;
}

const permissionModeNames = { auto:'自动放行', confirm:'每次确认', strong:'强确认', deny:'默认拒绝' };
function limitSummary(plugin) { if (plugin.pluginType === 'mysql') return `只读固定数据库 ${plugin.target.database} · 单语句 · 最多 ${plugin.limits?.maxRows ?? 100} 行 · ${Math.round((plugin.limits?.timeoutMs ?? 10000)/1000)} 秒超时`; if (plugin.pluginType === 'redis') return `只读固定 DB ${plugin.target.db} · 最多 ${plugin.limits?.maxKeys ?? 100} 个 Key · 不允许 Agent 切库`; return '权限由应用内置风险表判定，Agent 不能自行声明“安全”；所有读取有资源上限，所有服务器变更逐次确认。'; }
function renderPermissions(plugin) {
  const rules = permissionRules[plugin.pluginType];
  const counts = rules.reduce((summary,rule) => ({...summary,[rule.mode]:(summary[rule.mode] ?? 0) + 1}),{});
  const overview = ['auto','confirm','strong','deny'].filter((mode) => counts[mode]).map((mode) => `<div class="permission-summary-item ${escapeAttr(mode)}"><strong>${counts[mode]}</strong><span>${escapeHtml(permissionModeNames[mode])}</span></div>`).join('');
  const rows = rules.map((rule) => `<article class="policy-row" data-mode="${escapeAttr(rule.mode)}"><span class="policy-row-icon">${icon(rule.icon)}</span><div class="policy-copy"><strong>${escapeHtml(rule.label)}</strong><span class="policy-detail">${escapeHtml(rule.detail)}</span></div><span class="policy-state ${escapeAttr(rule.mode)}">${escapeHtml(permissionModeNames[rule.mode])}</span></article>`).join('');
  const editing = state.agentEditingPluginId === plugin.pluginInstanceId;
  const limitField = plugin.pluginType === 'mysql'
    ? `<label class="field">最大返回行数<input id="pluginAgentResourceLimit" type="number" min="1" value="${Number(plugin.limits?.maxRows ?? 100)}"></label>`
    : plugin.pluginType === 'redis'
      ? `<label class="field">最大 Key 数<input id="pluginAgentResourceLimit" type="number" min="1" value="${Number(plugin.limits?.maxKeys ?? 100)}"></label>`
      : '';
  const editor = editing ? `<section class="agent-settings-editor"><div class="form-grid">${limitField}<label class="field">操作超时（毫秒）<input id="pluginAgentTimeout" type="number" min="100" value="${Number(plugin.limits?.timeoutMs ?? 10000)}"></label></div><div class="inline-settings-actions"><button class="button" data-action="cancel-plugin-agent">取消</button><button class="button primary" data-action="save-plugin-agent">保存 Agent 配置</button></div></section>` : '';
  return `<div class="permissions-page"><header class="permission-hero"><span class="permission-hero-icon">${icon('shield')}</span><div class="permission-hero-copy"><span class="permission-eyebrow">应用内置安全策略</span><h2>Agent 可执行范围</h2><p>权限由应用按操作风险强制判定，Agent 和插件数据源都不能修改或绕过。</p></div><div class="permission-summary">${overview}</div></header><div class="content-title"><div><h2>Agent 配置</h2><p class="muted">保存时保留网络连接，并重建后续请求使用的 Agent context。</p></div>${editing ? '' : '<button class="button" data-action="edit-plugin-agent">编辑 Agent 配置</button>'}</div>${editor}<section class="policy-section"><div class="policy-section-title"><span>固定执行规则</span><small>${rules.length} 项规则</small></div><div class="policy-list">${rows}</div></section><div class="policy-limits">${icon('shield')}<div><strong>边界与资源上限</strong><span>${escapeHtml(limitSummary(plugin))}</span></div></div></div>`;
}

function pluginMetadataPatch(displayName) {
  return {displayName:String(displayName ?? '').trim()};
}

async function savePluginMetadata() {
  const plugin = activePlugin();
  if (!plugin || state.metadataEditingPluginId !== plugin.pluginInstanceId) return;
  const patch = pluginMetadataPatch($('#pluginMetadataName').value);
  const displayName = patch.displayName;
  if (!displayName) throw new Error('插件名称不能为空。');
  const value = await call(api.updatePluginMetadata({
    projectId:plugin.projectId,environmentId:plugin.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,expectedRevision:plugin.revision,patch,
  }));
  Object.assign(plugin,value);
  state.metadataEditingPluginId = null;
  renderShell();
  toast('插件名称已保存；连接和凭据未改变。');
}

async function savePluginAgentConfiguration() {
  const plugin = activePlugin();
  if (!plugin || state.agentEditingPluginId !== plugin.pluginInstanceId) return;
  const limits = {...(plugin.limits ?? {}),timeoutMs:Number($('#pluginAgentTimeout').value)};
  const resourceLimit = $('#pluginAgentResourceLimit');
  if (resourceLimit) {
    if (plugin.pluginType === 'mysql') limits.maxRows = Number(resourceLimit.value);
    if (plugin.pluginType === 'redis') limits.maxKeys = Number(resourceLimit.value);
  }
  const value = await call(api.updatePluginAgentConfiguration({
    projectId:plugin.projectId,environmentId:plugin.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,expectedRevision:plugin.revision,patch:{limits},
  }));
  Object.assign(plugin,value);
  state.agentEditingPluginId = null;
  renderShell();
  toast('Agent 配置已保存；现有网络连接保持不变。');
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
  const requestedScope = { projectId:state.projectId, environmentId:state.environmentId };
  const requestedScopeKey = scopeKey(requestedScope.projectId,requestedScope.environmentId);
  const generation = ++state.runbookLoadGeneration;
  state.runbookContent = '';
  state.runbookDraft = '';
  state.runbookRevision = null;
  state.runbookScopeKey = requestedScopeKey;
  state.runbookEditing = false;
  state.runbookDirty = false;
  state.runbookLoading = true;
  renderRunbook();
  try {
    const result = await call(api.readRunbook(requestedScope));
    if (generation !== state.runbookLoadGeneration
      || requestedScopeKey !== scopeKey()
      || state.runbookScopeKey !== requestedScopeKey
      || state.runbookDirty) return;
    state.runbookContent = result.content ?? '';
    state.runbookDraft = state.runbookContent;
    state.runbookRevision = result.environment?.revision ?? activeEnvironment()?.revision ?? null;
    state.runbookEditing = false;
    state.runbookDirty = false;
  } catch (error) {
    if (generation === state.runbookLoadGeneration
      && requestedScopeKey === scopeKey()
      && state.runbookScopeKey === requestedScopeKey) throw error;
  } finally {
    if (generation === state.runbookLoadGeneration && state.runbookScopeKey === requestedScopeKey) {
      state.runbookLoading = false;
      if (state.view === 'runbook' && requestedScopeKey === scopeKey()) renderRunbook();
    }
  }
}
function runbookVisibleContent(runbookState = state) {
  return runbookState.runbookEditing ? runbookState.runbookDraft : runbookState.runbookContent;
}
function renderRunbook() {
  const environment = activeEnvironment();
  if (!environment) return;
  const visibleContent = runbookVisibleContent();
  $('#runbookTitle').textContent = `${environment.name} · 运维说明`;
  $('#runbookScope').textContent = activeProject().name;
  $('#runbookPreview').innerHTML = renderMarkdown(visibleContent);
  const editor = $('#runbookEditor');
  if (editor.value !== visibleContent) editor.value = visibleContent;
  const bytes = new TextEncoder().encode(visibleContent).length;
  $('#runbookBytes').textContent = `${bytes.toLocaleString()} / 65,536 字节`;
  $('#runbookBytes').classList.toggle('error-text', bytes > 65_536);
  const saveBusy = operationInFlight(`runbook-save:${scopeKey()}`);
  setElementBusy($('#saveRunbook'),saveBusy);
  $('#saveRunbook').disabled = saveBusy || state.runbookLoading || bytes > 65_536;
  $('#editRunbook').disabled = state.runbookLoading;
  $('#runbookPreview').classList.toggle('hidden', state.runbookEditing);
  editor.classList.toggle('hidden', !state.runbookEditing);
  $('#editRunbook').classList.toggle('hidden', state.runbookEditing);
  $('#saveRunbook').classList.toggle('hidden', !state.runbookEditing);
  $('#cancelRunbook').classList.toggle('hidden', !state.runbookEditing);
}

function currentQuickQuestionScope() {
  return { projectId:state.projectId, environmentId:state.environmentId };
}

function quickQuestionScopeIsCurrent(scope,generation = state.quickQuestionScopeGeneration) {
  return generation === state.quickQuestionScopeGeneration
    && scope.projectId === state.projectId
    && scope.environmentId === state.environmentId;
}

function quickQuestionOperationKey(action,questionId = '') {
  return `quick-question:${scopeKey()}:${action}${questionId ? `:${questionId}` : ''}`;
}

function quickQuestionMutationOperationKey() {
  return quickQuestionOperationKey('mutation');
}

function quickQuestionOpeningOperationKey(action) {
  return `quick-question-opening:${action}`;
}

function quickQuestionOpeningDialogIsOpen() {
  return Boolean($('#quickQuestionOpeningDialog')?.open);
}

function renderQuickQuestionItems() {
  const list = $('#quickQuestionCustomList');
  const empty = $('#quickQuestionCommonEmpty');
  const hasItems = state.quickQuestionItems.length > 0;
  const mutationBusy = operationInFlight(quickQuestionMutationOperationKey());
  list.classList.toggle('hidden',!hasItems);
  empty.classList.toggle('hidden',hasItems || state.quickQuestionLoading);
  list.replaceChildren();
  for (const item of state.quickQuestionItems) {
    const card = document.createElement('article');
    card.className = 'quick-question-common-card';
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'quick-question-custom-fill';
    fill.dataset.quickQuestionFill = item.questionId;
    fill.textContent = item.text;
    fill.title = item.text;
    const tools = document.createElement('span');
    tools.className = 'quick-question-common-tools';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.dataset.quickQuestionEdit = item.questionId;
    edit.setAttribute('aria-label',`编辑常见问题：${item.text}`);
    edit.innerHTML = icon('edit');
    edit.disabled = mutationBusy;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.quickQuestionDelete = item.questionId;
    remove.setAttribute('aria-label',`删除常见问题：${item.text}`);
    remove.innerHTML = icon('trash');
    remove.disabled = mutationBusy;
    tools.append(edit,remove);
    card.append(fill,tools);
    list.append(card);
  }
}

function syncQuickQuestionComposer() {
  const draft = state.quickQuestionDraft;
  const hasQuestion = Boolean(draft.trim());
  const sensitive = quickQuestionHasStrictCredential(draft);
  const mutationBusy = operationInFlight(quickQuestionMutationOperationKey());
  $('#quickQuestionCount').textContent = `${draft.length} / 1200`;
  $('#quickQuestionSensitiveWarning').classList.toggle('hidden',!sensitive);
  $('#quickQuestionLoading').classList.toggle('hidden',!state.quickQuestionLoading);
  const copyBusy = operationInFlight(quickQuestionOperationKey('copy'));
  const saveButton = $('#saveQuickQuestion');
  const copyButton = $('#copyQuickQuestion');
  setElementBusy(copyButton,copyBusy);
  saveButton.disabled = !hasQuestion || sensitive || state.quickQuestionLoading || state.quickQuestionRevision === null || mutationBusy;
  copyButton.disabled = !hasQuestion || copyBusy || !state.quickQuestionOpeningLoaded || state.quickQuestionOpeningRevision === null;
  $('#addQuickQuestionCommon').disabled = state.quickQuestionLoading || state.quickQuestionRevision === null || mutationBusy;
  $('#editQuickQuestionOpening').disabled = state.quickQuestionOpeningLoading || state.quickQuestionOpeningRevision === null;

  const preview = state.quickQuestionOpeningLoaded
    ? buildQuickQuestionPreview({
      opening:state.quickQuestionOpeningText,
      projectName:activeProject()?.name,
      environmentName:activeEnvironment()?.name,
      question:draft,
      discoveredDate:state.quickQuestionDiscoveredDate,
    })
    : '正在加载开场词…';
  $('#quickQuestionFinalPreview').textContent = preview;
}

function renderQuickQuestions() {
  const project = activeProject();
  const environment = activeEnvironment();
  if (!project || !environment) return;
  $('#quickQuestionProjectName').textContent = project.name;
  $('#quickQuestionEnvironmentName').textContent = environment.name;
  $('#quickQuestionOpeningText').textContent = state.quickQuestionOpeningLoaded
    ? state.quickQuestionOpeningText
    : '正在加载开场词…';
  $('#quickQuestionOpeningNotice').classList.add('hidden');
  const input = $('#quickQuestionInput');
  if (input.value !== state.quickQuestionDraft) input.value = state.quickQuestionDraft;
  const discoveredDate = $('#quickQuestionDiscoveredDate');
  if (discoveredDate.value !== state.quickQuestionDiscoveredDate) discoveredDate.value = state.quickQuestionDiscoveredDate;
  renderQuickQuestionItems();
  syncQuickQuestionComposer();
}

async function loadQuickQuestionOpening() {
  if (state.quickQuestionOpeningLoading) {
    state.quickQuestionOpeningRefreshPending = true;
    return;
  }
  const loadGeneration = ++state.quickQuestionOpeningLoadGeneration;
  state.quickQuestionOpeningLoading = true;
  state.quickQuestionOpeningRefreshPending = false;
  if (state.view === 'quick-questions') renderQuickQuestions();
  try {
    const normalized = normalizeQuickQuestionOpening(await call(api.getQuickQuestionOpening()));
    if (loadGeneration !== state.quickQuestionOpeningLoadGeneration) return;
    state.quickQuestionOpeningText = normalized.text;
    state.quickQuestionOpeningDefaultText = normalized.defaultText;
    state.quickQuestionOpeningRevision = normalized.revision;
    state.quickQuestionOpeningLoaded = true;
  } catch (error) {
    if (loadGeneration === state.quickQuestionOpeningLoadGeneration) state.quickQuestionOpeningLoaded = false;
    throw error;
  } finally {
    if (loadGeneration === state.quickQuestionOpeningLoadGeneration) {
      const shouldRefresh = state.quickQuestionOpeningRefreshPending;
      state.quickQuestionOpeningRefreshPending = false;
      state.quickQuestionOpeningLoading = false;
      if (state.view === 'quick-questions') renderQuickQuestions();
      if (shouldRefresh && !quickQuestionOpeningDialogIsOpen()) loadQuickQuestionOpening().catch(showError);
    }
  }
}

function requestQuickQuestionOpeningRefresh() {
  if (quickQuestionOpeningDialogIsOpen()) {
    state.quickQuestionOpeningEditorStale = true;
    syncQuickQuestionOpeningDialog();
    return;
  }
  state.quickQuestionOpeningLoaded = false;
  if (state.quickQuestionOpeningLoading) {
    state.quickQuestionOpeningRefreshPending = true;
    return;
  }
  if (state.view === 'quick-questions') loadQuickQuestionOpening().catch(showError);
}

async function loadQuickQuestions() {
  const requestedScope = currentQuickQuestionScope();
  if (!requestedScope.projectId || !requestedScope.environmentId) return;
  const requestedKey = scopeKey(requestedScope.projectId,requestedScope.environmentId);
  const scopeGeneration = state.quickQuestionScopeGeneration;
  const loadGeneration = ++state.quickQuestionLoadGeneration;
  const loadIsCurrent = () => quickQuestionScopeIsCurrent(requestedScope,scopeGeneration)
    && loadGeneration === state.quickQuestionLoadGeneration;
  state.quickQuestionScopeKey = requestedKey;
  state.quickQuestionLoading = true;
  state.quickQuestionRefreshPending = false;
  state.quickQuestionItems = [];
  state.quickQuestionRevision = null;
  if (state.view === 'quick-questions') renderQuickQuestions();
  try {
    const value = await call(api.listQuickQuestions(requestedScope));
    if (!loadIsCurrent()) return;
    const normalized = normalizeQuickQuestionResponse(value);
    state.quickQuestionItems = normalized.items;
    state.quickQuestionRevision = normalized.revision;
  } catch (error) {
    if (loadIsCurrent()) state.quickQuestionScopeKey = null;
    throw error;
  } finally {
    if (loadIsCurrent()) {
      const shouldRefresh = state.quickQuestionRefreshPending;
      state.quickQuestionRefreshPending = false;
      state.quickQuestionLoading = false;
      if (state.view === 'quick-questions') renderQuickQuestions();
      if ($('#quickQuestionCommonDialog')?.open) syncQuickQuestionCommonDialog();
      if (shouldRefresh && state.view === 'quick-questions') loadQuickQuestions().catch(showError);
    }
  }
}

function requestQuickQuestionRefresh(scope = currentQuickQuestionScope()) {
  if (!quickQuestionScopeIsCurrent(scope)) return;
  state.quickQuestionScopeKey = null;
  if (state.quickQuestionLoading) {
    state.quickQuestionRefreshPending = true;
    return;
  }
  if (state.view === 'quick-questions') loadQuickQuestions().catch(showError);
}

function fillQuickQuestion(text) {
  state.quickQuestionDraft = String(text ?? '').slice(0,1200);
  renderQuickQuestions();
  const input = $('#quickQuestionInput');
  input.focus();
  input.setSelectionRange(input.value.length,input.value.length);
}

function syncQuickQuestionOpeningDialog() {
  const input = $('#quickQuestionOpeningInput');
  const text = input.value;
  const issue = quickQuestionOpeningIssue(text);
  const busy = operationInFlight(quickQuestionOpeningOperationKey('save'));
  $('#quickQuestionOpeningCount').textContent = `${Array.from(text).length} / 500`;
  const error = $('#quickQuestionOpeningError');
  const message = issue || (state.quickQuestionOpeningEditorStale
    ? '设置已在其他窗口更新；你的编辑内容已保留。保存时会先校验最新版本。'
    : '');
  error.textContent = message;
  error.classList.toggle('hidden',!message);
  const save = $('#saveQuickQuestionOpening');
  setElementBusy(save,busy);
  save.disabled = Boolean(issue) || busy || state.quickQuestionOpeningRevision === null;
  $('#resetQuickQuestionOpening').disabled = busy || !state.quickQuestionOpeningDefaultText;
}

function openQuickQuestionOpeningDialog() {
  if (!state.quickQuestionOpeningLoaded || state.quickQuestionOpeningRevision === null) return;
  state.quickQuestionOpeningEditorStale = false;
  $('#quickQuestionOpeningInput').value = state.quickQuestionOpeningText;
  syncQuickQuestionOpeningDialog();
  $('#quickQuestionOpeningDialog').showModal();
  $('#quickQuestionOpeningInput').focus();
}

async function saveQuickQuestionOpeningSetting() {
  const text = $('#quickQuestionOpeningInput').value.trim();
  const issue = quickQuestionOpeningIssue(text);
  if (issue || state.quickQuestionOpeningRevision === null) {
    syncQuickQuestionOpeningDialog();
    return;
  }
  const operationKey = quickQuestionOpeningOperationKey('save');
  const token = beginOperation(operationKey);
  if (!token) return;
  syncQuickQuestionOpeningDialog();
  try {
    const normalized = normalizeQuickQuestionOpening(await call(api.saveQuickQuestionOpening({
      text,
      expectedRevision:state.quickQuestionOpeningRevision,
    })));
    state.quickQuestionOpeningText = normalized.text;
    state.quickQuestionOpeningDefaultText = normalized.defaultText;
    state.quickQuestionOpeningRevision = normalized.revision;
    state.quickQuestionOpeningLoaded = true;
    state.quickQuestionOpeningEditorStale = false;
    $('#quickQuestionOpeningDialog').close();
    if (state.view === 'quick-questions') renderQuickQuestions();
    toast('开场词已更新，所有环境都会使用。');
  } catch (error) {
    if (error?.code !== 'CONFIG_REVISION_CONFLICT') throw error;
    try {
      await loadQuickQuestionOpening();
      state.quickQuestionOpeningEditorStale = true;
      syncQuickQuestionOpeningDialog();
      toast('开场词已更新，你的编辑内容已保留；请确认后再次保存。',true);
    } catch (refreshError) {
      throw refreshError;
    }
  } finally {
    finishOperation(operationKey,token);
    if (quickQuestionOpeningDialogIsOpen()) syncQuickQuestionOpeningDialog();
  }
}

function quickQuestionCommonDialogIssue(value) {
  const text = String(value ?? '').trim();
  if (!text) return '问题正文不能为空。';
  if (Array.from(text).length > 1200) return '问题正文不能超过 1200 个字符。';
  if (quickQuestionHasStrictCredential(text)) return '常见问题不能包含密码、密钥或其他明确凭据。';
  return null;
}

function syncQuickQuestionCommonDialog() {
  const input = $('#quickQuestionCommonInput');
  const text = input.value;
  const issue = quickQuestionCommonDialogIssue(text);
  const operationKey = quickQuestionMutationOperationKey();
  const busy = operationInFlight(operationKey);
  $('#quickQuestionCommonCount').textContent = `${Array.from(text).length} / 1200`;
  $('#quickQuestionCommonError').textContent = issue || '';
  $('#quickQuestionCommonError').classList.toggle('hidden',!issue);
  const save = $('#saveQuickQuestionFromDialog');
  setElementBusy(save,busy);
  save.disabled = Boolean(issue) || busy || state.quickQuestionRevision === null;
  const remove = $('#deleteQuickQuestionFromDialog');
  remove.classList.toggle('hidden',!state.quickQuestionEditingId);
  remove.disabled = busy;
}

function openQuickQuestionCommonDialog(item = null, initialText = '') {
  if (state.quickQuestionRevision === null || operationInFlight(quickQuestionMutationOperationKey())) return;
  const project = activeProject();
  const environment = activeEnvironment();
  if (!project || !environment) return;
  state.quickQuestionEditingId = item?.questionId ?? null;
  $('#quickQuestionCommonDialogTitle').textContent = item ? '编辑常见问题' : '新增常见问题';
  $('#quickQuestionCommonDialogScope').textContent = `${project.name} / ${environment.name}`;
  $('#quickQuestionCommonInput').value = item?.text ?? initialText;
  syncQuickQuestionCommonDialog();
  $('#quickQuestionCommonDialog').showModal();
  $('#quickQuestionCommonInput').focus();
}

async function saveQuickQuestionFromDialog() {
  const text = $('#quickQuestionCommonInput').value.trim();
  const issue = quickQuestionCommonDialogIssue(text);
  if (issue || state.quickQuestionRevision === null) {
    syncQuickQuestionCommonDialog();
    return;
  }
  const requestedScope = currentQuickQuestionScope();
  const requestedGeneration = state.quickQuestionScopeGeneration;
  const questionId = state.quickQuestionEditingId;
  const operationKey = quickQuestionMutationOperationKey();
  const token = beginOperation(operationKey);
  if (!token) return;
  syncQuickQuestionCommonDialog();
  if (state.view === 'quick-questions') renderQuickQuestions();
  try {
    const value = await call(api.saveQuickQuestion({
      ...requestedScope,
      ...(questionId ? {questionId} : {}),
      text,
      expectedRevision:state.quickQuestionRevision,
    }));
    if (!quickQuestionScopeIsCurrent(requestedScope,requestedGeneration)) return;
    const normalized = normalizeQuickQuestionResponse(value);
    state.quickQuestionItems = normalized.items;
    state.quickQuestionRevision = normalized.revision;
    state.quickQuestionEditingId = null;
    $('#quickQuestionCommonDialog').close();
    renderQuickQuestions();
    toast(questionId ? '常见问题已更新。' : '已保存为当前环境的常见问题。');
  } catch (error) {
    if (error?.code === 'CONFIG_REVISION_CONFLICT') {
      requestQuickQuestionRefresh(requestedScope);
      toast('常见问题已在其他窗口更新；你的编辑内容已保留，请稍后重试。',true);
      return;
    }
    throw error;
  } finally {
    finishOperation(operationKey,token);
    if ($('#quickQuestionCommonDialog').open) syncQuickQuestionCommonDialog();
    if (quickQuestionScopeIsCurrent(requestedScope,requestedGeneration)) renderQuickQuestions();
  }
}

async function deleteCurrentQuickQuestion(questionId,{closeDialog = false} = {}) {
  if (!questionId || state.quickQuestionRevision === null) return;
  const requestedScope = currentQuickQuestionScope();
  const requestedGeneration = state.quickQuestionScopeGeneration;
  const operationKey = quickQuestionMutationOperationKey();
  const token = beginOperation(operationKey);
  if (!token) return;
  renderQuickQuestions();
  try {
    const value = await call(api.deleteQuickQuestion({
      ...requestedScope,
      questionId,
      expectedRevision:state.quickQuestionRevision,
    }));
    if (!quickQuestionScopeIsCurrent(requestedScope,requestedGeneration)) return;
    const normalized = normalizeQuickQuestionResponse(value);
    state.quickQuestionItems = normalized.items;
    state.quickQuestionRevision = normalized.revision;
    if (closeDialog && $('#quickQuestionCommonDialog').open) $('#quickQuestionCommonDialog').close();
    if (state.quickQuestionEditingId === questionId) state.quickQuestionEditingId = null;
    renderQuickQuestions();
    toast('已删除常见问题。');
  } catch (error) {
    if (error?.code === 'CONFIG_REVISION_CONFLICT') requestQuickQuestionRefresh(requestedScope);
    throw error;
  } finally {
    finishOperation(operationKey,token);
    if (quickQuestionScopeIsCurrent(requestedScope,requestedGeneration)) renderQuickQuestions();
  }
}

async function copyCurrentQuickQuestion() {
  const text = state.quickQuestionDraft.trim();
  if (!text || state.quickQuestionOpeningRevision === null) return;
  const requestedScope = currentQuickQuestionScope();
  const requestedGeneration = state.quickQuestionScopeGeneration;
  const operationKey = quickQuestionOperationKey('copy');
  const token = beginOperation(operationKey);
  if (!token) return;
  syncQuickQuestionComposer();
  try {
    const value = await call(api.copyQuickQuestion({
      ...requestedScope,
      text,
      ...(state.quickQuestionDiscoveredDate ? {discoveredDate:state.quickQuestionDiscoveredDate} : {}),
      expectedOpeningRevision:state.quickQuestionOpeningRevision,
    }));
    if (value?.copied === false) throw new Error('复制失败，请重试。');
    if (quickQuestionScopeIsCurrent(requestedScope,requestedGeneration)) toast('已复制，可粘贴到 Agent');
  } catch (error) {
    if (error?.code !== 'CONFIG_REVISION_CONFLICT') throw error;
    await loadQuickQuestionOpening();
    if (quickQuestionScopeIsCurrent(requestedScope,requestedGeneration)) {
      toast('开场词已更新，预览已刷新；请再次复制。',true);
    }
  } finally {
    finishOperation(operationKey,token);
    if (quickQuestionScopeIsCurrent(requestedScope,requestedGeneration)) syncQuickQuestionComposer();
  }
}

function currentAuditScope() {
  return {
    projectId:state.projectId,
    environmentId:state.environmentId,
    pluginInstanceId:state.selectionKind === 'plugin' ? state.pluginId : null,
  };
}
function auditScopeKey(scope) {
  return JSON.stringify([scope.projectId,scope.environmentId,scope.pluginInstanceId ?? null]);
}
function auditScopeIsCurrent(scope) {
  const current = currentAuditScope();
  return state.view === 'audit'
    && scope.projectId === current.projectId
    && scope.environmentId === current.environmentId
    && scope.pluginInstanceId === current.pluginInstanceId;
}
function syncAuditRefreshBusy() {
  const button = $('#refreshAudit');
  if (!button) return;
  const busy = state.view === 'audit' && auditLoadPromises.has(auditScopeKey(currentAuditScope()));
  setElementBusy(button,busy);
}
async function refreshAuditAfterMutation(scope) {
  state.auditLoadGeneration += 1;
  const pending = auditLoadPromises.get(auditScopeKey(scope));
  if (pending) {
    try { await pending.promise; } catch { /* A fresh read below owns visible error handling. */ }
  }
  if (auditScopeIsCurrent(scope)) await loadAudit();
}
function trackAuditLoad(requestKey,generation,request) {
  const record = {generation,promise:null};
  record.promise = Promise.resolve(request).finally(() => {
    if (auditLoadPromises.get(requestKey) === record) auditLoadPromises.delete(requestKey);
    syncAuditRefreshBusy();
  });
  auditLoadPromises.set(requestKey,record);
  syncAuditRefreshBusy();
  return record.promise;
}
function beginAuditLoad(requestedScope,requestKey,generation) {
  const request = (async () => {
    let result;
    try {
      result = await call(api.listAudit({ ...requestedScope, limit:200 }));
    } catch (error) {
      if (generation === state.auditLoadGeneration && auditScopeIsCurrent(requestedScope)) throw error;
      return;
    }
    if (generation !== state.auditLoadGeneration || !auditScopeIsCurrent(requestedScope)) return;
    state.auditEntries = result.entries ?? [];
    renderAudit();
  })();
  return trackAuditLoad(requestKey,generation,request);
}
function loadAudit() {
  const requestedScope = currentAuditScope();
  const requestKey = auditScopeKey(requestedScope);
  const existing = auditLoadPromises.get(requestKey);
  if (existing?.generation === state.auditLoadGeneration) {
    syncAuditRefreshBusy();
    return existing.promise;
  }
  const generation = ++state.auditLoadGeneration;
  if (existing) {
    const request = existing.promise.catch(() => {}).then(() => {
      if (generation !== state.auditLoadGeneration || !auditScopeIsCurrent(requestedScope)) return;
      return beginAuditLoad(requestedScope,requestKey,generation);
    });
    return trackAuditLoad(requestKey,generation,request);
  }
  return beginAuditLoad(requestedScope,requestKey,generation);
}
function auditResult(entry) {
  const value = String(entry.result ?? (entry.errorCode ? 'error' : 'success')).toLowerCase();
  if (['success','connected','disconnected','complete','completed'].includes(value)) return 'success';
  if (value === 'pending-confirmation') return 'pending';
  if (value === 'cancelled') return 'cancelled';
  if (['partial','warning','needs-action'].includes(value)) return 'warning';
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
  if (entry.type === 'connection-plan-completed') return '执行连接计划';
  if (entry.type === 'connection-plan-resumed') return '恢复连接计划';
  if (entry.type === 'environment-connect-cancelled') return '取消环境连接';
  if (entry.type === 'plugin-draft-saved') return '保存旧版临时配置';
  if (entry.type === 'plugin-draft-promoted') return '完成插件配置';
  if (entry.type === 'plugin-draft-deleted') return '删除旧版临时配置';
  if (entry.type === 'plugin-policy-updated') return '修改 Agent 权限';
  if (entry.type === 'runbook-updated') return '更新运维说明';
  if (entry.type === 'confirmation-approved') return '确认 Agent 操作';
  if (entry.type === 'confirmation-rejected') return '拒绝 Agent 操作';
  if (entry.type === 'plugin-operation-decision') return auditCapabilityName(entry.capability ?? 'Agent 操作');
  if (entry.type === 'environment-disconnected') return '断开环境';
  if (entry.type?.startsWith('environment-')) return '连接环境';
  if (entry.type === 'host-key-change-approved' || entry.type === 'server-host-key-trusted') return '确认服务器指纹';
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
  if (entry.type === 'plugin-added') return entry.operationSummary ?? (entry.configState === 'ready' ? '插件已配置并保持断开' : '插件已添加，等待补充配置');
  if (entry.errorCode) return auditErrorName(entry.errorCode);
  if (entry.operationSummary) return `${entry.actor === 'agent' ? 'Agent' : '用户'} · ${entry.operationSummary}${Number.isFinite(entry.durationMs) ? ` · ${entry.durationMs} ms` : ''}`;
  if (Number.isFinite(entry.durationMs)) return `耗时 ${entry.durationMs} ms`;
  return '已完成';
}
function auditEntryVisible(entry) {
  if (!entry?.type || entry.type === 'plugin-operation-started' || entry.type === 'connect') return false;
  if (entry.type === 'disconnect' && entry.result !== 'connection-lost') return false;
  if (entry.type === 'environment-disconnected' && entry.reason === 'app-exit') return false;
  return true;
}
function visibleAuditEntries() {
  return state.auditEntries.filter((entry) => {
    if (state.selectionKind === 'plugin' && entry.pluginInstanceId !== state.pluginId) return false;
    return auditEntryVisible(entry);
  }).sort((left,right) => new Date(right.time).getTime() - new Date(left.time).getTime());
}
function auditDateLabel(date) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(),today.getMonth(),today.getDate() - 1);
  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
  if (key === todayKey) return '今天';
  if (key === yesterdayKey) return '昨天';
  return date.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'});
}
function renderAudit() {
  const environment = activeEnvironment();
  if (!environment) return;
  const plugin = state.selectionKind === 'plugin' ? activePlugin() : null;
  $('#auditTitle').textContent = plugin ? `${plugin.displayName} · 操作记录` : `${environment.name} · 环境操作记录`;
  $('#auditScopeHint').textContent = plugin ? '仅展示当前插件的用户、Agent 与系统记录' : '展示当前环境全部插件的用户、Agent 与系统记录';
  const clearLabel = plugin ? '清除当前插件记录' : '清除当前环境记录';
  $('#clearAudit').innerHTML = `${icon('trash')}<span>${clearLabel}</span>`;
  $('#clearAudit').disabled = visibleAuditEntries().length === 0;
  const query = $('#auditSearch').value.trim().toLocaleLowerCase('zh-CN');
  const resultFilter = $('#auditResult').value;
  const rows = visibleAuditEntries().filter((entry) => {
    const result = auditResult(entry);
    const text = [auditOperationName(entry),auditPluginName(entry),auditDescription(entry)].join(' ').toLocaleLowerCase('zh-CN');
    return (!resultFilter || result === resultFilter) && (!query || text.includes(query));
  });
  const resultNames = { success:'成功',pending:'等待确认',warning:'部分成功',cancelled:'已取消',blocked:'已拦截',error:'失败' };
  const groups = new Map();
  for (const entry of rows) {
    const date = new Date(entry.time);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (!groups.has(key)) groups.set(key,{date,entries:[]});
    groups.get(key).entries.push(entry);
  }
  $('#auditBody').innerHTML = [...groups.values()].map(({date,entries}) => `<section class="audit-date-group"><h2 class="audit-date-label">${escapeHtml(auditDateLabel(date))}</h2>${entries.map((entry) => {
    const result = auditResult(entry);
    const instant = new Date(entry.time);
    const actor = auditActorName(entry);
    return `<article class="audit-record"><time datetime="${escapeAttr(instant.toISOString())}">${escapeHtml(instant.toLocaleTimeString('zh-CN',{hour12:false}))}</time><span class="audit-actor ${escapeAttr(actor.toLowerCase())}">${escapeHtml(actor)}</span><div class="audit-event"><div class="audit-event-title"><strong>${escapeHtml(auditOperationName(entry))}</strong><span> · ${escapeHtml(auditPluginName(entry))}</span></div><p>${escapeHtml(auditDescription(entry))}</p></div><span class="result ${escapeAttr(result)}">${escapeHtml(resultNames[result])}</span></article>`;
  }).join('')}</section>`).join('');
  $('#auditEmpty').classList.toggle('hidden', rows.length > 0);
  $('#auditBody').classList.toggle('hidden', rows.length === 0);
}

function prepareClearAudit() {
  const environment = activeEnvironment();
  if (!environment) return;
  const plugin = state.selectionKind === 'plugin' ? activePlugin() : null;
  state.clearingAuditScope = {
    projectId:state.projectId,
    environmentId:state.environmentId,
    pluginInstanceId:plugin?.pluginInstanceId ?? null,
  };
  $('#clearAuditScope').textContent = plugin
    ? `${environment.name} / ${plugin.displayName} · 仅当前插件`
    : `${environment.name} · 当前环境全部插件`;
  $('#confirmClearAudit').textContent = plugin ? '清除插件记录' : '清除环境记录';
  $('#clearAuditDialog').showModal();
}

async function clearSelectedAudit() {
  const scope = state.clearingAuditScope;
  if (!scope) return;
  const button = $('#confirmClearAudit');
  button.disabled = true;
  try {
    const result = await call(api.clearAudit(scope));
    $('#clearAuditDialog').close();
    state.clearingAuditScope = null;
    await refreshAuditAfterMutation(scope);
    toast(result.deletedCount > 0 ? `已清除 ${result.deletedCount.toLocaleString()} 条操作记录。` : '当前范围没有可清除的操作记录。');
  } finally {
    button.disabled = false;
  }
}

function beginResourceEnvironmentRename(projectId,environmentId) {
  const project = state.projects.find((item) => item.projectId === projectId);
  const environment = environmentFor(projectId,environmentId);
  if (!project || !environment) return;
  if (projectIsIsolated(project)) { toast(project.configurationError.message,true); return; }
  state.resourceEnvironmentDeletePrompt = null;
  state.resourceEnvironmentEditor = {
    projectId,
    environmentId,
    name:environment.name,
    sequence:++state.resourceEnvironmentEditSequence,
  };
  renderScopeInformation();
  requestAnimationFrame(() => {
    const input = $(`[data-resource-environment-editor="${CSS.escape(environmentId)}"] input`);
    input?.focus();
    input?.select();
  });
}

function cancelResourceEnvironmentRename() {
  state.resourceEnvironmentEditor = null;
  renderScopeInformation();
}

async function saveResourceEnvironmentName(form) {
  const projectId = form.dataset.resourceProjectId;
  const environmentId = form.dataset.resourceEnvironmentEditor;
  const editor = resourceEnvironmentEditorFor(projectId,environmentId);
  const environment = environmentFor(projectId,environmentId);
  const input = form.querySelector('input');
  const error = form.querySelector('.resource-environment-rename-error');
  const submit = form.querySelector('[type="submit"]');
  if (!editor || !environment || !input || !submit || submit.disabled) return;
  editor.name = input.value;
  const name = input.value.trim();
  if (!name) {
    error.textContent = '请输入环境名称。';
    input.focus();
    return;
  }
  if (name === environment.name) {
    state.resourceEnvironmentEditor = null;
    renderScopeInformation();
    return;
  }
  const sequence = editor.sequence;
  const expectedRevision = environment.revision;
  for (const button of form.querySelectorAll('button')) button.disabled = true;
  try {
    const updated = await call(api.updateEnvironment({projectId,environmentId,patch:{name},expectedRevision}));
    const current = environmentFor(projectId,environmentId);
    if (current && Number(current.revision ?? 0) <= Number(updated?.revision ?? 0)) Object.assign(current,updated);
    if (state.resourceEnvironmentEditor?.sequence === sequence) state.resourceEnvironmentEditor = null;
    let refreshError = null;
    try { await refreshWorkspaceOverview({render:false}); }
    catch (caught) { refreshError = caught; }
    state.environments = state.environmentsByProject[state.projectId] ?? [];
    renderShell();
    if (refreshError) toast(`环境名称已保存，但列表刷新失败：${refreshError.message}`,true);
    else toast('环境名称已更新。');
  } finally {
    if (form.isConnected) for (const button of form.querySelectorAll('button')) button.disabled = false;
  }
}

function openEnvironmentDelete(projectId,environmentId) {
  const project = state.projects.find((item) => item.projectId === projectId);
  if (!project) return;
  if (projectIsIsolated(project)) { toast(project.configurationError.message,true); return; }
  const environments = state.environmentsByProject[projectId] ?? [];
  const environment = environments.find((item) => item.environmentId === environmentId);
  if (!environment) return;
  let message = `确定删除“${environment.name}”的配置和运维说明？本机加密凭据会继续保留。`;
  let confirmable = true;
  if (environments.length <= 1) { message = '项目至少需要保留一个环境'; confirmable = false; }
  else if (environment.pluginCount) { message = `请先处理该环境的 ${environment.pluginCount} 个插件`; confirmable = false; }
  const runtime = state.runtimeByScope[scopeKey(projectId,environmentId)];
  if (confirmable && (runtime?.desiredConnected || (runtime && runtime.phase !== 'disconnected'))) { message = '请先断开该环境'; confirmable = false; }
  state.resourceEnvironmentEditor = null;
  state.resourceEnvironmentDeletePrompt = {projectId,environmentId,message,confirmable};
  renderScopeInformation();
}

async function confirmResourceEnvironmentDelete(target) {
  const projectId = target.dataset.resourceProjectId;
  const environmentId = target.dataset.resourceConfirmEnvironmentDelete;
  const environments = state.environmentsByProject[projectId] ?? [];
  const environment = environments.find((item) => item.environmentId === environmentId);
  const prompt = state.resourceEnvironmentDeletePrompt;
  if (!environment || prompt?.projectId !== projectId || prompt.environmentId !== environmentId || !prompt.confirmable) return;
  const index = environments.findIndex((item) => item.environmentId === environmentId);
  const nextEnvironmentId = environments[index + 1]?.environmentId ?? environments[index - 1]?.environmentId ?? null;
  const deletingCurrent = projectId === state.projectId && environmentId === state.environmentId;
  if (deletingCurrent && !await mayLeaveCurrentScope()) return;
  try {
    await deleteEnvironmentOnce(projectId,environmentId,target,async () => {
      if (state.resourceEnvironmentDeletePrompt?.projectId === projectId
        && state.resourceEnvironmentDeletePrompt.environmentId === environmentId) state.resourceEnvironmentDeletePrompt = null;
      await refreshWorkspaceOverview({render:false});
      state.environments = state.environmentsByProject[state.projectId] ?? [];
      if (deletingCurrent && nextEnvironmentId) await openScope(projectId,nextEnvironmentId,{skipLeaveCheck:true});
      else renderShell();
      toast(`“${environment.name}”的配置已删除；本机加密凭据仍保留。`);
    });
  } catch (error) {
    if (state.resourceEnvironmentDeletePrompt?.projectId === projectId
      && state.resourceEnvironmentDeletePrompt.environmentId === environmentId) {
      state.resourceEnvironmentDeletePrompt = {projectId,environmentId,message:error?.message ?? '删除失败',confirmable:false};
      renderScopeInformation();
    } else showError(error);
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
  const grid = $('#pluginFormGrid');
  const body = pluginFormElement()?.querySelector('.plugin-dialog-body');
  if (!grid || !body || matchMedia('(prefers-reduced-motion: reduce)').matches) {
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

function pluginFormElement() { return $('.plugin-card'); }
function pluginFormActive() { return Boolean(pluginFormElement()?.closest('#pluginInlineFormHost')); }
function pluginFormVisible() {
  return pluginFormActive()
    && state.view === 'plugin-config'
    && !$('#pluginConfigView')?.classList.contains('hidden');
}
function mountPluginForm() {
  const form = pluginFormElement();
  if (!form) return;
  state.pluginFormMode = 'inline';
  form.classList.add('inline-plugin-form');
  $('#pluginInlineFormHost').append(form);
}
function unmountPluginForm() {
  const form = pluginFormElement();
  if (!form) return;
  form.classList.remove('inline-plugin-form');
  $('#pluginFormDepot')?.append(form);
}

function renderPluginTypePicker() {
  const picker = $('#pluginTypePicker');
  if (!picker) return;
  const visible = state.selectionKind === 'new-plugin' && !state.newPluginType;
  picker.classList.toggle('hidden',!visible);
  if (!visible) return;
  $('#pluginTypePickerScope').textContent = `${activeProject().name} / ${activeEnvironment().name}`;
  $('#pluginTypeChoices').innerHTML = pluginCatalog.map((definition) => `<label class="type-choice"><input type="radio" name="pluginTypeChoice" value="${escapeAttr(definition.type)}"><span>${icon(definition.icon)}<strong>${escapeHtml(definition.label)}</strong><small>${escapeHtml(definition.summary)}</small></span></label>`).join('');
  $$('[name=pluginTypeChoice]').forEach((radio) => {
    radio.checked = false;
    radio.disabled = false;
  });
}

function pluginEditImpactMessage(preview, plugin) {
  const connected = preview.preEditConnectedSet?.length ?? 0;
  const affected = preview.affectedIds?.length ?? 1;
  const active = (preview.activeOperations?.connection?.length ?? 0) + (preview.activeOperations?.workspace?.length ?? 0);
  const impact = connected
    ? `将先安全断开 ${connected} 个连接，保存或取消后可按原状态恢复。`
    : '当前没有需要断开的正式连接。';
  const waiting = active ? ` 还需等待 ${active} 个正在进行的操作结束。` : '';
  return `修改“${plugin.displayName}”的连接配置会影响 ${affected} 个插件。\n\n${impact}${waiting}\n\n继续进入编辑吗？`;
}

function pluginEditRequiresConfirmation(preview) {
  const connected = preview.preEditConnectedSet?.length ?? 0;
  const active = (preview.activeOperations?.connection?.length ?? 0) + (preview.activeOperations?.workspace?.length ?? 0);
  return connected > 0 || active > 0;
}

async function beginPluginConnectionEditor(plugin) {
  if (!plugin || state.pluginEditSession || state.pluginEditPreparation) return false;
  const scope = {
    projectId:plugin.projectId ?? state.projectId,
    environmentId:plugin.environmentId ?? state.environmentId,
    pluginInstanceId:plugin.pluginInstanceId,
    expectedRevision:plugin.revision,
  };
  const preview = await call(api.preparePluginConnectionEdit(scope));
  state.pluginEditPreparation = {...preview,scope};
  if (pluginEditRequiresConfirmation(preview) && !confirm(pluginEditImpactMessage(preview,plugin))) {
    try { await call(api.cancelPluginConnectionEdit({prepareToken:preview.prepareToken})); }
    finally { state.pluginEditPreparation = null; }
    return false;
  }
  try {
    const session = await call(api.beginPluginConnectionEdit({prepareToken:preview.prepareToken}));
    if (!scopeMatches(scope,{plugin:true}) || state.pluginId !== plugin.pluginInstanceId) {
      await call(api.cancelPluginConnectionEdit({editSessionId:session.editSessionId,restorePreEditConnections:true}));
      return false;
    }
    state.pluginEditSession = {
      ...session,
      baseRecordRevision:plugin.revision,
      scope,
      phase:'editing',
      sequence:++state.pluginValidationSequence,
      validations:{},
    };
    state.editingPlugin = session.plugin;
    state.inlineConfigPluginId = null;
    state.detailTabs[pluginStateKey(plugin)] = 'configuration';
    renderShell();
    return true;
  } finally {
    state.pluginEditPreparation = null;
  }
}

function pluginValidationPurpose(pluginType, action = 'validate') {
  const definition = pluginDefinition(pluginType);
  return definition?.validationPurpose?.[action]
    ?? definition?.validationPurpose?.validate
    ?? 'health-check';
}

function pluginValidationResultMatches(active, result) {
  if (!active || !result) return false;
  return active.editSessionId === result.editSessionId
    && ['requestId','draftGeneration','sequence'].every((key) => active[key] === result[key])
    && (!active.operationId || active.operationId === result.operationId)
    && (!active.configDigest || active.configDigest === result.configDigest);
}

function pluginValidationSession() {
  if (state.pluginEditSession?.editSessionId) return state.pluginEditSession;
  return null;
}

function activePluginValidation(purpose = null) {
  const session = state.pluginEditSession?.editSessionId ? state.pluginEditSession : null;
  const validations = session?.validations ?? {};
  if (purpose) return validations[purpose] ?? null;
  return Object.values(validations).find((item) => item.state === 'running') ?? null;
}

function creatingUnsavedPlugin() {
  return state.selectionKind === 'new-plugin'
    && Boolean(state.newPluginType)
    && Boolean(state.pluginFormInstanceId);
}

function createPluginFormInstanceId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `plugin-form-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createNewPluginInstanceId(type) {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${type}-${random}`.toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,63);
}

function initializePluginTypeOptions() {
  const select = $('#pluginType');
  if (!select) return;
  const selected = select.value;
  select.innerHTML = pluginCatalog
    .map((definition) => `<option value="${escapeAttr(definition.type)}">${escapeHtml(definition.label)}</option>`)
    .join('');
  if (pluginDefinition(selected)) select.value = selected;
}

function activePluginProbe(purpose = null) {
  const probe = state.pluginProbe;
  if (!probe || probe.state !== 'running') return null;
  return !purpose || probe.purpose === purpose ? probe : null;
}

function activePluginFormValidation(purpose = null) {
  return activePluginProbe(purpose) ?? activePluginValidation(purpose);
}

function pluginProbeResultMatches(active,result) {
  if (!active || !result || active.requestId !== result.requestId) return false;
  return (!Object.hasOwn(result,'sequence') || active.sequence === result.sequence)
    && (!Object.hasOwn(result,'draftGeneration') || active.draftGeneration === result.draftGeneration)
    && (!Object.hasOwn(result,'formInstanceId') || active.formInstanceId === result.formInstanceId)
    && (!active.operationId || !result.operationId || active.operationId === result.operationId)
    && (!active.configDigest || !result.configDigest || active.configDigest === result.configDigest);
}

function cancelLocalPluginProbe(probe,stateValue = 'cancelled') {
  if (!probe || probe.state !== 'running') return;
  probe.state = stateValue;
  if (state.pluginProbe === probe) state.pluginProbe = null;
  const payload = {
    projectId:probe.projectId,
    environmentId:probe.environmentId,
    formInstanceId:probe.formInstanceId,
    requestId:probe.requestId,
    operationId:probe.operationId,
  };
  if (typeof api.cancelPluginProbe === 'function') {
    void call(api.cancelPluginProbe(payload)).catch(() => undefined);
  }
}

function cancelLocalPluginValidation(validation, stateValue = 'cancelled') {
  if (!validation || validation.state !== 'running') return;
  validation.state = stateValue;
  validation.sequence = ++state.pluginValidationSequence;
  if (validation.operationId) {
    void call(api.cancelPluginValidation({
      editSessionId:validation.editSessionId,
      projectId:state.projectId,
      environmentId:state.environmentId,
      operationId:validation.operationId,
    })).catch(() => undefined);
  }
}

async function cancelOwnedPluginEditSession({restorePreEditConnections = true} = {}) {
  const preparation = state.pluginEditPreparation;
  const session = state.pluginEditSession;
  cancelLocalPluginProbe(activePluginProbe());
  if (!preparation && !session) return true;
  for (const validation of Object.values(session?.validations ?? {})) cancelLocalPluginValidation(validation);
  if (session) {
    await call(api.cancelPluginConnectionEdit({
      editSessionId:session.editSessionId,
      restorePreEditConnections,
    }));
  } else if (preparation) {
    await call(api.cancelPluginConnectionEdit({prepareToken:preparation.prepareToken}));
  }
  state.pluginEditPreparation = null;
  state.pluginEditSession = null;
  return true;
}

function markPluginDraftChanged() {
  const session = pluginValidationSession();
  if (!session || !pluginFormActive()) return;
  const signature = pluginFormSignature();
  if (signature === session.lastDraftSignature) return;
  session.lastDraftSignature = signature;
  session.draftGeneration += 1;
  session.sequence = ++state.pluginValidationSequence;
  session.validations ??= {};
  for (const validation of Object.values(session.validations)) cancelLocalPluginValidation(validation,'stale');
  state.pluginFormDiagnostic = null;
}

function populatePluginForm(plugin = null,{newPluginType = null} = {}) {
  resetPluginFormTransition();
  state.credentialRevealGeneration += 1;
  $$('[data-password-target]').forEach((button) => setElementBusy(button,false));
  const creating = !plugin && Boolean(newPluginType);
  state.editingPlugin = plugin;
  state.pluginProbe = null;
  state.pluginFormDiagnostic = null;
  state.credentialMigration = null;
  $('#savePlugin').disabled = false;
  setElementBusy($('#queryDatabases'),false);
  $('#queryDatabases').textContent = '读取数据库';
  state.databaseQueryGeneration += 1;
  const credentialProbeGeneration = ++state.credentialProbeGeneration;
  clearPluginFormError();
  const type = plugin?.pluginType ?? newPluginType ?? 'server';
  const definition = pluginDefinition(type);
  $('#pluginFormTitle').textContent = plugin ? '编辑连接配置' : `添加 ${typeNames[type]}`;
  $('#pluginFormScope').textContent = `${activeProject().name} / ${activeEnvironment().name}`;
  $('#pluginType').value = type;
  $('#pluginTypeBadge').textContent = typeNames[type];
  $('#pluginTypeIdentity').dataset.pluginType = type;
  $('#pluginTypeIconUse').setAttribute('href',`#i-${typeIcons[type] ?? 'plug'}`);
  $('#pluginBasicInfoSection').classList.toggle('hidden',Boolean(plugin));
  $('#changeNewPluginType').classList.toggle('hidden',!creating);
  $('#pluginDisplayName').value = plugin?.displayName ?? '';
  $('#pluginDisplayName').placeholder = type === 'server' ? '例如：生产服务器' : type === 'mysql' ? '例如：生产数据库' : '例如：缓存服务';
  $('#pluginDisplayNameHint').textContent = '';
  $('#pluginHost').value = plugin?.target?.host ?? '';
  $('#pluginPort').value = plugin?.target?.port ?? definition?.defaultPort ?? '';
  const database = plugin?.target?.database ?? '';
  $('#pluginDatabase').value = database;
  $('#pluginDatabase').disabled = false;
  $('#pluginDatabase').dataset.selectionSource = database ? 'saved' : 'manual';
  $('#pluginDatabaseOptions').innerHTML = database
    ? `<option value="${escapeAttr(database)}"></option>`
    : '';
  $('#databaseHint').textContent = database ? '当前已保存数据库；连接信息变化后请重新读取并验证' : '可读取当前账号可见数据库，也可手工输入准确名称';
  state.databaseCredentialRevision = 0;
  $('#pluginRedisDb').value = plugin?.target?.db ?? 0;
  $('#pluginUsername').value = plugin?.auth?.username ?? '';
  resetPasswordControl('pluginPassword');
  $('#pluginAddressFamily').value = plugin?.target?.addressFamily ?? 'ipv4Preferred';
  $('#pluginTransport').value = plugin?.transport?.kind ?? 'direct';
  $('#pluginVpnAlias').value = plugin?.transport?.interfaceAlias ?? '';
  $('#pluginAuthType').value = plugin?.auth?.type ?? 'password';
  $('#pluginAuthType').dataset.previousValue = $('#pluginAuthType').value;
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
  const validationSession = pluginValidationSession();
  if (validationSession) validationSession.lastDraftSignature = state.pluginFormInitial;
  const restoreCount = state.pluginEditSession?.preEditConnectedSet?.length ?? 0;
  const actionLayout = pluginFormActionLayout({plugin,restoreCount});
  const formalEdit = Boolean(plugin);
  $('#pluginEditSafetyStatus').textContent = plugin
    ? restoreCount ? `已暂停 ${restoreCount} 个连接，保存后将自动恢复` : '保存前不会更改当前运行状态'
    : '退出将丢弃本次填写；检查并添加后才会保存配置';
  const actionBar = pluginFormElement()?.querySelector('.plugin-form-actions');
  actionBar?.classList.toggle('is-create-flow',creating);
  actionBar?.classList.toggle('is-formal-edit',formalEdit);
  $('#savePluginOnly').classList.toggle('hidden',!actionLayout.saveOnly);
  $('#saveAndConnectPlugin').classList.toggle('hidden',!actionLayout.saveAndConnect);
  $('#cancelPluginEdit').textContent = creating ? '取消' : '取消更改';
  $('#savePluginOnly').textContent = '保存但不连接';
  $('#savePluginOnly').title = '更新正式配置，但保持断开';
  $('#savePlugin').textContent = plugin
      ? restoreCount ? `保存并恢复 ${restoreCount} 个连接` : '保存但不连接'
      : '检查并添加';
  $('#savePlugin').title = formalEdit && !restoreCount ? '更新正式配置，但保持断开' : '';
  $('#saveAndConnectPlugin').textContent = creating ? '添加并连接' : '保存并连接';
  $('#savePlugin').classList.toggle('primary',!actionLayout.saveAndConnect);
  $('#saveAndConnectPlugin').classList.toggle('primary',actionLayout.saveAndConnect);
  $('#pluginAdvancedSettings').open = Boolean(
    (type === 'server' && (plugin?.uplink?.type ?? 'direct') !== 'direct')
    || (type !== 'server' && ((plugin?.transport?.kind ?? 'direct') !== 'direct' || (plugin?.tls?.mode ?? 'disabled') !== 'disabled'))
    || (plugin?.target?.addressFamily ?? 'ipv4Preferred') !== 'ipv4Preferred'
  );
  renderPluginFormDiagnostic();
  renderCredentialMigrationNotice();
  loadCredentialIndicators(plugin, credentialProbeGeneration).catch(showPluginFormError);
}

function renderInlinePluginConfig(force = false) {
  const creating = state.selectionKind === 'new-plugin';
  renderPluginTypePicker();
  if (creating && !state.newPluginType) {
    state.inlineConfigPluginId = null;
    unmountPluginForm();
    return;
  }
  const plugin = creating ? null : activePlugin();
  if (!creating && (!plugin || state.pluginEditSession?.scope?.pluginInstanceId !== plugin.pluginInstanceId)) return;
  const formKey = creating ? `__new__:${state.newPluginType}` : plugin.pluginInstanceId;
  mountPluginForm();
  if (force || state.inlineConfigPluginId !== formKey) {
    state.inlineConfigPluginId = formKey;
    populatePluginForm(plugin,{newPluginType:creating ? state.newPluginType : null});
  }
  renderPluginFormDiagnostic();
}

function clearPluginFormError() {
  const element = $('#pluginFormError');
  element.textContent = '';
  element.classList.add('hidden');
  $$('[data-plugin-probe-error="true"]').forEach((input) => {
    input.removeAttribute('aria-invalid');
    delete input.dataset.pluginProbeError;
    const fieldError = input.closest?.('.field')?.querySelector?.('.field-error');
    if (fieldError?.dataset.pluginProbeError === 'true') {
      fieldError.textContent = '';
      delete fieldError.dataset.pluginProbeError;
    }
  });
}

function showPluginFormError(error) {
  const element = $('#pluginFormError');
  element.textContent = error?.message ?? String(error);
  element.classList.remove('hidden');
  element.scrollIntoView({ block:'nearest' });
}

function pluginProbeIssue(action = 'validate') {
  const type = $('#pluginType').value;
  const port = Number($('#pluginPort').value);
  const issue = (id,message) => ({id,message});
  if (!$('#pluginHost').value.trim()) return issue('pluginHost','请先填写主机地址。');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return issue('pluginPort','端口必须是 1 到 65535 之间的整数。');
  if (['server','mysql'].includes(type) && !$('#pluginUsername').value.trim()) {
    return issue('pluginUsername',`请先填写 ${typeNames[type]} 用户名。`);
  }
  if (type === 'server') {
    const authType = $('#pluginAuthType').value;
    if (authType === 'privateKey' && !$('#pluginPrivateKeyPath').value.trim()) return issue('pluginPrivateKeyPath','请先填写 SSH 私钥文件。');
    if (authType === 'password' && creatingUnsavedPlugin() && !editedPasswordValue('pluginPassword')) return issue('pluginPassword','请先输入 SSH 密码。');
    const uplink = $('#pluginUplink').value;
    if (['socks5','http'].includes(uplink)) {
      if (!$('#pluginProxyHost').value.trim()) return issue('pluginProxyHost','请先填写代理地址。');
      const proxyPort = Number($('#pluginProxyPort').value);
      if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) return issue('pluginProxyPort','代理端口必须是 1 到 65535 之间的整数。');
    }
    if (uplink === 'windowsVpn' && !$('#pluginServerVpnAlias').value.trim()) return issue('pluginServerVpnAlias','请先填写 Windows VPN 网卡名称。');
  } else {
    const transport = $('#pluginTransport').value;
    if (transport === 'serverTunnel' && !$('#pluginProvider').value) return issue('pluginProvider','请先选择要复用的 Server 隧道。');
    if (transport === 'windowsVpn' && !$('#pluginVpnAlias').value.trim()) return issue('pluginVpnAlias','请先填写 Windows VPN 网卡名称。');
  }
  if (type === 'mysql' && action === 'validate' && !$('#pluginDatabase').value.trim()) {
    return issue('pluginDatabase','请先读取并选择数据库，或手工输入准确数据库名称。');
  }
  if (type === 'redis') {
    const db = Number($('#pluginRedisDb').value);
    if (!Number.isInteger(db) || db < 0 || db > 15) return issue('pluginRedisDb','Redis Logical DB 必须是 0 到 15 之间的整数。');
  }
  return null;
}

function focusPluginProbeIssue(issue) {
  if (!issue) return false;
  clearPluginFormError();
  const input = $(`#${issue.id}`);
  const advanced = input?.closest?.('#pluginAdvancedSettings');
  if (advanced) advanced.open = true;
  if (input) {
    input.setAttribute('aria-invalid','true');
    input.dataset.pluginProbeError = 'true';
    const fieldError = input.closest?.('.field')?.querySelector?.('.field-error');
    if (fieldError) {
      fieldError.textContent = issue.message;
      fieldError.dataset.pluginProbeError = 'true';
    }
    input.focus?.({preventScroll:false});
    input.scrollIntoView?.({block:'nearest'});
  } else {
    showPluginFormError(new Error(issue.message));
  }
  return true;
}

function clearPluginProbeIssueForInput(input) {
  if (!input?.dataset?.pluginProbeError) return;
  input.removeAttribute('aria-invalid');
  delete input.dataset.pluginProbeError;
  const fieldError = input.closest?.('.field')?.querySelector?.('.field-error');
  if (fieldError?.dataset.pluginProbeError === 'true') {
    fieldError.textContent = '';
    delete fieldError.dataset.pluginProbeError;
  }
}

function renderPluginAdvancedSummary() {
  const type = $('#pluginType').value;
  const family = ({ipv4Preferred:'IPv4 优先',ipv4Only:'仅 IPv4',ipv6Preferred:'IPv6 优先',ipv6Only:'仅 IPv6'})[$('#pluginAddressFamily').value] ?? 'IPv4 优先';
  const route = type === 'server'
    ? ({direct:'直接连接',socks5:'SOCKS5',http:'HTTP CONNECT',windowsVpn:'Windows VPN'})[$('#pluginUplink').value] ?? '直接连接'
    : ({direct:'直接连接',serverTunnel:'Server 隧道',windowsVpn:'Windows VPN'})[$('#pluginTransport').value] ?? '直接连接';
  const parts = [route,family];
  if (type !== 'server') parts.push(`TLS ${tlsName($('#pluginTls').value)}`);
  $('#pluginAdvancedSummary').textContent = parts.join(' · ');
}

function updateDatabaseDiscoveryAvailability() {
  const button = $('#queryDatabases');
  if ($('#pluginType').value !== 'mysql' || button.classList.contains('hidden')) return;
  const canProbe = Boolean(pluginValidationSession() || creatingUnsavedPlugin());
  const pending = Boolean(activePluginFormValidation());
  const issue = pluginProbeIssue('discover');
  button.disabled = pending || !canProbe || Boolean(issue);
  button.title = issue?.message ?? (!canProbe ? '当前配置页面已经失效，请重新进入' : '读取当前账号可见数据库');
  if (!$('#pluginDatabase').value.trim() && state.databaseDiscoverySignature !== databaseConnectionSignature()) {
    $('#databaseHint').textContent = issue
      ? `${issue.message.replace(/^请先/,'请')} 完成连接信息后可读取数据库，也可手工输入库名`
      : '连接信息已完整，可读取数据库，也可手工输入准确名称';
  }
}

function databaseConnectionSignature() {
  return JSON.stringify({
    pluginType:$('#pluginType').value,
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
  return pluginFormActive() && state.pluginFormInitial !== null && pluginFormSignature() !== state.pluginFormInitial;
}

function invalidateDatabaseDiscovery() {
  if ($('#pluginType').value !== 'mysql' || !pluginFormActive()) return;
  if (state.databaseDiscoverySignature === databaseConnectionSignature()) return;
  const databaseSelect = $('#pluginDatabase');
  const selectedDatabase = databaseSelect.value;
  state.databaseQueryGeneration += 1;
  state.databaseDiscoverySignature = null;
  cancelLocalPluginValidation(activePluginValidation('resource-discovery'),'stale');
  cancelLocalPluginProbe(activePluginProbe('resource-discovery'),'stale');
  setElementBusy($('#queryDatabases'),false);
  $('#queryDatabases').disabled = !(pluginValidationSession() || creatingUnsavedPlugin());
  $('#queryDatabases').textContent = '读取数据库';
  setPluginCommitActionsDisabled(false);
  $('#pluginDatabaseOptions').innerHTML = '';
  databaseSelect.value = selectedDatabase;
  databaseSelect.disabled = false;
  $('#databaseHint').textContent = selectedDatabase
    ? '当前数据库已保留；连接信息已变化，请重新查询并验证'
    : '数据库列表已失效，请重新查询';
  if (typeof updateDatabaseDiscoveryAvailability === 'function') updateDatabaseDiscoveryAvailability();
}

function setPluginCommitActionsDisabled(disabled) {
  for (const id of ['savePlugin','savePluginOnly','saveAndConnectPlugin']) {
    const button = $(`#${id}`);
    if (button) button.disabled = Boolean(disabled);
  }
}

async function queryDatabases() {
  const editSession = state.pluginEditSession?.editSessionId ? state.pluginEditSession : null;
  const unsavedProbe = !editSession && creatingUnsavedPlugin();
  if (!editSession && !unsavedProbe) throw new Error('当前配置页面已经失效，请返回后重新进入。');
  if (activePluginFormValidation()) return null;
  if (focusPluginProbeIssue(pluginProbeIssue('discover'))) return null;
  const button = $('#queryDatabases');
  const queryGeneration = ++state.databaseQueryGeneration;
  const dialogGeneration = state.credentialProbeGeneration;
  const requestedFormInstanceId = unsavedProbe ? state.pluginFormInstanceId : null;
  const requestedScope = { projectId:state.projectId, environmentId:state.environmentId, pluginInstanceId:state.editingPlugin?.pluginInstanceId ?? null };
  const requestedSignature = databaseConnectionSignature();
  clearPluginFormError();
  setElementBusy(button,true);
  setPluginCommitActionsDisabled(true);
  button.textContent = '读取中…';
  let validation = null;
  try {
    const {input,secrets,credentialIntent} = pluginFormPayload({forProbe:unsavedProbe});
    const purpose = pluginValidationPurpose('mysql','discover');
    const sequence = ++state.pluginValidationSequence;
    const requestId = `${unsavedProbe ? 'probe' : 'validation'}-${sequence}`;
    validation = {
      editSessionId:editSession?.editSessionId,requestId,purpose,
      draftGeneration:editSession?.draftGeneration ?? queryGeneration,sequence,state:'running',
      operationId:null,configDigest:null,
      projectId:requestedScope.projectId,environmentId:requestedScope.environmentId,
      formInstanceId:requestedFormInstanceId,
    };
    if (editSession) editSession.validations[purpose] = validation;
    else state.pluginProbe = validation;
    const probePayload = {
      projectId:state.projectId,
      environmentId:state.environmentId,
      ...(unsavedProbe ? {formInstanceId:requestedFormInstanceId} : {}),
      requestId,
      purpose,
      draftGeneration:validation.draftGeneration,
      sequence,
      draft:input,
      temporarySecrets:secrets,
    };
    const response = await call(editSession
      ? api.validatePluginDraft({
          ...probePayload,
          editSessionId:editSession.editSessionId,
          credentialIntent,
        })
      : api.probePluginDraft(probePayload));
    const correlated = {
      ...response,
      requestId:response.requestId ?? requestId,
      formInstanceId:response.formInstanceId ?? requestedFormInstanceId,
      sequence:response.sequence ?? sequence,
      draftGeneration:response.draftGeneration ?? validation.draftGeneration,
    };
    const correlatedToCurrent = editSession
      ? pluginValidationResultMatches(validation,correlated) && pluginValidationSession() === editSession
      : pluginProbeResultMatches(validation,correlated) && state.pluginProbe === validation;
    if (!correlatedToCurrent) return null;
    Object.assign(validation,correlated,{state:'valid'});
    const result = response.result ?? response;
    if (queryGeneration !== state.databaseQueryGeneration || dialogGeneration !== state.credentialProbeGeneration || !pluginFormActive() || requestedScope.projectId !== state.projectId || requestedScope.environmentId !== state.environmentId || requestedScope.pluginInstanceId !== (state.editingPlugin?.pluginInstanceId ?? null) || (unsavedProbe && requestedFormInstanceId !== state.pluginFormInstanceId) || requestedSignature !== databaseConnectionSignature()) return;
    const databases = result.databases ?? [];
    const databaseSelect = $('#pluginDatabase');
    const selectedDatabase = databaseSelect.value;
    const selectionListed = Boolean(selectedDatabase) && databases.includes(selectedDatabase);
    $('#pluginDatabaseOptions').innerHTML = databases
      .map((name) => `<option value="${escapeAttr(name)}"></option>`)
      .join('');
    databaseSelect.value = selectedDatabase;
    databaseSelect.disabled = false;
    if (selectedDatabase && selectionListed) databaseSelect.dataset.selectionSource = 'discovered';
    state.databaseDiscoverySignature = requestedSignature;
    const discoverySummary = databases.length
      ? `已查询到 ${databases.length} 个数据库${result.truncated ? '（仅显示前 200 个）' : ''}`
      : '当前账号没有可见的普通数据库';
    $('#databaseHint').textContent = selectedDatabase && !selectionListed
      ? `${discoverySummary}；当前选择未在列表中返回，连接时将再次验证`
      : discoverySummary;
  } catch (error) {
    if (validation?.state === 'running') {
      Object.assign(validation,{
        state:error.code === 'PLUGIN_VALIDATION_CANCELLED' ? 'cancelled' : 'failed',
        operationId:error.details?.operationId ?? validation.operationId,
        configDigest:error.details?.configDigest ?? validation.configDigest,
      });
    }
    const validationIsCurrent = editSession
      ? pluginValidationSession() === editSession
      : state.pluginProbe === validation;
    if (error.code === 'MYSQL_DATABASE_LIST_FORBIDDEN' && error.details?.manualInputAllowed === true
      && queryGeneration === state.databaseQueryGeneration
      && dialogGeneration === state.credentialProbeGeneration
      && pluginFormVisible()
      && validationIsCurrent
      && (!unsavedProbe || requestedFormInstanceId === state.pluginFormInstanceId)
      && scopeMatches(requestedScope)) {
      $('#pluginDatabase').disabled = false;
      $('#databaseHint').textContent = '当前账号无权加载列表，请手工输入准确数据库名称并点击“验证所选数据库”';
      return;
    }
    if (queryGeneration === state.databaseQueryGeneration
      && dialogGeneration === state.credentialProbeGeneration
      && pluginFormVisible()
      && validationIsCurrent
      && (!unsavedProbe || requestedFormInstanceId === state.pluginFormInstanceId)
      && scopeMatches(requestedScope)
      && requestedScope.pluginInstanceId === (state.editingPlugin?.pluginInstanceId ?? null)
      && requestedSignature === databaseConnectionSignature()) throw error;
  } finally {
    if (unsavedProbe && state.pluginProbe === validation) state.pluginProbe = null;
    if (queryGeneration === state.databaseQueryGeneration) {
      setElementBusy(button,false);
      setPluginCommitActionsDisabled(false);
      button.textContent = '读取数据库';
    }
    if (pluginFormVisible()) renderPluginFormDiagnostic();
  }
}
function renderPluginForm() {
  const type = $('#pluginType').value;
  const definition = pluginDefinition(type);
  const capabilities = definition?.capabilities ?? {};
  const creating = creatingUnsavedPlugin();
  const authType = $('#pluginAuthType').value;
  $('#databaseField').classList.toggle('hidden', type !== 'mysql');
  $('#redisDbField').classList.toggle('hidden', type !== 'redis');
  $('#operationTargetSection').classList.toggle('hidden', !capabilities.resourceTarget);
  $('#transportField').classList.toggle('hidden', !capabilities.transport);
  $('#authTypeField').classList.toggle('hidden', type !== 'server');
  $('#privateKeyField').classList.toggle('hidden', type !== 'server' || authType !== 'privateKey');
  $('#primaryCredentialField').classList.toggle('hidden', type === 'server' && authType === 'agent');
  $('#primaryCredentialField').classList.toggle('full',type === 'server');
  $('#primaryCredentialLabel').textContent = type === 'server' && authType === 'privateKey' ? '私钥密码（可选）' : '密码';
  $('#pluginUsernameField').classList.toggle('is-required',['server','mysql'].includes(type));
  $('#pluginUsername').toggleAttribute('aria-required',['server','mysql'].includes(type));
  $('#uplinkField').classList.toggle('hidden', type !== 'server');
  const proxy = type === 'server' && ['socks5','http'].includes($('#pluginUplink').value);
  ['proxyHostField','proxyPortField','proxyUsernameField','proxyPasswordField'].forEach((id) => $(`#${id}`).classList.toggle('hidden', !proxy));
  $('#serverVpnField').classList.toggle('hidden', type !== 'server' || $('#pluginUplink').value !== 'windowsVpn');
  $('#tlsField').classList.toggle('hidden', !capabilities.tls);
  const tls = $('#pluginTls');
  const currentTls = tls.value;
  tls.innerHTML = '<option value="disabled">关闭</option><option value="preferred">加密（不校验证书）</option><option value="required">必须加密</option><option value="verifyIdentity">加密并校验证书身份</option>';
  tls.value = ['disabled','preferred','required','verifyIdentity'].includes(currentTls) ? currentTls : 'disabled';
  $('#providerField').classList.toggle('hidden', !capabilities.transport || $('#pluginTransport').value !== 'serverTunnel');
  $('#vpnField').classList.toggle('hidden', !capabilities.transport || $('#pluginTransport').value !== 'windowsVpn');
  const selectedProvider = $('#pluginProvider').value;
  $('#pluginProvider').innerHTML = state.plugins.filter((item) => item.pluginType === 'server').map((item) => `<option value="${escapeAttr(item.pluginInstanceId)}">${escapeHtml(item.displayName)}</option>`).join('');
  if (selectedProvider) $('#pluginProvider').value = selectedProvider;
  $('#validateServerDraft').classList.toggle('hidden',type !== 'server');
  $('#validateMysqlDatabase').classList.toggle('hidden',type !== 'mysql');
  $('#validateRedisDraft').classList.toggle('hidden',type !== 'redis');
  $('#validateTlsDraft').classList.toggle('hidden',!capabilities.tls || $('#pluginTls').value === 'disabled');
  $('#pluginValidationSection').classList.toggle('hidden',creating);
  const canProbe = Boolean(pluginValidationSession() || creatingUnsavedPlugin());
  const pending = Boolean(activePluginFormValidation());
  for (const id of ['validateServerDraft','validateMysqlDatabase','validateRedisDraft','validateTlsDraft','queryDatabases']) {
    const button = $(`#${id}`);
    if (button && !button.classList.contains('hidden')) button.disabled = pending || !canProbe;
  }
  $('#pluginValidationHint').textContent = canProbe
    ? '检查使用一次性临时连接，不改变正式 runtime、Agent context 或 active 凭据。'
    : '当前配置页面已经失效，请返回后重新进入。';
  renderPluginAdvancedSummary();
  updateDatabaseDiscoveryAvailability();
}

function pluginFormPayload({forProbe = false} = {}) {
  const type = $('#pluginType').value;
  const input = { pluginType:type, displayName:$('#pluginDisplayName').value.trim(), target:{ host:$('#pluginHost').value.trim(), port:Number($('#pluginPort').value), addressFamily:$('#pluginAddressFamily').value }, auth:{ username:$('#pluginUsername').value.trim() } };
  const formalBase = state.editingPlugin;
  const newPluginInstanceId = state.newPluginInstanceId;
  if (!formalBase && newPluginInstanceId) input.pluginInstanceId = newPluginInstanceId;
  if (formalBase && !input.displayName) input.displayName = formalBase.displayName;
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
  if (!input.displayName) {
    const parts = type === 'server'
      ? ['Server',input.target.host || '新连接']
      : type === 'mysql'
        ? ['MySQL',input.target.host || '新连接',input.target.database || '未选择数据库']
        : ['Redis',input.target.host || '新连接',`DB ${Number.isInteger(input.target.db) ? input.target.db : 0}`];
    input.displayName = parts.join(' · ').slice(0,120);
  }
  const primaryPassword = editedPasswordValue('pluginPassword');
  const proxyPassword = editedPasswordValue('pluginProxyPassword');
  const secrets = primaryPassword ? (type === 'server' && input.auth.type === 'privateKey' ? {privateKeyPassphrase:primaryPassword} : {password:primaryPassword}) : {};
  if (type === 'server' && proxyPassword) secrets.proxyPassword = proxyPassword;
  const patch = Object.fromEntries(['target','auth','transport','uplink','tls']
    .filter((key) => Object.hasOwn(input,key))
    .map((key) => [key,input[key]]));
  return {
    input,
    patch,
    secrets,
    credentialIntent:Object.keys(secrets).length ? 'replace' : 'unchanged',
  };
}

function newPluginFormSnapshot() {
  return {
    projectId:state.projectId,
    environmentId:state.environmentId,
    formInstanceId:state.pluginFormInstanceId,
    pluginInstanceId:state.newPluginInstanceId,
    formGeneration:state.credentialProbeGeneration,
    signature:pluginFormSignature(),
  };
}

function newPluginFormSnapshotIsCurrent(snapshot) {
  return creatingUnsavedPlugin()
    && snapshot?.projectId === state.projectId
    && snapshot.environmentId === state.environmentId
    && snapshot.formInstanceId === state.pluginFormInstanceId
    && snapshot.pluginInstanceId === state.newPluginInstanceId
    && snapshot.formGeneration === state.credentialProbeGeneration
    && snapshot.signature === pluginFormSignature();
}

function pluginProbeDiagnosticTitle(type,purpose) {
  if (purpose === 'tls-probe') return 'TLS 探测';
  if (type === 'server') return 'SSH 验证';
  if (type === 'mysql') return '所选数据库验证';
  return `${typeNames[type] ?? type} 验证`;
}

function pluginForDraftDiagnostic(input,scope) {
  return {
    ...input,
    projectId:scope.projectId,
    environmentId:scope.environmentId,
    pluginInstanceId:input.pluginInstanceId,
    target:{...input.target},
    auth:{...input.auth},
    configState:'ready',
  };
}

async function probeNewPluginSnapshot({input,secrets,purpose,snapshot}) {
  if (!newPluginFormSnapshotIsCurrent(snapshot)) return null;
  const sequence = ++state.pluginValidationSequence;
  const requestId = `probe-${sequence}`;
  const active = {
    requestId,purpose,draftGeneration:sequence,sequence,
    operationId:null,configDigest:null,state:'running',
    projectId:snapshot.projectId,environmentId:snapshot.environmentId,
    formInstanceId:snapshot.formInstanceId,
  };
  state.pluginProbe = active;
  try {
    const response = await call(api.probePluginDraft({
      projectId:snapshot.projectId,
      environmentId:snapshot.environmentId,
      formInstanceId:snapshot.formInstanceId,
      requestId,
      purpose,
      draftGeneration:sequence,
      sequence,
      draft:input,
      temporarySecrets:secrets,
    }));
    const correlated = {
      ...response,
      requestId:response.requestId ?? requestId,
      formInstanceId:response.formInstanceId ?? snapshot.formInstanceId,
      sequence:response.sequence ?? sequence,
      draftGeneration:response.draftGeneration ?? sequence,
    };
    if (state.pluginProbe !== active || !pluginProbeResultMatches(active,correlated) || !newPluginFormSnapshotIsCurrent(snapshot)) return null;
    Object.assign(active,correlated,{state:'valid'});
    return response;
  } catch (error) {
    const correlated = {
      formInstanceId:error.details?.formInstanceId ?? snapshot.formInstanceId,
      requestId:error.details?.requestId ?? requestId,
      operationId:error.details?.operationId ?? active.operationId,
      draftGeneration:error.details?.draftGeneration ?? sequence,
      configDigest:error.details?.configDigest ?? active.configDigest,
      sequence:error.details?.sequence ?? sequence,
    };
    if (state.pluginProbe !== active || !pluginProbeResultMatches(active,correlated) || !newPluginFormSnapshotIsCurrent(snapshot)) return null;
    Object.assign(active,correlated,{state:error.code === 'PLUGIN_VALIDATION_CANCELLED' ? 'cancelled' : 'failed'});
    throw error;
  } finally {
    if (state.pluginProbe === active && active.state !== 'running') state.pluginProbe = null;
  }
}

function pluginProbeHostKeyChallenge(error,input) {
  if (error?.code !== 'SSH_HOST_KEY_CONFIRM_REQUIRED') return null;
  const details = error.details?.hostKeyChallenge ?? error.details ?? {};
  const fingerprint = String(details.fingerprint ?? details.hostKeyFingerprint ?? '').trim();
  if (!fingerprint) return null;
  return {
    host:String(details.host ?? input.target.host).trim(),
    port:Number(details.port ?? input.target.port),
    fingerprint,
    algorithm:String(details.algorithm ?? '').trim(),
  };
}

async function checkAndCreateNewPlugin({input,secrets,scope}) {
  const snapshot = newPluginFormSnapshot();
  const purpose = pluginValidationPurpose(input.pluginType,'validate');
  let verifiedInput = input;
  let diagnosticPlugin = pluginForDraftDiagnostic(verifiedInput,scope);
  const beginDiagnostic = () => {
    state.pluginFormDiagnostic = {
      ...createPendingDiagnostic(diagnosticPlugin,`probe-pending-${state.pluginValidationSequence + 1}`),
      plugin:diagnosticPlugin,
      testedSignature:snapshot.signature,
      purpose,
      scope:{...scope,pluginInstanceId:verifiedInput.pluginInstanceId},
      title:pluginProbeDiagnosticTitle(input.pluginType,purpose),
    };
    renderPluginFormDiagnostic();
  };
  beginDiagnostic();
  let result;
  try {
    result = await probeNewPluginSnapshot({input:verifiedInput,secrets,purpose,snapshot});
  } catch (error) {
    const challenge = input.pluginType === 'server' ? pluginProbeHostKeyChallenge(error,input) : null;
    const challengeMatches = challenge
      && challenge.host === input.target.host
      && challenge.port === input.target.port
      && newPluginFormSnapshotIsCurrent(snapshot);
    if (!challengeMatches) {
      if (newPluginFormSnapshotIsCurrent(snapshot)) {
        state.pluginFormDiagnostic = {...failedDiagnostic(state.pluginFormDiagnostic,error),plugin:diagnosticPlugin,purpose,title:state.pluginFormDiagnostic.title};
        renderPluginFormDiagnostic();
      }
      throw error;
    }
    const algorithm = challenge.algorithm ? `\n算法：${challenge.algorithm}` : '';
    const accepted = confirm(`首次连接需要确认服务器身份。\n\n主机：${challenge.host}:${challenge.port}${algorithm}\n指纹：${challenge.fingerprint}\n\n仅将此指纹用于当前新增表单并重新检查，确认继续吗？`);
    if (!accepted || !newPluginFormSnapshotIsCurrent(snapshot)) {
      if (newPluginFormSnapshotIsCurrent(snapshot)) {
        state.pluginFormDiagnostic = {...failedDiagnostic(state.pluginFormDiagnostic,error),plugin:diagnosticPlugin,purpose,title:state.pluginFormDiagnostic.title};
        renderPluginFormDiagnostic();
      }
      return null;
    }
    verifiedInput = {...input,target:{...input.target,hostKeyFingerprint:challenge.fingerprint}};
    diagnosticPlugin = pluginForDraftDiagnostic(verifiedInput,scope);
    beginDiagnostic();
    try {
      result = await probeNewPluginSnapshot({input:verifiedInput,secrets,purpose,snapshot});
    } catch (retryError) {
      if (newPluginFormSnapshotIsCurrent(snapshot)) {
        state.pluginFormDiagnostic = {...failedDiagnostic(state.pluginFormDiagnostic,retryError),plugin:diagnosticPlugin,purpose,title:state.pluginFormDiagnostic.title};
        renderPluginFormDiagnostic();
      }
      throw retryError;
    }
  }
  if (!result || !newPluginFormSnapshotIsCurrent(snapshot)) return null;
  state.pluginFormDiagnostic = {
    ...completedDiagnostic(state.pluginFormDiagnostic,result.result ?? result),
    plugin:diagnosticPlugin,purpose,title:state.pluginFormDiagnostic.title,
  };
  renderPluginFormDiagnostic();
  if (!newPluginFormSnapshotIsCurrent(snapshot)) return null;
  return call(api.createPlugin({...scope,input:verifiedInput,secrets}));
}

function confirmUnreadableCredentialReplacement(error,secrets) {
  if (error?.code !== 'CREDENTIAL_REPLACEMENT_INCOMPLETE' || !Object.keys(secrets ?? {}).length) return false;
  const labels = {
    password:'登录密码',privateKeyPassphrase:'私钥口令',proxyPassword:'代理密码',
    tlsPassphrase:'TLS 私钥口令',caPem:'CA 证书',clientCertPem:'客户端证书',clientKeyPem:'客户端私钥',
  };
  const replacementFields = Object.keys(secrets).map((key) => labels[key] ?? key).join('、');
  return confirm(
    `现有加密凭据已经无法读取。\n\n继续将永久丢弃此连接旧密文中的全部历史字段，`
    + `并且只保存本次输入的：${replacementFields}。\n\n`
    + '请确认已重新输入此连接需要保留的全部凭据。此操作无法撤销，是否强制替换？',
  );
}

async function savePlugin(afterCommit = null) {
  const {input,patch,secrets,credentialIntent} = pluginFormPayload();
  const scope = { projectId:state.projectId,environmentId:state.environmentId };
  const editingPlugin = state.editingPlugin;
  const creating = !editingPlugin && creatingUnsavedPlugin();
  if (!editingPlugin && !creating) throw new Error('当前新增表单已经失效，请返回后重新进入。');
  if (focusPluginProbeIssue(pluginProbeIssue('validate'))) return null;
  const operationKey = `plugin-save:${scopeKey(scope.projectId,scope.environmentId)}:${editingPlugin?.pluginInstanceId ?? state.newPluginInstanceId ?? 'new'}`;
  const token = beginOperation(operationKey);
  if (!token) return;
  try {
    if (editingPlugin && !state.pluginEditSession?.editSessionId) throw new Error('连接配置编辑会话已经失效，请返回详情后重新进入。');
    if (state.pluginEditSession) {
      for (const validation of Object.values(state.pluginEditSession.validations ?? {})) cancelLocalPluginValidation(validation);
      state.pluginEditSession.phase = 'saving';
      renderPluginFormDiagnostic();
    }
    const saveExistingPlugin = (forceCredentialReplacement = false) => call(api.savePluginConnectionEdit({
      editSessionId:state.pluginEditSession.editSessionId,
      expectedRevision:state.pluginEditSession.baseRecordRevision ?? editingPlugin.revision,
      patch,
      credentialIntent,
      temporarySecrets:secrets,
      afterCommit:afterCommit ?? (state.pluginEditSession.preEditConnectedSet?.length ? 'restore-pre-edit-set' : 'stay-disconnected'),
      ...(forceCredentialReplacement ? {forceCredentialReplacement:true} : {}),
    }));

    let saved;
    saved = editingPlugin
      ? await (async () => {
        try {
          return await saveExistingPlugin();
        } catch (error) {
          if (error?.code !== 'CREDENTIAL_REPLACEMENT_INCOMPLETE'
            || !confirmUnreadableCredentialReplacement(error,secrets)) throw error;
          return saveExistingPlugin(true);
        }
      })()
      : await checkAndCreateNewPlugin({input,secrets,scope});
    if (!saved) return null;
    const plugin = saved.plugin ?? saved;
    const runtimeWarningMessage = pluginRuntimeWarningMessage(saved,'save');
    clearTransientRevealedCredentials({discardEdited:true});
    await refreshEnvironmentMetadata(scope);
    if (!scopeMatches(scope)) return;
    state.pluginFormInitial = null;
    state.pluginFormDiagnostic = null;
    state.inlineConfigPluginId = null;
    state.pluginEditSession = null;
    state.pluginEditPreparation = null;
    state.newPluginType = null;
    state.pluginFormInstanceId = null;
    state.newPluginInstanceId = null;
    state.pluginProbe = null;
    const loaded = await loadEnvironment(plugin.pluginInstanceId,scope);
    if (!loaded || !scopeMatches(scope)) return;
    state.selectionKind = 'plugin';
    state.pluginId = plugin.pluginInstanceId;
    const canTestSavedConfiguration = pluginDiagnosticAvailable(plugin);
    state.detailTabs[pluginStateKey(plugin)] = 'configuration';
    renderShell();
    toast(runtimeWarningMessage ?? (creating
      ? `“${plugin.displayName}”已添加，尚未连接。`
      : pluginConnectionViewModel(plugin).configurationState === 'complete'
        ? '配置已保存。'
        : canTestSavedConfiguration
          ? '配置已保存；请继续选择并验证操作目标。'
          : `配置已保存；请先修正：${pluginDiagnosticConfigurationIssue(plugin)}。`));
  } catch (error) {
    if (state.pluginEditSession?.phase === 'saving') state.pluginEditSession.phase = 'editing';
    throw error;
  } finally {
    finishOperation(operationKey,token);
  }
}

async function environmentAction() {
  const environment = activeEnvironment();
  if (!environment) return;
  const action = currentEnvironmentAction().action;
  await handleEnvironmentRuntimeAction(action,state.projectId,environment.environmentId);
}

function mergeDiagnosticProgress(diagnostic, plugin, check) {
  if (diagnostic.status === 'success' || diagnostic.status === 'failure') return diagnostic;
  const checks = diagnosticChecks(plugin,diagnostic);
  const index = checks.findIndex((item) => item.id === check.id);
  if (index < 0) return diagnostic;
  checks[index] = {...checks[index],...check};
  if (check.status === 'success' && checks[index + 1]?.status === 'queued') checks[index + 1] = {...checks[index + 1],status:'pending'};
  return {
    ...diagnostic,
    status:check.status === 'failure' ? 'failure' : 'pending',
    summary:check.status === 'failure' ? check.detail : '正在按顺序执行检查…',
    checks,
  };
}

function completedDiagnostic(diagnostic, result) {
  const checks = (result.checks?.length ? result.checks : diagnostic.checks ?? []).map((check) => (
    ['pending','queued'].includes(check.status)
      ? {...check,status:'success',elapsedMs:check.elapsedMs ?? null}
      : check
  ));
  return {
    ...diagnostic,
    status:'success',
    reused:Boolean(result.reused),
    checks,
    totalElapsedMs:result.totalElapsedMs,
    summary:result.reused ? '已通过当前活动连接完成全部检查。' : '临时连接已在检查完成后释放，可以安全保存或继续使用当前配置。',
  };
}

function failedDiagnostic(diagnostic, error) {
  const details = error?.details?.diagnostic;
  let checks = details?.checks?.length ? details.checks : diagnostic.checks;
  if (!checks.some((check) => check.status === 'failure')) {
    let marked = false;
    checks = checks.map((check) => {
      if (!marked && check.status === 'pending') { marked = true; return {...check,status:'failure',detail:error?.message ?? check.detail,elapsedMs:check.elapsedMs ?? null}; }
      return check;
    });
  }
  return {
    ...diagnostic,
    status:'failure',
    errorCode:error?.code ?? 'CONNECTION_FAILED',
    checks,
    totalElapsedMs:details?.totalElapsedMs,
    summary:error?.message ?? '连接检查失败。',
  };
}

function tlsDisableAvailable(diagnostic = state.pluginFormDiagnostic) {
  return ['TLS_NOT_SUPPORTED','MYSQL_TLS_NOT_SUPPORTED'].includes(diagnostic?.errorCode);
}

function disableTlsInCurrentDraft() {
  if (!tlsDisableAvailable()) return false;
  const tls = $('#pluginTls');
  if (!tls || tls.value === 'disabled') return false;
  if (!confirm('仅将当前表单的 TLS 调整为“关闭”？正式配置在保存前不会改变。')) return false;
  tls.value = 'disabled';
  markPluginDraftChanged();
  renderPluginForm();
  renderPluginFormDiagnostic();
  return true;
}

function connectionHostKeyChallenge(scope,source = null) {
  const actions = [
    ...(source?.actions ?? []),
    ...(state.connectionActionsByScope?.[scopeKey(scope.projectId,scope.environmentId)] ?? []),
  ];
  const action = actions.find((item) => (
    item?.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED'
    && (item.rootPluginInstanceId === scope.pluginInstanceId
      || item.affectedPluginInstanceIds?.includes(scope.pluginInstanceId))
    && item.details?.hostKeyChallenge
  ));
  return action?.details?.hostKeyChallenge ?? null;
}

async function confirmRuntimeHostKeyChallenge(scope,operation,source = null) {
  const challenge = connectionHostKeyChallenge(scope,source);
  if (!challenge) return null;
  if (operation && !runtimeOperationIsLatest(operation)) return null;
  const algorithm = challenge.algorithm ? `\n算法：${challenge.algorithm}` : '';
  const accepted = confirm(`首次连接需要确认服务器身份。\n\n主机：${challenge.host}:${challenge.port}${algorithm}\n指纹：${challenge.fingerprint}\n\n确认信任并保存此指纹吗？`);
  if (!accepted) return null;
  if (operation && !runtimeOperationIsLatest(operation)) return null;
  return call(api.confirmConnectionChallenge({
    challengeId:challenge.challengeId,
    planId:challenge.planId,
    operationId:challenge.operationId,
    expectedRevision:challenge.expectedRevision,
    decision:'trust-host-key',
  }));
}

function renderPluginFormDiagnostic() {
  const host = $('#pluginFormDiagnostic');
  if (!host) return;
  const diagnostic = state.pluginFormDiagnostic;
  host.classList.toggle('hidden',!diagnostic);
  const tlsAction = tlsDisableAvailable(diagnostic)
    ? '<div class="plugin-form-diagnostic-action"><button id="disableTlsInDraft" type="button" class="button">在当前表单关闭 TLS</button></div>'
    : '';
  host.innerHTML = diagnostic ? `<div class="plugin-form-diagnostic-head"><div><span class="connection-section-eyebrow">临时验证</span><strong>${escapeHtml(diagnostic.title ?? '连接验证')}</strong></div></div>${renderDiagnosticContent(diagnostic.plugin,diagnostic)}${tlsAction}` : '';
  $('#disableTlsInDraft')?.addEventListener('click',disableTlsInCurrentDraft);
  const pending = Boolean(activePluginFormValidation());
  for (const id of ['validateServerDraft','validateMysqlDatabase','validateRedisDraft','validateTlsDraft']) {
    const button = $(`#${id}`);
    if (!button || button.classList.contains('hidden')) continue;
    setElementBusy(button,pending);
    button.disabled = pending || !(pluginValidationSession() || creatingUnsavedPlugin());
  }
  $('#cancelPluginValidation')?.classList.toggle('hidden',!pending);
}

function pluginFormActionLayout({plugin,restoreCount}) {
  const formalEdit = Boolean(plugin);
  return {
    saveOnly:formalEdit && restoreCount > 0,
    saveAndConnect:formalEdit && !restoreCount,
  };
}

function applyPluginValidationProgress(message) {
  const session = state.pluginEditSession?.editSessionId ? state.pluginEditSession : null;
  if (!session) return;
  if (message?.editSessionId !== session.editSessionId) return;
  const active = session.validations?.[message.purpose];
  if (!active) return;
  if (active.state !== 'running') {
    if (message.operationId && ['cancelled','stale'].includes(active.state)) {
      void call(api.cancelPluginValidation({
        editSessionId:session.editSessionId,
        projectId:state.projectId,environmentId:state.environmentId,
        operationId:message.operationId,
      })).catch(() => undefined);
    }
    return;
  }
  const correlated = {...message,sequence:active.sequence};
  if (!pluginValidationResultMatches(active,correlated)) return;
  Object.assign(active,correlated);
  if (message.state === 'running') active.state = 'running';
  if (state.pluginFormDiagnostic?.requestId === active.requestId) {
    state.pluginFormDiagnostic = message.state === 'valid'
      ? completedDiagnostic(state.pluginFormDiagnostic,message.result ?? message)
      : ['failed','cancelled'].includes(message.state)
        ? failedDiagnostic(state.pluginFormDiagnostic,message.error ?? {code:'PLUGIN_VALIDATION_FAILED',message:'连接验证失败。'})
        : {...state.pluginFormDiagnostic,status:'pending'};
    renderPluginFormDiagnostic();
  }
}

async function validatePluginDraftAction(action = 'validate') {
  clearPluginFormError();
  const session = pluginValidationSession();
  if (!session || (session.editSessionId && session.phase !== 'editing')) throw new Error('连接配置编辑会话已经失效，请返回详情后重新进入。');
  if (activePluginValidation()) return null;
  const {input,secrets,credentialIntent} = pluginFormPayload();
  const testedSignature = pluginFormSignature();
  const purpose = pluginValidationPurpose(input.pluginType,action);
  const sequence = ++state.pluginValidationSequence;
  const requestId = `validation-${sequence}`;
  const pluginSource = state.editingPlugin ?? {};
  const plugin = {
    ...pluginSource,
    ...input,
    target:input.target,
    auth:input.auth,
    pluginInstanceId:pluginSource.pluginInstanceId,
    configState:'ready',
  };
  const active = {
    editSessionId:session.editSessionId,
    requestId,purpose,draftGeneration:session.draftGeneration,
    sequence,operationId:null,configDigest:null,state:'running',
  };
  session.validations[purpose] = active;
  state.pluginFormDiagnostic = {
    ...createPendingDiagnostic(plugin,requestId),plugin,testedSignature,purpose,
    scope:{projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId},
    title:purpose === 'tls-probe' ? 'TLS 探测' : input.pluginType === 'server' ? 'SSH 验证' : input.pluginType === 'mysql' ? '所选数据库验证' : 'Redis 验证',
  };
  renderPluginFormDiagnostic();
  try {
    const result = await call(api.validatePluginDraft({
      editSessionId:session.editSessionId,
      projectId:state.projectId,
      environmentId:state.environmentId,
      requestId,
      purpose,
      draftGeneration:session.draftGeneration,
      sequence,
      draft:input,
      credentialIntent,
      temporarySecrets:secrets,
    }));
    const correlated = {...result,sequence};
    if (!pluginValidationResultMatches(active,correlated) || pluginValidationSession() !== session) return null;
    Object.assign(active,correlated,{state:'valid'});
    state.pluginFormDiagnostic = testedSignature === pluginFormSignature()
      ? {...completedDiagnostic(state.pluginFormDiagnostic,result.result ?? result),plugin,testedSignature,purpose,title:state.pluginFormDiagnostic.title}
      : null;
    return result;
  } catch (error) {
    const correlated = {
      editSessionId:error.details?.editSessionId ?? session.editSessionId,
      requestId,
      operationId:error.details?.operationId ?? active.operationId,
      draftGeneration:error.details?.draftGeneration ?? active.draftGeneration,
      configDigest:error.details?.configDigest ?? active.configDigest,
      sequence,
    };
    if (!pluginValidationResultMatches(active,correlated) || pluginValidationSession() !== session) return null;
    Object.assign(active,correlated,{state:error.code === 'PLUGIN_VALIDATION_CANCELLED' ? 'cancelled' : 'failed'});
    state.pluginFormDiagnostic = testedSignature === pluginFormSignature()
      ? {...failedDiagnostic(state.pluginFormDiagnostic,error),plugin,testedSignature,purpose,title:state.pluginFormDiagnostic.title}
      : null;
    return null;
  } finally {
    if (pluginValidationSession() === session && pluginFormVisible()) renderPluginFormDiagnostic();
  }
}

async function cancelPluginValidationAction() {
  const probe = activePluginProbe();
  if (probe) {
    cancelLocalPluginProbe(probe);
    state.pluginFormDiagnostic = state.pluginFormDiagnostic
      ? {...state.pluginFormDiagnostic,status:'failure',summary:'验证已取消。'}
      : null;
    renderPluginFormDiagnostic();
    return;
  }
  const validation = activePluginValidation();
  if (!validation) return;
  cancelLocalPluginValidation(validation);
  state.pluginFormDiagnostic = state.pluginFormDiagnostic
    ? {...state.pluginFormDiagnostic,status:'failure',summary:'验证已取消。'}
    : null;
  renderPluginFormDiagnostic();
}

function confirmationExpiresAt(item) {
  return typeof item.expiresAt === 'number' ? item.expiresAt : new Date(item.expiresAt).getTime();
}

function confirmationRiskName(item) {
  return ({write:'写入',destructive:'破坏性变更',service:'服务变更',critical:'最高风险'})[item.riskLevel] ?? '服务器变更';
}

function confirmationScopeName(item) {
  const project = state.projects.find((entry) => entry.projectId === item.projectId);
  const environment = environmentFor(item.projectId,item.environmentId);
  const plugin = item.projectId === state.projectId && item.environmentId === state.environmentId
    ? state.plugins.find((entry) => entry.pluginInstanceId === item.pluginInstanceId)
    : environment?.resourcePreview?.find((entry) => entry.pluginInstanceId === item.pluginInstanceId);
  return {
    project:item.projectNameSnapshot ?? project?.name ?? '项目',
    environment:item.environmentNameSnapshot ?? environment?.name ?? '环境',
    plugin:item.pluginNameSnapshot ?? plugin?.displayName ?? '插件',
  };
}

function confirmationMatches(item,filter = state.confirmationFilter) {
  if (filter.kind === 'project') return item.projectId === filter.projectId;
  if (filter.kind === 'environment') return item.projectId === filter.projectId && item.environmentId === filter.environmentId;
  if (filter.kind === 'plugin') return item.projectId === filter.projectId && item.environmentId === filter.environmentId && item.pluginInstanceId === filter.pluginInstanceId;
  return true;
}

function confirmationFilterOptions() {
  const filters = [confirmationScopeData('all')];
  const active = state.confirmationFilter;
  const projectId = active.projectId ?? state.projectId;
  const environmentId = active.environmentId ?? state.environmentId;
  const pluginInstanceId = active.pluginInstanceId ?? (state.selectionKind === 'plugin' ? state.pluginId : null);
  if (projectId) filters.push(confirmationScopeData('project',projectId));
  if (projectId && environmentId) filters.push(confirmationScopeData('environment',projectId,environmentId));
  if (projectId && environmentId && pluginInstanceId) filters.push(confirmationScopeData('plugin',projectId,environmentId,pluginInstanceId));
  return filters;
}

function confirmationFilterLabel(filter) {
  if (filter.kind === 'all') return '全部';
  const item = pendingConfirmations().find((entry) => confirmationMatches(entry,filter));
  const names = item ? confirmationScopeName(item) : {};
  if (filter.kind === 'project') return names.project ?? state.projects.find((entry) => entry.projectId === filter.projectId)?.name ?? '当前项目';
  if (filter.kind === 'environment') return names.environment ?? environmentFor(filter.projectId,filter.environmentId)?.name ?? '当前环境';
  if (filter.kind === 'plugin') return names.plugin ?? state.plugins.find((entry) => entry.pluginInstanceId === filter.pluginInstanceId)?.displayName ?? '当前插件';
  return '全部';
}

function confirmationFilterIsActive(filter) {
  const current = state.confirmationFilter;
  return current.kind === filter.kind && current.projectId === filter.projectId && current.environmentId === filter.environmentId && current.pluginInstanceId === filter.pluginInstanceId;
}

function renderConfirmationPresentation(item) {
  const value = item.presentation ?? {};
  const row = (label,content,className = '') => `<div class="confirmation-fact ${escapeAttr(className)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(content)}</strong></div>`;
  if (value.kind === 'shell') return `<div class="confirmation-command"><span>完整命令</span><pre>${escapeHtml(value.command ?? item.summary)}</pre>${value.workingDirectory ? `<small>工作目录：${escapeHtml(value.workingDirectory)}</small>` : ''}</div>`;
  if (value.kind === 'file-transfer') return `<div class="confirmation-facts">${row('本地文件',value.source,'wide mono')}${row('服务器目标',value.destination,'wide mono')}${row('文件大小',`${Number(value.bytes ?? 0).toLocaleString()} 字节`)}${row('覆盖现有文件',value.overwrite ? '是' : '否')}${row('SHA-256',value.sha256,'wide mono')}</div>`;
  if (value.kind === 'file-write') return `<div class="confirmation-facts">${row('服务器目标',value.destination,'wide mono')}${row('写入大小',`${Number(value.bytes ?? 0).toLocaleString()} 字节`)}${row('覆盖现有文件',value.overwrite ? '是' : '否')}${row('新内容 SHA-256',value.sha256,'wide mono')}</div>`;
  if (value.kind === 'path-move') return `<div class="confirmation-facts">${row('原路径',value.source,'wide mono')}${row('目标路径',value.destination,'wide mono')}${row('覆盖目标',value.overwrite ? '是' : '否')}</div>`;
  if (value.kind === 'path-delete') return `<div class="confirmation-facts">${row('删除目标',value.destination,'wide mono')}${row('目标类型',value.remoteType)}</div>`;
  if (value.kind === 'service-control') return `<div class="confirmation-facts">${row('systemd unit',value.unit,'mono')}${row('动作',value.action)}</div>`;
  return `<p class="confirmation-plain-summary">${escapeHtml(item.summary || '对服务器执行一次变更操作')}</p>`;
}

function pruneConfirmationExecutions(limit = CONFIRMATION_EXECUTION_CACHE_LIMIT) {
  const ids = Object.keys(state.confirmationExecutions);
  const keep = new Set(ids.slice(-Math.max(0,limit)));
  const feedbackId = state.confirmationFeedback?.item?.requestId;
  if (feedbackId && state.confirmationExecutions[feedbackId]) keep.add(feedbackId);
  for (const id of ids) if (!keep.has(id)) delete state.confirmationExecutions[id];
}

function rememberConfirmationExecution(change) {
  if (!change?.confirmationId) return;
  delete state.confirmationExecutions[change.confirmationId];
  state.confirmationExecutions[change.confirmationId] = change;
  pruneConfirmationExecutions();
}

function clearConfirmationFeedback() {
  state.confirmationFeedback = null;
  pruneConfirmationExecutions();
}

function renderConfirmationFeedback() {
  const feedback = state.confirmationFeedback;
  if (!feedback) return '';
  const execution = state.confirmationExecutions[feedback.item.requestId];
  const status = execution?.status ?? feedback.status;
  const meta = ({waiting:['已授权，等待 Agent 执行','本次授权只匹配完全相同的操作内容'],running:['Agent 正在执行','操作已开始，请等待实际结果'],success:['操作执行成功',Number.isFinite(execution?.durationMs) ? `实际执行耗时 ${execution.durationMs.toLocaleString()} ms` : '实际操作已经完成'],error:['操作执行失败',auditErrorName(execution?.errorCode ?? '执行失败')],rejected:['操作已拒绝','Agent 需要重新发起请求后才能再次确认']})[status] ?? ['确认状态已更新',''];
  const tone = status === 'success' ? 'success' : status === 'error' || status === 'rejected' ? 'error' : status === 'running' ? 'running' : 'pending';
  return `<section class="confirmation-feedback ${tone}"><span class="confirmation-feedback-icon">${icon(status === 'success' ? 'check' : status === 'error' || status === 'rejected' ? 'x' : status === 'running' ? 'loader' : 'shield')}</span><div><strong>${escapeHtml(meta[0])}</strong><small>${escapeHtml(meta[1])}</small></div><button class="button small" data-confirmation-open-audit="${escapeAttr(feedback.item.requestId)}">查看操作记录</button></section>`;
}

function renderConfirmationCard(item) {
  const names = confirmationScopeName(item);
  const strong = item.approvalLevel === 'strong';
  const busy = operationInFlight(`confirmation:${item.requestId}`);
  const expiresAt = confirmationExpiresAt(item);
  const remaining = Math.max(0,Math.ceil((expiresAt - Date.now()) / 1000));
  return `<article class="confirmation-card ${strong ? 'critical' : ''}" data-confirmation-card="${escapeAttr(item.requestId)}"><header class="confirmation-card-head"><div><span class="confirmation-source">Agent 请求 · ${escapeHtml(names.project)} / ${escapeHtml(names.environment)}</span><div class="confirmation-title"><h2>${escapeHtml(item.capabilityLabel ?? auditCapabilityName(item.capability))}</h2><span class="risk-badge ${strong ? 'critical' : ''}">${escapeHtml(confirmationRiskName(item))}</span></div><p>目标插件：${escapeHtml(names.plugin)}</p></div><button class="button small" data-locate-confirmation="${escapeAttr(item.requestId)}">定位插件</button></header>${renderConfirmationPresentation(item)}${strong ? `<div class="strong-confirmation"><div class="strong-confirmation-warning">${icon('shield')}<span><strong>这是任意 Shell 命令</strong><small>命令可能修改或删除数据、停止服务，必须完整核对后才能授权。</small></span></div><label><input type="checkbox" data-confirmation-ack="${escapeAttr(item.requestId)}" ${busy ? 'disabled' : ''}>我已核对上面的完整命令、工作目录和目标环境</label></div>` : ''}<footer class="confirmation-card-actions"><span>只授权本次操作 · <time data-confirmation-expires="${escapeAttr(item.requestId)}" datetime="${new Date(expiresAt).toISOString()}">${remaining} 秒后过期</time></span><div><button class="button" data-reject-confirmation="${escapeAttr(item.requestId)}" ${busy ? 'disabled aria-busy="true"' : ''}>拒绝</button><button class="button ${strong ? 'danger' : 'primary'}" data-approve-confirmation="${escapeAttr(item.requestId)}" data-approval-level="${strong ? 'strong' : 'standard'}" ${strong || busy ? 'disabled' : ''}${busy ? ' aria-busy="true"' : ''}>${strong ? '确认执行一次' : '确认一次'}</button></div></footer></article>`;
}

function renderConfirmationCenter() {
  const pending = pendingConfirmations().filter((item) => confirmationMatches(item)).sort((left,right) => {
    const riskOrder = {critical:0,destructive:1,service:2,write:3};
    return (riskOrder[left.riskLevel] ?? 9) - (riskOrder[right.riskLevel] ?? 9) || new Date(left.createdAt) - new Date(right.createdAt);
  });
  const filters = confirmationFilterOptions().map((filter) => {
    const count = confirmationCount(filter);
    const attributes = `data-confirmation-filter="${escapeAttr(filter.kind)}"${filter.projectId ? ` data-confirmation-project="${escapeAttr(filter.projectId)}"` : ''}${filter.environmentId ? ` data-confirmation-environment="${escapeAttr(filter.environmentId)}"` : ''}${filter.pluginInstanceId ? ` data-confirmation-plugin="${escapeAttr(filter.pluginInstanceId)}"` : ''}`;
    return `<button class="confirmation-filter ${confirmationFilterIsActive(filter) ? 'active' : ''}" ${attributes}>${escapeHtml(confirmationFilterLabel(filter))}<span>${count}</span></button>`;
  }).join('');
  const empty = `<div class="confirmation-empty">${icon('shield')}<h2>${state.pendingCount ? '当前筛选没有待确认操作' : '当前没有待确认操作'}</h2><p>${state.pendingCount ? '切换到“全部”查看其他项目或环境的请求。' : 'Agent 发起服务器变更后会显示在这里，不会自动执行。'}</p></div>`;
  $('#confirmationCenter').innerHTML = `<div class="confirmation-page-shell"><header class="confirmation-page-head"><span class="confirmation-page-icon">${icon('shield')}</span><div><span class="confirmation-eyebrow">全局安全队列</span><h1>操作确认 <b>${state.pendingCount}</b></h1><p>逐项核对 Agent 请求；内容、目标或环境变化后必须重新确认。</p></div><button class="button" data-close-confirmation-center>${icon('x')}返回之前页面</button></header><nav class="confirmation-filters" aria-label="筛选待确认操作">${filters}</nav>${renderConfirmationFeedback()}<div class="confirmation-card-list">${pending.length ? pending.map(renderConfirmationCard).join('') : empty}</div></div>`;
}

async function refreshConfirmations({render = true} = {}) {
  const generation = ++state.confirmationLoadGeneration;
  let pending;
  try {
    pending = await call(api.listConfirmations());
  } catch (error) {
    if (generation === state.confirmationLoadGeneration) throw error;
    return null;
  }
  if (generation !== state.confirmationLoadGeneration) return null;
  state.confirmations = pending;
  state.pendingCount = pendingConfirmations().length;
  state.confirmationsLoaded = true;
  if (render) renderConfirmationSurfaces();
  return pending;
}

function renderConfirmationSurfaces() {
  state.pendingCount = pendingConfirmations().length;
  withUiContinuity(() => {
    renderConfirmationButton();
    renderProjects();
    renderResourcePane();
    if (state.confirmationCenterActive) renderConfirmationCenter();
    else if (state.view === 'plugins' && state.selectionKind === 'plugin' && activePlugin()) renderPluginDetail();
    else if (state.view === 'plugin-config' && pluginFormVisible()) renderPluginFormDiagnostic();
  });
}

async function openConfirmations(filter = confirmationScopeData('all')) {
  if (state.detailPaneCollapsed) setDetailPaneCollapsed(false);
  const generation = ++state.confirmationOpenGeneration;
  clearTransientRevealedCredentials();
  state.confirmationFilter = filter;
  state.confirmationCenterActive = true;
  renderShell();
  await refreshConfirmations({render:false});
  if (generation !== state.confirmationOpenGeneration || !state.confirmationCenterActive) return;
  renderConfirmationSurfaces();
}

function closeConfirmationCenter() {
  state.confirmationOpenGeneration += 1;
  state.confirmationCenterActive = false;
  clearConfirmationFeedback();
  renderShell();
}

function renderConfirmationButton() {
  const button = $('#confirmationButton');
  if (!button) return;
  button.classList.toggle('has-pending', state.pendingCount > 0);
  button.classList.toggle('active', state.confirmationCenterActive);
  $('#confirmationCount').classList.toggle('hidden',state.pendingCount === 0);
  $('#confirmationCount').textContent = state.pendingCount;
  $('#confirmationSummary').textContent = state.pendingCount ? `${state.pendingCount} 项操作等待处理` : '当前没有待确认操作';
  button.setAttribute('aria-label',state.pendingCount ? `打开操作确认中心，${state.pendingCount}项操作待确认` : '打开操作确认中心');
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

function currentScopeSaveInFlight() {
  if (!state.projectId || !state.environmentId) return false;
  const currentScopeKey = scopeKey();
  if (operationInFlight(`runbook-save:${currentScopeKey}`)) return true;
  const pluginPrefix = `plugin-save:${currentScopeKey}:`;
  return [...inFlightOperations.keys()].some((key) => key.startsWith(pluginPrefix));
}

async function mayLeaveCurrentScope() {
  if (currentScopeSaveInFlight()) {
    toast('正在保存，请稍候。');
    return false;
  }
  const discardRunbook = state.runbookDirty;
  const discardPlugin = state.pluginFormMode === 'inline' && pluginFormDirty();
  const discardLightweightPluginEdit = Boolean(state.metadataEditingPluginId || state.agentEditingPluginId);
  if (discardRunbook || discardPlugin || discardLightweightPluginEdit) {
    const subject = discardRunbook && (discardPlugin || discardLightweightPluginEdit)
      ? '运维说明和插件配置'
      : discardRunbook ? '运维说明' : '插件配置';
    if (!confirm(`${subject}尚未保存，确定放弃更改？`)) return false;
  }
  try {
    await cancelOwnedPluginEditSession({restorePreEditConnections:true});
  } catch (error) {
    toast(error?.message ?? '无法安全结束连接配置编辑会话。',true);
    return false;
  }
  clearTransientRevealedCredentials({ discardEdited:discardPlugin });
  if (discardRunbook) state.runbookDraft = state.runbookContent;
  state.runbookDirty = false;
  state.runbookEditing = false;
  state.metadataEditingPluginId = null;
  state.agentEditingPluginId = null;
  if (state.pluginFormMode === 'inline') {
    state.pluginFormDiagnostic = null;
    state.pluginFormInitial = null;
    state.inlineConfigPluginId = null;
    state.editingPlugin = null;
    state.pluginFormInstanceId = null;
    state.newPluginInstanceId = null;
    state.pluginProbe = null;
  }
  return true;
}

function rememberCurrentScope() {
  if (!state.projectId) return;
  if (state.environmentId) {
    state.projectEnvironmentMemory[state.projectId] = state.environmentId;
    state.scopePluginMemory[scopeKey()] = state.pluginId;
  }
}

function resetScopeUi() {
  state.runbookLoadGeneration += 1;
  state.auditLoadGeneration += 1;
  state.quickQuestionScopeGeneration += 1;
  state.quickQuestionLoadGeneration += 1;
  state.scopeInformationSupplementGeneration += 1;
  state.scopeInformationSupplementKey = null;
  state.scopeInformationSupplement = null;
  state.scopeInformationSupplementLoading = false;
  state.scopeInformationSupplementLoadedAt = 0;
  state.runbookScopeKey = null;
  state.runbookEditing = false;
  state.runbookLoading = false;
  state.quickQuestionItems = [];
  state.quickQuestionRevision = null;
  state.quickQuestionLoading = false;
  state.quickQuestionDraft = '';
  state.quickQuestionDiscoveredDate = '';
  state.quickQuestionScopeKey = null;
  state.quickQuestionRefreshPending = false;
  state.quickQuestionEditingId = null;
  if ($('#quickQuestionCommonDialog')?.open) $('#quickQuestionCommonDialog').close();
  if (!state.runbookDirty) {
    state.runbookContent = '';
    state.runbookDraft = '';
    state.runbookRevision = null;
  }
  state.mobileDetail = false;
  state.creatingEnvironmentInline = false;
  state.resourceEnvironmentEditor = null;
  state.resourceEnvironmentDeletePrompt = null;
  state.metadataEditingPluginId = null;
  state.agentEditingPluginId = null;
  state.newPluginType = null;
  state.pluginFormInstanceId = null;
  state.newPluginInstanceId = null;
  state.pluginProbe = null;
}

async function showProjectOverview(projectId) {
  if (!projectId) return;
  const project = state.projects.find((item) => item.projectId === projectId);
  if (!project) return;
  if (projectIsIsolated(project)) { toast(project.configurationError.message,true); return; }
  if (state.projectId === projectId && state.environmentId) {
    if (!await mayLeaveCurrentScope()) return;
    state.confirmationCenterActive = false;
    state.selectionKind = 'project';
    state.pluginId = null;
    state.expandedEnvironmentId = state.environmentId;
    state.scopeInformationSupplementGeneration += 1;
    state.scopeInformationSupplementKey = null;
    state.scopeInformationSupplement = null;
    state.scopeInformationSupplementLoading = false;
    state.scopeInformationSupplementLoadedAt = 0;
    renderShell();
    return;
  }
  if (!await mayLeaveCurrentScope()) return;
  state.confirmationCenterActive = false;
  rememberCurrentScope();
  const generation = ++state.navigationGeneration;
  state.projectTitleEditing = false;
  state.projectTitleDraft = '';
  state.projectId = projectId;
  state.projectOverviewActive = false;
  state.environmentId = null;
  state.pluginId = null;
  state.selectionKind = 'project';
  state.environmentDetailTab = 'information';
  state.environments = state.environmentsByProject[projectId] ?? [];
  state.plugins = [];
  state.runtime = null;
  state.loadedScopeKey = null;
  resetScopeUi();
  await loadProject(state.projectEnvironmentMemory[projectId],projectId,generation);
  if (generation !== state.navigationGeneration || state.projectId !== projectId) return;
  state.selectionKind = 'project';
  state.pluginId = null;
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
      state.selectionKind = 'plugin';
      state.expandedEnvironmentId = environmentId;
      renderShell();
    }
    return true;
  }
  if (!sameScope && !skipLeaveCheck && !await mayLeaveCurrentScope()) return false;
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
    state.expandedEnvironmentId = environmentId;
    resetScopeUi();
    // Switch the visible shell immediately so controls from the previous scope
    // cannot run while the new environment is loading.
    renderShell();
  }
  const preferred = pluginId ?? state.scopePluginMemory[requestedScopeKey];
  const loaded = await loadEnvironment(preferred,{ projectId,environmentId },generation);
  if (loaded && pluginId && state.plugins.some((plugin) => plugin.pluginInstanceId === pluginId)) {
    state.pluginId = pluginId;
    state.selectionKind = 'plugin';
    renderShell();
  }
  return Boolean(loaded && generation === state.navigationGeneration && state.projectId === projectId && state.environmentId === environmentId && !state.projectOverviewActive);
}

async function switchProject(id) { await showProjectOverview(id); }
async function switchEnvironment(id) {
  const changingSelection = state.environmentId !== id || state.selectionKind !== 'environment';
  if (changingSelection && !await mayLeaveCurrentScope()) return false;
  state.confirmationCenterActive = false;
  const opened = await openScope(state.projectId,id,{skipLeaveCheck:changingSelection});
  if (!opened) return false;
  state.selectionKind = 'environment';
  state.pluginId = null;
  state.environmentDetailTab = 'information';
  state.expandedEnvironmentId = id;
  renderShell();
  return true;
}

async function selectResourcePlugin(projectId,environmentId,pluginId) {
  const changingSelection = projectId !== state.projectId || environmentId !== state.environmentId || pluginId !== state.pluginId;
  if (changingSelection && !await mayLeaveCurrentScope()) return;
  state.confirmationCenterActive = false;
  const opened = await openScope(projectId,environmentId,{pluginId,skipLeaveCheck:changingSelection});
  if (!opened) return;
  state.selectionKind = 'plugin';
  state.pluginId = pluginId;
  state.scopePluginMemory[scopeKey()] = pluginId;
  state.detailTabs[pluginStateKey(pluginId,projectId,environmentId)] ??= 'connection';
  state.expandedEnvironmentId = environmentId;
  renderShell();
}

async function startAddPlugin(projectId = state.projectId,environmentId = state.environmentId) {
  if (!projectId || !environmentId || !await mayLeaveCurrentScope()) return;
  state.confirmationCenterActive = false;
  if (state.detailPaneCollapsed) setDetailPaneCollapsed(false);
  const opened = await openScope(projectId,environmentId,{skipLeaveCheck:true});
  if (!opened) return;
  state.selectionKind = 'new-plugin';
  state.newPluginType = null;
  state.pluginFormInstanceId = null;
  state.newPluginInstanceId = null;
  state.pluginProbe = null;
  state.pluginId = null;
  state.expandedEnvironmentId = environmentId;
  state.inlineConfigPluginId = null;
  renderShell();
}

function selectNewPluginType(type) {
  if (state.selectionKind !== 'new-plugin' || !pluginDefinition(type)) return false;
  state.newPluginType = type;
  state.pluginFormInstanceId = createPluginFormInstanceId();
  state.newPluginInstanceId = createNewPluginInstanceId(type);
  state.inlineConfigPluginId = null;
  renderShell();
  requestAnimationFrame(() => $('#pluginHost')?.focus({preventScroll:true}));
  return true;
}

async function returnToPluginTypePicker() {
  if (state.selectionKind !== 'new-plugin') return false;
  if (!await mayLeaveCurrentScope()) return false;
  state.newPluginType = null;
  state.pluginFormInstanceId = null;
  state.newPluginInstanceId = null;
  state.pluginProbe = null;
  state.inlineConfigPluginId = null;
  state.pluginFormInitial = null;
  renderShell();
  requestAnimationFrame(() => $('#pluginTypeChoices input')?.focus({preventScroll:true}));
  return true;
}

async function cancelNewPluginCreation() {
  if (state.selectionKind !== 'new-plugin' || !await mayLeaveCurrentScope()) return false;
  state.newPluginType = null;
  state.pluginFormInstanceId = null;
  state.newPluginInstanceId = null;
  state.pluginProbe = null;
  state.selectionKind = 'environment';
  state.pluginId = null;
  state.environmentDetailTab = 'information';
  state.inlineConfigPluginId = null;
  renderShell();
  return true;
}

function renderRuntimeOperationSurfaces(projectId,environmentId) {
  if (state.projectId !== projectId) return;
  renderResourcePane();
  if (state.projectOverviewActive) renderProjectOverview();
  else if (state.environmentId === environmentId && !state.confirmationCenterActive && state.view === 'plugins' && state.selectionKind === 'plugin') renderPluginDetail();
  else if (state.environmentId === environmentId && !state.confirmationCenterActive && state.view === 'plugin-config' && pluginFormVisible()) renderPluginFormDiagnostic();
}

async function handleEnvironmentRuntimeAction(action,projectId,environmentId) {
  const environment = environmentFor(projectId,environmentId);
  if (!environment) throw new Error('目标环境已经不存在，请刷新后重试。');
  if (action === 'configure') {
    const opened = await openScope(projectId,environmentId);
    if (!opened || state.projectId !== projectId || state.environmentId !== environmentId || state.projectOverviewActive) return;
    const incomplete = state.plugins.find((plugin) => (
      pluginConnectionViewModel(plugin,pluginRuntime(plugin.pluginInstanceId)).configurationState !== 'complete'
    ));
    if (incomplete) {
      state.pluginId = incomplete.pluginInstanceId;
      state.selectionKind = 'plugin';
      state.detailTabs[pluginStateKey(incomplete)] = 'configuration';
      state.scopePluginMemory[scopeKey()] = state.pluginId;
      state.inlineConfigPluginId = null;
      renderShell();
    } else await startAddPlugin(projectId,environmentId);
    return;
  }
  const scope = { projectId,environmentId };
  if (scopeDiagnosticPending(projectId,environmentId)) throw new Error('连接检查正在进行，请完成后再更改连接状态。');
  const operation = beginRuntimeOperation(projectId,environmentId,action);
  if (!operation) return;
  renderRuntimeOperationSurfaces(projectId,environmentId);
  try {
    let result;
    const request = () => api.requestConnectionIntent({
      ...scope,
      requestId:operation.requestId,
      planId:operation.planId,
      operationId:operation.operationId,
      intent:action,
      source:'renderer-environment',
      ...(action === 'connect' ? {expectedRevision:environmentFor(projectId,environmentId)?.revision} : {}),
    });
    if (action === 'cancel' || action === 'disconnect' || action === 'retry') result = await call(request());
    else if (action === 'connect') {
      try {
        result = await call(request());
      } catch (error) {
        if (error.code !== 'CONFIG_REVISION_CONFLICT') throw error;
        await refreshWorkspaceOverview({render:false});
        if (!runtimeOperationIsLatest(operation)) return;
        const current = environmentFor(projectId,environmentId);
        if (!current) throw new Error('目标环境已经不存在，请刷新后重试。');
        renewRuntimeConnectionIntent(operation);
        result = await call(request());
      }
    } else return;
    if (runtimeOperationIsLatest(operation)) {
      const runtime = result.snapshot;
      state.connectionActionsByScope ??= {};
      state.connectionActionsByScope[scopeKey(projectId,environmentId)] = result.actions ?? [];
      acceptRuntimeSnapshot({...runtime,projectId:runtime.projectId ?? projectId,environmentId:runtime.environmentId ?? environmentId});
    }
  } finally {
    const owner = state.connectionIntentOwners?.[operation.ownerKey];
    if (!operation.ownerInherited && owner?.planId === operation.planId && runtimeOperationIsLatest(operation)) delete state.connectionIntentOwners[operation.ownerKey];
    finishOperation(operation.operationKey,operation.token);
    renderRuntimeOperationSurfaces(projectId,environmentId);
  }
}

async function handleOverviewPluginRuntimeAction(action,projectId,environmentId,pluginInstanceId) {
  const environment = environmentFor(projectId,environmentId);
  const resource = projectId === state.projectId && environmentId === state.environmentId
    ? state.plugins.find((item) => item.pluginInstanceId === pluginInstanceId) ?? environment?.resourcePreview?.find((item) => item.pluginInstanceId === pluginInstanceId)
    : environment?.resourcePreview?.find((item) => item.pluginInstanceId === pluginInstanceId);
  if (!environment || !resource) throw new Error('目标资源已经不存在，请刷新后重试。');
  const scope = { projectId,environmentId,pluginInstanceId };
  if (scopeDiagnosticPending(projectId,environmentId,pluginInstanceId)) throw new Error('连接检查正在进行，请完成后再更改连接状态。');
  const operation = beginRuntimeOperation(projectId,environmentId,action,pluginInstanceId);
  if (!operation) return;
  renderRuntimeOperationSurfaces(projectId,environmentId);
  try {
    let result;
    let completionWarning = null;
    const request = (intent) => api.requestConnectionIntent({
      ...scope,
      requestId:operation.requestId,
      planId:operation.planId,
      operationId:operation.operationId,
      intent,
      source:'renderer-plugin',
    });
    if (action === 'trust-host') {
      if (!connectionHostKeyChallenge(scope)) throw new Error('服务器指纹确认已经失效，请重新连接以获取新的指纹。');
      const confirmation = await confirmRuntimeHostKeyChallenge(scope,operation);
      if (!confirmation || !runtimeOperationIsLatest(operation)) return;
      if (confirmation.plugin) {
        Object.assign(resource,confirmation.plugin);
        const loaded = state.plugins.find((item) => item.pluginInstanceId === pluginInstanceId);
        if (loaded && loaded !== resource) Object.assign(loaded,confirmation.plugin);
      }
      completionWarning = confirmation.runtimeWarning?.message ?? confirmation.persistenceWarning?.message ?? null;
      result = confirmation.connectionPlan ?? {
        outcome:'needs-action',actions:[],
        snapshot:await call(api.environmentStatus({projectId,environmentId})),
      };
    } else {
      const intent = ['disconnect','cancel','retry'].includes(action) ? action : 'connect';
      result = await call(request(intent));
      if (!runtimeOperationIsLatest(operation)) return;
      if (action !== 'disconnect' && connectionHostKeyChallenge(scope,result)) {
        const confirmation = await confirmRuntimeHostKeyChallenge(scope,operation,result);
        if (confirmation && runtimeOperationIsLatest(operation)) {
          if (confirmation.plugin) {
            Object.assign(resource,confirmation.plugin);
            const loaded = state.plugins.find((item) => item.pluginInstanceId === pluginInstanceId);
            if (loaded && loaded !== resource) Object.assign(loaded,confirmation.plugin);
          }
          completionWarning = confirmation.runtimeWarning?.message ?? confirmation.persistenceWarning?.message ?? null;
          result = confirmation.connectionPlan ?? {
            outcome:'needs-action',actions:[],
            snapshot:await call(api.environmentStatus({projectId,environmentId})),
          };
        }
      }
    }
    if (!runtimeOperationIsLatest(operation)) return;
    const runtime = result.snapshot;
    state.connectionActionsByScope ??= {};
    state.connectionActionsByScope[scopeKey(projectId,environmentId)] = result.actions ?? [];
    const normalizedRuntime = {...runtime,projectId:runtime.projectId ?? projectId,environmentId:runtime.environmentId ?? environmentId};
    acceptRuntimeSnapshot(normalizedRuntime);
    const latestRuntime = state.runtimeByScope[scopeKey(projectId,environmentId)] ?? normalizedRuntime;
    const phase = latestRuntime.plugins?.[pluginInstanceId]?.phase ?? 'disconnected';
    if (completionWarning) toast(completionWarning,true);
    else if (action === 'disconnect') toast(`${resource.displayName}已断开。`);
    else toast(`${resource.displayName}：${phase === 'connected' ? '已连接' : '连接失败'}`,phase !== 'connected');
    loadProjectOverviewActivity(projectId,{force:true}).catch(() => undefined);
  } finally {
    const owner = state.connectionIntentOwners?.[operation.ownerKey];
    if (!operation.ownerInherited && owner?.planId === operation.planId && runtimeOperationIsLatest(operation)) delete state.connectionIntentOwners[operation.ownerKey];
    finishOperation(operation.operationKey,operation.token);
    renderRuntimeOperationSurfaces(projectId,environmentId);
  }
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

document.addEventListener('input',(event) => {
  if (event.target.id === 'projectTitleInput') {
    state.projectTitleDraft = event.target.value;
    $('#projectTitleError').textContent = '';
    return;
  }
  const form = event.target.closest?.('[data-resource-environment-editor]');
  if (!form || event.target.tagName !== 'INPUT') return;
  const editor = resourceEnvironmentEditorFor(form.dataset.resourceProjectId,form.dataset.resourceEnvironmentEditor);
  if (!editor) return;
  editor.name = event.target.value;
  form.querySelector('.resource-environment-rename-error').textContent = '';
});

document.addEventListener('submit',(event) => {
  if (event.target.id === 'projectTitleEditor') {
    event.preventDefault();
    saveProjectTitleEdit().catch(showError);
    return;
  }
  const form = event.target.closest?.('[data-resource-environment-editor]');
  if (!form) return;
  event.preventDefault();
  saveResourceEnvironmentName(form).catch(showError);
});

document.addEventListener('keydown',(event) => {
  if (event.key !== 'Escape') return;
  if (event.target.closest?.('#projectTitleEditor')) {
    event.preventDefault();
    cancelProjectTitleEdit();
    return;
  }
  if (event.target.closest?.('[data-resource-environment-editor]')) {
    event.preventDefault();
    cancelResourceEnvironmentRename();
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) {
    const environmentButton = event.target.closest('.resource-environment-head')?.querySelector('.resource-environment-select');
    environmentButton?.click();
    return;
  }
  try {
    if (Date.now() < state.suppressRailClickUntil && target.closest('.rail-button')) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (target.dataset.passwordTarget) { await togglePasswordVisibility(target); return; }
    if (target.hasAttribute('data-confirm-credential-migration')) { await confirmCredentialMigration(target); return; }
    if (target.dataset.openConfirmations) {
      const filter = confirmationScopeData(target.dataset.openConfirmations,target.dataset.confirmationProject,target.dataset.confirmationEnvironment,target.dataset.confirmationPlugin);
      await openConfirmations(filter);
      return;
    }
    if (target.hasAttribute('data-close-confirmation-center')) { closeConfirmationCenter(); return; }
    if (target.dataset.confirmationFilter) {
      state.confirmationFilter = confirmationScopeData(target.dataset.confirmationFilter,target.dataset.confirmationProject,target.dataset.confirmationEnvironment,target.dataset.confirmationPlugin);
      renderConfirmationCenter();
      return;
    }
    if (target.dataset.locateConfirmation) {
      const item = state.confirmations.find((entry) => entry.requestId === target.dataset.locateConfirmation) ?? state.confirmationFeedback?.item;
      if (!item) return;
      const changingSelection = item.projectId !== state.projectId || item.environmentId !== state.environmentId || item.pluginInstanceId !== state.pluginId;
      if (changingSelection && !await mayLeaveCurrentScope()) return;
      state.confirmationCenterActive = false;
      const opened = await openScope(item.projectId,item.environmentId,{pluginId:item.pluginInstanceId,skipLeaveCheck:changingSelection});
      if (opened) {
        state.selectionKind = 'plugin';
        state.pluginId = item.pluginInstanceId;
        state.detailTabs[pluginStateKey(item.pluginInstanceId,item.projectId,item.environmentId)] ??= 'connection';
        renderShell();
      }
      return;
    }
    if (target.dataset.confirmationOpenAudit) {
      const item = state.confirmations.find((entry) => entry.requestId === target.dataset.confirmationOpenAudit) ?? state.confirmationFeedback?.item;
      if (!item) return;
      const changingSelection = item.projectId !== state.projectId || item.environmentId !== state.environmentId || item.pluginInstanceId !== state.pluginId;
      if (changingSelection && !await mayLeaveCurrentScope()) return;
      state.confirmationCenterActive = false;
      const opened = await openScope(item.projectId,item.environmentId,{pluginId:item.pluginInstanceId,skipLeaveCheck:changingSelection});
      if (opened) {
        state.selectionKind = 'plugin';
        state.pluginId = item.pluginInstanceId;
        state.detailTabs[pluginStateKey(item.pluginInstanceId,item.projectId,item.environmentId)] = 'audit';
        renderShell();
      }
      return;
    }
    if (target.id === 'projectSettingsShortcut') { beginProjectTitleEdit(); return; }
    if (target.id === 'saveProjectTitle') { event.preventDefault(); await saveProjectTitleEdit(); return; }
    if (target.id === 'cancelProjectTitle') { cancelProjectTitleEdit(); return; }
    if (target.id === 'projectDeleteShortcut') {
      const project = activeProject();
      if (!project) return;
      state.managingProjectId = project.projectId;
      openDeleteProject();
      return;
    }
    if (target.dataset.resourcePluginId) {
      await selectResourcePlugin(target.dataset.resourceProjectId ?? state.projectId,target.dataset.resourceEnvironmentId,target.dataset.resourcePluginId);
      return;
    }
    if (target.dataset.resourceEnvironmentId) {
      const environmentId = target.dataset.resourceEnvironmentId;
      const shouldCollapse = state.expandedEnvironmentId === environmentId;
      const switched = await switchEnvironment(environmentId);
      if (switched && shouldCollapse) {
        state.expandedEnvironmentId = null;
        renderResourcePane();
      }
      return;
    }
    if (target.dataset.resourceAddPlugin) {
      await startAddPlugin(state.projectId,target.dataset.resourceAddPlugin);
      return;
    }
    if (target.dataset.resourceRenameEnvironment) { beginResourceEnvironmentRename(state.projectId,target.dataset.resourceRenameEnvironment); return; }
    if (target.dataset.resourceDeleteEnvironment) { openEnvironmentDelete(state.projectId,target.dataset.resourceDeleteEnvironment); return; }
    if (target.hasAttribute('data-resource-cancel-environment-rename')) { cancelResourceEnvironmentRename(); return; }
    if (target.hasAttribute('data-resource-cancel-environment-delete')) { state.resourceEnvironmentDeletePrompt = null; renderScopeInformation(); return; }
    if (target.dataset.resourceConfirmEnvironmentDelete) { await confirmResourceEnvironmentDelete(target); return; }
    if (target.dataset.overviewPluginAction) {
      setElementBusy(target,true);
      try {
        await handleOverviewPluginRuntimeAction(target.dataset.overviewPluginAction,target.dataset.overviewProjectId,target.dataset.overviewEnvironmentId,target.dataset.overviewPluginId);
      } finally {
        if (target.isConnected) setElementBusy(target,false);
      }
      return;
    }
    if ('refreshOverviewActivity' in target.dataset) {
      if (state.projectId && state.projectOverviewActive) await loadProjectOverviewActivity(state.projectId,{force:true});
      return;
    }
    if (target.dataset.close) {
      if (target.dataset.close === 'pluginForm' && state.pluginFormMode === 'inline') {
        if (!await mayLeaveCurrentScope()) return;
        if (state.selectionKind === 'new-plugin') {
          state.selectionKind = 'environment';
          state.pluginId = null;
          state.environmentDetailTab = 'information';
          state.inlineConfigPluginId = null;
          renderShell();
          return;
        }
        renderInlinePluginConfig(true);
        return;
      }
      $(`#${target.dataset.close}`).close();
      return;
    }
    if (target.dataset.projectSettings) { openProjectSettings(target.dataset.projectSettings); return; }
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
      let message = `确定删除“${environment.name}”的配置和运维说明？本机加密凭据会继续保留。`;
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
      if (deletingCurrent && !await mayLeaveCurrentScope()) return;
      try {
        await deleteEnvironmentOnce(projectId,environmentId,target,async () => {
          if (state.overviewEnvironmentDeletePrompt?.projectId === projectId
            && state.overviewEnvironmentDeletePrompt?.environmentId === environmentId) state.overviewEnvironmentDeletePrompt = null;
          await refreshWorkspaceOverview({render:false});
          state.environments = state.environmentsByProject[state.projectId] ?? [];
          if (state.projectId === projectId && state.environmentId === environmentId) {
            state.environmentId = nextEnvironmentId;
            if (nextEnvironmentId) state.projectEnvironmentMemory[projectId] = nextEnvironmentId;
          }
          renderShell();
          toast(`“${environment.name}”的配置已删除；本机加密凭据仍保留。`);
        });
      } catch (error) {
        if (state.overviewEnvironmentDeletePrompt?.projectId === projectId
          && state.overviewEnvironmentDeletePrompt?.environmentId === environmentId) {
          state.overviewEnvironmentDeletePrompt = {projectId,environmentId,message:error?.message ?? '删除失败',confirmable:false};
          renderProjectOverview();
        } else showError(error);
      }
      return;
    }
    if (target.hasAttribute('data-overview-add-resource')) {
      await startAddPlugin(target.dataset.overviewProjectId,target.dataset.overviewEnvironmentId);
      return;
    }
    if (target.dataset.environmentRuntimeAction) {
      setElementBusy(target,true);
      try {
        await handleEnvironmentRuntimeAction(target.dataset.environmentRuntimeAction,target.dataset.actionProjectId,target.dataset.actionEnvironmentId);
      } finally {
        if (target.isConnected) setElementBusy(target,false);
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
      setElementBusy(target,true);
      try {
        await handleEnvironmentRuntimeAction(target.dataset.overviewRuntime,target.dataset.overviewProjectId,target.dataset.runtimeEnvironmentId);
      } finally {
        if (target.isConnected) setElementBusy(target,false);
      }
      return;
    }
    if (target.dataset.projectId) { await switchProject(target.dataset.projectId); return; }
    if (target.dataset.environmentId) { await switchEnvironment(target.dataset.environmentId); if ($('#environmentSwitcherDialog').open) $('#environmentSwitcherDialog').close(); return; }
    if (target.dataset.pluginId) { state.pluginId = target.dataset.pluginId; state.mobileDetail = true; state.scopePluginMemory[scopeKey()] = state.pluginId; renderPlugins(); return; }
    if (target.dataset.view) {
      if (target.dataset.view !== state.view && !await mayLeaveCurrentScope()) return;
      state.view = target.dataset.view;
      renderView();
      return;
    }
    if (target.dataset.detailTab) {
      if (state.selectionKind === 'new-plugin') {
        renderView();
        return;
      } else if (state.selectionKind === 'plugin') {
        const plugin = activePlugin();
        if (!plugin) return;
        if (detailTab(plugin) === 'configuration' && target.dataset.detailTab !== 'configuration' && !await mayLeaveCurrentScope()) return;
        state.detailTabs[pluginStateKey(plugin)] = target.dataset.detailTab;
      } else {
        if (state.environmentDetailTab === 'runbook' && target.dataset.detailTab !== 'runbook' && !await mayLeaveCurrentScope()) return;
        state.environmentDetailTab = target.dataset.detailTab;
      }
      renderDetailTopbar();
      renderView();
      return;
    }
    if (target.dataset.approveConfirmation) {
      const item = state.confirmations.find((entry) => entry.requestId === target.dataset.approveConfirmation);
      if (!item || (target.dataset.approvalLevel === 'strong' && target.disabled)) return;
      const operationKey = `confirmation:${item.requestId}`;
      const token = beginOperation(operationKey);
      if (!token) return;
      setElementBusy(target,true);
      clearConfirmationFeedback();
      if (state.confirmationCenterActive) renderConfirmationCenter();
      try {
        await call(api.approveConfirmation(item.requestId));
        state.confirmationFeedback = {item,status:'waiting'};
        await refreshConfirmations({render:false});
        renderConfirmationSurfaces();
        toast('已授权一次，正在等待 Agent 执行。');
      } finally {
        finishOperation(operationKey,token);
        if (state.confirmationCenterActive) renderConfirmationCenter();
      }
      return;
    }
    if (target.dataset.rejectConfirmation) {
      const item = state.confirmations.find((entry) => entry.requestId === target.dataset.rejectConfirmation);
      if (!item) return;
      const operationKey = `confirmation:${item.requestId}`;
      const token = beginOperation(operationKey);
      if (!token) return;
      setElementBusy(target,true);
      clearConfirmationFeedback();
      if (state.confirmationCenterActive) renderConfirmationCenter();
      try {
        await call(api.rejectConfirmation(item.requestId));
        state.confirmationFeedback = {item,status:'rejected'};
        await refreshConfirmations({render:false});
        renderConfirmationSurfaces();
        toast('操作已拒绝。');
      } finally {
        finishOperation(operationKey,token);
        if (state.confirmationCenterActive) renderConfirmationCenter();
      }
      return;
    }
    if (target.dataset.action === 'new-project') { $('#projectName').value=''; $('#firstEnvironmentName').value=''; $('#projectDialog').showModal(); return; }
    if (target.dataset.action === 'add-plugin') { await startAddPlugin(); return; }
    if (target.dataset.action === 'mobile-plugin-list') { state.mobileDetail = false; renderPlugins(); return; }
    if (target.dataset.action === 'edit-plugin-metadata') { state.metadataEditingPluginId = state.pluginId; renderPluginDetail(); return; }
    if (target.dataset.action === 'cancel-plugin-metadata') { state.metadataEditingPluginId = null; renderPluginDetail(); return; }
    if (target.dataset.action === 'save-plugin-metadata') { await savePluginMetadata(); return; }
    if (target.dataset.action === 'edit-plugin-agent') { state.agentEditingPluginId = state.pluginId; renderPluginDetail(); return; }
    if (target.dataset.action === 'cancel-plugin-agent') { state.agentEditingPluginId = null; renderPluginDetail(); return; }
    if (target.dataset.action === 'save-plugin-agent') { await savePluginAgentConfiguration(); return; }
    if (target.dataset.action === 'edit-plugin') {
      const plugin = activePlugin();
      if (!plugin) return;
      await beginPluginConnectionEditor(plugin);
      return;
    }
    if (target.dataset.action === 'prepare-delete-plugin') { openDeletePlugin(); return; }
    if (target.dataset.action === 'connect-plugin') {
      const plugin = activePlugin();
      if (!plugin) return;
      await handleOverviewPluginRuntimeAction('connect',plugin.projectId,plugin.environmentId,plugin.pluginInstanceId);
      return;
    }
    if (target.dataset.action === 'disconnect-plugin') {
      const plugin = activePlugin();
      if (!plugin) return;
      await handleOverviewPluginRuntimeAction('disconnect',plugin.projectId,plugin.environmentId,plugin.pluginInstanceId);
      return;
    }
    if (target.dataset.action === 'trust-host') {
      const plugin = activePlugin();
      if (!plugin) return;
      await handleOverviewPluginRuntimeAction('trust-host',plugin.projectId,plugin.environmentId,plugin.pluginInstanceId);
      return;
    }
  } catch (error) {
    if (target.closest('.plugin-card') && pluginFormVisible()) showPluginFormError(error);
    else showError(error);
  }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.dataset.confirmationAck) {
    const card = target.closest('[data-confirmation-card]');
    const approve = card?.querySelector(`[data-approve-confirmation="${CSS.escape(target.dataset.confirmationAck)}"]`);
    if (approve) approve.disabled = !target.checked;
    return;
  }
  if (target.matches('[name=pluginTypeChoice]')) {
    selectNewPluginType(target.value);
  }
});

initializePluginTypeOptions();
$('#pluginType').setAttribute('tabindex','-1');
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
{
  const app = $('#app');
  const pane = $('#resourcePane');
  const handle = $('#resourcePaneResizeHandle');
  let resize = null;
  const saveWidth = () => { try { localStorage.setItem(RESOURCE_PANE_WIDTH_KEY,String(Math.round(state.resourcePaneWidth))); } catch {} };
  const finishResize = (event) => {
    if (!resize || (event?.pointerId !== undefined && event.pointerId !== resize.pointerId)) return;
    const pointerId = resize.pointerId;
    resize = null;
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    app.classList.remove('resource-resizing');
    document.documentElement.classList.remove('resource-resizing');
    saveWidth();
  };
  handle.addEventListener('pointerdown',(event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resize = { pointerId:event.pointerId,startX:event.clientX,startWidth:state.resourcePaneWidth };
    handle.setPointerCapture(event.pointerId);
    app.classList.add('resource-resizing');
    document.documentElement.classList.add('resource-resizing');
  });
  handle.addEventListener('pointermove',(event) => {
    if (!resize || event.pointerId !== resize.pointerId) return;
    applyResourcePaneWidth(resize.startWidth + event.clientX - resize.startX);
  });
  handle.addEventListener('pointerup',finishResize);
  handle.addEventListener('pointercancel',finishResize);
  handle.addEventListener('lostpointercapture',finishResize);
  handle.addEventListener('dblclick',() => { state.resourcePaneWidth = RESOURCE_PANE_DEFAULT_WIDTH; applyResourcePaneWidth(); saveWidth(); });
  handle.addEventListener('keydown',(event) => {
    const { min,max } = resourcePaneWidthBounds();
    const current = state.resourcePaneWidth;
    let next = null;
    if (event.key === 'ArrowLeft') next = current - (event.shiftKey ? 32 : 8);
    if (event.key === 'ArrowRight') next = current + (event.shiftKey ? 32 : 8);
    if (event.key === 'Home') next = min;
    if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    applyResourcePaneWidth(next);
    saveWidth();
  });
}
function setDetailPaneCollapsed(collapsed) {
  state.detailPaneCollapsed = Boolean(collapsed);
  try { localStorage.setItem('ai-ops-detail-pane-collapsed',state.detailPaneCollapsed ? '1' : '0'); } catch {}
  renderDetailPaneState();
}
$('#toggleDetailPane').addEventListener('click',() => setDetailPaneCollapsed(!state.detailPaneCollapsed));
$('#expandDetailPane').addEventListener('click',() => setDetailPaneCollapsed(false));
$('#moreEnvironments').addEventListener('click', openEnvironmentSwitcher);
$('#confirmationButton').addEventListener('click', () => openConfirmations().catch(showError));
$('#showInlineEnvironmentCreate').addEventListener('click', beginInlineEnvironmentCreate);
$('#cancelInlineEnvironmentCreate').addEventListener('click', cancelInlineEnvironmentCreate);
$('#resourceEnvironmentCreateForm').addEventListener('submit', (event) => saveInlineEnvironmentCreate(event));
$('#addPlugin').addEventListener('click', () => startAddPlugin().catch(showError));
$('#cancelPluginTypeChoice').addEventListener('click', () => cancelNewPluginCreation().catch(showError));
$('#changeNewPluginType').addEventListener('click', () => returnToPluginTypePicker().catch(showError));
$('#pluginAuthType').addEventListener('change', () => {
  const plugin = state.editingPlugin;
  const select = $('#pluginAuthType');
  const authType = select.value;
  const previousAuthType = select.dataset.previousValue ?? plugin?.auth?.type ?? 'password';
  if ($('#pluginPassword').dataset.credentialState === 'edited'
    && !confirm('切换认证方式会放弃尚未保存的密码输入，确定继续？')) {
    select.value = previousAuthType;
    renderPluginForm();
    return;
  }
  select.dataset.previousValue = authType;
  state.credentialRevealGeneration += 1;
  setElementBusy($('[data-password-target="pluginPassword"]'),false);
  transitionPluginForm(() => {
    resetPasswordControl('pluginPassword');
    renderPluginForm();
    if (plugin?.pluginType === 'server' && plugin.auth?.type === authType) {
      const generation = ++state.credentialProbeGeneration;
      loadCredentialIndicators(plugin, generation).catch(showPluginFormError);
    }
  });
});
$('#pluginTransport').addEventListener('change', () => transitionPluginForm(renderPluginForm));
$('#pluginUplink').addEventListener('change', () => transitionPluginForm(renderPluginForm));
$('#queryDatabases').addEventListener('click', () => queryDatabases().catch(showPluginFormError));
$('#pluginDatabase').addEventListener('input', () => {
  clearPluginProbeIssueForInput($('#pluginDatabase'));
  $('#pluginDatabase').dataset.selectionSource = 'manual';
  markPluginDraftChanged();
});
$('#replacePrimaryCredential').addEventListener('click', () => {
  toggleCredentialReplacement('pluginPassword');
  state.databaseCredentialRevision += 1;
  invalidateDatabaseDiscovery();
  markPluginDraftChanged();
});
$('#replaceProxyCredential').addEventListener('click', () => {
  toggleCredentialReplacement('pluginProxyPassword');
  markPluginDraftChanged();
});
['pluginHost','pluginPort','pluginUsername','pluginAddressFamily','pluginTransport','pluginProvider','pluginVpnAlias','pluginTls'].forEach((id) => {
  $(`#${id}`).addEventListener(id === 'pluginHost' || id === 'pluginUsername' || id === 'pluginVpnAlias' ? 'input' : 'change', () => {
    clearPluginProbeIssueForInput($(`#${id}`));
    invalidateDatabaseDiscovery();
    markPluginDraftChanged();
    if (id === 'pluginTls') renderPluginForm();
    else renderPluginAdvancedSummary();
  });
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
    clearPluginProbeIssueForInput(input);
    input.dataset.credentialState = 'edited';
    updateCredentialComponent(id);
    updatePasswordToggle(id);
    if (id === 'pluginPassword') {
      state.databaseCredentialRevision += 1;
      invalidateDatabaseDiscovery();
    }
    markPluginDraftChanged();
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
    state.projectOverviewActive = false;
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
  if (project.projectId === state.projectId && !await mayLeaveCurrentScope()) return;
  button.disabled = true;
  try {
    await call(api.deleteProject({projectId:project.projectId}));
    $('#deleteProjectDialog').close();
    $('#projectSettingsDialog').close();
    delete state.environmentsByProject[project.projectId];
    for (const key of Object.keys(state.runtimeByScope)) if (key.startsWith(`${project.projectId}/`)) delete state.runtimeByScope[key];
    state.projectOrder = state.projectOrder.filter((id) => id !== project.projectId);
    try { localStorage.setItem(PROJECT_ORDER_KEY,JSON.stringify(state.projectOrder)); } catch {}
    state.projectOverviewActive = false;
    state.environmentId = null;
    state.pluginId = null;
    state.loadedScopeKey = null;
    await loadProjects(null);
    toast(`“${project.name}”的配置已删除；本机加密凭据仍保留。`);
  } catch (error) {
    showError(error);
    button.disabled = false;
  }
});

async function submitPluginForm(button, afterCommit = null) {
  if (button.disabled) return;
  const requestedScope = {projectId:state.projectId,environmentId:state.environmentId};
  const formGeneration = state.credentialProbeGeneration;
  const editingPluginId = state.editingPlugin?.pluginInstanceId ?? null;
  const lockNewPluginForm = creatingUnsavedPlugin();
  const form = pluginFormElement();
  setElementBusy(button,true);
  if (lockNewPluginForm && form) {
    form.inert = true;
    form.setAttribute('aria-busy','true');
  }
  clearPluginFormError();
  try { await savePlugin(afterCommit); } catch (error) {
    if (scopeMatches(requestedScope)
      && formGeneration === state.credentialProbeGeneration
      && editingPluginId === (state.editingPlugin?.pluginInstanceId ?? null)
      && pluginFormVisible()) showPluginFormError(error);
    else showError(error);
  } finally {
    if (lockNewPluginForm && form) {
      form.inert = false;
      form.removeAttribute('aria-busy');
    }
    if (pluginFormActive()) setElementBusy(button,false);
  }
}

$('#savePlugin').addEventListener('click', async (event) => {
  event.preventDefault();
  await submitPluginForm(event.currentTarget);
});
$('#savePluginOnly').addEventListener('click', (event) => submitPluginForm(event.currentTarget,'stay-disconnected'));
$('#saveAndConnectPlugin').addEventListener('click', (event) => submitPluginForm(event.currentTarget,'connect-current'));
$('#validateServerDraft').addEventListener('click', () => validatePluginDraftAction('validate').catch(showPluginFormError));
$('#validateMysqlDatabase').addEventListener('click', () => validatePluginDraftAction('validate').catch(showPluginFormError));
$('#validateRedisDraft').addEventListener('click', () => validatePluginDraftAction('validate').catch(showPluginFormError));
$('#validateTlsDraft').addEventListener('click', () => validatePluginDraftAction('tls').catch(showPluginFormError));
$('#cancelPluginValidation').addEventListener('click', () => cancelPluginValidationAction().catch(showPluginFormError));
$('#cancelPluginEdit').addEventListener('click', async () => {
  if (state.selectionKind === 'new-plugin') {
    await cancelNewPluginCreation();
    return;
  }
  if (!await mayLeaveCurrentScope()) return;
  const plugin = activePlugin();
  if (plugin) state.detailTabs[pluginStateKey(plugin)] = 'configuration';
  renderShell();
});
function invalidatePluginFormDiagnostic(event) {
  markPluginDraftChanged();
  const probe = activePluginProbe();
  if (probe && probe.purpose !== 'resource-discovery') {
    cancelLocalPluginProbe(probe,'stale');
    state.pluginFormDiagnostic = null;
    renderPluginFormDiagnostic();
  }
  if (state.pluginFormDiagnostic && state.pluginFormDiagnostic.status !== 'pending') {
    state.pluginFormDiagnostic = null;
    renderPluginFormDiagnostic();
  }
}
$('.plugin-card').addEventListener('input', invalidatePluginFormDiagnostic);
$('.plugin-card').addEventListener('change', invalidatePluginFormDiagnostic);
$('#confirmDeletePlugin').addEventListener('click', async () => {
  const scope = state.deletingPluginScope;
  if (!scope) { $('#deletePluginDialog').close(); return; }
  const operationKey = `plugin-delete:${scopeKey(scope.projectId,scope.environmentId)}:${scope.pluginInstanceId}`;
  const token = beginOperation(operationKey);
  if (!token) return;
  const button = $('#confirmDeletePlugin');
  setElementBusy(button,true);
  try {
    const result = await call(api.deletePlugin(scope));
    const runtimeWarningMessage = pluginRuntimeWarningMessage(result,'delete',scope.displayName);
    $('#deletePluginDialog').close();
    await refreshEnvironmentMetadata(scope);
    if (!scopeMatches(scope)) return;
    state.selectionKind = 'environment';
    state.environmentDetailTab = 'information';
    await loadEnvironment(null,{projectId:scope.projectId,environmentId:scope.environmentId});
    if (!scopeMatches(scope)) return;
    state.pluginId = null;
    renderShell();
    toast(runtimeWarningMessage ?? `“${scope.displayName}”已删除。`);
  } catch (error) { showError(error); }
  finally {
    finishOperation(operationKey,token);
    if (button.isConnected) setElementBusy(button,false);
  }
});
$('#projectDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#saveProject').click(); });
$('#projectSettingsDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#saveProjectSettings').click(); });
$('.plugin-card').addEventListener('submit', (event) => { event.preventDefault(); $('#savePlugin').click(); });
$('#editRunbook').addEventListener('click', () => {
  if (state.runbookLoading) return;
  if (!state.runbookDirty) state.runbookDraft = state.runbookContent;
  state.runbookEditing = true;
  renderRunbook();
  $('#runbookEditor').focus();
});
$('#runbookEditor').addEventListener('input', () => {
  state.runbookDraft = $('#runbookEditor').value;
  state.runbookDirty = state.runbookDraft !== state.runbookContent;
  const bytes = new TextEncoder().encode(state.runbookDraft).length;
  $('#runbookBytes').textContent = `${bytes.toLocaleString()} / 65,536 字节`;
  $('#runbookBytes').classList.toggle('error-text', bytes > 65_536);
  $('#saveRunbook').disabled = bytes > 65_536 || operationInFlight(`runbook-save:${scopeKey()}`);
});
$('#cancelRunbook').addEventListener('click', () => {
  state.runbookDraft = state.runbookContent;
  state.runbookDirty = false;
  state.runbookEditing = false;
  renderRunbook();
});
$('#saveRunbook').addEventListener('click', async () => {
  const requestedScope = { projectId:state.projectId, environmentId:state.environmentId };
  const operationKey = `runbook-save:${scopeKey(requestedScope.projectId,requestedScope.environmentId)}`;
  const token = beginOperation(operationKey);
  if (!token) return;
  try {
    const content = state.runbookDraft;
    if (new TextEncoder().encode(content).length > 65_536) throw new Error('运维说明不能超过 64 KiB。');
    const expectedRevision = environmentFor(requestedScope.projectId,requestedScope.environmentId)?.revision ?? state.runbookRevision;
    renderRunbook();
    const value = await call(api.saveRunbook({...requestedScope,content,expectedRevision}));
    if (!scopeMatches(requestedScope) || state.runbookScopeKey !== scopeKey()) return;
    const environment = activeEnvironment();
    if (environment && value.environment) Object.assign(environment,value.environment);
    state.runbookContent = content;
    state.runbookDraft = content;
    state.runbookRevision = value.environment?.revision ?? expectedRevision;
    state.runbookDirty = false;
    state.runbookEditing = false;
    renderRunbook();
    toast('运维说明已保存。');
  } catch (error) { showError(error); }
  finally {
    finishOperation(operationKey,token);
    if (scopeMatches(requestedScope) && state.view === 'runbook') renderRunbook();
  }
});
$('#refreshAudit').addEventListener('click', () => loadAudit().catch(showError));
$('#clearAudit').addEventListener('click', prepareClearAudit);
$('#confirmClearAudit').addEventListener('click', () => clearSelectedAudit().catch(showError));
$('#clearAuditDialog').addEventListener('close', () => { state.clearingAuditScope = null; });
$('#auditSearch').addEventListener('input', renderAudit);
$('#auditResult').addEventListener('change', renderAudit);
$('#quickQuestionInput').addEventListener('input',(event) => {
  state.quickQuestionDraft = event.currentTarget.value;
  syncQuickQuestionComposer();
});
$('#quickQuestionDiscoveredDate').addEventListener('input',(event) => {
  state.quickQuestionDiscoveredDate = event.currentTarget.value;
  syncQuickQuestionComposer();
});
$('#quickQuestionInput').addEventListener('keydown',(event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && state.quickQuestionDraft.trim()) {
    event.preventDefault();
    copyCurrentQuickQuestion().catch(showError);
  }
});
$('#quickQuestionCustomList').addEventListener('click',(event) => {
  const remove = event.target.closest('[data-quick-question-delete]');
  if (remove) {
    deleteCurrentQuickQuestion(remove.dataset.quickQuestionDelete).catch(showError);
    return;
  }
  const edit = event.target.closest('[data-quick-question-edit]');
  if (edit) {
    const item = state.quickQuestionItems.find((entry) => entry.questionId === edit.dataset.quickQuestionEdit);
    if (item) openQuickQuestionCommonDialog(item);
    return;
  }
  const fill = event.target.closest('[data-quick-question-fill]');
  if (!fill) return;
  const item = state.quickQuestionItems.find((entry) => entry.questionId === fill.dataset.quickQuestionFill);
  if (item) fillQuickQuestion(item.text);
});
$('#addQuickQuestionCommon').addEventListener('click',() => openQuickQuestionCommonDialog());
$('#saveQuickQuestion').addEventListener('click',() => openQuickQuestionCommonDialog(null,state.quickQuestionDraft.trim()));
$('#copyQuickQuestion').addEventListener('click',() => copyCurrentQuickQuestion().catch(showError));
$('#editQuickQuestionOpening').addEventListener('click',openQuickQuestionOpeningDialog);
$('#quickQuestionOpeningInput').addEventListener('input',syncQuickQuestionOpeningDialog);
$('#resetQuickQuestionOpening').addEventListener('click',() => {
  if (!state.quickQuestionOpeningDefaultText) return;
  $('#quickQuestionOpeningInput').value = state.quickQuestionOpeningDefaultText;
  syncQuickQuestionOpeningDialog();
});
$('#saveQuickQuestionOpening').addEventListener('click',() => saveQuickQuestionOpeningSetting().catch(showError));
$('#quickQuestionOpeningDialog').addEventListener('close',() => {
  if (!state.quickQuestionOpeningEditorStale) return;
  state.quickQuestionOpeningEditorStale = false;
  requestQuickQuestionOpeningRefresh();
});
$('#quickQuestionCommonInput').addEventListener('input',syncQuickQuestionCommonDialog);
$('#saveQuickQuestionFromDialog').addEventListener('click',() => saveQuickQuestionFromDialog().catch(showError));
$('#deleteQuickQuestionFromDialog').addEventListener('click',() => {
  if (state.quickQuestionEditingId) deleteCurrentQuickQuestion(state.quickQuestionEditingId,{closeDialog:true}).catch(showError);
});
$('#quickQuestionCommonDialog').addEventListener('close',() => {
  state.quickQuestionEditingId = null;
  $('#quickQuestionCommonError').textContent = '';
  $('#quickQuestionCommonError').classList.add('hidden');
});
function activateToastAction() {
  if ($('#toast').dataset.action === 'confirmations') openConfirmations().catch(showError);
}
$('#toast').addEventListener('click', activateToastAction);
$('#toast').addEventListener('keydown', (event) => {
  if (!['Enter',' '].includes(event.key) || !$('#toast').dataset.action) return;
  event.preventDefault();
  activateToastAction();
});

window.addEventListener('online', () => api.notifyNetworkChanged());
window.addEventListener('offline', () => api.notifyNetworkChanged());
window.addEventListener('resize', () => {
  if (layoutResizeFrame !== null) return;
  layoutResizeFrame = requestAnimationFrame(() => {
    layoutResizeFrame = null;
    applyProjectRailWidth();
    applyResourcePaneWidth();
  });
});
api.onEnvironmentStatus((runtime) => {
  if (!acceptRuntimeSnapshot(runtime)) return;
  scheduleRuntimeRender(runtime);
});

function invalidateWorkspaceActivity(change) {
  if (change.projectId !== state.projectOverviewActivityProjectId) return;
  const invalidatedProjectId = state.projectOverviewActivityProjectId;
  ++state.projectOverviewActivityGeneration;
  state.projectOverviewActivityProjectId = null;
  state.projectOverviewActivityEntries = [];
  state.projectOverviewActivityLoading = false;
  state.projectOverviewActivityRefreshing = false;
  if (state.projectOverviewActive && state.projectId === invalidatedProjectId) {
    setElementBusy($('[data-refresh-overview-activity]'),false);
    renderProjectOverviewActivity(invalidatedProjectId);
  }
}

function dedupeWorkspaceChanges(changes) {
  const unique = new Map();
  for (const change of changes) {
    const key = JSON.stringify([
      change.type,
      change.projectId ?? null,
      change.environmentId ?? null,
      change.pluginInstanceId ?? null,
      change.requestId ?? null,
    ]);
    unique.set(key,change);
  }
  return [...unique.values()];
}

async function drainWorkspaceChanges() {
  while (queuedWorkspaceChanges.length) {
    const batchSize = queuedWorkspaceChanges.length;
    const changes = dedupeWorkspaceChanges(queuedWorkspaceChanges.slice(0,batchSize));
    const refreshed = await refreshWorkspaceOverview({render:false});
    if (!refreshed) return false;
    const added = [...changes].reverse().find((change) => change.type === 'plugin-added'
      && change.projectId === state.projectId
      && change.environmentId === state.environmentId
      && !state.projectOverviewActive);
    if (added) {
      const loaded = await loadEnvironment(added.pluginInstanceId);
      if (loaded && scopeMatches(added)) toast(`Agent 已添加插件：${added.pluginName}`);
    } else {
      withUiContinuity(() => {
        if (state.dragSort || state.sortSaving) state.railRefreshPending = true;
        else renderProjects();
        if (state.projectOverviewActive && changes.some((change) => change.projectId === state.projectId)) renderProjectOverview();
        else if (!state.projectOverviewActive && changes.some((change) => scopeMatches(change))) renderResourcePane();
      });
    }
    queuedWorkspaceChanges.splice(0,batchSize);
  }
  return true;
}

function queueWorkspaceChange(change) {
  queuedWorkspaceChanges.push(change);
  invalidateWorkspaceActivity(change);
  if (!workspaceChangeRefreshPromise) {
    workspaceChangeRefreshPromise = Promise.resolve()
      .then(drainWorkspaceChanges)
      .catch(showError)
      .finally(() => { workspaceChangeRefreshPromise = null; });
  }
  return workspaceChangeRefreshPromise;
}

api.onWorkspaceChanged((change) => {
  if (change.type === 'quick-question-opening-updated') {
    requestQuickQuestionOpeningRefresh();
    return;
  }
  if (change.type === 'quick-questions-updated') {
    if (scopeMatches(change)) requestQuickQuestionRefresh(change);
    return;
  }
  if (change.type === 'confirmation-execution' && change.confirmationId) {
    rememberConfirmationExecution(change);
    if (state.confirmationFeedback?.item?.requestId === change.confirmationId) state.confirmationFeedback.status = change.status;
    if (state.confirmationCenterActive) renderConfirmationCenter();
    if (change.status === 'success') toast(`Agent 操作执行成功${Number.isFinite(change.durationMs) ? ` · ${change.durationMs.toLocaleString()} ms` : ''}`);
    if (change.status === 'error') toast(`Agent 操作执行失败：${auditErrorName(change.errorCode)}`,true);
    return;
  }
  queueWorkspaceChange(change);
});
api.onPluginValidationProgress?.(applyPluginValidationProgress);
api.onConfirmations((pending) => {
  state.confirmationLoadGeneration += 1;
  const previousIds = new Set(state.confirmations.map((item) => item.requestId));
  const added = pending.filter((item) => !previousIds.has(item.requestId));
  state.confirmations = pending;
  state.pendingCount = pendingConfirmations().length;
  const wasLoaded = state.confirmationsLoaded;
  state.confirmationsLoaded = true;
  renderConfirmationSurfaces();
  if (wasLoaded && added.length && !state.confirmationCenterActive) toast(`Agent 有 ${added.length} 项操作等待确认，点击查看。`,false,'confirmations');
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const openDialogs = $$('dialog[open]');
  const open = openDialogs[openDialogs.length - 1];
  if (!open) return;
  event.preventDefault();
  open.close();
});

setInterval(() => {
  const now = Date.now();
  let expired = false;
  $$('[data-confirmation-expires]').forEach((element) => {
    const item = state.confirmations.find((entry) => entry.requestId === element.dataset.confirmationExpires);
    if (!item) return;
    const remaining = Math.max(0,Math.ceil((confirmationExpiresAt(item) - now) / 1000));
    element.textContent = remaining ? `${remaining} 秒后过期` : '已过期';
    if (!remaining) expired = true;
  });
  if (expired) {
    state.confirmations = state.confirmations.filter((item) => confirmationExpiresAt(item) > now);
    renderConfirmationSurfaces();
  }
},1000);

Promise.all([loadProjects(),refreshConfirmations({render:false})]).then(() => renderShell()).catch(showError);
