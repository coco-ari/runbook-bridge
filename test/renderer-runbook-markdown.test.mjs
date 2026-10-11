import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {renderRunbookMarkdown} from '../renderer/v2/src/features/runbooks/runbook-markdown.ts';

const render = (source) => renderToStaticMarkup(renderRunbookMarkdown(source));

test('Runbook Markdown renders common formatting and GFM as semantic elements',() => {
  const html = render([
    '# 环境说明', '', '## 排查步骤', '', '**重点**与*提示*、~~旧说明~~和 `status`。', '',
    '> 只读检查', '', '- 第一项', '  - 子项', '', '1. 检查状态', '2. 读取日志', '',
    '- [x] 已验证', '- [ ] 待检查', '', '```sh', 'echo "<ready>"', '```', '',
    '| 服务 | 状态 |', '| --- | --- |', '| 示例 | 正常 |', '', '---',
  ].join('\n'));
  for (const fragment of [
    '<h1>环境说明</h1>', '<h2>排查步骤</h2>', '<strong>重点</strong>', '<em>提示</em>',
    '<del>旧说明</del>', '<code>status</code>', '<blockquote>', '<ul>', '<ol>', '<li>子项</li>',
    'type="checkbox" disabled="" checked=""', 'type="checkbox" disabled=""',
    '<pre tabindex="0" aria-label="代码块"><code class="language-sh">echo &quot;&lt;ready&gt;&quot;',
    '<table>', '<th>服务</th>', '<td>正常</td>', '<hr/>',
  ]) assert.ok(html.includes(fragment),fragment);
});

test('Runbook Markdown keeps ordinary text and code literal',() => {
  assert.equal(render('第一行\n第二行\n\n下一段'),'<p>第一行\n第二行</p>\n<p>下一段</p>');
  const html = render('```html\n<script>alert(1)</script>\n# 不是标题\n```');
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.ok(html.includes('# 不是标题'));
  assert.doesNotMatch(html,/<script|<h1/u);
});

test('Runbook Markdown never renders executable HTML, navigable links or resource-loading images',() => {
  const html = render([
    '<script>alert(1)</script>', '', '<img src="https://example.invalid/pixel" onerror="alert(1)">', '',
    '[监控](https://example.invalid/status)', '', 'https://example.invalid/status', '',
    '[执行](javascript:alert%281%29)', '', '[文件](file:///tmp/example)', '',
    '![架构](https://example.invalid/diagram.png)', '', '![内联](data:image/svg+xml;base64,PHN2Zz4=)',
  ].join('\n'));
  assert.doesNotMatch(html,/<(?:script|img|a|iframe|object|link)\b|<[^>]+\s(?:href|src)=/u);
  assert.match(html,/&lt;script&gt;/u);
  assert.ok(html.includes('监控'));
  assert.ok(html.includes('（https://example.invalid/status）'));
  assert.ok(html.includes('[图片：架构]'));
  assert.ok(html.includes('[图片：内联]'));
  assert.doesNotMatch(html,/javascript:|file:\/\/\//u);
});

test('oversized Runbook drafts stay literal and do not enter the Markdown parser',() => {
  const source = '# 超限草稿\n' + '运维'.repeat(11_000) + '\n<script>alert(1)</script>';
  const html = render(source);
  assert.match(html,/^<pre class="runbook-markdown-plain"># 超限草稿/u);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html,/<h1|<script/u);
});
