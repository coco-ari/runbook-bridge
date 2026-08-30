import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const navigationUrl = pathToFileURL(path.resolve(
  'renderer/v2/src/components/detail-workspace/detail-navigation.ts',
)).href;

test('detail navigation follows the selected business scope', async () => {
  const navigation = await import(navigationUrl);
  const values = (kind) => navigation.detailTabsForSelection(kind).map((tab) => tab.value);
  const labels = (kind) => navigation.detailTabsForSelection(kind).map((tab) => tab.label);

  assert.deepEqual(values('project'),['overview']);
  assert.deepEqual(labels('project'),['项目概览']);
  assert.deepEqual(values('environment'),[
    'overview','runbook','questions','audit','confirmations',
  ]);
  assert.deepEqual(labels('environment'),[
    '环境详情','运维说明','快捷提问','环境记录','操作确认',
  ]);
  assert.deepEqual(values('plugin'),[
    'overview','agent','audit','confirmations',
  ]);
  assert.deepEqual(labels('plugin'),[
    '插件详情','Agent 权限','插件记录','操作确认',
  ]);
  assert.deepEqual(values('unknown-plugin'),['overview','audit','confirmations']);
  assert.equal(navigation.isDetailTabAllowed('plugin','connection'),false);
  assert.equal(navigation.isDetailTabAllowed('environment','connection'),false);
  assert.equal(navigation.isDetailTabAllowed('plugin','runbook'),false);
  assert.equal(navigation.isDetailTabAllowed('environment','agent'),false);
  assert.equal(navigation.detailSelectionKind(true,'server'),'plugin');
  assert.equal(navigation.detailSelectionKind(true,'unknown'),'unknown-plugin');
  assert.equal(navigation.detailSelectionKind(true,null),'environment');
  assert.equal(navigation.detailSelectionKind(false,null),'project');
});
