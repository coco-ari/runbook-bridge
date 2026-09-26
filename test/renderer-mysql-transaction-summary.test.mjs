import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mysqlTransactionTiming,
  mysqlTransactionDuration,
  mysqlTransactionEntryLabel,
  withMysqlTransactionSummary,
  mysqlTransactionSummaryText,
} from '../renderer/v2/src/features/database/mysql-transaction-summary-model.ts';

const summary = {
  id:'fixture-transaction',startedAt:1_999_999_900_000,serverNow:2_000_000_000_000,
  idleTimeoutMs:300_000,idleExpiresAt:2_000_000_300_000,
  statementCount:2,writeCount:1,affectedRows:3,omittedCount:0,
  entries:[{sequence:1,kind:'select',tables:['fixture_items'],executedAt:1_999_999_910_000},{sequence:2,kind:'update',tables:['fixture_items'],affectedRows:3,executedAt:1_999_999_930_000}],
};

test('事务时间按主进程快照和单调时钟推进，不依赖本机日期', () => {
  const result=mysqlTransactionTiming(summary,500,1500,'active');
  assert.equal(result.elapsedMs,101_000);
  assert.equal(result.remainingMs,299_000);
  assert.equal(result.idleState,'normal');
  assert.equal(mysqlTransactionTiming(summary,1500,500,'active').remainingMs,300_000,'单调时钟锚点之后再开始计时');
  assert.equal(mysqlTransactionDuration(result.elapsedMs),'1 分 41 秒');
});

test('少于一分钟逐渐提示，到期只确认服务端状态而不宣称回滚', () => {
  const soon={...summary,idleExpiresAt:summary.serverNow+45_000};
  assert.equal(mysqlTransactionTiming(soon,500,1500,'active').idleState,'soon');
  assert.equal(mysqlTransactionTiming({...soon,idleExpiresAt:summary.serverNow+60_000},500,500,'active').idleState,'normal');
  const expired=mysqlTransactionTiming(soon,500,46_000,'active');
  assert.equal(expired.remainingMs,0);
  assert.equal(expired.idleState,'confirming');
  assert.equal(mysqlTransactionDuration(1,true),'1 秒','剩余不足一秒不得提前显示0秒');
});

test('执行中与结果未知都不显示空闲回滚倒计时', () => {
  const busy=mysqlTransactionTiming({...summary,idleExpiresAt:null},0,700_000,'active');
  assert.equal(busy.idleState,'paused');
  assert.equal(busy.remainingMs,null);
  const unknown=mysqlTransactionTiming(summary,0,700_000,'unknown');
  assert.equal(unknown.idleState,'unknown');
  assert.equal(unknown.remainingMs,null);
});

test('摘要更新保留结果和计划引用，累计数来自本次事务而非最后一次执行', () => {
  const state={documentId:'fixture-document',mode:'manual',transaction:'active',status:'success',results:[{index:1,kind:'select',data:{rows:[{id:1}]}}],plan:{planId:'fixture-plan'},transactionSummary:summary};
  const next={...summary,serverNow:summary.serverNow+2500,statementCount:3,writeCount:2,affectedRows:6,entries:[...summary.entries,{sequence:3,kind:'update',tables:['fixture_items'],affectedRows:3,executedAt:summary.serverNow}]};
  const merged=withMysqlTransactionSummary(state,next);
  assert.equal(merged.results,state.results);
  assert.equal(merged.plan,state.plan);
  assert.equal(merged.transactionSummary,next);
  assert.equal(merged.transactionSummary.affectedRows,6,'同一行再次更新按行次累计，不当作独立行数');
  assert.equal(merged.transactionSummary.entries.length,3);
  assert.equal(withMysqlTransactionSummary(state,undefined).transactionSummary,undefined);
  assert.equal(state.transactionSummary,summary,'轮询不修改之前的快照');
});

test('摘要格式仅使用操作类型和表名，忽略SQL正文及额外字段并说明表列表截断', () => {
  const entry={sequence:1,kind:'update',tables:['fixture_a','fixture_b'],tableCount:25,affectedRows:3,executedAt:1,sql:'UPDATE fixture SET private_value = secret_marker',values:['secret_marker']};
  const label=mysqlTransactionEntryLabel(entry);
  assert.deepEqual(label,{kind:'UPDATE',tables:'fixture_a、fixture_b 等 25 张表'});
  assert.doesNotMatch(JSON.stringify(label),/secret_marker|private_value/);
  assert.equal(mysqlTransactionEntryLabel({...entry,kind:'unexpected_secret_marker'}).kind,'SQL');
  assert.equal(mysqlTransactionEntryLabel({...entry,tableCount:2}).tables,'fixture_a、fixture_b');
});

test('首条写入未返回时不把零计数误述为没有写入，未知与执行中保守说明', () => {
  const empty={...summary,statementCount:0,writeCount:0,affectedRows:0,entries:[]};
  const unknown=mysqlTransactionSummaryText(empty,'unknown');
  assert.match(unknown.counts,/暂无已确认写入/);
  assert.match(unknown.description,/不含尚未应答/);
  assert.match(unknown.empty,/实际结果待核实/);
  assert.doesNotMatch(JSON.stringify(unknown),/未发生写入|尚未执行|没有待提交的数据更改/);
  const busy=mysqlTransactionSummaryText(empty,'active',true);
  assert.match(busy.counts,/等待执行结果/);
  assert.doesNotMatch(JSON.stringify(busy),/未发生写入|尚未执行|没有待提交的数据更改/);
  const completedRead=mysqlTransactionSummaryText({...empty,statementCount:2},'active',false);
  assert.match(completedRead.counts,/未发生写入.*2 条查询/);
  const knownWrites=mysqlTransactionSummaryText(summary,'unknown');
  assert.match(knownWrites.counts,/已返回 1 条写入/);
  assert.match(knownWrites.description,/实际写入与最终提交结果仍需核实/);
});
