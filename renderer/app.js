const state = {
  projects: [],
  selectedProjectId: null,
  selectedDocument: null,
  loadedDocumentKey: null,
  documentDirty: false,
  documentLoadSequence: 0,
  documentLoading: false,
  documentBusy: false,
  refreshSequence: 0,
  mode: 'edit',
  dialogMode: 'create',
  dialogProjectId: null,
  dialogSubmissionSequence: 0,
  dialogBusy: false,
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  projectList: $('#project-list'),
  emptyState: $('#empty-state'),
  projectView: $('#project-view'),
  projectName: $('#project-name'),
  serverAddress: $('#server-address'),
  badge: $('#connection-badge'),
  connectionButton: $('#connection-button'),
  docTabs: $('#doc-tab-list'),
  editor: $('#document-editor'),
  preview: $('#document-preview'),
  codexStatus: $('#codex-status'),
  dialog: $('#project-dialog'),
  form: $('#project-form'),
  dialogTitle: $('#dialog-title'),
  dialogError: $('#dialog-error'),
  submitProject: $('#submit-project'),
  editProject: $('#edit-project'),
  deleteProject: $('#delete-project'),
  documentDialog: $('#document-dialog'),
  documentForm: $('#document-form'),
  documentName: $('#document-name'),
  documentDialogError: $('#document-dialog-error'),
  credentialStorageNote: $('#credential-storage-note'),
  documentSaveState: $('#document-save-state'),
  documentSubmit: $('#submit-document'),
  appVersion: $('#app-version'),
};

function unwrap(response) {
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message || '操作失败。'), response?.error);
  return response.data;
}

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function currentProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) ?? null;
}

function currentDialogProject() {
  return state.projects.find((project) => project.id === state.dialogProjectId) ?? null;
}

function currentDocumentKey() {
  return state.selectedProjectId && state.selectedDocument
    ? `${state.selectedProjectId}\u0000${state.selectedDocument}`
    : null;
}

function updateDocumentSaveState() {
  elements.documentSaveState.textContent = state.documentDirty ? '未保存' : '';
  elements.documentSaveState.classList.toggle('hidden', !state.documentDirty);
}

function setDocumentBusy(busy) {
  state.documentBusy = busy;
  $('#save-document').disabled = busy || state.documentLoading;
  $('#delete-document').disabled = busy || state.documentLoading;
  $('#add-document').disabled = busy;
}

function setProjectDialogBusy(busy) {
  state.dialogBusy = busy;
  elements.submitProject.disabled = busy;
  $('#close-dialog').disabled = busy;
  $('#cancel-dialog').disabled = busy;
}

function confirmDiscardDocumentChanges() {
  return !state.documentDirty || window.confirm('当前文档还有未保存的修改，确定放弃这些修改吗？');
}

async function refreshProjects({ preserveSelection = true } = {}) {
  const sequence = ++state.refreshSequence;
  const projects = unwrap(await window.aiOps.listProjects());
  if (sequence !== state.refreshSequence) return;
  state.projects = projects;
  if (!preserveSelection || !state.projects.some((p) => p.id === state.selectedProjectId)) {
    state.selectedProjectId = state.projects[0]?.id ?? null;
  }
  renderProjects();
  await renderSelectedProject();
}

function renderProjects() {
  elements.projectList.replaceChildren();
  for (const project of state.projects) {
    const button = document.createElement('button');
    button.className = `project-item${project.id === state.selectedProjectId ? ' selected' : ''}`;
    const dotState = project.status.connected ? 'connected' : project.status.reconnecting ? 'reconnecting' : '';
    button.innerHTML = `<span class="project-dot ${dotState}"></span><strong></strong><small></small>`;
    button.querySelector('strong').textContent = project.name;
    button.querySelector('small').textContent = project.ssh.host;
    button.addEventListener('click', async () => {
      if (project.id !== state.selectedProjectId && !confirmDiscardDocumentChanges()) return;
      state.selectedProjectId = project.id;
      state.selectedDocument = null;
      state.loadedDocumentKey = null;
      state.documentDirty = false;
      updateDocumentSaveState();
      renderProjects();
      await renderSelectedProject();
    });
    elements.projectList.append(button);
  }
}

