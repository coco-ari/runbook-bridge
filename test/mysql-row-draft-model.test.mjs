import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeMysqlDraftRows,mysqlDraftColumn,mysqlDraftPlaceholder} from '../renderer/v2/src/features/database/mysql-row-draft-model.ts';

test('复制草稿紧跟源行，新增草稿保持可见，草稿复制也不重复',()=>{
 const a={id:'a'},b={id:'b'},copy={},child={},insert={};
 const drafts=[{row:copy,rowId:'copy',afterRowId:'a'},{row:child,rowId:'child',afterRowId:'copy'},{row:insert,rowId:'insert'}];
 assert.deepEqual(mergeMysqlDraftRows([{row:a,index:0},{row:b,index:1}],drafts,row=>row.id,2).map(item=>item.row),[a,copy,child,b,insert]);
 assert.deepEqual(mergeMysqlDraftRows([{row:b,index:1}],drafts,row=>row.id,2).map(item=>item.row),[b,copy,child,insert]);
 assert.deepEqual(mergeMysqlDraftRows([],drafts,row=>row.id,2).map(item=>item.row),[copy,child,insert]);
});
test('排序后的结果位置不改变原行索引，草稿使用独立索引',()=>{
 const rows=[{row:{id:'b'},index:1},{row:{id:'a'},index:0}];
 const merged=mergeMysqlDraftRows(rows,[{row:{},rowId:'copy',afterRowId:'a'}],row=>row.id,50);
 assert.deepEqual(merged.map(item=>item.index),[1,0,50]);
});
test('投影别名按源字段映射，默认值、NULL、空字符串和自动生成不混淆',()=>{
 const edit={columns:[{name:'alias',source:'label'},{name:'key',source:'id'},{name:'when',source:'created'}],insertColumns:[{name:'label',required:true},{name:'id',autoIncrement:true},{name:'created',defaultValue:'CURRENT_TIMESTAMP'}]};
 assert.equal(mysqlDraftColumn(edit,'alias').name,'label');
 assert.equal(mysqlDraftPlaceholder({values:{}},edit,'alias'),'待填写');
 assert.equal(mysqlDraftPlaceholder({values:{label:null}},edit,'alias'),null);
 assert.equal(mysqlDraftPlaceholder({values:{label:''}},edit,'alias'),null);
 assert.equal(mysqlDraftPlaceholder({values:{}},edit,'key'),'自动生成');
 assert.equal(mysqlDraftPlaceholder({values:{}},edit,'when'),'默认：CURRENT_TIMESTAMP');
 assert.equal(mysqlDraftPlaceholder({values:{}},edit,'not_in_projection'),'未查询字段');
});
