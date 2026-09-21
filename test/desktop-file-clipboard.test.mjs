import assert from 'node:assert/strict';
import test from 'node:test';
import { readWindowsClipboardFiles } from '../src/desktop-file-clipboard.mjs';

test('Windows 原生文件剪贴板读取使用固定隐藏命令，保留多个中文文件路径', async () => {
  const expected = ['C:\\发布\\a.jar', 'D:\\带 空格\\说明.txt'];
  let command;
  const actual = await readWindowsClipboardFiles({ platform:'win32', execute:async (executable,args,options) => {
    assert.ok(executable.endsWith('\\WindowsPowerShell\\v1.0\\powershell.exe'));
    assert.deepEqual(args.slice(0,4), ['-NoProfile','-NonInteractive','-STA','-EncodedCommand']);
    command = Buffer.from(args[4],'base64').toString('utf16le');
    assert.match(command,/GetFileDropList/u);
    assert.doesNotMatch(command,/Invoke-Expression|Get-Content|Set-Clipboard/u);
    assert.equal(options.windowsHide,true); assert.equal(options.timeout,5000); assert.equal(options.maxBuffer,1024*1024);
    return {stdout:'\uFEFF'+JSON.stringify({files:expected})};
  }});
  assert.deepEqual(actual,expected);
  for(const file of expected) assert.equal(command.includes(file),false);
});

test('没有文件、过量文件、非法结果和读取失败均给出明确提示，不泄露进程输出', async () => {
  for(const [value,code] of [[{files:[]},'UPLOAD_SOURCE_UNAVAILABLE'],[{tooMany:true},'INVALID_ARGUMENT'],[{files:['relative']},'UPLOAD_SOURCE_UNAVAILABLE'],[{files:['C:\\bad\0name']},'UPLOAD_SOURCE_UNAVAILABLE'],[{files:Array(21).fill('C:\\file')},'UPLOAD_SOURCE_UNAVAILABLE']]) {
    await assert.rejects(readWindowsClipboardFiles({platform:'win32',execute:async()=>({stdout:JSON.stringify(value)})}),{code});
  }
  for (const execute of [async()=>({stdout:'invalid-private-output'}),async()=>{throw Error('private process output');}]) {
    await assert.rejects(readWindowsClipboardFiles({platform:'win32',execute}),error => error.code==='CLIPBOARD_UNAVAILABLE' && !error.message.includes('private'));
  }
  await assert.rejects(readWindowsClipboardFiles({platform:'darwin',execute:async()=>assert.fail('非 Windows 不执行脚本')}),{code:'UPLOAD_SOURCE_UNAVAILABLE'});
});