async function renderSelectedProject() {
  const project = currentProject();
  elements.emptyState.classList.toggle('hidden', Boolean(project));
  elements.projectView.classList.toggle('hidden', !project);
  if (!project) return;
  elements.projectName.textContent = project.name;
  elements.serverAddress.textContent = `${project.ssh.username}@${project.ssh.host}:${project.ssh.port}`;
  const reconnecting = project.status.reconnecting || (project.status.connecting && !project.status.connected);
  const reconnectStopped = Boolean(project.status.reconnectStopped);
  const connectionActive = project.status.connected || reconnecting;
  elements.badge.textContent = project.status.connected
    ? '已连接'
    : reconnecting
      ? '自动重连中'
      : reconnectStopped
        ? '重连已停止'
        : '未连接';
  elements.badge.className = `badge ${project.status.connected ? 'connected' : reconnecting ? 'reconnecting' : 'disconnected'}`;
  elements.connectionButton.textContent = project.status.connected ? '断开' : reconnecting ? '停止重连' : '连接';
  elements.connectionButton.className = connectionActive ? 'outline danger' : 'outline';
  elements.editProject.disabled = connectionActive;
  elements.editProject.title = connectionActive ? '请先断开当前连接或停止重连' : '修改服务器、认证和代理设置';
  updateCodexStatus(project.status);
  const docs = project.documents ?? [];
  if (!docs.includes(state.selectedDocument)) state.selectedDocument = docs[0] ?? null;
  renderDocumentTabs(docs);
  if (state.selectedDocument) {
    // Project status is refreshed periodically. Do not reload the active document
    // unless the selected project/document actually changed, otherwise an in-progress
    // edit would be overwritten with the last version from disk.
    if (state.loadedDocumentKey !== currentDocumentKey()) await loadDocument(state.selectedDocument);
  } else {
    elements.editor.value = '';
    state.loadedDocumentKey = null;
    state.documentDirty = false;
    updateDocumentSaveState();
  }
}

function updateCodexStatus(status) {
  const reconnecting = status.reconnecting || (status.connecting && !status.connected);
  const reconnectStopped = Boolean(status.reconnectStopped);
  elements.codexStatus.className = `codex-status ${status.connected ? 'connected' : reconnecting ? 'reconnecting' : 'disconnected'}`;
  const strong = elements.codexStatus.querySelector('strong');
  const span = elements.codexStatus.querySelector('span');
  strong.textContent = status.connected
    ? 'Codex 可以使用当前 SSH 连接'
    : reconnecting
      ? 'SSH 正在自动重连'
      : reconnectStopped
        ? 'SSH 自动重连已停止'
      : 'Codex 当前不能操作服务器';
  span.textContent = status.connected
    ? status.autoReconnectEnabled
      ? '网络意外中断时会自动重连；主动断开后立即失效'
      : '当前连接未保存所需凭据，意外断线后需要手动连接'
    : reconnecting
      ? `网络恢复后自动连接（第 ${status.reconnectAttempt || 1} 次尝试）`
      : reconnectStopped
        ? status.reconnectErrorCode === 'SSH_AUTH_FAILED'
          ? '服务器拒绝了登录凭据，请点击“连接”重新输入账号密码或私钥口令'
          : `连接配置需要人工处理（${status.reconnectErrorCode || '未知错误'}），请检查连接设置后重试`
      : '在桌面工具中连接项目后即可使用';
}

function renderDocumentTabs(docs) {
  elements.docTabs.replaceChildren();
  for (const name of docs) {
    const button = document.createElement('button');
    button.className = `doc-tab${name === state.selectedDocument ? ' active' : ''}`;
    button.textContent = name;
    button.disabled = state.documentBusy || state.documentLoading;
    button.addEventListener('click', async () => {
      if (name !== state.selectedDocument && !confirmDiscardDocumentChanges()) return;
      state.selectedDocument = name;
      state.loadedDocumentKey = null;
      state.documentDirty = false;
      updateDocumentSaveState();
      renderDocumentTabs(docs);
      await loadDocument(name);
    });
    elements.docTabs.append(button);
  }
  $('#delete-document').classList.toggle('hidden', !state.selectedDocument || state.selectedDocument === 'README.md');
}

