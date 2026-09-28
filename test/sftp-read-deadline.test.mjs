import assert from 'node:assert/strict';
import test from 'node:test';
import {SftpReadDeadline} from '../src/sftp-read-deadline.mjs';

test('真实新增字节延长等待，重复进度与元数据不续期，且总时限保持', () => {
  let now=1000;
  const budget=new SftpReadDeadline(200,450,()=>now);
  assert.equal(budget.deadline,1200);
  now=1100;
  assert.equal(budget.progress({phase:'read',receivedBytes:30}),true);
  assert.equal(budget.deadline,1300);
  now=1150;
  assert.equal(budget.progress({phase:'read',receivedBytes:30}),false);
  assert.equal(budget.progress({phase:'validation',receivedBytes:40}),false);
  assert.equal(budget.deadline,1300);
  now=1250;
  assert.equal(budget.progress({phase:'read',receivedBytes:60}),true);
  assert.equal(budget.deadline,1450);
  now=1400;
  assert.equal(budget.progress({phase:'read',receivedBytes:90}),false);
  assert.equal(budget.deadline,1450);
  now=1450;
  assert.equal(budget.progress({phase:'read',receivedBytes:120}),false);
  assert.deepEqual(budget.details(),{timeoutMs:450,idleTimeoutMs:200,totalTimeoutMs:450,firstByteMs:100,lastProgressAgoMs:50});
});

test('新文件计数从零开始，缓存与读取开始事件不能替代真实新增字节', () => {
  let now=0;
  const budget=new SftpReadDeadline(200,450,()=>now);
  now=50;budget.progress({phase:'read',receivedBytes:100});
  now=100;budget.progress({phase:'metadata',receivedBytes:0});
  budget.progress({phase:'open',receivedBytes:0});
  budget.progress({phase:'read',receivedBytes:0});
  assert.equal(budget.deadline,250);
  now=150;budget.progress({phase:'read',receivedBytes:20});
  assert.equal(budget.deadline,350);
});

test('无进展保持初始预算，迟到响应不复活，普通读取仍遵守固定总时限', () => {
  let now=0;
  const budget=new SftpReadDeadline(200,450,()=>now);
  now=199;budget.progress({phase:'open',receivedBytes:0});
  assert.equal(budget.deadline,200);
  now=200;assert.equal(budget.progress({phase:'read',receivedBytes:30}),false);
  assert.deepEqual(budget.details(),{timeoutMs:200,idleTimeoutMs:200,totalTimeoutMs:450});
  const fixed=new SftpReadDeadline(200,200,()=>now);
  now=300;assert.equal(fixed.progress({phase:'read',receivedBytes:100}),false);
  assert.equal(fixed.deadline,400);
  assert.deepEqual(fixed.details(),{});
});
