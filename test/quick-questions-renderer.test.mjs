import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUICK_QUESTION_OPENING_MAX_LENGTH,
  buildQuickQuestionPreview,
  formatQuickQuestionDiscoveredDate,
  normalizeQuickQuestionOpening,
  normalizeQuickQuestionResponse,
  quickQuestionHasStrictCredential,
  quickQuestionOpeningIssue,
} from '../renderer/v2/quick-questions.js';
import { normalizeQuickQuestionOpening as normalizeBackendQuickQuestionOpening } from '../src/quick-questions.mjs';

const ACCEPTED_OPENING_MARKERS = [
  '请使用 AI Ops MCP 排查当前问题。',
  '请使用 AI-Ops MCP 排查当前问题。',
  'please use ai - ops mcp for diagnosis',
  '请使用 ＡＩ－Ｏｐｓ ＭＣＰ 排查当前问题。',
];

const REJECTED_OPENING_MARKERS = [
  '请使用 AI Ops-MCP 排查当前问题。',
  '请使用 AI-Ops-MCP 排查当前问题。',
  '请使用 AI--Ops MCP 排查当前问题。',
  '请使用 AI MCP 排查当前问题。',
  '请使用 XAI Ops MCP 排查当前问题。',
  '请使用 AI Ops MCPX 排查当前问题。',
];

test('renderer normalizes bounded environment common questions', () => {
  assert.deepEqual(normalizeQuickQuestionResponse({
    revision:4,
    items:[
      {questionId:'question-a',text:'  排查订单  ',createdAt:'2026-08-24T00:00:00.000Z'},
      {questionId:'',text:'忽略无效项'},
    ],
  }),{
    revision:4,
    items:[{questionId:'question-a',text:'排查订单',createdAt:'2026-08-24T00:00:00.000Z'}],
  });
});

test('renderer opening validation accepts AI Ops spelling variants and backend default', () => {
  for (const value of ACCEPTED_OPENING_MARKERS) assert.equal(quickQuestionOpeningIssue(value),null,value);

  assert.match(quickQuestionOpeningIssue('请排查当前问题。'),/AI Ops MCP/u);
  assert.match(quickQuestionOpeningIssue(''),/不能为空/u);
  assert.match(quickQuestionOpeningIssue(`AI Ops MCP ${'a'.repeat(QUICK_QUESTION_OPENING_MAX_LENGTH)}`),/500/u);
  assert.match(quickQuestionOpeningIssue('请使用 AI Ops MCP，password="secret with spaces"'),/凭据/u);

  assert.deepEqual(normalizeQuickQuestionOpening({
    revision:7,
    text:'  请使用 AI-Ops MCP 排查。  ',
    defaultText:'请使用 AI Ops MCP 排查。',
  }),{
    revision:7,
    text:'请使用 AI-Ops MCP 排查。',
    defaultText:'请使用 AI Ops MCP 排查。',
  });
  assert.equal(normalizeQuickQuestionOpening({
    revision:8,
    text:'请使用 ＡＩ－Ｏｐｓ ＭＣＰ 排查。',
    defaultText:'请使用 ＡＩ Ｏｐｓ ＭＣＰ 排查。',
  }).text,'请使用 AI-Ops MCP 排查。');
});

test('backend and renderer enforce the same opening marker accept and reject vectors', () => {
  for (const value of ACCEPTED_OPENING_MARKERS) {
    assert.doesNotThrow(() => normalizeBackendQuickQuestionOpening(value),value);
    assert.equal(quickQuestionOpeningIssue(value),null,value);
  }
  for (const value of REJECTED_OPENING_MARKERS) {
    assert.throws(
      () => normalizeBackendQuickQuestionOpening(value),
      (error) => error.code === 'QUICK_QUESTION_OPENING_MISSING_AI_OPS_MCP',
      value,
    );
    assert.match(quickQuestionOpeningIssue(value),/AI Ops MCP/u,value);
  }
});

test('renderer preview contains only opening, human-readable scope, and question', () => {
  const preview = buildQuickQuestionPreview({
    opening:'请使用 AI Ops MCP 排查。',
    projectName:'荷兰-voltstation',
    environmentName:'生产环境',
    question:'这个订单为什么一直待支付？',
  });
  assert.equal(preview,[
    '请使用 AI Ops MCP 排查。',
    '',
    '【当前范围】',
    '项目：荷兰-voltstation',
    '环境：生产环境',
    '',
    '【问题】',
    '这个订单为什么一直待支付？',
  ].join('\n'));
  assert.doesNotMatch(preview,/projectId|environmentId|plugin|resource|时区/iu);
});

test('renderer preview shows the optional discovery date as month and day only', () => {
  assert.equal(formatQuickQuestionDiscoveredDate('2026-08-24'),'8月24日');
  assert.equal(formatQuickQuestionDiscoveredDate('2026-02-30'),'');
  const preview = buildQuickQuestionPreview({
    opening:'请使用 AI Ops MCP 排查。',
    projectName:'企业版',
    environmentName:'生产环境',
    question:'为什么连接失败？',
    discoveredDate:'2026-08-24',
  });
  assert.match(preview,/环境：生产环境\n问题发现时间：8月24日\n\n【问题】/u);
  assert.doesNotMatch(preview,/2026|00:00|时区/u);
});

test('renderer credential feedback is strict without flagging ordinary URLs or business tokens', () => {
  for (const value of [
    'Authorization: Bearer bearer-secret-123456',
    'Basic dXNlcjpwYXNzd29yZA==',
    'password="secret with spaces"',
    'access_token=access-secret',
    '{"password":"secret with spaces"}',
    '{"client_secret":"client-secret"}',
    '{"secret":"service-secret"}',
    '{"Authorization":"Bearer bearer-secret-123456"}',
    '连接 https://reader:password@db.example.com/orders',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue',
    '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
  ]) assert.equal(quickQuestionHasStrictCredential(value),true,value);

  for (const value of [
    '排查邀请 token=invite-20260820 为什么没有生效',
    '请求 https://www.example.com/api/v1 报错',
    '交易哈希 0x1234567890abcdef1234567890abcdef',
  ]) assert.equal(quickQuestionHasStrictCredential(value),false,value);
});
