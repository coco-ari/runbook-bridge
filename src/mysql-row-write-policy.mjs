import { mysqlEditError } from './mysql-edit-policy.mjs';

// 触发器元数据会按权限隐藏；空结果本身不能证明没有触发器。
export async function assertMysqlRowWriteSafe(query, database, table, kinds) {
  const grantee="CONCAT(QUOTE(LEFT(CURRENT_USER(),CHAR_LENGTH(CURRENT_USER())-CHAR_LENGTH(SUBSTRING_INDEX(CURRENT_USER(),'@',-1))-1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))";
  let grants;
  try {
    [grants]=await query("SELECT PRIVILEGE_TYPE FROM (SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES UNION ALL SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ? UNION ALL SELECT GRANTEE,PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?) AS effective_grants WHERE GRANTEE = "+grantee+" AND PRIVILEGE_TYPE = 'TRIGGER' LIMIT 1",[database,database,table]);
  } catch { throw mysqlEditError('无法核对触发器可见性，暂不允许新增或删除。'); }
  if(!grants.length) throw mysqlEditError('当前账号缺少可确认的 TRIGGER 元数据权限，无法排除触发器影响，暂不允许新增或删除。');
  const [triggers]=await query('SELECT EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?',[database,table]);
  if(triggers.some(row=>kinds.has(String(row.EVENT_MANIPULATION).toLowerCase()))) throw mysqlEditError('当前表存在相关写入触发器，暂不支持新增或删除。');
  if(kinds.has('delete')){
    // 此系统表要求 PROCESS 权限，能发现账号无权查看的其他库中的入向外键。
    let relations;
    try { [relations]=await query('SELECT TYPE FROM information_schema.INNODB_FOREIGN WHERE REF_NAME = ? AND (TYPE & 3) <> 0',[database+'/'+table]); }
    catch { throw mysqlEditError('无法完整核对入向外键，请由管理员确认 PROCESS 元数据权限后再删除。'); }
    if(relations.length) throw mysqlEditError('当前表存在级联删除或置空关联，暂不支持删除行。');
  }
}
