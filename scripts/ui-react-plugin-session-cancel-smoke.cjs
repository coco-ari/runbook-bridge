const assert = require('node:assert/strict');
const {app} = require('electron');
const harness = require('./ui-react-plugin-operations-smoke.cjs');
const {state,SERVER_ID,EDITOR_SELECTOR,DISCARD_SELECTOR,click,fill,waitFor,calls,openPluginEditor} = harness;

async function scenario(win) {
  const evaluate = source => win.webContents.executeJavaScript(source,true);
  const open = async () => {
    await openPluginEditor(win,state.plugins[0].displayName);
    await waitFor(win,`document.querySelector('[data-testid="plugin-save"]')?.disabled === false`,'编辑会话就绪');
    return [...state.sessions.keys()].at(-1);
  };
  const closed = () => waitFor(win,`!document.querySelector('${EDITOR_SELECTOR}')`,'退出编辑器');
  const original = structuredClone(state.plugins[0]);
  const assertOriginal = () => assert.deepEqual(state.plugins[0],original,'取消不得修改原有配置');
  const cancelDirectly = async () => {
    await click(win,'[data-testid="plugin-editor-cancel"]','直接取消并退出');
    await closed();
    assert.equal(await evaluate(`document.querySelector('${DISCARD_SELECTOR}') !== null`),false);
    assert.equal(state.sessions.size,0);
  };

  // 后端已清理会话时，取消必须允许退出，不能假报连接恢复成功。
  const cancelled = await open();
  state.sessions.delete(cancelled);
  await cancelDirectly();
  assert.equal(calls('v2:plugin-connection-edit-save').length,0);

  const expired = await open();
  const host = 'discarded-input.fixture.invalid';
  await fill(win,'#plugin-host',host);
  state.sessions.delete(expired);
  await click(win,'[data-testid="plugin-save"]','保存已过期的会话');
  await waitFor(win,`document.querySelector('[data-testid="plugin-editor-error"]')?.textContent?.includes('本次修改未保存')`,'说明会话失效且未保存');
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid="plugin-editor-footer"] button').length`),2);
  assert.equal(await evaluate(`document.querySelector('[data-testid="plugin-editor-restart"]') !== null`),false);
  assert.equal(await evaluate(`document.querySelector('[data-testid="plugin-save"]').disabled`),true);
  assert.equal(calls('v2:plugin-connection-edit-save').length,0);

  const cancelCount = calls('v2:plugin-connection-edit-cancel').length;
  await cancelDirectly();
  assert.equal(calls('v2:plugin-connection-edit-cancel').length,cancelCount,'已确认结束的会话不重复取消');
  assertOriginal();

  // 正常会话的取消也直接放弃修改，再次打开必须读取已保存配置。
  const fresh = await open();
  assert.notEqual(fresh,expired);
  assert.equal(await evaluate(`document.querySelector('#plugin-host').value`),original.target.host);
  await fill(win,'#plugin-host',host);
  await cancelDirectly();
  assert.equal(calls('v2:plugin-connection-edit-cancel').at(-1).payload.editSessionId,fresh);
  assertOriginal();

  // 普通表单检查失败也不写入，随后取消即可退出。
  await open();
  await fill(win,'#plugin-host','');
  await click(win,'[data-testid="plugin-save"]','保存无效配置');
  await waitFor(win,`document.querySelector('#plugin-host')?.getAttribute('aria-invalid') === 'true'`,'显示字段检查错误');
  assert.equal(calls('v2:plugin-connection-edit-save').length,0);
  await cancelDirectly();
  assertOriginal();

  const saved = await open();
  assert.equal(await evaluate(`document.querySelector('#plugin-host').value`),original.target.host);
  await fill(win,'#plugin-host',host);
  await click(win,'[data-testid="plugin-save"]','保存有效配置');
  await closed();
  assert.equal(state.plugins.find(plugin => plugin.pluginInstanceId === SERVER_ID).target.host,host);
  assert.equal(calls('v2:plugin-connection-edit-save').at(-1).payload.editSessionId,saved);
  assert.equal(calls('v2:plugin-draft-validate').at(-1).payload.editSessionId,saved);
  assert.equal(state.sessions.size,0);
  assert.equal(state.plugins[0].target.host,host);
}

harness.runScenario(scenario).then(() => {
  process.stdout.write('插件保存失败、直接取消与重新打开回归通过。\n');
  app.exit(0);
}).catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  app.exit(1);
});
