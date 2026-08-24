import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectStore } from '../src/project-store.mjs';
import { DEFAULT_QUICK_QUESTION_OPENING } from '../src/quick-questions.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'ai-ops-quick-questions-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const legacyStore = new ProjectStore(root);
  const store = new WorkspaceStore(root,{legacyStore});
  await store.init();
  const project = await store.createProject({name:'订单中心',environmentName:'生产环境'});
  const [environment] = await store.listEnvironments(project.projectId);
  return {root,store,project,environment};
}

test('quick questions persist independently, parameterize identifiers, and keep stable IDs on update', async (t) => {
  const {store,project,environment} = await fixture(t);
  const environmentFile = store.environmentPath(project.projectId,environment.environmentId);
  const environmentBefore = await fs.readFile(environmentFile);
  assert.deepEqual(await store.listQuickQuestions(project.projectId,environment.environmentId),{
    schemaVersion:1,projectId:project.projectId,environmentId:environment.environmentId,revision:0,items:[],
  });

  const saved = await store.saveQuickQuestion(project.projectId,environment.environmentId,{
    text:'排查订单2026082012345678、用户U123456、机柜10600002，日期20260820',
  },0);
  assert.equal(saved.revision,1);
  assert.match(saved.items[0].questionId,/^question-[a-f0-9]{16}$/u);
  assert.equal(saved.items[0].text,'排查订单{订单号}、用户{用户ID}、机柜{机柜号},日期20260820');
  assert.equal(new Date(saved.items[0].createdAt).toISOString(),saved.items[0].createdAt);
  assert.deepEqual(await fs.readFile(environmentFile),environmentBefore,'environment revision/file must not change');

  const first = saved.items[0];
  const updated = await store.upsertQuickQuestion(project.projectId,environment.environmentId,{
    questionId:first.questionId,text:'重新排查{订单号}',
  },saved.revision);
  assert.equal(updated.revision,2);
  assert.equal(updated.items[0].questionId,first.questionId);
  assert.equal(updated.items[0].createdAt,first.createdAt);
  assert.equal(new Date(updated.items[0].updatedAt).toISOString(),updated.items[0].updatedAt);

  const disk = JSON.parse(await fs.readFile(store.quickQuestionsPath(project.projectId,environment.environmentId),'utf8'));
  assert.equal(disk.schemaVersion,1);
  assert.equal(disk.revision,2);
  const names = await fs.readdir(store.environmentDir(project.projectId,environment.environmentId));
  assert.equal(names.some((name) => name.endsWith('.tmp')),false,'atomic temp files must be cleaned up');
});

