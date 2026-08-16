const api = window.aiOps.v2;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name, className = 'icon') => `<svg class="${className}"><use href="#i-${name}"/></svg>`;

const state = {
  projects: [], environments: [], plugins: [], auditEntries: [], projectId: null,
  environmentId: null, pluginId: null, view: 'plugins', runtime: null,
  editingPlugin: null, editingEnvironmentId: null, detailTabs: {}, policyDrafts: {},
  runbookContent: '', runbookRevision: null, runbookScopeKey: null, runbookEditing: false, pendingCount: 0,
  projectEnvironmentMemory: {}, scopePluginMemory: {},
};

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

async function loadProjects(preferredId = state.projectId) {
  state.projects = await call(api.listProjects());
  state.projectId = preferredId && state.projects.some((item) => item.projectId === preferredId) ? preferredId : state.projects[0]?.projectId ?? null;
  renderProjects();
  if (state.projectId) await loadProject(state.projectEnvironmentMemory[state.projectId]);
  else renderShell();
}

async function loadProject(preferredEnvironment = state.environmentId) {
  state.environments = await call(api.listEnvironments(state.projectId));
  state.environmentId = preferredEnvironment && state.environments.some((item) => item.environmentId === preferredEnvironment) ? preferredEnvironment : state.environments[0]?.environmentId ?? null;
  state.pluginId = null;
  if (state.environmentId) await loadEnvironment(state.scopePluginMemory[scopeKey()]);
  else renderShell();
}

async function loadEnvironment(preferredPlugin = state.pluginId) {
  const scope = { projectId:state.projectId, environmentId:state.environmentId };
  const [plugins, runtime] = await Promise.all([call(api.listPlugins(scope)), call(api.environmentStatus(scope))]);
  state.plugins = plugins;
  state.runtime = runtime;
  state.pluginId = plugins.some((item) => item.pluginInstanceId === preferredPlugin) ? preferredPlugin : plugins.find((item) => item.pluginType === 'mysql')?.pluginInstanceId ?? plugins[0]?.pluginInstanceId ?? null;
  state.scopePluginMemory[scopeKey()] = state.pluginId;
  renderShell();
}

function projectMark(project) { return [...(project.name || '项')][0]; }
function renderProjects() {
  $('#projectList').innerHTML = state.projects.map((item) => `<button class="rail-button ${item.projectId === state.projectId ? 'active' : ''}" data-project-id="${escapeAttr(item.projectId)}" aria-label="${escapeAttr(item.name)}"><span class="rail-letter">${escapeHtml(projectMark(item))}</span><span class="project-tooltip">${escapeHtml(item.name)} · ${item.environmentCount} 个环境</span></button>`).join('');
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
    ['pluginsView','runbookView','auditView'].forEach((id) => $(`#${id}`).classList.add('hidden'));
    return;
  }
  $('#environmentTabs').innerHTML = visibleEnvironments().map((item) => `<button class="environment-tab ${item.environmentId === state.environmentId ? 'active' : ''}" data-environment-id="${escapeAttr(item.environmentId)}" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</button>`).join('');
  renderRuntime();
  renderView();
}

function renderRuntime() {
  const runtime = state.runtime ?? { phase:'disconnected', eligibleCount:0, connectedCount:0 };
  const status = $('#environmentStatus');
  status.dataset.state = runtime.phase;
  if (runtime.phase === 'connected') status.textContent = `${runtime.connectedCount}/${runtime.eligibleCount} 已连接`;
  else if (runtime.phase === 'partial') status.textContent = `${runtime.connectedCount}/${runtime.eligibleCount} 可用`;
  else if (runtime.phase === 'failed') status.textContent = `0/${runtime.eligibleCount} 可用`;
  else if (['connecting','reconnecting'].includes(runtime.phase)) status.textContent = `${phaseNames[runtime.phase]} ${runtime.connectedCount}/${runtime.eligibleCount}`;
  else status.textContent = phaseNames[runtime.phase] ?? '未连接';
  const action = $('#environmentAction');
  const disconnect = $('#environmentDisconnect');
  disconnect.classList.toggle('hidden', !runtime.desiredConnected || runtime.phase === 'connected');
  if (runtime.phase === 'connecting') action.textContent = '取消';
  else if (runtime.phase === 'connected') action.textContent = '断开环境';
  else if (runtime.desiredConnected) action.textContent = runtime.phase === 'reconnecting' ? '重连中' : '重试失败项';
  else action.textContent = '连接环境';
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
  $('#pluginCount').textContent = state.plugins.length ? state.plugins.length : '';
  const groups = ['server','mysql','redis'].map((type) => {
    const items = state.plugins.filter((item) => item.pluginType === type);
    if (!items.length) return '';
    return `<section class="plugin-group"><div class="plugin-group-label">${typeNames[type]} · ${items.length}</div>${items.map(pluginItem).join('')}</section>`;
  }).join('');
  $('#pluginList').innerHTML = groups || `<div class="detail-empty"><div><p>当前环境还没有插件</p><button class="button primary" data-action="add-plugin">添加插件</button></div></div>`;
  renderPluginDetail();
}

