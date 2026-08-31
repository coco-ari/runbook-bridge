import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

import * as model from '../renderer/v2/src/features/plugins/plugin-editor-model.ts';
import * as types from '../renderer/v2/src/features/plugins/plugin-types.ts';
import * as strategies from '../renderer/v2/src/features/plugins/plugin-save-strategy.ts';

const scope = {projectId:'project',environmentId:'environment'};
const fingerprint = 'SHA256:fixture-host-key';
const ok = data => ({ok:true,data});
const challenge = overrides => ({
  ok:false,
  error:{
    code:'SSH_HOST_KEY_CONFIRM_REQUIRED',message:'首次连接需要确认服务器指纹。',
    details:{host:'server.fixture.invalid',port:22,fingerprint,...overrides},
  },
});

// Execute the production hook with deterministic React scheduling; the service
// boundary is mocked so these tests never contact real infrastructure.
async function harness({existing = false,kind = 'server',respond = () => challenge(),apiOverrides = {},phase = 'editing'} = {}) {
  const source = stripTypeScriptTypes(await fs.readFile('renderer/v2/src/features/plugins/use-plugin-editor.ts','utf8'))
    .replace(/^import[\s\S]*?from "[^"]+"\s*$/gmu,'')
    .replace(/^export /gmu,'');
  const slots = [];
  const calls = [];
  const listeners = {};
  let cursor = 0;
  let dirty = true;
  let effects = [];
  let current;
  const record = {
    ...scope,pluginInstanceId:kind,pluginType:kind,revision:1,displayName:`Fixture ${kind}`,
    target:{host:`${kind}.fixture.invalid`,port:types.DEFAULT_PORTS[kind],addressFamily:'ipv4Preferred',database:'fixture',db:0},
    auth:{username:'operator',type:'agent'},uplink:{type:'direct'},
    transport:{kind:'direct'},tls:{mode:'required'},
  };
  const validate = async payload => {
    calls.push(payload);
    return respond(payload,calls.length);
  };
  const api = {
    probePluginDraft:validate,
    validatePluginDraft:validate,
    credentialStatus:async () => ok({}),
    preparePluginConnectionEdit:async () => ok({prepareToken:'preparation',preEditConnectedSet:[],affectedIds:['server']}),
    beginPluginConnectionEdit:async () => ok({editSessionId:'edit-session'}),
    onPluginProbeProgress(callback) { listeners.probe = callback; return () => {}; },
    onPluginValidationProgress(callback) { listeners.validation = callback; return () => {}; },
    ...apiOverrides,
  };
  const props = {api,scope,open:true,plugin:existing ? record : null};
  const same = (left,right) => left && right && left.length === right.length
    && left.every((value,index) => Object.is(value,right[index]));
  const hook = runInNewContext(`${source}\nusePluginEditor`,{
    ...model,...types,...strategies,
    useReducer(reducer,initial) {
      const slot = slots[cursor++] ??= {value:initial};
      return [slot.value,action => {
        const next = reducer(slot.value,action);
        if (!Object.is(next,slot.value)) { slot.value = next; dirty = true; }
      }];
    },
    useRef(initial) { return slots[cursor++] ??= {current:initial}; },
    useMemo(factory,deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps,deps)) slots[index] = {value:factory(),deps};
      return slots[index].value;
    },
    useCallback(callback,deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps,deps)) slots[index] = {callback,deps};
      return slots[index].callback;
    },
    useEffect(callback,deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps,deps)) {
        const previous = slots[index];
        const slot = slots[index] = {deps};
        effects.push(() => { previous?.cleanup?.(); slot.cleanup = callback(); });
      }
    },
  });
  const flush = () => {
    for (let count = 0; dirty || effects.length; count += 1) {
      assert.ok(count < 30,'plugin hook render loop must settle');
      dirty = false;
      cursor = 0;
      current = hook(props);
      const pending = effects;
      effects = [];
      for (const effect of pending) effect();
    }
    return current;
  };
  flush();
  if (!existing) current.updateDraft(() => types.pluginDraftFromRecord(record));
  for (let count = 0; count < 4; count += 1) {
    await Promise.resolve();
    flush();
  }
  assert.equal(current.state.phase,phase);
  return {
    calls,
    get current() { return flush(); },
    progress(value) { listeners[existing ? 'validation' : 'probe'](value); flush(); },
  };
}

