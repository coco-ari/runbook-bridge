#!/usr/bin/env node
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProjectStore } from './project-store.mjs';
import { defaultDataRoot } from './paths.mjs';
import { callBroker } from './broker-client.mjs';
import { AppError, toPublicError } from './errors.mjs';

const dataRoot = defaultDataRoot();
const store = new ProjectStore(dataRoot);
const MCP_VERSION = '0.3.2';
const clientInstanceId = crypto.randomBytes(16).toString('hex');
const BATCH_OUTPUT_LIMIT_BYTES = 1024 * 1024;
// ProjectStore caps remote command execution at 3600 seconds. Keep the local
// Broker IPC wait slightly longer so it never reports a failure while the
// authoritative Broker is still executing the command.
const COMMAND_BROKER_TIMEOUT_MS = 3600 * 1000 + 30_000;

const instructions = `这是一个个人 SSH 运维工具。首次操作项目、contextToken 过期或项目文档变化后，必须调用 open_project 读取最新项目文档；文档和连接未变化时，可在返回的 expiresAt 之前复用同一 contextToken。必须遵守项目文档中的部署流程、路径和限制。execute 和 execute_batch 中的每条命令都会经过桌面 Broker 的危险命令策略，命中规则时不能尝试改写、混淆或绕过。连续 2 到 10 个无需根据中间输出重新决策的命令应优先使用 execute_batch；需要先分析上一步结果再决定下一步时仍使用 execute。不得要求用户在对话中提供服务器密码、私钥口令或代理密码。不得尝试通过 MCP 建立新的 SSH 连接；项目未连接时，提示用户在桌面工具中点击连接。upload 和 download 只传文件路径，不要把二进制内容放进参数。`;

function validateExecuteBatchArgs(args) {
  const allowedRootKeys = new Set(['projectId', 'contextToken', 'commands', 'stopOnError']);
  if (Object.keys(args).some((key) => !allowedRootKeys.has(key))) {
    throw new AppError('INVALID_ARGUMENT', '批量执行包含不支持的参数。');
  }
  if (typeof args.projectId !== 'string' || args.projectId.length < 2 || args.projectId.length > 63) {
    throw new AppError('INVALID_ARGUMENT', '项目标识无效。');
  }
  if (typeof args.contextToken !== 'string' || !args.contextToken) {
    throw new AppError('INVALID_ARGUMENT', '项目操作令牌无效。');
  }
  if (!Array.isArray(args.commands) || args.commands.length < 1 || args.commands.length > 10) {
    throw new AppError('INVALID_ARGUMENT', '批量执行需要包含 1 到 10 条命令。');
  }
  if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') {
    throw new AppError('INVALID_ARGUMENT', 'stopOnError 必须是布尔值。');
  }
  const commands = args.commands.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new AppError('INVALID_ARGUMENT', `第 ${index + 1} 条命令格式无效。`);
    }
    const allowedStepKeys = new Set(['command', 'workingDirectory']);
    if (Object.keys(step).some((key) => !allowedStepKeys.has(key))) {
      throw new AppError('INVALID_ARGUMENT', `第 ${index + 1} 条命令包含不支持的参数。`);
    }
    if (typeof step.command !== 'string' || !step.command.trim() || step.command.length > 16_384) {
      throw new AppError('INVALID_ARGUMENT', `第 ${index + 1} 条命令为空或过长。`);
    }
    if (
      step.workingDirectory !== undefined &&
      (typeof step.workingDirectory !== 'string' || !step.workingDirectory.trim() || step.workingDirectory.length > 4096)
    ) {
      throw new AppError('INVALID_ARGUMENT', `第 ${index + 1} 条命令的工作目录无效。`);
    }
    return {
      command: step.command,
      ...(step.workingDirectory !== undefined ? { workingDirectory: step.workingDirectory } : {}),
    };
  });
  return { commands, stopOnError: args.stopOnError !== false };
}

function takeUtf8(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString('utf8'), bytes: buffer.length, truncated: false };
  }
  if (maxBytes <= 0) return { text: '', bytes: 0, truncated: buffer.length > 0 };
  let end = maxBytes;
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  const text = buffer.subarray(0, end).toString('utf8');
  return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated: true };
}

function capBatchOutput(result, remainingBytes) {
  // Diagnostics are usually more actionable than ordinary output when the
  // aggregate batch response reaches its limit, so preserve stderr first.
  const stderr = takeUtf8(result.stderr, remainingBytes);
  const stdout = takeUtf8(result.stdout, Math.max(0, remainingBytes - stderr.bytes));
  return {
    result: {
      ...result,
      stdout: stdout.text,
      stderr: stderr.text,
      batchOutputTruncated: stdout.truncated || stderr.truncated,
    },
    outputBytes: stdout.bytes + stderr.bytes,
    outputTruncated: stdout.truncated || stderr.truncated,
  };
}