function pluginItem(plugin) {
  const runtime = pluginRuntime(plugin.pluginInstanceId);
  return `<button class="plugin-item ${plugin.pluginInstanceId === state.pluginId ? 'active' : ''}" data-plugin-id="${escapeAttr(plugin.pluginInstanceId)}"><span class="plugin-icon">${icon(typeIcons[plugin.pluginType])}</span><span class="plugin-copy"><strong>${escapeHtml(plugin.displayName)}</strong><small>${escapeHtml(pluginTarget(plugin))}</small></span><span class="state-dot ${escapeAttr(runtime.phase)}" title="${escapeAttr(phaseNames[runtime.phase] ?? runtime.phase)}"></span></button>`;
}

function detailTab(plugin) { return state.detailTabs[plugin.pluginInstanceId] ?? (plugin.pluginType === 'mysql' ? 'permissions' : 'connection'); }
function renderPluginDetail() {
  const plugin = activePlugin();
  if (!plugin) { $('#pluginDetail').innerHTML = '<div class="detail-empty"><div>选择一个插件查看详情</div></div>'; return; }
  const runtime = pluginRuntime(plugin.pluginInstanceId);
  const tab = detailTab(plugin);
  state.detailTabs[plugin.pluginInstanceId] = tab;
  const error = runtime.error?.message ? `<div class="inline-error"><span>${escapeHtml(runtime.error.message)}</span>${runtime.reason === 'SSH_HOST_KEY_CONFIRM_REQUIRED' ? '<button class="button small" data-action="trust-host">确认指纹并重试</button>' : '<button class="button small" data-action="test-plugin">检查连接</button>'}</div>` : '';
  $('#pluginDetail').innerHTML = `<header class="detail-head"><div class="detail-title-line"><span class="detail-icon">${icon(typeIcons[plugin.pluginType])}</span><div class="detail-title"><div class="detail-title-top"><h1>${escapeHtml(plugin.displayName)}</h1><span class="type-label">${typeNames[plugin.pluginType]}</span><span class="health ${escapeAttr(runtime.phase)}">${escapeHtml(phaseNames[runtime.phase] ?? runtime.phase)}</span></div><p class="detail-summary">${escapeHtml(pluginTarget(plugin))}</p></div><div class="detail-actions"><button class="button" data-action="test-plugin">检查连接</button><button class="button" data-action="edit-plugin">配置</button></div></div><nav class="detail-tabs"><button class="detail-tab ${tab === 'connection' ? 'active' : ''}" data-detail-tab="connection">连接</button><button class="detail-tab ${tab === 'permissions' ? 'active' : ''}" data-detail-tab="permissions">操作权限</button></nav></header><div class="detail-content">${error}${tab === 'connection' ? renderConnection(plugin) : renderPermissions(plugin)}</div>`;
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
  return `<div class="content-title"><h2>操作权限</h2><div class="content-actions"><button class="text-button ${dirty ? '' : 'hidden'}" data-action="discard-policy">放弃更改</button><button class="button small ${dirty ? 'primary' : ''}" data-action="save-policy" ${dirty ? '' : 'disabled'}>保存规则</button></div></div><section class="policy-section"><div class="policy-section-title">可配置</div>${configurable}</section><section class="policy-section"><div class="policy-section-title">固定禁止</div>${fixed}</section><div class="policy-limits">${icon('shield')}<span>${escapeHtml(limitSummary(plugin))}</span></div>`;
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
  $('#runbookPreview').classList.toggle('hidden', state.runbookEditing);
  $('#runbookEditor').classList.toggle('hidden', !state.runbookEditing);
  $('#editRunbook').classList.toggle('hidden', state.runbookEditing);
  $('#saveRunbook').classList.toggle('hidden', !state.runbookEditing);
  $('#cancelRunbook').classList.toggle('hidden', !state.runbookEditing);
}

