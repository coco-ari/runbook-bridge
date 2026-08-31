# shadcn/Radix Renderer CSP 兼容性决策

> 日期：2026-08-29
>
> 状态：已采用
>
> 范围：正式 React Renderer 源入口 `renderer/v2/index.html`，构建产物 `renderer-build/v2/index.html`

## 决策

React Renderer 采用以下样式策略：

    style-src 'self' 'unsafe-inline'

此例外仅用于兼容 shadcn/ui 与 Radix primitives 的运行时样式，包括：

- 浮层和 portal 定位。
- 拖动、尺寸和碰撞计算结果。
- 运行时 CSS 变量。
- 组件注入的 `<style>` 块。
- React `style` 属性。

## 保持不变的边界

- `script-src` 继续只有 `'self'`，不允许脚本 `unsafe-inline`。
- 不允许 `unsafe-eval`。
- `connect-src` 继续为 `'none'`。
- 不允许外部脚本、外部样式、远程字体或 CDN。
- `contextIsolation: true`。
- `sandbox: true`。
- `nodeIntegration: false`。
- preload、IPC、Service、operation gate 和确认绑定不变。
- 唯一正式源码入口是 `renderer/v2/index.html`，Electron 加载 Vite 生成的 `renderer-build/v2/index.html`。

## 风险接受

允许内联样式会削弱 CSP 对 CSS 注入的限制，但不会授权执行内联 JavaScript。该取舍由本地桌面产品的 shadcn/Radix 完整兼容目标驱动，并已获得用户明确授权。

Renderer 仍必须把远程日志、配置、文件内容和命令输出当作不可信文本，不得使用未净化的 `dangerouslySetInnerHTML` 渲染。

## 验证

`scripts/ui-react-foundation-smoke.cjs` 必须同时验证：

1. React Renderer 可以应用动态 `style` 属性。
2. 组件可以注入运行时 `<style>` 块。
3. `script-src` 不包含 `unsafe-inline` 或 `unsafe-eval`。
4. 外部请求为 0。
5. sandbox、context isolation 和 node integration 基线保持。

入口切换已完成。`test/renderer-foundation-contract.test.mjs` 和 `test/renderer-app-shell-contract.test.mjs` 校验源码策略；`scripts/packaged-ui-smoke.cjs` 校验正式构建产物。重新验证步骤见 [验证指南](full-function-verification.md)。变更 CSP 必须同时复核这些测试，不能只调整样式策略而遗漏脚本与网络边界。
