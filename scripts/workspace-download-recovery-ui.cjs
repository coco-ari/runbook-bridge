const assert = require('node:assert/strict');

module.exports = async ({evaluate,click,until,snapshot,downloadReveals,downloadRetries,setJobs}) => {
  const has = selector => 'Boolean(document.querySelector(' + JSON.stringify(selector) + '))';
  const failed={jobId:'failed-download',direction:'download',name:'release.tar',path:'/srv/release.tar',localPath:'D:/下载/release.tar',bytes:400000,transferred:0,status:'error',canRemove:true,message:'模拟下载失败'};
  assert.equal(await evaluate("document.querySelector('.server-upload-tray-header button').getAttribute('aria-expanded')"),'false','传输摘要默认折叠');
  setJobs([failed,{...failed,jobId:'active-upload',direction:'upload',name:'active.bin',path:'/srv/active.bin',status:'running',bytes:100000000}]);
  await until(has('[aria-label="重新下载 release.tar"]'),'新失败展开');
  assert.ok(await evaluate("const text=document.querySelector('.server-upload-tray-header').textContent;text.includes('进行中')&&text.includes('失败')"),'失败不会被活动任务计数遮住');
  await click('[aria-label="重新下载 release.tar"]'); assert.deepEqual(downloadRetries,['failed-download']);
  await until(has('[aria-label="打开 release.tar 的本地位置"]'),'重试完成');
  assert.equal(await evaluate("document.querySelectorAll('.server-upload-row').length"),2,'重试与后续轮询不增加任务行');
  assert.equal(await evaluate("document.querySelector('.server-upload-task-heading strong').textContent"),'release.tar','重试保留原列表位置');
  assert.equal(await evaluate("document.querySelector('.server-upload-row').textContent.includes('模拟下载失败')"),false,'清除旧失败信息');
  await click('[aria-label="打开 release.tar 的本地位置"]'); assert.equal(downloadReveals.length,1);
  await snapshot('ssh-download-recovery.png');
  setJobs([]);
};