async function loadAudit() {
  const requestedScope = scopeKey();
  const result = await call(api.listAudit({ projectId:state.projectId, environmentId:state.environmentId, limit:100 }));
  if (state.view !== 'audit' || requestedScope !== scopeKey()) return;
  state.auditEntries = result.entries ?? [];
  renderAudit();
}
function auditResult(entry) { return entry.result ?? (entry.errorCode ? 'error' : 'success'); }
function renderAudit() {
  const environment = activeEnvironment();
  if (!environment) return;
  $('#auditTitle').textContent = `${environment.name} · 操作记录`;
  const query = $('#auditSearch').value.trim().toLocaleLowerCase('zh-CN');
  const resultFilter = $('#auditResult').value;
  const rows = state.auditEntries.filter((entry) => {
    const result = auditResult(entry);
    const text = [entry.id,entry.type,entry.pluginInstanceId,entry.operation,entry.errorCode,entry.detail].join(' ').toLocaleLowerCase('zh-CN');
    return (!resultFilter || result === resultFilter) && (!query || text.includes(query));
  });
  $('#auditBody').innerHTML = rows.map((entry) => { const result = auditResult(entry); return `<tr><td>${escapeHtml(new Date(entry.time).toLocaleString())}<small>${escapeHtml(entry.id ?? '')}</small></td><td>${escapeHtml(entry.pluginInstanceId ?? '环境')}</td><td>${escapeHtml(entry.operation ?? entry.type ?? '')}</td><td><span class="result ${escapeAttr(result)}">${result === 'success' ? '成功' : result === 'blocked' ? '已拦截' : '失败'}</span></td><td>${escapeHtml(entry.detail ?? entry.errorCode ?? '')}</td></tr>`; }).join('');
  $('#auditEmpty').classList.toggle('hidden', rows.length > 0);
  $('.audit-table-wrap table').classList.toggle('hidden', rows.length === 0);
}

