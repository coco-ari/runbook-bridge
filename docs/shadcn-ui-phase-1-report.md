# shadcn/ui 重构阶段 1 交付报告

> 对应计划：docs/shadcn-ui-full-rewrite-plan.md
>
> 基线：docs/shadcn-ui-phase-0-baseline.md
>
> 执行日期：2026-08-29
>
> 结论：通过。独立 React Renderer 基础已经建立，正式 UI、preload、IPC、Service 和安全边界保持不变。

## 1. 完成内容

阶段 1 已接入：

- React 19 和 React DOM。
- TypeScript 严格检查。
- Vite 本地生产构建。
- Tailwind CSS v4 Vite 插件。
- shadcn/ui 配置、class 合并工具和本地 Button 源组件。
- Phosphor 单一图标家族。
- 跟随系统的深浅主题、语义 token、Segoe UI/Cascadia 字体基线。
- focus-visible、disabled、active 和 reduced-motion 基线。
- 全部 58 项 window.aiOps.v2 的严格 TypeScript 公共面。
- 独立 Electron foundation smoke。
- preload 同步合同和 Renderer 安全合同测试。

新 Renderer 只显示基础诊断壳，并在用户点击后调用一次只读的
workspaceOverview 验证 preload。它不渲染项目、环境、插件、确认或其他业务页面。

## 2. 独立入口与构建边界

    renderer/v2/react.html
            |
            v
    renderer/v2/src/main.tsx
            |
            v
    renderer/v2/src/app/App.tsx

    Vite 输出：
    renderer-build/v2/

renderer-build/ 已加入 .gitignore，生成文件不提交。

正式应用仍保持：

    src/main.mjs
            |
            v
    renderer/v2/index.html
            |
            v
    renderer/v2/app.js + styles.css

start、正式 test:ui、dist 和 Electron Builder build.files 没有切换到新入口。

## 3. 文件变更

### 3.1 修改

| 文件 | 变更 |
| --- | --- |
| .gitignore | 忽略 renderer-build/ |
| package.json | 增加阶段 1 依赖和 next Renderer 的检查、构建、smoke 脚本 |
| pnpm-lock.yaml | 仅随依赖图更新 |

### 3.2 新增配置与源文件

