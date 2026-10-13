import path from 'node:path';
import { AppError } from '../../errors.mjs';
import { normalizeServiceUrl } from '../../source-protocol.mjs';
import { codexAdapter } from './connection.mjs';

export function codexTarget(raw = {}) {
  const authMode = raw.authMode ?? 'chatgpt';
  if (!['chatgpt','custom'].includes(authMode)) throw new AppError('INVALID_ARGUMENT','请选择 ChatGPT 登录或兼容 Responses 服务。');
  const executable = String(raw.executable ?? '').trim(), model = String(raw.model ?? '').trim();
  if (executable && (executable.length > 1024 || /[\r\n\0]/.test(executable) || (!path.posix.isAbsolute(executable) && !path.win32.isAbsolute(executable)))) throw new AppError('INVALID_ARGUMENT','Codex 可执行文件必须使用绝对路径。');
  if (model.length > 200 || /[\s\x00-\x1f]/.test(model)) throw new AppError('INVALID_ARGUMENT','模型 ID 无效。');
  return {authMode,executable,model,baseUrl:authMode === 'custom' ? normalizeServiceUrl(raw.baseUrl) : ''};
}
export const codexPluginDefinition = {
  type:'codex',connectionAdapter:codexAdapter,connectionFields:['target'],connectionNestedFields:{target:['authMode','executable','model','baseUrl']},
  normalizeConfiguration(input,existing,base) {
    const target = codexTarget({...existing?.target,...input.target});
    return {...base,target,configState:target.authMode === 'chatgpt' || (target.baseUrl && target.model) ? 'ready' : 'draft'};
  },
  publicResource:() => ({kind:'agent-workspace'}),capabilities:{},
  invoke() { throw new AppError('CAPABILITY_NOT_IMPLEMENTED','Codex Agent 只能从桌面对话工作区使用。'); },
};
