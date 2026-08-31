import { CaretUpDown, Desktop, Moon, Sun } from "@phosphor-icons/react"

import { useTheme } from "@/app/theme-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { isThemePreference } from "@/state/theme-state"

const options = [
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Desktop },
] as const

export function ThemeMenu() {
  const { preference, setPreference } = useTheme()
  const selected = options.find((option) => option.value === preference) ?? options[2]

  return (
    <div className="shrink-0 px-2 pb-2 pt-1" data-testid="theme-controls">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`切换主题，当前${selected.label}`}
            className="h-8 w-full min-w-0 justify-start gap-1.5 px-2.5 text-xs text-muted-foreground"
            data-testid="theme-menu-trigger"
            size="sm"
            type="button"
            variant="ghost"
          >
            <selected.Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left text-xs leading-4">{selected.label}</span>
            <CaretUpDown aria-hidden="true" className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44" data-testid="theme-menu" side="top">
          <DropdownMenuLabel>外观主题</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            aria-label="外观主题"
            onValueChange={(value) => { if (isThemePreference(value)) setPreference(value) }}
            value={preference}
          >
            {options.map(({ value, label, Icon }) => (
              <DropdownMenuRadioItem data-testid={`theme-option-${value}`} key={value} value={value}>
                <Icon aria-hidden="true" />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
