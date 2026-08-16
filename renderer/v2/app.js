const api = window.aiOps.v2;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  projects: [], environments: [], plugins: [], projectId: null, environmentId: null,
  pluginId: null, view: 'plugins', type: 'all', runtime: null, editingPlugin: null,
  editingEnvironmentId: null, runbookRevision: null,
};

const typeNames = { server: 'Server', mysql: 'MySQL', redis: 'Redis' };
const typeIcons = { server: '▤', mysql: '◉', redis: '⌘' };
const phaseNames = { disconnected: '未连接', connecting: '连接中', connected: '已连接', partial: '部分可用', failed: '连接失败', reconnecting: '网络变化 · 重连中', blocked: '依赖不可用', error: '连接失败', waitingDependency: '等待隧道', disconnecting: '断开中' };
const policyLabels = {
  server: { status: '查看系统状态', diagnostics: '运行只读诊断动作', logs: '搜索与读取日志', config: '读取脱敏配置', download: '下载已登记文件' },
  mysql: { describe: '查看表结构', select: 'SELECT 只读查询', explain: 'EXPLAIN 执行计划' },
  redis: { scan: 'SCAN 扫描 Key', read: '读取值或元数据', ttl: '查看 TTL' },
};
const policyModeNames = { auto: '自动允许', confirm: '每次确认', deny: '禁止' };

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

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 3200);
}

function activeProject() { return state.projects.find((item) => item.projectId === state.projectId); }
function activeEnvironment() { return state.environments.find((item) => item.environmentId === state.environmentId); }
function activePlugin() { return state.plugins.find((item) => item.pluginInstanceId === state.pluginId); }

async function loadProjects(preferredId = state.projectId) {
  state.projects = await call(api.listProjects());
  if (preferredId && state.projects.some((item) => item.projectId === preferredId)) state.projectId = preferredId;
  else state.projectId = state.projects[0]?.projectId ?? null;
  renderProjects();
  if (state.projectId) await loadProject();
  else renderEmpty();
}

async function loadProject(preferredEnvironment = state.environmentId) {
  state.environments = await call(api.listEnvironments(state.projectId));
  state.environmentId = state.environments.some((item) => item.environmentId === preferredEnvironment)
    ? preferredEnvironment : state.environments[0]?.environmentId ?? null;
  state.pluginId = null;
  if (state.environmentId) await loadEnvironment();
  renderShell();
}

async function loadEnvironment(preferredPlugin = state.pluginId) {
  const scope = { projectId: state.projectId, environmentId: state.environmentId };
  const [plugins, runtime] = await Promise.all([call(api.listPlugins(scope)), call(api.environmentStatus(scope))]);
  state.plugins = plugins;
  state.runtime = runtime;
  const visible = filteredPlugins();
  state.pluginId = visible.some((item) => item.pluginInstanceId === preferredPlugin) ? preferredPlugin : visible[0]?.pluginInstanceId ?? null;
  renderShell();
}

function filteredPlugins() { return state.type === 'all' ? state.plugins : state.plugins.filter((item) => item.pluginType === state.type); }

function renderEmpty() {
  $('#emptyState').classList.remove('hidden');
  $('#workspace').classList.add('hidden');
  $('#projectTitle').textContent = '选择项目';
  $('#environmentPicker').disabled = true;
}

function renderProjects() {
  const query = $('#projectSearch').value.trim().toLocaleLowerCase();
  $('#projectList').innerHTML = state.projects.filter((item) => item.name.toLocaleLowerCase().includes(query)).map((item) => `
    <button class="project-item ${item.projectId === state.projectId ? 'active' : ''}" data-project-id="${escapeAttr(item.projectId)}">
      <span class="project-dot"></span><span class="project-copy"><strong>${escapeHtml(item.name)}</strong><small>${item.environmentCount} 个环境 · ${item.pluginCount} 个插件</small></span>
    </button>`).join('');
}

function renderShell() {
  renderProjects();
  const project = activeProject();
  const environment = activeEnvironment();
  if (!project || !environment) return renderEmpty();
  $('#emptyState').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#projectTitle').textContent = project.name;
  $('#environmentPicker').disabled = false;
  $('#environmentPicker').textContent = `${environment.name} ⌄`;
  renderEnvironmentTabs();
  renderRuntime();
  renderView();
}

