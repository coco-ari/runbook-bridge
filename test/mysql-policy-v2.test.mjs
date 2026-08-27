import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMysqlSelect, validateMysqlExplain, applyMysqlRowLimit } from '../src/mysql-policy.mjs';

test('MySQL policy accepts bounded read-only queries and identifies tables', () => {
  const value = validateMysqlSelect('SELECT u.id, COUNT(*) AS total FROM users u LEFT JOIN orders o ON o.user_id=u.id GROUP BY u.id');
  assert.deepEqual(value.tables.sort(), ['orders', 'users']);
  assert.match(applyMysqlRowLimit(value, 50), /LIMIT 51/i);
  assert.match(validateMysqlExplain('SELECT id FROM users').statement, /^EXPLAIN SELECT/);
});

test('MySQL policy accepts the observed parser-supported pure time and JSON helpers', () => {
  for (const sql of [
    "SELECT CONVERT_TZ(created_at, '+00:00', '+08:00') FROM orders",
    "SELECT JSON_VALID(payload), JSON_UNQUOTE(JSON_EXTRACT(payload, '$.id')) FROM orders",
  ]) assert.doesNotThrow(() => validateMysqlSelect(sql));
  for (const sql of [
    "SELECT 'LOAD_FILE(' AS text",
    "SELECT id FROM orders WHERE message LIKE '%SLEEP(%'",
    'SELECT 1 /* BENCHMARK( */',
  ]) assert.doesNotThrow(() => validateMysqlSelect(sql));
  assert.throws(() => validateMysqlSelect('SELECT UTC_TIMESTAMP()'),(error) => error.code === 'DATABASE_FUNCTION_NOT_ALLOWED');
});

test('MySQL policy reports unsupported functions and syntax as actionable errors', () => {
  assert.throws(
    () => validateMysqlSelect('SELECT UUID() FROM users'),
    (error) => error.code === 'DATABASE_FUNCTION_NOT_ALLOWED' && error.details?.function === 'uuid',
  );
  assert.throws(
    () => validateMysqlSelect('SELECT FROM'),
    (error) => error.code === 'DATABASE_QUERY_UNSUPPORTED',
  );
  assert.throws(
    () => validateMysqlSelect('SELECT STDDEV(amount) FROM orders'),
    (error) => error.code === 'DATABASE_FUNCTION_NOT_ALLOWED' && error.details?.function === 'stddev',
  );
});

for (const sql of [
  'UPDATE users SET admin=1',
  'SELECT * FROM other.users',
  'SELECT * FROM users FOR UPDATE',
  'SELECT app.ABS(balance) FROM users',
  'SELECT app.JSON_VALID(payload) FROM users',
  "SELECT LOAD_FILE('/etc/passwd')",
  'SELECT SLEEP(10)',
  "SELECT GET_LOCK/**/('deploy', 1)",
  "SELECT WAIT_FOR_EXECUTED_GTID_SET('uuid:1', 10)",
  'SELECT * FROM users FOR SHARE',
  'SELECT * FROM users; SELECT * FROM orders',
  "SELECT * INTO OUTFILE '/tmp/x' FROM users",
]) {
  test(`MySQL policy blocks ${sql}`, () => assert.throws(() => validateMysqlSelect(sql), (error) => error.code === 'HARD_POLICY_DENIED'));
}
