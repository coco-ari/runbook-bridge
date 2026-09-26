import { AppError } from './errors.mjs';

export const ENVIRONMENT_TYPES = Object.freeze(['unspecified', 'production', 'test']);

export function normalizeEnvironmentType(value) {
  if (value === undefined) return 'unspecified';
  if (!ENVIRONMENT_TYPES.includes(value)) throw new AppError('INVALID_ARGUMENT', '环境类型应为未标注、生产或测试。');
  return value;
}

// Omit the default to preserve existing cloud hashes and older local records.
export function environmentTypeFields(value) {
  const environmentType = normalizeEnvironmentType(value);
  return environmentType === 'unspecified' ? {} : { environmentType };
}
