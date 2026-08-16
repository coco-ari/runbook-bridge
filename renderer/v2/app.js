const api = window.aiOps.v2;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name, className = 'icon') => `<svg class="${className}"><use href="#i-${name}"/></svg>`;
const STORED_PASSWORD_MASK = '*****';

const state = {
  projects: [], environments: [], plugins: [], auditEntries: [], projectId: null,
  environmentId: null, pluginId: null, view: 'plugins', runtime: null,
  editingPlugin: null, editingEnvironmentId: null, detailTabs: {}, policyDrafts: {}, navigationGeneration: 0,
  runbookContent: '', runbookRevision: null, runbookScopeKey: null, runbookEditing: false, pendingCount: 0,
  projectEnvironmentMemory: {}, scopePluginMemory: {},
  databaseDiscoverySignature: null, databaseCredentialRevision: 0, databaseQueryGeneration: 0,
  credentialProbeGeneration: 0,
  deletingPluginScope: null,
  runtimeByScope: {},
  pluginFormInitial: null,
  mobileDetail: false,
  projectRailExpanded: localStorage.getItem('ai-ops-project-rail-expanded') === '1',
};

let pluginFormTransitionGeneration = 0;
let pluginFormTransitionTimer = null;

const typeNames = { server: 'Server', mysql: 'MySQL', redis: 'Redis' };
const typeIcons = { server: 'server', mysql: 'db', redis: 'redis' };
const phaseNames = { disconnected:'未连接',connecting:'连接中',connected:'已连接',partial:'部分可用',failed:'连接失败',reconnecting:'网络变化 · 重连中',blocked:'依赖不可用',error:'连接失败',waitingDependency:'等待隧道',disconnecting:'断开中' };
const policyModeNames = { auto:'自动允许',confirm:'每次确认',deny:'禁止' };
const policyRules = {
  server: [
    { key:'status', label:'查看系统状态', icon:'eye', detail:'系统信息、磁盘与进程概览' },
    { key:'diagnostics', label:'运行安全诊断', icon:'plan', detail:'仅限内置、版本化的只读动作' },
    { key:'logs', label:'搜索与读取日志', icon:'search', detail:'仅限已登记日志源' },
    { key:'config', label:'读取脱敏配置', icon:'file', detail:'仅限已登记配置源' },
    { key:'download', label:'下载已登记文件', icon:'file', detail:'下载前按规则确认' },
  ],
  mysql: [
    { key:'describe', label:'查看表结构', icon:'eye', detail:'仅限当前固定数据库' },
    { key:'select', label:'SELECT 只读查询', icon:'search', detail:'单语句与有界结果' },
    { key:'explain', label:'EXPLAIN 执行计划', icon:'plan', detail:'仅允许分析 SELECT' },
  ],
  redis: [
    { key:'scan', label:'SCAN 扫描 Key', icon:'search', detail:'仅限允许的 Key pattern' },
    { key:'read', label:'读取值与元数据', icon:'eye', detail:'有界返回，超限截断' },
    { key:'ttl', label:'查看 TTL', icon:'plan', detail:'不改变 Key 状态' },
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

function toast(message, error = false, action = null) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  element.dataset.action = action ?? '';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), action ? 7000 : 3200);
}
function showError(error) { toast(error?.message ?? String(error), true); }

async function loadProjects(preferredId = state.projectId, generation = ++state.navigationGeneration) {
  const projects = await call(api.listProjects());
  if (generation !== state.navigationGeneration) return;
  state.projects = projects;
  state.projectId = preferredId && projects.some((item) => item.projectId === preferredId) ? preferredId : projects[0]?.projectId ?? null;
  renderProjects();
  if (state.projectId) await loadProject(state.projectEnvironmentMemory[state.projectId], state.projectId, generation);
  else renderShell();
}

