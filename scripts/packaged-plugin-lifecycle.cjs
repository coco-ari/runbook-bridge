const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { Server: SshServer, utils: sshUtils } = require('ssh2');
const mysql = require('mysql2');

// These are bounded loopback protocol fixtures, not production services. The
// packaged app still runs its actual preload, IPC, stores, DPAPI vault, network
// drivers, probes, edit sessions and connection coordinator without replacement.
async function startLoopbackFixtures() {
  const password = crypto.randomBytes(24).toString('hex');
  const replacement = crypto.randomBytes(24).toString('hex');
  const acceptedPasswords = new Set([password]);
  const sockets = new Set();
  const servers = [];
  const counts = { sshAuth: 0, sshRejected: 0, mysqlAuth: 0, mysqlRejected: 0,
    mysqlQueries: 0, redisAuth: 0, redisRejected: 0, redisPing: 0 };
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  };
  const listen = (server, emitter = server) => new Promise((resolve, reject) => {
    servers.push(server);
    emitter.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(emitter.address().port));
  });
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
  };
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048, privateKeyEncoding: {type:'pkcs1',format:'pem'},
      publicKeyEncoding: {type:'spki',format:'pem'},
    });
    const hostKeyFingerprint = 'SHA256:' + crypto.createHash('sha256')
      .update(sshUtils.parseKey(privateKey).getPublicSSH()).digest('base64').replace(/=+$/u, '');
    const ssh = new SshServer({hostKeys:[privateKey]}, (client) => {
      client.on('error', () => undefined);
      client.on('authentication', (context) => {
        if (context.method === 'password' && context.username === 'fixture'
          && acceptedPasswords.has(context.password)) {
          counts.sshAuth += 1;
          context.accept();
        } else {
          if (context.method === 'password') counts.sshRejected += 1;
          context.reject(['password']);
        }
      });
    });
    ssh._srv.on('connection', track);
    const sshPort = await listen(ssh);

    const sha1 = (...values) => values.reduce((hash, value) => hash.update(value), crypto.createHash('sha1')).digest();
    const tokenMatches = (context) => [...acceptedPasswords].some((value) => {
      const first = sha1(value);
      const scrambled = sha1(context.authPluginData1, context.authPluginData2, sha1(first));
      const expected = Buffer.from(first.map((byte, index) => byte ^ scrambled[index]));
      return context.authToken.length === expected.length && crypto.timingSafeEqual(context.authToken, expected);
    });
    const column = (name) => ({catalog:'def',schema:'',table:'',orgTable:'',name,orgName:name,
      characterSet:33,columnLength:255,columnType:253,flags:0,decimals:0});
    const database = mysql.createServer((client) => {
      client.on('error', () => undefined);
      client.serverHandshake({protocolVersion:10,serverVersion:'8.0.0-loopback-fixture',
        connectionId:counts.mysqlAuth + 1,statusFlags:2,characterSet:33,
        capabilityFlags:0x0008820d,
        authCallback:(context, done) => {
          if (context.user === 'fixture' && tokenMatches(context)) { counts.mysqlAuth += 1; done(null); }
          else { counts.mysqlRejected += 1; done(null, {code:1045,message:'Fixture authentication failed'}); }
          // mysql2's server helper keeps one dispatch command open. Reset only
          // between completed exchanges, as the MySQL wire protocol requires.
          client.sequenceId = 0;
        },
      });
      client.on('query', (query) => {
        counts.mysqlQueries += 1;
        if (query === 'SELECT DATABASE() AS ai_ops_database') {
          client.writeTextResult([{ai_ops_database:client.clientHelloReply.database}], [column('ai_ops_database')]);
        } else if (query === 'SELECT 1 AS ai_ops_health') {
          client.writeTextResult([{ai_ops_health:'1'}], [column('ai_ops_health')]);
        } else if (query === 'SHOW DATABASES') {
          client.writeTextResult([{Database:'app'}, {Database:'archive'}], [column('Database')]);
        } else client.writeError({code:1064,message:'Query outside bounded fixture contract'});
        client.sequenceId = 0;
      });
    });
    database._server.on('connection', track);
    const mysqlPort = await listen(database, database._server);

    const redis = net.createServer((socket) => {
      track(socket);
      let pending = Buffer.alloc(0);
      let authenticated = false;
      socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > 64 * 1024) return socket.destroy();
        while (pending.length) {
          const firstEnd = pending.indexOf('\r\n');
          if (firstEnd < 0) return;
          if (pending[0] !== 42) return socket.destroy();
          const count = Number(pending.subarray(1, firstEnd).toString());
          if (!Number.isInteger(count) || count < 1 || count > 16) return socket.destroy();
          const args = [];
          let offset = firstEnd + 2;
          for (let index = 0; index < count; index += 1) {
            const end = pending.indexOf('\r\n', offset);
            if (end < 0) return;
            if (pending[offset] !== 36) return socket.destroy();
            const length = Number(pending.subarray(offset + 1, end).toString());
            if (!Number.isInteger(length) || length < 0 || length > 16 * 1024) return socket.destroy();
            if (pending.length < end + 2 + length + 2) return;
            args.push(pending.subarray(end + 2, end + 2 + length).toString());
            offset = end + 2 + length + 2;
          }
          pending = pending.subarray(offset);
          const command = args[0].toUpperCase();
          if (command === 'AUTH') {
            authenticated = (args.length === 2 || args[1] === 'fixture') && acceptedPasswords.has(args.at(-1));
            if (authenticated) counts.redisAuth += 1;
            else counts.redisRejected += 1;
            socket.write(authenticated ? '+OK\r\n' : '-WRONGPASS fixture authentication failed\r\n');
          } else if (!authenticated) socket.write('-NOAUTH authentication required\r\n');
          else if (command === 'PING') { counts.redisPing += 1; socket.write('+PONG\r\n'); }
          else if (command === 'SELECT' && ['0','3'].includes(args[1])) socket.write('+OK\r\n');
          else if (command === 'CLIENT' && args[1]?.toUpperCase() === 'SETINFO') socket.write('+OK\r\n');
          else if (command === 'QUIT') socket.end('+OK\r\n');
          else socket.write('-ERR command outside bounded fixture contract\r\n');
        }
      });
    });
    const redisPort = await listen(redis);
    return {password,replacement,hostKeyFingerprint,sshPort,mysqlPort,redisPort,counts,stop,
      usePassword:(value) => { acceptedPasswords.clear(); acceptedPasswords.add(value); }};
  } catch (error) { await stop(); throw error; }
}

