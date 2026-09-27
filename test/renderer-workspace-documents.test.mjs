import assert from 'node:assert/strict';
import test from 'node:test';
import {selectDocument,reconcileDocuments,swapDocumentPanes} from '../renderer/v2/src/features/server-workspace/workspace-documents.ts';

test('单栏切换文件只改变显示，不改变其他文档标识',()=>{
  const view={active:'terminal',panes:['terminal'],layout:'single'};
  assert.deepEqual(selectDocument(view,'file'),{active:'file',panes:['file'],layout:'single'});
  assert.deepEqual(view.panes,['terminal']);
});
test('分屏点击已显示文档只切换焦点，新文档替换当前窗格',()=>{
  const view={active:'terminal',panes:['terminal','file'],layout:'horizontal'};
  const focused=selectDocument(view,'file');
  assert.deepEqual(focused.panes,['terminal','file']);
  assert.deepEqual(selectDocument(focused,'docker'),{active:'docker',panes:['terminal','docker'],layout:'horizontal'});
  assert.equal(selectDocument(focused,'file'),focused);
});
test('关闭分屏中的文档后保留另一侧并恢复单栏',()=>{
  const view={active:'file',panes:['terminal','file'],layout:'vertical'};
  assert.deepEqual(reconcileDocuments(view,['terminal','other'],['terminal','file','other']),{active:'terminal',panes:['terminal'],layout:'single'});
  assert.deepEqual(reconcileDocuments(view,['file','other'],['terminal','file','other']),{active:'file',panes:['file'],layout:'single'});
});
test('关闭单栏当前文件选择相邻文件，关闭后台标签不改变布局',()=>{
  const view={active:'file2',panes:['file2'],layout:'single'};
  assert.deepEqual(reconcileDocuments(view,['terminal','file1'],['terminal','file1','file2']),{active:'file1',panes:['file1'],layout:'single'});
  assert.equal(reconcileDocuments(view,['file2'],['terminal','file2']),view);
  assert.deepEqual(reconcileDocuments(view,[],['file2']),{active:null,panes:[],layout:'single'});
});
test('交换左右或上下只改变窗格位置，当前文档不变，再次交换恢复顺序',()=>{
  for (const layout of ['horizontal','vertical']) {
    const view={active:'file',panes:['terminal','file'],layout};
    const swapped=swapDocumentPanes(view);
    assert.deepEqual(swapped,{active:'file',panes:['file','terminal'],layout});
    assert.deepEqual(swapDocumentPanes(swapped),view);
    assert.deepEqual(selectDocument(swapped,'other').panes,['other','terminal']);
    assert.deepEqual(view.panes,['terminal','file']);
  }
});
test('单栏或缺少第二个文档时交换不改变状态',()=>{
  for(const view of [{active:'file',panes:['file'],layout:'single'},{active:null,panes:[],layout:'single'},{active:'file',panes:['file'],layout:'horizontal'}]) assert.equal(swapDocumentPanes(view),view);
});
