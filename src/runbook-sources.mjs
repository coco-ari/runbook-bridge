import crypto from 'node:crypto';
import path from 'node:path';

const SOURCE_LINE = /^\s*-\s*(日志目录|配置目录)\s*[:：]\s*`([^`]+)`\s*$/u;
const HEADING = /^###\s+(.+?)\s*$/u;

function key(value) {
  return String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function safeRoot(value) {
  const root = String(value ?? '').trim().replace(/\\/g, '/');
  if (!root.startsWith('/') || root.includes('\0') || root.length > 4096 || root.split('/').includes('..')) return null;
  return path.posix.normalize(root);
}

function sourceId(kind, root) {
  return `readme-${kind}-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
}

export function sourcesFromRunbook(content, plugin) {
  if (plugin?.pluginType !== 'server') return [];
  const lines = String(content ?? '').split(/\r?\n/u);
  const wantedHeading = key(plugin.displayName);
  const discovered = [];
  let inPluginSection = false;
  for (const line of lines) {
    const heading = line.match(HEADING);
    if (heading) {
      inPluginSection = key(heading[1]) === wantedHeading;
      continue;
    }
    if (/^#{1,2}\s+/u.test(line)) inPluginSection = false;
    if (!inPluginSection) continue;
    const match = line.match(SOURCE_LINE);
    if (!match) continue;
    const root = safeRoot(match[2]);
    if (!root) continue;
    const kind = match[1] === '日志目录' ? 'log' : 'config';
    discovered.push({
      sourceId: sourceId(kind, root),
      displayName: `${plugin.displayName}${kind === 'log' ? '日志' : '配置'}`,
      kind,
      root,
      patterns: kind === 'log' ? ['*.log', '*.txt'] : ['*.yml', '*.yaml', '*.properties', '*.conf', '*.json', '.env'],
      maxFileBytes: 100 * 1024 * 1024,
      redactSecrets: kind === 'config',
    });
  }
  return discovered;
}

export function pluginWithRunbookSources(plugin, runbookContent) {
  if (plugin?.pluginType !== 'server') return plugin;
  const combined = [...(plugin.sources ?? []), ...sourcesFromRunbook(runbookContent, plugin)];
  const unique = [];
  const seen = new Set();
  for (const source of combined) {
    const signature = `${source.kind}:${source.root}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(source);
  }
  return { ...plugin, sources: unique };
}

export const runbookSourceInternals = { safeRoot, SOURCE_LINE, HEADING };
