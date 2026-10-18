"use client"

import Link from "next/link"
import { useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, type ChatTransport, type UIMessage } from "ai"
import {
  ArrowUp,
  ArrowUpRight,
  BriefcaseBusiness,
  ChevronDown,
  CircleHelp,
  MessageSquarePlus,
  ScanSearch,
  Square,
  Unplug,
  Users,
  Waypoints,
  Wrench,
} from "lucide-react"
import type { Filter } from "@workspace/domain/filters"
import type { Brief } from "@/server/brief"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@workspace/ui/components/input-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@workspace/ui/components/empty"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Conversation } from "./Conversation"
import { ScopeControls } from "./ScopeControls"
import { readScope, scopeError } from "./scope"
import { projectMessage, requestMessages } from "./mapper"
import type { Interruption, RunContext } from "./types"

const roles = {
  engineer: {
    label: "Engineer",
    icon: Wrench,
    placeholder: "Ask about an error, a node, or a failure…",
  },
  team_lead: {
    label: "Team Lead",
    icon: Users,
    placeholder: "Ask about recurring problems and your team’s next step…",
  },
  manager: {
    label: "Manager",
    icon: BriefcaseBusiness,
    placeholder: "Ask what to investigate first, and why…",
  },
}
type Role = keyof typeof roles
function isRole(value: unknown): value is Role {
  return value === "engineer" || value === "team_lead" || value === "manager"
}

