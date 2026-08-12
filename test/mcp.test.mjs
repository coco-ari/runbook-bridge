import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProjectStore } from '../src/project-store.mjs';

test('MCP advertises the five tools and returns README before server operations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const project = await store.create({
    id: 'demo-project',
    name: '演示项目',
    ssh: { host: '127.0.0.1', port: 22, username: 'demo' },
    auth: { type: 'password' },
    proxy: { type: 'direct' },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/mcp.mjs')],
    env: { ...process.env, AI_OPS_DATA_DIR: root },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ai-ops-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ['list_projects', 'open_project', 'execute', 'upload', 'download'],
  );
  const opened = await client.callTool({ name: 'open_project', arguments: { projectId: project.id } });
  assert.equal(opened.isError, false);
  assert.equal(opened.structuredContent.connected, false);
  assert.equal(opened.structuredContent.contextToken, null);
  assert.equal(opened.structuredContent.documents[0].name, 'README.md');
  assert.match(opened.structuredContent.documents[0].content, /部署流程/);
});

test('Electron can run MCP directly in lightweight Node mode without a GUI parent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-electron-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const electron = path.resolve('node_modules/electron/dist/electron.exe');
  const transport = new StdioClientTransport({
    command: electron,
    args: [path.resolve('src/mcp.mjs')],
    env: { ...process.env, AI_OPS_DATA_DIR: root, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'electron-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 5);
});
