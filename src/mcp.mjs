#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProjectStore } from './project-store.mjs';
import { defaultDataRoot } from './paths.mjs';
import { callBroker } from './broker-client.mjs';
import { AppError, toPublicError } from './errors.mjs';

const dataRoot = defaultDataRoot();
const store = new ProjectStore(dataRoot);
const MCP_VERSION = '0.1.7';

const instructions = `这是一个个人 SSH 运维工具。执行任何服务器操作前，必须先调用 open_project 读取最新项目文档，并使用返回的 contextToken。必须遵守项目文档中的部署流程、路径和限制。execute 命令还会经过桌面 Broker 的项目安全策略，命中高危规则时会返回 COMMAND_BLOCKED，不能尝试改写、混淆或绕过规则。不得要求用户在对话中提供服务器密码、私钥口令或代理密码。不得尝试通过 MCP 建立新的 SSH 连接；项目未连接时，提示用户在桌面工具中点击连接。upload 和 download 只传文件路径，不要把二进制内容放进参数。`;

const server = new Server(
  { name: 'ai-ops-tool', version: MCP_VERSION },
  { capabilities: { tools: {} }, instructions },
);

const tools = [
  {
    name: 'list_projects',
    description: '列出本地 AI 运维项目及当前 SSH 连接状态。不会连接服务器。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'open_project',
    description: '读取项目全部 Markdown 操作文档，并在项目已连接时签发服务器操作所需的 contextToken。执行任何服务器操作前必须调用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: { projectId: { type: 'string', minLength: 2, maxLength: 63 } },
    },
  },
  {
    name: 'execute',
    description: '通过桌面工具中已经连接的低权限 SSH 会话执行非交互命令。命令会先经过每项目危险命令策略，命中时直接拦截且不会发送到服务器。不能登录、不能提供密码。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'contextToken', 'command'],
      properties: {
        projectId: { type: 'string' },
        contextToken: { type: 'string' },
        command: { type: 'string', minLength: 1, maxLength: 16384 },
        workingDirectory: { type: 'string', minLength: 1, maxLength: 4096 },
      },
    },
  },
  {
    name: 'upload',
    description: '通过当前 SSH 会话把 Markdown 文档中指定的本地普通文件流式上传到服务器。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'contextToken', 'localPath', 'remotePath'],
      properties: {
        projectId: { type: 'string' },
        contextToken: { type: 'string' },
        localPath: { type: 'string', minLength: 1, maxLength: 4096 },
        remotePath: { type: 'string', minLength: 1, maxLength: 4096 },
      },
    },
  },
  {
    name: 'download',
    description: '通过当前 SSH 会话下载 Markdown 中指定的日志或普通文件，保存到项目 downloads 目录。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'contextToken', 'remotePath'],
      properties: {
        projectId: { type: 'string' },
        contextToken: { type: 'string' },
        remotePath: { type: 'string', minLength: 1, maxLength: 4096 },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case 'list_projects': {
        const projects = await store.list();
        let statuses = {};
        let desktopVersion = null;
        try {
          const [currentStatuses, info] = await Promise.all([
            callBroker(dataRoot, 'statuses', {}, 2_000),
            callBroker(dataRoot, 'info', {}, 2_000),
          ]);
          statuses = currentStatuses;
          desktopVersion = info.version;
        } catch {
          // Reading project metadata is available while the desktop app is closed.
        }
        result = {
          mcpVersion: MCP_VERSION,
          desktopVersion,
          versionMismatch: Boolean(desktopVersion && desktopVersion !== MCP_VERSION),
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            server: `${project.ssh.username}@${project.ssh.host}:${project.ssh.port}`,
            connected: Boolean(statuses[project.id]?.connected),
            commandPolicyEnabled: project.commandPolicy?.enabled !== false,
          })),
        };
        break;
      }
      case 'open_project': {
        const context = await store.readContext(args.projectId);
        let operationContext = null;
        let desktopVersion = null;
        let desktopIncompatible = false;
        try {
          desktopVersion = (await callBroker(dataRoot, 'info', {}, 2_000)).version;
        } catch (error) {
          desktopIncompatible = error instanceof AppError && error.code === 'METHOD_NOT_FOUND';
          if (!(error instanceof AppError) || !['METHOD_NOT_FOUND', 'DESKTOP_UNAVAILABLE'].includes(error.code)) throw error;
        }
        const versionMismatch = Boolean(desktopVersion && desktopVersion !== MCP_VERSION);
        if (!context.truncated && !desktopIncompatible && !versionMismatch) {
          try {
            operationContext = await callBroker(
              dataRoot,
              'openContext',
              { projectId: args.projectId, expectedDocsHash: context.docsHash },
              3_000,
            );
          } catch (error) {
            if (!(error instanceof AppError) || !['SSH_NOT_CONNECTED', 'DESKTOP_UNAVAILABLE'].includes(error.code)) throw error;
          }
        }
        result = {
          projectId: context.config.id,
          name: context.config.name,
          mcpVersion: MCP_VERSION,
          desktopVersion,
          versionMismatch: versionMismatch || desktopIncompatible,
          server: `${context.config.ssh.username}@${context.config.ssh.host}:${context.config.ssh.port}`,
          connected: Boolean(operationContext),
          commandPolicy: {
            enabled: context.config.commandPolicy?.enabled !== false,
            customDenyCount: context.config.commandPolicy?.customDeny?.length ?? 0,
          },
          contextToken: operationContext?.contextToken ?? null,
          documents: context.documents,
          documentNames: context.documentNames,
          truncated: context.truncated,
          authorizationBlocked: context.truncated ? 'DOCUMENTS_TRUNCATED' : null,
          message: operationContext
            ? '项目文档已读取，可以使用 contextToken 执行操作。'
            : desktopIncompatible || versionMismatch
              ? '桌面工具与 MCP 版本不一致，未授予服务器操作权限；请升级并重新启动 Codex。'
            : context.truncated
              ? '项目文档总量超过读取限制，未授予服务器操作权限；请精简文档后重新打开项目。'
            : '项目文档已读取，但项目尚未连接；请用户在桌面工具中点击连接。',
        };
        break;
      }
      case 'execute':
        result = await callBroker(dataRoot, 'execute', args);
        break;
      case 'upload':
        result = await callBroker(dataRoot, 'upload', args, 30 * 60 * 1000);
        break;
      case 'download':
        result = await callBroker(dataRoot, 'download', args, 10 * 60 * 1000);
        break;
      default:
        throw new AppError('METHOD_NOT_FOUND', '未知 MCP 工具。');
    }
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (error) {
    const publicError = toPublicError(error);
    return {
      isError: true,
      content: [{ type: 'text', text: `${publicError.code}: ${publicError.message}` }],
      structuredContent: { ok: false, error: publicError },
    };
  }
});

await store.init();
await server.connect(new StdioServerTransport());
