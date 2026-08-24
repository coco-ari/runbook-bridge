import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppError } from '../src/errors.mjs';
import { registerV2Ipc } from '../src/ipc-v2.mjs';
import { DEFAULT_QUICK_QUESTION_OPENING } from '../src/quick-questions.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));

function harness(workspaceStore, quickQuestionClipboard = {writeText:() => undefined}) {
  const handlers = new Map();
  const broadcasts = [];
  registerV2Ipc({
    handle:(name,handler) => handlers.set(name,handler),
    on:() => undefined,
  },{
    workspaceStore,
    connectionManager:{on:() => undefined},
    contextManager:{},
    confirmationManager:{on:() => undefined},
    pluginManager:{},
    mysqlRuntime:{},
    quickQuestionClipboard,
    broadcast:(...args) => broadcasts.push(args),
  });
  return {handlers,broadcasts};
}

function baseStore(overrides = {}) {
  const opening = {
    schemaVersion:1,
    revision:2,
    text:'请使用 AI Ops MCP 在当前范围排查。',
    defaultText:DEFAULT_QUICK_QUESTION_OPENING,
  };
  return {
    getProject:async () => ({projectId:'project-a',name:'订单中心'}),
    getEnvironment:async () => ({projectId:'project-a',environmentId:'production',name:'生产环境'}),
    listProjectOverviews:async () => [{
      projectId:'project-a',name:'订单中心',environments:[{environmentId:'production',name:'生产环境'}],
    }],
    getQuickQuestionOpening:async () => opening,
    saveQuickQuestionOpening:async (text,expectedRevision) => ({...opening,revision:expectedRevision + 1,text}),
    useQuickQuestionOpening:async (expectedRevision,operation) => {
      if (expectedRevision !== opening.revision) {
        throw new AppError('CONFIG_REVISION_CONFLICT','开场白已变化。');
      }
      return operation(opening);
    },
    listQuickQuestions:async () => ({schemaVersion:1,revision:0,items:[]}),
    saveQuickQuestion:async () => ({schemaVersion:1,revision:1,items:[]}),
    deleteQuickQuestion:async () => ({schemaVersion:1,revision:2,items:[]}),
    ...overrides,
  };
}

