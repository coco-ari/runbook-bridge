import { Component, type ErrorInfo, type ReactNode } from "react"

import { ThemeProvider, useTheme } from "@/app/theme-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

interface AppProvidersProps {
  readonly children: ReactNode
}

interface ErrorBoundaryState {
  readonly failed: boolean
}

class RendererErrorBoundary extends Component<AppProvidersProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Renderer errors stay local. Never serialize operational data into diagnostics here.
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
          <Alert className="max-w-md border-danger/40 bg-surface p-5" variant="destructive">
            <AlertTitle><h1 className="text-base font-semibold">界面基础加载失败</h1></AlertTitle>
            <AlertDescription className="mt-2 text-sm leading-6">
              请关闭此验证窗口并查看本机测试输出。不会上传错误或运维数据。
            </AlertDescription>
          </Alert>
        </main>
      )
    }

    return this.props.children
  }
}

function ThemeNotifications() {
  const { theme } = useTheme()
  return <Toaster position="top-center" richColors theme={theme} />
}

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <RendererErrorBoundary>
      <ThemeProvider>
        <TooltipProvider delayDuration={350} skipDelayDuration={100}>
          {children}
          <ThemeNotifications />
        </TooltipProvider>
      </ThemeProvider>
    </RendererErrorBoundary>
  )
}
