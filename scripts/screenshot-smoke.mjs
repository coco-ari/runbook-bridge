import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../src/project-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const output = path.resolve(process.argv[2] ?? path.join(appRoot, 'artifacts', 'ui-smoke.png'));
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-ops-ui-'));
await fs.mkdir(path.dirname(output), { recursive: true });
const store = new ProjectStore(dataRoot);
const project = await store.create({
  id: 'order-prod',
  name: '订单系统生产',
  ssh: { host: '192.168.10.20', port: 22, username: 'order-deploy' },
  auth: { type: 'privateKey', privateKeyPath: 'C:\\Users\\me\\.ssh\\id_ed25519' },
  proxy: { type: 'socks5', host: '127.0.0.1', port: 1080, remoteDns: true },
});
await store.createDoc(project.id, 'DEPLOY.md');
await store.saveDoc(project.id, 'DEPLOY.md', '# 部署流程\n\n1. 备份当前 JAR。\n2. 上传新的 JAR 包。\n3. 执行启动脚本。\n4. 检查日志。');
await store.createDoc(project.id, 'LOGS.md');
const packagedExecutable = process.env.AI_OPS_PACKAGED_EXE;
const electron = packagedExecutable || path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electron, packagedExecutable ? [] : ['.'], {
  cwd: appRoot,
  env: {
    ...process.env,
    AI_OPS_DATA_DIR: dataRoot,
    AI_OPS_SCREENSHOT_PATH: output,
    AI_OPS_SCREENSHOT_DIALOG: process.env.AI_OPS_SCREENSHOT_DIALOG ?? '0',
  },
  stdio: 'inherit',
});
const exitCode = await new Promise((resolve) => child.once('exit', resolve));
await fs.rm(dataRoot, { recursive: true, force: true });
if (exitCode !== 0) process.exit(exitCode ?? 1);
console.log(output);
