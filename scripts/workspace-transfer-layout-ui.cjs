const assert = require('node:assert/strict');

module.exports = async ({evaluate,click,until,snapshot,setViewport,nativeTheme,setJobs}) => {
  const base = {jobId:'layout-download',name:'archive.tar.gz',path:'/srv/releases/archive.tar.gz',localPath:'D:/Downloads/archive.tar.gz',direction:'download',status:'running',bytes:10000000,transferred:3000000,bytesPerSecond:160000,etaSeconds:44};
  const completed = {...base,jobId:'layout-completed',name:'previous.tar.gz',status:'completed',transferred:10000000};
  const rows = [completed,base,{...base,jobId:'layout-upload',direction:'upload',localPath:undefined,name:'deployment-package.tar.gz',status:'paused',canResume:true}, {...base,jobId:'layout-error',name:'retry.tar.gz',status:'error',message:'模拟传输失败，请重试。'}];
  setJobs(rows);
  await until('document.querySelectorAll(".server-upload-row").length === 4', '失败任务展开传输列表');
  const progress = async () => evaluate(`(() => {
    const summary = document.querySelector('.server-transfer-summary-progress');
    const detail = document.querySelector('[data-status="running"] .server-transfer-meter');
    return {summary:summary.value/summary.max,detail:detail.value/detail.max,label:summary.getAttribute('aria-valuetext'),text:document.querySelector('[data-status="running"] .server-transfer-amount strong').textContent};
  })()`);
  assert.deepEqual(await progress(), {summary:.3,detail:.3,label:'30%',text:'30%'});
  const geometry = async () => evaluate(`(() => {
    const rows = [...document.querySelectorAll('.server-upload-row')];
    return rows.map(row => {
      const r=row.getBoundingClientRect(), p=row.querySelector('progress').getBoundingClientRect(), a=row.querySelector('.server-upload-task-action').getBoundingClientRect();
      return {left:p.left,width:p.width,offset:p.top-r.top,height:r.height,action:a.left,overflow:row.scrollWidth>row.clientWidth};
    });
  })()`);
  const aligned = async () => {
    const boxes = await geometry();
    for (const box of boxes) {
      assert.equal(box.left, boxes[0].left, '所有状态进度左边缘一致');
      assert.equal(box.width, boxes[0].width, '所有状态进度宽度一致');
      assert.equal(box.action, boxes[0].action, '操作列位置一致');
      assert.equal(box.overflow, false, '任务行无横向溢出');
    }
    assert.equal(boxes[0].height, boxes[1].height, '已完成与进行中任务等高');
    assert.equal(boxes[0].offset, boxes[1].offset, '已完成与进行中进度垂直位置一致');
  };
  await aligned();
  await snapshot('transfer-layout-dark.png');
  setJobs([completed,{...base,transferred:6780000}]);
  await until('document.querySelector(".server-transfer-summary")?.textContent.includes("68%")', '进度更新');
  assert.deepEqual(await progress(), {summary:.678,detail:.678,label:'68%',text:'68%'});
  await click('.server-transfer-toggle');
  assert.equal(await evaluate('document.querySelector(".server-upload-list")'), null);
  setJobs([completed,{...base,transferred:8000000}]);
  await until('document.querySelector(".server-transfer-summary")?.textContent.includes("80%")', '折叠状态仍更新进度');
  await click('.server-transfer-toggle');
  assert.deepEqual(await progress(), {summary:.8,detail:.8,label:'80%',text:'80%'});
  setJobs([completed,{...base,status:'completed',transferred:10000000}]);
  await until('!document.querySelector(".server-transfer-summary")', '全部完成后清除活动进度');
  await aligned();
  setJobs([completed,{...base,name:'archive-with-a-very-long-file-name-for-overflow-check.tar.gz',localPath:'D:/Downloads/long-folder-name/'.repeat(6)+'archive.tar.gz'}]);
  await until('document.querySelector("[data-status=running]")', '长路径任务');
  for (const [width,height] of [[1000,760],[760,760],[560,720]]) {
    await setViewport(width,height);
    await aligned();
    assert.ok(await evaluate('document.querySelector(".server-upload-tray").scrollWidth <= innerWidth'), '窄窗口传输栏不溢出');
    await snapshot('transfer-layout-'+width+'.png');
  }
  await setViewport(1440,920);
  const themeStable = theme => '(() => { const probe=document.createElement("span"); probe.style.cssText="color:var(--foreground);transition:none;position:fixed;visibility:hidden"; document.body.append(probe); const stable=getComputedStyle(document.querySelector(".server-upload-task-heading strong")).color===getComputedStyle(probe).color; probe.remove(); return document.documentElement.dataset.theme==='+JSON.stringify(theme)+' && stable; })()';
  nativeTheme.themeSource = 'light';
  await until(themeStable('light'), '浅色主题颜色过渡完成');
  await aligned();
  await snapshot('transfer-layout-light.png');
  nativeTheme.themeSource = 'dark';
  await until(themeStable('dark'), '恢复深色主题');
  setJobs([]);
  await until('document.querySelectorAll(".server-upload-row").length === 0', '清理布局测试任务');
  await click('.server-transfer-toggle');
};
