export type MysqlScriptStatement = { sql: string; start: number; end: number; line: number };
export function splitMysqlScript(input: string): MysqlScriptStatement[];
export function selectMysqlScript(input: string, start: number, end: number, kind?: 'current' | 'selection' | 'all'): string;
