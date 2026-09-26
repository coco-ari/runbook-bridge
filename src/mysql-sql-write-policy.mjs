import { isMysqlSqlPermissionError, mysqlSqlUnsafeError } from './mysql-sql-diagnostics.mjs';

const quote = name => '`' + String(name).replaceAll('`', '``') + '`';

// Called inside the dedicated transaction. Metadata locks last until its end.
export async function assertMysqlSqlTables(query, database, items) {
  const names = [...new Set(items.flatMap(item => item.tables))];
  for (const table of names) {
    const writes = items.filter(item => item.write && item.tables.includes(table));
    const readTable = async () => {
      let rows;
      try { [rows] = await query('SELECT TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, table]); }
      catch (error) {
        if (isMysqlSqlPermissionError(error)) throw mysqlSqlUnsafeError('table_unavailable');
        throw error;
      }
      if (rows.length !== 1) throw mysqlSqlUnsafeError('table_unavailable');
      if (rows[0].TABLE_TYPE !== 'BASE TABLE') throw mysqlSqlUnsafeError('table_type');
      if (writes.length && String(rows[0].ENGINE).toLowerCase() !== 'innodb') throw mysqlSqlUnsafeError('non_transactional');
    };
    await readTable();
    if (!writes.length) continue;
    try { await query('SELECT * FROM ' + quote(database) + '.' + quote(table) + ' LIMIT 0'); }
    catch (error) {
      if (isMysqlSqlPermissionError(error)) throw mysqlSqlUnsafeError('select_privilege');
      throw error;
    }
    await readTable();
    // Empty TRIGGERS results cannot prove absence without metadata visibility.
    const grantee = "CONCAT(QUOTE(LEFT(CURRENT_USER(),CHAR_LENGTH(CURRENT_USER())-CHAR_LENGTH(SUBSTRING_INDEX(CURRENT_USER(),'@',-1))-1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))";
    let grants;
    try {
      [grants] = await query("SELECT PRIVILEGE_TYPE FROM (SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES UNION ALL SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ? UNION ALL SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?) AS effective_grants WHERE GRANTEE = " + grantee + " AND PRIVILEGE_TYPE = 'TRIGGER' LIMIT 1", [database, database, table]);
    } catch { throw mysqlSqlUnsafeError('trigger_visibility'); }
    if (!grants.length) throw mysqlSqlUnsafeError('trigger_visibility');
    let triggers;
    try { [triggers] = await query('SELECT EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?', [database, table]); }
    catch { throw mysqlSqlUnsafeError('trigger_visibility'); }
    if (triggers.some(row => writes.some(item => item.kind === String(row.EVENT_MANIPULATION).toLowerCase()))) throw mysqlSqlUnsafeError('trigger_side_effect');
    const mask = (writes.some(item => item.kind === 'delete') ? 3 : 0) | (writes.some(item => item.kind === 'update') ? 12 : 0);
    if (mask) {
      let relations;
      try { [relations] = await query('SELECT TYPE FROM information_schema.INNODB_FOREIGN WHERE REF_NAME = ? AND (TYPE & ?) <> 0', [database + '/' + table, mask]); }
      catch { throw mysqlSqlUnsafeError('cascade_visibility'); }
      if (relations.length) throw mysqlSqlUnsafeError('cascade_side_effect');
    }
  }
}
