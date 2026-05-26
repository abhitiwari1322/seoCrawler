#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

const DEFAULT_CRAWLER_CONFIG = {
  urlTypes: {
    htmlLinks: true,
    images: true,
    stylesheets: true,
    scripts: true,
    iframes: true,
    media: true,
    documents: true,
    cssImports: true,
    cssUrls: false,
    metaRefresh: true,
    redirectFinalUrls: true
  },
  excludeExtensions: [],
  includeUrlPatterns: [],
  excludeUrlPatterns: []
};

const emit = (type, payload) => {
  process.stdout.write(JSON.stringify({ type, payload }) + "\n");
};

class Crawler {
  constructor() {
    this.reset();
  }

  reset() {
    this.settings = null;
    this.config = loadCrawlerConfig();
    this.root = null;
    this.origin = "";
    this.queue = [];
    this.seen = new Set();
    this.allowedSpecificUrls = new Set();
    this.pages = [];
    this.store = createEmptyStore();
    this.active = 0;
    this.status = "idle";
    this.startedAt = 0;
    this.timer = null;
    this.robots = null;
    this.sitemapUrls = new Set();
    this.titleOccurrences = new Map();
    this.descriptionOccurrences = new Map();
    this.h1Occurrences = new Map();
  }

  async start(settings) {
    this.reset();
    this.settings = settings;
    const seedUrls = this.prepareSeedUrls(settings);
    if (seedUrls.length === 0) {
      emit("error", "No valid URLs found to crawl.");
      return;
    }

    this.root = new URL(seedUrls[0]);
    this.origin = this.root.origin;
    this.status = "running";
    this.startedAt = Date.now();
    for (const seedUrl of seedUrls) this.enqueue(seedUrl, 0, undefined, this.root?.href, "htmlLinks");
    emit("status", this.status);
    emit("log", settings.crawlMode === "url-list" ? `Started URL-list crawl for ${seedUrls.length} URL(s).` : `Started crawl for ${this.root.href}`);

    if (settings.respectRobots) await this.loadRobots();
    await this.loadSitemaps();

    this.timer = setInterval(() => this.emitStats(), 500);
    this.pump();
  }

  prepareSeedUrls(settings) {
    if (settings.crawlMode !== "url-list") return [new URL(settings.rootUrl).href];

    const urls = [];
    for (const rawUrl of settings.specificUrls ?? []) {
      try {
        const url = new URL(rawUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        url.hash = "";
        if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
        urls.push(url.href);
        this.allowedSpecificUrls.add(url.href);
      } catch {
        // Ignore malformed file rows. The UI already reports when no URLs parse.
      }
    }

    return [...new Set(urls)].slice(0, Math.max(1, settings.maxUrls || urls.length));
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
      for (const sitemapUrl of extractRobotsSitemaps(body)) this.sitemapUrls.add(sitemapUrl);
      emit("log", response.ok ? "Loaded robots.txt rules." : "No robots.txt found.");
    } catch {
      emit("log", "robots.txt check failed; continuing crawl.");
    }
  }

  async loadSitemaps() {
    this.sitemapUrls.add(new URL("/sitemap.xml", this.origin).href);

    for (const sitemapUrl of Array.from(this.sitemapUrls)) {
      await this.loadSitemap(sitemapUrl, 0);
    }
  }

  async loadSitemap(sitemapUrl, depth) {
    if (depth > 3 || this.store.loadedSitemaps.has(sitemapUrl)) return;
    this.store.loadedSitemaps.add(sitemapUrl);

    try {
      const response = await fetch(sitemapUrl, { headers: { "user-agent": this.settings.userAgent } });
      if (!response.ok) {
        emit("log", `Sitemap not available: ${sitemapUrl}`);
        return;
      }

      const xml = await response.text();
      const $ = cheerio.load(xml, { xmlMode: true });
      const childSitemaps = $("sitemap > loc").map((_, element) => clean($(element).text())).get().filter(Boolean);
      const urls = $("url > loc").map((_, element) => clean($(element).text())).get().filter(Boolean);

      for (const child of childSitemaps) {
        const normalizedChild = normalizeOptionalUrl(child, sitemapUrl);
        if (normalizedChild) await this.loadSitemap(normalizedChild, depth + 1);
      }

      for (const rawUrl of urls) {
        const url = this.normalize(rawUrl, sitemapUrl);
        if (!url || !url.startsWith(this.origin)) continue;
        const record = {
          sitemapUrl,
          url,
          status: null,
          indexable: null,
          coverage: "Not crawled",
          issues: []
        };
        this.store.sitemaps.push(record);
        emit("sitemap", record);
      }

      emit("log", `Loaded sitemap ${sitemapUrl} with ${urls.length} URLs.`);
    } catch {
      emit("log", `Failed to load sitemap: ${sitemapUrl}`);
    }
  }

