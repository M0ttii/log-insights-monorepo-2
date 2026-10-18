import { memo, useState } from "react"
import { isToolUIPart, type ChatStatus, type UIMessage } from "ai"
import Markdown, { type Components } from "react-markdown"
import { Check, Copy, LoaderCircle } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Bubble, BubbleContent } from "@workspace/ui/components/bubble"
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
import { ToolCall } from "./ToolCall"
import type { Interruption } from "./types"

const markdownComponents: Components = {
  img: () => null,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
}
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

const ConversationMessage = memo(function ConversationMessage({
  message,
  interruption,
  busy,
}: {
  message: UIMessage
  interruption?: Interruption
  busy: boolean
}) {
  const user = message.role === "user"
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
  return (
    <article
      aria-label={user ? "Your question" : "Assistant response"}
      className="min-w-0"
    >
      <Message align={user ? "end" : "start"}>
        <MessageContent className="gap-5">
          {message.parts.map((part, partIndex) => {
            if (part.type === "text")
              return user ? (
                <Bubble
                  key={partIndex}
                  variant="muted"
                  align="end"
                  className="max-w-[92%] sm:max-w-[85%]"
                >
                  <BubbleContent className="px-4 py-3 text-sm leading-7 whitespace-pre-wrap">
                    {part.text}
                  </BubbleContent>
                </Bubble>
              ) : (
                <div key={partIndex} className="chat-prose">
                  <Markdown skipHtml components={markdownComponents}>
                    {part.text}
                  </Markdown>
                </div>
              )
            if (isToolUIPart(part))
              return (
                <ToolCall
                  key={part.toolCallId}
                  part={part}
                  interruption={interruption}
                />
              )
            // Reasoning parts are private; only the agent's public, transient
            // progress updates belong in the status line at the LOG-48 seam.
            return null
          })}
          {!user && interruption && (
            <output className="text-xs text-muted-foreground">
              {interruption === "stopped" ? "Stopped" : "Interrupted"} · partial
              response. Completed tool receipts remain available.
            </output>
          )}
          {!user && text && !busy && (
            <MessageFooter className="gap-2 px-0">
              <CopyAnswer text={text} />
              <span className="text-xs text-muted-foreground">
                {interruption
                  ? "Not verified"
                  : "See tool receipts for evidence"}
              </span>
            </MessageFooter>
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
}: {
  messages: UIMessage[]
  status: ChatStatus
  interruptions?: Record<string, Interruption>
}) {
  const busy = status === "streaming" || status === "submitted"
  return (
    <MessageScrollerProvider>
      <MessageScroller aria-label="Conversation">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-10 px-5 pt-8 pb-10 sm:px-8">
            {messages
              .filter((message) => message.role !== "system")
              .map((message, index) => (
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
                  />
                </MessageScrollerItem>
              ))}
            {busy && (
              <output className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle
                  className="size-4 motion-safe:animate-spin"
                  aria-hidden="true"
                />
                {status === "submitted"
                  ? "Starting investigation…"
                  : "Working through the evidence…"}
              </output>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
})
