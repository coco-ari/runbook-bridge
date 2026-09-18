import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalOpenQueue, terminalConnection } from '../renderer/v2/src/features/server-workspace/terminal-recovery.ts';
import { terminalHistory } from '../renderer/v2/src/features/server-workspace/terminal-history.ts';

const runtime = (phase, extra={}) => ({projectId:'p',environmentId:'e',sequence:3,phase,desiredConnected:true,plugins:{server:{phase,...extra}}});

test('工作区按目标服务器显示真实重连状态，其他插件失败不显示为服务器断线', () => {
  let snapshot = runtime('error', {retryable:true,reason:'CONNECTION_LOST'});
  snapshot.reconnect = {phase:'waiting',attempt:2,maxAttempts:5,nextRetryAt:12345,pluginInstanceIds:['server']};
  assert.deepEqual(terminalConnection(snapshot,'server','error'), {
    connected:false,allowRecovery:true,pauseRecovery:false,phase:'waiting',sequence:3,attempt:2,maxAttempts:5,nextRetryAt:12345,reason:'CONNECTION_LOST',message:'',
  });
  snapshot.plugins.server.phase = 'reconnecting';
  assert.equal(terminalConnection(snapshot,'server','reconnecting').phase, 'waiting');
  snapshot.plugins.server.phase = 'error';
  snapshot.reconnect.phase = 'exhausted';
  assert.equal(terminalConnection(snapshot,'server','error').phase, 'exhausted');
  snapshot.plugins.server.phase = 'connected';
  assert.equal(terminalConnection(snapshot,'server','connected').phase, 'connected');
  snapshot.plugins.server.phase = 'error';
  snapshot.reconnect.pluginInstanceIds = ['mysql'];
  assert.equal(terminalConnection(snapshot,'server','error').attempt, 0);
});

test('主动断开暂停恢复，配置变化和身份错误停止终端恢复', () => {
  assert.equal(terminalConnection(runtime('connected'),'server','disconnecting').allowRecovery,false);
  assert.equal(terminalConnection(runtime('connected'),'server','disconnecting').pauseRecovery,true);
  for (const value of [
    {...runtime('disconnected'),desiredConnected:false},
    {...runtime('disconnected'),manualDisconnected:{server:true}},
    runtime('disconnected',{reason:'USER_DISCONNECTED'}),
  ]) {
    const disconnected=terminalConnection(value,'server','disconnected');
    assert.equal(disconnected.allowRecovery,false);
    assert.equal(disconnected.pauseRecovery,true);
  }
  for (const reason of ['SSH_HOST_KEY_CHANGED','SSH_AUTH_FAILED','MANUAL_RECONNECT_REQUIRED']) {
    assert.equal(terminalConnection(runtime('error',{reason,retryable:false}),'server','error').pauseRecovery,false);
  }
  const reconnected=terminalConnection(runtime('connected'),'server','connected');
  assert.equal(reconnected.allowRecovery,true);
  assert.equal(reconnected.pauseRecovery,false);
  for (const value of [
    {...runtime('error',{retryable:true}),desiredConnected:false},
    {...runtime('error',{retryable:true}),manualDisconnected:{server:true}},
    runtime('error',{retryable:false,reason:'SSH_HOST_KEY_CHANGED'}),
    runtime('error',{retryable:false,reason:'SSH_AUTH_FAILED'}),
    runtime('error',{retryable:false,reason:'MANUAL_RECONNECT_REQUIRED'}),
    runtime('disconnecting'),
  ]) assert.equal(terminalConnection(value,'server','error').allowRecovery,false);
});

test('终端队列优先当前标签且串行创建，失败不阻塞其他标签', async () => {
  const queue = new TerminalOpenQueue();
  const calls=[];
  let active=0;
  const enqueue = (id, priority, fail=false) => queue.run(async () => {
    assert.equal(active++,0);
    calls.push(id);
    await new Promise(resolve => setTimeout(resolve,5));
    active--;
    if(fail) throw new Error('模拟单个终端失败');
    return id;
  },()=>priority);
  const results=await Promise.allSettled([enqueue('background',0),enqueue('foreground',1,true),enqueue('another',0)]);
  assert.deepEqual(calls,['foreground','background','another']);
  assert.equal(results[0].status,'fulfilled');
  assert.equal(results[1].status,'rejected');
  assert.equal(results[2].status,'fulfilled');
});

test('重连历史去掉控制字符、合并折行且限制内存', () => {
  const lines=[
    {text:'中文与空格  ',isWrapped:false},
    {text:'继续\x1b[31m\u009b',isWrapped:true},
    {text:'',isWrapped:false},
  ];
  const terminal={buffer:{normal:{length:lines.length,getLine:index=>lines[index]&&({...lines[index],translateToString:()=>lines[index].text})}}};
  assert.equal(terminalHistory(terminal),'中文与空格  继续[31m\r\n');
  terminal.buffer.normal.length=6000;
  terminal.buffer.normal.getLine=()=>({isWrapped:false,translateToString:()=> 'a'.repeat(500)});
  assert.ok(terminalHistory(terminal).length<=512*1024);
});

test('环境手动重连开始但插件状态尚未更新时保留终端恢复意图', () => {
  for (const phase of ['connecting','reconnecting']) {
    const snapshot={...runtime('disconnected'),phase};
    const pending=terminalConnection(snapshot,'server',phase);
    assert.equal(pending.connected,false);
    assert.equal(pending.allowRecovery,true);
    assert.equal(pending.phase,'connecting');
    const other=terminalConnection({...snapshot,manualDisconnected:{server:true}},'server',phase);
    assert.equal(other.allowRecovery,false);
    assert.equal(other.pauseRecovery,true);
  }
});
