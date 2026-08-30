import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const importModel = () => import(pathToFileURL(path.join(
  root,'renderer','v2','src','features','runbooks','runbook-model.ts',
)).href);

test('a late Runbook read updates the baseline but never overwrites an edited draft',async () => {
  const model = await importModel();
  const scopeKey = model.runbookScopeKey('project','environment');
  const token = model.beginRunbookRead(scopeKey,3,4);
  const edited = {
    scopeKey,
    epoch:3,
    draftGeneration:5,
    content:'older baseline',
    draft:'local edited draft',
    revision:7,
  };
  const applied = model.applyRunbookRead(edited,token,{
    content:'latest baseline',
    revision:8,
  });
  assert.deepEqual(applied,{
    ...edited,
    content:'latest baseline',
    draft:'local edited draft',
    revision:8,
  });
});

test('Runbook revision-conflict refresh preserves the draft and stale scope is ignored',async () => {
  const model = await importModel();
  const scopeKey = model.runbookScopeKey('project','environment');
  const current = {
    scopeKey,
    epoch:4,
    draftGeneration:9,
    content:'older baseline',
    draft:'draft kept after conflict',
    revision:10,
  };
  const conflictToken = model.beginRunbookRead(scopeKey,4,9);
  assert.equal(model.decideRunbookRead(conflictToken,current,true).replaceDraft,false);
  assert.equal(model.applyRunbookRead(current,conflictToken,{
    content:'latest baseline',
    revision:11,
  },true).draft,'draft kept after conflict');

  const staleToken = model.beginRunbookRead(
    model.runbookScopeKey('project','other-environment'),
    3,
    9,
  );
  assert.equal(model.applyRunbookRead(current,staleToken,{
    content:'wrong scope',
    revision:99,
  }),current);
});

test('an unedited current Runbook read may replace both baseline and draft',async () => {
  const model = await importModel();
  const scopeKey = model.runbookScopeKey('project','environment');
  const current = {
    scopeKey,
    epoch:1,
    draftGeneration:2,
    content:'old',
    draft:'old',
    revision:1,
  };
  assert.deepEqual(model.applyRunbookRead(
    current,
    model.beginRunbookRead(scopeKey,1,2),
    {content:'new',revision:2},
  ),{
    ...current,
    content:'new',
    draft:'new',
    revision:2,
    draftGeneration:3,
  });
  assert.equal(model.runbookByteLength('运维'),6);
});

test('React Runbook feature preserves scoped, revision-bound and size-bounded editing',async () => {
  const [source,model] = await Promise.all([
    fs.readFile(path.join(
      root,'renderer','v2','src','features','runbooks','RunbookFeature.tsx',
    ),'utf8'),
    fs.readFile(path.join(
      root,'renderer','v2','src','features','runbooks','runbook-model.ts',
    ),'utf8'),
  ]);
  const all = `${source}\n${model}`;

  assert.match(source,/readonly projectId: string/u);
  assert.match(source,/readonly environmentId: string/u);
  assert.match(source,/readonly environmentRevision: number/u);
  assert.match(source,/getAiOpsV2\(\)\.saveRunbook/u);
  assert.match(source,/api\.readRunbook\(\{ projectId, environmentId \}\)/u);
  assert.doesNotMatch(source,/as unknown as IpcResult<unknown>/u);
  assert.match(source,/expectedRevision: revision/u);
  assert.match(source,/CONFIG_REVISION_CONFLICT/u);
  assert.match(source,/readLatest\(epoch, true\)/u);
  assert.match(source,/beginRunbookRead/u);
  assert.match(source,/decideRunbookRead/u);
  assert.match(source,/draftGenerationRef\.current \+= 1/u);
  assert.match(model,/new TextEncoder\(\)\.encode\(value\)\.byteLength/u);
  assert.match(model,/RUNBOOK_MAX_BYTES = 65_536/u);
  assert.match(source,/onDirtyChange\?\.\(dirty\)/u);
  assert.match(source,/<Textarea/u);
  assert.match(source,/<pre/u);
  assert.doesNotMatch(all,/dangerouslySetInnerHTML|console\.(?:log|debug|info|warn|error)/u);
});
