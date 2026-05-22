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
    this.titleOccurrences = new Map();
    this.descriptionOccurrences = new Map();
    this.h1Occurrences = new Map();
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
    const titleTags = $("title").map((_, el) => clean($(el).text())).get().filter(Boolean);
    const descriptionTags = $('meta[name="description"]').map((_, el) => clean($(el).attr("content") ?? "")).get();
    const canonicalTags = $('link[rel="canonical"]').map((_, el) => clean($(el).attr("href") ?? "")).get();
    const title = titleTags[0] ?? "";
    const description = clean(descriptionTags.find(Boolean) ?? "");
    const canonical = normalizeOptionalUrl(clean(canonicalTags.find(Boolean) ?? ""), item.url);
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
    if (response.status >= 400) addIssue(issues, "HTTP error");
    validateMetadataIssues({
      issues,
      title,
      titleCount: titleTags.length,
      description,
      descriptionCount: descriptionTags.length,
      h1,
      wordCount,
      minWordCount: this.settings.minWordCount
    });
    validateCanonicalIssues({ issues, canonical, canonicalCount: canonicalTags.length, pageUrl: item.url, finalUrl: response.url, origin: this.origin });
    validateHeadingHierarchy(issues, headings);
    validateOpenGraphIssues(issues, openGraph);

    addOccurrence(this.titleOccurrences, title, item.url);
    addOccurrence(this.descriptionOccurrences, description, item.url);
    addOccurrence(this.h1Occurrences, h1[0] ?? "", item.url);

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
        counts: {
          titles: titleTags.length,
          descriptions: descriptionTags.length,
          canonicals: canonicalTags.length,
          h1: h1.length
        },
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
        finalDestinationUrl: "",
        destinationStatus: null,
        destinationIndexable: null,
        anchorText: clean($(element).text()),
        rel,
        isFollowed: !/\bnofollow\b/i.test(rel),
        isInternal,
        depth: item.depth + 1,
        linkType: classifyLink($, element),
        issues: buildLinkIssues({ href, normalized, anchorText: clean($(element).text()), rel, isInternal })
      };

      this.store.links.push(link);
      emit("link", link);
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
      emit("image", image);
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
    this.enrichLinks();
    this.enrichPageLinkCounts();
    this.applyDuplicateIssues();
    for (const page of this.pages) emit("page", page);
    for (const link of this.store.links) emit("link", link);
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

  enrichLinks() {
    for (const link of this.store.links) {
      if (!link.isInternal || !link.destinationUrl) continue;

      const destinationPage = this.store.pages.get(link.destinationUrl);
      if (!destinationPage) {
        addIssue(link.issues, "Destination not crawled");
        continue;
      }

      link.destinationStatus = destinationPage.status;
      link.finalDestinationUrl = destinationPage.finalUrl;
      link.destinationIndexable = destinationPage.indexability?.isIndexable ?? null;

      if (!destinationPage.status || destinationPage.status >= 400) addIssue(link.issues, "Broken internal link");
      if (destinationPage.status && destinationPage.status >= 300 && destinationPage.status < 400) addIssue(link.issues, "Redirecting internal link");
      if (destinationPage.indexability && !destinationPage.indexability.isIndexable) addIssue(link.issues, "Links to non-indexable URL");
    }
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

  applyDuplicateIssues() {
    applyDuplicateIssueToPages(this.pages, this.titleOccurrences, "Duplicate title");
    applyDuplicateIssueToPages(this.pages, this.descriptionOccurrences, "Duplicate meta description");
    applyDuplicateIssueToPages(this.pages, this.h1Occurrences, "Duplicate H1");
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

function addIssue(issues, issue) {
  if (!issues.includes(issue)) issues.push(issue);
}

function addOccurrence(map, value, url) {
  if (!value) return;
  const key = value.toLowerCase();
  if (!map.has(key)) map.set(key, { value, urls: new Set() });
  map.get(key).urls.add(url);
}

function applyDuplicateIssueToPages(pages, occurrences, issue) {
  const duplicateUrls = new Set();

  for (const occurrence of occurrences.values()) {
    if (occurrence.urls.size <= 1) continue;
    for (const url of occurrence.urls) duplicateUrls.add(url);
  }

  for (const page of pages) {
    if (duplicateUrls.has(page.url)) addIssue(page.issues, issue);
  }
}

function validateMetadataIssues({ issues, title, titleCount, description, descriptionCount, h1, wordCount, minWordCount }) {
  if (!title) addIssue(issues, "Missing title");
  if (titleCount > 1) addIssue(issues, "Multiple title tags");
  if (title && title.length < 30) addIssue(issues, "Short title");
  if (title.length > 60) addIssue(issues, "Long title");
  if (!description) addIssue(issues, "Missing meta description");
  if (descriptionCount > 1) addIssue(issues, "Multiple meta descriptions");
  if (description.length > 160) addIssue(issues, "Long meta description");
  if (h1.length === 0) addIssue(issues, "Missing H1");
  if (h1.length > 1) addIssue(issues, "Multiple H1s");
  if (wordCount > 0 && wordCount < minWordCount) addIssue(issues, "Thin content");
}

function validateCanonicalIssues({ issues, canonical, canonicalCount, pageUrl, finalUrl, origin }) {
  if (!canonical) {
    addIssue(issues, "Missing canonical");
    return;
  }

  if (canonicalCount > 1) addIssue(issues, "Multiple canonicals");

  const canonicalOrigin = safeOrigin(canonical);
  if (!canonicalOrigin) addIssue(issues, "Invalid canonical");
  if (canonicalOrigin && canonicalOrigin !== origin) addIssue(issues, "Canonical points outside site");
  if (canonical !== pageUrl && canonical !== finalUrl) addIssue(issues, "Canonicalized URL");
  if (canonical.includes("#")) addIssue(issues, "Canonical contains fragment");
}

function validateHeadingHierarchy(issues, headings) {
  if (headings.length === 0) return;
  if (headings[0].level !== 1) addIssue(issues, "First heading is not H1");

  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1];
    const current = headings[index];
    if (current.level - previous.level > 1) {
      addIssue(issues, "Non-sequential heading hierarchy");
      return;
    }
  }
}

function validateOpenGraphIssues(issues, openGraph) {
  const required = ["og:title", "og:description", "og:url", "og:type", "og:image"];
  const missing = required.filter((property) => !openGraph[property]?.some(Boolean));
  if (missing.length > 0) addIssue(issues, "Missing Open Graph tags");

  for (const [property, values] of Object.entries(openGraph)) {
    if (values.length > 1) {
      addIssue(issues, `Duplicate ${property}`);
    }
  }
}

function buildLinkIssues({ href, normalized, anchorText, rel, isInternal }) {
  const issues = [];
  if (!href) addIssue(issues, "Missing href");
  if (href && !normalized) addIssue(issues, "Invalid href");
  if (href && ["#", "/", ""].includes(href.trim())) addIssue(issues, "Low-value href");
  if (!anchorText) addIssue(issues, "Empty anchor text");
  if (isGenericAnchor(anchorText)) addIssue(issues, "Generic anchor text");
  if (/\bnofollow\b/i.test(rel) && isInternal) addIssue(issues, "Nofollow internal link");
  return issues;
}

function isGenericAnchor(anchorText) {
  const normalized = anchorText.toLowerCase().trim();
  return ["click here", "read more", "learn more", "more", "here", "link"].includes(normalized);
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
