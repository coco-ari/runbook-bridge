import { RedisWorkspaceReader } from './redis-workspace-reader.mjs';
import { AppError } from './errors.mjs';

const COMMANDS = new Set(['WATCH','TYPE','PTTL','STRLEN','GETRANGE','MULTI','SET','UNLINK','EXEC']);
// 写入通道独立登记命令，不扩大工作区只读通道及 Agent 的权限。
export class RedisEditConnection extends RedisWorkspaceReader {
  command(args, deadline) {
    if (!this.ready || !COMMANDS.has(args[0])) throw new AppError('POLICY_DENIED','未登记的 Redis 编辑操作。');
    return this.request(args,deadline);
  }
}