function openEnvironmentManager() {
  $('#environmentManagerScope').textContent = `${activeProject().name} · ${state.environments.length} 个环境`;
  $('#environmentManagerList').innerHTML = state.environments.map((item,index) => `<div class="manager-row" data-managed-environment-id="${escapeAttr(item.environmentId)}"><span><strong>${escapeHtml(item.name)}</strong><small>${item.pluginCount} 个插件</small></span><span class="manager-current">${item.environmentId === state.environmentId ? '当前查看' : ''}</span><span class="manager-actions"><button class="square-button" data-move-environment="${escapeAttr(item.environmentId)}" data-direction="-1" title="上移" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button><button class="square-button" data-move-environment="${escapeAttr(item.environmentId)}" data-direction="1" title="下移" ${index === state.environments.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button><button class="square-button" data-edit-environment="${escapeAttr(item.environmentId)}" title="编辑">${icon('edit')}</button><button class="square-button danger" data-delete-environment="${escapeAttr(item.environmentId)}" title="删除" ${state.environments.length <= 1 || item.pluginCount ? 'disabled' : ''}>${icon('trash')}</button></span></div>`).join('');
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

function openPluginDialog(plugin = null) {
  state.editingPlugin = plugin;
  const type = plugin?.pluginType ?? 'server';
  $('#pluginDialogTitle').textContent = plugin ? '配置插件' : '添加插件';
  $('#pluginDialogScope').textContent = `${activeProject().name} / ${activeEnvironment().name}`;
  $('#pluginType').value = type;
  $$('[name=pluginTypeChoice]').forEach((radio) => { radio.checked = radio.value === type; radio.disabled = Boolean(plugin); });
  $('#pluginDisplayName').value = plugin?.displayName ?? '';
  $('#pluginHost').value = plugin?.target?.host ?? '';
  $('#pluginPort').value = plugin?.target?.port ?? (type === 'server' ? 22 : type === 'mysql' ? 3306 : 6379);
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
  $('#deletePluginButton').classList.toggle('hidden', !plugin);
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
  const proxy = type === 'server' && ['socks5','http'].includes($('#pluginUplink').value);
  ['proxyHostField','proxyPortField','proxyUsernameField','proxyPasswordField'].forEach((id) => $(`#${id}`).classList.toggle('hidden', !proxy));
  $('#serverVpnField').classList.toggle('hidden', type !== 'server' || $('#pluginUplink').value !== 'windowsVpn');
  $('#tlsField').classList.toggle('hidden', !data);
  $('#providerField').classList.toggle('hidden', !data || $('#pluginTransport').value !== 'serverTunnel');
  $('#vpnField').classList.toggle('hidden', !data || $('#pluginTransport').value !== 'windowsVpn');
  const selectedProvider = $('#pluginProvider').value;
  $('#pluginProvider').innerHTML = state.plugins.filter((item) => item.pluginType === 'server').map((item) => `<option value="${escapeAttr(item.pluginInstanceId)}">${escapeHtml(item.displayName)}</option>`).join('');
  if (selectedProvider) $('#pluginProvider').value = selectedProvider;
}

async function savePlugin() {
  const type = $('#pluginType').value;
  const input = { pluginType:type, displayName:$('#pluginDisplayName').value.trim(), target:{ host:$('#pluginHost').value.trim(), port:Number($('#pluginPort').value), addressFamily:$('#pluginAddressFamily').value }, auth:{ username:$('#pluginUsername').value.trim() } };
  if (!input.displayName || !input.target.host || !input.target.port) throw new Error('请完整填写插件名称、主机地址和端口。');
  if (type === 'server') {
    input.auth.type = $('#pluginAuthType').value;
    if (input.auth.type === 'privateKey') input.auth.privateKeyPath = $('#pluginPrivateKeyPath').value.trim();
    input.uplink = { type:$('#pluginUplink').value };
    if (['socks5','http'].includes(input.uplink.type)) Object.assign(input.uplink,{host:$('#pluginProxyHost').value.trim(),port:Number($('#pluginProxyPort').value),username:$('#pluginProxyUsername').value.trim()});
    if (input.uplink.type === 'windowsVpn') input.uplink.interfaceAlias = $('#pluginServerVpnAlias').value.trim();
    input.sources = [];
    if ($('#pluginLogRoot').value.trim()) input.sources.push({sourceId:'logs',displayName:'应用日志',kind:'log',root:$('#pluginLogRoot').value.trim(),patterns:['*.log','*.txt']});
    if ($('#pluginConfigRoot').value.trim()) input.sources.push({sourceId:'config',displayName:'应用配置',kind:'config',root:$('#pluginConfigRoot').value.trim(),patterns:['*.yml','*.yaml','*.properties','*.conf','*.json','.env']});
  } else {
    input.transport = { kind:$('#pluginTransport').value };
    if (input.transport.kind === 'serverTunnel') input.transport.serverPluginInstanceId = $('#pluginProvider').value;
    if (input.transport.kind === 'windowsVpn') input.transport.interfaceAlias = $('#pluginVpnAlias').value.trim();
    input.tls = { mode:$('#pluginTls').value };
    if (type === 'mysql') input.target.database = $('#pluginDatabase').value.trim(); else input.target.db = Number($('#pluginRedisDb').value);
  }
  const secrets = $('#pluginPassword').value ? (type === 'server' && input.auth.type === 'privateKey' ? {privateKeyPassphrase:$('#pluginPassword').value} : {password:$('#pluginPassword').value}) : {};
  if (type === 'server' && $('#pluginProxyPassword').value) secrets.proxyPassword = $('#pluginProxyPassword').value;
  const scope = { projectId:state.projectId,environmentId:state.environmentId };
  const plugin = state.editingPlugin ? await call(api.updatePlugin({...scope,pluginInstanceId:state.editingPlugin.pluginInstanceId,patch:input,expectedRevision:state.editingPlugin.revision,secrets})) : await call(api.createPlugin({...scope,input,secrets}));
  $('#pluginDialog').close();
  await loadEnvironment(plugin.pluginInstanceId);
  toast('插件已保存；不会自动连接。');
}

async function environmentAction() {
  const scope = { projectId:state.projectId,environmentId:state.environmentId };
  const phase = state.runtime?.phase ?? 'disconnected';
  if (phase === 'connecting') state.runtime = await call(api.cancelEnvironment(scope));
  else if (phase === 'connected') state.runtime = await call(api.disconnectEnvironment(scope));
  else if (state.runtime?.desiredConnected) state.runtime = await call(api.retryEnvironment(scope));
  else state.runtime = await call(api.connectEnvironment({...scope,expectedRevision:activeEnvironment().revision}));
  renderShell();
}

function diagnosticSteps(plugin) {
  if (plugin.pluginType === 'server') return ['解析服务器地址',`建立 ${uplinkName(plugin)} 路由`,'验证 SSH 身份与主机指纹','检查已登记日志和配置源'];
  if (plugin.transport?.kind === 'serverTunnel') return ['检查 Server 插件','建立受控 SSH 隧道','验证数据库身份','检查固定数据库访问'];
  return ['解析目标地址',`建立 ${transportName(plugin)} 路由`,'验证服务身份','检查固定资源访问'];
}
async function testPlugin() {
  const plugin = activePlugin();
  const environment = activeEnvironment();
  $('#diagnosticTitle').textContent = `${plugin.displayName} · 连接检查`;
  $('#diagnosticScope').textContent = `${activeProject().name} / ${environment.name}`;
  const steps = diagnosticSteps(plugin);
  $('#diagnosticList').innerHTML = steps.map((step) => `<div class="diagnostic-row"><span>${icon('loader')}</span><strong>${escapeHtml(step)}</strong><span class="step-state">等待</span></div>`).join('');
  $('#diagnosticSummary').className = 'diagnostic-summary';
  $('#diagnosticSummary').textContent = '正在检查…';
  $('#diagnosticDialog').showModal();
  const rows = $$('.diagnostic-row', $('#diagnosticList'));
  try {
    const result = await call(api.testPlugin({projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId}));
    rows.forEach((row,index) => { row.classList.add('pass'); $('span:first-child',row).innerHTML = icon('check'); $('.step-state',row).textContent = `${12 + index * 17} ms`; });
    $('#diagnosticSummary').className = 'diagnostic-summary success';
    $('#diagnosticSummary').textContent = result.reused ? '插件当前已连接。' : '检查成功；环境连接状态未改变。';
  } catch (error) {
    const failIndex = Math.min(rows.length - 1, 2);
    rows.forEach((row,index) => { if (index < failIndex) { row.classList.add('pass'); $('span:first-child',row).innerHTML=icon('check'); $('.step-state',row).textContent=`${12+index*17} ms`; } });
    if (rows[failIndex]) { rows[failIndex].classList.add('fail'); $('span:first-child',rows[failIndex]).innerHTML=icon('x'); $('.step-state',rows[failIndex]).textContent='失败'; }
    $('#diagnosticSummary').className = 'diagnostic-summary failure';
    $('#diagnosticSummary').textContent = error.message;
  }
}

async function openConfirmations() {
  const pending = await call(api.listConfirmations());
  $('#confirmationList').innerHTML = pending.length ? pending.map((item) => `<div class="manager-row"><span><strong>${escapeHtml(item.capability)}</strong><small>${escapeHtml(item.pluginInstanceId)} · ${escapeHtml(item.environmentId)}</small></span><button class="button small" data-reject-confirmation="${escapeAttr(item.requestId)}">拒绝</button><button class="button small primary" data-approve-confirmation="${escapeAttr(item.requestId)}">确认一次</button></div>`).join('') : '<div class="dialog-empty">当前没有等待确认的操作</div>';
  $('#confirmationDialog').showModal();
}

async function switchProject(id) {
  if (id === state.projectId) return;
  if (state.runbookEditing && !confirm('运维说明尚未保存，确定切换项目？')) return;
  state.projectEnvironmentMemory[state.projectId] = state.environmentId;
  state.scopePluginMemory[scopeKey()] = state.pluginId;
  state.projectId = id;
  state.environmentId = null;
  state.runbookScopeKey = null;
  state.runbookEditing = false;
  await loadProject(state.projectEnvironmentMemory[id]);
}
async function switchEnvironment(id) {
  if (id === state.environmentId) return;
  if (state.runbookEditing && !confirm('运维说明尚未保存，确定切换环境？')) return;
  state.projectEnvironmentMemory[state.projectId] = id;
  state.scopePluginMemory[scopeKey()] = state.pluginId;
  state.environmentId = id;
  state.pluginId = null;
  state.runbookScopeKey = null;
  state.runbookEditing = false;
  await loadEnvironment(state.scopePluginMemory[scopeKey()]);
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.close) { $(`#${target.dataset.close}`).close(); return; }
    if (target.dataset.projectId) { await switchProject(target.dataset.projectId); return; }
    if (target.dataset.environmentId) { await switchEnvironment(target.dataset.environmentId); return; }
    if (target.dataset.pluginId) { state.pluginId = target.dataset.pluginId; state.scopePluginMemory[scopeKey()] = state.pluginId; renderPlugins(); return; }
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
    if (target.dataset.action === 'edit-plugin') { openPluginDialog(activePlugin()); return; }
    if (target.dataset.action === 'delete-plugin') {
      const plugin = activePlugin();
      if (!confirm(`删除插件“${plugin.displayName}”？`)) return;
      await call(api.deletePlugin({projectId:state.projectId,environmentId:state.environmentId,pluginInstanceId:plugin.pluginInstanceId}));
      if ($('#pluginDialog').open) $('#pluginDialog').close();
      delete state.policyDrafts[plugin.pluginInstanceId];
      await loadEnvironment();
      toast('插件已删除。');
      return;
    }
    if (target.dataset.action === 'test-plugin') { await testPlugin(); return; }
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
  } catch (error) { showError(error); }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.matches('[name=pluginTypeChoice]')) {
    $('#pluginType').value = target.value;
    $('#pluginPort').value = target.value === 'server' ? 22 : target.value === 'mysql' ? 3306 : 6379;
    renderPluginForm();
  }
  if (target.matches('[data-policy-key]')) {
    const plugin = activePlugin();
    state.policyDrafts[plugin.pluginInstanceId] = { ...policyDraft(plugin), [target.dataset.policyKey]:target.value };
    renderPluginDetail();
  }
});

