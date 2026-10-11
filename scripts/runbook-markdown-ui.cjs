const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {nativeTheme} = require('electron');

async function exerciseRunbookMarkdown(win,{clickText,click,fill,waitFor,setExactViewport,screenshotRoot}) {
  const feature = '[data-feature="runbook"]';
  const editor = 'textarea[aria-label="当前环境运维说明"]';
  const content = [
    '# 示例环境说明', '', '## 日常检查', '', '**只读检查**，*记录结果*，`status`，~~旧步骤~~。', '',
    '- 检查服务', '  - 记录状态', '- [x] 已验证', '- [ ] 待复核', '',
    '1. 查看状态', '2. 读取日志', '', '> 操作前确认环境。', '',
    '[监控入口](https://example.invalid/status)', '', '![架构示意](https://example.invalid/diagram.png)', '',
    '<img src="https://example.invalid/pixel" onerror="window.runbookInjected=true">', '',
    '```sh', `echo ${'long-command-'.repeat(90)}`, '```', '',
    `| ${Array.from({length:12},(_,i) => `列${i+1}`).join(' | ')} |`,
    `| ${Array(12).fill('---').join(' | ')} |`,
    `| ${Array(12).fill('只读示例').join(' | ')} |`, '',
    '普通文本第一行\n普通文本第二行',
  ].join('\n');
  await clickText(win,'编辑',feature);
  await fill(win,editor,content);
  await clickText(win,'预览',feature);
  const rendered = `${feature} [data-testid="runbook-markdown"]`;
  await waitFor(win,`document.querySelector(${JSON.stringify(rendered)})?.querySelector('h1')?.textContent === '示例环境说明'`,'Markdown draft preview');
  const previewHtml = await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(rendered)}).innerHTML`,true);
  await clickText(win,'继续编辑',feature);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(editor)}).value`,true),content,'preview preserves Markdown source');
  await clickText(win,'预览',feature);
  await clickText(win,'保存',feature);
  await waitFor(win,`![...document.querySelectorAll('${feature} button')].some(button => button.textContent.trim() === '保存')`,'save from preview');
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(rendered)}).innerHTML`,true),previewHtml,'read view and preview render identically');
  await waitFor(win,`document.querySelector('[data-sonner-toast]') === null`,'save toast settles before layout evidence');

  for (const theme of ['light','dark']) {
    nativeTheme.themeSource = theme;
    await waitFor(win,`document.documentElement.dataset.theme === '${theme}'`,`${theme} theme`);
    for (const width of [960,1280]) {
      await setExactViewport(win,width,820);
      const metrics = await win.webContents.executeJavaScript(`(() => {
        const root = document.querySelector(${JSON.stringify(rendered)});
        const pre = root.querySelector('pre');
        const table = root.querySelector('.runbook-markdown-table');
        const body = root.querySelector('p');
        return {
          headings:root.querySelectorAll('h1,h2').length,
          strong:root.querySelector('strong')?.textContent,
          quote:root.querySelector('blockquote')?.textContent.trim(),
          nestedList:!!root.querySelector('ul ul'),
          nestedListGap:root.querySelector('ul ul').getBoundingClientRect().top - root.querySelector('ul > li').getBoundingClientRect().top,
          lineHeight:parseFloat(getComputedStyle(root).lineHeight),
          tasks:[...root.querySelectorAll('input')].map(input => ({checked:input.checked,disabled:input.disabled})),
          activeElements:root.querySelectorAll('img,a,script,iframe,object').length,
          injected:window.runbookInjected === true,
          codeOverflow:pre.scrollWidth > pre.clientWidth,
          tableOverflow:table.scrollWidth > table.clientWidth,
          contentFits:root.scrollWidth <= root.clientWidth + 1,
          pageFits:document.documentElement.scrollWidth <= window.innerWidth + 1,
          headingSize:parseFloat(getComputedStyle(root.querySelector('h1')).fontSize),
          bodySize:parseFloat(getComputedStyle(body).fontSize),
          codeFont:getComputedStyle(pre.querySelector('code')).fontFamily,
          color:getComputedStyle(root).color,
          expectedColor:getComputedStyle(document.querySelector('${feature}')).color,
          listStyle:getComputedStyle(root.querySelector('ul')).listStyleType,
        };
      })()`,true);
      assert.equal(metrics.headings,2);
      assert.equal(metrics.strong,'只读检查');
      assert.equal(metrics.quote,'操作前确认环境。');
      assert.equal(metrics.nestedList,true);
      assert.ok(metrics.nestedListGap < metrics.lineHeight * 2,'nested lists must not introduce blank lines');
      assert.deepEqual(metrics.tasks,[{checked:true,disabled:true},{checked:false,disabled:true}]);
      assert.equal(metrics.activeElements,0);
      assert.equal(metrics.injected,false);
      assert.equal(metrics.codeOverflow,true);
      assert.equal(metrics.tableOverflow,true);
      assert.equal(metrics.contentFits,true);
      assert.equal(metrics.pageFits,true);
      assert.ok(metrics.headingSize > metrics.bodySize);
      assert.match(metrics.codeFont,/mono/iu);
      assert.equal(metrics.color,metrics.expectedColor);
      assert.equal(metrics.listStyle,'disc');
      if (screenshotRoot) {
        fs.mkdirSync(screenshotRoot,{recursive:true});
        fs.writeFileSync(path.join(screenshotRoot,`runbook-markdown-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`(() => {
          const root = document.querySelector(${JSON.stringify(rendered)});
          const viewport = root.closest('[data-slot="scroll-area-viewport"]');
          viewport.scrollTop = viewport.scrollHeight;
        })()`,true);
        await waitFor(win,`document.querySelector(${JSON.stringify(rendered)}).querySelector('pre').getBoundingClientRect().bottom < window.innerHeight`,'code block scrolled into view');
        fs.writeFileSync(path.join(screenshotRoot,`runbook-markdown-${theme}-${width}-code.png`),(await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(rendered)}).closest('[data-slot="scroll-area-viewport"]').scrollTop = 0`,true);
      }
    }
  }

  await clickText(win,'编辑',feature);
  await waitFor(win,`document.querySelector(${JSON.stringify(editor)})?.value === ${JSON.stringify(content)}`,'reopening editor resets preview');
  await fill(win,editor,'# 尚未保存的草稿');
  await clickText(win,'预览',feature);
  await clickText(win,'放弃编辑',feature);
  await click(win,'[data-testid="runbook-discard-confirm"]');
  await waitFor(win,`document.querySelector(${JSON.stringify(rendered)})?.querySelector('h1')?.textContent === '示例环境说明'`,'discard preserves saved content');
  await clickText(win,'编辑',feature);
  await waitFor(win,`document.querySelector(${JSON.stringify(editor)})?.value === ${JSON.stringify(content)}`,'discard resets preview');
  await clickText(win,'放弃编辑',feature);
  return content;
}

module.exports = {exerciseRunbookMarkdown};
