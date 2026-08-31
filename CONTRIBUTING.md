# 参与贡献

感谢你帮助改进 RunbookBridge。

## 开发环境

- Windows 10/11
- Node.js 22 或更新版本
- pnpm（通过 Corepack 使用）

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

行为变更先运行对应的 `test/*.test.mjs`，再运行：

```powershell
pnpm run check
pnpm test
```

修改 Renderer、preload/IPC、连接编辑、确认或快捷提问时还需运行 `corepack pnpm run test:ui`；跨功能或发布验证运行 `corepack pnpm run test:ui:all`。仅修改文档时运行 `git diff --check` 并核实文档路径和命令，无需完整应用测试。打包与安装回归的适用范围、隔离环境要求见 [测试与交付验证指南](docs/full-function-verification.md)。

## 仓库维护

先阅读 [AGENTS.md](AGENTS.md)、[当前架构](docs/architecture.md) 和 [仓库专项整治条例](docs/repository-cleanup.md)。清理必须基于实际调用关系，不能根据文件名含旧版本、draft 或 legacy 就删除迁移和恢复代码。

编辑 Renderer 源码，不提交 `renderer-build/`、`dist/`、日志、测试截图或本地数据。只在依赖图变化时更新锁文件；保留依赖补丁及其回归依据。不顺带更改版本或兼容身份；历史发布说明统一保留在 [CHANGELOG.md](CHANGELOG.md)，不再维护重复的阶段报告、原型和版本说明副本。

## Pull Request 要求

- 一个 PR 聚焦一个问题；
- 新功能或 Bug 修复应附带自动化测试；
- 不提交真实服务器地址、项目日志、凭据、私钥或个人项目文档；
- 修改 SSH、MCP、凭据、命令策略或文件传输代码时，应说明安全边界变化；
- 不要弱化主机指纹校验、上下文令牌或默认命令防护而不明确说明风险。

## Issue

普通 Bug 和功能建议可以使用公开 Issue。安全漏洞请遵循 [SECURITY.md](SECURITY.md)，不要公开披露敏感细节。