test('quick-question revisions serialize concurrent writers and enforce the eight-item limit', async (t) => {
  const {store,project,environment} = await fixture(t);
  const scope = [project.projectId,environment.environmentId];
  const attempts = await Promise.allSettled([
    store.saveQuickQuestion(...scope,{text:'问题 A'},0),
    store.saveQuickQuestion(...scope,{text:'问题 B'},0),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length,1);
  assert.equal(attempts.filter((item) => item.status === 'rejected' && item.reason.code === 'CONFIG_REVISION_CONFLICT').length,1);
  let document = await store.listQuickQuestions(...scope);
  await assert.rejects(
    () => store.saveQuickQuestion(...scope,{text:'旧版本写入'},0),
    (error) => error.code === 'CONFIG_REVISION_CONFLICT',
  );
  await assert.rejects(
    () => store.saveQuickQuestion(...scope,{text:'缺少版本'}),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  while (document.items.length < 8) {
    document = await store.saveQuickQuestion(...scope,{text:`常用问题 ${document.items.length + 1}`},document.revision);
  }
  await assert.rejects(
    () => store.saveQuickQuestion(...scope,{text:'第九条'},document.revision),
    (error) => error.code === 'RESULT_LIMIT_EXCEEDED',
  );
  assert.equal((await store.listQuickQuestions(...scope)).items.length,8);
});

test('credentials and oversized text are rejected, business token remains, and deletion uses its own revision', async (t) => {
  const {store,project,environment} = await fixture(t);
  const scope = [project.projectId,environment.environmentId];
  await assert.rejects(
    () => store.saveQuickQuestion(...scope,{text:'Authorization: Bearer do-not-save-12345'},0),
    (error) => error.code === 'QUICK_QUESTION_CONTAINS_CREDENTIAL',
  );
  await assert.rejects(
    () => store.saveQuickQuestion(...scope,{text:'x'.repeat(1201)},0),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  const saved = await store.saveQuickQuestion(...scope,{text:'排查邀请 token=invite-20260820'},0);
  assert.equal(saved.items[0].text,'排查邀请 token=invite-20260820');
  await assert.rejects(
    () => store.deleteQuickQuestion(...scope,saved.items[0].questionId,0),
    (error) => error.code === 'CONFIG_REVISION_CONFLICT',
  );
  const deleted = await store.deleteQuickQuestion(...scope,saved.items[0].questionId,saved.revision);
  assert.equal(deleted.revision,2);
  assert.deepEqual(deleted.items,[]);
});

test('environment existence is checked and deleting an environment removes its quick-question file naturally', async (t) => {
  const {store,project} = await fixture(t);
  await assert.rejects(
    () => store.listQuickQuestions(project.projectId,'missing-environment'),
    (error) => error.code === 'ENVIRONMENT_NOT_FOUND',
  );
  const temporary = await store.createEnvironment(project.projectId,{name:'临时环境'});
  await store.saveQuickQuestion(project.projectId,temporary.environmentId,{text:'检查健康状态'},0);
  const file = store.quickQuestionsPath(project.projectId,temporary.environmentId);
  await fs.access(file);
  await store.deleteEnvironment(project.projectId,temporary.environmentId);
  await assert.rejects(() => fs.access(file));
});

test('global opening defaults without materialization and saves atomically with an independent revision', async (t) => {
  const {store} = await fixture(t);
  const settingsFile = store.quickQuestionSettingsPath();
  assert.deepEqual(await store.getQuickQuestionOpening(),{
    schemaVersion:1,
    revision:0,
    text:DEFAULT_QUICK_QUESTION_OPENING,
    defaultText:DEFAULT_QUICK_QUESTION_OPENING,
  });
  await assert.rejects(() => fs.access(settingsFile),'missing settings should not be materialized by a read');
  for (const [text,code] of [
    ['', 'QUICK_QUESTION_OPENING_REQUIRED'],
    ['请使用 MCP 排查。','QUICK_QUESTION_OPENING_MISSING_AI_OPS_MCP'],
    ['请使用 AI Ops MCP，secret=do-not-save','QUICK_QUESTION_OPENING_CONTAINS_CREDENTIAL'],
  ]) {
    await assert.rejects(
      () => store.saveQuickQuestionOpening(text,0),
      (error) => error.code === code && !error.message.includes('do-not-save'),
    );
  }
  await assert.rejects(
    () => store.saveQuickQuestionOpening('请使用 AI Ops MCP 排查。'),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(() => fs.access(settingsFile),'rejected saves must not create a settings file');

  const saved = await store.saveQuickQuestionOpening('请使用 ＡＩ－Ｏｐｓ ＭＣＰ 进行排查。',0);
  assert.deepEqual(saved,{
    schemaVersion:1,
    revision:1,
    text:'请使用 AI-Ops MCP 进行排查。',
    defaultText:DEFAULT_QUICK_QUESTION_OPENING,
  });
  const disk = JSON.parse(await fs.readFile(settingsFile,'utf8'));
  assert.deepEqual(
    {schemaVersion:disk.schemaVersion,revision:disk.revision,openingText:disk.openingText},
    {schemaVersion:1,revision:1,openingText:saved.text},
  );
  assert.equal(new Date(disk.updatedAt).toISOString(),disk.updatedAt);
  assert.equal((await fs.readdir(path.dirname(settingsFile))).some((name) => name.endsWith('.tmp')),false);

  const attempts = await Promise.allSettled([
    store.saveQuickQuestionOpening('请使用 AI Ops MCP 执行 A。',1),
    store.saveQuickQuestionOpening('请使用 AI Ops MCP 执行 B。',1),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length,1);
  assert.equal(attempts.filter((item) => item.status === 'rejected' && item.reason.code === 'CONFIG_REVISION_CONFLICT').length,1);
  const current = await store.getQuickQuestionOpening();
  assert.equal(current.revision,2);
  await assert.rejects(
    () => store.useQuickQuestionOpening(1,() => assert.fail('stale opening must not be used')),
    (error) => error.code === 'CONFIG_REVISION_CONFLICT',
  );
  assert.equal(
    await store.useQuickQuestionOpening(current.revision,(opening) => opening.text),
    current.text,
  );
});

test('opening upgrade preserves existing environment questions and accepts schema v1 settings without updatedAt', async (t) => {
  const {root,store,project,environment} = await fixture(t);
  const scope = [project.projectId,environment.environmentId];
  const questions = await store.saveQuickQuestion(...scope,{text:'检查订单{订单号}'},0);
  const questionsFile = store.quickQuestionsPath(...scope);
  const questionsBefore = await fs.readFile(questionsFile);
  const legacyOpening = '请使用 AI Ops MCP 排查历史环境。';
  await fs.writeFile(store.quickQuestionSettingsPath(),JSON.stringify({
    schemaVersion:1,revision:4,openingText:legacyOpening,
  }),'utf8');

  const restarted = new WorkspaceStore(root);
  await restarted.init({migrateLegacy:false});
  assert.deepEqual(await restarted.getQuickQuestionOpening(),{
    schemaVersion:1,revision:4,text:legacyOpening,defaultText:DEFAULT_QUICK_QUESTION_OPENING,
  });
  await restarted.saveQuickQuestionOpening('请使用 AI Ops MCP 排查新环境。',4);
  assert.deepEqual(await fs.readFile(questionsFile),questionsBefore);
  assert.deepEqual(await restarted.listQuickQuestions(...scope),questions);
  const migratedDisk = JSON.parse(await fs.readFile(restarted.quickQuestionSettingsPath(),'utf8'));
  assert.equal(new Date(migratedDisk.updatedAt).toISOString(),migratedDisk.updatedAt);
});

test('credential-bearing or malformed global opening settings fail closed', async (t) => {
  const {store} = await fixture(t);
  for (const document of [
    {schemaVersion:1,revision:1,openingText:'请使用 AI Ops MCP，password=settings-secret'},
    {schemaVersion:1,revision:1,openingText:'只使用 MCP'},
    {schemaVersion:1,revision:'1',openingText:DEFAULT_QUICK_QUESTION_OPENING},
  ]) {
    await fs.writeFile(store.quickQuestionSettingsPath(),JSON.stringify(document),'utf8');
    await assert.rejects(
      () => store.getQuickQuestionOpening(),
      (error) => error.code === 'QUICK_QUESTION_SETTINGS_INVALID'
        && !error.message.includes('settings-secret'),
    );
  }
});
