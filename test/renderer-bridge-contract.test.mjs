import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const EXPECTED_API_NAMES = [
  'listProjects',
  'workspaceOverview',
  'createProject',
  'updateProject',
  'deleteProject',
  'listEnvironments',
  'getQuickQuestionOpening',
  'saveQuickQuestionOpening',
  'listQuickQuestions',
  'saveQuickQuestion',
  'deleteQuickQuestion',
  'copyQuickQuestion',
  'createEnvironment',
  'updateEnvironment',
  'deleteEnvironment',
  'reorderEnvironments',
  'requestConnectionIntent',
  'confirmConnectionChallenge',
  'connectEnvironment',
  'retryEnvironment',
  'disconnectEnvironment',
  'cancelEnvironment',
  'environmentStatus',
  'connectPlugin',
  'disconnectPlugin',
  'readRunbook',
  'saveRunbook',
  'listPlugins',
  'assessPlugin',
  'createPlugin',
  'updatePlugin',
  'updatePluginMetadata',
  'updatePluginAgentConfiguration',
  'updatePluginConnection',
  'preparePluginConnectionEdit',
  'beginPluginConnectionEdit',
  'validatePluginDraft',
  'cancelPluginValidation',
  'probePluginDraft',
  'cancelPluginProbe',
  'savePluginConnectionEdit',
  'cancelPluginConnectionEdit',
  'onPluginValidationProgress',
  'onPluginProbeProgress',
  'deletePlugin',
  'credentialStatus',
  'confirmCredentialMigration',
  'revealCredential',
  'listPluginDatabases',
  'listAudit',
  'clearAudit',
  'listConfirmations',
  'approveConfirmation',
  'rejectConfirmation',
  'onEnvironmentStatus',
  'onWorkspaceChanged',
  'onConfirmations',
  'notifyNetworkChanged',
];

function sorted(values) {
  return [...values].sort((left,right) => left.localeCompare(right,'en'));
}

function preloadApiNames(source) {
  const match = source.match(/v2:\s*\{\r?\n([\s\S]*?)\r?\n {2}\},\r?\n\}\);/u);
  assert.ok(match, 'preload must expose one v2 object');
  return [...match[1].matchAll(/^ {4}([A-Za-z][A-Za-z0-9_]*)(?=:|,)/gmu)]
    .map((entry) => entry[1]);
}

function interfaceApiNames(source) {
  const match = source.match(/export interface AiOpsV2Api \{\r?\n([\s\S]*?)\r?\n\}/u);
  assert.ok(match, 'bridge must export AiOpsV2Api');
  return [...match[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*)\(/gmu)]
    .map((entry) => entry[1]);
}

function runtimeApiNames(source) {
  const match = source.match(/export const AI_OPS_V2_API_NAMES = \[([\s\S]*?)\] as const/u);
  assert.ok(match, 'bridge must export its runtime contract names');
  return [...match[1].matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/gu)]
    .map((entry) => entry[1]);
}

test('React bridge freezes all 58 preload API names and strict signatures', async () => {
  const [preload,bridge,globalTypes] = await Promise.all([
    fs.readFile('src/preload.cjs','utf8'),
    fs.readFile('renderer/v2/src/bridge/ai-ops-v2.ts','utf8'),
    fs.readFile('renderer/v2/src/types/global.d.ts','utf8'),
  ]);

  assert.equal(EXPECTED_API_NAMES.length,58);
  assert.deepEqual(sorted(preloadApiNames(preload)),sorted(EXPECTED_API_NAMES));
  assert.deepEqual(sorted(interfaceApiNames(bridge)),sorted(EXPECTED_API_NAMES));
  assert.deepEqual(sorted(runtimeApiNames(bridge)),sorted(EXPECTED_API_NAMES));
  assert.doesNotMatch(bridge,/\bany\b/u);
  assert.doesNotMatch(globalTypes,/\bany\b/u);
  assert.match(bridge,/export type IpcResult<T>/u);
  assert.match(bridge,/readonly ok: false; readonly error: PublicError/u);
  assert.match(bridge,/notifyNetworkChanged\(\): void/u);
  assert.match(bridge,/listQuickQuestions\(payload: EnvironmentScope\): Promise<IpcResult<QuickQuestionCollectionRecord>>/u);
  assert.match(bridge,/deleteQuickQuestion\(payload: QuickQuestionDeletePayload\): Promise<IpcResult<QuickQuestionCollectionRecord>>/u);
  assert.match(bridge,/readonly createdAt: string[\s\S]*readonly updatedAt: string/u);
  assert.match(bridge,/saveRunbook\(payload: RunbookSavePayload\): Promise<IpcResult<RunbookSaveRecord>>/u);
  assert.match(bridge,/listAudit\(payload: AuditListPayload\): Promise<IpcResult<AuditPage>>/u);
  assert.match(bridge,/export interface AuditPage extends OpaqueData \{\s*readonly entries: readonly AuditRecord\[\]\s*readonly nextCursor: string \| null\s*\}/u);
  assert.match(bridge,/readonly bytes: number[\s\S]*readonly hash: string[\s\S]*readonly empty: boolean/u);
  assert.match(globalTypes,/readonly v2\?: AiOpsV2Api/u);
  assert.match(bridge,/const candidate = window\.aiOps\?\.v2/u);
  assert.doesNotMatch(bridge,/invoke\(|ipcRenderer|contextBridge/u);
});