async function loadProject(preferredEnvironment = state.environmentId, projectId = state.projectId, generation = ++state.navigationGeneration) {
  const environments = await call(api.listEnvironments(projectId));
  if (generation !== state.navigationGeneration || projectId !== state.projectId) return;
  state.environments = environments;
  state.environmentId = preferredEnvironment && environments.some((item) => item.environmentId === preferredEnvironment) ? preferredEnvironment : environments[0]?.environmentId ?? null;
  state.pluginId = null;
  if (state.environmentId) await loadEnvironment(state.scopePluginMemory[scopeKey()], { projectId, environmentId:state.environmentId }, generation);
  else renderShell();
}

async function loadEnvironment(preferredPlugin = state.pluginId, scope = { projectId:state.projectId, environmentId:state.environmentId }, generation = ++state.navigationGeneration) {
  const [plugins, runtime] = await Promise.all([call(api.listPlugins(scope)), call(api.environmentStatus(scope))]);
  if (generation !== state.navigationGeneration || scope.projectId !== state.projectId || scope.environmentId !== state.environmentId) return;
  state.plugins = plugins;
  state.runtime = runtime;
  state.runtimeByScope[scopeKey(scope.projectId, scope.environmentId)] = runtime;
  state.pluginId = plugins.some((item) => item.pluginInstanceId === preferredPlugin) ? preferredPlugin : plugins[0]?.pluginInstanceId ?? null;
  state.scopePluginMemory[scopeKey()] = state.pluginId;
  state.mobileDetail = false;
  renderShell();
}

async function refreshEnvironmentMetadata() {
  const currentId = state.environmentId;
  state.environments = await call(api.listEnvironments(state.projectId));
  if (!state.environments.some((item) => item.environmentId === currentId)) {
    state.environmentId = state.environments[0]?.environmentId ?? null;
  }
}

function projectMark(project) { return [...(project.name || '项目')].slice(0,2).join(''); }
function renderProjectRailState() {
  $('#app').classList.toggle('rail-expanded', state.projectRailExpanded);
  const toggle = $('#toggleProjectRail');
  toggle.setAttribute('aria-expanded', String(state.projectRailExpanded));
  toggle.setAttribute('aria-label', state.projectRailExpanded ? '收起项目列表' : '展开项目列表');
  toggle.title = state.projectRailExpanded ? '收起项目列表' : '展开项目列表';
}
function renderProjects() {
  renderProjectRailState();
  $('#projectList').innerHTML = state.projects.map((item) => `<button class="rail-button ${item.projectId === state.projectId ? 'active' : ''}" data-project-id="${escapeAttr(item.projectId)}" aria-label="${escapeAttr(item.name)}"><span class="rail-letter">${escapeHtml(projectMark(item))}</span><span class="rail-project-copy"><strong>${escapeHtml(item.name)}</strong><small>${item.environmentCount} 个环境</small></span><span class="project-tooltip">${escapeHtml(item.name)} · ${item.environmentCount} 个环境</span></button>`).join('');
}

function visibleEnvironments() {
  const current = activeEnvironment();
  if (state.environments.length <= 4 || !current) return state.environments.slice(0, 4);
  const first = state.environments.slice(0, 4);
  return first.some((item) => item.environmentId === current.environmentId) ? first : state.environments.slice(0, 3).concat(current);
}

function renderShell() {
  renderProjects();
  const project = activeProject();
  const environment = activeEnvironment();
  $('#projectTitle').textContent = project?.name ?? '选择项目';
  $('#emptyState').classList.toggle('hidden', Boolean(project && environment));
  $('#environmentRuntime').classList.toggle('hidden', !environment);
  $('#addEnvironment').disabled = !project;
  $('#manageEnvironments').disabled = !project;
  if (!project || !environment) {
    $('#environmentTabs').innerHTML = '';
    $('#moreEnvironments').classList.add('hidden');
    renderConfirmationButton();
    ['pluginsView','runbookView','auditView'].forEach((id) => $(`#${id}`).classList.add('hidden'));
    return;
  }
  $('#environmentTabs').innerHTML = visibleEnvironments().map((item) => `<button class="environment-tab ${item.environmentId === state.environmentId ? 'active' : ''}" data-environment-id="${escapeAttr(item.environmentId)}" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</button>`).join('');
  const hiddenEnvironmentCount = Math.max(0, state.environments.length - visibleEnvironments().length);
  $('#moreEnvironments').classList.toggle('hidden', hiddenEnvironmentCount === 0);
  $('#moreEnvironments').textContent = `更多 ${hiddenEnvironmentCount}`;
  renderConfirmationButton();
  renderRuntime();
  renderView();
}

