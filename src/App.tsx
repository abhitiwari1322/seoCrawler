import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Download, Pause, Play, Search, Square, Trash2 } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { EngineClient } from "./engineClient";
import type { CrawlImage, CrawlLink, CrawlPage, CrawlSettings, CrawlStats, CrawlStatus } from "./types";

const defaultSettings: CrawlSettings = {
  rootUrl: "https://example.com",
  maxUrls: 500,
  maxDepth: 5,
  concurrency: 6,
  delayMs: 100,
  userAgent: "ScoutSEO/0.1 (+https://example.com/bot)",
  respectRobots: true,
  minWordCount: 300
};

const emptyStats: CrawlStats = {
  discovered: 0,
  crawled: 0,
  queued: 0,
  active: 0,
  errors: 0,
  urlsPerSecond: 0,
  durationMs: 0
};

const statusColors = ["#137c5a", "#2d6cdf", "#c67b19", "#b13b3b", "#5b6270"];
const reportTabs = ["Overview", "Metadata", "Indexability", "Headings", "Open Graph", "Structured Data", "Links", "Images", "Sitemaps", "PageSpeed"] as const;
type ReportTab = (typeof reportTabs)[number];

export function App() {
  const engineRef = useRef(new EngineClient());
  const subscribedRef = useRef(false);
  const [settings, setSettings] = useState(defaultSettings);
  const [status, setStatus] = useState<CrawlStatus>("idle");
  const [stats, setStats] = useState(emptyStats);
  const [pages, setPages] = useState<CrawlPage[]>([]);
  const [links, setLinks] = useState<CrawlLink[]>([]);
  const [images, setImages] = useState<CrawlImage[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [activeReport, setActiveReport] = useState<ReportTab>("Overview");
  const [logs, setLogs] = useState<string[]>(["Ready to crawl."]);
  const [crawlElapsedMs, setCrawlElapsedMs] = useState(0);
  const crawlStartedAtRef = useRef<number | null>(null);
  const accumulatedElapsedRef = useRef(0);

  const statusData = useMemo(() => {
    const groups = new Map<string, number>();
    for (const page of pages) {
      const key = page.status ? `${Math.floor(page.status / 100)}xx` : "Failed";
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return Array.from(groups, ([name, value]) => ({ name, value }));
  }, [pages]);

  const filteredPages = useMemo(() => {
    return pages.filter((page) => {
      const matchesQuery = !query || page.url.toLowerCase().includes(query.toLowerCase()) || page.title.toLowerCase().includes(query.toLowerCase());
      const matchesStatus = statusFilter === "all" || String(page.status ?? "failed").startsWith(statusFilter);
      return matchesQuery && matchesStatus;
    });
  }, [pages, query, statusFilter]);

  const filteredLinks = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return links.filter((link) => {
      const matchesQuery =
        !normalizedQuery ||
        link.sourceUrl.toLowerCase().includes(normalizedQuery) ||
        link.destinationUrl.toLowerCase().includes(normalizedQuery) ||
        link.anchorText.toLowerCase().includes(normalizedQuery);
      return matchesQuery;
    });
  }, [links, query]);

  const filteredImages = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return images.filter((image) => {
      const matchesQuery =
        !normalizedQuery ||
        image.pageUrl.toLowerCase().includes(normalizedQuery) ||
        image.src.toLowerCase().includes(normalizedQuery) ||
        image.alt.toLowerCase().includes(normalizedQuery);
      return matchesQuery;
    });
  }, [images, query]);

  useEffect(() => {
    if (status !== "running") return;

    const timer = window.setInterval(() => {
      if (crawlStartedAtRef.current === null) return;
      setCrawlElapsedMs(accumulatedElapsedRef.current + Date.now() - crawlStartedAtRef.current);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [status]);

  function markTimerRunning() {
    if (crawlStartedAtRef.current === null) {
      crawlStartedAtRef.current = Date.now();
    }
  }

  function markTimerPaused() {
    if (crawlStartedAtRef.current === null) return;
    accumulatedElapsedRef.current += Date.now() - crawlStartedAtRef.current;
    crawlStartedAtRef.current = null;
    setCrawlElapsedMs(accumulatedElapsedRef.current);
  }

  function resetTimer() {
    accumulatedElapsedRef.current = 0;
    crawlStartedAtRef.current = null;
    setCrawlElapsedMs(0);
  }

  async function ensureEngine() {
    const engine = engineRef.current;
    if (!subscribedRef.current) {
      engine.subscribe((event) => {
        if (event.type === "status") {
          const nextStatus = event.payload as CrawlStatus;
          setStatus(nextStatus);
          if (nextStatus === "running") markTimerRunning();
          if (nextStatus === "paused" || nextStatus === "stopped" || nextStatus === "complete" || nextStatus === "error") markTimerPaused();
        }
        if (event.type === "stats") setStats(event.payload as CrawlStats);
        if (event.type === "page") {
          const page = event.payload as CrawlPage;
          setPages((current) => {
            const existingIndex = current.findIndex((currentPage) => currentPage.url === page.url);
            if (existingIndex === -1) return [page, ...current].slice(0, 1000);

            const next = [...current];
            next[existingIndex] = page;
            return next;
          });
        }
        if (event.type === "link") {
          const link = event.payload as CrawlLink;
          setLinks((current) => {
            const existingIndex = current.findIndex((currentLink) => currentLink.id === link.id);
            if (existingIndex === -1) return [link, ...current].slice(0, 5000);

            const next = [...current];
            next[existingIndex] = link;
            return next;
          });
        }
        if (event.type === "image") {
          const image = event.payload as CrawlImage;
          setImages((current) => {
            const existingIndex = current.findIndex((currentImage) => currentImage.id === image.id);
            if (existingIndex === -1) return [image, ...current].slice(0, 5000);

            const next = [...current];
            next[existingIndex] = image;
            return next;
          });
        }
        if (event.type === "log") setLogs((current) => [String(event.payload), ...current].slice(0, 8));
        if (event.type === "complete") setStatus("complete");
        if (event.type === "error") {
          setStatus("error");
          setLogs((current) => [String(event.payload), ...current].slice(0, 8));
        }
      });
      subscribedRef.current = true;
    }
    await engine.connect();
    return engine;
  }

  async function startCrawl() {
    setPages([]);
    setLinks([]);
    setImages([]);
    setStats(emptyStats);
    setLogs([]);
    resetTimer();
    try {
      const engine = await ensureEngine();
      engine.start(settings);
    } catch (error) {
      setStatus("error");
      const message = error instanceof Error ? error.message : String(error);
      setLogs((current) => [`Start failed: ${message}`, ...current].slice(0, 8));
    }
  }

  const issueCount = pages.reduce((sum, page) => sum + page.issues.length, 0);
  const canClearLogs = logs.length > 0 && status !== "running";
  const reportRows = getReportRows(activeReport, filteredPages, filteredLinks, filteredImages);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={24} />
          <div>
            <strong>Scout SEO</strong>
            <span>Desktop crawler</span>
          </div>
        </div>

        <label>
          Root URL
          <input value={settings.rootUrl} onChange={(event) => setSettings({ ...settings, rootUrl: event.target.value })} />
        </label>

        <div className="two-col">
          <label>
            URLs
            <input type="number" min="1" value={settings.maxUrls} onChange={(event) => setSettings({ ...settings, maxUrls: Number(event.target.value) })} />
          </label>
          <label>
            Depth
            <input type="number" min="0" value={settings.maxDepth} onChange={(event) => setSettings({ ...settings, maxDepth: Number(event.target.value) })} />
          </label>
        </div>

        <div className="two-col">
          <label>
            Threads
            <input type="number" min="1" max="32" value={settings.concurrency} onChange={(event) => setSettings({ ...settings, concurrency: Number(event.target.value) })} />
          </label>
          <label>
            Delay
            <input type="number" min="0" value={settings.delayMs} onChange={(event) => setSettings({ ...settings, delayMs: Number(event.target.value) })} />
          </label>
        </div>

        <label>
          User agent
          <input value={settings.userAgent} onChange={(event) => setSettings({ ...settings, userAgent: event.target.value })} />
        </label>

        <label className="check-row">
          <input type="checkbox" checked={settings.respectRobots} onChange={(event) => setSettings({ ...settings, respectRobots: event.target.checked })} />
          Respect robots.txt
        </label>

        <div className="action-row">
          <button onClick={startCrawl} disabled={status === "running"}>
            <Play size={16} /> Start
          </button>
          <button onClick={() => engineRef.current.pause()} disabled={status !== "running"} title="Pause">
            <Pause size={16} />
          </button>
          <button onClick={() => engineRef.current.stop()} disabled={status === "idle"} title="Stop">
            <Square size={16} />
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className={`status-dot ${status}`} />
            <strong>{status.toUpperCase()}</strong>
            <span className="crawl-timer">{formatDuration(crawlElapsedMs)}</span>
          </div>
          <button onClick={() => engineRef.current.exportCsv("all-urls")}>
            <Download size={16} /> CSV
          </button>
        </header>

        <section className="metrics">
          <Metric label="Discovered" value={stats.discovered} />
          <Metric label="Crawled" value={stats.crawled} />
          <Metric label="Queue" value={stats.queued} />
          <Metric label="Errors" value={stats.errors} />
          <Metric label="Issues" value={issueCount} />
          <Metric label="URLs/sec" value={stats.urlsPerSecond.toFixed(1)} />
        </section>

        <section className="dashboard">
          <div className="chart-panel">
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={86}>
                  {statusData.map((entry, index) => <Cell key={entry.name} fill={statusColors[index % statusColors.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="log-panel">
            <div className="panel-header">
              <strong>Logs</strong>
              <button className="icon-button" onClick={() => setLogs([])} disabled={!canClearLogs} title="Clear logs">
                <Trash2 size={16} />
              </button>
            </div>
            <div className="log-list">
              {logs.length === 0 ? <p className="empty-log">No logs yet.</p> : logs.map((log, index) => <p key={`${log}-${index}`}>{log}</p>)}
            </div>
          </div>
        </section>

        <section className="filters">
          <div className="searchbox">
            <Search size={16} />
            <input placeholder="Search current report" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} disabled={activeReport === "Links" || activeReport === "Images"}>
            <option value="all">All statuses</option>
            <option value="2">2xx</option>
            <option value="3">3xx</option>
            <option value="4">4xx</option>
            <option value="5">5xx</option>
          </select>
        </section>

        <nav className="report-tabs" aria-label="Reports">
          {reportTabs.map((tab) => (
            <button key={tab} className={activeReport === tab ? "active" : ""} onClick={() => setActiveReport(tab)}>
              {tab}
            </button>
          ))}
        </nav>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>{getReportHeaders(activeReport).map((header) => <th key={header}>{header}</th>)}</tr>
            </thead>
            <tbody>{reportRows}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getReportHeaders(report: ReportTab) {
  if (report === "Metadata") return ["URL", "Title", "Title Count", "Description", "Description Count", "Canonical", "Issues"];
  if (report === "Indexability") return ["URL", "Status", "Indexable", "Noindex", "Nofollow", "Canonicalized", "Reasons"];
  if (report === "Headings") return ["URL", "H1 Count", "H2 Count", "Heading Path", "Issues"];
  if (report === "Open Graph") return ["URL", "OG Title", "OG Description", "OG URL", "OG Type", "OG Image", "Issues"];
  if (report === "Structured Data") return ["URL", "JSON-LD Blocks", "Invalid Blocks", "Errors"];
  if (report === "Links") return ["Source URL", "Destination URL", "Anchor Text", "Type", "Followed", "Internal", "Issues"];
  if (report === "Images") return ["Page URL", "Image URL", "Alt", "Has Alt", "Width", "Height", "Issues"];
  if (report === "Sitemaps") return ["Sitemap URL", "URL", "Status", "Indexable", "Coverage", "Issues"];
  if (report === "PageSpeed") return ["URL", "Mobile Score", "Desktop Score", "LCP", "CLS", "INP", "Issues"];
  return ["URL", "Status", "Depth", "Title", "Description", "Canonical", "Words", "Issues", "Indexable", "Indexability Reasons", "Inlinks", "Outlinks", "Referrers", "Images"];
}

function getReportRows(report: ReportTab, pages: CrawlPage[], links: CrawlLink[], images: CrawlImage[]) {
  if (report === "Metadata") {
    return pages.map((page) => (
      <tr key={`metadata-${page.url}`}>
        <td>{page.url}</td>
        <td>{page.title || "Missing"}</td>
        <td>{page.metadata?.counts.titles ?? 0}</td>
        <td>{page.description || "Missing"}</td>
        <td>{page.metadata?.counts.descriptions ?? 0}</td>
        <td>{page.canonical || "Missing"}</td>
        <td>{issueText(page, ["title", "description", "canonical", "Duplicate"])}</td>
      </tr>
    ));
  }

  if (report === "Indexability") {
    return pages.map((page) => (
      <tr key={`indexability-${page.url}`}>
        <td>{page.url}</td>
        <td>{page.status ?? "Fail"}</td>
        <td>{page.indexability?.isIndexable ? "Yes" : "No"}</td>
        <td>{page.indexability?.hasNoindex ? "Yes" : "No"}</td>
        <td>{page.indexability?.hasNofollow ? "Yes" : "No"}</td>
        <td>{page.indexability?.canonicalized ? "Yes" : "No"}</td>
        <td>{page.indexability?.reasons.join(", ") ?? ""}</td>
      </tr>
    ));
  }

  if (report === "Headings") {
    return pages.map((page) => (
      <tr key={`headings-${page.url}`}>
        <td>{page.url}</td>
        <td>{page.h1.length}</td>
        <td>{page.h2.length}</td>
        <td>{page.headings?.map((heading) => `H${heading.level}: ${heading.text}`).join(" > ") ?? ""}</td>
        <td>{issueText(page, ["H1", "heading"])}</td>
      </tr>
    ));
  }

  if (report === "Open Graph") {
    return pages.map((page) => {
      const og = page.metadata?.openGraph ?? {};
      return (
        <tr key={`og-${page.url}`}>
          <td>{page.url}</td>
          <td>{firstValue(og["og:title"])}</td>
          <td>{firstValue(og["og:description"])}</td>
          <td>{firstValue(og["og:url"])}</td>
          <td>{firstValue(og["og:type"])}</td>
          <td>{firstValue(og["og:image"])}</td>
          <td>{issueText(page, ["Open Graph", "og:"])}</td>
        </tr>
      );
    });
  }

  if (report === "Structured Data") {
    return pages.map((page) => {
      const blocks = page.metadata?.structuredData.jsonLd ?? [];
      const invalid = blocks.filter((block) => !block.valid);
      return (
        <tr key={`structured-${page.url}`}>
          <td>{page.url}</td>
          <td>{blocks.length}</td>
          <td>{invalid.length}</td>
          <td>{invalid.flatMap((block) => block.errors).join(", ")}</td>
        </tr>
      );
    });
  }

  if (report === "Links") {
    return links.length ? links.map((link) => (
      <tr key={link.id}>
        <td>{link.sourceUrl}</td>
        <td>{link.destinationUrl || "Missing"}</td>
        <td>{link.anchorText}</td>
        <td>{link.linkType}</td>
        <td>{link.isFollowed ? "Yes" : "No"}</td>
        <td>{link.isInternal ? "Yes" : "No"}</td>
        <td>{link.issues.join(", ")}</td>
      </tr>
    )) : emptyRow(report, "No link records yet. Start a crawl to populate this report.");
  }

  if (report === "Images") {
    return images.length ? images.map((image) => (
      <tr key={image.id}>
        <td>{image.pageUrl}</td>
        <td>{image.src || "Missing"}</td>
        <td>{image.alt}</td>
        <td>{image.hasAltAttribute ? "Yes" : "No"}</td>
        <td>{image.width || "Missing"}</td>
        <td>{image.height || "Missing"}</td>
        <td>{image.issues.join(", ")}</td>
      </tr>
    )) : emptyRow(report, "No image records yet. Start a crawl to populate this report.");
  }

  if (report === "Sitemaps") return emptyRow(report, "Sitemap crawling and coverage reports are planned for the sitemap phase.");
  if (report === "PageSpeed") return emptyRow(report, "PageSpeed Insights reports are planned for the PageSpeed phase.");

  return pages.map((page) => (
    <tr key={`overview-${page.url}`}>
      <td>{page.url}</td>
      <td>{page.status ?? "Fail"}</td>
      <td>{page.depth}</td>
      <td>{page.title || "Missing"}</td>
      <td>{page.description || "Missing"}</td>
      <td>{page.canonical || "Missing"}</td>
      <td>{page.wordCount}</td>
      <td>{page.issues.join(", ")}</td>
      <td>{page.indexability ? (page.indexability.isIndexable ? "Yes" : "No") : "Unknown"}</td>
      <td>{page.indexability?.reasons.join(", ") ?? ""}</td>
      <td>{page.incomingInternalLinks ?? 0}</td>
      <td>{page.outgoingInternalLinks ?? 0}</td>
      <td>{page.referrerUrls?.join(", ") ?? ""}</td>
      <td>{page.imageCount ?? 0}</td>
    </tr>
  ));
}

function issueText(page: CrawlPage, terms: string[]) {
  return page.issues.filter((issue) => terms.some((term) => issue.toLowerCase().includes(term.toLowerCase()))).join(", ");
}

function firstValue(values?: string[]) {
  return values?.find(Boolean) ?? "Missing";
}

function emptyRow(report: ReportTab, message: string) {
  return (
    <tr>
      <td colSpan={getReportHeaders(report).length}>{message}</td>
    </tr>
  );
}
