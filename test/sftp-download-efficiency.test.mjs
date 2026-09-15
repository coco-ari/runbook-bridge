import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SshBroker } from '../src/ssh-broker.mjs';

async function fixture(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'runbook-download-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const sftp = new EventEmitter();
  let callback;
  let closed = false;
  let statCount = 0;
  sftp.realpath = (value,done) => done(null,value);
  sftp.stat = (_value,done) => { statCount += 1; done(null,{isFile:() => true,size:8,mtime:mode === 'changed' && statCount > 1 ? 2 : 1}); };
  sftp.end = () => {
    if (closed) return;
    closed = true;
    const done = callback;
    callback = null;
    done?.(Object.assign(new Error('fixture closed'),{code:'ERR_STREAM_DESTROYED'}));
    sftp.emit('close');
  };
  sftp.fastGet = (_remote,local,options,done) => {
    callback = done;
    assert.equal(options.concurrency,16);
    assert.equal(options.chunkSize,30 * 1024);
    void (async () => {
      await fs.writeFile(local,'');
      if (mode === 'stalled') { options.step(1); return; }
      for (let bytes = 1; bytes <= 8; bytes += 1) {
        await delay(50);
        if (closed) return;
        options.step(bytes);
      }
      await fs.writeFile(local,'12345678');
      callback = null;
      done();
    })().catch(done);
  };
  const broker = new SshBroker({});
  broker.sessions.set('fixture',{client:{sftp:done => done(null,sftp)}});
  const internal = broker.withInternalSftp.bind(broker);
  broker.withInternalSftp = (id,operation,options) => internal(id,operation,{...options,timeoutMs:5000,inactivityMs:250});
  return { broker, root, destination:path.join(root,'download.log') };
}

test('下载持续有进度时越过空闲时限仍能完成，保持较小读取窗口', async (t) => {
  const h = await fixture(t,'progress');
  const result = await h.broker.downloadRemoteFile('fixture','/fixture.log',h.destination,100);
  assert.equal(result.bytes,8);
  assert.equal(await fs.readFile(h.destination,'utf8'),'12345678');
});

test('下载完成前源文件变化时不覆盖原文件，并清理临时文件', async (t) => {
  const h = await fixture(t,'changed');
  await fs.writeFile(h.destination,'original');
  await assert.rejects(h.broker.downloadRemoteFile('fixture','/fixture.log',h.destination,100), error => error.code === 'SOURCE_CHANGED');
  assert.equal(await fs.readFile(h.destination,'utf8'),'original');
  assert.deepEqual(await fs.readdir(h.root),['download.log']);
});

test('停滞的下载返回安全进度并终止传输', async (t) => {
  const h = await fixture(t,'stalled');
  await assert.rejects(h.broker.downloadRemoteFile('fixture','/fixture.log',h.destination,100), error => error.code === 'SFTP_OPERATION_TIMEOUT' && error.details.transferredBytes === 1 && error.details.totalBytes === 8);
  await delay(30);
  assert.deepEqual(await fs.readdir(h.root),[]);
});
