"use client"
// Adapted from the original demo's AppShell and the shadcn sidebar-07 block.
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState, useSyncExternalStore } from "react"
import {
  ArrowUpRight,
  ChartNoAxesCombined,
  ChevronRight,
  Database,
  FileText,
  HelpCircle,
  Logs,
  MessageSquare,
  Moon,
  Sun,
  Waypoints,
} from "lucide-react"
import type { ToolOutcome } from "@workspace/domain/tool"
import { CONTRACT_VERSION } from "@workspace/domain/version"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group"
import { Badge } from "@workspace/ui/components/badge"
import { EvidenceDrawer } from "@/components/evidence/EvidenceDrawer"
import { ReceiptLink } from "@/components/evidence/ReceiptLink"
import { loadedDatasetIds } from "@/components/datasets/catalog"
import { LoadedDatasetsProvider } from "@/components/providers/LoadedDatasets"

const links = [
  { title: "Ask", href: "/investigations/new", icon: MessageSquare },
  { title: "Overview", href: "/workspace", icon: ChartNoAxesCombined },
  { title: "Logs", href: "/logs", icon: Logs },
  { title: "Corpus", href: "/datasets", icon: Database },
]
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener)
  return () => window.removeEventListener("storage", listener)
}
function getTheme() {
  try {
    return localStorage.getItem("log-insights-theme") ?? "dark"
  } catch {
    return "dark"
  }
}
function AppSidebar() {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const theme = useSyncExternalStore(subscribe, getTheme, () => "dark")
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }, [theme])
  function toggleTheme() {
    try {
      localStorage.setItem(
        "log-insights-theme",
        theme === "dark" ? "light" : "dark"
      )
      window.dispatchEvent(new Event("storage"))
    } catch {
      document.documentElement.classList.toggle("dark")
    }
  }
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center border-b">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/investigations/new" />}
              tooltip="Log Insights"
              onClick={() => setOpenMobile(false)}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Waypoints className="size-3.5" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold tracking-tight">
                Log Insights
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="px-2 pt-5">
        <nav aria-label="Main navigation">
          <SidebarMenu>
            {links.map(({ title, href, icon: Icon }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  render={<Link href={href} />}
                  className="h-9"
                  isActive={pathname === href}
                  aria-current={pathname === href ? "page" : undefined}
                  tooltip={title}
                  onClick={() => setOpenMobile(false)}
                >
                  <Icon aria-hidden="true" />
                  <span>{title}</span>
                  {pathname === href && (
                    <ChevronRight
                      aria-hidden="true"
                      className="ml-auto size-3"
                    />
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </nav>
        <section
          className="mt-auto px-2 pb-5 text-xs leading-5 text-muted-foreground group-data-[collapsible=icon]:hidden"
          aria-label="About this workspace"
        >
          <p className="mb-1 font-medium text-foreground">
            Follow the evidence.
          </p>
          <p>
            SereneDB computes.
            <br />
            Claude explains.
            <br />
            Every number has a receipt.
          </p>
        </section>
      </SidebarContent>
      <SidebarFooter className="border-t p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleTheme}
              tooltip={
                theme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
            >
              {theme === "dark" ? (
                <Sun aria-hidden="true" />
              ) : (
                <Moon aria-hidden="true" />
              )}
              <span>{theme === "dark" ? "Light theme" : "Dark theme"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/datasets#connect" />}
              tooltip="Connect from Claude"
              onClick={() => setOpenMobile(false)}
            >
              <HelpCircle aria-hidden="true" />
              <span>Connect from Claude</span>
              <ArrowUpRight aria-hidden="true" className="ml-auto size-3.5" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
function ContextBar({ corpus }: { corpus: ToolOutcome<unknown> }) {
  const pathname = usePathname()
  const router = useRouter()
  const [value, setValue] = useState("")
  const [error, setError] = useState("")
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2 sm:px-5">
      <SidebarTrigger />
      <span className="text-xs font-medium tracking-wider uppercase">
        {links.find((link) => link.href === pathname)?.title ?? "Ask"}
      </span>
      <form
        className="ml-auto w-44 sm:w-56"
        onSubmit={(event) => {
          event.preventDefault()
          const match = /^(r_[0-9a-f]{8})(\.f[1-9]\d*)?$/.exec(value.trim())
          if (!match) {
            setError("Enter a receipt or fact ID, such as r_7f3a9c21.f4.")
            return
          }
          setError("")
          const params = new URLSearchParams(window.location.search)
          params.set("receipt", match[1] ?? "")
          if (match[2]) params.set("fact", value.trim())
          else params.delete("fact")
          router.push(`${pathname}?${params}`, { scroll: false })
        }}
      >
        <InputGroup className="h-8">
          <InputGroupAddon>
            <FileText aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Open receipt"
            placeholder="Open receipt or fact ID"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "receipt-error" : undefined}
          />
        </InputGroup>
      </form>
      <span className="hidden items-center gap-3 text-xs text-muted-foreground xl:flex">
        {corpus.ok
          ? corpus.result.facts
              .filter((fact) => /\/datasets\/\d+\/events$/.test(fact.path))
              .map((fact) => (
                <span key={fact.id} className="flex items-center gap-1.5">
                  <span className="capitalize">{fact.group.dataset}</span>
                  <ReceiptLink
                    id={corpus.result.receipt.receipt_id}
                    fact={fact.id}
                  >
                    {Number(fact.value).toLocaleString("en-US")}
                  </ReceiptLink>
                </span>
              ))
          : "Corpus unavailable"}
      </span>
      <Badge variant="outline" className="gap-1.5 font-normal">
        <span
          className="size-1.5 rounded-full bg-muted-foreground"
          aria-hidden="true"
        />
        UTC
      </Badge>
      <span className="hidden text-xs text-muted-foreground 2xl:block">
        Contract {CONTRACT_VERSION}
      </span>
      {error && (
        <p
          id="receipt-error"
          role="alert"
          className="w-full text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </header>
  )
}
export function AppShell({
  corpus,
  children,
}: {
  corpus: ToolOutcome<unknown>
  children: React.ReactNode
}) {
  return (
    <LoadedDatasetsProvider datasets={loadedDatasetIds(corpus)}>
      <SidebarProvider className="h-svh min-h-0 overflow-hidden">
        <a
          href="#workspace-content"
          className="sr-only z-50 rounded-md bg-background p-3 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <ContextBar corpus={corpus} />
          <main
            id="workspace-content"
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-y-auto outline-none"
          >
            {children}
          </main>
        </SidebarInset>
        <EvidenceDrawer />
      </SidebarProvider>
    </LoadedDatasetsProvider>
  )
}
