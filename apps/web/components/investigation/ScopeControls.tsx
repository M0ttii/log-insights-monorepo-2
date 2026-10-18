import { useState } from "react"
import { CalendarDays, ChevronDown, Database, X } from "lucide-react"
import {
  FILTER_FIELDS,
  datasetSchema,
  type Filter,
} from "@workspace/domain/filters"
import { datasetTitle } from "@/components/datasets/catalog"
import { useLoadedDatasets } from "@/components/providers/LoadedDatasets"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { changeDataset, scopeError } from "./scope"

export function ScopeControls({
  scope,
  onChange,
  disabled,
}: {
  scope: Filter
  onChange: (scope: Filter) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [error, setError] = useState<string | null>(null)
  const datasets = useLoadedDatasets()
  const filters = FILTER_FIELDS.filter(
    (key) =>
      !["dataset", "from", "to"].includes(key) && scope[key] !== undefined
  )
  const datasetLabel = scope.dataset
    ? datasetTitle(scope.dataset)
    : "Agent chooses"
  const windowLabel =
    scope.from || scope.to
      ? "Custom window"
      : scope.dataset === "otel"
        ? "Tool-specific window"
        : "Full span"
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" />}
          disabled={disabled}
          aria-label={`Choose dataset, ${datasetLabel}`}
          className="gap-1.5 text-xs text-muted-foreground"
        >
          <Database className="size-3.5" />
          {datasetLabel}
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-72">
          <DropdownMenuRadioGroup
            value={scope.dataset ?? "auto"}
            onValueChange={(value) => {
              if (value === "auto") onChange(changeDataset(scope))
              else {
                const parsed = datasetSchema.safeParse(value)
                if (parsed.success && datasets.includes(parsed.data))
                  onChange(changeDataset(scope, parsed.data))
              }
            }}
          >
            <DropdownMenuRadioItem value="auto" closeOnClick>
              Agent chooses dataset
            </DropdownMenuRadioItem>
            {datasets.map((dataset) => (
              <DropdownMenuRadioItem key={dataset} value={dataset} closeOnClick>
                {datasetTitle(dataset)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">
            {datasets.length === 0 &&
              "Loaded datasets unavailable. Check the corpus connection. "}
            Changing dataset clears the previous time window and filters.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (value) {
            setFrom(scope.from ?? "")
            setTo(scope.to ?? "")
            setError(null)
          }
        }}
      >
        <PopoverTrigger
          render={<Button variant="ghost" size="sm" />}
          disabled={disabled}
          aria-label={`Set time window, ${windowLabel}`}
          className="gap-1.5 text-xs text-muted-foreground"
        >
          <CalendarDays className="size-3.5" />
          <span>{windowLabel}</span>
          <ChevronDown className="size-3" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)] p-4"
        >
          <PopoverTitle>Time window</PopoverTitle>
          <PopoverDescription className="text-xs leading-5">
            UTC. Start included, end excluded.{" "}
            {scope.dataset === "otel"
              ? "Text queries default to the indexed reference window. Direct counts and trends need both boundaries; see Corpus for scan limits."
              : "Leave either boundary empty to use the dataset’s span."}
          </PopoverDescription>
          <Label htmlFor="scope-from">From · inclusive</Label>
          <Input
            id="scope-from"
            value={from}
            placeholder="2005-06-01T00:00:00Z"
            onChange={(event) => setFrom(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "scope-error" : undefined}
          />
          <Label htmlFor="scope-to">To · exclusive</Label>
          <Input
            id="scope-to"
            value={to}
            placeholder="2005-07-01T00:00:00Z"
            onChange={(event) => setTo(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "scope-error" : undefined}
          />
          {error && (
            <p
              id="scope-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {error}
            </p>
          )}
          <div className="mt-2 flex justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const { from: _from, to: _to, ...rest } = scope
                onChange(rest)
                setOpen(false)
              }}
            >
              Reset window
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const { from: _from, to: _to, ...rest } = scope
                const next = {
                  ...rest,
                  ...(from.trim() ? { from: from.trim() } : {}),
                  ...(to.trim() ? { to: to.trim() } : {}),
                }
                const problem = scopeError(next)
                if (problem) {
                  setError(problem)
                  return
                }
                if (
                  [next.from, next.to].some(
                    (value) => value && !value.endsWith("Z")
                  )
                ) {
                  setError("Use UTC timestamps ending in Z.")
                  return
                }
                onChange(next)
                setOpen(false)
              }}
            >
              Apply window
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {filters.map((key) => (
        <Button
          key={key}
          variant="secondary"
          size="xs"
          disabled={disabled}
          onClick={() => {
            const next = { ...scope }
            delete next[key]
            onChange(next)
          }}
          aria-label={`Remove ${key} filter: ${key}: ${Array.isArray(scope[key]) ? scope[key].join(", ") : String(scope[key])}`}
          className="max-w-40 text-xs"
        >
          <span className="truncate">
            {key}:{" "}
            {Array.isArray(scope[key])
              ? scope[key].join(", ")
              : String(scope[key])}
          </span>
          <X className="size-3" />
        </Button>
      ))}
    </>
  )
}
