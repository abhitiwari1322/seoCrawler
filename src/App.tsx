import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Download, Pause, Play, Search, Square, Trash2, Upload } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { EngineClient } from "./engineClient";
import type { CrawlImage, CrawlLink, CrawlPage, CrawlPsiRecord, CrawlSettings, CrawlSitemapRecord, CrawlStats, CrawlStatus } from "./types";

const defaultSettings: CrawlSettings = {
  rootUrl: "https://example.com",
  crawlMode: "site",
  speedPreset: "max",
  crawlScope: "internal-all",
  specificUrls: [],
  maxUrls: 500,
  maxDepth: 5,
  concurrency: 64,
  delayMs: 0,
  timeoutMs: 8000,
  userAgent: "ScoutSEO/0.1 (+https://example.com/bot)",
  respectRobots: true,
  minWordCount: 300,
  psiEnabled: false,
  psiApiKey: "",
  psiMaxUrls: 5,
  psiMobile: true,
  psiDesktop: true
};

const speedPresets: Record<CrawlSettings["speedPreset"], Pick<CrawlSettings, "concurrency" | "delayMs" | "timeoutMs">> = {
  polite: { concurrency: 2, delayMs: 250, timeoutMs: 15000 },
  balanced: { concurrency: 8, delayMs: 50, timeoutMs: 12000 },
  fast: { concurrency: 16, delayMs: 0, timeoutMs: 10000 },
  aggressive: { concurrency: 32, delayMs: 0, timeoutMs: 8000 },
  max: { concurrency: 64, delayMs: 0, timeoutMs: 8000 }
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
const reportTabs = ["Overview", "Metadata", "Indexability", "Headings", "Open Graph", "Structured Data", "Links", "Images", "Sitemaps", "PageSpeed", "Compare"] as const;
type ReportTab = (typeof reportTabs)[number];
type ReportFilters = Record<string, string>;
type ReportFilterConfig = {
  key: string;
  label: string;
  options: { label: string; value: string }[];
};
type ReportFilterState = Record<ReportTab, ReportFilters>;
type PreviousCrawlRow = {
  url: string;
  finalUrl: string;
  status: string;
  title: string;
  description: string;
  canonical: string;
  indexable: string;
  wordCount: string;
  issues: string;
};
type CompareRow = {
  url: string;
  changeType: "New" | "Removed" | "Changed";
  statusChange: string;
  titleChange: string;
  descriptionChange: string;
  canonicalChange: string;
  indexabilityChange: string;
  wordCountChange: string;
  issuesAdded: string[];
  issuesFixed: string[];
};

function createEmptyReportFilters(): ReportFilterState {
  return Object.fromEntries(reportTabs.map((tab) => [tab, {}])) as ReportFilterState;
}

function parseUrlList(text: string) {
  const urls = new Set<string>();
  const candidates = text
    .split(/[\n\r,\t ;]+/)
    .map((value) => value.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      urls.add(url.href);
    } catch {
      // Ignore CSV headers, notes, and malformed cells.
    }
  }

  return Array.from(urls);
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function App() {
  const engineRef = useRef(new EngineClient());
  const subscribedRef = useRef(false);
  const [settings, setSettings] = useState(defaultSettings);
  const [status, setStatus] = useState<CrawlStatus>("idle");
  const [stats, setStats] = useState(emptyStats);
  const [pages, setPages] = useState<CrawlPage[]>([]);
  const [links, setLinks] = useState<CrawlLink[]>([]);
  const [images, setImages] = useState<CrawlImage[]>([]);
  const [sitemaps, setSitemaps] = useState<CrawlSitemapRecord[]>([]);
  const [psiResults, setPsiResults] = useState<CrawlPsiRecord[]>([]);
  const [query, setQuery] = useState("");
  const [activeReport, setActiveReport] = useState<ReportTab>("Overview");
  const [reportFiltersByTab, setReportFiltersByTab] = useState<ReportFilterState>(() => createEmptyReportFilters());
  const [urlListFileName, setUrlListFileName] = useState("");
  const [urlListError, setUrlListError] = useState("");
  const [previousCsvName, setPreviousCsvName] = useState("");
  const [previousRows, setPreviousRows] = useState<PreviousCrawlRow[]>([]);
  const [compareError, setCompareError] = useState("");
  const [logs, setLogs] = useState<string[]>(["Ready to crawl."]);
  const [crawlElapsedMs, setCrawlElapsedMs] = useState(0);
  const crawlStartedAtRef = useRef<number | null>(null);
  const accumulatedElapsedRef = useRef(0);
  const reportFilters = reportFiltersByTab[activeReport] ?? {};

  const statusData = useMemo(() => {
    const groups = new Map<string, number>();
    for (const page of pages) {
      const key = page.status ? `${Math.floor(page.status / 100)}xx` : "Failed";
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    return Array.from(groups, ([name, value]) => ({ name, value }));
  }, [pages]);

  const filteredPages = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return pages.filter((page) => {
      const matchesQuery =
        !normalizedQuery ||
        page.url.toLowerCase().includes(normalizedQuery) ||
        page.title.toLowerCase().includes(normalizedQuery) ||
        page.description.toLowerCase().includes(normalizedQuery) ||
        page.issues.join(" ").toLowerCase().includes(normalizedQuery);
      return matchesQuery && matchesPageReportFilters(page, activeReport, reportFilters);
    });
  }, [activeReport, pages, query, reportFilters]);

  const filteredLinks = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return links.filter((link) => {
      const matchesQuery =
        !normalizedQuery ||
        link.sourceUrl.toLowerCase().includes(normalizedQuery) ||
        link.destinationUrl.toLowerCase().includes(normalizedQuery) ||
        link.anchorText.toLowerCase().includes(normalizedQuery) ||
        link.issues.join(" ").toLowerCase().includes(normalizedQuery);
      return matchesQuery && matchesLinkFilters(link, reportFilters);
    });
  }, [links, query, reportFilters]);

  const filteredImages = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return images.filter((image) => {
      const matchesQuery =
        !normalizedQuery ||
        image.pageUrl.toLowerCase().includes(normalizedQuery) ||
        image.src.toLowerCase().includes(normalizedQuery) ||
        image.alt.toLowerCase().includes(normalizedQuery) ||
        image.issues.join(" ").toLowerCase().includes(normalizedQuery);
      return matchesQuery && matchesImageFilters(image, reportFilters);
    });
  }, [images, query, reportFilters]);

  const filteredSitemaps = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return sitemaps.filter((record) => {
      const matchesQuery =
        !normalizedQuery ||
        record.sitemapUrl.toLowerCase().includes(normalizedQuery) ||
        record.url.toLowerCase().includes(normalizedQuery) ||
        record.issues.join(" ").toLowerCase().includes(normalizedQuery);
      return matchesQuery && matchesSitemapFilters(record, reportFilters);
    });
  }, [sitemaps, query, reportFilters]);

  const filteredPsiResults = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return psiResults.filter((record) => {
      const matchesQuery =
        !normalizedQuery ||
        record.url.toLowerCase().includes(normalizedQuery) ||
        record.strategy.includes(normalizedQuery) ||
        record.issues.join(" ").toLowerCase().includes(normalizedQuery);
      return matchesQuery && matchesPsiFilters(record, reportFilters);
    });
  }, [psiResults, query, reportFilters]);

  const compareRows = useMemo(() => buildCompareRows(previousRows, pages), [pages, previousRows]);

  const filteredCompareRows = useMemo(() => {
    const normalizedQuery = query.toLowerCase();
    return compareRows.filter((record) => {
      const matchesQuery =
        !normalizedQuery ||
        record.url.toLowerCase().includes(normalizedQuery) ||
        record.changeType.toLowerCase().includes(normalizedQuery) ||
        record.statusChange.toLowerCase().includes(normalizedQuery) ||
        record.titleChange.toLowerCase().includes(normalizedQuery) ||
        record.descriptionChange.toLowerCase().includes(normalizedQuery) ||
        record.canonicalChange.toLowerCase().includes(normalizedQuery) ||
        record.issuesAdded.join(" ").toLowerCase().includes(normalizedQuery) ||
        record.issuesFixed.join(" ").toLowerCase().includes(normalizedQuery);
      return matchesQuery && matchesCompareFilters(record, reportFilters);
    });
  }, [compareRows, query, reportFilters]);

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
        if (event.type === "sitemap") {
          const sitemap = event.payload as CrawlSitemapRecord;
          setSitemaps((current) => {
            const existingIndex = current.findIndex((currentSitemap) => currentSitemap.sitemapUrl === sitemap.sitemapUrl && currentSitemap.url === sitemap.url);
            if (existingIndex === -1) return [sitemap, ...current].slice(0, 5000);

            const next = [...current];
            next[existingIndex] = sitemap;
            return next;
          });
        }
        if (event.type === "psi") {
          const psi = event.payload as CrawlPsiRecord;
          setPsiResults((current) => {
            const existingIndex = current.findIndex((currentPsi) => currentPsi.url === psi.url && currentPsi.strategy === psi.strategy);
            if (existingIndex === -1) return [psi, ...current].slice(0, 1000);

            const next = [...current];
            next[existingIndex] = psi;
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
    if (settings.crawlMode === "url-list" && settings.specificUrls.length === 0) {
      setStatus("error");
      setLogs((current) => ["Upload a URL list before starting a URL-list crawl.", ...current].slice(0, 8));
      return;
    }

    setPages([]);
    setLinks([]);
    setImages([]);
    setSitemaps([]);
    setPsiResults([]);
    setStats(emptyStats);
    setLogs([]);
    resetTimer();
    try {
      const engine = await ensureEngine();
      engine.start({
        ...settings,
        maxUrls: settings.crawlMode === "url-list" ? Math.max(settings.specificUrls.length, 1) : settings.maxUrls
      });
    } catch (error) {
      setStatus("error");
      const message = error instanceof Error ? error.message : String(error);
      setLogs((current) => [`Start failed: ${message}`, ...current].slice(0, 8));
    }
  }

  const issueCount = pages.reduce((sum, page) => sum + page.issues.length, 0);
  const canClearLogs = logs.length > 0 && status !== "running";
  const activeFilterConfigs = getReportFilterConfigs(activeReport);
  const activeFilterKeys = activeFilterConfigs.map((filter) => filter.key);
  const hasActiveFilters = activeFilterKeys.some((key) => (reportFilters[key] ?? "all") !== "all");
  const reportRows = getReportRows(activeReport, filteredPages, filteredLinks, filteredImages, filteredSitemaps, filteredPsiResults, filteredCompareRows);

  function updateActiveFilter(key: string, value: string) {
    setReportFiltersByTab((current) => ({
      ...current,
      [activeReport]: {
        ...current[activeReport],
        [key]: value
      }
    }));
  }

  function clearActiveFilters() {
    setReportFiltersByTab((current) => ({
      ...current,
      [activeReport]: clearReportFilters(current[activeReport] ?? {}, activeFilterKeys)
    }));
  }

  async function handleUrlListUpload(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      const urls = parseUrlList(text);
      if (urls.length === 0) {
        setUrlListError("No valid URLs found.");
        setUrlListFileName(file.name);
        setSettings((current) => ({ ...current, crawlMode: "url-list", specificUrls: [] }));
        return;
      }

      setUrlListError("");
      setUrlListFileName(file.name);
      setSettings((current) => ({
        ...current,
        rootUrl: urls[0],
        crawlMode: "url-list",
        specificUrls: urls,
        maxUrls: urls.length
      }));
      setLogs((current) => [`Loaded ${urls.length} URL(s) from ${file.name}.`, ...current].slice(0, 8));
    } catch (error) {
      setUrlListError(error instanceof Error ? error.message : "Could not read URL file.");
    }
  }

  function clearUrlList() {
    setUrlListFileName("");
    setUrlListError("");
    setSettings((current) => ({ ...current, specificUrls: [], maxUrls: defaultSettings.maxUrls }));
  }

  function updateCrawlMode(crawlMode: CrawlSettings["crawlMode"]) {
    setSettings((current) => ({
      ...current,
      crawlMode,
      maxUrls: crawlMode === "url-list" ? current.specificUrls.length : defaultSettings.maxUrls
    }));
  }

  function updateSpeedPreset(speedPreset: CrawlSettings["speedPreset"]) {
    setSettings((current) => ({
      ...current,
      speedPreset,
      ...speedPresets[speedPreset]
    }));
  }

  async function handlePreviousCsvUpload(file: File | undefined) {
    if (!file) return;

    try {
      const text = await file.text();
      const parsedRows = parsePreviousReportCsv(text);
      if (parsedRows.length === 0) {
        setCompareError("No comparable URL rows found.");
        setPreviousRows([]);
        setPreviousCsvName(file.name);
        return;
      }

      setPreviousCsvName(file.name);
      setPreviousRows(parsedRows);
      setCompareError("");
      setActiveReport("Compare");
      setLogs((current) => [`Loaded previous CSV ${file.name} with ${parsedRows.length} URL(s).`, ...current].slice(0, 8));
    } catch (error) {
      setCompareError(error instanceof Error ? error.message : "Could not read previous CSV.");
      setPreviousRows([]);
      setPreviousCsvName(file.name);
    }
  }

  function clearPreviousCsv() {
    setPreviousCsvName("");
    setPreviousRows([]);
    setCompareError("");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={24} />
          <div>
            <strong>BOLD SEO</strong>
            <span>Desktop crawler</span>
          </div>
        </div>

        <label>
          Crawl mode
          <select value={settings.crawlMode} onChange={(event) => updateCrawlMode(event.target.value as CrawlSettings["crawlMode"])}>
            <option value="site">Discover site URLs</option>
            <option value="url-list">Only uploaded URLs</option>
          </select>
        </label>

        <label>
          Speed
          <select value={settings.speedPreset} onChange={(event) => updateSpeedPreset(event.target.value as CrawlSettings["speedPreset"])}>
            <option value="max">Max speed</option>
            <option value="aggressive">Aggressive</option>
            <option value="fast">Fast</option>
            <option value="balanced">Balanced</option>
            <option value="polite">Polite</option>
          </select>
        </label>

        <label>
          Crawl scope
          <select value={settings.crawlScope} onChange={(event) => setSettings({ ...settings, crawlScope: event.target.value as CrawlSettings["crawlScope"] })}>
            <option value="html-only">HTML only</option>
            <option value="internal-all">Internal all baseline</option>
            <option value="all-resources">All resources</option>
          </select>
        </label>

        {settings.crawlMode === "site" ? (
          <label>
            Root URL
            <input value={settings.rootUrl} onChange={(event) => setSettings({ ...settings, rootUrl: event.target.value })} />
          </label>
        ) : (
          <div className="url-list-panel">
            <label className="file-upload">
              <span><Upload size={15} /> URL file</span>
              <input type="file" accept=".txt,.csv,text/plain,text/csv" onChange={(event) => void handleUrlListUpload(event.target.files?.[0])} />
              <span className="upload-control">
                <strong>{urlListFileName || "Choose URL file"}</strong>
                <small>{settings.specificUrls.length ? `${settings.specificUrls.length} URL(s) loaded` : "TXT or CSV with absolute URLs"}</small>
              </span>
            </label>
            {urlListError ? <strong className="url-list-error">{urlListError}</strong> : null}
            {settings.specificUrls.length > 0 ? <button type="button" className="text-button" onClick={clearUrlList}>Clear uploaded list</button> : null}
          </div>
        )}

        {settings.crawlMode === "site" ? (
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
        ) : (
          <label>
            URLs from file
            <input type="number" value={settings.specificUrls.length} disabled readOnly />
          </label>
        )}

        <div className="two-col">
          <label>
            Threads
            <input type="number" min="1" max="128" value={settings.concurrency} onChange={(event) => setSettings({ ...settings, speedPreset: "max", concurrency: Number(event.target.value) })} />
          </label>
          <label>
            Request delay
            <input type="number" min="0" value={settings.delayMs} onChange={(event) => setSettings({ ...settings, speedPreset: "max", delayMs: Number(event.target.value) })} />
          </label>
        </div>

        <label>
          Timeout ms
          <input type="number" min="1000" value={settings.timeoutMs} onChange={(event) => setSettings({ ...settings, speedPreset: "max", timeoutMs: Number(event.target.value) })} />
        </label>

        <label>
          User agent
          <input value={settings.userAgent} onChange={(event) => setSettings({ ...settings, userAgent: event.target.value })} />
        </label>

        <label className="check-row">
          <input type="checkbox" checked={settings.respectRobots} onChange={(event) => setSettings({ ...settings, respectRobots: event.target.checked })} />
          Respect robots.txt
        </label>

        <label className="check-row">
          <input type="checkbox" checked={settings.psiEnabled} onChange={(event) => setSettings({ ...settings, psiEnabled: event.target.checked })} />
          PageSpeed checks
        </label>

        {settings.psiEnabled ? (
          <>
            <label>
              PSI API key
              <input value={settings.psiApiKey} onChange={(event) => setSettings({ ...settings, psiApiKey: event.target.value })} placeholder="Optional" />
            </label>

            <div className="two-col">
              <label>
                PSI URLs
                <input type="number" min="1" max="25" value={settings.psiMaxUrls} onChange={(event) => setSettings({ ...settings, psiMaxUrls: Number(event.target.value) })} />
              </label>
              <div className="stacked-checks">
                <label className="check-row">
                  <input type="checkbox" checked={settings.psiMobile} onChange={(event) => setSettings({ ...settings, psiMobile: event.target.checked })} />
                  Mobile
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={settings.psiDesktop} onChange={(event) => setSettings({ ...settings, psiDesktop: event.target.checked })} />
                  Desktop
                </label>
              </div>
            </div>
          </>
        ) : null}

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
          <div className="topbar-actions">
            <label className="compare-upload">
              <Upload size={16} /> Compare CSV
              <input type="file" accept=".csv,text/csv" onChange={(event) => void handlePreviousCsvUpload(event.target.files?.[0])} />
            </label>
            <button onClick={() => engineRef.current.exportCsv("all-urls")}>
              <Download size={16} /> CSV
            </button>
          </div>
        </header>

        {previousCsvName || compareError ? (
          <section className="compare-banner">
            <span>{compareError || `Comparing current crawl against ${previousCsvName}`}</span>
            <button type="button" onClick={clearPreviousCsv}>Clear comparison</button>
          </section>
        ) : null}

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

        <nav className="report-tabs" aria-label="Reports">
          {reportTabs.map((tab) => (
            <button key={tab} className={activeReport === tab ? "active" : ""} onClick={() => setActiveReport(tab)}>
              {tab}
            </button>
          ))}
        </nav>

        <section className="filters">
          <div className="searchbox">
            <Search size={16} />
            <input placeholder={`Search ${activeReport}`} value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="filter-controls">
            {activeFilterConfigs.map((filter) => (
              <label key={`${activeReport}-${filter.key}`} className="filter-select">
                <span>{filter.label}</span>
                <select aria-label={filter.label} value={reportFilters[filter.key] ?? "all"} onChange={(event) => updateActiveFilter(filter.key, event.target.value)}>
                  {filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            ))}
            <button className="secondary-button" onClick={clearActiveFilters} disabled={!hasActiveFilters}>
              Clear
            </button>
          </div>
        </section>

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

function getReportFilterConfigs(report: ReportTab): ReportFilterConfig[] {
  if (report === "Metadata") {
    return [
      optionGroup("titleStatus", "Title", ["Missing", "Duplicate", "Short", "Long", "Multiple"]),
      optionGroup("descriptionStatus", "Description", ["Missing", "Duplicate", "Long", "Multiple"]),
      optionGroup("canonicalStatus", "Canonical", ["Missing", "Present", "Invalid", "Canonicalized", "External"]),
      optionGroup("issueStatus", "Issues", ["With issues", "No issues"])
    ];
  }

  if (report === "Indexability") {
    return [
      optionGroup("indexability", "Indexability", ["Indexable", "Non-indexable", "Unknown"]),
      optionGroup("indexReason", "Reason", ["Noindex", "Nofollow", "Robots blocked", "Canonicalized", "HTTP error"]),
      optionGroup("noindex", "Noindex", ["Yes", "No"]),
      optionGroup("nofollow", "Nofollow", ["Yes", "No"]),
      optionGroup("canonicalized", "Canonicalized", ["Yes", "No"])
    ];
  }

  if (report === "Headings") {
    return [
      optionGroup("h1Status", "H1", ["Missing", "Single", "Multiple"]),
      optionGroup("hierarchy", "Hierarchy", ["Valid", "First heading not H1", "Non-sequential"]),
      optionGroup("h2Status", "H2", ["Missing", "Has H2"]),
      optionGroup("issueStatus", "Issues", ["With issues", "No issues"])
    ];
  }

  if (report === "Open Graph") {
    return [
      optionGroup("ogStatus", "OG status", ["Complete", "Missing tags", "Duplicate tags"]),
      optionGroup("ogImage", "OG image", ["Present", "Missing"]),
      optionGroup("ogTitle", "OG title", ["Present", "Missing"]),
      optionGroup("duplicateOg", "Duplicates", ["Any duplicate", "No duplicates"])
    ];
  }

  if (report === "Structured Data") {
    return [
      optionGroup("structuredStatus", "Structured data", ["Present", "Missing"]),
      optionGroup("validity", "Validity", ["Valid", "Invalid"]),
      optionGroup("errorStatus", "Errors", ["Has errors", "No errors"])
    ];
  }

  if (report === "Links") {
    return [
      optionGroup("linkType", "Link type", ["Internal", "External"]),
      optionGroup("destinationStatus", "Status", ["2xx", "3xx", "4xx", "5xx", "Not crawled"]),
      optionGroup("followStatus", "Follow", ["Follow", "Nofollow"]),
      optionGroup("linkIssue", "Issue", ["Missing href", "Invalid href", "Empty anchor", "Generic anchor", "Broken link"])
    ];
  }

  if (report === "Images") {
    return [
      optionGroup("altStatus", "Alt", ["Has alt", "Missing alt", "Empty alt", "Generic alt"]),
      optionGroup("imageSource", "Source", ["Normal src", "Srcset", "Lazy-loaded", "Empty src"]),
      optionGroup("dimensions", "Dimensions", ["Complete", "Missing width", "Missing height", "Missing both"]),
      optionGroup("issueStatus", "Issues", ["With issues", "No issues"])
    ];
  }

  if (report === "Sitemaps") {
    return [
      optionGroup("coverage", "Coverage", ["Crawled", "Not crawled"]),
      optionGroup("indexability", "Indexability", ["Indexable", "Non-indexable", "Unknown"]),
      optionGroup("statusGroup", "Status", ["2xx", "3xx", "4xx", "5xx", "Unknown"]),
      optionGroup("sitemapIssue", "Issue", ["URL not crawled", "HTTP error", "Non-indexable"])
    ];
  }

  if (report === "PageSpeed") {
    return [
      optionGroup("strategy", "Strategy", ["Mobile", "Desktop"]),
      optionGroup("scoreRange", "Score", ["Poor", "Needs improvement", "Good", "Error"]),
      optionGroup("apiStatus", "API", ["Successful", "Failed"]),
      optionGroup("vitalIssue", "Vitals", ["Slow FCP", "Slow LCP", "High TBT", "High CLS", "High INP"])
    ];
  }

  if (report === "Compare") {
    return [
      optionGroup("changeType", "Change", ["New", "Removed", "Changed"]),
      optionGroup("statusChange", "Status", ["Changed", "Became 4xx", "Became 5xx", "Fixed to 2xx"]),
      optionGroup("metadataChange", "Metadata", ["Title", "Description", "Canonical"]),
      optionGroup("issueDelta", "Issues", ["New issue", "Fixed issue"]),
      optionGroup("indexabilityChange", "Indexability", ["Changed", "Became non-indexable", "Became indexable"])
    ];
  }

  return [
    optionGroup("statusGroup", "Status", ["2xx", "3xx", "4xx", "5xx", "Failed"]),
    optionGroup("indexability", "Indexability", ["Indexable", "Non-indexable", "Unknown"]),
    optionGroup("issueStatus", "Issues", ["With issues", "No issues"]),
    optionGroup("depth", "Depth", ["0", "1", "2", "3", "4+"]),
    optionGroup("wordCount", "Words", ["Thin", "Normal", "High"])
  ];
}

function optionGroup(key: string, label: string, labels: string[]): ReportFilterConfig {
  return {
    key,
    label,
    options: [{ label: `All ${label.toLowerCase()}`, value: "all" }, ...labels.map((optionLabel) => ({ label: optionLabel, value: optionLabel.toLowerCase().replace(/\s+/g, "-") }))]
  };
}

function clearReportFilters(filters: ReportFilters, activeKeys: string[]) {
  const next = { ...filters };
  for (const key of activeKeys) next[key] = "all";
  return next;
}

function matchesPageReportFilters(page: CrawlPage, report: ReportTab, filters: ReportFilters) {
  if (report === "Links" || report === "Images" || report === "Sitemaps" || report === "PageSpeed" || report === "Compare") return true;

  if (!matchesStatusGroup(page.status, filters.statusGroup)) return false;
  if (!matchesIndexability(page.indexability?.isIndexable, filters.indexability)) return false;
  if (!matchesIssueStatus(page.issues, filters.issueStatus)) return false;

  if (report === "Overview") {
    if (!matchesDepth(page.depth, filters.depth)) return false;
    if (!matchesWordCount(page.wordCount, filters.wordCount)) return false;
  }

  if (report === "Metadata") {
    if (!matchesIssueOption(page, filters.titleStatus, {
      missing: "Missing title",
      duplicate: "Duplicate title",
      short: "Short title",
      long: "Long title",
      multiple: "Multiple title tags"
    })) return false;
    if (!matchesIssueOption(page, filters.descriptionStatus, {
      missing: "Missing meta description",
      duplicate: "Duplicate meta description",
      long: "Long meta description",
      multiple: "Multiple meta descriptions"
    })) return false;
    if (!matchesCanonicalStatus(page, filters.canonicalStatus)) return false;
  }

  if (report === "Indexability") {
    if (!matchesReason(page, filters.indexReason)) return false;
    if (!matchesBoolean(page.indexability?.hasNoindex, filters.noindex)) return false;
    if (!matchesBoolean(page.indexability?.hasNofollow, filters.nofollow)) return false;
    if (!matchesBoolean(page.indexability?.canonicalized, filters.canonicalized)) return false;
  }

  if (report === "Headings") {
    if (!matchesH1Status(page, filters.h1Status)) return false;
    if (!matchesHeadingHierarchy(page, filters.hierarchy)) return false;
    if (!matchesH2Status(page, filters.h2Status)) return false;
  }

  if (report === "Open Graph") {
    if (!matchesOpenGraphStatus(page, filters.ogStatus)) return false;
    if (!matchesOpenGraphField(page, "og:image", filters.ogImage)) return false;
    if (!matchesOpenGraphField(page, "og:title", filters.ogTitle)) return false;
    if (!matchesDuplicateOpenGraph(page, filters.duplicateOg)) return false;
  }

  if (report === "Structured Data") {
    if (!matchesStructuredStatus(page, filters.structuredStatus)) return false;
    if (!matchesStructuredValidity(page, filters.validity)) return false;
    if (!matchesStructuredErrors(page, filters.errorStatus)) return false;
  }

  return true;
}

function matchesLinkFilters(link: CrawlLink, filters: ReportFilters) {
  if (filters.linkType === "internal" && !link.isInternal) return false;
  if (filters.linkType === "external" && link.isInternal) return false;
  if (!matchesStatusGroup(link.destinationStatus, filters.destinationStatus)) return false;
  if (filters.destinationStatus === "not-crawled" && link.destinationStatus !== null) return false;
  if (filters.followStatus === "follow" && !link.isFollowed) return false;
  if (filters.followStatus === "nofollow" && link.isFollowed) return false;
  if (!matchesIssueByValue(link.issues, filters.linkIssue)) return false;
  return true;
}

function matchesImageFilters(image: CrawlImage, filters: ReportFilters) {
  if (filters.altStatus === "has-alt" && (!image.hasAltAttribute || !image.alt.trim())) return false;
  if (filters.altStatus === "missing-alt" && !hasIssue(image.issues, "Missing alt attribute")) return false;
  if (filters.altStatus === "empty-alt" && !hasIssue(image.issues, "Empty alt text")) return false;
  if (filters.altStatus === "generic-alt" && !hasIssue(image.issues, "Generic alt text")) return false;
  if (filters.imageSource === "normal-src" && (!image.src || image.srcset || image.isLazyLoaded)) return false;
  if (filters.imageSource === "srcset" && !image.srcset) return false;
  if (filters.imageSource === "lazy-loaded" && !image.isLazyLoaded) return false;
  if (filters.imageSource === "empty-src" && !hasIssue(image.issues, "Empty image src")) return false;
  if (filters.dimensions === "complete" && (!image.width || !image.height)) return false;
  if (filters.dimensions === "missing-width" && !hasIssue(image.issues, "Missing width")) return false;
  if (filters.dimensions === "missing-height" && !hasIssue(image.issues, "Missing height")) return false;
  if (filters.dimensions === "missing-both" && !(hasIssue(image.issues, "Missing width") && hasIssue(image.issues, "Missing height"))) return false;
  if (!matchesIssueStatus(image.issues, filters.issueStatus)) return false;
  return true;
}

function matchesSitemapFilters(record: CrawlSitemapRecord, filters: ReportFilters) {
  if (filters.coverage && filters.coverage !== "all" && record.coverage.toLowerCase().replace(/\s+/g, "-") !== filters.coverage) return false;
  if (!matchesIndexability(record.indexable, filters.indexability)) return false;
  if (!matchesStatusGroup(record.status, filters.statusGroup)) return false;
  if (!matchesIssueByValue(record.issues, filters.sitemapIssue)) return false;
  return true;
}

function matchesPsiFilters(record: CrawlPsiRecord, filters: ReportFilters) {
  if (filters.strategy && filters.strategy !== "all" && record.strategy !== filters.strategy) return false;
  if (!matchesScoreRange(record.performanceScore, filters.scoreRange)) return false;
  if (filters.apiStatus === "successful" && record.issues.length > 0) return false;
  if (filters.apiStatus === "failed" && record.issues.length === 0) return false;
  if (!matchesPsiVital(record, filters.vitalIssue)) return false;
  return true;
}

function matchesCompareFilters(record: CompareRow, filters: ReportFilters) {
  if (filters.changeType && filters.changeType !== "all" && record.changeType.toLowerCase() !== filters.changeType) return false;

  if (filters.statusChange === "changed" && !record.statusChange) return false;
  if (filters.statusChange === "became-4xx" && !becameStatusGroup(record.statusChange, "4")) return false;
  if (filters.statusChange === "became-5xx" && !becameStatusGroup(record.statusChange, "5")) return false;
  if (filters.statusChange === "fixed-to-2xx" && !fixedToStatusGroup(record.statusChange, "2")) return false;

  if (filters.metadataChange === "title" && !record.titleChange) return false;
  if (filters.metadataChange === "description" && !record.descriptionChange) return false;
  if (filters.metadataChange === "canonical" && !record.canonicalChange) return false;

  if (filters.issueDelta === "new-issue" && record.issuesAdded.length === 0) return false;
  if (filters.issueDelta === "fixed-issue" && record.issuesFixed.length === 0) return false;

  if (filters.indexabilityChange === "changed" && !record.indexabilityChange) return false;
  if (filters.indexabilityChange === "became-non-indexable" && !record.indexabilityChange.endsWith("No")) return false;
  if (filters.indexabilityChange === "became-indexable" && !record.indexabilityChange.endsWith("Yes")) return false;

  return true;
}

function matchesStatusGroup(status: number | null, value?: string) {
  if (!value || value === "all") return true;
  if (value === "failed" || value === "unknown" || value === "not-crawled") return status === null;
  if (!status) return false;
  return `${Math.floor(status / 100)}xx` === value;
}

function matchesIndexability(isIndexable: boolean | null | undefined, value?: string) {
  if (!value || value === "all") return true;
  if (value === "indexable") return isIndexable === true;
  if (value === "non-indexable") return isIndexable === false;
  if (value === "unknown") return isIndexable === null || isIndexable === undefined;
  return true;
}

function matchesIssueStatus(issues: string[], value?: string) {
  if (!value || value === "all") return true;
  if (value === "with-issues") return issues.length > 0;
  if (value === "no-issues") return issues.length === 0;
  return true;
}

function matchesDepth(depth: number, value?: string) {
  if (!value || value === "all") return true;
  if (value === "4+") return depth >= 4;
  return depth === Number(value);
}

function matchesWordCount(wordCount: number, value?: string) {
  if (!value || value === "all") return true;
  if (value === "thin") return wordCount > 0 && wordCount < 300;
  if (value === "normal") return wordCount >= 300 && wordCount <= 2000;
  if (value === "high") return wordCount > 2000;
  return true;
}

function matchesIssueOption(page: CrawlPage, value: string | undefined, issueMap: Record<string, string>) {
  if (!value || value === "all") return true;
  const issue = issueMap[value];
  return issue ? hasIssue(page.issues, issue) : true;
}

function matchesCanonicalStatus(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  if (value === "missing") return !page.canonical;
  if (value === "present") return Boolean(page.canonical);
  if (value === "invalid") return hasIssue(page.issues, "Invalid canonical");
  if (value === "canonicalized") return hasIssue(page.issues, "Canonicalized URL");
  if (value === "external") return hasIssue(page.issues, "Canonical points outside site");
  return true;
}

function matchesReason(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  const reasons = [...(page.indexability?.reasons ?? []), ...page.issues].join(" ").toLowerCase();
  if (value === "robots-blocked") return reasons.includes("robots");
  if (value === "http-error") return Boolean(page.status && page.status >= 400);
  return reasons.includes(value.replace("-", " "));
}

function matchesBoolean(flag: boolean | undefined, value?: string) {
  if (!value || value === "all") return true;
  if (value === "yes") return flag === true;
  if (value === "no") return flag !== true;
  return true;
}

function matchesH1Status(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  if (value === "missing") return page.h1.length === 0;
  if (value === "single") return page.h1.length === 1;
  if (value === "multiple") return page.h1.length > 1;
  return true;
}

function matchesHeadingHierarchy(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  const hasFirstHeadingIssue = hasIssue(page.issues, "First heading is not H1");
  const hasSequentialIssue = hasIssue(page.issues, "Non-sequential heading hierarchy");
  if (value === "valid") return !hasFirstHeadingIssue && !hasSequentialIssue;
  if (value === "first-heading-not-h1") return hasFirstHeadingIssue;
  if (value === "non-sequential") return hasSequentialIssue;
  return true;
}

function matchesH2Status(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  if (value === "missing") return page.h2.length === 0;
  if (value === "has-h2") return page.h2.length > 0;
  return true;
}

function matchesOpenGraphStatus(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  const hasMissing = hasIssue(page.issues, "Missing Open Graph tags");
  const hasDuplicate = page.issues.some((issue) => issue.toLowerCase().startsWith("duplicate og:"));
  if (value === "complete") return !hasMissing && !hasDuplicate;
  if (value === "missing-tags") return hasMissing;
  if (value === "duplicate-tags") return hasDuplicate;
  return true;
}

function matchesOpenGraphField(page: CrawlPage, field: string, value?: string) {
  if (!value || value === "all") return true;
  const hasValue = Boolean(page.metadata?.openGraph[field]?.some(Boolean));
  if (value === "present") return hasValue;
  if (value === "missing") return !hasValue;
  return true;
}

function matchesDuplicateOpenGraph(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  const hasDuplicate = page.issues.some((issue) => issue.toLowerCase().startsWith("duplicate og:"));
  if (value === "any-duplicate") return hasDuplicate;
  if (value === "no-duplicates") return !hasDuplicate;
  return true;
}

function matchesStructuredStatus(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  const blocks = page.metadata?.structuredData.jsonLd ?? [];
  if (value === "present") return blocks.length > 0;
  if (value === "missing") return blocks.length === 0;
  return true;
}

function matchesStructuredValidity(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  const blocks = page.metadata?.structuredData.jsonLd ?? [];
  if (value === "valid") return blocks.length > 0 && blocks.every((block) => block.valid);
  if (value === "invalid") return blocks.some((block) => !block.valid);
  return true;
}

function matchesStructuredErrors(page: CrawlPage, value?: string) {
  if (!value || value === "all") return true;
  const hasErrors = Boolean(page.metadata?.structuredData.jsonLd.some((block) => block.errors.length > 0));
  if (value === "has-errors") return hasErrors;
  if (value === "no-errors") return !hasErrors;
  return true;
}

function matchesIssueByValue(issues: string[], value?: string) {
  if (!value || value === "all") return true;
  if (value === "broken-link") return issues.some((issue) => issue.toLowerCase().includes("broken") && issue.toLowerCase().includes("link"));
  const normalizedNeedle = value.replace(/-/g, " ");
  return issues.some((issue) => issue.toLowerCase().includes(normalizedNeedle));
}

function matchesScoreRange(score: number | null, value?: string) {
  if (!value || value === "all") return true;
  if (value === "error") return score === null;
  if (score === null) return false;
  if (value === "poor") return score <= 49;
  if (value === "needs-improvement") return score >= 50 && score <= 89;
  if (value === "good") return score >= 90;
  return true;
}

function matchesPsiVital(record: CrawlPsiRecord, value?: string) {
  if (!value || value === "all") return true;
  if (value === "slow-fcp") return metricSeconds(record.fcp) > 1.8;
  if (value === "slow-lcp") return metricSeconds(record.lcp) > 2.5;
  if (value === "high-tbt") return metricMilliseconds(record.tbt) > 200;
  if (value === "high-cls") return Number.parseFloat(record.cls) > 0.1;
  if (value === "high-inp") return metricMilliseconds(record.inp) > 200;
  return true;
}

function metricSeconds(value: string) {
  const number = Number.parseFloat(value);
  if (Number.isNaN(number)) return 0;
  return value.toLowerCase().includes("ms") ? number / 1000 : number;
}

function metricMilliseconds(value: string) {
  const number = Number.parseFloat(value);
  if (Number.isNaN(number)) return 0;
  return value.toLowerCase().includes(" s") || value.toLowerCase().endsWith("s") ? number * 1000 : number;
}

function hasIssue(issues: string[], issueText: string) {
  return issues.some((issue) => issue.toLowerCase().includes(issueText.toLowerCase()));
}

function becameStatusGroup(statusChange: string, group: string) {
  const next = statusChange.split(" -> ")[1] ?? "";
  return next.startsWith(group);
}

function fixedToStatusGroup(statusChange: string, group: string) {
  const [previous, next] = statusChange.split(" -> ");
  return Boolean(previous && next?.startsWith(group) && !previous.startsWith(group));
}

function parsePreviousReportCsv(text: string): PreviousCrawlRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const indexFor = (name: string) => headers.indexOf(name.toLowerCase());
  const urlIndex = indexFor("url");
  if (urlIndex === -1) return [];

  const rowFor = (values: string[]): PreviousCrawlRow => ({
    url: values[urlIndex]?.trim() ?? "",
    finalUrl: valueAt(values, indexFor("finalUrl")),
    status: valueAt(values, indexFor("status")),
    title: valueAt(values, indexFor("title")),
    description: valueAt(values, indexFor("description")),
    canonical: valueAt(values, indexFor("canonical")),
    indexable: valueAt(values, indexFor("indexable")),
    wordCount: valueAt(values, indexFor("wordCount")),
    issues: valueAt(values, indexFor("issues"))
  });

  return rows
    .slice(1)
    .map(rowFor)
    .filter((row) => row.url);
}

function valueAt(values: string[], index: number) {
  if (index < 0) return "";
  return values[index]?.trim() ?? "";
}

function buildCompareRows(previousRows: PreviousCrawlRow[], currentPages: CrawlPage[]): CompareRow[] {
  if (previousRows.length === 0 || currentPages.length === 0) return [];

  const previousByUrl = new Map(previousRows.map((row) => [normalizeCompareUrl(row.url), row]));
  const currentByUrl = new Map(currentPages.map((page) => [normalizeCompareUrl(page.url), page]));
  const urls = new Set([...previousByUrl.keys(), ...currentByUrl.keys()]);
  const rows: CompareRow[] = [];

  for (const url of urls) {
    const previous = previousByUrl.get(url);
    const current = currentByUrl.get(url);

    if (!previous && current) {
      rows.push({
        url: current.url,
        changeType: "New",
        statusChange: `Missing -> ${statusLabel(current.status)}`,
        titleChange: `Missing -> ${current.title || "Missing"}`,
        descriptionChange: current.description ? "Missing -> Present" : "",
        canonicalChange: current.canonical ? "Missing -> Present" : "",
        indexabilityChange: `Missing -> ${indexableLabel(current.indexability?.isIndexable)}`,
        wordCountChange: `0 -> ${current.wordCount}`,
        issuesAdded: current.issues,
        issuesFixed: []
      });
      continue;
    }

    if (previous && !current) {
      rows.push({
        url: previous.url,
        changeType: "Removed",
        statusChange: `${previous.status || "Missing"} -> Missing`,
        titleChange: previous.title ? `${previous.title} -> Missing` : "",
        descriptionChange: previous.description ? "Present -> Missing" : "",
        canonicalChange: previous.canonical ? "Present -> Missing" : "",
        indexabilityChange: `${previous.indexable || "Unknown"} -> Missing`,
        wordCountChange: `${previous.wordCount || 0} -> 0`,
        issuesAdded: [],
        issuesFixed: splitIssueList(previous.issues)
      });
      continue;
    }

    if (!previous || !current) continue;

    const issuesAdded = diffList(splitIssueList(csvIssueText(previous)), current.issues);
    const issuesFixed = diffList(current.issues, splitIssueList(csvIssueText(previous)));
    const row: CompareRow = {
      url: current.url,
      changeType: "Changed",
      statusChange: changedText(previous.status, statusLabel(current.status)),
      titleChange: changedText(previous.title, current.title),
      descriptionChange: changedText(previous.description, current.description),
      canonicalChange: changedText(previous.canonical, current.canonical),
      indexabilityChange: changedText(normalizeIndexable(previous.indexable), indexableLabel(current.indexability?.isIndexable)),
      wordCountChange: changedText(previous.wordCount, String(current.wordCount)),
      issuesAdded,
      issuesFixed
    };

    if (hasCompareChanges(row)) rows.push(row);
  }

  return rows.sort((a, b) => changeRank(a.changeType) - changeRank(b.changeType) || a.url.localeCompare(b.url));
}

function hasCompareChanges(row: CompareRow) {
  return Boolean(
    row.statusChange ||
      row.titleChange ||
      row.descriptionChange ||
      row.canonicalChange ||
      row.indexabilityChange ||
      row.wordCountChange ||
      row.issuesAdded.length ||
      row.issuesFixed.length
  );
}

function changeRank(changeType: CompareRow["changeType"]) {
  if (changeType === "New") return 0;
  if (changeType === "Removed") return 1;
  return 2;
}

function normalizeCompareUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return url.href;
  } catch {
    return value.trim();
  }
}

