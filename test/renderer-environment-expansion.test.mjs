import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {reconcileEnvironmentExpansion} from '../renderer/v2/src/components/resource-pane/environment-expansion.ts';

const target = (environmentId = 'production',pluginInstanceId = null,projectId = 'project-a') => ({
  projectId,environmentId,pluginInstanceId,
});
const environmentIds = ['production','staging'];

test('manual environment closure survives repeated summaries, runtime updates and viewing the same environment details',() => {
  const selected = target('production','server-one');
  const manuallyClosed = [];
  for (let refresh = 0; refresh < 3; refresh += 1) {
    assert.equal(reconcileEnvironmentExpansion(manuallyClosed,[...environmentIds],{...selected},selected),
      manuallyClosed,'new summary objects are not new navigation intent');
  }
  assert.equal(reconcileEnvironmentExpansion(manuallyClosed,environmentIds,target('production'),selected),
    manuallyClosed,'viewing the same environment details must not undo a closed accordion');

  const projectOverview = target(null);
  assert.equal(reconcileEnvironmentExpansion(manuallyClosed,environmentIds,projectOverview,projectOverview),
    manuallyClosed,'refreshes do not reopen the first environment while viewing the project');
});

test('navigation to another environment or a newly selected plugin reveals the destination once',() => {
  const opened = reconcileEnvironmentExpansion(['production'],environmentIds,target('staging'),target('production'));
  assert.deepEqual(opened,['production','staging']);
  assert.deepEqual(reconcileEnvironmentExpansion([],environmentIds,target('staging','database-one'),target('staging')),
    ['staging'],'external plugin navigation reveals an environment that the user closed');
  assert.deepEqual(reconcileEnvironmentExpansion([],environmentIds,target('staging','database-two'),target('staging','database-one')),
    ['staging'],'switching plugins also reveals their closed parent environment');
  const manuallyClosedAgain = [];
  assert.equal(reconcileEnvironmentExpansion(manuallyClosedAgain,environmentIds,target('staging','database-two'),target('staging','database-two')),
    manuallyClosedAgain,'subsequent refreshes do not continuously enforce visibility');
});

test('project switches reset expansion and stale or out-of-scope environment ids are never retained or revealed',() => {
  assert.deepEqual(reconcileEnvironmentExpansion(['production','staging'],['testing','production'],target(null,null,'project-b'),target()),
    ['testing'],'a new project starts from its own first environment');
  assert.deepEqual(reconcileEnvironmentExpansion(['production','staging'],['testing','production'],target('production',null,'project-b'),target()),
    ['production'],'an explicit destination takes precedence over the new project default');
  assert.deepEqual(reconcileEnvironmentExpansion(['production','staging'],['staging'],target('production','server-one'),target()),
    ['staging'],'deleted selected environments are pruned, never added back');
  assert.deepEqual(reconcileEnvironmentExpansion([],environmentIds,target('foreign','server-one'),target()),[],
    'navigation cannot reveal an environment outside the current project list');
  assert.deepEqual(reconcileEnvironmentExpansion(['production'],[],target(null,null,null),target()),[]);
});

test('environment ordering updates preserve explicit open and closed choices without redundant state updates',() => {
  const current = ['staging','production'];
  const selected = target('production');
  assert.equal(reconcileEnvironmentExpansion(current,['staging','production'],selected,selected),current);
  assert.deepEqual(reconcileEnvironmentExpansion(current,['staging'],target(null),selected),['staging']);
  assert.deepEqual(reconcileEnvironmentExpansion([],environmentIds,target('staging'),null),['staging']);
});

test('asynchronously available environments initialize once without reopening subsequent manual closures',() => {
  const projectOverview = target(null);
  const beforeEnvironments = reconcileEnvironmentExpansion([],[],projectOverview,null,[]);
  assert.deepEqual(beforeEnvironments,[]);
  assert.deepEqual(reconcileEnvironmentExpansion(beforeEnvironments,environmentIds,projectOverview,projectOverview,[]),
    ['production'],'the first list can arrive after the project identity is already known');
  const manuallyClosed = [];
  assert.equal(reconcileEnvironmentExpansion(manuallyClosed,[...environmentIds],projectOverview,projectOverview,environmentIds),
    manuallyClosed,'availability initialization is not repeated for fresh summary objects');

  const selectedBeforeLoad = target('staging','database-one');
  assert.deepEqual(reconcileEnvironmentExpansion([],environmentIds,selectedBeforeLoad,selectedBeforeLoad,[]),
    ['staging'],'an explicit selected destination takes precedence when its first list arrives');
  assert.deepEqual(reconcileEnvironmentExpansion(['production'],environmentIds,selectedBeforeLoad,selectedBeforeLoad,['production']),
    ['production','staging'],'a previously missing selected environment is revealed when it becomes available');
  assert.equal(reconcileEnvironmentExpansion(manuallyClosed,environmentIds,selectedBeforeLoad,selectedBeforeLoad,environmentIds),
    manuallyClosed,'later updates leave that same selected environment closed when the user closes it');
});

test('environment headings toggle natively and select environment details when a plugin or another scope is selected',async () => {
  const source = await fs.readFile('renderer/v2/src/components/resource-pane/ResourcePane.tsx','utf8');
  const heading = source.slice(source.indexOf('<AccordionTrigger'),source.indexOf('</AccordionTrigger>'));
  assert.match(heading,/if \(!environmentSelected\) onSelectEnvironment\(\)/u);
  assert.doesNotMatch(heading,/preventDefault\(/u,
    'native Accordion activation still owns each mouse and keyboard toggle');
  assert.equal((heading.match(/onSelectEnvironment\(\)/gu) ?? []).length,1,
    'a title selects its environment details without repeating navigation for the already selected environment');
  assert.match(source,/const environmentSelected =\s*selectedEnvironmentId === environment\.environmentId && selectedPluginId === null/u,
    'a selected child plugin must not be mistaken for the environment detail itself');
  assert.match(source,/onValueChange=\{setExpandedEnvironmentIds\}/u);
  assert.match(source,/reconcileEnvironmentExpansion\(/u);
  assert.match(source,/selectedEnvironmentId, selectedPluginId\]\)/u);
});
