import { AppError } from './errors.mjs';

export const LOG_SEARCH_LIMITS = Object.freeze({
  maxMatches:{minimum:1,maximum:500,default:200,label:'最大匹配数'},
  maxFiles:{minimum:1,maximum:100,default:20,label:'最大文件数'},
  maxDepth:{minimum:0,maximum:12,default:3,label:'最大目录深度'},
  beforeLines:{minimum:0,maximum:50,default:2,label:'前置上下文行数'},
  afterLines:{minimum:0,maximum:50,default:2,label:'后置上下文行数'},
  maxScanBytes:{minimum:65536,maximum:64 * 1024 * 1024,default:16 * 1024 * 1024,label:'日志扫描字节数'},
  maxExpandedBytes:{minimum:65536,maximum:128 * 1024 * 1024,default:64 * 1024 * 1024,label:'日志展开字节数'},
  maxArchiveEntries:{minimum:1,maximum:128,default:128,label:'归档条目数'},
});

export function logLimitSchema(field, description) {
  const {minimum,maximum} = LOG_SEARCH_LIMITS[field];
  return {type:'integer',minimum,maximum,...(description ? {description} : {})};
}

export function logInteger(value, field, fallback = LOG_SEARCH_LIMITS[field].default) {
  const {minimum,maximum,label} = LOG_SEARCH_LIMITS[field];
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new AppError('INVALID_ARGUMENT',`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`,{
      field,minimum,maximum,receivedType:typeof value,
      ...(Number.isFinite(resolved) ? {received:resolved} : {}),
      suggestedValue:Number.isFinite(resolved) ? Math.min(maximum,Math.max(minimum,Math.floor(resolved))) : fallback,
      guidance:'按建议修正参数后重新调用，并检查结果的覆盖范围；较小预算可能只返回部分结果。',
    });
  }
  return resolved;
}
