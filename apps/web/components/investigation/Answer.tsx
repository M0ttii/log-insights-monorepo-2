import {
  createContext,
  useContext,
  useId,
  useMemo,
  type ComponentProps,
} from "react"
import Markdown, { defaultUrlTransform, type Components } from "react-markdown"
import {
  answerFindings,
  detectSections,
  extractCitations,
  findUncited,
  type AnswerRole,
  type SubmittedCheck,
} from "@workspace/domain/answer"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { ReceiptLink } from "../evidence/ReceiptLink"

type Mark = { start: number; end: number; url: string }
function sourceStart(node: object): number | null {
  if (
    !("position" in node) ||
    typeof node.position !== "object" ||
    node.position === null
  )
    return null
  const position = node.position
  if (
    !("start" in position) ||
    typeof position.start !== "object" ||
    position.start === null
  )
    return null
  return "offset" in position.start && typeof position.start.offset === "number"
    ? position.start.offset
    : null
}

/** Annotate parsed text nodes so URL targets, code and Markdown syntax stay intact. */
function markTree(tree: unknown, source: string, marks: Mark[]) {
  if (
    typeof tree !== "object" ||
    tree === null ||
    !("children" in tree) ||
    !Array.isArray(tree.children)
  )
    return
  tree.children = tree.children.flatMap((child: unknown): unknown[] => {
    if (typeof child !== "object" || child === null || !("type" in child))
      return [child]
    // Existing links already have a focusable control; never nest controls in one.
    if (child.type === "link" || child.type === "linkReference") return [child]
    if (
      child.type !== "text" ||
      !("value" in child) ||
      typeof child.value !== "string"
    ) {
      markTree(child, source, marks)
      return [child]
    }
    const start = sourceStart(child)
    const value = child.value
    if (start === null || source.slice(start, start + value.length) !== value)
      return [child]
    const contained = marks.filter(
      (mark) => mark.start >= start && mark.end <= start + value.length
    )
    if (contained.length === 0) return [child]
    const nodes: object[] = []
    let cursor = 0
    for (const mark of contained) {
      const from = mark.start - start
      const to = mark.end - start
      if (from > cursor)
        nodes.push({ type: "text", value: value.slice(cursor, from) })
      nodes.push({
        type: "link",
        url: mark.url,
        children: [{ type: "text", value: value.slice(from, to) }],
      })
      cursor = to
    }
    if (cursor < value.length)
      nodes.push({ type: "text", value: value.slice(cursor) })
    return nodes
  })
}

function outlineLabel(value: string) {
  return { type: "text", value }
}

function outlineText(value: string) {
  return {
    type: "emphasis",
    data: { hName: "span" },
    children: [outlineLabel(value)],
  }
}

/** Build jumps from rendered Markdown nodes; the domain owns section recognition. */
function addOutline(
  tree: unknown,
  source: string,
  role: AnswerRole | null,
  answerId: string
) {
  if (
    typeof tree !== "object" ||
    tree === null ||
    !("children" in tree) ||
    !Array.isArray(tree.children)
  )
    return
  const targets = new Map<string, string>()
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return
    if ("type" in node && (node.type === "heading" || node.type === "strong")) {
      const start = sourceStart(node)
      if (start !== null) {
        const lineStart = source.lastIndexOf("\n", start - 1) + 1
        const newline = source.indexOf("\n", start)
        const line = source.slice(
          lineStart,
          newline === -1 ? undefined : newline
        )
        for (const section of detectSections(line, role).present) {
          if (targets.has(section)) continue
          const id = `${answerId}-section-${section.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`
          targets.set(section, id)
          Object.assign(node, {
            data: {
              hProperties: {
                id,
                tabIndex: -1,
                className:
                  "scroll-mt-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              },
            },
          })
        }
      }
    }
    if ("children" in node && Array.isArray(node.children))
      node.children.forEach(visit)
  }
  visit(tree)
  const sections = detectSections(source, role)
  tree.children.unshift({
    type: "paragraph",
    data: {
      hName: "nav",
      hProperties: {
        "aria-label": "Answer outline",
        className:
          "mb-4 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground",
      },
    },
    children: [
      ...sections.present.map((section) => {
        const id = targets.get(section)
        return id
          ? { type: "link", url: `#${id}`, children: [outlineLabel(section)] }
          : outlineText(section)
      }),
      ...sections.missing.map(({ section }) =>
        outlineText(`Missing section: ${section}`)
      ),
    ],
  })
}

