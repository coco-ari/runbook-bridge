const assert = require('node:assert/strict');
const {version} = require('../package.json');

module.exports = async function exerciseSoftwareUpdate({evaluate,waitFor,pressKey,setHandler,capture = null}) {
  const sources = [
    {repositoryId:'fixture-one',name:'演示云仓库一',origin:'https://updates-one.example.invalid'},
    {repositoryId:'fixture-two',name:'演示云仓库二',origin:'https://updates-two.example.invalid'},
  ];
  let state = {phase:'no-source',currentVersion:version,availableVersion:null,releaseNotes:'',releaseDate:null,progress:null,error:null,checkedAt:null,source:null,sources:[],supported:true};
  const requests = [];
  let finishOpen;
  setHandler(async request => {
    requests.push(request);
    if (request.action === 'source') state = {...state,phase:'idle',source:sources.find(source => source.repositoryId === request.repositoryId)};
    if (request.action === 'check') state = {...state,phase:'available',availableVersion:'99.0.0',releaseNotes:'模拟版本说明\n<script>window.__updateNotesExecuted = true</script>',releaseDate:'2026-10-02T00:00:00.000Z',checkedAt:'2026-10-02T00:00:00.000Z',error:null};
    if (request.action === 'download') state = {...state,phase:'downloading',progress:{percent:25,transferred:256,total:1024}};
    if (request.action === 'cancel') state = {...state,phase:'available',progress:null};
    if (request.action === 'install') state = {...state,phase:'error',error:{code:'UPDATE_WORKSPACE_BUSY',message:'请先结束 SQL 事务和文件传输，再更新。'}};
    if (request.action === 'open-installer') {
      assert.equal(request.downloadId,state.downloadId);
      state = {...state,phase:'opening'};
      await new Promise(resolve => { finishOpen = resolve; });
      state = {...state,phase:'downloaded',installerOpened:true};
    }
    if (request.action === 'reveal-installer') assert.equal(request.downloadId,state.downloadId);
    return state;
  });
  const click = async id => {
    await waitFor(`Boolean(document.querySelector('[data-testid="${id}"]:not(:disabled)'))`,id);
    await evaluate(`(() => { const button=document.querySelector('[data-testid="${id}"]');button.focus();button.click(); })()`);
  };
  const status = async text => waitFor(`document.querySelector('[data-testid="software-update-status"]')?.textContent === ${JSON.stringify(text)}`,text);
  try {
    await click('settings-open');
    await click('settings-about');
    await status('尚未连接云仓库');
    assert.equal(await evaluate('document.querySelector("[data-testid=software-update-check]").disabled'),true);
    assert.ok(requests.every(request => request.action === 'status'),'打开关于页只查询本机状态');

    state = {...state,phase:'source-required',sources};
    await status('请选择更新来源');
    assert.equal(await evaluate('document.querySelector("[data-testid=software-update-check]").disabled'),true);
    await evaluate('document.querySelector("[data-testid=software-update-source]").focus()');
    await pressKey('SPACE');
    await waitFor('Boolean(document.querySelector("[role=option]"))','更新来源选项');
    await waitFor('document.activeElement?.getAttribute("role") === "option"','更新来源选项取得键盘焦点');
    await pressKey('END');
    await waitFor('document.activeElement === [...document.querySelectorAll("[role=option]")].at(-1)','键盘定位最后一个更新来源');
    await pressKey('ENTER');
    await status('尚未检查更新');
    assert.equal(state.source.repositoryId,'fixture-two');
    assert.equal(await evaluate('document.querySelector("[data-testid=software-update-origin]").textContent'),sources[1].origin);
    await click('software-update-check');
    await status('发现新版本');
    assert.equal(await evaluate('document.querySelector("[data-testid=software-update-version]").textContent'),`${version} → 99.0.0`);
    assert.equal(await evaluate('window.__updateNotesExecuted'),undefined,'版本说明作为纯文本显示');
    assert.equal(await evaluate('document.querySelector("[data-testid=software-update-notes] script")'),null);
    await click('software-update-download');
    await status('正在下载更新…');
    await waitFor('document.querySelector("[aria-label=更新下载进度]")?.getAttribute("aria-valuenow") === "25"','下载进度');
    assert.equal(await evaluate('document.querySelector("[data-testid=settings-back]").disabled'),false,'后台下载期间可以离开设置');
    await click('settings-appearance');
    state = {...state,progress:{percent:75,transferred:768,total:1024}};
    await click('settings-about');
    await waitFor('document.querySelector("[aria-label=更新下载进度]")?.getAttribute("aria-valuenow") === "75"','切页后继续展示下载进度');
    assert.equal(requests.filter(request => request.action === 'cancel').length,0,'切页不取消后台任务');
    await click('software-update-cancel');
    await status('发现新版本');
    assert.equal(requests.filter(request => request.action === 'cancel').length,1);
    await click('software-update-download');
    await status('正在下载更新…');
    state = {...state,phase:'downloaded',progress:{percent:100,transferred:1024,total:1024}};
    await status('更新已下载');
    if (capture) await capture();
    await click('software-update-install');
    await waitFor('Boolean(document.querySelector("[data-testid=software-update-confirm]"))','安装确认');
    assert.equal(requests.filter(request => request.action === 'install').length,0,'打开确认对话框不能开始安装');
    assert.match(await evaluate('document.querySelector("[data-testid=software-update-confirm]").textContent'),/SQL 事务和文件传输/u);
    await click('software-update-install-cancel');
    await waitFor('!document.querySelector("[data-testid=software-update-confirm]")','取消安装确认');
    assert.equal(requests.filter(request => request.action === 'install').length,0,'取消确认不安装');
    await click('software-update-install');
    await click('software-update-install-confirm');
    await status('更新暂未完成');
    assert.equal(requests.filter(request => request.action === 'install').length,1,'仅明确确认后发送一次安装请求');
    assert.match(await evaluate('document.querySelector("[data-testid=software-update-error]").textContent'),/SQL 事务/u);
    state = {...state,phase:'downloaded',installationMode:'manual-dmg',downloadId:'synthetic-mac-download',installerOpened:false,error:null};
    await status('更新已下载');
    await waitFor('Boolean(document.querySelector("[data-testid=software-update-open]"))','Mac 打开入口');
    assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=software-update-install]"))'),false,'Mac 不显示重启安装');
    assert.match(await evaluate('document.querySelector("[data-testid=software-update-mac-instructions]").textContent'),/原安装位置.*替换/u);
    await click('software-update-open');
    await status('正在校验并打开安装包…');
    assert.equal(await evaluate('Boolean(document.querySelector("[data-testid=software-update-confirm][data-state=open]"))'),false,'Mac 不进入 Windows 安装确认');
    assert.equal(requests.filter(request => request.action === 'install').length,1,'Mac 不发起自动安装');
    finishOpen();
    await status('更新已下载');
    await waitFor('document.querySelector("[data-testid=software-update-open]")?.textContent.includes("重新打开")','打开后仍可重试');
    assert.match(await evaluate('document.querySelector("[data-testid=software-update-panel]").textContent'),/当前运行版本尚未更新/u);
    await click('software-update-reveal');
    await waitFor('!document.querySelector("[data-testid=software-update-reveal]").disabled','Finder 请求结束');
    assert.equal(requests.filter(request => request.action === 'reveal-installer').length,1);
    if (capture) await capture();
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth && document.querySelector("[data-testid=settings-main]").scrollWidth <= document.querySelector("[data-testid=settings-main]").clientWidth'),true,'更新面板不能产生水平溢出');
    await click('settings-back');
    await waitFor('!document.querySelector("[data-testid=settings-page]")','关闭更新设置');
  } finally { setHandler(null); }
};