function renderEnvironmentTabs() {
  const values = state.environments.slice(0, 5);
  $('#environmentTabs').innerHTML = values.map((item) => `<button class="environment-tab ${item.environmentId === state.environmentId ? 'active' : ''}" data-environment-id="${escapeAttr(item.environmentId)}">${escapeHtml(item.name)}</button>`).join('');
}

function renderRuntime() {
  const runtime = state.runtime ?? { phase: 'disconnected', eligibleCount: 0, connectedCount: 0 };
  const status = $('#environmentStatus');
  status.dataset.state = runtime.phase;
  if (runtime.phase === 'connected') status.textContent = `${runtime.connectedCount}/${runtime.eligibleCount} 已连接`;
  else if (runtime.phase === 'partial') status.textContent = `${runtime.connectedCount}/${runtime.eligibleCount} 可用`;
  else if (runtime.phase === 'connecting' || runtime.phase === 'reconnecting') status.textContent = `${phaseNames[runtime.phase]} ${runtime.connectedCount}/${runtime.eligibleCount}`;
  else status.textContent = phaseNames[runtime.phase] ?? '未连接';
  const action = $('#environmentAction');
  const disconnect = $('#environmentDisconnect');
  disconnect.classList.toggle('hidden', !runtime.desiredConnected || runtime.phase === 'connected');
  if (runtime.phase === 'connecting') action.textContent = '取消';
  else if (runtime.phase === 'connected') action.textContent = '断开环境';
  else if (runtime.desiredConnected) action.textContent = runtime.phase === 'reconnecting' ? '重连中' : '重试失败项';
  else action.textContent = '连接环境';
  action.disabled = runtime.phase === 'disconnecting' || runtime.phase === 'reconnecting';
}

function renderView() {
  $$('.page-tab').forEach((item) => item.classList.toggle('active', item.dataset.view === state.view));
  $('#pluginsView').classList.toggle('hidden', state.view !== 'plugins');
  $('#runbookView').classList.toggle('hidden', state.view !== 'runbook');
  $('#auditView').classList.toggle('hidden', state.view !== 'audit');
  if (state.view === 'plugins') renderPlugins();
  if (state.view === 'runbook') loadRunbook().catch(showError);
  if (state.view === 'audit') loadAudit().catch(showError);
}

function renderPlugins() {
  const counts = Object.fromEntries(['server', 'mysql', 'redis'].map((type) => [type, state.plugins.filter((item) => item.pluginType === type).length]));
  $('#typeFilters').innerHTML = `<button class="segment ${state.type === 'all' ? 'active' : ''}" data-type="all">全部 ${state.plugins.length}</button>${['server','mysql','redis'].map((type) => `<button class="segment ${state.type === type ? 'active' : ''}" data-type="${type}">${typeNames[type]} ${counts[type]}</button>`).join('')}`;
  const plugins = filteredPlugins();
  $('#pluginCount').textContent = `${plugins.length} 个插件`;
  const groups = ['server', 'mysql', 'redis'].map((type) => {
    const items = plugins.filter((item) => item.pluginType === type);
    if (!items.length) return '';
    return `<div class="plugin-group-label">${typeNames[type]} · ${items.length}</div>${items.map(pluginItem).join('')}`;
  }).join('');
  $('#pluginList').innerHTML = groups || '<div class="detail-empty">当前筛选没有插件</div>';
  renderPluginDetail();
}

function pluginRuntime(pluginId) { return state.runtime?.plugins?.[pluginId] ?? { phase: 'disconnected' }; }
function pluginItem(plugin) {
  const runtime = pluginRuntime(plugin.pluginInstanceId);
  return `<button class="plugin-item ${plugin.pluginInstanceId === state.pluginId ? 'active' : ''}" data-plugin-id="${escapeAttr(plugin.pluginInstanceId)}"><span class="plugin-icon">${typeIcons[plugin.pluginType]}</span><span><strong>${escapeHtml(plugin.displayName)}</strong><small>${escapeHtml(pluginTarget(plugin))}</small></span><span class="state-dot ${runtime.phase}" title="${escapeAttr(phaseNames[runtime.phase] ?? runtime.phase)}"></span></button>`;
}