// The server resolves prior completed answers from trusted run records. Large
// tool results and private reasoning never travel back in a follow-up request.
const transport = new DefaultChatTransport({
  api: "/api/chat",
  prepareSendMessagesRequest: ({ id, messages, body }) => ({
    body: { ...body, id, messages: requestMessages(messages) },
  }),
})
export function InvestigationView({
  brief,
  available = false,
  disabledMessage = "Chat unavailable: no model configured",
  chatTransport = transport,
}: {
  brief: Brief
  available?: boolean
  disabledMessage?: string
  chatTransport?: ChatTransport<UIMessage>
}) {
  const [role, setRole] = useState<Role>("engineer")
  const [question, setQuestion] = useState("")
  const [scope, setScope] = useState<Filter>({})
  const [interruptions, setInterruptions] = useState<
    Record<string, Interruption>
  >({})
  const [contexts, setContexts] = useState<Record<string, RunContext>>({})
  const input = useRef<HTMLTextAreaElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const submittedQuestion = useRef<string | null>(null)
  function finishQuestion(restore: boolean) {
    if (restore && submittedQuestion.current !== null)
      setQuestion(submittedQuestion.current)
    submittedQuestion.current = null
    if (form.current?.contains(document.activeElement))
      input.current?.focus({ preventScroll: true })
  }
  const chat = useChat({
    transport: chatTransport,
    onError: () => finishQuestion(true),
    onFinish: ({ message, isAbort, isError, isDisconnect }) => {
      if (isAbort || isDisconnect || isError)
        setInterruptions((previous) => ({
          ...previous,
          [message.id]: isAbort ? "stopped" : "failed",
        }))
      const completed = projectMessage(message).run?.status
      finishQuestion(
        isAbort ||
          isError ||
          isDisconnect ||
          (completed !== undefined && completed !== "completed")
      )
    },
  })
  const busy = chat.status === "submitted" || chat.status === "streaming"
  const current = brief.roles.find((item) => item.id === role)
  const RoleIcon = roles[role].icon
  const problem = scopeError(scope)
  const canSend =
    available &&
    !busy &&
    question.trim().length > 0 &&
    question.length <= 4000 &&
    !problem
  const hasMessages = chat.messages.length > 0

  function newInvestigation() {
    chat.setMessages([])
    chat.clearError()
    setQuestion("")
    setScope({})
    setInterruptions({})
    setContexts({})
    input.current?.focus()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 px-5 py-3 sm:px-8">
        <span className="text-sm text-muted-foreground">New investigation</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="New chat"
            disabled={
              busy ||
              (!hasMessages && !question && Object.keys(scope).length === 0)
            }
            onClick={newInvestigation}
          >
            <MessageSquarePlus />
            <span className="hidden sm:inline">New chat</span>
          </Button>
          <Link
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
            aria-label="How it works"
            href="/datasets#connect"
          >
            <CircleHelp />
          </Link>
        </div>
      </header>

      {hasMessages ? (
        <div className="min-h-0 flex-1">
          <Conversation
            messages={chat.messages}
            status={chat.status}
            interruptions={interruptions}
            contexts={contexts}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Empty className="chat-welcome mx-auto min-h-full max-w-3xl gap-8 px-5 py-8 sm:px-8">
            <EmptyHeader className="max-w-xl gap-3">
              <EmptyMedia className="mb-3 text-link">
                <Waypoints className="size-8 stroke-[1.3]" aria-hidden="true" />
              </EmptyMedia>
              <h1 className="text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                What do you need to know?
              </h1>
              <EmptyDescription className="max-w-md text-sm leading-6">
                Ask a question. Trace the evidence.
                <br className="hidden sm:block" /> Find your next step.
              </EmptyDescription>
            </EmptyHeader>
            <section
              className="w-full max-w-xl text-left"
              aria-label={`Example questions for ${roles[role].label}`}
            >
              {brief.examples
                .filter((example) => example.role === role)
                .map((example) => (
                  <Button
                    key={example.id}
                    variant="ghost"
                    className="group h-auto w-full justify-start gap-3 rounded-lg px-3 py-3 text-left text-sm leading-6 font-normal whitespace-normal text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setQuestion(example.question.trim())
                      setScope(readScope(example.scope))
                      input.current?.focus()
                    }}
                  >
                    <ScanSearch
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="line-clamp-2 flex-1">
                      {example.question.trim()}
                    </span>
                    <ArrowUpRight
                      className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      aria-hidden="true"
                    />
                  </Button>
                ))}
            </section>
          </Empty>
        </div>
      )}

      <section
        aria-label="Question composer"
        className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 pb-4 sm:px-8 sm:pb-6"
      >
        {chat.error && (
          <Alert className="mb-3">
            <Unplug />
            <AlertTitle>Response interrupted</AlertTitle>
            <AlertDescription>
              Your question is preserved. Check the connection and send it
              again.
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={!canSend}
                onClick={() => form.current?.requestSubmit()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSend || submittedQuestion.current !== null) return
            chat.clearError()
            submittedQuestion.current = question
            setQuestion("")
            input.current?.focus({ preventScroll: true })
            const id = crypto.randomUUID()
            setContexts((previous) => ({
              ...previous,
              [id]: { role, scope, question: question.trim() },
            }))
            void chat.sendMessage(
              {
                id,
                role: "user",
                parts: [{ type: "text", text: question.trim() }],
              },
              { body: { role, scope } }
            )
          }}
        >
          <InputGroup className="chat-composer overflow-hidden rounded-xl border-border bg-card has-disabled:bg-card has-disabled:opacity-100 dark:bg-card dark:has-disabled:bg-card">
            <InputGroupTextarea
              ref={input}
              aria-label="Your question"
              aria-describedby="chat-availability"
              placeholder={roles[role].placeholder}
              value={question}
              maxLength={4000}
              readOnly={busy}
              rows={2}
              className="max-h-48 min-h-24 resize-none px-4 pt-4 pb-2 text-sm leading-7 md:text-sm"
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  if (canSend) form.current?.requestSubmit()
                }
              }}
            />
            <InputGroupAddon
              align="block-end"
              className="flex-wrap gap-0 px-2 pb-2"
            >
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="sm" />}
                  disabled={busy}
                  aria-label={`Choose perspective, ${roles[role].label}`}
                  className="gap-1.5 text-xs"
                >
                  <RoleIcon className="size-3.5" />
                  {roles[role].label}
                  <ChevronDown className="size-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  side="top"
                  className="w-80 max-w-[calc(100vw-2rem)]"
                >
                  <DropdownMenuRadioGroup
                    value={role}
                    onValueChange={(value) => {
                      if (isRole(value)) setRole(value)
                    }}
                  >
                    {Object.entries(roles).map(([id, item]) => (
                      <DropdownMenuRadioItem
                        closeOnClick
                        key={id}
                        value={id}
                        className="items-start py-3"
                      >
                        <item.icon className="mt-0.5 size-4 shrink-0" />
                        <span>
                          <span className="block font-medium">
                            {item.label}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {
                              brief.roles.find((entry) => entry.id === id)
                                ?.description
                            }
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="mx-1 h-4 border-l" aria-hidden="true" />
              <ScopeControls
                scope={scope}
                onChange={setScope}
                disabled={busy}
              />
              <InputGroupButton
                type={busy ? "button" : "submit"}
                variant="default"
                size="icon-sm"
                className="ml-auto rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover"
                disabled={!busy && !canSend}
                aria-label={
                  busy
                    ? "Stop response"
                    : available
                      ? "Send question"
                      : "Send unavailable"
                }
                onClick={
                  busy
                    ? () => {
                        void chat.stop()
                      }
                    : undefined
                }
              >
                {busy ? (
                  <Square className="size-3.5 fill-current" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
        <p
          className="mt-2.5 px-1 text-xs leading-5 text-muted-foreground"
          aria-live="polite"
        >
          {current?.description}
        </p>
        {(scope.from || scope.to) && (
          <p className="mt-1 flex flex-wrap gap-x-1 px-1 font-mono text-xs leading-5 text-muted-foreground">
            <span className="whitespace-nowrap">
              [{scope.from ?? "span start"},
            </span>
            <span className="whitespace-nowrap">{scope.to ?? "span end"})</span>
            <span className="whitespace-nowrap">· UTC</span>
          </p>
        )}
        {problem && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {problem}
          </p>
        )}
        <p
          id="chat-availability"
          className="mt-3 flex items-start justify-center gap-1.5 text-center text-xs leading-5 text-muted-foreground"
        >
          {available ? (
            "Answers can be incomplete. Follow the receipts to verify the evidence."
          ) : (
            <>
              <Unplug className="mt-1 size-3 shrink-0" aria-hidden="true" />
              <span>
                {disabledMessage}. Your question can be prepared here.{" "}
                <Link
                  className="text-link underline underline-offset-4"
                  href="/datasets#connect"
                >
                  Use Claude via MCP
                  <ArrowUpRight
                    className="ml-0.5 inline size-3"
                    aria-hidden="true"
                  />
                </Link>
              </span>
            </>
          )}
        </p>
      </section>
    </div>
  )
}
