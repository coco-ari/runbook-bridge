import { useCallback, useRef, useState } from "react"
import { Eye } from "@phosphor-icons/react"
import type { AiOpsV2Api, PluginScope } from "@/bridge/ai-ops-v2"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { StoredCredentialViewer } from "@/features/plugins/StoredCredentialViewer"

interface StoredCredentialInputProps extends React.ComponentProps<"input"> {
  readonly api: AiOpsV2Api
  readonly scope: PluginScope | null
  readonly field: "password" | "privateKeyPassphrase" | "proxyPassword"
  readonly credentialLabel: string
  readonly stored: boolean
}

export function StoredCredentialInput({ api, scope, field, credentialLabel, stored, ...inputProps }: StoredCredentialInputProps) {
  const [viewOpen, setViewOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeView = useCallback(() => setViewOpen(false), [])
  const viewLabel = `查看已保存${credentialLabel}`

  return (
    <>
      <InputGroup>
        <InputGroupInput {...inputProps} type="password" />
        {scope && stored ? (
          <InputGroupAddon align="inline-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <InputGroupButton ref={triggerRef} aria-label={viewLabel} aria-haspopup="dialog" className="shrink-0 text-xs" data-testid={`stored-credential-view-${field}`} disabled={inputProps.disabled} onClick={() => setViewOpen(true)} size="xs">
                  <Eye aria-hidden="true" />
                  查看已保存
                </InputGroupButton>
              </TooltipTrigger>
              <TooltipContent>{viewLabel}，在只读弹窗中展示，不显示或替换当前输入。</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {scope && stored && viewOpen ? <StoredCredentialViewer api={api} scope={scope} field={field} label={credentialLabel} onClose={closeView} onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus() }} /> : null}
    </>
  )
}