function pluginTarget(plugin) {
  if (plugin.pluginType === 'server') return `${plugin.auth.username || '未配置'}@${plugin.target.host || '未配置'}:${plugin.target.port}`;
  if (plugin.pluginType === 'mysql') return `${plugin.target.database || '未配置数据库'} · ${transportName(plugin)}`;
  return `DB ${plugin.target.db} · ${transportName(plugin)}`;
}

function transportName(plugin) {
  if (plugin.transport?.kind === 'serverTunnel') return `经 ${providerName(plugin.transport.serverPluginInstanceId)} 隧道`;
  if (plugin.transport?.kind === 'windowsVpn') return `Windows VPN · ${plugin.transport.interfaceAlias}`;
  return '直接连接';
}
function providerName(id) { return state.plugins.find((item) => item.pluginInstanceId === id)?.displayName ?? id; }

function renderPluginDetail() {
  const plugin = activePlugin();
  if (!plugin) { $('#pluginDetail').innerHTML = '<div class="detail-empty">选择一个插件查看配置与操作规则</div>'; return; }
  const runtime = pluginRuntime(plugin.pluginInstanceId);
  const allowed = Object.entries(plugin.policy ?? {}).filter(([,mode]) => mode !== 'deny').length;
  const providerDependents = plugin.pluginType === 'server' ? state.plugins.filter((item) => item.transport?.serverPluginInstanceId === plugin.pluginInstanceId) : [];
  const props = plugin.pluginType === 'server'
    ? [['SSH 目标', `${plugin.auth.username}@${plugin.target.host}:${plugin.target.port}`], ['上行方式', uplinkName(plugin)], ['地址族', familyName(plugin.target.addressFamily)], ['主机指纹', plugin.target.hostKeyFingerprint || '首次连接时确认']]
    : [['目标', `${plugin.target.host}:${plugin.target.port}`], [plugin.pluginType === 'mysql' ? '固定数据库' : '固定 Logical DB', plugin.pluginType === 'mysql' ? plugin.target.database : String(plugin.target.db)], ['连接方式', transportName(plugin)], ['地址族', familyName(plugin.target.addressFamily)]];
  $('#pluginDetail').innerHTML = `<header class="detail-header"><span class="plugin-icon">${typeIcons[plugin.pluginType]}</span><div class="detail-title"><h1>${escapeHtml(plugin.displayName)} <span class="type-chip">${typeNames[plugin.pluginType]}</span></h1><div class="detail-subtitle">${escapeHtml(pluginTarget(plugin))}</div></div><div class="detail-actions"><button class="button" data-action="test-plugin">检查连接</button><button class="button" data-action="edit-plugin">配置</button><button class="button" data-action="delete-plugin">删除</button></div></header><div class="detail-body"><section class="detail-section"><h2>连接</h2><dl class="property-grid">${props.map(([key,value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join('')}<dt>当前状态</dt><dd><span class="status-chip ${runtime.phase}">${phaseNames[runtime.phase] ?? runtime.phase}</span>${runtime.error?.message ? ` · ${escapeHtml(runtime.error.message)}` : ''}</dd></dl></section><section class="detail-section"><h2>Agent 操作</h2><div class="permission-summary"><span>允许 ${allowed} 项结构化操作；禁止任意 Shell、跨库和未登记目标。</span><button class="button" data-action="policy">管理规则</button></div></section>${providerDependents.length ? `<section class="detail-section"><h2>隧道复用</h2><div class="dependent-list">${providerDependents.map((item) => `<div class="dependent"><span>${escapeHtml(item.displayName)}</span><span class="muted">${typeNames[item.pluginType]}</span></div>`).join('')}</div></section>` : ''}</div>`;
  if (runtime.reason === 'SSH_HOST_KEY_CONFIRM_REQUIRED') $('#pluginDetail .detail-actions').insertAdjacentHTML('afterbegin', '<button class="button primary" data-action="trust-host">确认指纹并重试</button>');
}

function uplinkName(plugin) { const type = plugin.uplink?.type ?? 'direct'; return type === 'direct' ? '直接连接' : type === 'windowsVpn' ? `Windows VPN · ${plugin.uplink.interfaceAlias}` : `${type.toUpperCase()} · ${plugin.uplink.host}:${plugin.uplink.port}`; }
function familyName(value) { return ({ ipv4Preferred:'IPv4 优先，失败尝试 IPv6', ipv4Only:'仅 IPv4', ipv6Preferred:'IPv6 优先，失败尝试 IPv4', ipv6Only:'仅 IPv6' })[value] ?? value; }

