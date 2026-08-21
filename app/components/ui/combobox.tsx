"use client"

import { Check, ChevronsUpDown, Search } from "lucide-react"
import * as React from "react"

import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover"
import { cn } from "@/app/lib/utils"

export type ComboboxOption = {
  value: string
  label: string
  description?: string
  keywords?: string[]
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .trim()
}

export function Combobox({
  options,
  value,
  onValueChange,
  placeholder = "Selecione uma opção…",
  searchPlaceholder = "Buscar…",
  emptyMessage = "Nenhuma opção encontrada.",
  disabled = false,
  required = false,
  autoFocus = false,
  ariaLabelledBy,
  className,
}: {
  options: ComboboxOption[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  disabled?: boolean
  required?: boolean
  autoFocus?: boolean
  ariaLabelledBy?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const listboxId = React.useId()
  const normalizedQuery = normalizeSearch(query)
  const selectedOption = options.find((option) => option.value === value)
  const filteredOptions = React.useMemo(
    () =>
      normalizedQuery
        ? options.filter((option) =>
            normalizeSearch(
              [
                option.label,
                option.description ?? "",
                ...(option.keywords ?? []),
              ].join(" "),
            ).includes(normalizedQuery),
          )
        : options,
    [normalizedQuery, options],
  )
  const boundedActiveIndex = Math.min(
    activeIndex,
    Math.max(filteredOptions.length - 1, 0),
  )

  function selectOption(option: ComboboxOption) {
    onValueChange(option.value)
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          const selectedIndex = options.findIndex(
            (option) => option.value === value,
          )
          setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
        } else {
          setQuery("")
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          aria-controls={listboxId}
          aria-expanded={open}
          aria-labelledby={ariaLabelledBy}
          aria-required={required}
          autoFocus={autoFocus}
          className={cn(
            "w-full min-w-0 justify-between px-2.5 text-left font-normal",
            !selectedOption && "text-muted-foreground",
            className,
          )}
          disabled={disabled}
          role="combobox"
          type="button"
          variant="outline"
        >
          <span className="min-w-0 truncate">
            {selectedOption?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="shrink-0 text-muted-foreground" size={15} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchInputRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-2 border-b border-border px-2.5">
          <Search className="shrink-0 text-muted-foreground" size={14} />
          <Input
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={
              filteredOptions[boundedActiveIndex]
                ? `${listboxId}-option-${boundedActiveIndex}`
                : undefined
            }
            className="h-9 border-0 px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0"
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setActiveIndex((current) =>
                  Math.min(current + 1, filteredOptions.length - 1),
                )
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setActiveIndex((current) => Math.max(current - 1, 0))
              } else if (event.key === "Enter") {
                const activeOption = filteredOptions[boundedActiveIndex]
                if (!activeOption) return
                event.preventDefault()
                selectOption(activeOption)
              } else if (event.key === "Escape") {
                event.preventDefault()
                setOpen(false)
              }
            }}
            placeholder={searchPlaceholder}
            ref={searchInputRef}
            role="searchbox"
            value={query}
          />
        </div>
        <div
          aria-label="Opções disponíveis"
          className="max-h-72 overflow-y-auto p-1 overscroll-contain"
          id={listboxId}
          onWheel={(event) => {
            const listbox = event.currentTarget
            if (listbox.scrollHeight <= listbox.clientHeight) return

            event.preventDefault()
            event.stopPropagation()
            listbox.scrollTop += event.deltaY
          }}
          role="listbox"
        >
          {filteredOptions.length ? (
            filteredOptions.map((option, index) => {
              const selected = option.value === value
              const active = index === boundedActiveIndex
              return (
                <Button
                  aria-selected={selected}
                  className={cn(
                    "h-auto w-full min-w-0 justify-start gap-2 rounded-md px-2 py-2 text-left whitespace-normal",
                    active && "bg-accent text-accent-foreground",
                  )}
                  id={`${listboxId}-option-${index}`}
                  key={option.value}
                  onClick={() => selectOption(option)}
                  onMouseMove={() => setActiveIndex(index)}
                  role="option"
                  size="unstyled"
                  type="button"
                  variant="ghost"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {selected ? <Check className="text-primary" size={14} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-xs font-medium">
                      {option.label}
                    </strong>
                    {option.description ? (
                      <small className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {option.description}
                      </small>
                    ) : null}
                  </span>
                </Button>
              )
            })
          ) : (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyMessage}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
