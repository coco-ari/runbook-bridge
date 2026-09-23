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
    <div data-testid="theme-controls">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`切换主题，当前${selected.label}`}
            className="h-8 w-full min-w-0 justify-start gap-2 px-3 text-sm"
            data-testid="theme-menu-trigger"
            size="sm"
            type="button"
            variant="outline"
          >
            <selected.Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left text-sm leading-5">{selected.label}</span>
            <CaretUpDown aria-hidden="true" className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]" data-testid="theme-menu" side="bottom">
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
