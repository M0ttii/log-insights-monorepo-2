import { Database, ExternalLink, FileCode2, Terminal } from "lucide-react"
import { z } from "zod"
import type { ToolOutcome } from "@workspace/domain/tool"
import { CONTRACT_VERSION } from "@workspace/domain/version"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@workspace/ui/components/card"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
import { Badge } from "@workspace/ui/components/badge"
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockCopyButton,
} from "@workspace/ui/components/code-block"
import { DatasetCards } from "./DatasetCards"
import { ResultView } from "@/components/results/ResultView"
import { ReceiptLink } from "@/components/evidence/ReceiptLink"
import { features } from "@/components/evidence/features"
import { ToolErrorNotice } from "@/components/workspace/ToolErrorNotice"
const codeCommand =
  "claude mcp add --transport stdio log-insights -- pnpm --silent --dir /absolute/path/to/log-insights-monorepo-2 mcp"
export function CorpusView({
  outcome,
  playbookVersion,
}: {
  outcome: ToolOutcome<unknown>
  playbookVersion: string
}) {
  const parsed = outcome.ok
    ? z.record(z.string(), z.unknown()).safeParse(outcome.result.data)
    : null
  const data = parsed?.success ? parsed.data : null
  return (
    <div className="workspace-page">
      <h1 className="page-heading">Know your corpus</h1>
      <p className="page-description">
        Datasets, boundaries, and the tools behind every answer.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Badge variant="outline">
          <FileCode2 />
          Contract {CONTRACT_VERSION}
        </Badge>
        <Badge variant="outline">
          <FileCode2 />
          Playbooks {playbookVersion}
        </Badge>
      </div>
      <section className="mt-8" aria-label="Corpus metadata">
        {!outcome.ok ? (
          <ToolErrorNotice error={outcome.error} />
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <ReceiptLink id={outcome.result.receipt.receipt_id} />
              <span className="text-xs text-muted-foreground">
                SereneDB {outcome.result.receipt.duration_ms} ms
              </span>
            </div>
            <Tabs defaultValue="datasets">
              <TabsList className="max-w-full overflow-auto">
                <TabsTrigger value="datasets">Datasets & schema</TabsTrigger>
                <TabsTrigger value="ownership">Ownership</TabsTrigger>
                <TabsTrigger value="limits">Limits</TabsTrigger>
                <TabsTrigger value="versions">Versions</TabsTrigger>
              </TabsList>
              {["datasets", "ownership", "limits", "versions"].map((key) => (
                <TabsContent key={key} value={key} className="min-w-0 pt-5">
                  {key === "ownership" && (
                    <p className="mb-4 text-sm text-muted-foreground">
                      Fictional ownership · Unmapped components are unowned.
                    </p>
                  )}
                  <>
                    {key === "datasets" ? (
                      <DatasetCards
                        datasets={data?.datasets}
                        result={outcome.result}
                      />
                    ) : (
                      <Card className="min-w-0 shadow-none">
                        <CardContent>
                          <ResultView
                            value={data?.[key]}
                            facts={outcome.result.facts}
                            receiptId={outcome.result.receipt.receipt_id}
                            path={`/result/${key}`}
                          />
                        </CardContent>
                      </Card>
                    )}
                  </>
                </TabsContent>
              ))}
            </Tabs>
          </>
        )}
      </section>
      <section className="mt-10" aria-labelledby="functions-heading">
        <h2
          id="functions-heading"
          className="mb-4 flex items-center gap-2 text-base font-semibold"
        >
          <Database className="size-4" />
          Computed in SereneDB
        </h2>
        <p className="mb-4 max-w-prose text-sm leading-6 text-muted-foreground">
          Receipts show a function chip only when its SQL contains that
          function. Search, episodes, trends, and percentiles stay in the
          database.
        </p>
        <dl className="divide-y rounded-lg border px-4">
          {features.map((feature) => (
            <div
              key={feature.label}
              className="grid gap-1 py-3 text-sm sm:grid-cols-[12rem_1fr]"
            >
              <dt className="font-medium">{feature.label}</dt>
              <dd className="text-muted-foreground">{feature.description}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section
        id="connect"
        className="mt-10 scroll-mt-6"
        aria-labelledby="connect-heading"
      >
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle
              id="connect-heading"
              className="flex items-center gap-2 text-base"
            >
              <Terminal className="size-4" />
              Connect from Claude
            </CardTitle>
            <CardDescription>
              The same tools, facts, and receipts in Claude Code and Claude
              Desktop. Run commands from your checkout.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <CodeBlock size="sm">
              <CodeBlockHeader>
                <CodeBlockTitle>
                  Claude Code · replace the absolute path
                </CodeBlockTitle>
                <CodeBlockCopyButton value={codeCommand} />
              </CodeBlockHeader>
              <CodeBlockContent wrap>{codeCommand}</CodeBlockContent>
            </CodeBlock>
            <CodeBlock size="sm">
              <CodeBlockHeader>
                <CodeBlockTitle>
                  Claude Desktop · generate your local configuration
                </CodeBlockTitle>
                <CodeBlockCopyButton value="pnpm --silent mcp:desktop-config" />
              </CodeBlockHeader>
              <CodeBlockContent>
                pnpm --silent mcp:desktop-config
              </CodeBlockContent>
            </CodeBlock>
            <p className="text-xs leading-5 text-muted-foreground">
              Paste the generated entry into your Claude Desktop MCP
              configuration. Copy a receipt or fact ID from Claude into Open
              receipt above to inspect the same evidence here.
            </p>
          </CardContent>
        </Card>
      </section>
      <p className="mt-8 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        Dataset sources:
        <a
          className="inline-flex items-center gap-1 text-link underline underline-offset-4"
          href="https://github.com/logpai/loghub/tree/master/BGL"
          target="_blank"
          rel="noreferrer"
        >
          Loghub · BGL
          <ExternalLink className="size-3" />
        </a>
        <a
          className="inline-flex items-center gap-1 text-link underline underline-offset-4"
          href="https://github.com/logpai/loghub/tree/master/OpenStack"
          target="_blank"
          rel="noreferrer"
        >
          Loghub · OpenStack
          <ExternalLink className="size-3" />
        </a>
      </p>
    </div>
  )
}