for (const existing of [false,true]) {
  const entry = existing ? 'existing plugin validation' : 'new plugin probe';

  test(`${entry} treats a correlated host-key challenge as a pending decision and ignores late progress`,async () => {
    const h = await harness({existing});
    assert.equal(await h.current.validate(),false);
    assert.equal(h.current.state.validation.state,'awaiting-confirmation');
    assert.equal(h.current.state.validation.error,undefined);
    assert.equal(h.current.state.error,null);
    assert.equal(h.current.state.confirmation.kind,'host-key');
    assert.equal(h.current.state.draft.target.hostKeyFingerprint,undefined);
    const request = h.calls[0];
    h.progress({...request,state:'failed'});
    assert.equal(h.current.state.validation.state,'awaiting-confirmation');
    assert.equal(h.current.state.error,null);
    assert.equal(h.calls.length,1,'observing a fingerprint must never retry or trust automatically');
  });

  test(`${entry} cancels host-key confirmation without trusting or retrying`,async () => {
    const h = await harness({existing});
    await h.current.validate();
    h.current.rejectConfirmation();
    await h.current.acceptHostKey();
    assert.equal(h.current.state.confirmation,null);
    assert.equal(h.current.state.validation.state,'cancelled');
    assert.equal(h.current.state.error,null);
    assert.equal(h.current.state.draft.target.hostKeyFingerprint,undefined);
    assert.equal(h.calls.length,1,'a rejected confirmation cannot be reused to retry');
  });

  test(`${entry} retries only the approved fingerprint and preserves a real retry failure`,async () => {
    const failure = {code:'SSH_AUTHENTICATION_FAILED',message:'Fixture authentication failed.'};
    const h = await harness({existing,respond:(_payload,attempt) => attempt === 1 ? challenge() : {ok:false,error:failure}});
    await h.current.validate();
    await h.current.acceptHostKey();
    assert.equal(h.calls.length,2);
    assert.equal(h.calls[0].draft.target.hostKeyFingerprint,undefined);
    assert.equal(h.calls[1].draft.target.hostKeyFingerprint,fingerprint);
    assert.equal(h.calls[1].draft.target.host,h.calls[0].draft.target.host);
    assert.equal(h.calls[1].draft.target.port,h.calls[0].draft.target.port);
    assert.equal(h.current.state.confirmation,null);
    assert.equal(h.current.state.validation.state,'failed');
    assert.equal(h.current.state.error.code,failure.code);
    assert.equal(h.current.state.validation.error.message,failure.message);
  });
}

test('unusable host-key challenges and host-key mismatches remain visible errors',async () => {
  for (const response of [
    challenge({host:'other.fixture.invalid'}),
    challenge({port:2222}),
    challenge({fingerprint:''}),
    {ok:false,error:{code:'SSH_HOST_KEY_MISMATCH',message:'Fixture host key changed.'}},
  ]) {
    const h = await harness({respond:() => response});
    await h.current.validate();
    assert.equal(h.current.state.confirmation,null);
    assert.equal(h.current.state.validation.state,'failed');
    assert.equal(h.current.state.error.code,response.error.code);
    assert.equal(h.current.state.draft.target.hostKeyFingerprint,undefined);
    await h.current.acceptHostKey();
    assert.equal(h.calls.length,1,'unusable or changed keys must not gain an approval path');
  }
});

const unsupportedTls = () => ({ok:false,error:{code:'TLS_UNSUPPORTED',message:'Fixture target does not support TLS.'}});

for (const existing of [false,true]) {
  for (const kind of ['mysql','redis']) {
    const entry = `${existing ? 'existing' : 'new'} ${kind}`;

    test(`${entry} awaits explicit TLS fallback without failure or automatic downgrade`,async () => {
      const h = await harness({existing,kind,respond:unsupportedTls});
      assert.equal(await h.current.validate(),false);
      assert.equal(h.current.state.validation.state,'awaiting-confirmation');
      assert.equal(h.current.state.validation.error,undefined);
      assert.equal(h.current.state.error,null);
      assert.equal(h.current.state.confirmation.kind,'disable-tls');
      assert.equal(h.current.state.draft.tls.mode,'required');
      h.progress({...h.calls[0],state:'failed'});
      assert.equal(h.current.state.validation.state,'awaiting-confirmation');
      assert.equal(h.current.state.error,null);
      assert.equal(h.calls.length,1);
    });

    test(`${entry} cancels TLS fallback without changing TLS or retrying`,async () => {
      const h = await harness({existing,kind,respond:unsupportedTls});
      await h.current.validate();
      h.current.rejectConfirmation();
      await h.current.acceptTlsFallback();
      assert.equal(h.current.state.confirmation,null);
      assert.equal(h.current.state.validation.state,'cancelled');
      assert.equal(h.current.state.error,null);
      assert.equal(h.current.state.draft.tls.mode,'required');
      assert.equal(h.calls.length,1);
    });

    test(`${entry} retries TLS fallback only after approval and preserves a real retry failure`,async () => {
      const failure = {code:'AUTHENTICATION_FAILED',message:'Fixture authentication failed.'};
      const h = await harness({existing,kind,respond:(_payload,attempt) => attempt === 1 ? unsupportedTls() : {ok:false,error:failure}});
      await h.current.validate();
      await h.current.acceptTlsFallback();
      assert.equal(h.calls.length,2);
      assert.equal(h.calls[0].draft.tls.mode,'required');
      assert.equal(h.calls[1].draft.tls.mode,'disabled');
      assert.deepEqual(h.calls[1].draft.target,h.calls[0].draft.target);
      assert.equal(h.current.state.confirmation,null);
      assert.equal(h.current.state.validation.state,'failed');
      assert.equal(h.current.state.error.code,failure.code);
      assert.equal(h.current.state.validation.error.message,failure.message);
    });
  }
}

