import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOffsetCursor, normalizeRedisCursor } from '../src/pagination-cursor.mjs';
import { ServerOperations } from '../src/server-operations.mjs';
import { MysqlPluginRuntime } from '../src/mysql-plugin-runtime.mjs';
import { RedisPluginRuntime } from '../src/redis-plugin-runtime.mjs';

const INVALID_OFFSET_CURSORS = [
  'not-a-cursor',
  '',
  '01',
  '-1',
  '1.5',
  ' 1',
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
];

function rejectsInvalidCursor(operation, message) {
  return assert.rejects(
    operation,
    (error) => error?.code === 'INVALID_ARGUMENT',
    message,
  );
}

test('offset cursors preserve legacy integers and canonical returned strings', () => {
  assert.equal(parseOffsetCursor(undefined), 0);
  assert.equal(parseOffsetCursor(null), 0);
  assert.equal(parseOffsetCursor(17), 17);
  assert.equal(parseOffsetCursor('17'), 17);
  assert.equal(parseOffsetCursor(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(parseOffsetCursor(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeRedisCursor('0'), '0');
  assert.equal(normalizeRedisCursor('18446744073709551615'), '18446744073709551615');
});

test('every Server pagination boundary rejects malformed or unsafe cursors before remote work', async () => {
  const operations = new ServerOperations({}, {});
  const boundaries = {
    listFiles:(cursor) => operations.listFiles({}, {sourceId:'logs', cursor}),
    readLog:(cursor) => operations.readLog({}, {fileId:'log-file', cursor}),
    readConfig:(cursor) => operations.readConfig({}, {fileId:'config-file', cursor}),
    listDirectory:(cursor) => operations.listDirectory({}, {path:'/logs', cursor}),
    readFile:(cursor) => operations.readFile({}, {path:'/logs/app.log', cursor}),
  };
  for (const [name, invoke] of Object.entries(boundaries)) {
    for (const cursor of INVALID_OFFSET_CURSORS) {
      await rejectsInvalidCursor(
        () => invoke(cursor),
        `${name} should reject ${String(cursor)}`,
      );
    }
  }
});

test('MySQL table pagination rejects malformed or unsafe cursors before querying', async () => {
  const runtime = new MysqlPluginRuntime({}, {}, {});
  runtime.querySession = async () => {
    assert.fail('invalid cursor must be rejected before querying MySQL');
  };
  for (const cursor of INVALID_OFFSET_CURSORS) {
    await rejectsInvalidCursor(() => runtime.listTables({}, {cursor}));
  }
});

test('Redis scan accepts only canonical unsigned decimal string cursors', async () => {
  const runtime = new RedisPluginRuntime({}, {});
  const invalidRedisCursors = [
    ...INVALID_OFFSET_CURSORS,
    0,
    null,
    '18446744073709551616',
  ];
  for (const cursor of invalidRedisCursors) {
    await rejectsInvalidCursor(() => runtime.scan({}, {patternId:'orders', cursor}));
  }
});
