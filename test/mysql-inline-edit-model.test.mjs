import test from 'node:test';
import assert from 'node:assert/strict';
import {bindMysqlEditRows,mysqlEditRowKey,mysqlEditValueMatches} from '../renderer/v2/src/features/database/mysql-inline-edit-model.ts';

const snapshot={columns:[{name:'tenant',primary:true},{name:'row_key',primary:true},{name:'label',primary:false}],rows:[
 {rowId:'one',values:{tenant:'2',row_key:'9007199254740993',label:'第一行'}},
 {rowId:'two',values:{tenant:'3',row_key:'9007199254740993',label:'第二行'}}
]};
test('编辑绑定完整复合主键与字段别名，不受返回顺序变化影响',()=>{
 const rows=[{tenant:3,row_key:'9007199254740993',label:'第二行'},{tenant:2,row_key:'9007199254740993',label:'第一行'}];
 const bindings=bindMysqlEditRows(rows,snapshot);
 assert.equal(bindings.get(rows[0]).rowId,'two');
 assert.equal(bindings.get(rows[1]).rowId,'one');
});
test('丢失、重复和已舍入的主键一律不能绑定',()=>{
 const rows=[{tenant:2,row_key:9007199254740993},{tenant:2},{tenant:4,row_key:'9007199254740993'},
 {tenant:3,row_key:'9007199254740993'},{tenant:3,row_key:'9007199254740993'}];
 assert.equal(bindMysqlEditRows(rows,snapshot).size,0);
 assert.equal(mysqlEditRowKey({id:null},['id']),null);
 assert.equal(mysqlEditRowKey({id:'1'},[]),null);
});
test('键值包含分隔符仍不会混淆目标',()=>{
 assert.notEqual(mysqlEditRowKey({a:'1|2',b:'3'},['a','b']),mysqlEditRowKey({a:'1',b:'2|3'},['a','b']));
});
test('字段值变化或数值已丢失精度时拒绝直接编辑',()=>{
 assert.equal(mysqlEditValueMatches('旧值','新值'),false);
 assert.equal(mysqlEditValueMatches(9007199254740993,'9007199254740993'),false);
 assert.equal(mysqlEditValueMatches(1,'1'),true);
 assert.equal(mysqlEditValueMatches('9999999999999999.1234','9999999999999999.1234'),true);
 assert.equal(mysqlEditValueMatches(null,null),true);
 assert.equal(mysqlEditValueMatches('',null),false);
});