test('other TLS errors, already disabled TLS and Server errors remain failures without fallback',async () => {
  for (const {kind,code,disabled} of [
    {kind:'mysql',code:'TLS_CERTIFICATE_INVALID'},
    {kind:'redis',code:'TLS_CERTIFICATE_INVALID'},
    {kind:'mysql',code:'TLS_UNSUPPORTED',disabled:true},
    {kind:'redis',code:'TLS_UNSUPPORTED',disabled:true},
    {kind:'server',code:'TLS_UNSUPPORTED'},
  ]) {
    const h = await harness({kind,respond:() => ({ok:false,error:{code,message:'Fixture TLS failure.'}})});
    if (disabled) h.current.updateDraft(draft => ({...draft,tls:{mode:'disabled'}}));
    await h.current.validate();
    assert.equal(h.current.state.confirmation,null);
    assert.equal(h.current.state.validation.state,'failed');
    assert.equal(h.current.state.error.code,code);
    await h.current.acceptTlsFallback();
    assert.equal(h.calls.length,1);
  }
});

test('credential replacement waits without a false failure and cannot be reused after cancellation',async () => {
  const saveCalls = [];
  const h = await harness({existing:true,kind:'mysql',respond:() => ok({}),apiOverrides:{
    savePluginConnectionEdit:async payload => {
      saveCalls.push(payload);
      return {ok:false,error:{code:'CREDENTIAL_REPLACEMENT_INCOMPLETE',message:'Fixture replacement requires approval.'}};
    },
  }});
  h.current.setCredentials({primary:'synthetic-test-replacement',proxy:''});
  await h.current.save();
  assert.equal(h.current.state.phase,'editing');
  assert.equal(h.current.state.error,null);
  assert.equal(h.current.state.confirmation.kind,'credential-replacement');
  assert.equal(saveCalls.length,1);
  assert.equal(saveCalls[0].forceCredentialReplacement,undefined);
  h.current.rejectConfirmation();
  await h.current.confirmCredentialReplacement();
  assert.equal(h.current.state.confirmation,null);
  assert.equal(h.current.state.error,null);
  assert.equal(saveCalls.length,1);
});

test('credential replacement requires explicit approval and preserves a real save failure',async () => {
  const saveCalls = [];
  const failure = {code:'PERSISTENCE_FAILED',message:'Fixture persistence failed.'};
  const h = await harness({existing:true,kind:'mysql',respond:() => ok({}),apiOverrides:{
    savePluginConnectionEdit:async payload => {
      saveCalls.push(payload);
      return {ok:false,error:saveCalls.length === 1
        ? {code:'CREDENTIAL_REPLACEMENT_INCOMPLETE',message:'Fixture replacement requires approval.'}
        : failure};
    },
  }});
  h.current.setCredentials({primary:'synthetic-test-replacement',proxy:''});
  await h.current.save('restore-previous');
  assert.equal(h.current.state.error,null);
  await h.current.confirmCredentialReplacement();
  assert.equal(saveCalls.length,2);
  assert.equal(saveCalls[0].forceCredentialReplacement,undefined);
  assert.equal(saveCalls[1].forceCredentialReplacement,true);
  assert.equal(saveCalls[1].afterCommit,'restore-pre-edit-set');
  assert.equal(h.current.state.confirmation,null);
  assert.equal(h.current.state.error.code,failure.code);
  await h.current.confirmCredentialReplacement();
  assert.equal(saveCalls.length,2);
});

test('edit impact waits for a decision without an error or starting an edit session',async () => {
  const beginCalls = [];
  const cancelCalls = [];
  const h = await harness({existing:true,phase:'impact-confirmation',apiOverrides:{
    preparePluginConnectionEdit:async () => ok({prepareToken:'preparation',preEditConnectedSet:['server'],affectedIds:['server']}),
    beginPluginConnectionEdit:async payload => { beginCalls.push(payload); return ok({editSessionId:'edit-session'}); },
    cancelPluginConnectionEdit:async payload => { cancelCalls.push(payload); return ok({}); },
  }});
  assert.equal(h.current.state.confirmation.kind,'edit-impact');
  assert.equal(h.current.state.error,null);
  assert.equal(beginCalls.length,0);
  await h.current.rejectEditImpact();
  assert.equal(cancelCalls.length,1);
  assert.equal(cancelCalls[0].prepareToken,'preparation');
  assert.equal(beginCalls.length,0);
  assert.equal(h.current.state.phase,'closed');
  assert.equal(h.current.state.error,null);
});
