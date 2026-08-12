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

提交代码前请运行：

```powershell
pnpm run check
pnpm test
pnpm run test:ui
```

## Pull Request 要求

- 一个 PR 聚焦一个问题；
- 新功能或 Bug 修复应附带自动化测试；
- 不提交真实服务器地址、项目日志、凭据、私钥或个人项目文档；
- 修改 SSH、MCP、凭据、命令策略或文件传输代码时，应说明安全边界变化；
- 不要弱化主机指纹校验、上下文令牌或默认命令防护而不明确说明风险。

## Issue

普通 Bug 和功能建议可以使用公开 Issue。安全漏洞请遵循 [SECURITY.md](SECURITY.md)，不要公开披露敏感细节。
