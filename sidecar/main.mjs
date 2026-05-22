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
    this.store = createEmptyStore();
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

  enqueue(rawUrl, depth, discoveredFrom, baseUrl = this.root?.href) {
    if (this.seen.size >= this.settings.maxUrls) return;
    const normalized = this.normalize(rawUrl, baseUrl);
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

  normalize(rawUrl, baseUrl = this.root?.href) {
    try {
      const url = new URL(rawUrl, baseUrl);
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
      this.storePage(page);
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
      this.storePage(page);
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
    const canonical = normalizeOptionalUrl(clean($('link[rel="canonical"]').attr("href") ?? ""), item.url);
    const h1 = $("h1").map((_, el) => clean($(el).text())).get().filter(Boolean);
    const h2 = $("h2").map((_, el) => clean($(el).text())).get().filter(Boolean);
    const headings = extractHeadings($);
    const openGraph = extractMetaProperties($, "og:");
    const twitter = extractMetaNames($, "twitter:");
    const robotsMeta = clean($('meta[name="robots"], meta[name="googlebot"]').map((_, el) => $(el).attr("content")).get().join(", "));
    const xRobotsTag = clean(response.headers.get("x-robots-tag") ?? "");
    const structuredData = extractStructuredData($, item.url);
    const text = clean($("body").text());
    const wordCount = text ? text.split(/\s+/).length : 0;
    const indexability = buildIndexability({
      status: response.status,
      robotsMeta,
      xRobotsTag,
      canonical,
      url: item.url,
      finalUrl: response.url
    });

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

    const pageImages = this.extractImages(item, $);

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
      headings,
      metadata: {
        title,
        description,
        canonical,
        robotsMeta,
        xRobotsTag,
        openGraph,
        twitter,
        structuredData
      },
      indexability,
      wordCount,
      issues,
      discoveredFrom: item.discoveredFrom,
      referrerUrls: item.discoveredFrom ? [item.discoveredFrom] : [],
      outgoingInternalLinks: 0,
      incomingInternalLinks: 0,
      imageCount: pageImages.length
    };
  }

  discoverLinks(item, html) {
    const $ = cheerio.load(html);
    $("a").each((index, element) => {
      const href = $(element).attr("href") ?? "";
      const normalized = href ? this.normalize(href, item.url) : "";
      const destinationOrigin = normalized ? safeOrigin(normalized) : "";
      const isInternal = Boolean(normalized && destinationOrigin === this.origin);
      const rel = clean($(element).attr("rel") ?? "");
      const link = {
        id: `${item.url}#a-${index}`,
        sourceUrl: item.url,
        rawHref: href,
        destinationUrl: normalized,
        normalizedDestinationUrl: normalized,
        anchorText: clean($(element).text()),
        rel,
        isFollowed: !/\bnofollow\b/i.test(rel),
        isInternal,
        depth: item.depth + 1,
        linkType: classifyLink($, element),
        issues: href ? [] : ["Missing href"]
      };

      this.store.links.push(link);
      if (isInternal) this.enqueue(href, item.depth + 1, item.url, item.url);
    });
  }

  extractImages(item, $) {
    const images = [];
    $("img").each((index, element) => {
      const src = $(element).attr("src") ?? "";
      const alt = $(element).attr("alt");
      const width = clean($(element).attr("width") ?? "");
      const height = clean($(element).attr("height") ?? "");
      const issues = [];

      if (!src) issues.push("Empty image src");
      if (alt === undefined) issues.push("Missing alt attribute");
      if (alt !== undefined && !clean(alt)) issues.push("Empty alt text");
      if (!width) issues.push("Missing width");
      if (!height) issues.push("Missing height");

      const image = {
        id: `${item.url}#img-${index}`,
        pageUrl: item.url,
        rawSrc: src,
        src: src ? this.normalize(src, item.url) : "",
        alt: clean(alt ?? ""),
        hasAltAttribute: alt !== undefined,
        width,
        height,
        issues
      };

      this.store.images.push(image);
      images.push(image);
    });

    return images;
  }

  storePage(page) {
    this.store.pages.set(page.url, page);
    this.store.metadata.set(page.url, page.metadata ?? null);
    this.store.indexability.set(page.url, page.indexability ?? null);

    for (const heading of page.headings ?? []) {
      this.store.headings.push({ pageUrl: page.url, ...heading });
    }
  }

  finish() {
    if (this.timer) clearInterval(this.timer);
    this.status = "complete";
    this.enrichPageLinkCounts();
    for (const page of this.pages) emit("page", page);
    emit("status", this.status);
    this.emitStats();
    emit("complete", this.getSummary());
  }

  emitStats() {
    const elapsed = this.startedAt ? Math.max(1, Date.now() - this.startedAt) : 0;
    emit("stats", {
      discovered: this.seen.size,
      crawled: this.pages.length,
      queued: this.queue.length,
      active: this.active,
      errors: this.pages.filter((page) => !page.status || page.status >= 400).length,
      links: this.store.links.length,
      images: this.store.images.length,
      urlsPerSecond: elapsed ? this.pages.length / (elapsed / 1000) : 0,
      durationMs: elapsed
    });
  }

  async exportCsv(report) {
    const dir = join(tmpdir(), "scout-seo-exports");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${report}-${Date.now()}.csv`);
    const header = ["url", "finalUrl", "status", "depth", "title", "description", "canonical", "indexable", "wordCount", "incomingInternalLinks", "outgoingInternalLinks", "referrerUrls", "issues"];
    const rows = this.pages.map((page) => [
      page.url,
      page.finalUrl,
      page.status ?? "",
      page.depth,
      page.title,
      page.description,
      page.canonical,
      page.indexability?.isIndexable ?? "",
      page.wordCount,
      page.incomingInternalLinks ?? 0,
      page.outgoingInternalLinks ?? 0,
      (page.referrerUrls ?? []).join("; "),
      page.issues.join("; ")
    ]);
    await writeFile(filePath, [header, ...rows].map(toCsvRow).join("\n"));
    emit("exported", { report, filePath });
    emit("log", `Exported ${report} CSV to ${filePath}`);
  }

  enrichPageLinkCounts() {
    const incoming = new Map();
    const outgoing = new Map();
    const referrers = new Map();

    for (const link of this.store.links) {
      if (!link.isInternal || !link.destinationUrl) continue;
      outgoing.set(link.sourceUrl, (outgoing.get(link.sourceUrl) ?? 0) + 1);
      incoming.set(link.destinationUrl, (incoming.get(link.destinationUrl) ?? 0) + 1);
      if (!referrers.has(link.destinationUrl)) referrers.set(link.destinationUrl, new Set());
      referrers.get(link.destinationUrl).add(link.sourceUrl);
    }

    this.pages = this.pages.map((page) => ({
      ...page,
      incomingInternalLinks: incoming.get(page.url) ?? 0,
      outgoingInternalLinks: outgoing.get(page.url) ?? 0,
      referrerUrls: Array.from(referrers.get(page.url) ?? new Set(page.discoveredFrom ? [page.discoveredFrom] : []))
    }));

    for (const page of this.pages) this.store.pages.set(page.url, page);
  }

  getSummary() {
    return {
      pages: this.pages.length,
      links: this.store.links.length,
      images: this.store.images.length,
      headings: this.store.headings.length,
      metadata: this.store.metadata.size,
      indexability: this.store.indexability.size,
      sitemaps: this.store.sitemaps.length,
      psiResults: this.store.psiResults.size
    };
  }
}

function createEmptyStore() {
  return {
    pages: new Map(),
    links: [],
    headings: [],
    metadata: new Map(),
    indexability: new Map(),
    images: [],
    sitemaps: [],
    psiResults: new Map()
  };
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeOptionalUrl(value, baseUrl) {
  if (!value) return "";
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function extractHeadings($) {
  const headings = [];
  $("h1,h2,h3,h4,h5,h6").each((index, element) => {
    const tagName = element.tagName?.toLowerCase() ?? "";
    headings.push({
      order: index,
      level: Number(tagName.replace("h", "")),
      text: clean($(element).text())
    });
  });
  return headings;
}

function extractMetaProperties($, prefix) {
  const tags = {};
  $(`meta[property^="${prefix}"]`).each((_, element) => {
    const property = clean($(element).attr("property") ?? "");
    const content = clean($(element).attr("content") ?? "");
    if (!property) return;
    if (!tags[property]) tags[property] = [];
    tags[property].push(content);
  });
  return tags;
}

function extractMetaNames($, prefix) {
  const tags = {};
  $(`meta[name^="${prefix}"]`).each((_, element) => {
    const name = clean($(element).attr("name") ?? "");
    const content = clean($(element).attr("content") ?? "");
    if (!name) return;
    if (!tags[name]) tags[name] = [];
    tags[name].push(content);
  });
  return tags;
}

function extractStructuredData($, pageUrl) {
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((index, element) => {
    const raw = $(element).contents().text();
    try {
      const parsed = JSON.parse(raw);
      jsonLd.push({ id: `${pageUrl}#jsonld-${index}`, type: "json-ld", valid: true, data: parsed, errors: [] });
    } catch (error) {
      jsonLd.push({ id: `${pageUrl}#jsonld-${index}`, type: "json-ld", valid: false, data: null, errors: [error?.message ?? "Invalid JSON-LD"] });
    }
  });

  return { jsonLd };
}

function buildIndexability({ status, robotsMeta, xRobotsTag, canonical, url, finalUrl }) {
  const robots = `${robotsMeta},${xRobotsTag}`.toLowerCase();
  const hasNoindex = /\bnoindex\b/.test(robots);
  const hasNofollow = /\bnofollow\b/.test(robots);
  const canonicalized = Boolean(canonical && canonical !== url && canonical !== finalUrl);
  const reasons = [];

  if (status >= 400) reasons.push("HTTP error");
  if (hasNoindex) reasons.push("noindex");
  if (canonicalized) reasons.push("canonicalized");

  return {
    isIndexable: status < 400 && !hasNoindex && !canonicalized,
    hasNoindex,
    hasNofollow,
    robotsMeta,
    xRobotsTag,
    canonical,
    canonicalized,
    reasons
  };
}

function classifyLink($, element) {
  if ($(element).find("img").length > 0) return "image";
  if ($(element).closest("nav").length > 0) return "navigation";
  if ($(element).closest("footer").length > 0) return "footer";
  if ($(element).closest("header").length > 0) return "header";
  return "body";
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
