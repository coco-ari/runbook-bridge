import { parentPort } from 'node:worker_threads';
import { expandLogArchive } from './log-archive.mjs';
import { searchLogSnapshots } from './log-search.mjs';

async function processInput({ archive, search }) {
  const expanded = await expandLogArchive(archive);
  let remainingMatches = search.maxMatches;
  let remainingContextBytes = search.maxContextBytes;
  let remainingOffset = search.matchOffset ?? 0;
  const snapshots = [];
  for (const snapshot of expanded.snapshots) {
    const searched = expanded.archiveType === 'plain' && search.skipPrefixBytes
      ? { ...snapshot, content:snapshot.content.subarray(search.skipPrefixBytes) }
      : snapshot;
    const result = searchLogSnapshots({ ...search, snapshots:[searched], maxMatches:remainingMatches, maxContextBytes:remainingContextBytes, matchOffset:remainingOffset });
    remainingOffset = Math.max(0,remainingOffset - result.totalMatches);
    remainingMatches -= result.matches.length;
    remainingContextBytes -= result.contextBytes;
    snapshots.push({ path:snapshot.path, archiveEntry:snapshot.archiveEntry, search:result });
  }
  return { ...expanded, snapshots };
}

parentPort.on('message', async ({ operation, args }) => {
  try {
    const result = operation === 'process' ? await processInput(args) : operation === 'expand' ? await expandLogArchive(args) : searchLogSnapshots(args);
    const transfer = operation === 'expand'
      ? [...new Set(result.snapshots.map(snapshot => snapshot.content.buffer).filter(buffer => buffer.byteLength > 8192))]
      : [];
    parentPort.postMessage({ result }, transfer);
  } catch (error) {
    const known = /^(LOG_ARCHIVE_|INVALID_LOG_SEARCH_ARGUMENT)/.test(String(error?.code));
    parentPort.postMessage({ error:known ? { code:error.code, message:error.message, details:error.details } : { code:'LOG_PROCESSING_FAILED', message:'本地日志处理失败，请缩小搜索范围。' } });
  }
});
