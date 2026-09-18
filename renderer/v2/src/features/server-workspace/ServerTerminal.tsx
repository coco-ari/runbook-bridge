import { WorkspaceIconButton } from "@/components/workspace/WorkspaceControls"
import { useCallback, useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { TerminalSearch, type TerminalSearchHandle, type TerminalSearchEngine } from "./TerminalSearch"
import { Copy, ClipboardText, Plus, Stop, TerminalWindow } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope } from "@/bridge/ai-ops-v2"
import { useTheme } from "@/app/theme-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { quoteRemotePath, unwrapWorkspaceResult, workspaceErrorMessage } from "./workspace-model"
import { terminalOpenQueue, type TerminalConnection } from "./terminal-recovery"
import { resetTerminalForReconnect } from "./terminal-history"
import type { WorkspacePathDrag } from "./workspace-path-drag"
import "@xterm/xterm/css/xterm.css"

const TERMINAL_FONT_FAMILY = "\"Cascadia Mono\", \"Cascadia Code\", Consolas, Menlo, Monaco, \"Noto Sans Mono CJK SC\", \"Microsoft YaHei UI\", \"PingFang SC\", \"Noto Sans CJK SC\", monospace"
const PASTE_COLORS_COMMAND = "if [ -n \"${BASH_VERSION-}\" ]; then builtin bind 'set active-region-start-color \\e[27;48;5;23;38;5;195m' 2>/dev/null; builtin bind 'set active-region-end-color \\e[0m' 2>/dev/null; fi"

const DEFAULT_COLORS_KEY = "runbook-bridge:terminal-default-colors:v1"
function readDefaultColors() {
  try { return localStorage.getItem(DEFAULT_COLORS_KEY) !== "false" } catch { return true }
}

export interface ServerTerminalProps {
  readonly tabId: string
  readonly api: AiOpsV2Api
  readonly scope: PluginScope
  readonly visible: boolean
  readonly connected: boolean
  readonly connection: TerminalConnection
  readonly maximized: boolean
  readonly onMaximize: () => void
  readonly pathDrag: WorkspacePathDrag
}

