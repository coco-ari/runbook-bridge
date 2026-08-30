import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const importModel = () => import(pathToFileURL(path.join(
  root,'renderer','v2','src','features','quick-questions','quick-question-model.ts',
)).href);

test('React quick-question normalization is bounded and validates the shared opening',async () => {
  const model = await importModel();
  const items = Array.from({length:10},(_,index) => ({
    questionId:`question-${index}`,
    text:index === 0 ? 'x'.repeat(1_400) : `问题 ${index}`,
    createdAt:`2026-08-${String(index + 1).padStart(2,'0')}T00:00:00.000Z`,
    updatedAt:`2026-08-${String(index + 1).padStart(2,'0')}T01:00:00.000Z`,
  }));
  const normalized = model.normalizeQuickQuestionCollection({revision:4,items});
  assert.equal(normalized.items.length,model.QUICK_QUESTION_COLLECTION_LIMIT);
  assert.equal(Array.from(normalized.items[0].text).length,model.QUICK_QUESTION_MAX_CHARACTERS);
  assert.equal(normalized.revision,4);
  assert.equal(
    model.formatQuickQuestionUpdatedAt('2026-08-30T01:00:00.000Z'),
    '8月30日更新',
  );

  assert.deepEqual(model.normalizeQuickQuestionOpening({
    revision:7,
    text:'  请使用 ＡＩ－Ｏｐｓ ＭＣＰ 排查。  ',
    defaultText:'请使用 AI Ops MCP 排查。',
  }),{
    revision:7,
    text:'请使用 AI-Ops MCP 排查。',
    defaultText:'请使用 AI Ops MCP 排查。',
  });
  assert.throws(() => model.normalizeQuickQuestionOpening({
    revision:1,
    text:`AI Ops MCP ${'a'.repeat(500)}`,
    defaultText:'AI Ops MCP',
  }),/500/u);
});

test('React quick-question preview contains bounded human scope and a month-day date only',async () => {
  const model = await importModel();
  const preview = model.buildQuickQuestionPreview({
    opening:{text:'请使用 AI Ops MCP 排查。',defaultText:'请使用 AI Ops MCP 排查。',revision:2},
    projectName:'本地项目',
    environmentName:'预发布环境',
    question:'为什么任务没有完成?',
    discoveredDate:'2026-08-24',
  });
  assert.equal(preview,[
    '请使用 AI Ops MCP 排查。',
    '',
    '【当前范围】',
    '项目：本地项目',
    '环境：预发布环境',
    '问题发现时间：8月24日',
    '',
    '【问题】',
    '为什么任务没有完成?',
  ].join('\n'));
  assert.doesNotMatch(preview,/projectId|environmentId|plugin|resource|2026|时区/iu);
  assert.equal(model.formatQuickQuestionDiscoveredDate('2026-02-30'),'');
});

test('strict credential detection avoids ordinary URL and business-token false positives',async () => {
  const model = await importModel();
  for (const value of [
    '排查邀请 token=invite-example 为什么没有生效',
    '请求 https://www.example.test/api/v1 返回错误',
    '交易标识 0x1234567890abcdef',
  ]) assert.equal(model.quickQuestionHasStrictCredential(value),false,value);

  assert.equal(model.quickQuestionHasStrictCredential(
    'password=example-value',
  ),true);
  const collection = model.normalizeQuickQuestionCollection({
    items:[{
      questionId:'question-a',text:'password=example-value',
      createdAt:'2026-08-30T00:00:00.000Z',updatedAt:'2026-08-30T01:00:00.000Z',
    }],
  });
  assert.match(collection.items[0].text,/\[已脱敏\]/u);
  assert.doesNotMatch(collection.items[0].text,/example-value/u);

  const generatedCredentialShapes = [
    'Authorization: Bearer ' + 'x'.repeat(12),
    'sk-' + 'x'.repeat(16),
    'eyJ' + 'a'.repeat(8) + '.' + 'b'.repeat(8) + '.' + 'c'.repeat(8),
  ];
  for (const value of generatedCredentialShapes) {
    assert.equal(model.quickQuestionHasStrictCredential(value),true);
    const redacted = model.redactQuickQuestionPreview(value);
    assert.match(redacted,/\[已脱敏\]/u);
    assert.equal(redacted.includes(value),false);
  }
});

