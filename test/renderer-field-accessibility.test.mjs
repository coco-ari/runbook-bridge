import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname,'..');
const read = (relativePath) => fs.readFileSync(path.join(root,relativePath),'utf8');

const sources = {
  environment:read('renderer/v2/src/features/environments/EnvironmentMutationSurfaces.tsx'),
  pluginMetadata:read('renderer/v2/src/features/plugins/PluginMetadataDialog.tsx'),
  project:read('renderer/v2/src/features/projects/ProjectMutationSurfaces.tsx'),
  quickQuestions:read('renderer/v2/src/features/quick-questions/QuickQuestionsFeature.tsx'),
};

function assertRelationship(source,id) {
  assert.match(
    source,
    new RegExp(`<(?:FieldDescription|FieldError|MutationError)[^>]*\\bid="${id}"`,'u'),
    `${id} must identify its description or error node`,
  );
  assert.match(
    source,
    new RegExp(`aria-(?:describedby|errormessage)=[\\s\\S]{0,320}${id}`,'u'),
    `${id} must be referenced by the owning control or form-level group`,
  );
}

test('project and environment mutation fields expose stable description and error relationships', () => {
  for (const id of [
    'create-project-error',
    'project-settings-name-description',
    'project-settings-name-error',
    'delete-project-confirmation-error',
    'delete-project-mutation-error',
  ]) assertRelationship(sources.project,id);

  for (const id of [
    'new-environment-name-description',
    'new-environment-name-error',
    'environment-settings-name-description',
    'environment-settings-name-error',
    'delete-environment-error',
  ]) assertRelationship(sources.environment,id);

  assert.match(sources.environment,/aria-label="删除环境范围"[\s\S]{0,80}role="group"/u);
});

test('plugin metadata and quick-question editors expose stable description and error relationships', () => {
  for (const id of [
    'plugin-metadata-name-description',
    'plugin-metadata-name-error',
  ]) assertRelationship(sources.pluginMetadata,id);

  for (const id of [
    'quick-question-input-description',
    'quick-question-date-description',
    'quick-opening-editor-description',
    'quick-opening-editor-error',
    'common-question-editor-description',
    'common-question-editor-error',
  ]) assertRelationship(sources.quickQuestions,id);

  for (const source of Object.values(sources)) {
    assert.doesNotMatch(source,/<FieldDescription(?![^>]*\bid=)[^>]*>/u);
    assert.doesNotMatch(source,/<FieldError(?![^>]*\bid=)[^>]*>/u);
  }
});
