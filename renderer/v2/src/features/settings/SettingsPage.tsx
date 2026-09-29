import { version as appVersion } from "../../../../../package.json"
import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Cloud, GearSix, GithubLogo, Info, Palette, PlugsConnected } from "@phosphor-icons/react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { ThemeMenu } from "@/components/app-shell/ThemeMenu"
import { Button } from "@/components/ui/button"
import { CloudConfigPanel } from "@/features/cloud-config/CloudConfigPanel"
import { cn } from "@/lib/utils"
import { CodexIntegrationPanel } from "./CodexIntegrationPanel"

const sections = [
  { id: "appearance", title: "外观主题", description: "选择适合你的界面外观，设置会应用到整个工作台。", icon: Palette },
  { id: "agent", title: "Agent 接入", description: "让 Agent 使用工作台中的资源，在这里查看和管理接入状态。", icon: PlugsConnected },
  { id: "cloud", title: "云同步", description: "管理云仓库与项目显示，按项目更新或上传配置。", icon: Cloud },
  { id: "about", title: "关于", description: "查看应用版本与兼容性信息。", icon: Info },
] as const

export function SettingsPage({ api, onBack, onChanged }: {
  readonly api: AiOpsV2Api
  readonly onBack: () => void
  readonly onChanged: () => void
}) {
  const [section, setSection] = useState<(typeof sections)[number]["id"]>("appearance")
  const [cloudVisited, setCloudVisited] = useState(false)
  const [cloudBusy, setCloudBusy] = useState(false)
  const [agentBusy, setAgentBusy] = useState(false)
  const busy = cloudBusy || agentBusy
  const [repositoryError, setRepositoryError] = useState("")
  const openRepository = async () => {
    setRepositoryError("")
    try {
      const result = await api.openRepository()
      if (!result.ok) setRepositoryError(result.error.message)
    } catch { setRepositoryError("无法打开浏览器，请复制下方仓库地址访问。") }
  }
  const current = sections.find(item => item.id === section)!
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }) }, [section])

  return <div className="absolute inset-0 z-50 flex min-h-0 min-w-0 flex-col bg-background sm:flex-row" data-testid="settings-page">
    <aside className="flex shrink-0 flex-col border-b bg-sidebar p-3 sm:w-52 sm:border-r sm:border-b-0" aria-label="应用设置导航">
      <div className="hidden h-12 items-center gap-2 px-2 text-sm font-semibold sm:flex"><GearSix size={20} />应用设置</div>
      <Button className="justify-start sm:my-4" variant="ghost" size="sm" disabled={busy} data-testid="settings-back" onClick={onBack}><ArrowLeft />返回工作台</Button>
      <p className="mt-2 mb-2 hidden px-2 text-xs text-muted-foreground sm:block">应用配置</p>
      <nav className="grid grid-cols-2 gap-1 sm:flex sm:flex-col">
        {sections.map(item => <Button key={item.id} data-settings-nav className="justify-start aria-[current=page]:bg-surface-selected aria-[current=page]:text-primary aria-[current=page]:shadow-[inset_2px_0_var(--primary)]" variant={section === item.id ? "secondary" : "ghost"} size="sm" aria-current={section === item.id ? "page" : undefined} disabled={busy} data-testid={`settings-${item.id}`} onClick={() => {
          if (item.id === "cloud") { if (!cloudVisited) setCloudBusy(true); setCloudVisited(true) }
          setSection(item.id)
        }}><item.icon />{item.title}</Button>)}
      </nav>
    </aside>
    <main className={cn("min-h-0 min-w-0 flex-1 p-4 sm:p-6", section === "cloud" ? "flex flex-col overflow-hidden" : "overflow-y-auto")} aria-labelledby="settings-heading" data-testid="settings-main">
      <div className={cn("w-full max-w-6xl", section === "cloud" ? "flex min-h-0 flex-1 flex-col gap-4" : "space-y-6")}>
        <header className="shrink-0 space-y-1">
          <h1 className="text-base font-semibold tracking-tight outline-none" id="settings-heading" ref={headingRef} tabIndex={-1}>{current.title}</h1>
          <p className="text-sm text-muted-foreground">{current.description}</p>
        </header>
        {section === "appearance" ? <section className="max-w-xl space-y-4 rounded-lg border bg-card p-5 sm:p-6" aria-label="外观设置">
          <div className="space-y-1"><h2 className="text-section font-medium">界面主题</h2><p className="text-xs text-muted-foreground">选择浅色、深色，或跟随系统自动切换。</p></div>
          <ThemeMenu />
          <p className="text-xs text-muted-foreground">更改立即生效，并保存在本机。</p>
        </section> : null}
        {section === "agent" ? <CodexIntegrationPanel api={api} onBusyChange={setAgentBusy} /> : null}
        {section === "about" ? <section className="max-w-xl space-y-5 rounded-lg border bg-card p-5 sm:p-6" aria-label="版本信息" data-testid="settings-version">
          <div className="space-y-2"><h2 className="text-section font-semibold">Agent运维工作台</h2><p className="text-sm leading-6 text-muted-foreground">按项目和环境组织运维资源，为 Agent 提供受控的排查工具。</p></div>
          <div className="space-y-2"><Button data-testid="about-github" onClick={() => void openRepository()}><GithubLogo />GitHub 开源仓库</Button><p className="break-all text-xs text-muted-foreground">https://github.com/coco-ari/runbook-bridge</p>{repositoryError ? <p role="alert" className="text-xs text-destructive">{repositoryError}</p> : null}</div>
          <dl className="space-y-3 border-t pt-4 text-sm"><div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">当前版本</dt><dd className="font-mono" data-testid="about-version">{appVersion}</dd></div><div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">开源许可</dt><dd>MIT</dd></div></dl>
          <div className="border-t pt-4"><h3 className="text-sm font-medium">版本兼容性</h3><p className="mt-2 text-xs leading-5 text-muted-foreground">版本号来自当前应用包。共享云仓库的设备请保持客户端功能兼容；使用生产/测试环境标识时，其他设备也需更新到支持此功能的版本。</p></div>
        </section> : null}
        {cloudVisited ? <div hidden={section !== "cloud"} className={section === "cloud" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><CloudConfigPanel api={api} onChanged={onChanged} onBusyChange={setCloudBusy} /></div> : null}
      </div>
    </main>
  </div>
}
