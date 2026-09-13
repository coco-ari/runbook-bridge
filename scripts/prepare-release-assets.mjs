import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname,'..');
const manifest = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
if (!['win32','darwin'].includes(platform) || !['x64','arm64'].includes(arch)) throw new Error('无效的发布平台或架构。');
const output = path.join(root,'artifacts','release',platform + '-' + arch);
await fs.mkdir(output,{recursive:true});
const names = platform === 'win32'
  ? [[manifest.build.productName + ' Setup ' + manifest.version + '.exe','RunbookBridge-Setup-' + manifest.version + '.exe']]
  : ['dmg','zip'].map(ext => {
    const name = 'RunbookBridge-' + manifest.version + '-mac-' + arch + '.' + ext;
    return [name,name];
  });
for (const [input,name] of names) {
  const content = await fs.readFile(path.join(root,'dist',input));
  await fs.writeFile(path.join(output,name),content);
  await fs.writeFile(path.join(output,name + '.sha256'),createHash('sha256').update(content).digest('hex') + '  ' + name + '\n');
}
console.log('已准备发布附件：' + platform + ' / ' + arch);