async function exercisePackagedPluginLifecycle(cdp, dataRoot) {
  const fixture = await startLoopbackFixtures();
  let calls = 0;
  const invoke = async (method, payload) => {
    calls += 1;
    // Do not include payloads or credential values in assertions/diagnostics.
    return cdp.evaluate(`window.aiOps.v2[${JSON.stringify(method)}](${JSON.stringify(payload)})`);
  };
  const success = async (method, payload) => {
    const result = await invoke(method, payload);
    assert.equal(result?.ok, true, `${method}: ${result?.error?.code ?? 'unexpected response'}`);
    return result.data;
  };
  try {
    const project = await success('createProject', {name:'Packaged lifecycle fixture'});
    const [environment] = await success('listEnvironments', project.projectId);
    const scope = {projectId:project.projectId,environmentId:environment.environmentId};
    const begin = async (plugin) => {
      const preview = await success('preparePluginConnectionEdit', {...scope,
        pluginInstanceId:plugin.pluginInstanceId,expectedRevision:plugin.revision});
      return success('beginPluginConnectionEdit', {prepareToken:preview.prepareToken});
    };
    for (const pluginType of ['server','mysql','redis']) {
      process.stdout.write(`Packaged plugin lifecycle: ${pluginType}\n`);
      fixture.usePassword(fixture.password);
      const input = {pluginType,displayName:`Packaged ${pluginType}`,
        target:{host:'127.0.0.1',port:fixture[`${pluginType === 'server' ? 'ssh' : pluginType}Port`],
          ...(pluginType === 'server' ? {hostKeyFingerprint:fixture.hostKeyFingerprint} : {}),
          ...(pluginType === 'mysql' ? {database:'app'} : {}),...(pluginType === 'redis' ? {db:0} : {})},
        auth:{username:'fixture',...(pluginType === 'server' ? {type:'password'} : {})},
        ...(pluginType === 'server' ? {uplink:{type:'direct'}} : {transport:{kind:'direct'},tls:{mode:'disabled'}})};
      const purpose = pluginType === 'server' ? 'server-auth' : 'resource-access';
      const probe = (draft = input, password = fixture.password, requestedPurpose = purpose) => invoke('probePluginDraft', {
        ...scope,formInstanceId:crypto.randomUUID(),requestId:crypto.randomUUID(),draftGeneration:1,sequence:1,
        purpose:requestedPurpose,draft,temporarySecrets:{password},
      });
      const rejectedKey = `${pluginType === 'server' ? 'ssh' : pluginType}Rejected`;
      const rejectedBefore = fixture.counts[rejectedKey];
      const denied = await probe(input, crypto.randomBytes(24).toString('hex'));
      assert.equal(denied.ok, false, `${pluginType}: incorrect password is rejected by the real driver`);
      assert.ok(fixture.counts[rejectedKey] > rejectedBefore, 'failed probe reached protocol authentication');
      const checked = await probe();
      assert.equal(checked.ok, true, `${pluginType}: new-plugin probe ${checked.error?.code ?? ''}`);
      assert.equal(checked.data.state, 'valid');
      assert.equal((await success('listPlugins', scope)).length, 0, 'probe never persists a plugin');
      if (pluginType === 'mysql') {
        const discovered = await probe(input, fixture.password, 'resource-discovery');
        assert.equal(discovered.ok, true);
        assert.deepEqual(discovered.data.result, {databases:['app','archive'],truncated:false});
      }
      let plugin = await success('createPlugin', {...scope,input,secrets:{password:fixture.password}});
      const connected = await success('connectPlugin', {...scope,pluginInstanceId:plugin.pluginInstanceId});
      assert.equal(connected.plugins[plugin.pluginInstanceId].phase, 'connected');
      const session = await begin(plugin);
      const validation = await success('validatePluginDraft', {
        editSessionId:session.editSessionId,requestId:crypto.randomUUID(),draftGeneration:1,purpose,
        draft:plugin,credentialIntent:'unchanged',temporarySecrets:{},discardTemporarySecrets:true,
      });
      assert.equal(validation.state, 'valid', 'saved credential reuse only occurs in an existing edit session');
      await success('cancelPluginConnectionEdit', {editSessionId:session.editSessionId,restorePreEditConnections:true});
      const restored = await success('environmentStatus', scope);
      assert.equal(restored.plugins[plugin.pluginInstanceId].phase, 'connected');
      const edit = await begin(plugin);
      fixture.usePassword(fixture.replacement);
      const connectionPatch = pluginType === 'server' ? {target:{addressFamily:'ipv4Only'}}
        : pluginType === 'mysql' ? {target:{database:'archive'}} : {target:{db:3}};
      const saved = await success('savePluginConnectionEdit', {
        editSessionId:edit.editSessionId,expectedRevision:plugin.revision,patch:connectionPatch,
        credentialIntent:'replace',temporarySecrets:{password:fixture.replacement},discardTemporarySecrets:true,
        afterCommit:'connect-current',
      });
      assert.equal(saved.committed, true);
      assert.equal(saved.runtimeWarning, null);
      await success('disconnectPlugin', {...scope,pluginInstanceId:plugin.pluginInstanceId});
      const replacementConnection = await success('connectPlugin', {...scope,pluginInstanceId:plugin.pluginInstanceId});
      assert.equal(replacementConnection.plugins[plugin.pluginInstanceId].phase, 'connected',
        'only the replacement password is accepted, and reconnect receives no supplied secrets');
      [plugin] = await success('listPlugins', scope);
      for (const [field,value] of Object.entries(connectionPatch.target)) assert.equal(plugin.target[field], value);
      plugin = await success('updatePluginMetadata', {...scope,pluginInstanceId:plugin.pluginInstanceId,
        expectedRevision:plugin.revision,patch:{displayName:`Edited ${pluginType}`}});
      assert.equal(plugin.displayName, `Edited ${pluginType}`);
      const status = await success('credentialStatus', {...scope,pluginInstanceId:plugin.pluginInstanceId});
      assert.equal(status.saved, true);
      const deleted = await success('deletePlugin', {...scope,pluginInstanceId:plugin.pluginInstanceId});
      assert.equal(deleted.credentialsPreserved, true);
      assert.equal((await success('listPlugins', scope)).length, 0);
      fixture.usePassword(fixture.password);
      const checkedAgain = await probe();
      assert.equal(checkedAgain.ok, true, 'first probe after deleting the final plugin succeeds');
      const recreated = await success('createPlugin', {...scope,input,secrets:{password:fixture.password}});
      assert.notEqual(recreated.pluginInstanceId, plugin.pluginInstanceId, 'same-name re-add never inherits old vault identity');
      const reconnected = await success('connectPlugin', {...scope,pluginInstanceId:recreated.pluginInstanceId});
      assert.equal(reconnected.plugins[recreated.pluginInstanceId].phase, 'connected');
      await success('deletePlugin', {...scope,pluginInstanceId:recreated.pluginInstanceId});
      const emptied = await success('environmentStatus', scope);
      assert.equal(emptied.phase, 'disconnected', 'deleting the final plugin clears aggregate connection state');
      assert.equal(emptied.desiredConnected, false, 'an empty environment retains no reconnect intent');
    }
    // Inspect bytes, never output operational text, and do not call revealCredential.
    let encryptedVaultFiles = 0;
    const visit = async (directory) => {
      for (const entry of await fs.readdir(directory, {withFileTypes:true})) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) {
          const bytes = await fs.readFile(file);
          for (const value of [fixture.password,fixture.replacement]) {
            assert.equal(bytes.includes(Buffer.from(value)), false, 'generated credential must not appear in persisted plaintext');
          }
          if (entry.name.endsWith('.json') && directory.includes('credential')) encryptedVaultFiles += 1;
        }
      }
    };
    await visit(dataRoot);
    assert.ok(encryptedVaultFiles > 0, 'actual encrypted credential records were persisted');
    assert.ok(fixture.counts.sshAuth >= 6 && fixture.counts.mysqlAuth >= 6 && fixture.counts.redisAuth >= 6);
    await success('deleteProject', {projectId:project.projectId});
    assert.equal((await success('workspaceOverview')).length, 0);
    return {calls,pluginTypes:3,protocols:fixture.counts,plaintextCredentialLeaks:0};
  } finally { await fixture.stop(); }
}

module.exports = {exercisePackagedPluginLifecycle,startLoopbackFixtures};
