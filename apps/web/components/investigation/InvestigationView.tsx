"use client"
import Link from "next/link"
import { useRef, useState } from "react"
import {
  ArrowRight,
  ArrowUp,
  BriefcaseBusiness,
  ChevronDown,
  CircleHelp,
  Database,
  FileCheck2,
  ScanSearch,
  SlidersHorizontal,
  Users,
  Wrench,
  X,
} from "lucide-react"
import type { Brief } from "@/server/brief"
import { Button } from "@workspace/ui/components/button"
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@workspace/ui/components/input-group"
import { Label } from "@workspace/ui/components/label"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@workspace/ui/components/alert"
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select"

const roleIcons = {
  engineer: Wrench,
  team_lead: Users,
  manager: BriefcaseBusiness,
}
const labels = {
  engineer: "Engineer",
  team_lead: "Team Lead",
  manager: "Manager",
}
type Role = keyof typeof labels
function isRole(value: unknown): value is Role {
  return value === "engineer" || value === "team_lead" || value === "manager"
}
// Composer composition is reused from the demo's Base UI Prompt Input adaptation.
export function InvestigationView({ brief }: { brief: Brief }) {
  const [role, setRole] = useState<Role>("engineer")
  const [question, setQuestion] = useState("")
  const [dataset, setDataset] = useState("")
  const [scope, setScope] = useState<Record<string, unknown>>({})
  const input = useRef<HTMLTextAreaElement>(null)
  const current = brief.roles.find((item) => item.id === role)
  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-5 py-8 sm:px-10 lg:px-14 lg:pt-14">
      <div className="flex items-start justify-between gap-5">
        <div>
          <h1 className="page-heading">What do you need to know?</h1>
          <p className="page-description">
            Start with a question. Follow the evidence to your next step.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          render={<Link href="/datasets#connect" />}
          className="hidden sm:inline-flex"
        >
          <CircleHelp />
          How it works
        </Button>
      </div>
      <section className="mt-10" aria-label="Choose your perspective">
        <Label className="mb-3 block text-xs text-muted-foreground">
          Your perspective
        </Label>
        <Tabs
          value={role}
          onValueChange={(value) => {
            if (isRole(value)) setRole(value)
          }}
        >
          <TabsList className="h-10 w-full sm:w-auto">
            {Object.entries(labels).map(([id, label]) => {
              const Icon = isRole(id) ? roleIcons[id] : Wrench
              return (
                <TabsTrigger
                  className="px-4 shadow-none sm:min-w-32 data-active:shadow-none"
                  key={id}
                  value={id}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
          {current?.description}
        </p>
      </section>
      <section
        className="mt-7 space-y-2"
        aria-label={`Example questions for ${labels[role]}`}
      >
        <h2 className="mb-3 text-xs font-medium text-muted-foreground">
          Try a question
        </h2>
        {brief.examples
          .filter((example) => example.role === role)
          .map((example) => (
            <Button
              key={example.id}
              variant="ghost"
              className="h-auto w-full justify-start gap-3 border border-border px-4 py-3 text-left leading-6 font-normal whitespace-normal hover:bg-muted"
              onClick={() => {
                setQuestion(example.question.trim())
                setScope(example.scope ?? {})
                setDataset(
                  typeof example.scope?.dataset === "string"
                    ? example.scope.dataset
                    : ""
                )
                input.current?.focus()
              }}
            >
              <ScanSearch
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="flex-1">{example.question.trim()}</span>
              <ArrowUp
                className="size-3.5 shrink-0 rotate-45 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          ))}
      </section>
      <section aria-label="Question composer" className="mt-8">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Database className="size-3.5 shrink-0" aria-hidden="true" />
            {dataset
              ? `Scope: ${dataset.toUpperCase()}`
              : "Scope: chosen by the agent"}
            {typeof scope.from === "string" && (
              <span className="hidden sm:inline">
                · [{scope.from.slice(0, 10)}, {String(scope.to).slice(0, 10)})
                UTC
              </span>
            )}
            {dataset && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Clear scope"
                onClick={() => {
                  setDataset("")
                  setScope({})
                }}
              >
                <X />
              </Button>
            )}
          </span>
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
              <SlidersHorizontal />
              Set scope
              <ChevronDown />
            </PopoverTrigger>
            <PopoverContent align="end" className="space-y-3">
              <PopoverTitle>Dataset scope</PopoverTitle>
              <PopoverDescription>
                Choose a dataset, or let the agent choose from your question.
              </PopoverDescription>
              <Label htmlFor="ask-dataset">Dataset</Label>
              <NativeSelect
                id="ask-dataset"
                value={dataset}
                onChange={(event) => {
                  setDataset(event.target.value)
                  setScope(
                    event.target.value ? { dataset: event.target.value } : {}
                  )
                }}
              >
                <NativeSelectOption value="">
                  Chosen by the agent
                </NativeSelectOption>
                <NativeSelectOption value="bgl">BGL</NativeSelectOption>
                <NativeSelectOption value="openstack">
                  OpenStack
                </NativeSelectOption>
              </NativeSelect>
            </PopoverContent>
          </Popover>
        </div>
        <InputGroup className="rounded-xl bg-card shadow-none has-disabled:bg-card has-disabled:opacity-100 dark:bg-card dark:has-disabled:bg-card">
          <InputGroupTextarea
            id="question"
            ref={input}
            aria-label="Your question"
            aria-describedby="chat-availability"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about errors, recurring problems, or priorities…"
            rows={3}
            maxLength={12000}
            className="min-h-28 p-4 text-base"
          />
          <InputGroupAddon
            align="block-end"
            className="justify-between px-4 pb-3"
          >
            <span className="text-xs font-normal text-muted-foreground">
              {labels[role]} · UTC
            </span>
            <InputGroupButton
              variant="default"
              size="sm"
              disabled
              aria-label="Send unavailable in this preliminary interface"
            >
              <ArrowUp />
              Send
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <p
          id="chat-availability"
          className="mt-3 text-xs leading-5 text-muted-foreground"
        >
          Preliminary interface · Chat is not connected yet. Your draft stays
          editable.
        </p>
      </section>
      <Alert className="mt-6 bg-transparent">
        <CircleHelp />
        <AlertTitle>Ask with Claude now</AlertTitle>
        <AlertDescription>
          The MCP server already provides the shared tools and role playbooks.{" "}
          <Link
            href="/datasets#connect"
            className="text-link underline underline-offset-4"
          >
            Connect from Claude{" "}
            <ArrowRight className="inline size-3" aria-hidden="true" />
          </Link>
        </AlertDescription>
      </Alert>
      <div className="mt-auto pt-12">
        <Card className="border-0 bg-transparent shadow-none">
          <CardContent className="grid gap-5 p-0 text-xs leading-5 text-muted-foreground sm:grid-cols-3">
            <p className="flex gap-2.5">
              <ScanSearch className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong className="block font-medium text-foreground">
                  Choose a perspective
                </strong>
                The same corpus. A different question and next step.
              </span>
            </p>
            <p className="flex gap-2.5">
              <Database className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong className="block font-medium text-foreground">
                  Inspect the evidence
                </strong>
                Open the SQL, scope, and facts behind a result.
              </span>
            </p>
            <p className="flex gap-2.5">
              <FileCheck2 className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong className="block font-medium text-foreground">
                  Check the numbers
                </strong>
                Facts link to receipts across the web and MCP.
              </span>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
