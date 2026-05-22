import { useMemo, useRef, useState } from "react";
import { Activity, Download, Pause, Play, Search, Square, Trash2 } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { EngineClient } from "./engineClient";
import type { CrawlPage, CrawlSettings, CrawlStats, CrawlStatus } from "./types";

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

export function App() {
  const engineRef = useRef(new EngineClient());
  const subscribedRef = useRef(false);
  const [settings, setSettings] = useState(defaultSettings);
  const [status, setStatus] = useState<CrawlStatus>("idle");
  const [stats, setStats] = useState(emptyStats);
  const [pages, setPages] = useState<CrawlPage[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [logs, setLogs] = useState<string[]>(["Ready to crawl."]);

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

  async function ensureEngine() {
    const engine = engineRef.current;
    if (!subscribedRef.current) {
      engine.subscribe((event) => {
        if (event.type === "status") setStatus(event.payload as CrawlStatus);
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
    setStats(emptyStats);
    setLogs([]);
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
            <input placeholder="Search URLs or titles" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="2">2xx</option>
            <option value="3">3xx</option>
            <option value="4">4xx</option>
            <option value="5">5xx</option>
          </select>
        </section>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Status</th>
                <th>Depth</th>
                <th>Title</th>
                <th>Description</th>
                <th>Words</th>
                <th>Issues</th>
                <th>Indexable</th>
                <th>Inlinks</th>
                <th>Outlinks</th>
                <th>Referrers</th>
                <th>Images</th>
              </tr>
            </thead>
            <tbody>
              {filteredPages.map((page) => (
                <tr key={page.url}>
                  <td>{page.url}</td>
                  <td>{page.status ?? "Fail"}</td>
                  <td>{page.depth}</td>
                  <td>{page.title || "Missing"}</td>
                  <td>{page.description || "Missing"}</td>
                  <td>{page.wordCount}</td>
                  <td>{page.issues.join(", ")}</td>
                  <td>{page.indexability ? (page.indexability.isIndexable ? "Yes" : "No") : "Unknown"}</td>
                  <td>{page.incomingInternalLinks ?? 0}</td>
                  <td>{page.outgoingInternalLinks ?? 0}</td>
                  <td>{page.referrerUrls?.join(", ") ?? ""}</td>
                  <td>{page.imageCount ?? 0}</td>
                </tr>
              ))}
            </tbody>
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