| 文件 | 职责 |
| --- | --- |
| renderer/v2/react.html | 独立 HTML 入口和严格 CSP |
| renderer/v2/vite.config.ts | 相对本地资产和仓库外输出 |
| renderer/v2/tsconfig.json | 严格 TypeScript 配置和 @/* alias |
| renderer/v2/components.json | shadcn/ui 配置 |
| renderer/v2/src/main.tsx | React 根挂载 |
| renderer/v2/src/app/App.tsx | 最小 foundation 页面和只读 preload 验证 |
| renderer/v2/src/app/providers.tsx | 系统主题和本地错误边界 |
| renderer/v2/src/bridge/ai-ops-v2.ts | 58 项 API 类型、结果类型和存在性校验 |
| renderer/v2/src/types/global.d.ts | Window.aiOps.v2 声明 |
| renderer/v2/src/lib/utils.ts | shadcn class 合并工具 |
| renderer/v2/src/components/ui/button.tsx | 最小本地 shadcn Button |
| renderer/v2/src/styles/globals.css | Tailwind、token、主题、字体、焦点和减弱动效 |

### 3.3 新增验证

| 文件 | 验证 |
| --- | --- |
| test/renderer-bridge-contract.test.mjs | preload、TypeScript interface 和运行时名称数组均为同一组 58 项 |
| test/renderer-foundation-contract.test.mjs | 独立入口、CSP、安全窗口参数、构建边界、shadcn 和主题基线 |
| scripts/ui-react-foundation-smoke.cjs | 隔离 Electron 中的本地资产、React 挂载、preload、CSP、焦点和无外部请求 |

## 4. 依赖说明

### 4.1 应用依赖

| 依赖 | 用途 |
| --- | --- |
| react、react-dom | 新 Renderer 组件树 |
| @radix-ui/react-slot | shadcn Button 的 asChild 组合能力 |
| class-variance-authority | shadcn 组件变体 |
| clsx、tailwind-merge | class 合并和冲突消解 |
| tw-animate-css | shadcn 后续交互 primitive 的本地动画 utilities |
| @phosphor-icons/react | 单一图标家族，避免手写 SVG 和混用图标 |

### 4.2 构建依赖

| 依赖 | 用途 |
| --- | --- |
| typescript、React/Node 类型包 | 严格类型检查 |
| vite、@vitejs/plugin-react | 本地 Renderer 构建 |
| tailwindcss、@tailwindcss/vite | Tailwind v4 Vite 集成 |

没有增加全局状态库、表单库、请求库、动画框架或第二套设计系统。

## 5. preload API 合同

AiOpsV2Api 明确声明全部 58 项方法和订阅：

- 每个调用都有具体 payload 类型。
- IPC 返回统一为 IpcResult<T>，错误使用当前 code/message/details 公共结构。
- 事件订阅返回 Unsubscribe。
- notifyNetworkChanged 保持单向 void。
- 类型文件不使用 any。
- 敏感返回值只在 CredentialRevealData 中声明为瞬时字符串，不在 bridge 中读取、缓存、日志或渲染。
- getAiOpsV2 只校验 58 个函数是否存在，返回原始 preload 对象，不代理或改变参数。

同步测试保存了一份明确的 58 项兼容清单，同时比较：

1. src/preload.cjs 的真实公开键。
2. AiOpsV2Api 的 TypeScript 方法。
3. AI_OPS_V2_API_NAMES 的运行时校验清单。

三者任何一方增删或改名都会失败。

## 6. 安全与兼容性结果

| 合同 | 结果 |
| --- | --- |
| 正式 loadFile() 仍指向旧 index.html | 保持 |
| contextIsolation: true | 保持 |
| nodeIntegration: false | 保持 |
| sandbox: true | 保持 |
| 窗口最小尺寸 960×640 | 保持 |
| CSP 不含 unsafe-inline、unsafe-eval 或外部资产 | 通过 |
| Renderer 只通过 window.aiOps.v2 调用应用 API | 通过 |
| foundation smoke 外部网络请求 | 0 |
| preload、IPC、V2 Service | 未修改 |
| 产品名、版本、CLI、MCP、数据目录、pipe 名称 | 未修改 |
| Builder 正式文件清单 | 未修改 |
| legacy renderer 和 src/mcp.mjs tombstone | 未恢复 |

## 7. 测试结果

| 命令 | 结果 |
| --- | --- |
| corepack pnpm run check:renderer:next | 通过 |
| corepack pnpm run build:renderer:next | 通过 |
| node --test 两项阶段 1 合同测试 | 2/2 通过 |
| corepack pnpm run test:ui:renderer-next | 通过，React renderer foundation smoke passed |
| corepack pnpm run check | 通过 |
| corepack pnpm test | 484/484 通过，0 失败、取消、跳过或 TODO |
| corepack pnpm run test:ui | 通过，Three-pane UI smoke passed |

构建基线：

    renderer-build/v2/react.html                  0.70 kB
    renderer-build/v2/assets/react-*.css         18.24 kB
    renderer-build/v2/assets/react-*.js         237.34 kB
    gzip 后 JavaScript                          75.06 kB

哈希文件名由 Vite 生成，不纳入源代码合同。

## 8. 执行中发现并解决的问题

### 8.1 TypeScript 7 移除 baseUrl

第一轮检查报告 baseUrl 已被移除。已删除该选项并保留 TypeScript 7
支持的相对 paths 映射。最终严格检查通过。

### 8.2 Windows 临时 userData 锁

第一轮 Electron smoke 功能断言通过，但进程退出前 Chromium 仍锁定临时
userData，同进程清理产生 EPERM 警告。已对齐现有 UI smoke 的 app.exit()
退出方式，最终运行无警告。

### 8.3 payload 类型校准

根据现有 Renderer 的真实调用补齐了 Host Key challenge、validation cancel、
probe cancel、prepare edit 和 restore-pre-edit-set 保存策略字段。未修改运行时
payload 或 preload。

## 9. 最终失败项

无。

## 10. 阶段 2 前置条件

阶段 2 可以开始，但必须继续满足：

1. 只在独立 react.html 入口实现三栏 App Shell。
2. 继续使用模拟数据，不接入项目、环境和插件真实业务请求。
3. 不修改 src/main.mjs、preload、IPC、Service 和正式打包入口。
4. 不放宽 CSP，不加载 CDN、远程字体、远程图标或远程样式。
5. 保持 DESIGN_VARIANCE: 3、MOTION_INTENSITY: 2、VISUAL_DENSITY: 8。
6. 实现项目栏、资源栏、详情栏、两处分隔线、双侧折叠和独立滚动。
7. 覆盖无项目、空项目、多环境、多插件、长名称和主要运行状态的 fixture。
8. 增加 960×640、1280×820 和宽屏行为测试。
9. 保留 skip link、键盘选择、可见焦点和 reduced-motion。
10. 新旧 Renderer 的专项 smoke、完整测试和旧 UI smoke 必须同时通过。

建议阶段 2 文件边界：

    renderer/v2/src/app/App.tsx
    renderer/v2/src/components/app-shell/*
    renderer/v2/src/components/project-rail/*
    renderer/v2/src/components/resource-pane/*
    renderer/v2/src/components/detail-workspace/*
    renderer/v2/src/components/ui/*
    renderer/v2/src/state/layout-state.ts
    renderer/v2/src/fixtures/app-shell-fixtures.ts
    renderer/v2/src/styles/globals.css
    scripts/ui-react-foundation-smoke.cjs
    test/renderer-app-shell-contract.test.mjs

阶段 2 不应新增 projects、environments、plugins 等真实业务 feature 模块。
