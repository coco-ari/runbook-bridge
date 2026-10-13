import { AppError } from '../../errors.mjs';
import { sourceAdapter } from './connection.mjs';
import { normalizeServiceUrl, SOURCE_PROJECT } from '../../source-protocol.mjs';

export const sourcePluginDefinition = {
  type:'source',connectionAdapter:sourceAdapter,connectionFields:['target'],connectionNestedFields:{target:['serviceUrl','remoteProjectId']},
  normalizeConfiguration(input,existing,base) {
    const target = {...existing?.target,...input.target};
    const serviceUrl = normalizeServiceUrl(target.serviceUrl);
    const remoteProjectId = String(target.remoteProjectId ?? '').trim().toLowerCase();
    if (remoteProjectId && !SOURCE_PROJECT.test(remoteProjectId)) throw new AppError('INVALID_ARGUMENT','源码项目 ID 无效。');
    return {...base,configState:serviceUrl && remoteProjectId ? 'ready' : 'draft',target:{serviceUrl,remoteProjectId}};
  },
  publicResource:plugin => ({sourceProjectId:plugin.target?.remoteProjectId}),
  capabilities:{},
  invoke() { throw new AppError('CAPABILITY_NOT_IMPLEMENTED','源码插件仅向 MCP 提供本地路径和版本信息。'); },
};