export function ServerTerminal({ tabId, api, scope, visible, connected, connection, maximized, onMaximize, pathDrag }: ServerTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<TerminalSearchHandle>(null)
  const [searchEngine, setSearchEngine] = useState<TerminalSearchEngine | null>(null)
  const sessionRef = useRef<string | null>(null)
  const clipboardSessionRef = useRef<string | null>(null)
  const clipboardPendingRef = useRef(false)
  const interactionEpochRef = useRef(0)
  const openingRef = useRef(false)
  const generationRef = useRef(0)
  const mountedRef = useRef(false)
  const visibleRef = useRef(visible)
  const connectedRef = useRef(connected)
  const connectionRef = useRef(connection)
  const recoveryRef = useRef<{ sessionId: string; eligible: boolean; waitForSequence?: number } | null>(null)
  const recoveryEnabledRef = useRef(true)
  const recoveryAttemptsRef = useRef(0)
  const stableTimerRef = useRef(0)
  const hasOpenedRef = useRef(false)
  const [reconnected, setReconnected] = useState(false)
  const writeChainRef = useRef(Promise.resolve())
  const queuedBytesRef = useRef(0)
  const [status, setStatus] = useState<"idle" | "opening" | "open" | "closed" | "waiting">("idle")
  const [defaultColors, setDefaultColors] = useState(readDefaultColors)
  const [colorHelp, setColorHelp] = useState(false)
  const [colorPlatform, setColorPlatform] = useState("linux")
  const [error, setError] = useState("")
  const [paste, setPaste] = useState("")
  const [hasSelection, setHasSelection] = useState(false)
  const [pathDragOver, setPathDragOver] = useState(false)
  const isMac = /Mac/u.test(navigator.platform)
  const { theme } = useTheme()
  if (visibleRef.current !== visible) interactionEpochRef.current += 1
  visibleRef.current = visible
  connectedRef.current = connected
  connectionRef.current = connection

  const insertPaste = useCallback((text: string) => {
    const terminal = terminalRef.current
    if (!terminal || !sessionRef.current || !connectedRef.current || !visibleRef.current || !text) return false
    // xterm 会规范换行并为括号粘贴添加 12 字节控制序列，按实际发送量检查队列。
    const bytes = new TextEncoder().encode(text.replace(/\r?\n/gu, "\r")).byteLength + (terminal.modes.bracketedPasteMode ? 12 : 0)
    if (bytes + queuedBytesRef.current > 65536) { setError("粘贴内容或待发送输入超过 64 KB，请等待后分批操作。"); return false }
    terminal.paste(text)
    terminal.focus()
    return true
  }, [])

  const acceptPaste = useCallback((text: string) => {
    if (!sessionRef.current || !connectedRef.current || !visibleRef.current || !text) return
    if (new TextEncoder().encode(text).byteLength > 65536) { setError("粘贴内容超过 64 KB，请分批操作。"); return }
    setError("")
    if (/\r|\n/u.test(text) || text.length > 32768) setPaste(text)
    else insertPaste(text)
  }, [insertPaste])

  const clipboardAction = useCallback(async (action: "copy" | "paste") => {
    const terminal = terminalRef.current
    const sessionId = action === "copy" ? clipboardSessionRef.current : sessionRef.current
    if (!terminal || !sessionId || !visibleRef.current || clipboardPendingRef.current) return
    const text = action === "copy" ? terminal.getSelection() : ""
    if (action === "copy" && !text) return
    const epoch = interactionEpochRef.current
    const generation = generationRef.current
    clipboardPendingRef.current = true
    try {
      const result = unwrapWorkspaceResult(await api.serverTerminalClipboard({ ...scope, sessionId, ...(action === "copy" ? { action, text } : { action }) }))
      if (!mountedRef.current || generation !== generationRef.current || epoch !== interactionEpochRef.current || !visibleRef.current) return
      if (action === "paste") acceptPaste(result.text ?? "")
      else terminal.focus()
    } catch (failure) {
      if (mountedRef.current && generation === generationRef.current && epoch === interactionEpochRef.current) setError(workspaceErrorMessage(failure))
    } finally { clipboardPendingRef.current = false }
  }, [acceptPaste, api, scope])

  const resize = useCallback(() => {
    const container = containerRef.current
    const terminal = terminalRef.current
    if (!visibleRef.current || !container || !terminal || container.clientWidth < 40 || container.clientHeight < 40) return
    fitRef.current?.fit()
    const sessionId = sessionRef.current
    if (sessionId) void api.serverTerminalResize({ ...scope, sessionId, cols: terminal.cols, rows: terminal.rows })
  }, [api, scope])

  const finish = useCallback((message: string, recovery: { sessionId: string; eligible: boolean; waitForSequence?: number } | null = null) => {
    sessionRef.current = null
    openingRef.current = false
    generationRef.current += 1
    interactionEpochRef.current += 1
    queuedBytesRef.current = 0
    writeChainRef.current = Promise.resolve()
    recoveryRef.current = recoveryEnabledRef.current && (connectionRef.current.allowRecovery || connectionRef.current.pauseRecovery) ? recovery : null
    setStatus(recoveryRef.current?.eligible ? "waiting" : "closed")
    setPaste("")
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = true
      terminalRef.current.writeln("\r\n\x1b[90m" + message + "\x1b[0m")
    }
  }, [])

  const stop = useCallback(() => {
    const sessionId = sessionRef.current ?? recoveryRef.current?.sessionId
    const recovering = Boolean(recoveryRef.current)
    recoveryEnabledRef.current = false
    recoveryRef.current = null
    finish(recovering ? "已停止此终端的自动恢复。" : "人工终端会话已结束。")
    if (sessionId) void api.serverTerminalClose({ ...scope, sessionId }).then((result) => {
      if (!result.ok && mountedRef.current) setError(result.error.message)
    }).catch((failure) => { if (mountedRef.current) setError(workspaceErrorMessage(failure)) })
  }, [api, finish, scope])

  const open = useCallback(async (automatic = false) => {
    if (!connectedRef.current || openingRef.current || sessionRef.current || !terminalRef.current) return
    const recoveryOf = automatic ? recoveryRef.current?.sessionId : undefined
    if (automatic && (!recoveryOf || !recoveryEnabledRef.current || !connectionRef.current.allowRecovery)) return
    if (!automatic) {
      recoveryEnabledRef.current = true
      recoveryRef.current = null
      recoveryAttemptsRef.current = 0
    } else recoveryAttemptsRef.current += 1
    openingRef.current = true
    const generation = ++generationRef.current
    const focusAtStart = document.activeElement
    setStatus("opening")
    setError("")
    resize()
    const terminal = terminalRef.current
    let readingSession: string | null = null
    try {
      const session = await terminalOpenQueue.run(async () => {
        if (!mountedRef.current || generation !== generationRef.current || !connectedRef.current) return null
        const result = unwrapWorkspaceResult(await api.serverTerminalOpen({
          ...scope, tabId, defaultColors: readDefaultColors(), cols: terminal.cols, rows: terminal.rows,
          ...(recoveryOf ? { recoveryOf } : {}),
        }))
        if (!mountedRef.current || generation !== generationRef.current) {
          await api.serverTerminalClose({ ...scope, sessionId: result.sessionId })
          return null
        }
        return result
      }, () => visibleRef.current ? 1 : 0)
      if (!session) return
      readingSession = session.sessionId
      sessionRef.current = session.sessionId
      clipboardSessionRef.current = session.sessionId
      if (hasOpenedRef.current) await resetTerminalForReconnect(terminal, automatic)
      if (!mountedRef.current || generation !== generationRef.current) {
        void api.serverTerminalClose({ ...scope, sessionId: session.sessionId })
        return
      }
      hasOpenedRef.current = true
      recoveryRef.current = null
      openingRef.current = false
      terminal.options.disableStdin = !connectedRef.current
      setStatus("open")
      setReconnected(automatic)
      // 自动恢复不改变焦点；手动打开也不抢走等待期间用户移到其他控件的焦点。
      if (!automatic && connectedRef.current && visibleRef.current && document.activeElement === focusAtStart) terminal.focus()
      window.clearTimeout(stableTimerRef.current)
      stableTimerRef.current = window.setTimeout(() => {
        if (generation === generationRef.current && sessionRef.current === session.sessionId) recoveryAttemptsRef.current = 0
      }, 30_000)
      while (mountedRef.current && generation === generationRef.current && sessionRef.current === session.sessionId) {
        const chunk = unwrapWorkspaceResult(await api.serverTerminalRead({ ...scope, sessionId: session.sessionId }))
        if (!mountedRef.current || generation !== generationRef.current) break
        // 等待 xterm 消化本批输出，再读取下一批，避免高频日志挤满渲染内存。
        if (chunk.data.byteLength) await new Promise<void>((resolve) => terminal.write(new Uint8Array(chunk.data), resolve))
        if (!mountedRef.current || generation !== generationRef.current) break
        if (chunk.status === "closed") {
          const recovery = chunk.recoverable || chunk.closeReason === "channel-closed"
            ? { sessionId: session.sessionId, eligible: chunk.recoverable === true } : null
          if (chunk.closeReason === "user-disconnected") recoveryAttemptsRef.current = 0
          finish(chunk.recoverable && chunk.closeReason === "user-disconnected" ? "服务器已断开，重新连接后将恢复此终端；未发送的输入不会重放。"
            : chunk.recoverable ? "连接中断，保留历史并等待恢复；未发送的输入不会重放。"
            : "终端会话已结束" + (chunk.exitCode == null ? "" : "（退出码 " + chunk.exitCode + "）") + "。", recovery)
          break
        }
        if (!chunk.data.byteLength) await new Promise<void>((resolve) => window.setTimeout(resolve, 20))
      }
    } catch (failure) {
      if (mountedRef.current && generation === generationRef.current) {
        if (readingSession) {
          void api.serverTerminalClose({ ...scope, sessionId: readingSession })
          finish("终端读取失败，请手动打开新终端。")
        } else {
          const code = (failure as { code?: string })?.code
          const waitingForConnection = code === "SSH_NOT_CONNECTED"
          if (waitingForConnection) recoveryAttemptsRef.current = Math.max(0, recoveryAttemptsRef.current - 1)
          const stopped = ["TERMINAL_RECOVERY_STOPPED", "TERMINAL_SCOPE_MISMATCH", "TERMINAL_LIMIT_REACHED", "TERMINAL_AUDIT_UNAVAILABLE"].includes(code ?? "")
            || (code === "WORKSPACE_CLOSED" && !connectionRef.current.pauseRecovery)
          finish("终端暂时无法打开。", automatic && !stopped && recoveryOf ? { sessionId: recoveryOf, eligible: true, ...(waitingForConnection ? { waitForSequence: connectionRef.current.sequence } : {}) } : null)
        }
        setError(workspaceErrorMessage(failure))
      }
    } finally {
      if (generation === generationRef.current) {
        openingRef.current = false
        if (!sessionRef.current) setStatus("closed")
      }
    }
  }, [api, finish, resize, scope, tabId])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    mountedRef.current = true
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 14,
      lineHeight: 1.35,
      scrollback: 5000,
      screenReaderMode: true,
      minimumContrastRatio: 4.5,
      // 官方搜索扩展使用装饰 API 在本地绘制匹配高亮。
      allowProposedApi: true,
      disableStdin: true,
      convertEol: false,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal
    fitRef.current = fit
    const searchAddon = new SearchAddon({ highlightLimit: 1000 })
    terminal.loadAddon(searchAddon)
    setSearchEngine({ terminal, addon: searchAddon })
    const sendInput = (data: string, encoding: "utf8" | "binary" = "utf8") => {
      const sessionId = sessionRef.current
      if (!sessionId || !connectedRef.current) return
      const inputBytes = encoding === "binary" ? data.length : new TextEncoder().encode(data).byteLength
      if (queuedBytesRef.current + inputBytes > 65536) {
        setError("输入量过大，请等待终端响应后分批粘贴。")
        return
      }
      queuedBytesRef.current += inputBytes
      const generation = generationRef.current
      writeChainRef.current = writeChainRef.current.then(async () => {
        try {
          if (generation !== generationRef.current || sessionRef.current !== sessionId) return
          unwrapWorkspaceResult(await api.serverTerminalWrite({ ...scope, sessionId, data, encoding }))
        } catch (failure) {
          if (generation === generationRef.current && mountedRef.current) {
            setPaste("")
            setError(workspaceErrorMessage(failure))
          }
        } finally { if (generation === generationRef.current) queuedBytesRef.current -= inputBytes }
      })
    }
    const input = terminal.onData((data) => sendInput(data))
    const binaryInput = terminal.onBinary((data) => sendInput(data, "binary"))
    // 远端 OSC 52 不得读写系统剪贴板。
    const clipboard = terminal.parser.registerOscHandler(52, () => true)
    const selection = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()))
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase()
      const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!modifier || event.altKey || (key !== "v" && !(key === "c" && (isMac || event.shiftKey)))) return true
      event.preventDefault()
      event.stopPropagation()
      if (event.type === "keydown" && !event.repeat) void clipboardAction(key === "c" ? "copy" : "paste")
      return false
    })
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      acceptPaste(event.clipboardData?.getData("text/plain") ?? "")
    }
    container.addEventListener("paste", onPaste, true)
    let resizeTimer = 0
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(resize, 80)
    })
    observer.observe(container)
    // 首次入口点击授权打开终端；延迟一拍避免 StrictMode 的试挂载建立重复会话。
    const initialOpen = window.setTimeout(() => { void open() }, 0)
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      openingRef.current = false
      const sessionId = sessionRef.current ?? recoveryRef.current?.sessionId
      recoveryRef.current = null
      window.clearTimeout(stableTimerRef.current)
      sessionRef.current = null
      if (sessionId) void api.serverTerminalClose({ ...scope, sessionId })
      window.clearTimeout(initialOpen)
      window.clearTimeout(resizeTimer)
      observer.disconnect()
      container.removeEventListener("paste", onPaste, true)
      input.dispose()
      binaryInput.dispose()
      clipboard.dispose()
      selection.dispose()
      terminal.dispose()
      terminalRef.current = null
      clipboardSessionRef.current = null
      fitRef.current = null
    }
  }, [acceptPaste, api, clipboardAction, finish, isMac, open, resize, scope])

  useEffect(() => {
    if (!connected) {
      interactionEpochRef.current += 1
      setPaste("")
      if (terminalRef.current) terminalRef.current.options.disableStdin = true
    }
    if (!connection.allowRecovery) {
      // 主动断开仅暂停恢复，等待用户重新连接；结束会话和停止恢复仍由各标签单独控制。
      if (connection.pauseRecovery) {
        recoveryAttemptsRef.current = 0
        return
      }
      recoveryEnabledRef.current = false
      recoveryRef.current = null
      if (status === "waiting" || (status === "opening" && !sessionRef.current)) finish("自动恢复已停止，请连接服务器后手动打开终端。")
      return
    }
    const recovery = recoveryRef.current
    if (!recovery || !connected || openingRef.current || sessionRef.current || !recoveryEnabledRef.current) return
    if (recovery.waitForSequence === connection.sequence) return
    if (recoveryAttemptsRef.current >= 3) {
      recoveryRef.current = null
      setStatus("closed")
      setError("终端连续恢复失败，已停止自动尝试。可手动打开终端。")
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        // 通道关闭可能早于 SSH 丢失事件，只有后台明确授予恢复资格后才打开新终端。
        if (!recovery.eligible) {
          try {
            const result = unwrapWorkspaceResult(await api.serverTerminalRead({ ...scope, sessionId: recovery.sessionId }))
            if (!result.recoverable) return
          } catch { return }
        }
        if (!cancelled && recoveryRef.current === recovery && recoveryEnabledRef.current) void open(true)
      })()
    }, [0, 1000, 3000][recoveryAttemptsRef.current] ?? 3000)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [api, connected, connection.allowRecovery, connection.pauseRecovery, connection.sequence, finish, open, scope, status])


  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontSize = 14
    terminal.options.theme = theme === "dark"
      ? { background: "#0c0e13", foreground: "#d9e0e9", cursor: "#34d399", selectionBackground: "#234e46", selectionForeground: "#ecfdf5", selectionInactiveBackground: "#234e46", black: "#171b24", red: "#f87171", green: "#4ade80", yellow: "#facc15", blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e2e8f0", brightBlack: "#8995a7", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff" }
      : { background: "#fbfcfd", foreground: "#202a3a", cursor: "#059669", selectionBackground: "#bbf7d0", selectionForeground: "#16382d", selectionInactiveBackground: "#d4ede2", black: "#1f2937", red: "#b91c1c", green: "#047857", yellow: "#a16207", blue: "#1d4ed8", magenta: "#7e22ce", cyan: "#0e7490", white: "#e5e7eb", brightBlack: "#6b7280", brightRed: "#b91c1c", brightGreen: "#166534", brightYellow: "#854d0e", brightBlue: "#1e40af", brightMagenta: "#86198f", brightCyan: "#155e75", brightWhite: "#374151" }
    const frame = requestAnimationFrame(() => { resize(); if (visible) terminal.focus() })
    return () => cancelAnimationFrame(frame)
  }, [resize, theme, visible])

  const acceptsPathDrop = visible && connected && status === "open" && !paste && !colorHelp
  useEffect(() => { if (!acceptsPathDrop) setPathDragOver(false) }, [acceptsPathDrop])
  useEffect(() => {
    if (!pathDragOver) return
    const clear = () => setPathDragOver(false)
    window.addEventListener("dragend", clear)
    window.addEventListener("blur", clear)
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("blur", clear) }
  }, [pathDragOver])

  useEffect(() => { if (!visible) setPaste("") }, [visible])

  const directoryColorCommand = colorPlatform === "linux"
    ? "if command ls --color=auto -d . >/dev/null 2>&1; then export LS_COLORS='di=01;34:ln=01;36:ex=01;32:or=01;31:fi=0:*.zip=01;35:*.tar=01;35:*.gz=01;35:*.jar=01;35'; alias ls='ls --color=auto'; alias ll='ls -alF --color=auto'; else printf '%s\\n' 'ls does not support --color'; fi"
    : "export CLICOLOR=1 LSCOLORS=ExFxCxDxBxegedabagacad; alias ls='ls -G'; alias ll='ls -alF -G'"
  const colorCommand = `${directoryColorCommand}; ${PASTE_COLORS_COMMAND}`
  const lines = paste.replace(/\r\n?/gu, "\n").split("\n")
  return (
    <section className="server-terminal-pane" aria-label="交互式 SSH 终端" data-testid="server-terminal" onKeyDownCapture={event => {
      const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!visible || !searchEngine || !modifier || event.altKey || event.shiftKey || event.nativeEvent.isComposing || event.key.toLowerCase() !== "f") return
      // 仅处理当前终端面板内的快捷键，兼容断线与搜索框聚焦，不拦截弹窗输入。
      if (!event.currentTarget.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) searchRef.current?.open()
    }}>
      <div className="server-workspace-toolbar">
        <div className="flex min-w-0 items-center gap-2"><TerminalWindow size={16} className="text-primary" /><span className="font-medium">终端</span><span className="text-xs text-muted-foreground" role="status" aria-live="polite">{status === "open" ? reconnected ? "已重新连接 · 新会话" : "人工会话" : status === "opening" ? recoveryRef.current ? "正在恢复终端…" : "正在打开…" : status === "waiting" ? connected ? "等待恢复终端…" : "等待服务器连接…" : "会话已结束"}</span></div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={!hasSelection} title={isMac ? "复制选中内容（⌘C）" : "复制选中内容（Ctrl+Shift+C）"} onClick={() => { void clipboardAction("copy") }}><Copy />复制</Button>
          <Button size="sm" variant="ghost" disabled={status !== "open" || !connected} title={isMac ? "粘贴（⌘V）" : "粘贴（Ctrl+V / Ctrl+Shift+V）"} onClick={() => { void clipboardAction("paste") }}><ClipboardText />粘贴</Button>
          <Button size="sm" variant="ghost" onClick={() => { setDefaultColors(readDefaultColors()); setColorHelp(true) }}>目录配色</Button>
          {status === "open" ? <Button size="sm" variant="ghost" onClick={stop}><Stop />结束会话</Button>
            : status === "waiting" || (status === "opening" && recoveryRef.current) ? <Button size="sm" variant="ghost" onClick={stop}><Stop />停止恢复</Button>
            : <Button size="sm" variant="ghost" disabled={!connected || status === "opening"} onClick={() => { void open() }}><Plus />打开终端</Button>}
          <WorkspaceIconButton action={maximized ? "restore" : "maximize"} label={maximized ? "恢复分栏" : "最大化终端"} onClick={onMaximize} />
        </div>
      </div>
      <TerminalSearch ref={searchRef} engine={searchEngine} visible={visible} theme={theme} />
      {error ? <div role="alert" className="server-workspace-error">{error}<Button size="sm" variant="ghost" aria-label="收起终端提示" onClick={() => setError("")}>收起</Button></div> : null}
      <ContextMenu><ContextMenuTrigger asChild><div className="server-terminal-container" ref={containerRef} data-path-drag-over={pathDragOver || undefined}
        onDragOverCapture={event => {
          event.preventDefault()
          event.stopPropagation()
          const accepted = acceptsPathDrop && Boolean(sessionRef.current) && pathDrag.accepts(event.dataTransfer)
          event.dataTransfer.dropEffect = accepted ? "copy" : "none"
          setPathDragOver(accepted)
        }} onDragLeaveCapture={event => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPathDragOver(false)
        }} onDropCapture={event => {
          event.preventDefault()
          event.stopPropagation()
          setPathDragOver(false)
          if (!acceptsPathDrop || !sessionRef.current) return
          const path = pathDrag.take(event.dataTransfer)
          if (path !== null) insertPaste(quoteRemotePath(path))
        }} /></ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={(event) => { event.preventDefault(); if (visibleRef.current) terminalRef.current?.focus() }}>
          <ContextMenuItem disabled={!hasSelection} onSelect={() => { void clipboardAction("copy") }}>复制选中内容</ContextMenuItem>
          <ContextMenuItem disabled={status !== "open" || !connected} onSelect={() => { void clipboardAction("paste") }}>粘贴</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Dialog open={colorHelp} onOpenChange={setColorHelp}>
        <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); if (visibleRef.current) terminalRef.current?.focus() }}>
          <DialogHeader><DialogTitle>终端目录配色</DialogTitle><DialogDescription>新终端自动设置目录颜色并提供 ll 命令；支持的 Bash 同时使用深青底、浅色字显示粘贴内容。配置仅影响当前会话。</DialogDescription></DialogHeader>
          <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={defaultColors} onChange={(event) => {
            const enabled = event.target.checked
            try { localStorage.setItem(DEFAULT_COLORS_KEY, String(enabled)); setDefaultColors(enabled) } catch { setError("无法保存自动配色偏好，请检查本地存储。") }
          }} />新建终端时自动启用配色</label>
          <p className="text-xs text-muted-foreground">开关仅影响之后新建的终端。已打开的终端可在空白 Bash / Zsh 提示符中填入下方命令，按 Enter 应用；未识别的 Shell 会跳过自动配置。</p>
          <label className="flex items-center gap-3 text-sm">服务器类型<select className="rounded border bg-background px-2 py-1" aria-label="配色服务器类型" value={colorPlatform} onChange={(event) => setColorPlatform(event.target.value)}><option value="linux">Linux / GNU ls</option><option value="bsd">macOS / BSD ls</option></select></label>
          <p className="text-xs text-muted-foreground">目录：蓝色 · 软链接：青色 · 可执行文件：绿色。同时提供 ll 别名；Bash 粘贴高亮与鼠标选区分别配色。</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border bg-surface-inset p-3 font-mono text-xs">{colorCommand}</pre>
          <DialogFooter><Button variant="outline" onClick={() => setColorHelp(false)}>取消</Button><Button disabled={status !== "open" || !connected} onClick={() => { terminalRef.current?.paste(colorCommand); setColorHelp(false) }}>填入配色命令</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(paste)} onOpenChange={(value) => { if (!value) setPaste("") }}>
        <DialogContent className="sm:max-w-lg" onCloseAutoFocus={(event) => { event.preventDefault(); if (visibleRef.current) terminalRef.current?.focus() }}>
          <DialogHeader><DialogTitle>确认粘贴到终端</DialogTitle><DialogDescription>确认后整段发送到当前终端。部分 Shell 会立即执行其中的换行，请检查内容和当前程序状态。</DialogDescription></DialogHeader>
          <pre style={{ fontFamily: TERMINAL_FONT_FAMILY }} className="max-h-64 overflow-auto rounded-md border bg-surface-inset p-3 text-sm leading-6 whitespace-pre-wrap break-all">{paste}</pre>
          <p className="text-xs text-muted-foreground">共 {lines.length} 行，保留缩进和空行。</p>
          <DialogFooter><Button variant="outline" onClick={() => setPaste("")}>取消</Button><Button disabled={status !== "open" || !connected} onClick={() => {
            if (insertPaste(paste)) setPaste("")
          }}>确认粘贴整段</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
