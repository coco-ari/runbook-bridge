const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function exerciseAuditHistory({win,scope,root,dataRoot,ipcMain,registerRead,click,clickText,fill,waitFor,screenshotRoot}) {
  const { AuditHistory } = await import(pathToFileURL(path.join(root,'src/audit-history.mjs')).href);
  const { workspaceInternals } = await import(pathToFileURL(path.join(root,'src/workspace-store.mjs')).href);
  const history = new AuditHistory();
  const file = path.join(dataRoot,'audit-ui-fixture.jsonl');
  const base = {...scope,pluginInstanceId:'fixture-server',pluginNameSnapshot:'应用服务器',actor:'agent',pluginType:'server'};
  const rows = [];
  for (let index = 0; index < 260; index++) {
    const item = {...base,operationId:`fixture-${index}`,capability:'fs.find',auditTarget:index === 0 ? '/fixture/history-oldest.log' : `/fixture/logs/file-${index}.log`,time:new Date(Date.UTC(2026,8,23,1,0,index)).toISOString()};
    rows.push({...item,type:'plugin-operation-started',result:'started'},{...item,type:'plugin-operation',result:'success',durationMs:120});
  }
  rows.push({...base,type:'plugin-operation',operationId:'desktop-query',actor:'user',pluginType:'mysql',pluginNameSnapshot:'测试数据库',capability:'select',auditAction:'mysql.select',auditTarget:'固定数据库 fixture',result:'success',time:'2026-09-23T02:00:00Z'});
  const approval = {...base,confirmationId:'fixture-confirmation',capability:'service.control',auditAction:'service.restart',auditTarget:'fixture.service',time:'2026-09-23T03:00:00Z'};
  rows.push({...approval,type:'plugin-operation-decision',result:'pending-confirmation'},
    {...approval,type:'confirmation-approved',actor:'user',result:'success'},
    {...approval,type:'plugin-operation-started',operationId:'approved-execution',result:'started'},
    {...approval,type:'plugin-operation',operationId:'approved-execution',result:'error',errorCode:'SERVICE_CONTROL_FAILED',durationMs:3000});
  fs.writeFileSync(file,rows.map(row => JSON.stringify(row)).join('\n')+'\n');
  ipcMain.removeHandler('v2:audit-list');
  registerRead('v2:audit-list',payload => history.list(file,payload,workspaceInternals.readLinesReverse));
  await click(win,'[data-testid="audit-refresh-trigger"]');
  await waitFor(win,'document.querySelectorAll("[data-audit-operation]").length === 50','首批完整操作');
  await click(win,'[data-testid="audit-load-more"]');
  await waitFor(win,'document.querySelectorAll("[data-audit-operation]").length === 100','加载更多完整操作');
  const ids = await win.webContents.executeJavaScript('[...document.querySelectorAll("[data-audit-operation]")].map(item=>item.dataset.auditOperation)',true);
  assert.equal(new Set(ids).size,100,'分页不能重复操作');
  await win.webContents.executeJavaScript('document.querySelector("[data-feature=audit] [data-radix-scroll-area-viewport]").scrollTop=300',true);
  fs.appendFileSync(file,JSON.stringify({...base,type:'runbook-updated',actor:'user',result:'success',time:'2026-09-23T04:00:00Z'})+'\n');
  win.webContents.send('v2:workspace-changed',{...scope,type:'audit-appended'});
  await waitFor(win,'document.querySelector("[data-feature=audit]").textContent.includes("操作记录有更新")','历史阅读期间提示新记录');
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-audit-operation]").length',true),100);
  assert.ok(await win.webContents.executeJavaScript('document.querySelector("[data-feature=audit] [data-radix-scroll-area-viewport]").scrollTop > 200',true));
  await fill(win,'input[aria-label="搜索操作记录"]','history-oldest.log');
  await waitFor(win,'document.querySelectorAll("[data-audit-operation]").length === 1 && document.querySelector("[data-audit-operation]").textContent.includes("history-oldest.log")','搜索超过 200 条的历史');
  await fill(win,'input[aria-label="搜索操作记录"]','');
  await click(win,'[aria-label="筛选参与方"]');
  await clickText(win,'用户','[role="listbox"]');
  await waitFor(win,'document.querySelectorAll("[data-audit-operation]").length === 3','用户筛选包含人工审批');
  const queryActor = await win.webContents.executeJavaScript('[...document.querySelectorAll("[data-audit-operation] summary")].find(item=>item.textContent.includes("执行只读查询"))?.textContent',true);
  assert.ok(queryActor.includes('用户') && !queryActor.includes('Agent'),'人工数据库查询归属用户');
  await waitFor(win,'document.querySelector("[role=listbox]") === null','参与方菜单关闭');
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',true);
  await win.webContents.executeJavaScript('[...document.querySelectorAll("[data-audit-operation] summary")].find(item=>item.textContent.includes("重启服务")).focus()',true);
  await waitFor(win,'document.activeElement?.matches("[data-audit-operation] summary") === true','审批操作获得键盘焦点');
  // 原生 summary 的 Enter 激活需要字符事件，模拟完整按键序列。
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await waitFor(win,'document.querySelector("details[open] [data-audit-detail]")?.textContent.includes("用户批准操作") === true','键盘展开审批过程');
  const processText = await win.webContents.executeJavaScript('document.querySelector("details[open] [data-audit-detail]").textContent',true);
  assert.ok(processText.includes('开始执行') && processText.includes('SERVICE_CONTROL_FAILED'));
  if (screenshotRoot) {
    fs.mkdirSync(screenshotRoot,{recursive:true});
    const originalSize = win.getContentSize();
    for (const [width,height] of [[1280,820],[960,640]]) {
      win.setContentSize(width,height);
      await new Promise(resolve => setTimeout(resolve,200));
      assert.ok(await win.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth + 1',true),'记录布局无横向溢出');
      fs.writeFileSync(path.join(screenshotRoot,`audit-history-${width}x${height}.png`),(await win.webContents.capturePage()).toPNG());
    }
    win.setContentSize(...originalSize);
  }
  await click(win,'[aria-label="筛选参与方"]');
  await clickText(win,'全部参与方','[role="listbox"]');
  process.stdout.write('操作记录界面通过：来源、审批详情、历史搜索、分页、新记录提示和键盘展开。\n');
}

module.exports = {exerciseAuditHistory};