async function loadRunbook() {
  const environment = activeEnvironment();
  const result = await call(api.readRunbook({ projectId: state.projectId, environmentId: state.environmentId }));
  if (state.view !== 'runbook') return;
  $('#runbookScope').textContent = `${activeProject().name} / ${environment.name}`;
  $('#runbookEditor').value = result.content;
  state.runbookRevision = environment.revision;
}

async function loadAudit() {
  const result = await call(api.listAudit({ projectId: state.projectId, environmentId: state.environmentId, limit: 100 }));
  if (state.view !== 'audit') return;
  $('#auditList').innerHTML = result.entries.length ? result.entries.map((item) => `<div class="audit-row"><time>${escapeHtml(new Date(item.time).toLocaleString())}</time><span>${escapeHtml(item.type)}${item.pluginInstanceId ? ` · ${escapeHtml(item.pluginInstanceId)}` : ''}</span><small>${escapeHtml(item.result ?? item.errorCode ?? '')}</small></div>`).join('') : '<div class="detail-empty">暂无操作记录</div>';
}

function openEnvironmentMenu() {
  const button = $('#environmentPicker');
  const rect = button.getBoundingClientRect();
  const menu = $('#environmentMenu');
  menu.style.left = `${rect.left}px`; menu.style.top = `${rect.bottom + 8}px`;
  menu.innerHTML = state.environments.map((item) => `<button data-environment-id="${escapeAttr(item.environmentId)}"><strong>${escapeHtml(item.name)}</strong><span class="muted">${item.pluginCount} 个插件</span></button>`).join('');
  menu.classList.toggle('hidden');
}

function openEnvironmentManager() {
  $('#environmentManagerScope').textContent = `${activeProject().name} · ${state.environments.length} 个环境`;
  $('#environmentManagerList').innerHTML = state.environments.map((item, index) => `<div class="manager-row"><span><strong>${escapeHtml(item.name)}</strong><small>${item.environmentId === state.environmentId ? '当前查看 · ' : ''}${item.pluginCount} 个插件</small></span><span><button class="button small" data-move-environment="${escapeAttr(item.environmentId)}" data-direction="-1" ${index===0?'disabled':''}>↑</button> <button class="button small" data-move-environment="${escapeAttr(item.environmentId)}" data-direction="1" ${index===state.environments.length-1?'disabled':''}>↓</button></span><span><button class="button small" data-edit-environment="${escapeAttr(item.environmentId)}">编辑</button> <button class="button small danger" data-delete-environment="${escapeAttr(item.environmentId)}" ${state.environments.length <= 1 || item.pluginCount ? 'disabled' : ''}>删除</button></span></div>`).join('');
  $('#environmentManagerDialog').showModal();
}

function openPluginDialog(plugin = null) {
  state.editingPlugin = plugin;
  $('#pluginDialogTitle').textContent = plugin ? '配置插件' : '添加插件';
  $('#pluginDialogScope').textContent = `${activeProject().name} / ${activeEnvironment().name}`;
  $('#pluginType').disabled = Boolean(plugin);
  $('#pluginType').value = plugin?.pluginType ?? 'server';
  $('#pluginDisplayName').value = plugin?.displayName ?? '';
  $('#pluginHost').value = plugin?.target?.host ?? '';
  $('#pluginPort').value = plugin?.target?.port ?? 22;
  $('#pluginDatabase').value = plugin?.target?.database ?? '';
  $('#pluginRedisDb').value = plugin?.target?.db ?? 0;
  $('#pluginUsername').value = plugin?.auth?.username ?? '';
  $('#pluginPassword').value = '';
  $('#pluginAddressFamily').value = plugin?.target?.addressFamily ?? 'ipv4Preferred';
  $('#pluginTransport').value = plugin?.transport?.kind ?? 'direct';
  $('#pluginVpnAlias').value = plugin?.transport?.interfaceAlias ?? '';
  $('#pluginAuthType').value = plugin?.auth?.type ?? 'password';
  $('#pluginPrivateKeyPath').value = plugin?.auth?.privateKeyPath ?? '';
  $('#pluginUplink').value = plugin?.uplink?.type ?? 'direct';
  $('#pluginProxyHost').value = plugin?.uplink?.host ?? '';
  $('#pluginProxyPort').value = plugin?.uplink?.port ?? 1080;
  $('#pluginProxyUsername').value = plugin?.uplink?.username ?? '';
  $('#pluginProxyPassword').value = '';
  $('#pluginServerVpnAlias').value = plugin?.uplink?.interfaceAlias ?? '';
  $('#pluginLogRoot').value = plugin?.sources?.find((item) => item.kind === 'log')?.root ?? '';
  $('#pluginConfigRoot').value = plugin?.sources?.find((item) => item.kind === 'config')?.root ?? '';
  $('#pluginTls').value = plugin?.tls?.mode ?? 'disabled';
  renderPluginForm();
  if (plugin?.transport?.serverPluginInstanceId) $('#pluginProvider').value = plugin.transport.serverPluginInstanceId;
  $('#pluginDialog').showModal();
}