function statusLabel(status: number | null) {
  return status === null ? "Failed" : String(status);
}

function indexableLabel(value: boolean | undefined) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unknown";
}

function normalizeIndexable(value: string) {
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  return value || "Unknown";
}

function changedText(previous: string, current: string) {
  const previousValue = previous || "Missing";
  const currentValue = current || "Missing";
  return previousValue === currentValue ? "" : `${previousValue} -> ${currentValue}`;
}

function splitIssueList(value: string | string[]) {
  if (Array.isArray(value)) return value.map((issue) => issue.trim()).filter(Boolean);
  return value.split(";").map((issue) => issue.trim()).filter(Boolean);
}

function csvIssueText(row: PreviousCrawlRow) {
  return row.issues;
}

function diffList(previous: string[], current: string[]) {
  const previousSet = new Set(previous.map((item) => item.toLowerCase()));
  return current.filter((item) => !previousSet.has(item.toLowerCase()));
}

function getReportHeaders(report: ReportTab) {
  if (report === "Metadata") return ["URL", "Title", "Title Length", "Title Count", "Description", "Description Length", "Description Count", "Canonical", "Issues"];
  if (report === "Indexability") return ["URL", "Status", "Indexable", "Noindex", "Nofollow", "Canonicalized", "Reasons"];
  if (report === "Headings") return ["URL", "H1 Count", "H2 Count", "Heading Path", "Issues"];
  if (report === "Open Graph") return ["URL", "OG Title", "OG Description", "OG URL", "OG Type", "OG Image", "Issues"];
  if (report === "Structured Data") return ["URL", "JSON-LD Blocks", "Invalid Blocks", "Errors"];
  if (report === "Links") return ["Source URL", "Destination URL", "Status", "Final URL", "Anchor Text", "Type", "Followed", "Internal", "Indexable", "Issues"];
  if (report === "Images") return ["Page URL", "Image URL", "Srcset", "Alt", "Has Alt", "Width", "Height", "Lazy", "Issues"];
  if (report === "Sitemaps") return ["Sitemap URL", "URL", "Status", "Indexable", "Coverage", "Issues"];
  if (report === "PageSpeed") return ["URL", "Strategy", "Score", "FCP", "Speed Index", "LCP", "TBT", "CLS", "INP", "Issues"];
  if (report === "Compare") return ["URL", "Change", "Status", "Title", "Description", "Canonical", "Indexability", "Words", "New Issues", "Fixed Issues"];
  return [
    "URL",
    "Status",
    "Depth",
    "Response Time",
    "Title",
    "Title Length",
    "Description",
    "Description Length",
    "Canonical",
    "Redirect URL",
    "Redirect Type",
    "Words",
    "Issues",
    "Indexable",
    "Indexability Reasons",
    "Inlinks",
    "Outlinks",
    "External Outlinks",
    "Referrers",
    "Images"
  ];
}

