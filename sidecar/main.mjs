#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

const emit = (type, payload) => {
  process.stdout.write(JSON.stringify({ type, payload }) + "\n");
};

class Crawler {
  constructor() {
    this.reset();
  }

  reset() {
    this.settings = null;
    this.root = null;
    this.origin = "";
    this.queue = [];
    this.seen = new Set();
    this.pages = [];
    this.active = 0;
    this.status = "idle";
    this.startedAt = 0;
    this.timer = null;
    this.robots = null;
    this.titleMap = new Map();
    this.descriptionMap = new Map();
    this.h1Map = new Map();
  }

  async start(settings) {
    this.reset();
    this.settings = settings;
    this.root = new URL(settings.rootUrl);
    this.origin = this.root.origin;
    this.status = "running";
    this.startedAt = Date.now();
    this.enqueue(this.root.href, 0);
    emit("status", this.status);
    emit("log", `Started crawl for ${this.root.href}`);

    if (settings.respectRobots) await this.loadRobots();

    this.timer = setInterval(() => this.emitStats(), 500);
    this.pump();
  }

  pause() {
    if (this.status !== "running") return;
    this.status = "paused";
    emit("status", this.status);
  }

  resume() {
    if (this.status !== "paused") return;
    this.status = "running";
    emit("status", this.status);
    this.pump();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.status = "stopped";
    this.queue = [];
    emit("status", this.status);
    this.emitStats();
  }

  async loadRobots() {
    const robotsUrl = new URL("/robots.txt", this.origin).href;
    try {
      const response = await fetch(robotsUrl, { headers: { "user-agent": this.settings.userAgent } });
      const body = response.ok ? await response.text() : "";
      this.robots = robotsParser(robotsUrl, body);
      emit("log", response.ok ? "Loaded robots.txt rules." : "No robots.txt found.");
    } catch {
      emit("log", "robots.txt check failed; continuing crawl.");
    }
  }

  enqueue(rawUrl, depth, discoveredFrom) {
    if (this.seen.size >= this.settings.maxUrls) return;
    const normalized = this.normalize(rawUrl);
    if (!normalized || this.seen.has(normalized)) return;
    if (!normalized.startsWith(this.origin)) return;
    if (depth > this.settings.maxDepth) return;
    if (this.robots && !this.robots.isAllowed(normalized, this.settings.userAgent)) {
      emit("log", `Blocked by robots.txt: ${normalized}`);
      return;
    }

    this.seen.add(normalized);
    this.queue.push({ url: normalized, depth, discoveredFrom });
  }

  normalize(rawUrl) {
    try {
      const url = new URL(rawUrl, this.root);
      url.hash = "";
      if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
      return url.href;
    } catch {
      return null;
    }
  }

  pump() {
    if (this.status !== "running") return;
    while (this.active < this.settings.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.active += 1;
      this.crawl(item).finally(() => {
        this.active -= 1;
        if (this.status === "running") {
          setTimeout(() => this.pump(), this.settings.delayMs);
        }
        if (this.queue.length === 0 && this.active === 0 && this.status === "running") {
          this.finish();
        }
      });
    }
  }

