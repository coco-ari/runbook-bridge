import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMysqlSelect, validateMysqlExplain, applyMysqlRowLimit } from '../src/mysql-policy.mjs';

test('MySQL policy accepts bounded read-only queries and identifies tables', () => {
  const value = validateMysqlSelect('SELECT u.id, COUNT(*) AS total FROM users u LEFT JOIN orders o ON o.user_id=u.id GROUP BY u.id');
  assert.deepEqual(value.tables.sort(), ['orders', 'users']);
  assert.match(applyMysqlRowLimit(value, 50), /LIMIT 51/i);
  assert.match(validateMysqlExplain('SELECT id FROM users').statement, /^EXPLAIN SELECT/);
});

for (const sql of [
  'UPDATE users SET admin=1',
  'SELECT * FROM other.users',
  'SELECT * FROM users FOR UPDATE',
  "SELECT LOAD_FILE('/etc/passwd')",
  'SELECT SLEEP(10)',
  'SELECT UUID() FROM users',
  'SELECT * FROM users; SELECT * FROM orders',
  "SELECT * INTO OUTFILE '/tmp/x' FROM users",
]) {
  test(`MySQL policy blocks ${sql}`, () => assert.throws(() => validateMysqlSelect(sql), (error) => error.code === 'HARD_POLICY_DENIED'));
}

