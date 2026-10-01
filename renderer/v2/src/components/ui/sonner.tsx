"use client"

import {
  CheckCircle,
  Info,
  SpinnerGap,
  Warning,
  XCircle,
} from "@phosphor-icons/react"
import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={props.theme ?? "system"}
      className="toaster group"
      icons={{
        success: <CheckCircle aria-hidden="true" className="size-4" weight="fill" />,
        info: <Info aria-hidden="true" className="size-4" weight="fill" />,
        warning: <Warning aria-hidden="true" className="size-4" weight="fill" />,
        error: <XCircle aria-hidden="true" className="size-4" weight="fill" />,
        loading: <SpinnerGap aria-hidden="true" className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
