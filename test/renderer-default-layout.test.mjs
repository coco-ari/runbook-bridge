import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_SHELL_PANEL_IDS, APP_SHELL_LAYOUT_STORAGE_KEY,
  createDefaultAppShellLayout, isAppShellLayout, readAppShellLayoutState,
} from '../renderer/v2/src/state/layout-state.ts';

test('新布局把宽屏新增空间交给详情，导航保持内容所需宽度', () => {
  const pixels = (width) => {
    const layout = createDefaultAppShellLayout(width);
    assert.equal(isAppShellLayout(layout), true);
    return Object.fromEntries(Object.entries(layout).map(([key, value]) => [key, value / 100 * (width - 2)]));
  };
  const normal = pixels(1280);
  const wide = pixels(1920);
  for (const id of [APP_SHELL_PANEL_IDS.project, APP_SHELL_PANEL_IDS.resource]) {
    assert.ok(Math.abs(normal[id] - wide[id]) < 0.001);
  }
  assert.ok(normal[APP_SHELL_PANEL_IDS.detail] > 700);
  assert.ok(Math.abs(wide[APP_SHELL_PANEL_IDS.detail] - normal[APP_SHELL_PANEL_IDS.detail] - 640) < 0.001);
});

test('无保存布局根据首开窗口计算，有效保存布局和折叠偏好原样恢复', () => {
  const previous = globalThis.window;
  const values = new Map();
  globalThis.window = { innerWidth: 1920, localStorage: { getItem: (key) => values.get(key) ?? null } };
  try {
    const fresh = readAppShellLayoutState();
    assert.deepEqual(fresh.layout, createDefaultAppShellLayout(1920));
    const saved = {
      layout: { [APP_SHELL_PANEL_IDS.project]: 18, [APP_SHELL_PANEL_IDS.resource]: 42, [APP_SHELL_PANEL_IDS.detail]: 40 },
      projectCollapsed: true, detailCollapsed: false,
    };
    values.set(APP_SHELL_LAYOUT_STORAGE_KEY, JSON.stringify(saved));
    assert.deepEqual(readAppShellLayoutState(), saved);
    globalThis.window.innerWidth = 640;
    assert.deepEqual(readAppShellLayoutState(), saved);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('窄窗及损坏记录回退到可展开布局，迁移仍保留旧折叠意图', () => {
  const previous = globalThis.window;
  let stored = '{invalid';
  globalThis.window = { innerWidth: 640, localStorage: { getItem: () => stored } };
  try {
    assert.deepEqual(readAppShellLayoutState().layout, createDefaultAppShellLayout(960));
    stored = JSON.stringify({ layout: { invalid: 100 }, projectSize: 'collapsed', detailSize: 'collapsed' });
    const migrated = readAppShellLayoutState();
    assert.equal(migrated.projectCollapsed, true);
    assert.equal(migrated.detailCollapsed, true);
    assert.equal(isAppShellLayout(migrated.layout), true);
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      assert.deepEqual(createDefaultAppShellLayout(width), createDefaultAppShellLayout(1280));
    }
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
