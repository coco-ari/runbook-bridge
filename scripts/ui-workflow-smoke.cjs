const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.disableHardwareAcceleration();

const appRoot = path.resolve(__dirname, '..');
let project = null;
let createCalls = 0;
let updateCalls = 0;
let connectCalls = 0;
let saveCalls = 0;
let savedContent = null;
const documents = {
  'README.md': '# 初始文档\n\n原始内容。',
  'DEPLOY.md': '# 部署文档\n\n第二份内容。',
};

function ok(data) {
  return { ok: true, data };
}

function publicProject() {
  return {
    ...project,
    status: { connected: Boolean(project?.connected), generation: project?.connected ? 1 : 0 },
    credentialsSaved: false,
    documents: Object.keys(documents),
  };
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await handler(...args));
    } catch (error) {
      return { ok: false, error: { code: error.code || 'TEST_ERROR', message: error.message } };
    }
  });
}

handle('project:list', () => (project ? [publicProject()] : []));
handle('project:create', ({ project: input }) => {
  createCalls += 1;
  project = {
    id: 'workflow-project',
    ...input,
    connected: false,
  };
  return {
    project,
    connectError: { code: 'SSH_CONNECTION_FAILED', message: '模拟首次连接失败。' },
  };
});
handle('project:update', ({ id, project: input }) => {
  assert.equal(id, 'workflow-project');
  updateCalls += 1;
  project = { ...project, ...input, id, connected: false };
  return project;
});
handle('project:connect', ({ projectId }) => {
  assert.equal(projectId, 'workflow-project');
  connectCalls += 1;
  project.connected = true;
  return { connected: true, generation: 1 };
});
handle('project:disconnect', () => ({ connected: false }));
handle('project:delete', () => ({}));
handle('document:read', async ({ name }) => {
  if (name === 'DEPLOY.md') await new Promise((resolve) => setTimeout(resolve, 120));
  return documents[name];
});
handle('document:save', ({ name, content }) => {
  saveCalls += 1;
  savedContent = content;
  documents[name] = content;
  return { name, verified: true, sizeBytes: Buffer.byteLength(content), sha256: 'a'.repeat(64) };
});
handle('document:create', () => ({}));
handle('document:delete', () => ({}));
handle('dialog:private-key', () => null);
handle('app:open-data-folder', () => '');
handle('app:info', () => ({ version: 'test', dataRoot: 'test' }));

async function run() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(appRoot, 'src', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(path.join(appRoot, 'renderer', 'index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate, timeout = 3000) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error('UI wait timed out');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    document.querySelector('#new-project').click();
    const form = document.querySelector('#project-form');
    form.elements.name.value = '工作流测试';
    form.elements.host.value = '127.0.0.1';
    form.elements.port.value = '22';
    form.elements.username.value = 'deploy';
    form.elements.password.value = 'temporary-password';
    form.requestSubmit();
    await waitFor(() => !document.querySelector('#dialog-error').classList.contains('hidden'));
    const firstFailure = {
      open: document.querySelector('#project-dialog').open,
      action: document.querySelector('#submit-project').textContent,
      error: document.querySelector('#dialog-error').textContent,
    };
    form.requestSubmit();
    await waitFor(() => !document.querySelector('#project-dialog').open);
    await waitFor(() => document.querySelector('#document-editor').value.includes('初始文档'));

    const editor = document.querySelector('#document-editor');
    editor.value = '# 已修改文档\\n\\n必须保持。';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5300));
    const valueAfterRefresh = editor.value;
    const dirtyAfterRefresh = !document.querySelector('#document-save-state').classList.contains('hidden');
    document.querySelector('#save-document').click();
    await waitFor(() => document.querySelector('#document-save-state').classList.contains('hidden'));

    [...document.querySelectorAll('.doc-tab')].find((button) => button.textContent === 'DEPLOY.md').click();
    document.querySelector('#save-document').click();
    await waitFor(() => editor.value.includes('部署文档'));

    const projectList = document.querySelector('#project-list');
    for (let index = 0; index < 12; index += 1) {
      const item = document.createElement('button');
      item.className = 'project-item';
      item.innerHTML = '<span class="project-dot"></span><strong>额外项目 ' + index + '</strong><small>127.0.0.1</small>';
      projectList.append(item);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sidebarRect = document.querySelector('.sidebar').getBoundingClientRect();
    const newProjectRect = document.querySelector('#new-project').getBoundingClientRect();
    const sidebarLayout = {
      listScrollable: projectList.scrollHeight > projectList.clientHeight,
      buttonVisible:
        newProjectRect.height > 0 &&
        newProjectRect.top >= sidebarRect.top &&
        newProjectRect.bottom <= sidebarRect.bottom,
    };
    return { firstFailure, valueAfterRefresh, dirtyAfterRefresh, sidebarLayout };
  })()`);

  assert.equal(createCalls, 1, 'retry must not create a duplicate project');
  assert.equal(updateCalls, 1);
  assert.equal(connectCalls, 1);
  assert.equal(result.firstFailure.open, true);
  assert.equal(result.firstFailure.action, '保存并连接');
  assert.match(result.firstFailure.error, /项目已经创建，但连接失败/);
  assert.equal(result.valueAfterRefresh, '# 已修改文档\n\n必须保持。');
  assert.equal(result.dirtyAfterRefresh, true);
  assert.equal(savedContent, '# 已修改文档\n\n必须保持。');
  assert.equal(saveCalls, 1, 'loading another document must not save stale editor content');
  assert.equal(result.sidebarLayout.listScrollable, true, 'a long project list must scroll inside the sidebar');
  assert.equal(result.sidebarLayout.buttonVisible, true, 'the new-project button must remain visible');
  window.destroy();
}

app.whenReady()
  .then(run)
  .then(() => {
    console.log('UI workflow smoke passed');
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
