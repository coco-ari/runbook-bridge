const assert = require('node:assert/strict');
const crypto = require('node:crypto');

module.exports = async function liveTerminalUi({ evaluate, until, wait, win, setViewport, probe }) {
  assert.ok(win.isVisible() && !win.isMinimized()); win.focus(); win.webContents.focus();
  const samples = [];
  const profiler = process.env.RUNBOOK_BRIDGE_TERMINAL_PROFILE === '1' ? await require('./server-renderer-profiler.cjs')(win) : null;
  const profiledLabels = new Set(['new-terminal-tab', 'switch-tab-1', 'multiline-paste-review', 'search-1200-lines']);
  const panel = '.server-terminal-tab-panel:not([hidden])';
  const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const rows = q(panel + ' .xterm-rows');
  const contains = text => '(' + rows + ')?.textContent.includes(' + JSON.stringify(text) + ')';
  const named = text => '[...document.querySelectorAll(' + JSON.stringify(panel + ' button') + ')].find(item=>item.textContent.trim()===' + JSON.stringify(text) + ' && item.getClientRects().length)';
  const first = probe.snapshot().sessions[0].sessionId;
  async function mainUntil(check) {
    const untilAt = Date.now() + 10000;
    while (!check()) { assert.ok(Date.now() < untilAt, '真实终端后台等待超时'); await wait(10); }
  }
  async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
  async function mouse(element) {
    await until('Boolean(' + element + ') && !(' + element + ').disabled', '终端操作控件');
    await evaluate('(' + element + ').scrollIntoView({block:"nearest"})'); await settle();
    const point = await evaluate('(()=>{const r=(' + element + ').getBoundingClientRect();return{x:Math.round(r.left+Math.min(70,r.width/2)),y:Math.round(r.top+r.height/2)}})()');
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
  function key(keyCode, modifiers = [], char) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }
  function typeAscii(text) { assert.match(text, /^[\x20-\x7e]*$/u); for (const character of text) key(character.toUpperCase(), [], character); }
  async function focus() { await evaluate(q(panel + ' .xterm-helper-textarea') + '.focus()'); win.focus(); win.webContents.focus(); await settle(); }
  async function measure(label, action, done) {
    if (profiler && profiledLabels.has(label)) await profiler.start(label);
    await evaluate(`(()=>{
      window.terminalSample=new Promise((resolve,reject)=>{
        let start,trusted,finished=false,previous,gap=0,frame,hidden=document.visibilityState!=='visible';
        const visibility=()=>{hidden ||= document.visibilityState!=='visible'};document.addEventListener('visibilitychange',visibility);
        const types=['click','keydown','beforeinput','input'];
        const event=e=>{if(start===undefined){start=performance.now();trusted=e.isTrusted}};
        const clear=()=>{observer.disconnect();types.forEach(type=>document.removeEventListener(type,event,true));clearTimeout(timer);cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',visibility)};
        const check=()=>{if(start===undefined||finished||!(${done}))return;finished=true;const ms=performance.now()-start;requestAnimationFrame(()=>requestAnimationFrame(()=>{const twoFramesMs=performance.now()-start;clear();resolve({trusted,ms,twoFramesMs,maxFrameGap:gap,hiddenDuringSample:hidden,focused:document.hasFocus()})}))};
        const tick=now=>{if(start!==undefined&&previous!==undefined)gap=Math.max(gap,now-previous);previous=now;check();frame=requestAnimationFrame(tick)};
        const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,attributes:true,childList:true,characterData:true});
        const timer=setTimeout(()=>{clear();reject(new Error('可见终端响应超时'))},10000);types.forEach(type=>document.addEventListener(type,event,true));frame=requestAnimationFrame(tick);
      });
    })()`);
    await action();
    const result = { label, ...await evaluate('window.terminalSample') }; samples.push(result);
    if (profiler && profiledLabels.has(label)) await profiler.stop();
    process.stdout.write(JSON.stringify({ terminalUiStep: label, ...result }) + '\n');
    assert.equal(result.trusted, true);
    // 远端往返在组网链路上单独记录；本地操作保留原阈值，不能用网络等待掩盖本地停顿。
    const local = /^(?:switch-tab-|search-|multiline-paste-(?:review|cancel)|manual-close)/u.test(label);
    assert.ok(result.ms < (local ? 2000 : 10000), '终端操作应在观察上限内完成');
  }
  async function clearLine(sessionId) { probe.expect(sessionId, '\x15'); await focus(); key('U', ['control']); await mainUntil(() => !probe.snapshot().pendingInput); await wait(30); }
  async function command(sessionId, label, commandText, token) {
    probe.expect(sessionId, commandText + '\r'); await focus();
    typeAscii(commandText);
    await mainUntil(() => probe.snapshot().pendingInput === 1);
    await measure(label, () => key('Enter'), contains(token));
    await mainUntil(() => !probe.snapshot().pendingInput && probe.hasOutput(sessionId, token));
  }
  function marker(prefix = 'ui-result-') {
    const suffix = crypto.randomBytes(5).toString('hex');
    return { token: prefix + suffix, command: "printf '%s%s\\n' '" + prefix + "' '" + suffix + "'" };
  }
  try {
    for (let index = 0; index < 5; index += 1) {
      const text = 'echo' + index;
      probe.expect(first, text); await focus();
      await measure('input-echo-' + (index + 1), () => { for (const character of text) key(character.toUpperCase(), [], character); }, contains(text));
      await mainUntil(() => !probe.snapshot().pendingInput); await clearLine(first);
      const item = marker(); await command(first, 'command-roundtrip-' + (index + 1), item.command, item.token);
    }
    const firstMarker = marker('ui-first-'); await command(first, 'first-tab-marker', firstMarker.command, firstMarker.token);
    await measure('new-terminal-tab', () => mouse(q('[aria-label="新增终端"]')), contains('probe>') + ' && document.querySelectorAll(".server-terminal-tab-panel").length===2');
    await mainUntil(() => probe.snapshot().sessions.length === 2);
    const second = probe.snapshot().sessions.find(item => item.sessionId !== first).sessionId;
    const secondMarker = marker('ui-second-'); await command(second, 'second-tab-marker', secondMarker.command, secondMarker.token);
    assert.ok(!probe.hasOutput(first, secondMarker.token)); assert.ok(!probe.hasOutput(second, firstMarker.token));
    for (let index = 0; index < 6; index += 1) {
      const number = index % 2 === 0 ? 1 : 2, token = number === 1 ? firstMarker.token : secondMarker.token;
      await measure('switch-tab-' + (index + 1), () => mouse(q('[role="tab"][title="终端 ' + number + '"]')), contains(token));
    }
    await mouse(q('[role="tab"][title="终端 1"]')); await focus();

    const clipboardEnabled = probe.snapshot().clipboardSupported;
    if (clipboardEnabled) {
      const item = marker('ui-中文-'); probe.setClipboard(item.command); probe.expect(first, '\x1b[200~' + item.command + '\x1b[201~');
      await measure('clipboard-paste-unicode', () => key('V', ['control']), contains('ui-中文-'));
      await mainUntil(() => !probe.snapshot().pendingInput); assert.ok(!probe.hasOutput(first, item.token));
      probe.expect(first, '\r'); await measure('clipboard-command-execute', () => key('Enter'), contains(item.token));
      await mainUntil(() => !probe.snapshot().pendingInput);
      const one = marker('ui-multi-one-'), two = marker('ui-multi-two-'), multiline = one.command + '\n' + two.command;
      const before = probe.snapshot().writeBytes;
      probe.setClipboard(multiline); await focus();
      await measure('multiline-paste-review', () => key('V', ['control']), 'Boolean(document.querySelector("[role=dialog]"))');
      assert.equal(probe.snapshot().writeBytes, before);
      const dialogButton = label => '[...document.querySelectorAll("[role=dialog] button")].find(item=>item.textContent.trim()===' + JSON.stringify(label) + ')';
      await measure('multiline-paste-cancel', () => mouse(dialogButton('取消')), '!document.querySelector("[role=dialog][data-state=open]")');
      await until('!document.querySelector("[role=dialog]")', '粘贴取消完成'); assert.equal(probe.snapshot().writeBytes, before);
      await focus(); key('V', ['control']); await until('document.querySelector("[role=dialog]")', '重新打开粘贴确认');
      probe.expect(first, '\x1b[200~' + multiline.replace(/\n/g, '\r') + '\x1b[201~');
      await measure('multiline-paste-confirm', () => mouse(dialogButton('确认粘贴整段')), contains('ui-multi-two-'));
      await mainUntil(() => !probe.snapshot().pendingInput); assert.ok(!probe.hasOutput(first, one.token) && !probe.hasOutput(first, two.token));
      probe.expect(first, '\r'); await focus(); await measure('multiline-paste-execute', () => key('Enter'), contains(one.token) + ' && ' + contains(two.token));
      await mainUntil(() => !probe.snapshot().pendingInput);
    }
    const bulk = marker('ui-bulk-done-');
    await command(first, 'render-1200-lines', "for ((ui_i=0; ui_i<1200; ui_i++)); do printf 'ui-match-%04d\\n' \"$ui_i\"; done; " + bulk.command, bulk.token);
    const beforeSearch = probe.snapshot().writeBytes;
    await focus(); await measure('search-open', () => key('F', ['control']), 'Boolean(' + q(panel + ' [aria-label="搜索终端内容"]') + ')');
    await until(q(panel + ' [aria-label="搜索终端内容"]') + '===document.activeElement', '搜索输入焦点');
    await measure('search-1200-lines', () => win.webContents.insertText('ui-match-'), q(panel + ' .server-terminal-search-count') + '?.textContent.includes("1000+")');
    assert.equal(probe.snapshot().writeBytes, beforeSearch, '搜索不会发送终端命令');
    const previousResult = await evaluate(q(panel + ' .server-terminal-search-count') + '.textContent');
    await measure('search-next', () => mouse(q(panel + ' [aria-label="下一个匹配"]')), q(panel + ' .server-terminal-search-count') + '?.textContent!==' + JSON.stringify(previousResult));
    if (clipboardEnabled) {
      const input = q(panel + ' [aria-label="搜索终端内容"]'); await mouse(input); key('A', ['control']); await win.webContents.insertText(bulk.token);
      await until(q(panel + ' .server-terminal-search-count') + '?.textContent==="1 / 1"', '定位合成文本选区');
      probe.expectCopy(bulk.token); await mouse(named('复制')); await mainUntil(() => probe.snapshot().clipboardCopies === 1);
    }
    await measure('search-close', () => mouse(q(panel + ' [aria-label="关闭终端搜索"]')), '!' + q(panel + ' [aria-label="搜索终端内容"]'));
    await focus();

    const resizeSamples = [];
    if (profiler) await profiler.start('continuous-resize');
    await evaluate('(()=>{window.terminalResizeFrames=[];let previous;const tick=now=>{if(previous!==undefined)window.terminalResizeFrames.push(now-previous);previous=now;window.terminalResizeFrame=requestAnimationFrame(tick)};window.terminalResizeFrame=requestAnimationFrame(tick)})()');
    const beforeResize = probe.snapshot().events.filter(item => item.method === 'resizeTerminal').length;
    for (let index = 0; index < 12; index += 1) {
      win.setContentSize(1440 - 25 * index, 920 - 10 * index); await wait(18);
      resizeSamples.push(await evaluate('(()=>{const c=document.querySelector(' + JSON.stringify(panel + ' .server-terminal-container') + '),s=c.querySelector(".xterm-screen");return{container:c.clientWidth,screen:s.getBoundingClientRect().width}})()'));
    }
    await until("innerWidth===1165 && innerHeight===810", "连续调整后的原生窗口最终尺寸");
    await settle(); await wait(250);
    const resizeFrames = await evaluate('(()=>{cancelAnimationFrame(window.terminalResizeFrame);const values=window.terminalResizeFrames;delete window.terminalResizeFrames;delete window.terminalResizeFrame;return values})()');
    if (profiler) await profiler.stop();
    const maxOverflow = Math.max(...resizeSamples.map(item => Math.max(0, item.screen - item.container)));
    const changedWidths = new Set(resizeSamples.map(item => item.screen)).size;
    assert.ok(changedWidths >= 4 && resizeSamples.filter(item => item.screen - item.container > 64).length <= 1, '连续调整窗口时终端排版应跟随尺寸变化');
    const resizeEvents = probe.snapshot().events.filter(item => item.method === 'resizeTerminal').slice(beforeResize);
    assert.ok(resizeEvents.length > 0);
    const lastSize = resizeEvents.at(-1);
    const size = marker('ui-size-done-'); await command(first, 'pty-size-confirm', 'stty size; ' + size.command, size.token);
    const reportedSize = probe.lastReportedSize(first);
    if (!reportedSize || reportedSize.rows !== lastSize.rows || reportedSize.cols !== lastSize.cols) process.stdout.write(JSON.stringify({ resizeMismatch: true, expected: { rows: lastSize.rows, cols: lastSize.cols }, actual: reportedSize, tail: probe.snapshot().events.filter(item => item.method === 'resizeTerminal').slice(-3), resizeSamples, maxOverflow, changedWidths, maxFrameGap: Math.max(...resizeFrames) }) + '\n');
    assert.deepEqual(reportedSize, { rows: lastSize.rows, cols: lastSize.cols }, '远端 PTY 接收最终尺寸');
    await setViewport(1440, 920);
    const exit = 'exit 0\r'; probe.expect(second, exit);
    await mouse(q('[role="tab"][title="终端 2"]')); await focus(); typeAscii('exit 0'); await mainUntil(() => probe.snapshot().pendingInput === 1);
    await measure('remote-exit', () => key('Enter'), contains('终端会话已结束（退出码 0）'));
    await mainUntil(() => probe.snapshot().sessions.find(item => item.sessionId === second).status === 'closed');
    await mouse(q('[aria-label="关闭终端 2"]')); await until('document.querySelectorAll(".server-terminal-tab-panel").length===1', '关闭已退出标签');
    await measure('manual-close', () => mouse(named('结束会话')), contains('人工终端会话已结束'));
    await mainUntil(() => probe.snapshot().sessions.every(item => item.status === 'closed'));
    assert.equal(probe.snapshot().pendingInput, 0);
    assert.ok(!await evaluate('document.querySelector(".server-terminal-pane [role=alert]")'));
    return { visible: win.isVisible(), profiles: profiler?.reports() ?? [], samples, resize: { samples: resizeSamples, maxOverflow, changedWidths, maxFrameGap: Math.max(...resizeFrames), remoteUpdates: resizeEvents.length },
      clipboard: clipboardEnabled ? 'native-paste-copy-passed' : 'skipped-unsupported-existing-formats',
      ...probe.snapshot() };
  } finally { await profiler?.dispose(); await evaluate('cancelAnimationFrame(window.terminalResizeFrame); delete window.terminalResizeFrame; delete window.terminalResizeFrames; delete window.terminalSample'); }
};
