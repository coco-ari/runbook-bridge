import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const ROOT = fileURLToPath(new URL('../',import.meta.url));
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MAX_BLOCKMAP_BYTES = 16 * 1024 * 1024;

async function fileInfo(file,limit) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error('升级文件必须是大小在限制内的普通文件，不能使用符号链接。');
  const handle = await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) throw new Error('升级文件在读取前发生变化。');
    const hash = crypto.createHash('sha512');
    let size = 0;
    for await (const part of handle.createReadStream({autoClose:false})) {
      size += part.length;
      if (size > limit) throw new Error('升级文件超过大小限制。');
      hash.update(part);
    }
    if (size !== opened.size) throw new Error('升级文件在读取期间发生变化。');
    return {sha512:hash.digest('base64'),size};
  } finally { await handle.close(); }
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory,{recursive:true});
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('升级输出目录不能使用符号链接或特殊文件。');
}

async function copyImmutable(source,directory,name,limit) {
  await fileInfo(source,limit);
  const temporary = path.join(directory,`.prepare-${crypto.randomUUID()}.tmp`);
  const target = path.join(directory,name);
  try {
    await fs.copyFile(source,temporary,constants.COPYFILE_EXCL);
    const info = await fileInfo(temporary,limit);
    try {
      // 文件先完整落盘，再原子加入公开名称；同版本不同内容不能覆盖。
      await fs.link(temporary,target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await fileInfo(target,limit);
      if (previous.size !== info.size || previous.sha512 !== info.sha512) throw new Error('输出目录已存在内容不同的同版本文件，请提升正式版本后重新构建。');
    }
    return {url:name,...info};
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function optionalBlockmap(source,directory,name) {
  try { await fs.lstat(`${source}.blockmap`); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await copyImmutable(`${source}.blockmap`,directory,`${name}.blockmap`,MAX_BLOCKMAP_BYTES);
}

export async function prepareCloudUpdate({root = ROOT,platform = process.platform,arch = process.arch,inputDirectory,outputDirectory,now = new Date()} = {}) {
  if (!['win32','darwin'].includes(platform) || !['x64','arm64',...(platform === 'win32' ? ['ia32'] : [])].includes(arch)) throw new Error('仅支持 Windows 的 x64、arm64、ia32 和 macOS 的 x64、arm64 升级包。');
  const metadata = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  if (metadata.name !== 'runbook-bridge' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(metadata.version ?? '')) throw new Error('软件升级仅发布 runbook-bridge 的稳定三段版本，请先同步正式版本信息。');
  const version = metadata.version;
  const input = path.resolve(inputDirectory ?? path.join(root,'dist'));
  const output = path.resolve(outputDirectory ?? path.join(root,'artifacts','cloud-updates'));
  for (const directory of [output,path.join(output,platform),path.join(output,platform,arch)]) await ensureDirectory(directory);
  const directory = path.join(output,platform,arch);
  const extensions = platform === 'win32' ? ['exe'] : ['zip','dmg'];
  const sources = extensions.map(extension => ({
    source:path.join(input,platform === 'win32' ? `Agent运维工作台 Setup ${version}.exe` : `RunbookBridge-${version}-mac-${arch}.${extension}`),
    name:`RunbookBridge-${version}-${platform}-${arch}.${extension}`,
  }));
  // 先检查所有必需产物，避免把缺少 ZIP 的 macOS 构建声明为可升级版本。
  for (const {source} of sources) await fileInfo(source,MAX_PACKAGE_BYTES);
  const files = [];
  for (const {source,name} of sources) {
    files.push(await copyImmutable(source,directory,name,MAX_PACKAGE_BYTES));
    await optionalBlockmap(source,directory,name);
  }
  const manifest = {product:'runbook-bridge',platform,arch,version,files,path:files[0].url,sha512:files[0].sha512,releaseDate:now.toISOString()};
  const manifestName = platform === 'win32' ? 'latest.yml' : 'latest-mac.yml';
  const target = path.join(directory,manifestName);
  const temporary = path.join(directory,`.prepare-${crypto.randomUUID()}.tmp`);
  try {
    try {
      const previous = await fs.lstat(target);
      if (!previous.isFile() || previous.isSymbolicLink()) throw new Error('已有升级清单不是普通文件，已拒绝替换。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.writeFile(temporary,YAML.stringify(manifest),{flag:'wx'});
    // 安装包及可选 blockmap 全部完成后才替换最新版本清单。
    await fs.rename(temporary,target);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return {directory,manifestName,manifest};
}

function cliOptions(args) {
  const names = {'--platform':'platform','--arch':'arch','--input-dir':'inputDirectory','--output-dir':'outputDirectory'};
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]];
    if (!name || !args[index+1] || args[index+1].startsWith('--') || Object.hasOwn(options,name)) throw new Error('用法：node scripts/prepare-cloud-update.mjs --platform win32|darwin --arch x64|arm64|ia32 [--input-dir dist] [--output-dir artifacts/cloud-updates]');
    options[name] = args[index+1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await prepareCloudUpdate(cliOptions(process.argv.slice(2)));
    console.log(`已准备 ${result.manifest.platform}/${result.manifest.arch} 的 ${result.manifest.version} 升级文件：${result.directory}`);
    console.log('请先部署完整安装包及可选 blockmap，最后原子替换 latest 清单。此命令不会上传或安装软件。');
  } catch (error) {
    console.error(error?.code ? '无法准备软件升级文件，请检查构建产物、输出目录和文件权限。' : error.message);
    process.exitCode = 1;
  }
}
