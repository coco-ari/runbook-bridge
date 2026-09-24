import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPluginUiRegistry } from '../renderer/v2/src/features/plugins/plugin-ui-registry.ts';

test('第四种插件可贡献独立编辑、连接和 Agent 界面，不依赖内置连接表单', () => {
  const Editor = ({plugin}) => createElement('form', null, createElement('input', {name:'namespace',defaultValue:plugin.namespace}));
  const ConnectionPanel = () => createElement('section', null, '队列连接');
  const AgentAccess = () => createElement('section', null, '队列权限');
  const definition = {type:'test-queue',label:'测试队列',Editor,ConnectionPanel,AgentAccess};
  const registry = createPluginUiRegistry([definition]);
  const contribution = registry.get('test-queue');
  assert.deepEqual(registry.options, [{type:'test-queue',label:'测试队列'}]);
  const html = renderToStaticMarkup(createElement(contribution.Editor, {plugin:{namespace:'orders'}}));
  assert.match(html, /name="namespace"/);
  assert.match(html, /value="orders"/);
  assert.doesNotMatch(html, /target|auth|password/);
  assert.equal(renderToStaticMarkup(createElement(contribution.ConnectionPanel)), '<section>队列连接</section>');
  assert.equal(renderToStaticMarkup(createElement(contribution.AgentAccess)), '<section>队列权限</section>');
  assert.equal(registry.get('constructor'), undefined);
  assert.throws(() => createPluginUiRegistry([definition,definition]));
  assert.throws(() => createPluginUiRegistry([{...definition,Editor:null}]));
  assert.throws(() => { contribution.Editor = null; }, TypeError);
});