$('#createProjectButton').addEventListener('click', () => { $('#projectName').value=''; $('#firstEnvironmentName').value=''; $('#projectDialog').showModal(); });
$('#addEnvironment').addEventListener('click', () => openEnvironmentEditor());
$('#manageEnvironments').addEventListener('click', openEnvironmentManager);
$('#managerAddEnvironment').addEventListener('click', () => openEnvironmentEditor());
$('#addPlugin').addEventListener('click', () => openPluginDialog());
$('#pluginAuthType').addEventListener('change', renderPluginForm);
$('#pluginTransport').addEventListener('change', renderPluginForm);
$('#pluginUplink').addEventListener('change', renderPluginForm);
$('#environmentAction').addEventListener('click', () => environmentAction().catch(showError));
$('#environmentDisconnect').addEventListener('click', async () => { try { state.runtime = await call(api.disconnectEnvironment({projectId:state.projectId,environmentId:state.environmentId})); renderShell(); } catch (error) { showError(error); } });

$('#saveProject').addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    const name = $('#projectName').value.trim();
    const environmentName = $('#firstEnvironmentName').value.trim();
    if (!name || !environmentName) throw new Error('请填写项目名称和第一个环境。');
    const project = await call(api.createProject({name,environmentName}));
    $('#projectDialog').close();
    await loadProjects(project.projectId);
  } catch (error) { showError(error); }
});

