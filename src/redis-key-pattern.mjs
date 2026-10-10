// 桌面范围预览与服务端权限校验共用相同语义：仅 *、? 是通配符。
export function redisKeyAllowed(pattern, value) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u').exec(value)?.[0] === value;
}
