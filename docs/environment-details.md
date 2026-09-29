# 环境详情快捷操作

环境详情集中展示当前环境的连接摘要和插件列表。插件行同时提供连接操作与工作区入口，无需先进入插件详情。

- 名称下面显示插件类型，状态旁显示依赖或异常说明；点击插件名称仍可查看配置和诊断。
- 未连接时可连接，连接中可按现有流程取消，异常时可重试，已连接时可断开。连接沿用既有依赖处理和主机指纹确认流程。
- Server、MySQL、Redis 在配置及当前连接状态可用时提供工作区入口；未连接或状态读取失败时禁用入口。
- 已保留会话显示“继续工作区”。从环境详情打开的工作区返回后，仍停留在环境详情并恢复到对应按钮，原页面滚动位置和会话内容保留。
- MySQL 沿用单插件工作区策略，切换其他插件或环境时按既有范围规则释放原会话；工作区的关闭、事务及编辑保护仍由原组件处理。
- 打开环境详情、刷新状态和连接成功都不会自动进入工作区。
- 窄面板将插件操作放到下一行，按钮保持可见。

验证使用隔离夹具，不连接真实基础设施：

```powershell
node --test test/plugin-workspace-registry.test.mjs test/renderer-environment-detail-model.test.mjs
corepack pnpm run check
corepack pnpm test
corepack pnpm run test:ui
corepack pnpm run test:ui:database
corepack pnpm run test:ui:plugins
```