  enqueue(rawUrl, depth, discoveredFrom, baseUrl = this.root?.href, urlType = "htmlLinks") {
    if (this.seen.size >= this.settings.maxUrls) return;
    const normalized = this.normalize(rawUrl, baseUrl);
    if (!normalized || this.seen.has(normalized)) return;
    if (!normalized.startsWith(this.origin)) return;
    if (!this.shouldIncludeUrl(normalized, urlType)) return;
    if (this.settings.crawlMode === "url-list" && !this.allowedSpecificUrls.has(normalized)) return;
    if (depth > this.settings.maxDepth) return;
    if (this.robots && !this.robots.isAllowed(normalized, this.settings.userAgent)) {
      emit("log", `Blocked by robots.txt: ${normalized}`);
      return;
    }

    this.seen.add(normalized);
    this.queue.push({ url: normalized, depth, discoveredFrom, urlType });
  }

  shouldIncludeUrl(url, urlType) {
    if (!this.config.urlTypes?.[urlType]) return false;

    const extension = extensionFromUrl(url);
    if (extension && this.config.excludeExtensions?.map((value) => value.toLowerCase()).includes(extension)) return false;

    if (this.config.includeUrlPatterns?.length > 0 && !matchesAnyPattern(url, this.config.includeUrlPatterns)) return false;
    if (matchesAnyPattern(url, this.config.excludeUrlPatterns ?? [])) return false;

    return true;
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
          void this.finish();
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
      const isHtml = contentType.includes("text/html");
      const isCss = isCssContentType(contentType);
      const body = isHtml || isCss ? await response.text() : "";
      const page = this.extractPage(item, response, isHtml ? body : "", contentType);
      this.storePage(page);
      this.pages.push(page);
      emit("page", page);
      this.enqueueRedirectFinalUrl(item, response);
      if (isHtml && body) this.discoverLinks(item, body);
      if (response.ok && isHtml && body) this.discoverResources(item, body);
      if (isCss && body) this.discoverCssResources(item, body);
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
      if (isInternal && this.settings.crawlMode !== "url-list") this.enqueue(href, item.depth + 1, item.url, item.url, "htmlLinks");
    });
  }

  discoverResources(item, html) {
    const $ = cheerio.load(html);

    this.enqueueElementUrls($, item, "img", ["src", "data-src", "data-lazy-src", "data-original"], "images");
    this.enqueueSrcsetUrls($, item, "img[srcset], source[srcset]", "images");
    this.enqueueElementUrls($, item, 'link[rel~="stylesheet"], link[as="style"]', ["href"], "stylesheets");
    this.enqueueElementUrls($, item, 'link[rel~="icon"], link[rel="shortcut icon"]', ["href"], "images");
    this.enqueueElementUrls($, item, "script[src]", ["src"], "scripts");
    this.enqueueElementUrls($, item, "iframe[src], frame[src]", ["src"], "iframes");
    this.enqueueElementUrls($, item, "source[src], video[src], audio[src], video[poster]", ["src", "poster"], "media");
    this.enqueueElementUrls($, item, "embed[src], object[data]", ["src", "data"], "documents");

    $("meta[http-equiv]").each((_, element) => {
      const httpEquiv = clean($(element).attr("http-equiv") ?? "").toLowerCase();
      if (httpEquiv !== "refresh") return;
      const refreshUrl = extractMetaRefreshUrl($(element).attr("content") ?? "");
      if (refreshUrl) this.enqueue(refreshUrl, item.depth + 1, item.url, item.url, "metaRefresh");
    });

    $("[style]").each((_, element) => {
      for (const url of extractCssUrls($(element).attr("style") ?? "")) {
        this.enqueue(url, item.depth + 1, item.url, item.url, "cssUrls");
      }
    });

    $("style").each((_, element) => {
      this.discoverCssResources(item, $(element).text());
    });
  }

  enqueueElementUrls($, item, selector, attributes, urlType) {
    $(selector).each((_, element) => {
      for (const attribute of attributes) {
        const value = clean($(element).attr(attribute) ?? "");
        if (value) this.enqueue(value, item.depth + 1, item.url, item.url, urlType);
      }
    });
  }

  enqueueSrcsetUrls($, item, selector, urlType) {
    $(selector).each((_, element) => {
      const url = firstSrcsetCandidate($(element).attr("srcset") ?? "");
      if (url) this.enqueue(url, item.depth + 1, item.url, item.url, urlType);
    });
  }

  discoverCssResources(item, css) {
    for (const url of extractCssImports(css)) {
      this.enqueue(url, item.depth + 1, item.url, item.url, "cssImports");
    }

    for (const url of extractCssUrls(css)) {
      this.enqueue(url, item.depth + 1, item.url, item.url, "cssUrls");
    }
  }

  enqueueRedirectFinalUrl(item, response) {
    const finalUrl = this.normalize(response.url, item.url);
    if (!finalUrl || finalUrl === item.url || !finalUrl.startsWith(this.origin)) return;
    this.enqueue(finalUrl, item.depth + 1, item.url, item.url, "redirectFinalUrls");
  }

  extractImages(item, $) {
    const images = [];
    $("img").each((index, element) => {
      const src = pickImageSource($, element);
      const srcset = clean($(element).attr("srcset") ?? "");
      const loading = clean($(element).attr("loading") ?? "");
      const alt = $(element).attr("alt");
      const width = clean($(element).attr("width") ?? "");
      const height = clean($(element).attr("height") ?? "");
      const issues = buildImageIssues({ src, alt, width, height });

      const image = {
        id: `${item.url}#img-${index}`,
        pageUrl: item.url,
        rawSrc: src,
        src: src ? this.normalize(src, item.url) : "",
        srcset,
        alt: clean(alt ?? ""),
        hasAltAttribute: alt !== undefined,
        width,
        height,
        loading,
        isLazyLoaded: loading.toLowerCase() === "lazy",
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

  async finish() {
    if (this.timer) clearInterval(this.timer);
    this.enrichLinks();
    this.enrichPageLinkCounts();
    this.enrichSitemaps();
    this.applyDuplicateIssues();
    await this.runPageSpeed();
    this.status = "complete";
    for (const page of this.pages) emit("page", page);
    for (const link of this.store.links) emit("link", link);
    for (const sitemap of this.store.sitemaps) emit("sitemap", sitemap);
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
    const header = ["exportVersion", "url", "finalUrl", "status", "depth", "title", "description", "canonical", "indexable", "wordCount", "incomingInternalLinks", "outgoingInternalLinks", "referrerUrls", "issues"];
    const rows = this.pages.map((page) => [
      "1",
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

  async runPageSpeed() {
    if (!this.settings.psiEnabled) return;

    const strategies = [];
    if (this.settings.psiMobile) strategies.push("mobile");
    if (this.settings.psiDesktop) strategies.push("desktop");
    if (strategies.length === 0) {
      emit("log", "PageSpeed skipped: no strategy selected.");
      return;
    }

    const urls = this.pages
      .filter((page) => page.status && page.status >= 200 && page.status < 300 && page.indexability?.isIndexable)
      .slice(0, Math.max(1, this.settings.psiMaxUrls || 1))
      .map((page) => page.url);

    if (urls.length === 0) {
      emit("log", "PageSpeed skipped: no indexable 2xx URLs found.");
      return;
    }

    emit("log", `Running PageSpeed for ${urls.length} URL(s).`);

    for (const url of urls) {
      for (const strategy of strategies) {
        const record = await runPageSpeedRequest({ url, strategy, apiKey: clean(this.settings.psiApiKey) });
        this.store.psiResults.set(`${url}-${strategy}`, record);
        emit("psi", record);
      }
    }
  }

  enrichSitemaps() {
    for (const record of this.store.sitemaps) {
      const page = this.store.pages.get(record.url);
      record.coverage = page ? "Crawled" : "Not crawled";
      record.status = page?.status ?? null;
      record.indexable = page?.indexability?.isIndexable ?? null;
      record.issues = [];

      if (!page) addIssue(record.issues, "Sitemap URL not crawled");
      if (page && (!page.status || page.status >= 400)) addIssue(record.issues, "Sitemap URL has HTTP error");
      if (page?.indexability && !page.indexability.isIndexable) addIssue(record.issues, "Non-indexable URL in sitemap");
    }
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
    loadedSitemaps: new Set(),
    psiResults: new Map()
  };
}

function loadCrawlerConfig() {
  try {
    const config = JSON.parse(readFileSync("crawler.config.json", "utf8"));
    return {
      ...DEFAULT_CRAWLER_CONFIG,
      ...config,
      urlTypes: {
        ...DEFAULT_CRAWLER_CONFIG.urlTypes,
        ...(config.urlTypes ?? {})
      },
      excludeExtensions: config.excludeExtensions ?? DEFAULT_CRAWLER_CONFIG.excludeExtensions,
      includeUrlPatterns: config.includeUrlPatterns ?? DEFAULT_CRAWLER_CONFIG.includeUrlPatterns,
      excludeUrlPatterns: config.excludeUrlPatterns ?? DEFAULT_CRAWLER_CONFIG.excludeUrlPatterns
    };
  } catch {
    return DEFAULT_CRAWLER_CONFIG;
  }
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function extensionFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? `.${match[1]}` : "";
  } catch {
    return "";
  }
}

function matchesAnyPattern(value, patterns) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return value.includes(pattern);
    }
  });
}

function isCssContentType(contentType) {
  return /text\/css/i.test(contentType);
}

function extractMetaRefreshUrl(value) {
  return value.match(/url\s*=\s*([^;]+)/i)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

function extractCssImports(css) {
  const urls = [];
  const importRegex = /@import\s+(?:url\()?["']?([^"')\s;]+)["']?\)?/gi;
  let match;
  while ((match = importRegex.exec(css)) !== null) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

function extractCssUrls(css) {
  const urls = [];
  const urlRegex = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let match;
  while ((match = urlRegex.exec(css)) !== null) {
    const url = match[1]?.trim();
    if (url && !url.startsWith("data:")) urls.push(url);
  }
  return urls;
}

function srcsetCandidates(srcset) {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractRobotsSitemaps(body) {
  return String(body)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*sitemap:\s*(.+)\s*$/i)?.[1])
    .filter(Boolean)
    .map(clean);
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

function pickImageSource($, element) {
  return clean(
    $(element).attr("src") ??
      $(element).attr("data-src") ??
      $(element).attr("data-lazy-src") ??
      $(element).attr("data-original") ??
      firstSrcsetCandidate($(element).attr("srcset") ?? "") ??
      ""
  );
}

function firstSrcsetCandidate(srcset) {
  const firstCandidate = srcset.split(",").map((candidate) => candidate.trim()).find(Boolean);
  return firstCandidate?.split(/\s+/)[0] ?? "";
}

function buildImageIssues({ src, alt, width, height }) {
  const issues = [];
  const cleanedAlt = clean(alt ?? "");

  if (!src) addIssue(issues, "Empty image src");
  if (alt === undefined) addIssue(issues, "Missing alt attribute");
  if (alt !== undefined && !cleanedAlt) addIssue(issues, "Empty alt text");
  if (isGenericImageAlt(cleanedAlt)) addIssue(issues, "Generic alt text");
  if (isKeywordStuffedAlt(cleanedAlt)) addIssue(issues, "Possible keyword-stuffed alt text");
  if (!width) addIssue(issues, "Missing width");
  if (!height) addIssue(issues, "Missing height");
  return issues;
}

function isGenericImageAlt(alt) {
  const normalized = alt.toLowerCase().trim();
  return ["image", "photo", "picture", "logo", "banner", "thumbnail"].includes(normalized);
}

function isKeywordStuffedAlt(alt) {
  if (!alt) return false;
  const words = alt.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return Math.max(...counts.values()) >= 4;
}

async function runPageSpeedRequest({ url, strategy, apiKey }) {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", strategy);
  endpoint.searchParams.set("category", "performance");
  if (apiKey) endpoint.searchParams.set("key", apiKey);

  try {
    const response = await fetch(endpoint, { headers: { "user-agent": "ScoutSEO/0.1" } });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return emptyPsiRecord(url, strategy, [formatPageSpeedError(response.status, data)]);
    }

    const audits = data.lighthouseResult?.audits ?? {};
    const categories = data.lighthouseResult?.categories ?? {};
    const score = categories.performance?.score;
    return {
      url,
      strategy,
      performanceScore: typeof score === "number" ? Math.round(score * 100) : null,
      fcp: audits["first-contentful-paint"]?.displayValue ?? "",
      speedIndex: audits["speed-index"]?.displayValue ?? "",
      lcp: audits["largest-contentful-paint"]?.displayValue ?? "",
      tbt: audits["total-blocking-time"]?.displayValue ?? "",
      cls: audits["cumulative-layout-shift"]?.displayValue ?? "",
      inp: audits["interaction-to-next-paint"]?.displayValue ?? audits["experimental-interaction-to-next-paint"]?.displayValue ?? "",
      issues: []
    };
  } catch (error) {
    return emptyPsiRecord(url, strategy, [error?.message ?? "PageSpeed request failed"]);
  }
}

function emptyPsiRecord(url, strategy, issues) {
  return {
    url,
    strategy,
    performanceScore: null,
    fcp: "",
    speedIndex: "",
    lcp: "",
    tbt: "",
    cls: "",
    inp: "",
    issues
  };
}

function formatPageSpeedError(status, data) {
  const apiError = data?.error;
  const reason = apiError?.status || apiError?.errors?.[0]?.reason;
  const message = clean(apiError?.message ?? "");
  const prefix = `PageSpeed API error ${status}`;
  if (reason && message) return `${prefix}: ${reason} - ${message}`;
  if (message) return `${prefix}: ${message}`;
  return prefix;
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
