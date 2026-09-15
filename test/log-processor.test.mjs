import test from 'node:test';
import assert from 'node:assert/strict';
import { LogProcessor } from '../src/log-processor.mjs';

test('复用日志线程时大文件扫描仍允许主线程处理事件', async (t) => {
  const processor = new LogProcessor({ maxWorkers:1 });
  t.after(() => processor.close());
  const args = {
    archive:{ filePath:'/fixture.log', content:Buffer.from('warm\n'), maxExpandedBytes:32 * 1024 * 1024 },
    search:{ keywords:['needle'], maxMatches:10, maxContextBytes:4096 },
  };
  await processor.run('process', args);
  args.archive.content = Buffer.from('ordinary fixture line\n'.repeat(700_000) + 'needle\n');
  let pulses = 0;
  const interval = setInterval(() => { pulses += 1; }, 2);
  t.after(() => clearInterval(interval));
  const result = await processor.run('process', args);
  clearInterval(interval);
  assert.ok(pulses > 0, '扫描期间主线程没有处理定时事件');
  assert.equal(result.snapshots[0].search.matches[0].text,'needle');
  assert.equal(result.snapshots[0].content,undefined);
  assert.equal(processor.workers.size,1);
});

test('工作线程返回的上下文受字节预算约束', async (t) => {
  const processor = new LogProcessor();
  t.after(() => processor.close());
  const result = await processor.run('process', {
    archive:{ filePath:'/fixture.log', content:Buffer.from(('needle '+ '长'.repeat(20_000) + '\n').repeat(30)) },
    search:{ keywords:['needle'], maxMatches:2, beforeLines:20, afterLines:20, maxContextBytes:10_000 },
  });
  const search = result.snapshots[0].search;
  assert.equal(search.outputTruncated,true);
  assert.ok(search.contextBytes <= 10_000);
  assert.ok(Buffer.byteLength(JSON.stringify(search.contexts)) < 12_000);
});

test('工作线程超时终止并释放槽位，错误不包含输入内容', async (t) => {
  const processor = new LogProcessor({ maxWorkers:1, timeoutMs:20, workerUrl:new URL('data:text/javascript,import {parentPort} from "node:worker_threads";parentPort.on("message",()=>{});') });
  t.after(() => processor.close());
  await assert.rejects(processor.run('search', { privateValue:'fixture-secret' }), error => error.code === 'LOG_PROCESSING_TIMEOUT' && !error.message.includes('fixture-secret'));
  assert.equal(processor.workers.size,0);
});