function answerMarks(
  text: string,
  role: AnswerRole | null,
  answerId: string,
  outline: boolean
) {
  const citations = extractCitations(text)
  const uncited = findUncited(text)
  let prefix = "answer-marker"
  while (text.includes(prefix)) prefix += "-"
  const marks = [
    ...citations.map((citation, index) => ({
      ...citation,
      url: `#${prefix}-citation-${index}`,
    })),
    ...uncited.map((number, index) => ({
      ...number,
      url: `#${prefix}-uncited-${index}`,
    })),
  ].toSorted((a, b) => a.start - b.start)
  const plugin = () => (tree: unknown) => {
    markTree(tree, text, marks)
    if (outline) addOutline(tree, text, role, answerId)
  }
  return { citations, uncited, prefix, plugin }
}

type AnswerMarkings = Pick<
  ReturnType<typeof answerMarks>,
  "citations" | "uncited" | "prefix"
> & {
  findings: ReturnType<typeof answerFindings>
  hasChecks: boolean
}
const AnswerMarkingsContext = createContext<AnswerMarkings>({
  citations: [],
  uncited: [],
  prefix: "",
  findings: [],
  hasChecks: false,
})

function citationStatus(
  finding: ReturnType<typeof answerFindings>[number] | undefined,
  hasChecks: boolean
): NonNullable<ComponentProps<typeof ReceiptLink>["status"]> {
  if (finding?.kind === "mismatch") return "mismatch"
  if (finding?.kind === "unresolved") return "unresolved"
  if (!hasChecks || finding?.kind === "unchecked") return "unchecked"
  return "verified"
}

function AnswerLink({ href, children }: ComponentProps<"a">) {
  const { citations, uncited, prefix, findings, hasChecks } = useContext(
    AnswerMarkingsContext
  )

  const citationIndex = href?.startsWith(`#${prefix}-citation-`)
    ? href.slice(`#${prefix}-citation-`.length)
    : undefined
  const citation =
    citationIndex === undefined ? undefined : citations[Number(citationIndex)]
  if (citation) {
    const finding = findings.find(
      (item) => "fact" in item && item.fact === citation.id
    )
    return (
      <ReceiptLink
        id={citation.receiptId}
        fact={citation.kind === "fact" ? citation.id : undefined}
        status={citationStatus(finding, hasChecks)}
        mismatchOn={
          finding?.kind === "mismatch" ? finding.mismatch_on : undefined
        }
      />
    )
  }
  const numberIndex = href?.startsWith(`#${prefix}-uncited-`)
    ? href.slice(`#${prefix}-uncited-`.length)
    : undefined
  const number =
    numberIndex === undefined ? undefined : uncited[Number(numberIndex)]
  if (number)
    return (
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="xs" />}
          className="inline h-auto px-0 font-normal text-inherit underline decoration-(--verification-uncited-foreground) decoration-dotted underline-offset-4"
          aria-label={`Uncited number ${number.value}: No fact ID next to this number`}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent>No fact ID next to this number</TooltipContent>
      </Tooltip>
    )
  if (href?.startsWith("#")) return <a href={href}>{children}</a>
  return href && /^(https?:|mailto:|\/|#)/i.test(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  )
}
const markdownComponents: Components = { img: () => null, a: AnswerLink }

export function Answer({
  text,
  role,
  checks,
  outline = false,
}: {
  text: string
  role: AnswerRole | null
  checks: SubmittedCheck[]
  outline?: boolean
}) {
  const answerId = useId()
  const { citations, uncited, prefix, plugin } = useMemo(
    () => answerMarks(text, role, answerId, outline),
    [text, role, answerId, outline]
  )
  const findings = useMemo(
    () => answerFindings({ text, role, checks }),
    [text, role, checks]
  )
  const markings = useMemo(
    () => ({
      citations,
      uncited,
      prefix,
      findings,
      hasChecks: checks.length > 0,
    }),
    [citations, uncited, prefix, findings, checks.length]
  )
  return (
    <div className="min-w-0 space-y-4">
      <div className="chat-prose min-w-0 wrap-anywhere">
        <AnswerMarkingsContext value={markings}>
          <Markdown
            skipHtml
            components={markdownComponents}
            urlTransform={defaultUrlTransform}
            remarkPlugins={[plugin]}
          >
            {text}
          </Markdown>
        </AnswerMarkingsContext>
      </div>
    </div>
  )
}
