import { AppError } from './errors.mjs';

const deny = message => new AppError('MYSQL_SQL_WRITE_UNSAFE', message);
const quote = name => '`' + String(name).replaceAll('`', '``') + '`';

// Called inside the dedicated transaction. Metadata locks last until its end.
export async function assertMysqlSqlTables(query, database, items) {
  const names = [...new Set(items.flatMap(item => item.tables))];
  for (const table of names) {
    const writes = items.filter(item => item.write && item.tables.includes(table));
    const readTable = async () => {
      const [rows] = await query('SELECT TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, table]);
      if (rows.length !== 1 || rows[0].TABLE_TYPE !== 'BASE TABLE') throw deny('首版仅支持当前数据库的基础表，不支持视图或不可见的表。');
      if (writes.length && String(rows[0].ENGINE).toLowerCase() !== 'innodb') throw deny('SQL 写入仅支持 InnoDB 表，无法保证其他存储引擎的事务回滚。');
    };
    await readTable();
    if (!writes.length) continue;
    await query('SELECT * FROM ' + quote(database) + '.' + quote(table) + ' LIMIT 0');
    await readTable();
    // Empty TRIGGERS results cannot prove absence without metadata visibility.
    const grantee = "CONCAT(QUOTE(LEFT(CURRENT_USER(),CHAR_LENGTH(CURRENT_USER())-CHAR_LENGTH(SUBSTRING_INDEX(CURRENT_USER(),'@',-1))-1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))";
    let grants;
    try {
      [grants] = await query("SELECT PRIVILEGE_TYPE FROM (SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES UNION ALL SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ? UNION ALL SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?) AS effective_grants WHERE GRANTEE = " + grantee + " AND PRIVILEGE_TYPE = 'TRIGGER' LIMIT 1", [database, database, table]);
    } catch { throw deny('无法核对触发器可见性，请确认当前账号具有目标表的直接 TRIGGER 元数据权限。'); }
    if (!grants.length) throw deny('缺少可确认的 TRIGGER 元数据权限，无法排除跨库或不可回滚的触发器副作用。');
    const [triggers] = await query('SELECT EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?', [database, table]);
    if (triggers.some(row => writes.some(item => item.kind === String(row.EVENT_MANIPULATION).toLowerCase()))) throw deny('当前表存在相关写入触发器，首版暂不执行此 SQL。');
    const mask = (writes.some(item => item.kind === 'delete') ? 3 : 0) | (writes.some(item => item.kind === 'update') ? 12 : 0);
    if (mask) {
      let relations;
      try { [relations] = await query('SELECT TYPE FROM information_schema.INNODB_FOREIGN WHERE REF_NAME = ? AND (TYPE & ?) <> 0', [database + '/' + table, mask]); }
      catch { throw deny('无法完整核对入向级联外键，请确认 PROCESS 元数据权限后再执行修改或删除。'); }
      if (relations.length) throw deny('当前表存在相关级联修改或删除，首版暂不执行此 SQL。');
    }
  }
}