function renderPluginForm() {
  const type = $('#pluginType').value;
  const data = type !== 'server';
  $('#databaseField').classList.toggle('hidden', type !== 'mysql');
  $('#redisDbField').classList.toggle('hidden', type !== 'redis');
  $('#transportField').classList.toggle('hidden', !data);
  $('#authTypeField').classList.toggle('hidden', type !== 'server');
  $('#privateKeyField').classList.toggle('hidden', type !== 'server' || $('#pluginAuthType').value !== 'privateKey');
  $('#uplinkField').classList.toggle('hidden', type !== 'server');
  $('#serverLogsField').classList.toggle('hidden', type !== 'server');
  $('#serverConfigField').classList.toggle('hidden', type !== 'server');
  const proxyUplink = type === 'server' && ['socks5','http'].includes($('#pluginUplink').value);
  $('#proxyHostField').classList.toggle('hidden', !proxyUplink);
  $('#proxyPortField').classList.toggle('hidden', !proxyUplink);
  $('#proxyUsernameField').classList.toggle('hidden', !proxyUplink);
  $('#proxyPasswordField').classList.toggle('hidden', !proxyUplink);
  $('#serverVpnField').classList.toggle('hidden', type !== 'server' || $('#pluginUplink').value !== 'windowsVpn');
  $('#tlsField').classList.toggle('hidden', !data);
  $('#providerField').classList.toggle('hidden', !data || $('#pluginTransport').value !== 'serverTunnel');
  $('#vpnField').classList.toggle('hidden', !data || $('#pluginTransport').value !== 'windowsVpn');
  $('#pluginProvider').innerHTML = state.plugins.filter((item) => item.pluginType === 'server').map((item) => `<option value="${escapeAttr(item.pluginInstanceId)}">${escapeHtml(item.displayName)}</option>`).join('');
  if (!$('#pluginPort').value || state.editingPlugin?.pluginType !== type) $('#pluginPort').value = type === 'server' ? 22 : type === 'mysql' ? 3306 : 6379;
}

function openPolicy() {
  const plugin = activePlugin();
  $('#policyTitle').textContent = `${plugin.displayName} · 操作规则`;
  $('#policyScope').textContent = `${activeProject().name} / ${activeEnvironment().name}`;
  $('#policyRows').innerHTML = Object.entries(policyLabels[plugin.pluginType]).map(([key,label]) => `<div class="policy-row"><strong>${label}</strong><select data-policy-key="${key}"><option value="auto">自动允许</option><option value="confirm">每次确认</option><option value="deny">禁止</option></select></div>`).join('');
  $$('[data-policy-key]').forEach((select) => { select.value = plugin.policy[select.dataset.policyKey]; });
  $('#fixedLimits').textContent = plugin.pluginType === 'mysql' ? `固定数据库 ${plugin.target.database} · 禁止 USE、跨库、View、多语句和写入` : plugin.pluginType === 'redis' ? `固定 DB ${plugin.target.db} · 禁止写入、EVAL、MONITOR、KEYS 和 Agent 切库` : '仅允许内置结构化动作和已登记数据源；不提供任意 Shell。';
  $('#policyDialog').showModal();
}

