import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMysqlScript, selectMysqlScript } from '../src/mysql-script-splitter.mjs';
import { prepareMysqlSqlScript, mysqlSqlRequest } from '../src/desktop-mysql-sql-policy.mjs';
import { validateMysqlSelect } from '../src/mysql-policy.mjs';

test('SQL script splitter preserves comments, quoted semicolons, doubled quotes and source offsets', () => {
  const sql = "-- introductory ; comment\nSELECT 'a;b', 'it''s fine', \"a;\"\"b\" FROM `semi;colon`;\n/* separator ; */\nUPDATE `semi;colon` SET label='; # --' WHERE id=1; # trailing ;";
  const items = splitMysqlScript(sql);
  assert.equal(items.length, 2);
  assert.equal(items[0].line, 2);
  assert.equal(items[1].line, 4);
  for (const item of items) assert.equal(sql.slice(item.start, item.end), item.sql);
  assert.match(items[0].sql, /'it''s fine'/u);
  assert.match(items[1].sql, /^\/\* separator ; \*\//u);
  assert.deepEqual(splitMysqlScript(' ; -- comment\n # comment\n /* comment */ ; '), []);
  assert.equal(splitMysqlScript('SELECT 3--1;SELECT 2').length, 2, 'MySQL -- needs following whitespace');
  assert.equal(splitMysqlScript('SELECT `a``;b`;SELECT 2').length, 2);
});

test('SQL script selection executes current statement or exact selected text', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
  assert.equal(selectMysqlScript(sql, 3, 3), 'SELECT 1');
  assert.equal(selectMysqlScript(sql, 9, 9), 'SELECT 2');
  assert.equal(selectMysqlScript(sql, sql.length, sql.length), 'SELECT 3');
  assert.equal(selectMysqlScript(sql, 10, 18, 'selection'), 'SELECT 2');
  assert.equal(selectMysqlScript(sql, 0, 0, 'all'), sql);
  assert.equal(selectMysqlScript(' -- nothing', 2, 2), '');
  for (const args of [[0, 0, 'selection'], [-1, 0, 'current'], [1, 0, 'selection'], [0, 200, 'current'], [0, 0, 'unknown']]) {
    assert.throws(() => selectMysqlScript(sql, ...args), (error) => error.code === 'INVALID_ARGUMENT');
  }
});

test('SQL script lexer fails closed on ambiguous or executable syntax', () => {
  for (const sql of [
    "SELECT 'unfinished", 'SELECT "unfinished', 'SELECT `unfinished', 'SELECT 1 /* unfinished',
    'SELECT 1 /*!; DROP TABLE users */', '/*M! DELETE FROM users */',
    'UPDATE /*+ SET_VAR(foreign_key_checks=OFF) */ users SET id=1',
    "SELECT 'back\\slash'", "SELECT 'it\\'s'", 'SELECT `back\\tick`',
    'DELIMITER $$\nSELECT 1$$', '/* leading */ DELIMITER ;', 'SELECT 1\0',
    '/* outer /* inner */ SELECT 1',
  ]) assert.throws(() => splitMysqlScript(sql), (error) => error.code === 'DATABASE_QUERY_UNSUPPORTED', sql);
  assert.equal(splitMysqlScript("SELECT '/*! not executable */', 'DELIMITER', '-- x', '#x'").length, 1);
});

test('desktop SQL policy supports ordinary single-table DML with reviewed pure expressions', () => {
  const queries = [
    ["INSERT INTO users (id,name) VALUES (1,'Alice'),(2,'Bob')", 'insert', false],
    ['UPDATE users SET name=UPPER(name),score=score+1 WHERE id IN (1,2)', 'update', false],
    ["UPDATE users u SET u.name=CASE WHEN u.id=1 THEN 'A' ELSE 'B' END WHERE u.id=1", 'update', false],
    ['UPDATE users SET active=1', 'update', true],
    ['DELETE FROM users WHERE id=1 ORDER BY id LIMIT 1', 'delete', false],
    ['DELETE FROM users LIMIT 1', 'delete', true],
  ];
  for (const [sql, kind, dangerous] of queries) {
    const [item] = prepareMysqlSqlScript(sql);
    assert.equal(item.kind, kind);
    assert.equal(item.write, true);
    assert.equal(item.dangerous, dangerous);
    assert.equal(item.table, 'users');
    assert.deepEqual(item.tables, ['users']);
    assert.deepEqual(mysqlSqlRequest(item, { database: 'app' }), { sql, values: [] });
  }
  assert.throws(() => validateMysqlSelect('UPDATE users SET active=1'), (error) => error.code === 'HARD_POLICY_DENIED', 'Agent policy remains read-only');
});

