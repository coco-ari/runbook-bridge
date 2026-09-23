const assert = require('node:assert/strict');

// 性能原始记录只在内存解析；输出限于浏览器计数和仓库脚本位置，不保存页面或终端正文。
module.exports = async function rendererProfiler(win) {
  const driver = win.webContents.debugger, attached = driver.isAttached();
  if (!attached) driver.attach('1.3');
  await driver.sendCommand('Performance.enable');
  await driver.sendCommand('Profiler.enable');
  await driver.sendCommand('Profiler.setSamplingInterval', { interval: 1000 });
  let active = null;
  const reports = [];
  const round = value => Math.round(value * 10) / 10;
  const metrics = async () => Object.fromEntries((await driver.sendCommand('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  function summarize(profile) {
    assert.ok(profile.nodes.length < 20000 && (profile.samples?.length ?? 0) < 100000, '性能采样必须有界');
    const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map(), values = new Map();
    for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
    const keyFor = id => {
      const frame = nodes.get(id)?.callFrame ?? {};
      const fn = frame.functionName && /^[\w$ .:<>-]{1,100}$/u.test(frame.functionName) ? frame.functionName : ['(idle)', '(program)', '(garbage collector)', '(root)'].includes(frame.functionName) ? frame.functionName : '(anonymous)';
      const asset = frame.url?.match(/\/assets\/([\w-]+\.js)$/u)?.[1] ?? 'runtime';
      const key = [fn, asset, frame.lineNumber, frame.columnNumber].join(':');
      if (!values.has(key)) values.set(key, { fn, asset, line: (frame.lineNumber ?? -1) + 1, column: (frame.columnNumber ?? -1) + 1, selfMs: 0, inclusiveMs: 0 });
      return key;
    };
    for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
      let id = profile.samples[index]; const duration = (profile.timeDeltas?.[index] ?? 1000) / 1000;
      values.get(keyFor(id)).selfMs += duration;
      // 同一递归函数在一条采样栈中只计一次总耗时，避免汇总超过采样时长。
      const counted = new Set();
      for (let depth = 0; id !== undefined && depth < profile.nodes.length; depth += 1) {
        const key = keyFor(id);
        if (!counted.has(key)) { values.get(key).inclusiveMs += duration; counted.add(key); }
        id = parents.get(id);
      }
    }
    const listed = [...values.values()].filter(item => !['(idle)', '(root)'].includes(item.fn));
    const top = field => [...listed].sort((a, b) => b[field] - a[field]).slice(0, 12).map(item => ({ ...item, selfMs: round(item.selfMs), inclusiveMs: round(item.inclusiveMs) }));
    return { samples: profile.samples?.length ?? 0, topSelf: top('selfMs'), topInclusive: top('inclusiveMs') };
  }
  return {
    async start(label) { assert.ok(!active); active = { label, before: await metrics() }; await driver.sendCommand('Profiler.start'); },
    async stop() {
      assert.ok(active); const { label, before } = active; active = null;
      const { profile } = await driver.sendCommand('Profiler.stop'); const after = await metrics();
      const result = { label, durationsMs: Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(name => [name, round((after[name] - before[name]) * 1000)])),
        counts: Object.fromEntries(['LayoutCount', 'RecalcStyleCount'].map(name => [name, after[name] - before[name]])), ...summarize(profile) };
      reports.push(result); process.stdout.write(JSON.stringify({ rendererProfile: result }) + '\n');
    },
    reports: () => reports,
    async dispose() {
      try { if (active) { await driver.sendCommand('Profiler.stop'); active = null; } await driver.sendCommand('Profiler.disable'); await driver.sendCommand('Performance.disable'); }
      finally { if (!attached && driver.isAttached()) driver.detach(); }
    },
  };
};
