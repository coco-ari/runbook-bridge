import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_QUICK_QUESTION_OPENING,
  buildQuickQuestionCopyText,
  containsQuickQuestionCredential,
  normalizeQuickQuestionOpening,
  parameterizeQuickQuestion,
  prepareQuickQuestionForSave,
  redactQuickQuestionCredentials,
} from '../src/quick-questions.mjs';

test('explicit credential forms are detected and fully redacted while an ordinary business token is preserved', () => {
  const cases = [
    ['Authorization: Bearer bearer-secret-123456','bearer-secret-123456'],
    ['Authorization = Basic dXNlcjpwYXNzd29yZA==','dXNlcjpwYXNzd29yZA=='],
    ['Authorization: custom-signed-secret-value','custom-signed-secret-value'],
    ['access_token = "access secret with spaces"','access secret with spaces'],
    ["client_secret: 'client secret with spaces'",'client secret with spaces'],
    ['secret=plain-secret-value','plain-secret-value'],
    ['password = "password with spaces"','password with spaces'],
    ['password = "password \\"with quotes\\" and spaces"','password \\"with quotes\\" and spaces'],
    ['连接 https://reader:p%40ssword@db.example.com/orders','p%40ssword'],
    ['-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----','private-material'],
    ['临时值 sk-proj-abcdefghijklmnopqrstuvwxyz012345','sk-proj-abcdefghijklmnopqrstuvwxyz012345'],
  ];
  for (const [source,secret] of cases) {
    assert.equal(containsQuickQuestionCredential(source),true,source);
    const redacted = redactQuickQuestionCredentials(source);
    assert.equal(redacted.includes(secret),false,source);
    assert.match(redacted,/\[已脱敏\]/u,source);
  }

  const business = '排查邀请 token=invite-20260820 为什么没有生效';
  assert.equal(containsQuickQuestionCredential(business),false);
  assert.equal(redactQuickQuestionCredentials(business),business);
  assert.equal(prepareQuickQuestionForSave(business),business);
  for (const source of [
    'access_token=real-secret-value',
    'secret=plain-secret-value',
    '{"password":"top-secret-123","client_secret":"client-json-secret","secret":"plain-json-secret"}',
    '{"Authorization":"Bearer bearer-secret-123456"}',
  ]) {
    assert.equal(containsQuickQuestionCredential(source),true);
    const redacted = redactQuickQuestionCredentials(source);
    assert.doesNotMatch(redacted,/real-secret-value|plain-secret-value|top-secret-123|client-json-secret|plain-json-secret|bearer-secret-123456/u);
    if (source.startsWith('{')) assert.doesNotThrow(() => JSON.parse(redacted));
    assert.throws(
      () => prepareQuickQuestionForSave(source),
      (error) => error.code === 'QUICK_QUESTION_CONTAINS_CREDENTIAL',
    );
  }
});

test('saved questions parameterize business identifiers without treating compact dates as cabinet numbers', () => {
  assert.equal(
    parameterizeQuickQuestion('订单2026082012345678，用户U123456，邮箱a@example.com，地址https://ops.example/a，机柜10600002，日期20260820'),
    '订单{订单号},用户{用户ID},邮箱{邮箱},地址{URL},机柜{机柜号},日期20260820',
  );
  assert.equal(parameterizeQuickQuestion('错误码10600002，日期20260229'),'错误码10600002,日期20260229');
  assert.equal(parameterizeQuickQuestion('机柜20260820'),'机柜20260820');
});

test('global opening validation is bounded, credential-free, and requires the AI Ops MCP identifier', () => {
  assert.equal(normalizeQuickQuestionOpening(DEFAULT_QUICK_QUESTION_OPENING),DEFAULT_QUICK_QUESTION_OPENING);
  assert.equal(normalizeQuickQuestionOpening('请使用 ai-ops mcp 排查。'),'请使用 ai-ops mcp 排查。');
  assert.equal(
    normalizeQuickQuestionOpening('  请使用 ＡＩ－Ｏｐｓ ＭＣＰ 排查。  '),
    '请使用 AI-Ops MCP 排查。',
  );
  assert.throws(
    () => normalizeQuickQuestionOpening(''),
    (error) => error.code === 'QUICK_QUESTION_OPENING_REQUIRED',
  );
  assert.throws(
    () => normalizeQuickQuestionOpening(`AI Ops MCP ${'x'.repeat(501)}`),
    (error) => error.code === 'QUICK_QUESTION_OPENING_TOO_LONG',
  );
  assert.throws(
    () => normalizeQuickQuestionOpening('请使用 MCP 排查。'),
    (error) => error.code === 'QUICK_QUESTION_OPENING_MISSING_AI_OPS_MCP',
  );
  assert.throws(
    () => normalizeQuickQuestionOpening('请使用 AI Ops-MCP 排查。'),
    (error) => error.code === 'QUICK_QUESTION_OPENING_MISSING_AI_OPS_MCP',
  );
  assert.throws(
    () => normalizeQuickQuestionOpening('请使用 AI Ops MCP，password=opening-secret-value'),
    (error) => error.code === 'QUICK_QUESTION_OPENING_CONTAINS_CREDENTIAL'
      && !error.message.includes('opening-secret-value'),
  );
});

test('copy text has only the canonical opening, range, and redacted question sections', () => {
  const openingText = '请使用 AI-Ops MCP 排查下列问题。';
  const copied = buildQuickQuestionCopyText({
    openingText,
    projectName:'荷兰-voltstaion',
    environmentName:'生产环境',
    question:'排查 access_token=copy-secret-value',
  });
  assert.equal(copied,[
    openingText,
    '',
    '【当前范围】',
    '项目：荷兰-voltstaion',
    '环境：生产环境',
    '',
    '【问题】',
    '排查 access_token=[已脱敏]',
  ].join('\n'));
  assert.doesNotMatch(copied,/默认只读|作用域锁定|【用户问题】|copy-secret-value/u);
  assert.doesNotMatch(copied,/projectId|environmentId|插件|Asia\/|Europe\//iu);

  for (const scope of [
    {projectName:'password=project-name-secret',environmentName:'生产环境',secret:'project-name-secret'},
    {projectName:'订单中心',environmentName:'client_secret=environment-name-secret',secret:'environment-name-secret'},
  ]) {
    assert.throws(
      () => buildQuickQuestionCopyText({openingText,...scope,question:'检查服务状态'}),
      (error) => error.code === 'QUICK_QUESTION_SCOPE_NAME_CONTAINS_CREDENTIAL'
        && !error.message.includes(scope.secret),
    );
  }
  assert.throws(
    () => buildQuickQuestionCopyText({openingText,projectName:'订单中心',environmentName:'生产环境',question:''}),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});
