"use client"
// Adapted from the demo's EventTimeline; data now comes from the tool schema.
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  XAxis,
  YAxis,
} from "recharts"
import { eventTrendOutputSchema } from "@workspace/domain/tools/event-trend"
import type { ToolResult } from "@workspace/domain/tool"
import { ChartContainer } from "@workspace/ui/components/chart"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { ResultView } from "@/components/results/ResultView"
import { formatUtcDate } from "@/components/workspace/format"
export function EventTimeline({ result }: { result: ToolResult<unknown> }) {
  const parsed = eventTrendOutputSchema.safeParse(result.data)
  if (!parsed.success) return null
  const { buckets } = parsed.data
  const rows = buckets.map((bucket) => ({
    ...bucket,
    count: bucket.capture_gap ? null : bucket.events,
  }))
  return (
    <Tabs defaultValue="chart">
      <TabsList aria-label="Trend presentation">
        <TabsTrigger value="chart">Chart</TabsTrigger>
        <TabsTrigger value="table">View as table</TabsTrigger>
      </TabsList>
      <TabsContent value="chart">
        <figure aria-label="BGL error events by UTC week. Use View as table for exact values and citations.">
          <ChartContainer
            className="h-56 w-full"
            config={{
              count: { label: "Error events", color: "var(--chart-1)" },
            }}
          >
            <LineChart
              data={rows}
              margin={{ top: 12, right: 12, left: 4, bottom: 8 }}
              accessibilityLayer
            >
              <defs>
                <pattern
                  id="partial-bucket"
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d="M0 6L6 0"
                    stroke="var(--muted-foreground)"
                    strokeWidth="1"
                  />
                </pattern>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket_start"
                tickFormatter={(value) => formatUtcDate(String(value))}
                minTickGap={45}
                tickLine={false}
                axisLine={false}
                fontSize={10}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                fontSize={10}
              />
              {rows
                .filter((row) => row.partial || row.capture_gap)
                .map((row) => (
                  <ReferenceArea
                    key={row.bucket_start}
                    x1={row.bucket_start}
                    x2={row.bucket_start}
                    stroke="var(--muted-foreground)"
                    strokeDasharray="3 3"
                    label={{
                      value: row.capture_gap ? "Gap" : "Partial",
                      position: "insideTop",
                      fontSize: 10,
                      fill: "var(--muted-foreground)",
                    }}
                    fill="url(#partial-bucket)"
                  />
                ))}
              <Line
                dataKey="count"
                type="linear"
                stroke="var(--color-count)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ChartContainer>
          <figcaption className="mt-2 text-xs leading-5 text-muted-foreground">
            Log events per week · UTC. Partial buckets are labelled; capture
            gaps interrupt the line.
          </figcaption>
        </figure>
      </TabsContent>
      <TabsContent value="table">
        <div className="max-h-96 overflow-auto">
          <ResultView
            value={buckets}
            facts={result.facts}
            receiptId={result.receipt.receipt_id}
            path="/result/buckets"
          />
        </div>
      </TabsContent>
    </Tabs>
  )
}