test('React quick questions feature keeps explicit CRUD, conflict, and component contracts',async () => {
  const [source,model] = await Promise.all([
    fs.readFile(path.join(
      root,'renderer','v2','src','features','quick-questions','QuickQuestionsFeature.tsx',
    ),'utf8'),
    fs.readFile(path.join(
      root,'renderer','v2','src','features','quick-questions','quick-question-model.ts',
    ),'utf8'),
  ]);
  const all = `${source}\n${model}`;

  assert.match(source,/readonly projectId: string/u);
  assert.match(source,/readonly environmentId: string/u);
  for (const method of [
    'getQuickQuestionOpening','saveQuickQuestionOpening','listQuickQuestions',
    'saveQuickQuestion','deleteQuickQuestion','copyQuickQuestion',
  ]) assert.match(source,new RegExp(`getAiOpsV2\\(\\).*${method}|getAiOpsV2\\(\\)\\.${method}|api\\.${method}`,'su'));
  assert.match(source,/normalizeQuickQuestionCollection as normalizeCollection/u);
  assert.match(source,/formatQuickQuestionUpdatedAt/u);
  assert.doesNotMatch(source,/as unknown as IpcResult<unknown>|修订 \{item\.revision\}/u);
  assert.match(source,/buildQuickQuestionPreview/u);
  assert.match(model,/QUICK_QUESTION_OPENING_MAX_CHARACTERS = 500/u);
  assert.match(model,/QUICK_QUESTION_MAX_CHARACTERS = 1_200/u);
  assert.match(model,/QUICK_QUESTION_COLLECTION_LIMIT = 8/u);
  assert.match(source,/@\/components\/ui\/calendar/u);
  assert.match(source,/@\/components\/ui\/popover/u);
  assert.match(source,/<Calendar/u);
  assert.match(source,/<Popover/u);
  assert.doesNotMatch(source,/type="date"/u);
  assert.match(source,/CONFIG_REVISION_CONFLICT/u);
  assert.match(source,/return api\.onWorkspaceChanged/u);
  assert.doesNotMatch(source,/<Dialog\b|<DialogClose\b|@\/components\/ui\/dialog/u);
  assert.match(source,/data-testid="quick-opening-inline-editor"/u);
  assert.match(source,/data-testid="common-question-inline-editor"/u);
  assert.match(source,/<AlertDialog/u);
  assert.match(source,/@\/components\/ui\/alert/u);
  assert.match(source,/@\/components\/ui\/empty/u);
  assert.match(source,/@\/components\/ui\/item/u);
  assert.match(source,/@\/components\/ui\/button-group/u);
  assert.match(source,/@\/components\/ui\/card/u);
  assert.match(source,/<ItemGroup/u);
  assert.match(source,/<ItemActions asChild>/u);
  assert.match(source,/<Tooltip/u);
  assert.match(source,/<ButtonGroup/u);
  assert.match(source,/<Empty/u);
  assert.match(source,/<Alert/u);
  assert.match(source,/<Field/u);
  assert.match(source,/<Textarea/u);
  assert.doesNotMatch(source,/divide-y|<section[^>]+className="border-[tb]/u);
  assert.doesNotMatch(source,/title=\{item\.text\}/u);
  assert.doesNotMatch(source,/<TooltipContent[^>]*>\s*\{item\.text\}/u);
  assert.match(source,/deleteTriggerRef\.current = event\.currentTarget/u);
  assert.match(source,/if \(!focusWorkspaceElement\(trigger\)\)/u);
  assert.doesNotMatch(all,/dangerouslySetInnerHTML|console\.(?:log|debug|info|warn|error)/u);
});

test('inline quick-question editors keep one draft owner and report dirty and saving state', async () => {
  const source = await fs.readFile(path.join(
    root,'renderer','v2','src','features','quick-questions','QuickQuestionsFeature.tsx',
  ),'utf8');
  assert.match(source,/readonly onDirtyChange: \(dirty: boolean\) => void/u);
  assert.match(source,/readonly onSavingChange: \(saving: boolean\) => void/u);
  assert.match(source,/useState<"opening" \| "question" \| null>\(null\)/u);
  assert.doesNotMatch(source,/openingDialog|questionDialog/u);
  assert.match(source,/onDirtyChange\(editorDirty\)/u);
  assert.match(source,/onSavingChange\(busy !== null\)/u);
  assert.match(source,/useDirtyLeaveGuard\(/u);
  assert.match(source,/quickQuestionsDirty: editorDirty/u);
  assert.match(source,/saveInFlight: busy !== null/u);
  assert.match(source,/pendingEditorTransitionRef/u);
  assert.match(source,/editorLeave\.requestLeave\(\)/u);
  assert.match(source,/requestEditorTransition\(closeEditor\)/u);
  assert.match(source,/<DirtyLeaveAlertDialog controller=\{editorLeave\}/u);
  assert.match(source,/focusWorkspaceElement\(input\)/u);
  assert.match(source,/editorTransitionPendingRef\.current = true/u);
  assert.match(source,/editorTransitionPendingRef\.current = false/u);
  assert.match(source,/onCloseAutoFocus=\{\(event\) => \{/u);
  assert.match(source,/requestAnimationFrame\(restoreEditorFocus\)/u);
  assert.match(source,/editorTriggerRef\.current\?\.isConnected/u);
});

test('inline editor conflicts preserve drafts and require an explicit revision adoption', async () => {
  const source = await fs.readFile(path.join(
    root,'renderer','v2','src','features','quick-questions','QuickQuestionsFeature.tsx',
  ),'utf8');
  assert.match(source,/expectedRevision: openingEditorRevision/u);
  assert.match(source,/expectedRevision: questionEditorRevision/u);
  assert.match(source,/openingDraft !== openingBaseline/u);
  assert.match(source,/questionDraft !== questionBaseline/u);
  assert.match(source,/opening\?\.revision !== openingEditorRevision/u);
  assert.match(source,/collection\.revision !== questionEditorRevision/u);
  assert.match(source,/采用最新修订，保留草稿/u);
  assert.match(source,/原问题已被移除。草稿仍保留/u);
  // Windows checkouts may use CRLF; a missing boundary must never silently
  // turn this assertion into a slice containing unrelated editor callbacks.
  for (const newline of ['\n','\r\n']) {
    const checkout = source.replace(/\r?\n/gu,newline);
    const start = checkout.indexOf('const loadOpening =');
    const end = checkout.search(/useEffect\(\(\) => \{\r?\n    scopeEpochRef/u);
    assert.ok(start >= 0 && end > start,'both loader boundaries must exist in order');
    const loaders = checkout.slice(start,end);
    assert.doesNotMatch(loaders,/setOpeningDraft|setQuestionDraft|setEditingQuestionId/u);
  }
  for (const name of ['openingReadError','questionsReadError','copyError','openingError','questionError','deleteError']) {
    assert.match(source,new RegExp(`const \\[${name},`,'u'));
  }
  assert.match(source,/if \(epoch !== scopeEpochRef\.current\) return/u);
  assert.match(source,/if \(!open && busy !== "delete" && !deleteInFlightRef\.current\)/u);
  assert.match(source,/onEscapeKeyDown=\{\(event\) => \{ if \(busy === "delete" \|\| deleteInFlightRef\.current\) event\.preventDefault\(\)/u);
  assert.match(source,/event\.preventDefault\(\)\s+void deleteQuestion\(\)/u);
});
