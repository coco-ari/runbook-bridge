import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const { CdpClient } = createRequire(import.meta.url)('../scripts/install-upgrade-regression.cjs');

class Socket extends EventTarget {
  send(message) { this.sent = JSON.parse(message); }
  close() { this.dispatchEvent(new Event('close')); }
  reply(result) {
    this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:this.sent.id,result})}));
  }
}

test('安装回归的浏览器请求超时后释放等待项，迟到回复不影响后续请求',async () => {
  const socket = new Socket();
  const client = new CdpClient(socket,{timeoutMs:20});
  await assert.rejects(client.call('Runtime.evaluate'),/浏览器请求超时：Runtime.evaluate/u);
  assert.equal(client.pending.size,0);
  socket.reply({stale:true});
  const next = client.call('Browser.close');
  socket.reply({closed:true});
  assert.deepEqual(await next,{closed:true});
  assert.equal(client.pending.size,0);
  client.close();
});

test('安装回归的浏览器连接关闭时拒绝请求并清理超时计时器',async () => {
  const socket = new Socket();
  const client = new CdpClient(socket,{timeoutMs:1000});
  const pending = client.call('Runtime.evaluate');
  client.close();
  await assert.rejects(pending,/CDP connection closed/u);
  assert.equal(client.pending.size,0);
});
