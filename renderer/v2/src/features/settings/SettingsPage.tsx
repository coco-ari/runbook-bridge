import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Cloud, GearSix, Palette } from "@phosphor-icons/react"
import type { AiOpsV2Api } from "@/bridge/ai-ops-v2"
import { ThemeMenu } from "@/components/app-shell/ThemeMenu"
import { Button } from "@/components/ui/button"
import { CloudConfigPanel } from "@/features/cloud-config/CloudConfigPanel"

export function SettingsPage({ api, onBack, onChanged }: {
  readonly api: AiOpsV2Api
  readonly onBack: () => void
  readonly onChanged: () => void
}) {
  const [section, setSection] = useState<"appearance" | "cloud">("appearance")
  const [cloudVisited, setCloudVisited] = useState(false)
  const [busy, setBusy] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }) }, [section])

  return <div className="absolute inset-0 z-50 flex min-h-0 min-w-0 flex-col bg-background sm:flex-row" data-testid="settings-page">
    <aside className="flex shrink-0 flex-col border-b bg-sidebar p-3 sm:w-52 sm:border-r sm:border-b-0" aria-label="配置导航">
      <div className="hidden h-12 items-center gap-2 px-2 text-sm font-semibold sm:flex"><GearSix size={20} />配置</div>
      <Button className="justify-start sm:my-4" variant="ghost" size="sm" disabled={busy} data-testid="settings-back" onClick={onBack}><ArrowLeft />返回工作台</Button>
      <p className="mt-2 mb-2 hidden px-2 text-xs text-muted-foreground sm:block">应用配置</p>
      <nav className="flex gap-1 sm:flex-col">
        <Button className="flex-1 justify-start sm:flex-none" variant={section === "appearance" ? "secondary" : "ghost"} size="sm" aria-current={section === "appearance" ? "page" : undefined} disabled={busy} data-testid="settings-appearance" onClick={() => setSection("appearance")}><Palette />外观主题</Button>
        <Button className="flex-1 justify-start sm:flex-none" variant={section === "cloud" ? "secondary" : "ghost"} size="sm" aria-current={section === "cloud" ? "page" : undefined} disabled={busy} data-testid="settings-cloud" onClick={() => { if (!cloudVisited) setBusy(true); setCloudVisited(true); setSection("cloud") }}><Cloud />云配置</Button>
      </nav>
    </aside>
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 sm:p-8" aria-labelledby="settings-heading" data-testid="settings-main">
      <div className="max-w-4xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight outline-none" id="settings-heading" ref={headingRef} tabIndex={-1}>{section === "appearance" ? "外观主题" : "云配置"}</h1>
          <p className="text-sm text-muted-foreground">{section === "appearance" ? "选择适合你的界面外观，设置会应用到整个工作台。" : "加密保存项目、插件与凭据，在其他电脑上下载使用。"}</p>
        </header>
        {section === "appearance" ? <section className="max-w-xl space-y-5 rounded-xl border bg-card p-5 sm:p-6" aria-label="外观设置">
          <div className="space-y-1"><h2 className="font-medium">界面主题</h2><p className="text-xs text-muted-foreground">选择浅色、深色，或跟随系统自动切换。</p></div>
          <ThemeMenu />
          <p className="text-xs text-muted-foreground">更改立即生效，并保存在本机。</p>
        </section> : null}
        {cloudVisited ? <div hidden={section !== "cloud"}><CloudConfigPanel api={api} onChanged={onChanged} onBusyChange={setBusy} /></div> : null}
      </div>
    </main>
  </div>
}