async function openConfirmations() {
  const pending = await call(api.listConfirmations());
  $('#confirmationList').innerHTML = pending.length ? pending.map((item) => `<div class="manager-row"><span><strong>${escapeHtml(item.capability)}</strong><small>${escapeHtml(item.pluginInstanceId)} · ${escapeHtml(item.environmentId)}</small></span><button class="button small" data-reject-confirmation="${escapeAttr(item.requestId)}">拒绝</button><button class="button small primary" data-approve-confirmation="${escapeAttr(item.requestId)}">确认一次</button></div>`).join('') : '<div class="detail-empty" style="min-height:140px">当前没有等待确认的操作</div>';
  $('#confirmationDialog').showModal();
}

async function savePlugin() {
  const type = $('#pluginType').value;
  const input = { pluginType: type, displayName: $('#pluginDisplayName').value, target: { host: $('#pluginHost').value, port: Number($('#pluginPort').value), addressFamily: $('#pluginAddressFamily').value }, auth: { username: $('#pluginUsername').value }, };
  if (type === 'server') {
    input.auth.type = $('#pluginAuthType').value;
    if (input.auth.type === 'privateKey') input.auth.privateKeyPath = $('#pluginPrivateKeyPath').value;
    input.uplink = { type: $('#pluginUplink').value };
    if (['socks5','http'].includes(input.uplink.type)) { input.uplink.host=$('#pluginProxyHost').value; input.uplink.port=Number($('#pluginProxyPort').value); input.uplink.username=$('#pluginProxyUsername').value; }
    if (input.uplink.type === 'windowsVpn') input.uplink.interfaceAlias=$('#pluginServerVpnAlias').value;
    input.sources = [];
    if ($('#pluginLogRoot').value.trim()) input.sources.push({ sourceId:'logs',displayName:'应用日志',kind:'log',root:$('#pluginLogRoot').value.trim(),patterns:['*.log','*.txt'] });
    if ($('#pluginConfigRoot').value.trim()) input.sources.push({ sourceId:'config',displayName:'应用配置',kind:'config',root:$('#pluginConfigRoot').value.trim(),patterns:['*.yml','*.yaml','*.properties','*.conf','*.json','.env'] });
  }
  else {
    input.transport = { kind: $('#pluginTransport').value };
    if (input.transport.kind === 'serverTunnel') input.transport.serverPluginInstanceId = $('#pluginProvider').value;
    if (input.transport.kind === 'windowsVpn') input.transport.interfaceAlias = $('#pluginVpnAlias').value;
    input.tls = { mode: $('#pluginTls').value };
    if (type === 'mysql') input.target.database = $('#pluginDatabase').value;
    else input.target.db = Number($('#pluginRedisDb').value);
  }
  const secrets = $('#pluginPassword').value
    ? (type === 'server' && input.auth.type === 'privateKey' ? { privateKeyPassphrase: $('#pluginPassword').value } : { password: $('#pluginPassword').value })
    : {};
  if (type === 'server' && $('#pluginProxyPassword').value) secrets.proxyPassword = $('#pluginProxyPassword').value;
  const scope = { projectId: state.projectId, environmentId: state.environmentId };
  let plugin;
  if (state.editingPlugin) plugin = await call(api.updatePlugin({ ...scope, pluginInstanceId: state.editingPlugin.pluginInstanceId, patch: input, expectedRevision: state.editingPlugin.revision, secrets }));
  else plugin = await call(api.createPlugin({ ...scope, input, secrets }));
  $('#pluginDialog').close();
  await loadEnvironment(plugin.pluginInstanceId);
  toast('插件已保存；不会自动连接。');
}

async function environmentAction() {
  const scope = { projectId: state.projectId, environmentId: state.environmentId };
  const phase = state.runtime?.phase ?? 'disconnected';
  if (phase === 'connecting') state.runtime = await call(api.cancelEnvironment(scope));
  else if (phase === 'connected') state.runtime = await call(api.disconnectEnvironment(scope));
  else if (state.runtime?.desiredConnected) state.runtime = await call(api.retryEnvironment(scope));
  else state.runtime = await call(api.connectEnvironment({ ...scope, expectedRevision: activeEnvironment().revision }));
  renderShell();
}