function getReportRows(report: ReportTab, pages: CrawlPage[], links: CrawlLink[], images: CrawlImage[], sitemaps: CrawlSitemapRecord[], psiResults: CrawlPsiRecord[], compareRows: CompareRow[]) {
  if (report === "Metadata") {
    return pages.length ? pages.map((page) => (
      <tr key={`metadata-${page.url}`}>
        <td>{page.url}</td>
        <td>{page.title || "Missing"}</td>
        <td>{page.titleLength ?? page.metadata?.titleLength ?? page.title.length}</td>
        <td>{page.metadata?.counts.titles ?? 0}</td>
        <td>{page.description || "Missing"}</td>
        <td>{page.descriptionLength ?? page.metadata?.descriptionLength ?? page.description.length}</td>
        <td>{page.metadata?.counts.descriptions ?? 0}</td>
        <td>{page.canonical || "Missing"}</td>
        <td>{issueText(page, ["title", "description", "canonical", "Duplicate"])}</td>
      </tr>
    )) : emptyRow(report, "No matching metadata records. Clear filters or start a crawl.");
  }

  if (report === "Indexability") {
    return pages.length ? pages.map((page) => (
      <tr key={`indexability-${page.url}`}>
        <td>{page.url}</td>
        <td>{page.status ?? "Fail"}</td>
        <td>{page.indexability?.isIndexable ? "Yes" : "No"}</td>
        <td>{page.indexability?.hasNoindex ? "Yes" : "No"}</td>
        <td>{page.indexability?.hasNofollow ? "Yes" : "No"}</td>
        <td>{page.indexability?.canonicalized ? "Yes" : "No"}</td>
        <td>{page.indexability?.reasons.join(", ") ?? ""}</td>
      </tr>
    )) : emptyRow(report, "No matching indexability records. Clear filters or start a crawl.");
  }

  if (report === "Headings") {
    return pages.length ? pages.map((page) => (
      <tr key={`headings-${page.url}`}>
        <td>{page.url}</td>
        <td>{page.h1.length}</td>
        <td>{page.h2.length}</td>
        <td>{page.headings?.map((heading) => `H${heading.level}: ${heading.text}`).join(" > ") ?? ""}</td>
        <td>{issueText(page, ["H1", "heading"])}</td>
      </tr>
    )) : emptyRow(report, "No matching heading records. Clear filters or start a crawl.");
  }

  if (report === "Open Graph") {
    return pages.length ? pages.map((page) => {
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
    }) : emptyRow(report, "No matching Open Graph records. Clear filters or start a crawl.");
  }

  if (report === "Structured Data") {
    return pages.length ? pages.map((page) => {
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
    }) : emptyRow(report, "No matching structured data records. Clear filters or start a crawl.");
  }

  if (report === "Links") {
    return links.length ? links.map((link) => (
      <tr key={link.id}>
        <td>{link.sourceUrl}</td>
        <td>{link.destinationUrl || "Missing"}</td>
        <td>{link.destinationStatus ?? "Unknown"}</td>
        <td>{link.finalDestinationUrl || ""}</td>
        <td>{link.anchorText}</td>
        <td>{link.linkType}</td>
        <td>{link.isFollowed ? "Yes" : "No"}</td>
        <td>{link.isInternal ? "Yes" : "No"}</td>
        <td>{link.destinationIndexable === null ? "Unknown" : link.destinationIndexable ? "Yes" : "No"}</td>
        <td>{link.issues.join(", ")}</td>
      </tr>
    )) : emptyRow(report, "No matching link records. Clear filters or start a crawl.");
  }

  if (report === "Images") {
    return images.length ? images.map((image) => (
      <tr key={image.id}>
        <td>{image.pageUrl}</td>
        <td>{image.src || "Missing"}</td>
        <td>{image.srcset}</td>
        <td>{image.alt}</td>
        <td>{image.hasAltAttribute ? "Yes" : "No"}</td>
        <td>{image.width || "Missing"}</td>
        <td>{image.height || "Missing"}</td>
        <td>{image.isLazyLoaded ? "Yes" : "No"}</td>
        <td>{image.issues.join(", ")}</td>
      </tr>
    )) : emptyRow(report, "No matching image records. Clear filters or start a crawl.");
  }

  if (report === "Sitemaps") {
    return sitemaps.length ? sitemaps.map((record) => (
      <tr key={`${record.sitemapUrl}-${record.url}`}>
        <td>{record.sitemapUrl}</td>
        <td>{record.url}</td>
        <td>{record.status ?? "Unknown"}</td>
        <td>{record.indexable === null ? "Unknown" : record.indexable ? "Yes" : "No"}</td>
        <td>{record.coverage}</td>
        <td>{record.issues.join(", ")}</td>
      </tr>
    )) : emptyRow(report, "No matching sitemap records. Clear filters or start a crawl.");
  }
  if (report === "PageSpeed") {
    return psiResults.length ? psiResults.map((record) => (
      <tr key={`${record.url}-${record.strategy}`}>
        <td>{record.url}</td>
        <td>{record.strategy}</td>
        <td>{scoreText(record.performanceScore)}</td>
        <td>{record.fcp}</td>
        <td>{record.speedIndex}</td>
        <td>{record.lcp}</td>
        <td>{record.tbt}</td>
        <td>{record.cls}</td>
        <td>{record.inp}</td>
        <td>{record.issues.join(", ")}</td>
      </tr>
    )) : emptyRow(report, "No matching PageSpeed records. Clear filters or enable PageSpeed before crawling.");
  }

  if (report === "Compare") {
    return compareRows.length ? compareRows.map((record) => (
      <tr key={`compare-${record.url}`}>
        <td>{record.url}</td>
        <td>{record.changeType}</td>
        <td>{record.statusChange}</td>
        <td>{record.titleChange}</td>
        <td>{record.descriptionChange}</td>
        <td>{record.canonicalChange}</td>
        <td>{record.indexabilityChange}</td>
        <td>{record.wordCountChange}</td>
        <td>{record.issuesAdded.join(", ")}</td>
        <td>{record.issuesFixed.join(", ")}</td>
      </tr>
    )) : emptyRow(report, "Upload a previous CSV and run a current crawl to compare changes.");
  }

  return pages.length ? pages.map((page) => (
    <tr key={`overview-${page.url}`}>
      <td>{page.url}</td>
      <td>{page.status ?? "Fail"}</td>
      <td>{page.depth}</td>
      <td>{formatResponseTime(page.responseTimeMs)}</td>
      <td>{page.title || "Missing"}</td>
      <td>{page.titleLength ?? page.title.length}</td>
      <td>{page.description || "Missing"}</td>
      <td>{page.descriptionLength ?? page.description.length}</td>
      <td>{page.canonical || "Missing"}</td>
      <td>{page.redirectUrl || ""}</td>
      <td>{page.redirectType || ""}</td>
      <td>{page.wordCount}</td>
      <td>{page.issues.join(", ")}</td>
      <td>{page.indexability ? (page.indexability.isIndexable ? "Yes" : "No") : "Unknown"}</td>
      <td>{page.indexability?.reasons.join(", ") ?? ""}</td>
      <td>{page.incomingInternalLinks ?? 0}</td>
      <td>{page.outgoingInternalLinks ?? 0}</td>
      <td>{page.externalOutgoingLinks ?? 0}</td>
      <td>{page.referrerUrls?.join(", ") ?? ""}</td>
      <td>{page.imageCount ?? 0}</td>
    </tr>
  )) : emptyRow(report, "No matching URL records. Clear filters or start a crawl.");
}

function issueText(page: CrawlPage, terms: string[]) {
  return page.issues.filter((issue) => terms.some((term) => issue.toLowerCase().includes(term.toLowerCase()))).join(", ");
}

function firstValue(values?: string[]) {
  return values?.find(Boolean) ?? "Missing";
}

function scoreText(score: number | null) {
  return score === null ? "Error" : String(score);
}

function formatResponseTime(responseTimeMs?: number) {
  return typeof responseTimeMs === "number" && responseTimeMs > 0 ? `${responseTimeMs} ms` : "";
}

function emptyRow(report: ReportTab, message: string) {
  return (
    <tr>
      <td colSpan={getReportHeaders(report).length}>{message}</td>
    </tr>
  );
}
