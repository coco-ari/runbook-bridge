function sourceKey(value) {
  return JSON.stringify([value.path, value.archiveMember ?? null, value.scanStartByte, value.lineNumberScope]);
}

function selectedContexts(contexts, matches, beforeLines, afterLines) {
  const ranges = new Map();
  for (const match of matches) {
    const key = sourceKey(match);
    if (!ranges.has(key)) ranges.set(key, []);
    ranges.get(key).push([match.lineNumber - beforeLines, match.lineNumber + afterLines]);
  }
  const selected = [];
  for (const context of contexts) {
    const windows = ranges.get(sourceKey(context));
    if (!windows) continue;
    const lines = context.lines.filter(line => windows.some(([start, end]) => line.lineNumber >= start && line.lineNumber <= end));
    if (!lines.length) continue;
    const included = new Set(lines.map(line => line.lineNumber));
    selected.push({
      ...context,
      startLine:lines[0].lineNumber,
      endLine:lines.at(-1).lineNumber,
      matchLineNumbers:context.matchLineNumbers.filter(line => included.has(line)),
      lines,
    });
  }
  return selected;
}

// 按实际 UTF-8 JSON 大小分页；游标只能推进到本页确实返回的匹配。
export function selectLogResultPage({ previousMatches, previousContexts, matches, contexts, beforeLines, afterLines, maxBytes }) {
  const candidate = count => {
    const selected = matches.slice(0, count);
    const selectedContext = selectedContexts(contexts, selected, beforeLines, afterLines);
    const bytes = Buffer.byteLength(JSON.stringify({
      matches:[...previousMatches, ...selected],
      contexts:[...previousContexts, ...selectedContext],
    }), 'utf8');
    return { matches:selected, contexts:selectedContext, bytes, contextOmitted:false };
  };
  let low = 0;
  let high = matches.length;
  let page = candidate(0);
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const next = candidate(count);
    if (next.bytes <= maxBytes) {
      low = count;
      page = next;
    } else high = count - 1;
  }
  if (low === 0 && previousMatches.length === 0 && matches.length > 0) {
    // 单条命中必须能推进游标；过大的上下文可用更大预算重新查询。
    const selected = matches.slice(0, 1);
    page = { matches:selected, contexts:[], bytes:Buffer.byteLength(JSON.stringify({matches:selected,contexts:[]}),'utf8'), contextOmitted:true };
  }
  return { ...page, limited:page.matches.length < matches.length || page.contextOmitted || page.bytes > maxBytes };
}
