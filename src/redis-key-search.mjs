// 搜索支持 *、? 和反斜杠转义；未指定 * 时自动按包含匹配。
// 使用迭代匹配，避免把用户模式转换为可能发生指数回溯的正则。
export function redisKeySearch(keyword = '') {
  const tokens = [];
  const chars = Array.from(keyword);
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '\\' && index + 1 < chars.length) tokens.push({ literal: chars[++index] });
    else if (char === '*') {
      if (tokens.at(-1)?.wildcard !== '*') tokens.push({ wildcard: '*' });
    } else if (char === '?') tokens.push({ wildcard: '?' });
    else tokens.push({ literal: char });
  }
  if (!tokens.some((token) => token.wildcard)) {
    const literal = tokens.map((token) => token.literal).join('');
    return (key) => key.includes(literal);
  }
  if (!tokens.some((token) => token.wildcard === '*')) {
    tokens.unshift({ wildcard: '*' });
    tokens.push({ wildcard: '*' });
  }
  return (key) => {
    const value = Array.from(key);
    let at = 0;
    let token = 0;
    let star = -1;
    let retry = 0;
    while (at < value.length) {
      if (tokens[token]?.wildcard === '*') { star = token++; retry = at; }
      else if (tokens[token]?.wildcard === '?' || tokens[token]?.literal === value[at]) { at += 1; token += 1; }
      else if (star >= 0) { token = star + 1; at = ++retry; }
      else return false;
    }
    while (tokens[token]?.wildcard === '*') token += 1;
    return token === tokens.length;
  };
}
