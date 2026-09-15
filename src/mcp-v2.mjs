#!/usr/bin/env node
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { defaultDataRoot } from './paths.mjs';
import { callBroker } from './broker-client.mjs';
import { AppError, toPublicError } from './errors.mjs';
import { APP_VERSION, RUNTIME_INFO } from './package-metadata.mjs';
import { instructions, tools, methodByTool } from './mcp-tool-contract.mjs';

const dataRoot = defaultDataRoot();
const clientInstanceId = crypto.randomBytes(16).toString('hex');
let brokerHandshake = null;
const server = new Server({ name: 'agent-ops-workbench', version: APP_VERSION }, { capabilities: { tools: {} }, instructions });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const name = request.params.name;
    const method = methodByTool[name];
    if (!method) throw new AppError('METHOD_NOT_FOUND', '未知 MCP 工具。');
    const args = { ...(request.params.arguments ?? {}) };
    args.clientInstanceId = clientInstanceId;
    brokerHandshake ??= callBroker(dataRoot, 'info', {}, 10_000).then((info) => {
      if (info?.protocolVersion !== 2) throw new AppError('BROKER_VERSION_MISMATCH', '桌面端与 Agent MCP 版本不兼容，请重启并更新 Agent 运维工作台。', { expectedProtocol:2, actualProtocol:info?.protocolVersion ?? null });
      return info;
    }).catch((error) => { brokerHandshake = null; throw error; });
    const brokerInfo = await brokerHandshake;
    const result = await callBroker(dataRoot, `v2.${method}`, args, 10 * 60 * 1000);
    if (method === 'openEnvironment') {
      result.mcpRuntime = RUNTIME_INFO;
      const actual = result.runtime ?? brokerInfo;
      if (!actual.buildId || actual.buildId !== RUNTIME_INFO.buildId) {
        result.runtimeWarning = 'MCP 与桌面端的构建标识不同或无法识别；如新能力不可用，请核对安装路径并更新、重启对应进程。';
      }
    }
    return { isError: false, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    if (['DESKTOP_UNAVAILABLE','BROKER_TIMEOUT'].includes(error?.code)) brokerHandshake = null;
    const value = toPublicError(error);
    return { isError: true, content: [{ type: 'text', text: `${value.code}: ${value.message}` }], structuredContent: { ok: false, error: value } };
  }
});

await server.connect(new StdioServerTransport());