async function loadDocument(name) {
  const projectId = state.selectedProjectId;
  const key = `${projectId}\u0000${name}`;
  const sequence = ++state.documentLoadSequence;
  state.documentLoading = true;
  state.loadedDocumentKey = null;
  state.documentDirty = false;
  elements.editor.value = '';
  elements.editor.disabled = true;
  updateDocumentSaveState();
  setDocumentBusy(state.documentBusy);
  try {
    const content = unwrap(await window.aiOps.readDocument(projectId, name));
    if (sequence !== state.documentLoadSequence || key !== currentDocumentKey()) return;
    elements.editor.value = content;
    state.loadedDocumentKey = key;
    renderPreview();
  } catch (error) {
    if (sequence === state.documentLoadSequence && key === currentDocumentKey()) {
      showToast(`文档读取失败：${error.message}`, true);
    }
  } finally {
    if (sequence === state.documentLoadSequence && key === currentDocumentKey()) {
      state.documentLoading = false;
      elements.editor.disabled = false;
      setDocumentBusy(state.documentBusy);
    }
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function markdownToSafeHtml(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const html = [];
  let inCode = false;
  let listOpen = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (!inCode) { html.push('<pre><code>'); inCode = true; }
      else { html.push('</code></pre>'); inCode = false; }
      continue;
    }
    if (inCode) { html.push(`${escapeHtml(line)}\n`); continue; }
    const list = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (list) {
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      html.push(`<li>${renderInline(list[1])}</li>`);
      continue;
    }
    if (listOpen) { html.push('</ul>'); listOpen = false; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
    else if (line.trim()) html.push(`<p>${renderInline(line)}</p>`);
  }
  if (listOpen) html.push('</ul>');
  if (inCode) html.push('</code></pre>');
  return html.join('');
}

function renderPreview() {
  elements.preview.innerHTML = markdownToSafeHtml(elements.editor.value);
}

function setMode(mode) {
  state.mode = mode;
  const preview = mode === 'preview';
  elements.editor.classList.toggle('hidden', preview);
  elements.preview.classList.toggle('hidden', !preview);
  $('#edit-mode').classList.toggle('active', !preview);
  $('#preview-mode').classList.toggle('active', preview);
  if (preview) renderPreview();
}

function syncAuthFields() {
  const type = $('#auth-type').value;
  $('#password-row').classList.toggle('hidden', type !== 'password');
  $('#private-key-row').classList.toggle('hidden', type !== 'privateKey');
  const fields = elements.form.elements;
  const canUseSavedPassword =
    state.dialogMode === 'connect' &&
    elements.form.elements.rememberCredentials.checked &&
    Boolean(currentDialogProject()?.credentialsSaved);
  fields.password.required = type === 'password' && !canUseSavedPassword;
  fields.privateKeyPath.required = type === 'privateKey';
}

function syncCredentialStorageNote() {
  const remember = elements.form.elements.rememberCredentials.checked;
  elements.credentialStorageNote.textContent = remember
    ? '▣ 凭据由 Windows 加密保存，不会通过 MCP 提供给 Codex'
    : '▣ 凭据仅用于本次连接，关闭连接后不会保留';
}

function syncProxyFields() {
  const type = $('#proxy-type').value;
  $('#proxy-fields').classList.toggle('hidden', type === 'direct');
  const proxyPort = elements.form.elements.proxyPort;
  elements.form.elements.proxyHost.required = type !== 'direct';
  proxyPort.required = type !== 'direct';
  if (type === 'socks5' && (!proxyPort.value || proxyPort.value === '8080')) proxyPort.value = '1080';
  if (type === 'http' && (!proxyPort.value || proxyPort.value === '1080')) proxyPort.value = '8080';
}

function syncCommandPolicyFields() {
  const enabled = elements.form.elements.commandPolicyEnabled.checked;
  elements.form.elements.customDeny.disabled = !enabled;
}

function resetDialogError() {
  elements.dialogError.textContent = '';
  elements.dialogError.classList.add('hidden');
}

function showDialogError(message) {
  elements.dialogError.textContent = message;
  elements.dialogError.classList.remove('hidden');
}

function openCreateDialog() {
  state.dialogMode = 'create';
  state.dialogProjectId = null;
  setProjectDialogBusy(false);
  elements.form.reset();
  elements.form.elements.port.value = '22';
  elements.form.elements.proxyPort.value = '1080';
  elements.form.elements.remoteDns.checked = true;
  elements.form.elements.rememberCredentials.checked = true;
  elements.form.elements.commandPolicyEnabled.checked = true;
  elements.form.elements.customDeny.value = '';
  elements.form.elements.password.placeholder = '输入后使用 Windows 加密保存';
  elements.dialogTitle.textContent = '新建项目';
  elements.submitProject.textContent = '创建并连接';
  for (const field of ['name', 'host', 'port', 'username', 'authType', 'privateKeyPath', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUsername']) {
    elements.form.elements[field].disabled = false;
  }
  $('#advanced-options').open = false;
  syncAuthFields();
  syncProxyFields();
  syncCommandPolicyFields();
  syncCredentialStorageNote();
  resetDialogError();
  elements.dialog.showModal();
}

function openConnectDialog(project) {
  state.dialogMode = 'connect';
  state.dialogProjectId = project.id;
  setProjectDialogBusy(false);
  elements.form.reset();
  const fields = elements.form.elements;
  fields.name.value = project.name;
  fields.host.value = project.ssh.host;
  fields.port.value = project.ssh.port;
  fields.username.value = project.ssh.username;
  fields.authType.value = project.auth.type;
  fields.privateKeyPath.value = project.auth.privateKeyPath ?? '';
  fields.proxyType.value = project.proxy.type;
  fields.proxyHost.value = project.proxy.host ?? '';
  fields.proxyPort.value = project.proxy.port ?? (project.proxy.type === 'http' ? 8080 : 1080);
  fields.proxyUsername.value = project.proxy.username ?? '';
  fields.remoteDns.checked = project.proxy.remoteDns !== false;
  fields.rememberCredentials.checked = project.credentials?.remember !== false;
  fields.commandPolicyEnabled.checked = project.commandPolicy?.enabled !== false;
  fields.customDeny.value = (project.commandPolicy?.customDeny ?? []).join('\n');
  fields.password.placeholder = project.credentialsSaved
    ? '*****'
    : '请输入密码';
  elements.dialogTitle.textContent = `连接设置 · ${project.name}`;
  elements.submitProject.textContent = '保存并连接';
  for (const field of ['name', 'host', 'port', 'username', 'authType', 'privateKeyPath', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUsername']) {
    fields[field].disabled = false;
  }
  $('#advanced-options').open = project.proxy.type !== 'direct' || !fields.commandPolicyEnabled.checked || Boolean(fields.customDeny.value);
  syncAuthFields();
  syncProxyFields();
  syncCommandPolicyFields();
  syncCredentialStorageNote();
  resetDialogError();
  elements.dialog.showModal();
}

function formPayload() {
  const fields = elements.form.elements;
  const project = {
    name: fields.name.value.trim(),
    ssh: { host: fields.host.value.trim(), port: Number(fields.port.value), username: fields.username.value.trim() },
    auth: {
      type: fields.authType.value,
      ...(fields.authType.value === 'privateKey' ? { privateKeyPath: fields.privateKeyPath.value.trim() } : {}),
    },
    proxy: {
      type: fields.proxyType.value,
      ...(fields.proxyType.value !== 'direct'
        ? {
            host: fields.proxyHost.value.trim(),
            port: Number(fields.proxyPort.value),
            username: fields.proxyUsername.value.trim(),
            remoteDns: fields.remoteDns.checked,
          }
        : {}),
    },
    credentials: { remember: fields.rememberCredentials.checked },
    commandPolicy: {
      enabled: fields.commandPolicyEnabled.checked,
      customDeny: fields.customDeny.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    },
  };
  const secrets = {
    password: fields.password.value,
    privateKeyPassphrase: fields.privateKeyPassphrase.value,
    proxyPassword: fields.proxyPassword.value,
  };
  return { project, secrets };
}

function continueCreatedProjectAsConnect(project) {
  // The project already exists on disk even when its first SSH connection
  // fails. Switch the dialog to update/connect mode immediately so another
  // submit retries this project instead of creating a suffixed duplicate.
  state.selectedProjectId = project.id;
  state.dialogMode = 'connect';
  state.dialogProjectId = project.id;
  elements.dialogTitle.textContent = `连接设置 · ${project.name}`;
  elements.submitProject.textContent = '保存并连接';
}

async function confirmHostKeyAndReconnect(projectId, secrets, error) {
  const fingerprint = error.details?.fingerprint;
  if (!fingerprint) throw Object.assign(new Error(error.message), error);
  if (error.code === 'SSH_HOST_KEY_CONFIRM_REQUIRED') {
    const approved = window.confirm(`首次连接需要确认服务器指纹：\n\n${fingerprint}\n\n请确认它与服务器管理员提供的指纹一致。`);
    if (!approved) throw new Error('已取消服务器指纹确认。');
    return unwrap(await window.aiOps.connectProject({ projectId, secrets: { ...secrets, acceptHostKey: fingerprint } }));
  }
  if (error.code === 'SSH_HOST_KEY_CHANGED') {
    const project = state.projects.find((item) => item.id === projectId);
    const previous = project?.ssh?.hostKeyFingerprint ?? '未知';
    const approved = window.confirm(
      `警告：服务器 SSH 指纹已经变化。\n\n旧指纹：${previous}\n新指纹：${fingerprint}\n\n这可能表示服务器重装，也可能是中间人攻击。请先通过可信渠道核对新指纹。确认信任并替换吗？`,
    );
    if (!approved) throw new Error('已拒绝更换服务器指纹。');
    unwrap(await window.aiOps.trustHostKeyChange({ projectId, fingerprint }));
    return unwrap(await window.aiOps.connectProject({ projectId, secrets }));
  }
  throw Object.assign(new Error(error.message), error);
}

async function submitProject(event) {
  event.preventDefault();
  resetDialogError();
  const payload = formPayload();
  const submissionSequence = ++state.dialogSubmissionSequence;
  const dialogMode = state.dialogMode;
  const targetProjectId = state.dialogProjectId;
  let projectCreated = false;
  setProjectDialogBusy(true);
  try {
    if (dialogMode === 'create') {
      const created = unwrap(await window.aiOps.createProject(payload));
      projectCreated = true;
      continueCreatedProjectAsConnect(created.project);
      if (created.connectError) {
        await confirmHostKeyAndReconnect(created.project.id, payload.secrets, created.connectError);
      }
      showToast('项目已创建并连接。');
    } else {
      if (!targetProjectId) throw new Error('连接目标已经失效，请重新打开连接设置。');
      unwrap(await window.aiOps.updateProject({ id: targetProjectId, project: payload.project }));
      try {
        unwrap(await window.aiOps.connectProject({ projectId: targetProjectId, secrets: payload.secrets }));
      } catch (error) {
        await confirmHostKeyAndReconnect(targetProjectId, payload.secrets, error);
      }
      showToast('SSH 已连接。');
    }
    elements.form.elements.password.value = '';
    elements.form.elements.privateKeyPassphrase.value = '';
    elements.form.elements.proxyPassword.value = '';
    if (submissionSequence === state.dialogSubmissionSequence && elements.dialog.open) {
      elements.dialog.close();
    }
    await refreshProjects();
  } catch (error) {
    if (projectCreated) await refreshProjects().catch(() => undefined);
    if (submissionSequence === state.dialogSubmissionSequence && elements.dialog.open) {
      syncAuthFields();
      showDialogError(
        projectCreated
          ? `项目已经创建，但连接失败：${error.message || '请检查连接设置后重试。'}`
          : error.message || '连接失败。',
      );
    }
  } finally {
    if (submissionSequence === state.dialogSubmissionSequence) setProjectDialogBusy(false);
  }
}

async function toggleConnection() {
  const project = currentProject();
  if (!project) return;
  if (project.status.connected || project.status.reconnecting || project.status.connecting) {
    elements.connectionButton.disabled = true;
    try {
      unwrap(await window.aiOps.disconnectProject(project.id));
      showToast(project.status.connected ? 'SSH 已断开。' : '已停止自动重连。');
      await refreshProjects();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      elements.connectionButton.disabled = false;
    }
  } else if (project.credentialsSaved && project.credentials?.remember !== false) {
    elements.connectionButton.disabled = true;
    try {
      unwrap(await window.aiOps.connectProject({ projectId: project.id, secrets: {} }));
      showToast('已使用 Windows 加密保存的凭据连接。');
      await refreshProjects();
    } catch (error) {
      if (state.selectedProjectId === project.id) {
        openConnectDialog(project);
        showDialogError(`${error.message} 请重新输入或修改连接设置。`);
      } else {
        showToast(`${project.name} 连接失败：${error.message}`, true);
      }
    } finally {
      elements.connectionButton.disabled = false;
    }
  } else openConnectDialog(project);
}

async function createDocument() {
  if (!state.selectedProjectId || state.documentBusy || state.documentLoading) return;
  elements.documentForm.reset();
  elements.documentDialogError.textContent = '';
  elements.documentDialogError.classList.add('hidden');
  elements.documentDialog.showModal();
  requestAnimationFrame(() => elements.documentName.focus());
}

async function submitDocument(event) {
  event.preventDefault();
  if (state.documentDirty && !confirmDiscardDocumentChanges()) return;
  const projectId = state.selectedProjectId;
  let name = elements.documentName.value.trim();
  if (!name.toLowerCase().endsWith('.md')) name += '.md';
  elements.documentSubmit.disabled = true;
  $('#close-document-dialog').disabled = true;
  $('#cancel-document-dialog').disabled = true;
  setDocumentBusy(true);
  try {
    unwrap(await window.aiOps.createDocument(projectId, name));
    if (state.selectedProjectId === projectId) {
      state.selectedDocument = name;
      state.loadedDocumentKey = null;
      state.documentDirty = false;
      updateDocumentSaveState();
    }
    elements.documentDialog.close();
    await refreshProjects();
    showToast('文档已创建。');
  } catch (error) {
    elements.documentDialogError.textContent = error.message;
    elements.documentDialogError.classList.remove('hidden');
  } finally {
    elements.documentSubmit.disabled = false;
    $('#close-document-dialog').disabled = false;
    $('#cancel-document-dialog').disabled = false;
    setDocumentBusy(false);
  }
}

async function saveDocument() {
  if (!state.selectedProjectId || !state.selectedDocument || state.documentBusy) return;
  if (state.documentLoading || state.loadedDocumentKey !== currentDocumentKey()) {
    showToast('文档尚未加载完成，不能保存。', true);
    return;
  }
  const projectId = state.selectedProjectId;
  const name = state.selectedDocument;
  const key = currentDocumentKey();
  const content = elements.editor.value;
  setDocumentBusy(true);
  try {
    const saved = unwrap(await window.aiOps.saveDocument(projectId, name, content));
    if (!saved.verified) throw new Error('文档写入后校验失败。');
    if (key === currentDocumentKey() && elements.editor.value === content) {
      state.documentDirty = false;
      updateDocumentSaveState();
      showToast('文档已保存。Codex 下次操作前需要重新读取。');
    } else {
      showToast('点击保存时的内容已写入，之后的修改仍未保存。');
    }
  } catch (error) {
    if (key === currentDocumentKey()) {
      state.documentDirty = true;
      updateDocumentSaveState();
    }
    showToast(error.message, true);
  } finally {
    setDocumentBusy(false);
  }
}

async function deleteDocument() {
  if (!state.selectedDocument || state.selectedDocument === 'README.md' || state.documentBusy) return;
  const projectId = state.selectedProjectId;
  const name = state.selectedDocument;
  const key = currentDocumentKey();
  const dirtyWarning = state.documentDirty ? '\n\n当前未保存的修改也会丢失。' : '';
  if (!window.confirm(`确定删除 ${name}？${dirtyWarning}`)) return;
  setDocumentBusy(true);
  try {
    unwrap(await window.aiOps.deleteDocument(projectId, name));
    if (key === currentDocumentKey()) {
      state.selectedDocument = null;
      state.loadedDocumentKey = null;
      state.documentDirty = false;
      updateDocumentSaveState();
    }
    await refreshProjects();
    showToast('文档已删除。');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setDocumentBusy(false);
  }
}

async function deleteProject() {
  const project = currentProject();
  if (!project) return;
  const connectedWarning = project.status.connected ? '\n\n当前 SSH 连接也会立即断开。' : '';
  const dirtyWarning = state.documentDirty ? '\n\n当前文档有未保存修改。' : '';
  if (!window.confirm(`确定删除项目“${project.name}”？${connectedWarning}${dirtyWarning}\n\n项目文件夹将移入 Windows 回收站。`)) return;
  elements.deleteProject.disabled = true;
  try {
    unwrap(await window.aiOps.deleteProject(project.id));
    if (state.selectedProjectId === project.id) {
      state.selectedProjectId = null;
      state.selectedDocument = null;
      state.loadedDocumentKey = null;
      state.documentDirty = false;
      updateDocumentSaveState();
    }
    await refreshProjects({ preserveSelection: false });
    showToast('项目已移入回收站。');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.deleteProject.disabled = false;
  }
}

$('#new-project').addEventListener('click', openCreateDialog);
$('[data-action="new-project"]').addEventListener('click', openCreateDialog);
$('#close-dialog').addEventListener('click', () => { if (!state.dialogBusy) elements.dialog.close(); });
$('#cancel-dialog').addEventListener('click', () => { if (!state.dialogBusy) elements.dialog.close(); });
elements.dialog.addEventListener('cancel', (event) => { if (state.dialogBusy) event.preventDefault(); });
elements.form.addEventListener('submit', submitProject);
$('#auth-type').addEventListener('change', syncAuthFields);
$('#proxy-type').addEventListener('change', syncProxyFields);
elements.form.elements.commandPolicyEnabled.addEventListener('change', syncCommandPolicyFields);
elements.form.elements.rememberCredentials.addEventListener('change', () => {
  syncCredentialStorageNote();
  syncAuthFields();
});
$('#choose-key').addEventListener('click', async () => {
  try {
    const selected = unwrap(await window.aiOps.choosePrivateKey());
    if (selected) elements.form.elements.privateKeyPath.value = selected;
  } catch (error) { showDialogError(error.message); }
});
elements.connectionButton.addEventListener('click', toggleConnection);
elements.editProject.addEventListener('click', () => {
  const project = currentProject();
  if (project && !project.status.connected) openConnectDialog(project);
});
elements.deleteProject.addEventListener('click', deleteProject);
$('#add-document').addEventListener('click', createDocument);
elements.documentForm.addEventListener('submit', submitDocument);
$('#close-document-dialog').addEventListener('click', () => elements.documentDialog.close());
$('#cancel-document-dialog').addEventListener('click', () => elements.documentDialog.close());
elements.documentDialog.addEventListener('cancel', (event) => { if (state.documentBusy) event.preventDefault(); });
$('#save-document').addEventListener('click', saveDocument);
$('#delete-document').addEventListener('click', deleteDocument);
$('#edit-mode').addEventListener('click', () => setMode('edit'));
$('#preview-mode').addEventListener('click', () => setMode('preview'));
elements.editor.addEventListener('input', () => {
  state.documentDirty = true;
  updateDocumentSaveState();
  if (state.mode === 'preview') renderPreview();
});
window.addEventListener('beforeunload', (event) => {
  if (!state.documentDirty) return;
  event.preventDefault();
  event.returnValue = '';
});
$('#open-data').addEventListener('click', async () => {
  try { unwrap(await window.aiOps.openDataFolder()); } catch (error) { showToast(error.message, true); }
});

refreshProjects({ preserveSelection: false }).catch((error) => showToast(error.message, true));
window.aiOps.getAppInfo()
  .then((response) => {
    const info = unwrap(response);
    elements.appVersion.textContent = `v${info.version}`;
  })
  .catch(() => { elements.appVersion.textContent = '版本未知'; });
setInterval(() => refreshProjects().catch(() => undefined), 5000);