async function executeBatch(args) {
  const { commands, stopOnError } = validateExecuteBatchArgs(args);
  const batchId = crypto.randomUUID();
  const results = [];
  let outputBytes = 0;
  let outputTruncated = false;
  let stoppedEarly = false;

  for (let index = 0; index < commands.length; index += 1) {
    let failed = false;
    try {
      const execution = await callBroker(dataRoot, 'execute', {
        projectId: args.projectId,
        contextToken: args.contextToken,
        ...commands[index],
      }, COMMAND_BROKER_TIMEOUT_MS);
      const capped = capBatchOutput(execution, Math.max(0, BATCH_OUTPUT_LIMIT_BYTES - outputBytes));
      outputBytes += capped.outputBytes;
      outputTruncated ||= capped.outputTruncated;
      failed = execution.exitCode !== 0;
      results.push({
        index,
        ok: !failed,
        ...capped.result,
        ...(failed
          ? {
              error: {
                code: 'COMMAND_EXIT_NONZERO',
                message: '命令返回了非零退出码。',
                details: {
                  exitCode: execution.exitCode,
                  signal: execution.signal ?? null,
                  operationId: execution.operationId,
                },
              },
            }
          : {}),
      });
    } catch (error) {
      failed = true;
      results.push({ index, ok: false, error: toPublicError(error) });
    }
    if (failed && stopOnError) {
      stoppedEarly = index + 1 < commands.length;
      break;
    }
  }

  return {
    batchId,
    stopOnError,
    requestedCount: commands.length,
    executedCount: results.length,
    stoppedEarly,
    results,
    outputLimitBytes: BATCH_OUTPUT_LIMIT_BYTES,
    outputBytes,
    outputTruncated,
  };
}

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
    description: '读取项目全部 Markdown 操作文档，并在项目已连接时签发服务器操作所需的 contextToken。文档和连接未变化时，同一 MCP 进程会复用未过期令牌。',
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
    name: 'execute_batch',
    description: '通过当前 SSH 会话顺序执行 1 到 10 条命令，减少多步部署或排障的 MCP 往返。每条命令独立经过危险命令检查、超时和审计，不共享 Shell 状态；默认遇到策略拦截、执行错误或非零退出码就停止。仅在后续步骤不需要根据中间输出重新决策时使用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'contextToken', 'commands'],
      properties: {
        projectId: { type: 'string', minLength: 2, maxLength: 63 },
        contextToken: { type: 'string', minLength: 1 },
        commands: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['command'],
            properties: {
              command: { type: 'string', minLength: 1, maxLength: 16384 },
              workingDirectory: { type: 'string', minLength: 1, maxLength: 4096 },
            },
          },
        },
        stopOnError: { type: 'boolean', default: true },
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
  {
    name: 'search_logs',
    description: '对项目文档中记录的一个或多个明确服务器日志文件执行受限的字面量搜索。支持 AND/OR、前后文、截断说明和短期分页游标；不在服务器执行 grep。首次搜索传绝对文件路径 files 和 keywords；翻页只需传 cursor。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'contextToken'],
      properties: {
        projectId: { type: 'string' },
        contextToken: { type: 'string' },
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: { type: 'string', minLength: 1, maxLength: 4096 },
        },
        keywords: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: { type: 'string', minLength: 1, maxLength: 256 },
        },
        keywordMode: { type: 'string', enum: ['AND', 'OR'], default: 'OR' },
        caseSensitive: { type: 'boolean', default: false },
        beforeLines: { type: 'integer', minimum: 0, maximum: 50, default: 3 },
        afterLines: { type: 'integer', minimum: 0, maximum: 50, default: 5 },
        maxMatches: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        maxScanBytes: { type: 'integer', minimum: 65536 },
        pageSize: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
        cursor: { type: 'string', minLength: 32, maxLength: 128 },
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
              {
                projectId: args.projectId,
                expectedDocsHash: context.docsHash,
                expectedSecurityConfigHash: store.securityConfigHash(context.config),
                clientInstanceId,
              },
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
          context: operationContext
            ? {
                generation: operationContext.generation,
                issuedAt: operationContext.issuedAt,
                expiresAt: operationContext.expiresAt,
                remainingSeconds: operationContext.remainingSeconds,
                reused: operationContext.reused,
              }
            : null,
          documents: context.documents,
          documentNames: context.documentNames,
          truncated: context.truncated,
          authorizationBlocked: context.truncated ? 'DOCUMENTS_TRUNCATED' : null,
          message: operationContext
            ? operationContext.reused
              ? `项目文档未变化，已复用操作令牌；有效期至 ${operationContext.expiresAt}。`
              : `项目文档已读取，操作令牌有效期至 ${operationContext.expiresAt}。`
            : desktopIncompatible || versionMismatch
              ? '桌面工具与 MCP 版本不一致，未授予服务器操作权限；请升级并重新启动 Codex。'
            : context.truncated
              ? '项目文档总量超过读取限制，未授予服务器操作权限；请精简文档后重新打开项目。'
            : '项目文档已读取，但项目尚未连接；请用户在桌面工具中点击连接。',
        };
        break;
      }
      case 'execute':
        result = await callBroker(dataRoot, 'execute', args, COMMAND_BROKER_TIMEOUT_MS);
        break;
      case 'execute_batch':
        result = await executeBatch(args);
        break;
      case 'upload':
        result = await callBroker(dataRoot, 'upload', args, 30 * 60 * 1000);
        break;
      case 'download':
        result = await callBroker(dataRoot, 'download', args, 10 * 60 * 1000);
        break;
      case 'search_logs':
        result = await callBroker(dataRoot, 'searchLogs', args, 10 * 60 * 1000);
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