test('desktop SQL policy prevalidates the complete batch and returns indexed errors without SQL contents', () => {
  const sql = "INSERT INTO users VALUES(1);\nUPDATE users SET id=2 WHERE id=1;\nDROP TABLE users";
  assert.throws(() => prepareMysqlSqlScript(sql), (error) => error.code === 'HARD_POLICY_DENIED' && error.details.statementIndex === 2 && error.details.line === 3 && !error.message.includes('DROP TABLE users'));
  const items = prepareMysqlSqlScript('BEGIN; INSERT INTO users VALUES(1); UPDATE users SET id=2 WHERE id=1; COMMIT; SELECT * FROM users;');
  assert.deepEqual(items.map((item) => item.kind), ['begin', 'insert', 'update', 'commit', 'select']);
  for (const sql of ['', ' /* comment */ ', 'SELECT 1;'.repeat(101), `SELECT '${'中'.repeat(90_000)}'`]) {
    assert.throws(() => prepareMysqlSqlScript(sql), (error) => error.code === 'INVALID_ARGUMENT');
  }
  assert.equal(prepareMysqlSqlScript('SELECT 1;'.repeat(100)).length, 100);
});

test('desktop SQL requests bound SELECT, OFFSET, UNION and EXPLAIN results', () => {
  const request = (sql) => mysqlSqlRequest(prepareMysqlSqlScript(sql)[0], { database: 'app', maxRows: 20 });
  assert.match(request('SELECT * FROM users').sql, /LIMIT 21$/iu);
  assert.match(request('SELECT * FROM users LIMIT 10').sql, /LIMIT 10$/iu);
  assert.match(request('SELECT * FROM users LIMIT 100 OFFSET 3').sql, /LIMIT 21 OFFSET 3$/iu);
  assert.match(request('SELECT 1 UNION ALL SELECT 2').sql, /^SELECT \* FROM \(SELECT 1 UNION ALL SELECT 2\) AS `_desktop_result` LIMIT 21$/iu);
  assert.match(request('EXPLAIN SELECT * FROM users').sql, /^EXPLAIN SELECT .* LIMIT 21$/iu);
  assert.deepEqual(prepareMysqlSqlScript('SELECT u.id FROM users u LEFT JOIN orders o ON o.id=u.id')[0].tables, ['users', 'orders']);
  assert.deepEqual(prepareMysqlSqlScript('WITH q AS (SELECT id FROM users) SELECT * FROM q')[0].tables, ['users']);
});

test('desktop metadata SQL is scoped, parameterized and bounded', () => {
  for (const sql of ['SHOW TABLES', 'SHOW COLUMNS FROM users', 'SHOW INDEX FROM users', 'DESCRIBE users', 'DESC users']) {
    const [item] = prepareMysqlSqlScript(sql);
    assert.equal(item.write, false);
    const request = mysqlSqlRequest(item, { database: 'app', maxRows: 50 });
    assert.match(request.sql, /information_schema\./u);
    assert.match(request.sql, /TABLE_SCHEMA = \?/u);
    assert.match(request.sql, /LIMIT \?$/u);
    assert.deepEqual(request.values, sql === 'SHOW TABLES' ? ['app', 51] : ['app', 'users', 51]);
  }
  const create = mysqlSqlRequest(prepareMysqlSqlScript('SHOW CREATE TABLE users')[0], { database: 'app`scope' });
  assert.equal(create.sql, 'SHOW CREATE TABLE `app``scope`.`users`');
});

test('escaped table names bind metadata checks to the actual MySQL identifier', () => {
  for (const sql of ['SELECT * FROM `x``y`', 'SHOW COLUMNS FROM `x``y`', 'SHOW CREATE TABLE `x``y`', 'DESCRIBE `x``y`', 'INSERT INTO `x``y` VALUES(1)', 'DELETE FROM `x``y` WHERE id=1']) {
    const [item] = prepareMysqlSqlScript(sql);
    assert.deepEqual(item.tables, ['x`y']);
    const request = mysqlSqlRequest(item, { database: 'app' });
    if (sql.startsWith('SHOW CREATE')) assert.equal(request.sql, 'SHOW CREATE TABLE `app`.`x``y`');
    else if (sql.startsWith('SHOW') || sql.startsWith('DESCRIBE')) assert.equal(request.values[1], 'x`y');
    else assert.match(request.sql, /`x``y`/u);
  }
});

