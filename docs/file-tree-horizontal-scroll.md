# 目录树横向滚动

服务器工作区的目录树保持文件名和符号链接目标单行完整显示。内容超出面板宽度时，目录区域底部出现横向滚动条，可拖动滚动条或使用触控板横向滑动查看名称尾部。顶部工具栏、路径栏与底部传输区保持固定。

内容宽度包含当前已加载且已展开分支的名称、层级缩进和下载按钮。虚拟列表上下滚动不会改变横向范围；展开、收起或刷新目录后重新计算。短名称不产生额外横向滚动。详情列表继续使用原有列布局。

离线回归使用合成目录和隐藏 Electron 窗口：

```powershell
corepack pnpm run build:renderer
$env:RUNBOOK_BRIDGE_TREE_SCROLL_SMOKE = '1'
corepack pnpm exec electron scripts/ui-react-server-workspace-smoke.cjs
Remove-Item Env:RUNBOOK_BRIDGE_TREE_SCROLL_SMOKE
```

覆盖未挂载的长名称、中英文混合文件名、深层目录、链接目标、双向滚动、选择与键盘导航、虚拟窗口宽度稳定、详情视图切换、窄窗口及 125% 缩放。
