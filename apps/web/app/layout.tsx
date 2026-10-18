import localFont from "next/font/local"
import type { Metadata } from "next"
import { Suspense } from "react"
import { AppShell } from "@/components/workspace/AppShell"
import { runTool } from "@/server/runtime"
import "./globals.css"

const mono = localFont({
  src: "./fonts/GeistMono-Latin.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 900",
})

export const metadata: Metadata = {
  title: "Log Insights",
  description:
    "Ask better questions. Follow the evidence. Every number has a receipt.",
}
export const dynamic = "force-dynamic"

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const corpus = await runTool("describe_corpus", {})
  return (
    <html
      lang="en"
      className={`dark ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Suspense>
          <AppShell corpus={corpus}>{children}</AppShell>
        </Suspense>
      </body>
    </html>
  )
}