function showError(error) { toast(error.message ?? String(error), true); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]); }
function escapeAttr(value) { return escapeHtml(value); }

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.projectId) { state.projectId = target.dataset.projectId; state.environmentId = null; await loadProject(null); return; }
    if (target.dataset.environmentId) { $('#environmentMenu').classList.add('hidden'); state.environmentId = target.dataset.environmentId; state.pluginId = null; await loadEnvironment(); return; }
    if (target.dataset.pluginId) { state.pluginId = target.dataset.pluginId; renderPlugins(); return; }
    if (target.dataset.type) { state.type = target.dataset.type; const visible = filteredPlugins(); if (!visible.some((item) => item.pluginInstanceId === state.pluginId)) state.pluginId = visible[0]?.pluginInstanceId ?? null; renderPlugins(); return; }
    if (target.dataset.view) { state.view = target.dataset.view; renderView(); return; }
    if (target.dataset.close) { $(`#${target.dataset.close}`).close(); return; }
    if (target.dataset.editEnvironment) { state.editingEnvironmentId = target.dataset.editEnvironment; const env = state.environments.find((item) => item.environmentId === state.editingEnvironmentId); $('#environmentDialogTitle').textContent = '编辑环境'; $('#environmentName').value = env.name; $('#environmentDialog').showModal(); return; }
    if (target.dataset.moveEnvironment) { const index=state.environments.findIndex((item)=>item.environmentId===target.dataset.moveEnvironment); const next=index+Number(target.dataset.direction); if(next<0||next>=state.environments.length)return; const ids=state.environments.map((item)=>item.environmentId); [ids[index],ids[next]]=[ids[next],ids[index]]; await call(api.reorderEnvironments({projectId:state.projectId,environmentIds:ids,expectedRevision:activeProject().revision})); $('#environmentManagerDialog').close(); await loadProjects(state.projectId); openEnvironmentManager(); return; }
    if (target.dataset.deleteEnvironment) { const env = state.environments.find((item) => item.environmentId === target.dataset.deleteEnvironment); if (!confirm(`删除空环境“${env.name}”？`)) return; await call(api.deleteEnvironment({ projectId: state.projectId, environmentId: env.environmentId })); $('#environmentManagerDialog').close(); await loadProject(state.environmentId === env.environmentId ? null : state.environmentId); return; }
    if (target.dataset.action === 'edit-plugin') return openPluginDialog(activePlugin());
    if (target.dataset.action === 'policy') return openPolicy();
    if (target.dataset.action === 'delete-plugin') { const plugin = activePlugin(); if (!confirm(`删除插件“${plugin.displayName}”？`)) return; await call(api.deletePlugin({ projectId: state.projectId, environmentId: state.environmentId, pluginInstanceId: plugin.pluginInstanceId })); await loadEnvironment(); return; }
    if (target.dataset.action === 'test-plugin') { const plugin = activePlugin(); const result = await call(api.testPlugin({ projectId: state.projectId, environmentId: state.environmentId, pluginInstanceId: plugin.pluginInstanceId })); toast(result.reused ? '插件当前已连接。' : '连接检查成功；环境连接状态未改变。'); return; }
    if (target.dataset.action === 'trust-host') { const plugin=activePlugin(); const fingerprint=pluginRuntime(plugin.pluginInstanceId).error?.details?.fingerprint; if(!fingerprint) throw new Error('没有可确认的服务器指纹。'); const value=await call(api.updatePlugin({projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId,patch:{target:{...plugin.target,hostKeyFingerprint:fingerprint}},expectedRevision:plugin.revision})); Object.assign(plugin,value); state.runtime=await call(api.retryEnvironment({projectId:state.projectId,environmentId:state.environmentId,secretsByPlugin:{[plugin.pluginInstanceId]:{acceptHostKey:fingerprint}}})); renderShell(); return; }
    if (target.dataset.approveConfirmation) { await call(api.approveConfirmation(target.dataset.approveConfirmation)); await openConfirmations(); toast('已确认一次；Agent 重试相同操作后执行。'); return; }
    if (target.dataset.rejectConfirmation) { await call(api.rejectConfirmation(target.dataset.rejectConfirmation)); await openConfirmations(); toast('操作已拒绝。'); return; }
  } catch (error) { showError(error); }
});