  async crawl(item) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(item.url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": this.settings.userAgent }
      });
      const contentType = response.headers.get("content-type") ?? "";
      const html = contentType.includes("text/html") ? await response.text() : "";
      const page = this.extractPage(item, response, html, contentType);
      this.pages.push(page);
      emit("page", page);
      if (html) this.discoverLinks(item, html);
    } catch (error) {
      const page = {
        url: item.url,
        finalUrl: item.url,
        depth: item.depth,
        status: null,
        contentType: "",
        title: "",
        description: "",
        canonical: "",
        h1: [],
        h2: [],
        wordCount: 0,
        issues: ["Request failed"],
        discoveredFrom: item.discoveredFrom
      };
      this.pages.push(page);
      emit("page", page);
      emit("log", `${item.url}: ${error?.name === "AbortError" ? "timeout" : "request failed"}`);
    } finally {
      clearTimeout(timeout);
      this.emitStats();
    }
  }

  extractPage(item, response, html, contentType) {
    const $ = cheerio.load(html || "");
    const title = clean($("title").first().text());
    const description = clean($('meta[name="description"]').attr("content") ?? "");
    const canonical = clean($('link[rel="canonical"]').attr("href") ?? "");
    const h1 = $("h1").map((_, el) => clean($(el).text())).get().filter(Boolean);
    const h2 = $("h2").map((_, el) => clean($(el).text())).get().filter(Boolean);
    const text = clean($("body").text());
    const wordCount = text ? text.split(/\s+/).length : 0;

    const issues = [];
    if (response.status >= 400) issues.push("HTTP error");
    if (!title) issues.push("Missing title");
    if (title && title.length < 30) issues.push("Short title");
    if (title.length > 60) issues.push("Long title");
    if (!description) issues.push("Missing meta description");
    if (description.length > 160) issues.push("Long meta description");
    if (h1.length === 0) issues.push("Missing H1");
    if (h1.length > 1) issues.push("Multiple H1s");
    if (wordCount > 0 && wordCount < this.settings.minWordCount) issues.push("Thin content");

    addDuplicateIssue(this.titleMap, title, "Duplicate title", issues);
    addDuplicateIssue(this.descriptionMap, description, "Duplicate meta description", issues);
    addDuplicateIssue(this.h1Map, h1[0] ?? "", "Duplicate H1", issues);

    return {
      url: item.url,
      finalUrl: response.url,
      depth: item.depth,
      status: response.status,
      contentType,
      title,
      description,
      canonical,
      h1,
      h2,
      wordCount,
      issues,
      discoveredFrom: item.discoveredFrom
    };
  }

  discoverLinks(item, html) {
    const $ = cheerio.load(html);
    $("a[href]").each((_, element) => {
      this.enqueue($(element).attr("href"), item.depth + 1, item.url);
    });
  }

  finish() {
    if (this.timer) clearInterval(this.timer);
    this.status = "complete";
    emit("status", this.status);
    this.emitStats();
    emit("complete", { pages: this.pages.length });
  }

  emitStats() {
    const elapsed = this.startedAt ? Math.max(1, Date.now() - this.startedAt) : 0;
    emit("stats", {
      discovered: this.seen.size,
      crawled: this.pages.length,
      queued: this.queue.length,
      active: this.active,
      errors: this.pages.filter((page) => !page.status || page.status >= 400).length,
      urlsPerSecond: elapsed ? this.pages.length / (elapsed / 1000) : 0,
      durationMs: elapsed
    });
  }

  async exportCsv(report) {
    const dir = join(tmpdir(), "scout-seo-exports");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${report}-${Date.now()}.csv`);
    const header = ["url", "finalUrl", "status", "depth", "title", "description", "canonical", "wordCount", "issues"];
    const rows = this.pages.map((page) => [
      page.url,
      page.finalUrl,
      page.status ?? "",
      page.depth,
      page.title,
      page.description,
      page.canonical,
      page.wordCount,
      page.issues.join("; ")
    ]);
    await writeFile(filePath, [header, ...rows].map(toCsvRow).join("\n"));
    emit("exported", { report, filePath });
    emit("log", `Exported ${report} CSV to ${filePath}`);
  }
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function addDuplicateIssue(map, value, issue, issues) {
  if (!value) return;
  const count = (map.get(value) ?? 0) + 1;
  map.set(value, count);
  if (count > 1) issues.push(issue);
}

function toCsvRow(row) {
  return row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",");
}

const crawler = new Crawler();
emit("ready", { version: "0.1.0" });

createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type === "start") await crawler.start(message.payload);
    if (message.type === "pause") crawler.pause();
    if (message.type === "resume") crawler.resume();
    if (message.type === "stop") crawler.stop();
    if (message.type === "export") await crawler.exportCsv(message.payload.report);
  } catch (error) {
    emit("error", error?.message ?? "Unknown engine error");
  }
});