test('opening and environment question IPC methods expose exact preload APIs and broadcast mutations', async () => {
  const calls = [];
  const store = baseStore({
    getQuickQuestionOpening:async () => {
      calls.push(['opening-get']);
      return {schemaVersion:1,revision:0,text:DEFAULT_QUICK_QUESTION_OPENING,defaultText:DEFAULT_QUICK_QUESTION_OPENING};
    },
    saveQuickQuestionOpening:async (...args) => {
      calls.push(['opening-save',...args]);
      return {schemaVersion:1,revision:1,text:args[0],defaultText:DEFAULT_QUICK_QUESTION_OPENING};
    },
    listQuickQuestions:async (...args) => { calls.push(['list',...args]); return {revision:0,items:[]}; },
    saveQuickQuestion:async (...args) => { calls.push(['save',...args]); return {revision:1,items:[]}; },
    deleteQuickQuestion:async (...args) => { calls.push(['delete',...args]); return {revision:2,items:[]}; },
  });
  const {handlers,broadcasts} = harness(store);
  const scope = {projectId:'project-a',environmentId:'production'};
  assert.equal((await handlers.get('v2:quick-question-opening-get')({})).ok,true);
  assert.equal((await handlers.get('v2:quick-question-opening-save')({}, {
    text:'请使用 AI Ops MCP 排查。',expectedRevision:0,
  })).ok,true);
  assert.equal((await handlers.get('v2:quick-question-list')({},scope)).ok,true);
  assert.equal((await handlers.get('v2:quick-question-save')({},
    {...scope,questionId:'question-a1',text:'排查订单',expectedRevision:3})).ok,true);
  assert.equal((await handlers.get('v2:quick-question-delete')({},
    {...scope,questionId:'question-a1',expectedRevision:4})).ok,true);
  assert.deepEqual(calls,[
    ['opening-get'],
    ['opening-save','请使用 AI Ops MCP 排查。',0],
    ['list','project-a','production'],
    ['save','project-a','production',{questionId:'question-a1',text:'排查订单'},3],
    ['delete','project-a','production','question-a1',4],
  ]);
  assert.deepEqual(broadcasts.map(([,payload]) => payload.type),[
    'quick-question-opening-updated','quick-questions-updated','quick-questions-updated',
  ]);

  const preload = await fs.readFile(path.join(testRoot,'..','src','preload.cjs'),'utf8');
  for (const method of [
    'getQuickQuestionOpening','saveQuickQuestionOpening',
    'listQuickQuestions','saveQuickQuestion','deleteQuickQuestion','copyQuickQuestion',
  ]) assert.match(preload,new RegExp(`${method}:`,'u'));
  const main = await fs.readFile(path.join(testRoot,'..','src','main.mjs'),'utf8');
  const quickLogic = await fs.readFile(path.join(testRoot,'..','src','quick-questions.mjs'),'utf8');
  assert.doesNotMatch(main,/nativeImage|createQuickQuestionClipboardAdapter/u);
  assert.doesNotMatch(quickLogic,/attachmentDataUrl|nativeImage|data:image\//u);
});

test('copy uses canonical names and revision-bound global opening, redacts the question, and writes text only', async () => {
  const writes = [];
  const store = baseStore();
  const {handlers} = harness(store,{writeText:async (text) => writes.push(text)});
  const result = await handlers.get('v2:quick-question-copy')({}, {
    projectId:'project-a',environmentId:'production',
    text:'排查 access_token="secret with spaces" 对应请求',
    expectedOpeningRevision:2,
  });
  assert.deepEqual(result,{ok:true,data:{copied:true}});
  assert.equal(writes.length,1);
  assert.equal(writes[0],[
    '请使用 AI Ops MCP 在当前范围排查。',
    '',
    '【当前范围】',
    '项目：订单中心',
    '环境：生产环境',
    '',
    '【问题】',
    '排查 access_token="[已脱敏]" 对应请求',
  ].join('\n'));
  assert.doesNotMatch(writes[0],/secret with spaces|默认只读|作用域锁定|project-a|production/u);
});

test('copy fails closed for old attachment, saved-id, and renderer-spoofed scope or opening fields', async () => {
  let writes = 0;
  const {handlers} = harness(baseStore(),{writeText:() => { writes += 1; }});
  const base = {
    projectId:'project-a',environmentId:'production',text:'检查服务',expectedOpeningRevision:2,
  };
  for (const extra of [
    {attachmentDataUrl:'data:image/png;base64,AA=='},
    {questionId:'question-a1',attachmentDataUrl:'data:image/png;base64,AA=='},
    {question:'旧字段'},
    {openingText:'伪造开场白'},
    {projectName:'伪造项目'},
    {environmentName:'伪造环境'},
  ]) {
    const rejected = await handlers.get('v2:quick-question-copy')({}, {...base,...extra});
    assert.equal(rejected.ok,false);
    assert.equal(rejected.error.code,'INVALID_ARGUMENT');
  }
  assert.equal(writes,0);
});

test('copy blocks stale opening previews, corrupt settings, duplicate names, and credential-bearing canonical names', async () => {
  let writes = 0;
  const clipboard = {writeText:() => { writes += 1; }};
  const payload = {
    projectId:'project-a',environmentId:'production',text:'检查服务',expectedOpeningRevision:1,
  };
  const staleHarness = harness(baseStore(),clipboard);
  const stale = await staleHarness.handlers.get('v2:quick-question-copy')({},payload);
  assert.equal(stale.ok,false);
  assert.equal(stale.error.code,'CONFIG_REVISION_CONFLICT');

  const corruptStore = baseStore({
    useQuickQuestionOpening:async () => {
      throw new AppError('QUICK_QUESTION_SETTINGS_INVALID','快捷提问全局设置文件损坏。');
    },
  });
  const corrupt = await harness(corruptStore,clipboard).handlers.get('v2:quick-question-copy')({}, {
    ...payload,expectedOpeningRevision:2,
  });
  assert.equal(corrupt.ok,false);
  assert.equal(corrupt.error.code,'QUICK_QUESTION_SETTINGS_INVALID');

  const duplicateStore = baseStore({
    listProjectOverviews:async () => [
      {projectId:'project-a',name:'订单中心',environments:[{environmentId:'production',name:'生产环境'}]},
      {projectId:'project-b',name:'订单中心',environments:[{environmentId:'prod-2',name:'生产环境'}]},
    ],
  });
  const duplicate = await harness(duplicateStore,clipboard).handlers.get('v2:quick-question-copy')({}, {
    ...payload,expectedOpeningRevision:2,
  });
  assert.equal(duplicate.ok,false);
  assert.equal(duplicate.error.code,'AMBIGUOUS_QUICK_QUESTION_SCOPE');

  const sensitiveStore = baseStore({
    getProject:async () => ({projectId:'project-a',name:'secret=scope-name-secret'}),
    listProjectOverviews:async () => [{
      projectId:'project-a',name:'secret=scope-name-secret',
      environments:[{environmentId:'production',name:'生产环境'}],
    }],
  });
  const sensitive = await harness(sensitiveStore,clipboard).handlers.get('v2:quick-question-copy')({}, {
    ...payload,expectedOpeningRevision:2,
  });
  assert.equal(sensitive.ok,false);
  assert.equal(sensitive.error.code,'QUICK_QUESTION_SCOPE_NAME_CONTAINS_CREDENTIAL');
  assert.doesNotMatch(sensitive.error.message,/scope-name-secret/u);
  assert.equal(writes,0);
});

test('opening save rejects renderer scope fields instead of silently accepting them', async () => {
  const {handlers,broadcasts} = harness(baseStore());
  const rejected = await handlers.get('v2:quick-question-opening-save')({}, {
    text:'请使用 AI Ops MCP 排查。',expectedRevision:2,projectId:'project-a',
  });
  assert.equal(rejected.ok,false);
  assert.equal(rejected.error.code,'INVALID_ARGUMENT');
  assert.equal(broadcasts.length,0);
});