$('#saveEnvironment').addEventListener('click', async (event) => {
  event.preventDefault();
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
});

$('#savePlugin').addEventListener('click', async (event) => { event.preventDefault(); try { await savePlugin(); } catch (error) { showError(error); } });
$('#projectDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#saveProject').click(); });
$('#environmentDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#saveEnvironment').click(); });
$('#pluginDialog form').addEventListener('submit', (event) => { event.preventDefault(); $('#savePlugin').click(); });
$('#editRunbook').addEventListener('click', () => { state.runbookEditing = true; renderRunbook(); $('#runbookEditor').focus(); });
$('#cancelRunbook').addEventListener('click', () => { state.runbookEditing = false; $('#runbookEditor').value = state.runbookContent; renderRunbook(); });
$('#saveRunbook').addEventListener('click', async () => {
  try {
    const content = $('#runbookEditor').value;
    const value = await call(api.saveRunbook({projectId:state.projectId,environmentId:state.environmentId,content,expectedRevision:activeEnvironment().revision}));
    Object.assign(activeEnvironment(),value.environment);
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
api.onEnvironmentStatus((runtime) => { if (runtime.projectId === state.projectId && runtime.environmentId === state.environmentId) { state.runtime = runtime; renderRuntime(); if (state.view === 'plugins') renderPlugins(); } });
api.onConfirmations((pending) => { state.pendingCount = pending.length; if (pending.length) toast(`有 ${pending.length} 个操作等待确认，点击处理。`,false,'confirmations'); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { const open = $('dialog[open]'); if (open) open.close(); } });

loadProjects().catch(showError);
