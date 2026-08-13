import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProjectStore } from '../src/project-store.mjs';

const executable = path.resolve(process.argv[2] ?? 'dist/win-unpacked/AI运维工具.exe');
await fs.access(executable);
const mcpEntrypoint = path.join(path.dirname(executable), 'resources', 'app.asar', 'src', 'mcp.mjs');
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-package-'));
try {
  const store = new ProjectStore(dataRoot);
  const project = await store.create({
    id: 'package-verifier',
    name: '安装包验证项目',
    ssh: { host: '127.0.0.1', port: 22, username: 'deploy' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const transport = new StdioClientTransport({
    command: executable,
    args: [mcpEntrypoint],
    env: { ...process.env, AI_OPS_DATA_DIR: dataRoot, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  const client = new Client({ name: 'package-verifier', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ['list_projects', 'open_project', 'execute', 'execute_batch', 'upload', 'download', 'search_logs'],
  );
  const projects = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.equal(projects.isError, false);
  assert.equal('accessMode' in projects.structuredContent.projects[0], false);
  assert.equal('logRootCount' in projects.structuredContent.projects[0], false);
  const opened = await client.callTool({ name: 'open_project', arguments: { projectId: project.id } });
  assert.equal(opened.isError, false);
  assert.equal('accessMode' in opened.structuredContent, false);
  assert.equal('displayTimezone' in opened.structuredContent, false);
  assert.equal('allowedLogRoots' in opened.structuredContent, false);
  await client.close();
  console.log(`verified: ${executable}`);
} finally {
  await fs.rm(dataRoot, { recursive: true, force: true });
}
