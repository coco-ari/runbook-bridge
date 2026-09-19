import { HardDrives } from "@phosphor-icons/react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function DockerIcon({ size = 20 }: { readonly size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13.1 2.5h3v3h-3zm-3.7 3.7h3v3h-3zm3.7 0h3v3h-3zm-7.4 0h3v3h-3zM2 9.9h3v3H2zm3.7 0h3v3h-3zm3.7 0h3v3h-3zm3.7 0h3v3h-3z" />
    <path d="M23.7 10.4c-1.1-.6-2.3-.6-3.3-.3-.3-1.3-1-2.2-2-2.9-.8 1.3-1 2.8-.4 4.2-.9.9-2.5 1.7-5 1.7H.4c-.3 2.7.7 5.1 2.7 6.5 1.5 1.1 3.6 1.7 6 1.7 5.7 0 9.6-2.6 11.4-7.6 1.5-.1 2.7-1.2 3.2-3.3ZM5 15.5a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z" />
  </svg>
}

export const SERVER_RESOURCES = [
  { id:"files", label:"服务器文件", Icon:HardDrives },
  { id:"docker", label:"Docker 容器", Icon:DockerIcon },
] as const
export type ServerResource = typeof SERVER_RESOURCES[number]["id"]

export function ServerResourceRail({ active, onSelect }: { readonly active:ServerResource; readonly onSelect:(id:ServerResource) => void }) {
  return <nav className="server-resource-rail" aria-label="服务器资源">
    {SERVER_RESOURCES.map(({ id, label, Icon }, index) => <Tooltip key={id}><TooltipTrigger asChild>
      <button type="button" className="server-resource-button" data-resource={id} aria-label={label} aria-pressed={active === id} onClick={() => onSelect(id)} onKeyDown={event => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const next = event.key === "Home" ? 0 : event.key === "End" ? SERVER_RESOURCES.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + SERVER_RESOURCES.length) % SERVER_RESOURCES.length
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-resource="' + SERVER_RESOURCES[next]!.id + '"]')?.focus()
      }}><Icon size={20} /></button>
    </TooltipTrigger><TooltipContent side="right" sideOffset={6}>{label}</TooltipContent></Tooltip>)}
  </nav>
}