$('#projectSearch').addEventListener('input', renderProjects);
$('#settingsButton').addEventListener('click', () => openConfirmations().catch(showError));
$('#collapseRail').addEventListener('click', () => $('#app').classList.toggle('rail-collapsed'));
$('#environmentPicker').addEventListener('click', openEnvironmentMenu);
$('#manageEnvironments').addEventListener('click', openEnvironmentManager);
$('#createProjectButton').addEventListener('click', () => { $('#projectName').value=''; $('#firstEnvironmentName').value=''; $('#projectDialog').showModal(); });
$('#saveProject').addEventListener('click', async (event) => { event.preventDefault(); try { const project = await call(api.createProject({ name: $('#projectName').value, environmentName: $('#firstEnvironmentName').value })); $('#projectDialog').close(); await loadProjects(project.projectId); } catch(error){ showError(error); } });
$('#managerAddEnvironment').addEventListener('click', () => { state.editingEnvironmentId = null; $('#environmentDialogTitle').textContent='新增环境'; $('#environmentName').value=''; $('#environmentDialog').showModal(); });
$('#saveEnvironment').addEventListener('click', async (event) => { event.preventDefault(); try { if (state.editingEnvironmentId) { const env=state.environments.find((item)=>item.environmentId===state.editingEnvironmentId); await call(api.updateEnvironment({ projectId:state.projectId,environmentId:env.environmentId,patch:{name:$('#environmentName').value},expectedRevision:env.revision })); } else await call(api.createEnvironment({ projectId:state.projectId,input:{name:$('#environmentName').value} })); $('#environmentDialog').close(); $('#environmentManagerDialog').close(); await loadProject(state.environmentId); } catch(error){ showError(error); } });
$('#addPlugin').addEventListener('click', () => openPluginDialog());
$('#pluginType').addEventListener('change', renderPluginForm);
$('#pluginAuthType').addEventListener('change', renderPluginForm);
$('#pluginTransport').addEventListener('change', renderPluginForm);
$('#pluginUplink').addEventListener('change', renderPluginForm);
$('#savePlugin').addEventListener('click', async (event) => { event.preventDefault(); try { await savePlugin(); } catch(error){ showError(error); } });
$('#environmentAction').addEventListener('click', () => environmentAction().catch(showError));
$('#environmentDisconnect').addEventListener('click', async () => { try { state.runtime = await call(api.disconnectEnvironment({ projectId:state.projectId,environmentId:state.environmentId })); renderShell(); } catch(error){ showError(error); } });
$('#saveRunbook').addEventListener('click', async () => { try { const value=await call(api.saveRunbook({ projectId:state.projectId,environmentId:state.environmentId,content:$('#runbookEditor').value,expectedRevision:activeEnvironment().revision })); const env=activeEnvironment(); Object.assign(env,value.environment); state.runbookRevision=value.environment.revision; toast('运维说明已保存。'); } catch(error){ showError(error); } });
$('#refreshAudit').addEventListener('click', () => loadAudit().catch(showError));
$('#savePolicy').addEventListener('click', async () => { try { const plugin=activePlugin(); const policy=Object.fromEntries($$('[data-policy-key]').map((item)=>[item.dataset.policyKey,item.value])); const value=await call(api.savePolicy({ projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId,policy,expectedRevision:plugin.revision })); Object.assign(plugin,value); $('#policyDialog').close(); renderPlugins(); toast('操作规则已保存。'); } catch(error){ showError(error); } });
window.addEventListener('online', () => api.notifyNetworkChanged());
window.addEventListener('offline', () => api.notifyNetworkChanged());
api.onEnvironmentStatus((runtime) => { if (runtime.projectId===state.projectId && runtime.environmentId===state.environmentId) { state.runtime=runtime; renderRuntime(); if(state.view==='plugins') renderPlugins(); } });
api.onConfirmations((pending) => { if (!pending.length) return; toast(`有 ${pending.length} 个 Agent 操作等待确认。`); });
document.addEventListener('keydown', (event) => { if (event.key==='Escape') $('#environmentMenu').classList.add('hidden'); if ((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k') { event.preventDefault(); $('#projectSearch').focus(); } });

loadProjects().catch(showError);
