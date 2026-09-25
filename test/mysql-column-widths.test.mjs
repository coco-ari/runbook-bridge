import test from 'node:test';
import assert from 'node:assert/strict';
import {autoMysqlColumnWidths,clampMysqlColumnWidth,mysqlColumnSignature,readMysqlColumnWidths} from '../renderer/v2/src/features/database/mysql-column-widths.ts';
const columns=[{name:'id',table:'orders',type:8},{name:'customer_name',table:'orders',type:253},{name:'note',table:'orders',type:253}];
test('短主键紧凑、中文和长整数按内容拓宽，长文本默认有上限',()=>{
 const short=autoMysqlColumnWidths(columns,[{id:1,customer_name:'测试客户',note:'x'.repeat(10000)}]);
 assert.equal(short[0],72);assert.ok(short[1]>short[0]);assert.equal(short[2],280);
 const large=autoMysqlColumnWidths(columns,[{id:'9007199254740993',customer_name:'测试客户',note:null}]);
 assert.ok(large[0]>=132);assert.ok(large[2]>=72);
 assert.equal(autoMysqlColumnWidths(columns,[{note:'x'.repeat(10000)}],undefined,640)[2],640);
});
test('空表和空值可用，宽度测量限于前一百行及文本前缀',()=>{
 assert.equal(autoMysqlColumnWidths(columns,[]).length,3);
 const rows=Array.from({length:100},()=>({id:1,note:''}));
 const initial=autoMysqlColumnWidths(columns,rows);
 assert.deepEqual(autoMysqlColumnWidths(columns,[...rows,{id:'x'.repeat(10000)}]),initial);
 let largest=0;
 autoMysqlColumnWidths(columns,[{note:'x'.repeat(100000)}],text=>{largest=Math.max(largest,text.length);return text.length*7;});
 assert.ok(largest<=512);
});
test('列身份区分投影、字段顺序、来源和类型，拒绝损坏或越界的持久化配置',()=>{
 for(const changed of [[...columns].reverse(),columns.map(c=>({...c,table:'other'})),columns.map(c=>({...c,type:3}))]) assert.notEqual(mysqlColumnSignature(columns),mysqlColumnSignature(changed));
 assert.deepEqual(readMysqlColumnWidths('[72,180,280]',3),[72,180,280]);
 for(const raw of ['null','{}','[72]','[0,180,280]','[72,"180",280]','[72,180,999999]','broken']) assert.equal(readMysqlColumnWidths(raw,3),null);
 assert.equal(clampMysqlColumnWidth(-100),72);assert.equal(clampMysqlColumnWidth(5000),1200);
});
