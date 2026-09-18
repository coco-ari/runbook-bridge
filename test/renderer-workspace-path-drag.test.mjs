import assert from 'node:assert/strict';
import test from 'node:test';
import { canDragWorkspacePath, createWorkspacePathDrag, WORKSPACE_PATH_DRAG_TYPE } from '../renderer/v2/src/features/server-workspace/workspace-path-drag.ts';
import { quoteRemotePath } from '../renderer/v2/src/features/server-workspace/workspace-model.ts';

function transfer() {
  const items = new Map();
  return {
    get types() { return [...items.keys()]; },
    setData(type, value) { items.set(type, value); },
    getData(type) { return items.get(type) ?? ''; },
    clearData() { items.clear(); },
    effectAllowed: 'none',
  };
}

test('拖拽精确保留完整路径，转义 Shell 引号且不添加回车，只能消费一次', () => {
  const drag = createWorkspacePathDrag(), data = transfer();
  const path = "/日志/带 空格'$(echo literal).conf ";
  assert.equal(drag.begin(data, path), true);
  assert.equal(data.effectAllowed, 'copy');
  assert.deepEqual(data.types, [WORKSPACE_PATH_DRAG_TYPE]);
  assert.ok(!data.getData(WORKSPACE_PATH_DRAG_TYPE).includes(path));
  assert.equal(drag.accepts(data), true);
  const result = drag.take(data);
  assert.equal(result, path);
  assert.equal(quoteRemotePath(result), "'/日志/带 空格'\"'\"'$(echo literal).conf '");
  assert.equal(drag.take(data), null);
  assert.equal(drag.accepts(data), false);
});

test('拒绝其他工作区、外部文本、本地文件和伪造的拖拽标识', () => {
  const drag = createWorkspacePathDrag(), data = transfer();
  drag.begin(data, '/srv/example.conf');
  assert.equal(createWorkspacePathDrag().take(data), null);
  const external = transfer();
  external.setData('text/plain', '/etc/example');
  assert.equal(drag.accepts(external), false);
  assert.equal(drag.take(external), null);
  external.setData(WORKSPACE_PATH_DRAG_TYPE, 'forged');
  assert.equal(drag.take(external), null);
  external.setData(WORKSPACE_PATH_DRAG_TYPE, data.getData(WORKSPACE_PATH_DRAG_TYPE));
  external.setData('Files', '');
  assert.equal(drag.accepts(external), false);
  assert.equal(drag.take(external), null);
  assert.equal(drag.take(data), '/srv/example.conf');
});

test('取消、断开或开始下一次拖拽后，旧数据不会延迟插入', () => {
  const drag = createWorkspacePathDrag(), first = transfer(), second = transfer();
  drag.begin(first, '/first');
  drag.clear();
  assert.equal(drag.take(first), null);
  drag.begin(first, '/first');
  drag.begin(second, '/second');
  assert.equal(drag.take(first), null);
  assert.equal(drag.take(second), '/second');
});

test('路径验证拦截终端控制字符和超长输入，保留合法空格、中文及软链接路径', () => {
  for (const value of ['/', '/current/logs', '/中文/尾空格 ', '/' + 'a'.repeat(4095)]) {
    assert.equal(canDragWorkspacePath(value), true);
  }
  const drag = createWorkspacePathDrag(), data = transfer();
  for (const value of ['', 'relative', '/a\nb', '/a\rb', '/a\tb', '/a\0b', '/a\x1bb', '/a\x7fb', '/a\x9bb', '/' + 'a'.repeat(4096)]) {
    assert.equal(canDragWorkspacePath(value), false);
    drag.begin(data, '/previous');
    assert.equal(drag.begin(transfer(), value), false);
    assert.equal(drag.take(data), null);
  }
});
