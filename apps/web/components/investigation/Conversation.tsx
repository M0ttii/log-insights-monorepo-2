import { memo, useState } from "react"
import type { ChatStatus, UIMessage } from "ai"
import { Check, Copy, LoaderCircle } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { Bubble, BubbleContent } from "@workspace/ui/components/bubble"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  Message,
  MessageContent,
  MessageFooter,
} from "@workspace/ui/components/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@workspace/ui/components/message-scroller"
import { ToolCalls } from "./ToolCalls"
import { Answer } from "./Answer"
import { Verification } from "./Verification"
import { ExportRun } from "./ExportRun"
import { findingText, projectMessage, textOf } from "./mapper"
import type { Interruption, RunContext } from "./types"
import { scopeSummary } from "./scope"

function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? "Answer copied" : "Copy answer"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setFailed(false)
          } catch {
            setFailed(true)
          }
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <output className={failed ? "text-xs text-muted-foreground" : "sr-only"}>
        {failed
          ? "Could not copy. Select and copy the answer text."
          : copied
            ? "Answer copied"
            : ""}
      </output>
    </>
  )
}

const roles = {
  engineer: "Engineer",
  team_lead: "Team Lead",
  manager: "Manager",
}
const phaseLabels = {
  preflight: "Reading corpus context…",
  investigate: "Working through the evidence…",
  answer: "Writing answer…",
  revise: "Revising after claim checks…",
}

const ConversationMessage = memo(function ConversationMessage({
  message,
  interruption,
  busy,
  context,
}: {
  message: UIMessage
  interruption?: Interruption
  busy: boolean
  context?: RunContext
}) {
  const [toolsOpen, setToolsOpen] = useState({ draft: false, final: false })
  const user = message.role === "user"
  const view = projectMessage(message)
  const role = context?.role ?? null
  const text = user ? textOf(message.parts) : textOf(view.final)
  const incomplete =
    interruption ||
    (view.run && ["stopped", "timeout", "error"].includes(view.run.status))
  const declined = view.run?.status === "refusal"
  const toolInterruption = interruption ?? (incomplete ? "failed" : undefined)
  function content(parts: UIMessage["parts"], draft = false) {
    // The whole version is marked once so citations across streamed text parts
    // use the same canonical sentence and code-span boundaries.
    const answer = textOf(parts)
    const version = draft || !view.revised ? "draft" : "final"
    return (
      <>
        <ToolCalls
          parts={parts}
          interruption={toolInterruption}
          open={toolsOpen[version]}
          onOpenChange={(open) =>
            setToolsOpen((previous) => ({ ...previous, [version]: open }))
          }
        />
        {answer && (
          <Answer
            text={answer}
            role={role}
            checks={draft ? view.draftChecks : view.checks}
            outline={!draft && !busy && !incomplete && !declined}
          />
        )}
      </>
    )
  }
  return (
    <article
      aria-label={user ? "Your question" : "Assistant response"}
      className="min-w-0"
    >
      <Message align={user ? "end" : "start"}>
        <MessageContent className="gap-5">
          {context && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{roles[context.role]}</Badge>
              <span className="min-w-0 wrap-anywhere">
                {scopeSummary(context.scope)}
              </span>
            </div>
          )}
          {user ? (
            <Bubble
              variant="muted"
              align="end"
              className="max-w-[92%] sm:max-w-[85%]"
            >
              <BubbleContent className="px-4 py-3 text-sm leading-7 wrap-anywhere whitespace-pre-wrap">
                {text}
              </BubbleContent>
            </Bubble>
          ) : (
            <>
              <ToolCalls parts={view.tools} interruption={toolInterruption} />
              {view.revised && (
                <>
                  <Collapsible className="min-w-0">
                    <CollapsibleTrigger
                      render={<Button variant="ghost" size="sm" />}
                      className="h-auto max-w-full flex-wrap justify-start gap-2 text-left whitespace-normal"
                    >
                      Draft · {view.draftFindings.length} findings · Show draft
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-4 space-y-4 border-l pl-4">
                      {content(view.draft, true)}
                      {view.draftFindings.length > 0 && (
                        <ul
                          aria-label="Draft findings"
                          className="space-y-1 text-xs leading-5 text-muted-foreground"
                        >
                          {view.draftFindings.map((finding, index) => (
                            <li key={index}>{findingText(finding)}</li>
                          ))}
                        </ul>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                  <p className="text-xs leading-6 text-muted-foreground">
                    Revised after check:{" "}
                    {view.draftFindings.map(findingText).join("; ")}
                  </p>
                </>
              )}
              {content(view.final)}
              {declined && (
                <output className="text-sm text-muted-foreground">
                  The model declined this request. Your question is preserved.
                </output>
              )}
              {incomplete && (
                <output className="text-xs leading-6 text-muted-foreground">
                  {view.run?.status === "timeout"
                    ? "Timed out"
                    : interruption === "stopped" ||
                        view.run?.status === "stopped"
                      ? "Stopped"
                      : "Interrupted"}{" "}
                  · partial response. Completed tool receipts remain available.
                  Partial answer – not verified.
                </output>
              )}
              {!busy && !incomplete && !declined && text && (
                <Verification
                  text={text}
                  role={role}
                  checks={view.checks}
                  parts={message.parts}
                />
              )}
              {!busy && (text || view.run) && (
                <MessageFooter className="flex-wrap gap-2 px-0">
                  {text && <CopyAnswer text={text} />}
                  {incomplete && (
                    <span className="text-xs text-muted-foreground">
                      Not verified
                    </span>
                  )}
                  {view.run && context && (
                    <ExportRun
                      message={message}
                      context={context}
                      run={view.run}
                    />
                  )}
                </MessageFooter>
              )}
              {busy && (
                <output className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle
                    className="size-4 motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                  {view.phase
                    ? phaseLabels[view.phase.kind]
                    : "Working through the evidence…"}
                </output>
              )}
            </>
          )}
        </MessageContent>
      </Message>
    </article>
  )
})

export const Conversation = memo(function Conversation({
  messages,
  status,
  interruptions,
  contexts,
}: {
  messages: UIMessage[]
  status: ChatStatus
  interruptions?: Record<string, Interruption>
  contexts?: Record<string, RunContext>
}) {
  const busy = status === "streaming" || status === "submitted"
  const contextualMessages: {
    message: UIMessage
    context: RunContext | undefined
  }[] = []
  let currentContext: RunContext | undefined
  for (const message of messages) {
    if (message.role === "system") continue
    if (message.role === "user") currentContext = contexts?.[message.id]
    contextualMessages.push({ message, context: currentContext })
  }
  return (
    <MessageScrollerProvider>
      <MessageScroller aria-label="Conversation">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-10 px-5 pt-8 pb-10 sm:px-8">
            {contextualMessages.map(({ message, context }, index) => (
              <MessageScrollerItem
                key={message.id}
                scrollAnchor={
                  message.role === "user" && index === messages.length - 1
                }
              >
                <ConversationMessage
                  message={message}
                  interruption={interruptions?.[message.id]}
                  busy={busy && index === messages.length - 1}
                  context={context}
                />
              </MessageScrollerItem>
            ))}
            {status === "submitted" && (
              <output className="text-sm text-muted-foreground">
                Starting investigation…
              </output>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
})
