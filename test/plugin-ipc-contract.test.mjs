import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { PLUGIN_IPC_CHANNELS } from '../src/plugin-ipc-contract.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';

test('真实 preload 插件方法与已注册 IPC 通道逐项一致，并原样传递请求和返回值', async () => {
  const handlers = new Map();
  registerV2Ipc({handle:(name, handler) => handlers.set(name, handler), on:() => {}}, {
    workspaceStore:{}, connectionManager:{on:() => {}}, confirmationManager:{on:() => {}},
    contextManager:{}, pluginManager:{}, mysqlRuntime:{},
  });
  const requests = [];
  const returned = {ok:true, data:{marker:'test-response'}};
  let exposed;
  vm.runInNewContext(await fs.readFile('src/preload.cjs', 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge:{exposeInMainWorld:(_name, api) => { exposed = api; }},
        ipcRenderer:{invoke:async (channel, payload) => { requests.push({channel, payload}); return returned; }},
        webUtils:{},
      };
    },
  }, {filename:'preload.cjs'});
  for (const [method, channel] of Object.entries(PLUGIN_IPC_CHANNELS)) {
    assert.equal(typeof exposed.v2[method], 'function', method);
    assert.equal(typeof handlers.get(channel), 'function', channel);
    const request = {projectId:'test-project', environmentId:'test-env', requestId:method};
    assert.equal(await exposed.v2[method](request), returned);
    assert.equal(requests.at(-1).channel, channel);
    assert.equal(requests.at(-1).payload, request);
  }
});
