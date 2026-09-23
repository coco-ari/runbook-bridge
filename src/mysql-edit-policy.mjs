import crypto from 'node:crypto';
import { AppError } from './errors.mjs';
import { validateMysqlSelect } from './mysql-policy.mjs';

export const MYSQL_EDIT_LIMITS = Object.freeze({rows:100, cells:2000, valueBytes:65536, changeBytes:262144, snapshotBytes:4194304, snapshots:24, lifetimeMs:1800000, planMs:120000});
const BACKTICK = String.fromCharCode(96);
export const quoteMysqlName = name => BACKTICK + String(name).replaceAll(BACKTICK,BACKTICK+BACKTICK) + BACKTICK;
export const mysqlEditError = (message, details) => new AppError('MYSQL_EDIT_READONLY',message,details);
export const mysqlEditHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function editableMysqlQuery(sql) {
  const validated = validateMysqlSelect(sql);
  const ast = validated.ast;
  if (ast.from?.length !== 1 || !ast.from[0].table || ast.from[0].db || ast.from[0].join
    || ast.with || ast.distinct || ast.groupby || ast.having || ast.window || ast._next || ast.set_op || ast.options?.length) {
    throw mysqlEditError('仅支持包含完整主键的简单单表查询；联表、去重和聚合结果保持只读。');
  }
  const visit = (node, root = false) => {
    if (!node || typeof node !== 'object') return;
    if (!root && node.type === 'select') throw mysqlEditError('含子查询的结果暂不支持编辑。');
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(item=>visit(item)); else if (value && typeof value === 'object') visit(value);
  };
  visit(ast,true);
  const source = ast.from[0];
  const columns = ast.columns;
  if (!Array.isArray(columns) || columns.some(item => item.expr?.type !== 'column_ref'
    || item.expr.collate || (item.expr.table && ![source.table,source.as].includes(item.expr.table))
    || (item.expr.column === '*' && item.as))) {
    throw mysqlEditError('查询列必须直接对应原表字段；计算结果暂不支持编辑。');
  }
  return {...validated,table:source.table,projections:columns.map(item=>({source:item.expr.column,name:item.as || item.expr.column}))};
}

const TEXT_TYPES = new Set(['char','varchar','tinytext','text','mediumtext','longtext']);
const INTEGER_BITS = {tinyint:8,smallint:16,mediumint:24,int:32,integer:32,bigint:64};
export function mysqlEditableColumn(column) {
  const type = column.dataType.toLowerCase();
  if (column.key === 'PRI') return {editable:false,reason:'主键仅用于定位记录，不允许修改。'};
  if (/generated/i.test(column.extra)) return {editable:false,reason:'生成列由数据库计算。'};
  if (TEXT_TYPES.has(type) || Object.hasOwn(INTEGER_BITS,type) || ['decimal','numeric','float','double','real','date','datetime','timestamp','time','year','enum','set','json'].includes(type)) return {editable:true};
  return {editable:false,reason:'此字段类型暂不支持编辑。'};
}

function enumValues(type) {
  return [...type.matchAll(/'((?:''|\\.|[^'])*)'/gu)].map(match=>match[1].replace(/''/gu,"'").replace(/\\([0bnrtZ\\'"])/gu,(_all,char)=>({'0':'\0',b:'\b',n:'\n',r:'\r',t:'\t',Z:'\x1a'}[char] ?? char)));
}

