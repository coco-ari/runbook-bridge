import test from 'node:test';
import assert from 'node:assert/strict';
import {changedCloudRows,changeSummary,initialCloudChoices} from '../renderer/v2/src/features/cloud-config/cloud-diff-presentation.ts';
const diff = {added:0,modified:0,removed:0,environmentsAdded:0,environmentsRemoved:0,credentialsChanged:false,contentChanged:false};
test('同步有本地冲突时默认保留，用户必须明确选择覆盖', () => {
  assert.deepEqual(initialCloudChoices([
    {rowId:'unchanged',diff,conflict:false},
    {rowId:'remote',diff:{...diff,contentChanged:true},conflict:false},
    {rowId:'conflict',diff:{...diff,contentChanged:true},conflict:true},
  ]), {unchanged:'local',remote:'cloud',conflict:'local'});
});
test('差异确认仅选择实际变化的项目，凭据和说明变更不被遗漏',() => {
  const rows = [{rowId:'unchanged',diff},{rowId:'secret',diff:{...diff,contentChanged:true,credentialsChanged:true}},{rowId:'runbook',diff:{...diff,contentChanged:true,runbooksChanged:1}}];
  assert.deepEqual(changedCloudRows(rows).map(row=>row.rowId),['secret','runbook']);
  assert.equal(changeSummary(rows[1].diff),'凭据变更');
  assert.equal(changeSummary(rows[2].diff),'1 份运维说明变更');
  assert.equal(changeSummary(diff),'无变化');
  assert.equal(changeSummary({...diff,contentChanged:true,modified:2}),'修改 2 个插件');
});
