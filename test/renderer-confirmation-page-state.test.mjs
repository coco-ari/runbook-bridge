import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = await import(pathToFileURL(path.join(root,
  'renderer/v2/src/features/confirmations/confirmation-queue-read-model.ts',
)).href);

test('确认页面初读及失败没有已知零项，也不会使用成功状态', () => {
  const initial = model.confirmationQueueInitial('项目甲/环境甲');
  assert.equal(initial.hasSnapshot,false);
  assert.deepEqual(model.confirmationQueuePresentation(initial,0),{
    phase:'loading',label:'正在读取队列',variant:'outline',stale:false,
  });
  const failed = model.confirmationQueueFailed(initial,'项目甲/环境甲','合成读取失败');
  assert.equal(failed.loading,false);
  assert.deepEqual(model.confirmationQueuePresentation(failed,0),{
    phase:'unavailable',label:'队列不可用',variant:'warning',stale:false,
  });
  const retrying = model.confirmationQueueReading(failed,'项目甲/环境甲');
  assert.equal(retrying.hasSnapshot,false);
  assert.equal(retrying.error,null);
  assert.equal(model.confirmationQueuePresentation(retrying,0).phase,'loading');
});

test('确认页面刷新及失败保留旧快照但明确上次读取，包括旧零项', () => {
  const snapshot = model.confirmationQueueReceived('项目甲/环境甲');
  const reading = model.confirmationQueueReading(snapshot,'项目甲/环境甲');
  assert.equal(reading.hasSnapshot,true);
  assert.deepEqual(model.confirmationQueuePresentation(reading,2),{
    phase:'refreshing',label:'上次读取：2 项',variant:'outline',stale:true,
  });
  const failed = model.confirmationQueueFailed(reading,'项目甲/环境甲','合成读取失败');
  assert.equal(failed.hasSnapshot,true);
  assert.equal(failed.error,'合成读取失败');
  for (const count of [0,2]) {
    assert.deepEqual(model.confirmationQueuePresentation(failed,count),{
      phase:'stale',label:`上次读取：${count} 项`,variant:'warning',stale:true,
    });
  }
});

test('有效读取和订阅可恢复空队列及非空队列并清除旧错误', () => {
  const failed = model.confirmationQueueFailed(model.confirmationQueueInitial('项目甲/环境甲'),
    '项目甲/环境甲','合成读取失败');
  assert.notEqual(failed.error,null);
  const recovered = model.confirmationQueueReceived('项目甲/环境甲');
  assert.equal(recovered.error,null);
  assert.equal(recovered.loading,false);
  assert.equal(recovered.hasSnapshot,true);
  assert.deepEqual(model.confirmationQueuePresentation(recovered,0),{
    phase:'ready',label:'0 项待处理',variant:'success',stale:false,
  });
  assert.equal(model.confirmationQueuePresentation(recovered,1).variant,'warning');
});

test('范围切换的首帧遮蔽上一范围的数量、快照和错误', () => {
  const previous = model.confirmationQueueFailed(model.confirmationQueueReceived('项目甲/环境甲'),
    '项目甲/环境甲','上一范围合成错误');
  const current = model.confirmationQueueForScope(previous,'项目甲/环境乙');
  assert.deepEqual(current,model.confirmationQueueInitial('项目甲/环境乙'));
  assert.equal(model.confirmationQueuePresentation(current,20).label,'正在读取队列');
  const reading = model.confirmationQueueReading(previous,'项目甲/环境乙');
  assert.equal(reading.hasSnapshot,false);
  assert.equal(reading.error,null);
});

test('确认页面读取与订阅只提交当前范围，未知状态和读取失败有独立空态', async () => {
  const source = await fs.readFile(path.join(root,
    'renderer/v2/src/features/confirmations/ConfirmationsFeature.tsx'),'utf8');
  assert.match(source,/confirmationQueueForScope\(queueRead, scopeKey\)/u);
  assert.match(source,/generation !== loadGenerationRef\.current/u);
  assert.match(source,/if \(!active \|\| !Array\.isArray\(pending\)\) return/u);
  assert.match(source,/normalizeConfirmations\(pending\)\.filter\(matchesCurrentScope\)\)\s+setQueueRead\(confirmationQueueReceived\(scopeKey\)\)\s+setError\(null\)/u);
  assert.match(source,/currentRead\.error && visible\.length === 0/u);
  assert.match(source,/data-testid="confirmation-queue-unavailable"/u);
  assert.match(source,/data-testid="confirmation-queue-stale"/u);
  assert.match(source,/currentRead\.hasSnapshot \? count : "未知"/u);
});