export function normalizeMysqlEditValue(column, value) {
  if (!mysqlEditableColumn(column).editable) throw new AppError('MYSQL_EDIT_COLUMN_READONLY','该字段不可修改。',{column:column.name});
  if (value === null) {
    if (!column.nullable) throw new AppError('MYSQL_EDIT_VALUE_INVALID','该字段不允许 NULL。',{column:column.name});
    return null;
  }
  if (typeof value !== 'string' || Buffer.byteLength(value,'utf8') > MYSQL_EDIT_LIMITS.valueBytes || value.includes('\0')) {
    throw new AppError('MYSQL_EDIT_VALUE_INVALID','字段值必须是有界文本或 NULL。',{column:column.name});
  }
  const invalid = message => {throw new AppError('MYSQL_EDIT_VALUE_INVALID',message,{column:column.name});};
  const type = column.dataType.toLowerCase();
  if (TEXT_TYPES.has(type)) {
    if (column.maxLength !== null && [...value].length > column.maxLength) invalid('文本超过字段允许的长度。');
    return value;
  }
  if (Object.hasOwn(INTEGER_BITS,type)) {
    if (!/^[+-]?\d+$/u.test(value)) invalid('请输入完整整数，不支持小数或指数形式。');
    const number = BigInt(value), bits = BigInt(INTEGER_BITS[type]), unsigned = /unsigned/i.test(column.type);
    if (number < (unsigned ? 0n : -(2n ** (bits-1n))) || number > (unsigned ? 2n**bits-1n : 2n**(bits-1n)-1n)) invalid('整数超出字段允许的范围。');
    return number.toString();
  }
  if (['decimal','numeric'].includes(type)) {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value);
    if (!match || (/unsigned/i.test(column.type) && match[1] === '-')) invalid('请输入有效的精确小数。');
    const integer = match[2].replace(/^0+(?=\d)/u,'');
    if ((integer === '0' ? 0 : integer.length) > column.precision-column.scale || (match[3]?.length ?? 0) > column.scale) invalid('小数位数或整数位数超过字段精度。');
    return (match[1] === '-' ? '-' : '') + integer + (match[3] ? '.' + match[3] : '');
  }
  if (['float','double','real'].includes(type)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) || !Number.isFinite(Number(value))
      || (type === 'float' && Math.abs(Number(value)) > 3.402823466e38) || (/unsigned/i.test(column.type) && Number(value)<0)) invalid('请输入字段范围内的有限数字。');
    return value;
  }
  if (['date','datetime','timestamp'].includes(type)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/u.exec(value);
    if (!match || (type === 'date' ? match[4] !== undefined : match[4] === undefined)) invalid('日期格式应为 YYYY-MM-DD，时间格式应为 YYYY-MM-DD HH:mm:ss。');
    const [year,month,day] = match.slice(1,4).map(Number);
    const leap = year%4 === 0 && (year%100 !== 0 || year%400 === 0);
    const days = [31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    if (year<1000 || month<1 || month>12 || day<1 || day>days[month-1]
      || Number(match[4]??0)>23 || Number(match[5]??0)>59 || Number(match[6]??0)>59 || (match[7]?.length??0)>(column.datetimePrecision??0)) invalid('日期、时间或小数秒精度无效。');
    return value.replace('T',' ');
  }
  if (type === 'time') {
    const match=/^-?(\d{1,3}):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/u.exec(value);
    if (!match || Number(match[1])>838 || (match[4]?.length??0)>(column.datetimePrecision??0)) invalid('时间应在允许范围内，并使用 HH:mm:ss 格式。');
  }
  if (type === 'year' && !/^(?:0000|19(?:0[1-9]|[1-9]\d)|20\d\d|21[0-4]\d|215[0-5])$/u.test(value)) invalid('年份应为 0000 或 1901 到 2155。');
  if (type === 'enum' && !enumValues(column.type).includes(value)) invalid('请选择字段定义中的枚举值。');
  if (type === 'set' && value !== '' && value.split(',').some(item=>!enumValues(column.type).includes(item))) invalid('集合值包含未定义的选项。');
  if (type === 'json') { try {JSON.parse(value);} catch {invalid('JSON 格式无效。');} }
  return value;
}

export function mysqlEditProjection(query, schema) {
  const byName = new Map(schema.columns.map(column=>[column.name,column]));
  const result = [];
  for (const item of query.projections) {
    if (item.source === '*') result.push(...schema.columns.filter(column=>!/invisible/i.test(column.extra)).map(column=>({source:column.name,name:column.name})));
    else if (byName.has(item.source)) result.push(item);
    else throw mysqlEditError('查询字段与当前表结构不一致，请重新查询。');
  }
  if (new Set(result.map(item=>item.name)).size !== result.length || new Set(result.map(item=>item.source)).size !== result.length) throw mysqlEditError('重复或重名字段无法可靠编辑，请简化查询。');
  const primary = schema.columns.filter(column=>column.key === 'PRI');
  if (!primary.length || primary.some(column=>!result.some(item=>item.source === column.name))) throw mysqlEditError('查询结果必须包含完整主键；请将所有主键字段加入 SELECT。');
  if (primary.some(column=>!TEXT_TYPES.has(column.dataType) && !Object.hasOwn(INTEGER_BITS,column.dataType) && !['decimal','numeric','date','datetime','timestamp','time','year'].includes(column.dataType))) throw mysqlEditError('当前主键类型无法无损定位，暂不支持编辑。');
  return result.map(item=>({...item,column:byName.get(item.source),...mysqlEditableColumn(byName.get(item.source))}));
}