function renderRuntime() {
  const runtime = state.runtime ?? { phase:'disconnected', eligibleCount:0, connectedCount:0 };
  const status = $('#environmentStatus');
  status.dataset.state = runtime.phase;
  const total = Number(runtime.eligibleCount ?? 0);
  const connected = Number(runtime.connectedCount ?? 0);
  if (runtime.phase === 'connected') status.textContent = `${connected}/${total} 已连接`;
  else if (runtime.phase === 'partial') status.textContent = `${connected}/${total} 可用`;
  else if (runtime.phase === 'failed') status.textContent = total ? `连接失败 · 0/${total}` : '没有可连接的插件';
  else if (runtime.phase === 'connecting') status.textContent = total ? `连接中 ${connected}/${total}` : '正在准备连接';
  else if (runtime.phase === 'reconnecting') status.textContent = total ? `网络变化 · 重连中 ${connected}/${total}` : '网络变化 · 重连中';
  else status.textContent = phaseNames[runtime.phase] ?? '未连接';
  const action = $('#environmentAction');
  const disconnect = $('#environmentDisconnect');
  disconnect.classList.toggle('hidden', !runtime.desiredConnected || !['partial','failed','reconnecting'].includes(runtime.phase));
  if (!total && !runtime.desiredConnected) action.textContent = state.plugins.length ? '完善插件' : '添加插件';
  else if (runtime.phase === 'connecting') action.textContent = '取消';
  else if (runtime.phase === 'connected') action.textContent = '断开环境';
  else if (runtime.phase === 'disconnecting') action.textContent = '断开中';
  else if (runtime.phase === 'reconnecting') action.textContent = '重连中';
  else if (runtime.desiredConnected) action.textContent = '重试失败项';
  else action.textContent = '连接全部插件';
  action.disabled = ['disconnecting','reconnecting'].includes(runtime.phase);
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

function fixedRules(plugin) {
  if (plugin.pluginType === 'mysql') return [{ label:'数据写入', detail:'INSERT · UPDATE · DELETE' },{ label:'结构与数据库切换', detail:'DDL · USE' },{ label:'跨库与多语句', detail:'database.table · 多条 SQL' }];
  if (plugin.pluginType === 'redis') return [{ label:'写入、脚本与管理命令', detail:'SET · DEL · EVAL · FLUSH · MONITOR' },{ label:'切换 Logical DB', detail:'Agent 不可执行 SELECT' }];
  return [{ label:'任意 Shell 与任意端口转发', detail:'仅开放内置结构化动作' },{ label:'读取未登记路径', detail:'日志与配置必须来自已登记数据源' }];
}
function policyDraft(plugin) { return state.policyDrafts[plugin.pluginInstanceId] ?? { ...plugin.policy }; }
function policyDirty(plugin) { return JSON.stringify(policyDraft(plugin)) !== JSON.stringify(plugin.policy ?? {}); }
function limitSummary(plugin) { if (plugin.pluginType === 'mysql') return `仅限 ${plugin.target.database} · 单语句 · 最多 ${plugin.limits?.maxRows ?? 100} 行 · ${Math.round((plugin.limits?.timeoutMs ?? 10000)/1000)} 秒超时`; if (plugin.pluginType === 'redis') return `固定 DB ${plugin.target.db} · 最多 ${plugin.limits?.maxKeys ?? 100} 个 Key · 不允许 Agent 切库`; return '只允许内置结构化动作和已登记数据源；不提供任意 Shell。'; }
function renderPermissions(plugin) {
  const draft = policyDraft(plugin);
  const dirty = policyDirty(plugin);
  const configurable = policyRules[plugin.pluginType].map((rule) => `<div class="policy-row"><span class="policy-row-icon">${icon(rule.icon)}</span><strong>${escapeHtml(rule.label)}</strong><span class="policy-detail">${escapeHtml(rule.detail)}</span><select class="rule-select" data-policy-key="${escapeAttr(rule.key)}" aria-label="${escapeAttr(rule.label)}">${Object.entries(policyModeNames).map(([value,label]) => `<option value="${value}" ${draft[rule.key] === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>`).join('');
  const fixed = fixedRules(plugin).map((rule) => `<div class="policy-row"><span class="policy-row-icon">${icon('lock')}</span><strong>${escapeHtml(rule.label)}</strong><span class="policy-detail">${escapeHtml(rule.detail)}</span><span class="locked-state">系统禁止</span></div>`).join('');
  return `<div class="content-title"><h2>Agent 权限</h2><div class="content-actions"><button class="text-button ${dirty ? '' : 'hidden'}" data-action="discard-policy">放弃更改</button><button class="button small ${dirty ? 'primary' : ''}" data-action="save-policy" ${dirty ? '' : 'disabled'}>保存规则</button></div></div><section class="policy-section"><div class="policy-section-title">允许 Agent 执行</div>${configurable}</section><section class="policy-section"><div class="policy-section-title">始终禁止</div>${fixed}</section><div class="policy-limits">${icon('shield')}<span>${escapeHtml(limitSummary(plugin))}</span></div>`;
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
  return ({status:'查看系统状态',diagnostics:'运行安全诊断',logs:'查询日志',config:'查看配置',download:'下载文件',describe:'查看表结构',select:'查询数据',explain:'查看执行计划',scan:'扫描缓存键',read:'读取缓存',ttl:'查看过期时间'})[value] ?? value;
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

function openEnvironmentManager() {
  $('#environmentManagerScope').textContent = `${activeProject().name} · ${state.environments.length} 个环境`;
  $('#environmentManagerList').innerHTML = state.environments.map((item,index) => `<div class="manager-row" data-managed-environment-id="${escapeAttr(item.environmentId)}"><span><strong>${escapeHtml(item.name)}</strong><small>${item.pluginCount} 个插件</small></span><span class="manager-actions"><button class="square-button" data-move-environment="${escapeAttr(item.environmentId)}" data-direction="-1" title="上移" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button><button class="square-button" data-move-environment="${escapeAttr(item.environmentId)}" data-direction="1" title="下移" ${index === state.environments.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button><button class="square-button" data-edit-environment="${escapeAttr(item.environmentId)}" title="重命名">${icon('edit')}</button><button class="button small danger" data-delete-environment="${escapeAttr(item.environmentId)}">删除</button></span></div>`).join('');
  if (!$('#environmentManagerDialog').open) $('#environmentManagerDialog').showModal();
}
function openEnvironmentEditor(id = null) {
  state.editingEnvironmentId = id;
  const environment = state.environments.find((item) => item.environmentId === id);
  $('#environmentDialogTitle').textContent = environment ? '重命名环境' : '新增环境';
  $('#environmentName').value = environment?.name ?? '';
  $('#environmentDialog').showModal();
  $('#environmentName').focus();
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
  const scope = { projectId:state.projectId,environmentId:state.environmentId };
  const phase = state.runtime?.phase ?? 'disconnected';
  if (!(state.runtime?.eligibleCount ?? 0) && !state.runtime?.desiredConnected) {
    if (!state.plugins.length) { openPluginDialog(); return; }
    const incomplete = state.plugins.find((plugin) => plugin.configState !== 'ready') ?? state.plugins[0];
    state.pluginId = incomplete.pluginInstanceId;
    state.scopePluginMemory[scopeKey()] = state.pluginId;
    renderPlugins();
    openPluginDialog(incomplete);
    return;
  }
  if (phase === 'connecting') state.runtime = await call(api.cancelEnvironment(scope));
  else if (phase === 'connected') state.runtime = await call(api.disconnectEnvironment(scope));
  else if (state.runtime?.desiredConnected) state.runtime = await call(api.retryEnvironment(scope));
  else {
    try {
      state.runtime = await call(api.connectEnvironment({...scope,expectedRevision:activeEnvironment().revision}));
    } catch (error) {
      if (error.code !== 'CONFIG_REVISION_CONFLICT') throw error;
      await refreshEnvironmentMetadata();
      state.runtime = await call(api.connectEnvironment({...scope,expectedRevision:activeEnvironment().revision}));
    }
  }
  renderShell();
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
    return `<article class="confirmation-row"><div class="confirmation-copy"><span class="confirmation-source">Agent 请求 · ${escapeHtml(item.projectNameSnapshot ?? project?.name ?? '项目')} / ${escapeHtml(item.environmentNameSnapshot ?? environment?.name ?? '环境')}</span><strong>${escapeHtml(auditCapabilityName(item.capability))}</strong><p>${escapeHtml(item.summary || '对已登记目标执行一次受控操作')}</p><small>目标：${escapeHtml(item.pluginNameSnapshot ?? plugin?.displayName ?? '插件')} · ${escapeHtml(new Date(item.createdAt).toLocaleTimeString())}</small></div><div class="confirmation-actions"><button class="button small" data-reject-confirmation="${escapeAttr(item.requestId)}">拒绝</button><button class="button small primary" data-approve-confirmation="${escapeAttr(item.requestId)}">确认一次</button></div></article>`;
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
    const phase = runtime?.phase ?? 'disconnected';
    const connection = phase === 'connected' ? `${runtime.connectedCount}/${runtime.eligibleCount} 已连接` : phase === 'partial' ? `${runtime.connectedCount}/${runtime.eligibleCount} 可用` : phaseNames[phase] ?? '未连接';
    return `<button class="switcher-row ${item.environmentId === state.environmentId ? 'active' : ''}" data-environment-id="${escapeAttr(item.environmentId)}"><span class="state-dot ${escapeAttr(phase)}"></span><strong>${escapeHtml(item.name)}</strong><small>${item.pluginCount} 个插件 · ${escapeHtml(connection)}</small></button>`;
  }).join('');
  $('#environmentSwitcherDialog').showModal();
}

function openDeletePlugin(plugin = activePlugin()) {
  if (!plugin) return;
  state.deletingPluginScope = { projectId:plugin.projectId, environmentId:plugin.environmentId, pluginInstanceId:plugin.pluginInstanceId, displayName:plugin.displayName };
  const dependents = plugin.pluginType === 'server' ? state.plugins.filter((item) => item.transport?.serverPluginInstanceId === plugin.pluginInstanceId) : [];
  $('#deletePluginScope').textContent = `${activeProject().name} / ${activeEnvironment().name}`;
  $('#deletePluginMessage').textContent = `确定删除“${plugin.displayName}”？连接配置和本机保存的凭据将一并移除。`;
  $('#deletePluginBlockers').classList.toggle('hidden', dependents.length === 0);
  $('#deletePluginBlockers').innerHTML = dependents.length ? `<strong>暂时不能删除</strong><p>以下插件正在复用它的隧道：${dependents.map((item) => escapeHtml(item.displayName)).join('、')}</p>` : '';
  $('#confirmDeletePlugin').disabled = dependents.length > 0;
  $('#deletePluginDialog').showModal();
}

async function switchProject(id) {
  if (id === state.projectId) return;
  if (state.runbookEditing && !confirm('运维说明尚未保存，确定切换项目？')) return;
  state.projectEnvironmentMemory[state.projectId] = state.environmentId;
  state.scopePluginMemory[scopeKey()] = state.pluginId;
  const generation = ++state.navigationGeneration;
  state.projectId = id;
  state.environmentId = null;
  state.runbookScopeKey = null;
  state.runbookEditing = false;
  await loadProject(state.projectEnvironmentMemory[id], id, generation);
}
async function switchEnvironment(id) {
  if (id === state.environmentId) return;
  if (state.runbookEditing && !confirm('运维说明尚未保存，确定切换环境？')) return;
  state.projectEnvironmentMemory[state.projectId] = id;
  state.scopePluginMemory[scopeKey()] = state.pluginId;
  const generation = ++state.navigationGeneration;
  state.environmentId = id;
  state.pluginId = null;
  state.runbookScopeKey = null;
  state.runbookEditing = false;
  await loadEnvironment(state.scopePluginMemory[scopeKey()], { projectId:state.projectId, environmentId:id }, generation);
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.passwordTarget) { await togglePasswordVisibility(target); return; }
    if (target.dataset.close) {
      if (target.dataset.close === 'pluginDialog' && pluginFormDirty() && !confirm('插件配置尚未保存，确定放弃更改？')) return;
      $(`#${target.dataset.close}`).close();
      return;
    }
    if (target.dataset.projectId) { await switchProject(target.dataset.projectId); return; }
    if (target.dataset.environmentId) { await switchEnvironment(target.dataset.environmentId); if ($('#environmentSwitcherDialog').open) $('#environmentSwitcherDialog').close(); return; }
    if (target.dataset.pluginId) { state.pluginId = target.dataset.pluginId; state.mobileDetail = true; state.scopePluginMemory[scopeKey()] = state.pluginId; renderPlugins(); return; }
    if (target.dataset.view) { if (state.runbookEditing && target.dataset.view !== 'runbook' && !confirm('运维说明尚未保存，确定离开？')) return; state.view = target.dataset.view; renderView(); return; }
    if (target.dataset.detailTab) { const plugin = activePlugin(); state.detailTabs[plugin.pluginInstanceId] = target.dataset.detailTab; renderPluginDetail(); return; }
    if (target.dataset.editEnvironment) { openEnvironmentEditor(target.dataset.editEnvironment); return; }
    if (target.dataset.moveEnvironment) {
      const index = state.environments.findIndex((item) => item.environmentId === target.dataset.moveEnvironment);
      const next = index + Number(target.dataset.direction);
      if (index < 0 || next < 0 || next >= state.environments.length) return;
      const ids = state.environments.map((item) => item.environmentId);
      [ids[index],ids[next]] = [ids[next],ids[index]];
      await call(api.reorderEnvironments({projectId:state.projectId,environmentIds:ids,expectedRevision:activeProject().revision}));
      await loadProjects(state.projectId);
      openEnvironmentManager();
      return;
    }
    if (target.dataset.deleteEnvironment) {
      const environment = state.environments.find((item) => item.environmentId === target.dataset.deleteEnvironment);
      if (state.environments.length <= 1) { toast('项目至少需要保留一个环境。',true); return; }
      if (environment?.pluginCount) { toast(`“${environment.name}”还有 ${environment.pluginCount} 个插件，请先处理插件。`,true); return; }
      const runtime = state.runtimeByScope[scopeKey(state.projectId,environment?.environmentId)];
      if (runtime?.desiredConnected || (runtime && runtime.phase !== 'disconnected')) { toast(`请先断开“${environment.name}”。`,true); return; }
      if (!environment || !confirm(`删除空环境“${environment.name}”？`)) return;
      await call(api.deleteEnvironment({projectId:state.projectId,environmentId:environment.environmentId}));
      $('#environmentManagerDialog').close();
      await loadProject(state.environmentId === environment.environmentId ? null : state.environmentId);
      toast('环境已删除。');
      return;
    }
    if (target.dataset.approveConfirmation) { await call(api.approveConfirmation(target.dataset.approveConfirmation)); await openConfirmations(); toast('已确认一次。'); return; }
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
    if (target.dataset.action === 'discard-policy') { delete state.policyDrafts[activePlugin().pluginInstanceId]; renderPluginDetail(); return; }
    if (target.dataset.action === 'save-policy') {
      const plugin = activePlugin();
      const policy = policyDraft(plugin);
      const value = await call(api.savePolicy({projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId,policy,expectedRevision:plugin.revision}));
      Object.assign(plugin,value);
      delete state.policyDrafts[plugin.pluginInstanceId];
      renderPluginDetail();
      toast('操作规则已保存。');
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
  if (target.matches('[data-policy-key]')) {
    const plugin = activePlugin();
    state.policyDrafts[plugin.pluginInstanceId] = { ...policyDraft(plugin), [target.dataset.policyKey]:target.value };
    renderPluginDetail();
  }
});

$('#createProjectButton').addEventListener('click', () => { $('#projectName').value=''; $('#firstEnvironmentName').value=''; $('#projectDialog').showModal(); });
$('#toggleProjectRail').addEventListener('click', () => {
  state.projectRailExpanded = !state.projectRailExpanded;
  localStorage.setItem('ai-ops-project-rail-expanded', state.projectRailExpanded ? '1' : '0');
  renderProjectRailState();
});
$('#addEnvironment').addEventListener('click', () => openEnvironmentEditor());
$('#manageEnvironments').addEventListener('click', openEnvironmentManager);
$('#moreEnvironments').addEventListener('click', openEnvironmentSwitcher);
$('#confirmationButton').addEventListener('click', () => openConfirmations().catch(showError));
$('#managerAddEnvironment').addEventListener('click', () => openEnvironmentEditor());
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
$('#environmentDisconnect').addEventListener('click', async () => { try { state.runtime = await call(api.disconnectEnvironment({projectId:state.projectId,environmentId:state.environmentId})); renderShell(); } catch (error) { showError(error); } });

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
    await loadProjects(project.projectId);
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});

$('#saveEnvironment').addEventListener('click', async (event) => {
  event.preventDefault();
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  try {
    const name = $('#environmentName').value.trim();
    if (!name) throw new Error('请输入环境名称。');
    if (state.editingEnvironmentId) {
      const environment = state.environments.find((item) => item.environmentId === state.editingEnvironmentId);
      await call(api.updateEnvironment({projectId:state.projectId,environmentId:environment.environmentId,patch:{name},expectedRevision:environment.revision}));
    } else await call(api.createEnvironment({projectId:state.projectId,input:{name}}));
    $('#environmentDialog').close();
    await loadProject(state.environmentId);
    if ($('#environmentManagerDialog').open) openEnvironmentManager();
    toast(state.editingEnvironmentId ? '环境名称已更新。' : '环境已创建。');
    state.editingEnvironmentId = null;
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
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
    delete state.policyDrafts[scope.pluginInstanceId];
    await refreshEnvironmentMetadata();
    await loadEnvironment();
    toast(`“${scope.displayName}”已删除。`);
  } catch (error) { showError(error); }
});
$('#projectDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#saveProject').click(); });
$('#environmentDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#saveEnvironment').click(); });
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
api.onEnvironmentStatus((runtime) => {
  state.runtimeByScope[scopeKey(runtime.projectId,runtime.environmentId)] = runtime;
  if (runtime.projectId === state.projectId && runtime.environmentId === state.environmentId) { state.runtime = runtime; renderRuntime(); if (state.view === 'plugins') renderPlugins(); }
});
api.onWorkspaceChanged((change) => {
  if (change.projectId !== state.projectId || change.environmentId !== state.environmentId) return;
  loadEnvironment(change.pluginInstanceId).then(() => toast(`Agent 已添加插件：${change.pluginName}`)).catch(showError);
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