test('desktop SQL accepts only simple transaction boundaries', () => {
  const expected = [['BEGIN', 'begin', 'START TRANSACTION'], ['START TRANSACTION', 'begin', 'START TRANSACTION'], ['COMMIT', 'commit', 'COMMIT'], ['ROLLBACK', 'rollback', 'ROLLBACK']];
  for (const [sql, kind, normalized] of expected) {
    const [item] = prepareMysqlSqlScript(sql);
    assert.equal(item.kind, kind);
    assert.equal(item.write, false);
    assert.deepEqual(mysqlSqlRequest(item, { database: 'app' }), { sql: normalized, values: [] });
  }
  for (const sql of ['START TRANSACTION READ ONLY', 'COMMIT AND CHAIN', 'SAVEPOINT x', 'ROLLBACK TO SAVEPOINT x', 'SET autocommit=0']) {
    assert.throws(() => prepareMysqlSqlScript(sql));
  }
});

test('desktop SQL refuses cross-database and side-effecting expressions regardless of statement kind', () => {
  const deniedQueries = [
    'SELECT * FROM other.users', 'SELECT other.users.id FROM users', 'SELECT * FROM users FOR UPDATE',
    'SELECT SLEEP(2)', 'SELECT app.ABS(id) FROM users', 'SELECT @value', 'SELECT @@session.sql_mode',
    'UPDATE other.users SET id=1', 'DELETE FROM other.users', 'INSERT INTO other.users VALUES(1)',
    'UPDATE users SET id=other.users.id', 'UPDATE users SET id=@value', 'UPDATE users SET id=(@value:=1)',
    'UPDATE users SET id=? WHERE id=1', 'SELECT ?', 'SELECT 1 LIMIT ?',
    'INSERT INTO users VALUES(app.ABS(1))', 'UPDATE users SET id=SLEEP(1)', 'DELETE FROM users WHERE GET_LOCK(\'a\',1)',
    'UPDATE users SET id=(SELECT MAX(id) FROM orders)', 'DELETE FROM users WHERE id IN (SELECT id FROM orders)',
    'INSERT INTO users VALUES((SELECT 1))', 'INSERT INTO users SELECT * FROM orders',
    'UPDATE users u JOIN orders o ON o.id=u.id SET u.id=1', 'UPDATE users,orders SET users.id=1',
    'DELETE u FROM users u JOIN orders o ON o.id=u.id', 'DELETE users FROM users WHERE id=1',
    'INSERT IGNORE INTO users VALUES(1)', 'INSERT INTO users VALUES(1) ON DUPLICATE KEY UPDATE id=2', 'INSERT INTO users SET id=1',
    'SHOW COLUMNS FROM other.users', 'SHOW INDEX FROM other.users', 'SHOW CREATE TABLE other.users', 'SHOW DATABASES', 'SHOW GRANTS',
    'CREATE TABLE users(id int)', 'ALTER TABLE users ADD active int', 'DROP TABLE users', 'TRUNCATE TABLE users',
    "GRANT ALL ON *.* TO 'x'", "CREATE USER 'x'", 'CALL do_work()', 'SET sql_mode=\'\'', 'USE other',
    "LOAD DATA INFILE '/tmp/rows' INTO TABLE users", "SELECT * FROM users INTO OUTFILE '/tmp/result'", 'EXPLAIN UPDATE users SET id=1',
  ];
  for (const sql of deniedQueries) assert.throws(() => prepareMysqlSqlScript(sql), undefined, sql);
});

test('SQL execution requests revalidate untrusted item classifications and argument bounds', () => {
  assert.throws(() => mysqlSqlRequest({ sql: 'DROP TABLE users', kind: 'select', write: false }, { database: 'app' }));
  assert.throws(() => mysqlSqlRequest({ sql: 'SELECT 1;SELECT 2' }, { database: 'app' }));
  for (const options of [{}, { database: '' }, { database: 'app\0' }, { database: 'app', maxRows: 0 }, { database: 'app', maxRows: 1001 }, { database: 'app', maxRows: 1.5 }]) {
    assert.throws(() => mysqlSqlRequest({ sql: 'SELECT 1' }, options), (error) => error.code === 'INVALID_ARGUMENT');
  }
});
