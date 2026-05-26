export type CrawlStatus = "idle" | "running" | "paused" | "stopped" | "complete" | "error";

export interface CrawlSettings {
  rootUrl: string;
  crawlMode: "site" | "url-list";
  speedPreset: "polite" | "balanced" | "fast" | "aggressive" | "max";
  crawlScope: "html-only" | "internal-all" | "all-resources";
  specificUrls: string[];
  maxUrls: number;
  maxDepth: number;
  concurrency: number;
  delayMs: number;
  timeoutMs: number;
  userAgent: string;
  respectRobots: boolean;
  minWordCount: number;
  psiEnabled: boolean;
  psiApiKey: string;
  psiMaxUrls: number;
  psiMobile: boolean;
  psiDesktop: boolean;
}

export interface CrawlStats {
  discovered: number;
  crawled: number;
  queued: number;
  active: number;
  errors: number;
  links?: number;
  images?: number;
  urlsPerSecond: number;
  durationMs: number;
}

export interface CrawlHeading {
  order: number;
  level: number;
  text: string;
}

export interface StructuredDataBlock {
  id: string;
  type: "json-ld" | "microdata" | "rdfa";
  valid: boolean;
  data: unknown;
  errors: string[];
}

export interface CrawlMetadata {
  title: string;
  titleLength?: number;
  description: string;
  descriptionLength?: number;
  canonical: string;
  robotsMeta: string;
  xRobotsTag: string;
  counts: {
    titles: number;
    descriptions: number;
    canonicals: number;
    h1: number;
  };
  openGraph: Record<string, string[]>;
  twitter: Record<string, string[]>;
  structuredData: {
    jsonLd: StructuredDataBlock[];
  };
}

export interface CrawlIndexability {
  isIndexable: boolean;
  hasNoindex: boolean;
  hasNofollow: boolean;
  robotsMeta: string;
  xRobotsTag: string;
  canonical: string;
  canonicalized: boolean;
  reasons: string[];
}

export interface CrawlLink {
  id: string;
  sourceUrl: string;
  rawHref: string;
  destinationUrl: string;
  normalizedDestinationUrl: string;
  finalDestinationUrl: string;
  destinationStatus: number | null;
  destinationIndexable: boolean | null;
  anchorText: string;
  rel: string;
  isFollowed: boolean;
  isInternal: boolean;
  depth: number;
  linkType: string;
  issues: string[];
}

export interface CrawlImage {
  id: string;
  pageUrl: string;
  rawSrc: string;
  src: string;
  srcset: string;
  alt: string;
  hasAltAttribute: boolean;
  width: string;
  height: string;
  loading: string;
  isLazyLoaded: boolean;
  issues: string[];
}

export interface CrawlSitemapRecord {
  sitemapUrl: string;
  url: string;
  status: number | null;
  indexable: boolean | null;
  coverage: string;
  issues: string[];
}

export interface CrawlPsiRecord {
  url: string;
  strategy: "mobile" | "desktop";
  performanceScore: number | null;
  fcp: string;
  speedIndex: string;
  lcp: string;
  tbt: string;
  cls: string;
  inp: string;
  issues: string[];
}

export interface CrawlPage {
  url: string;
  finalUrl: string;
  depth: number;
  status: number | null;
  contentType: string;
  title: string;
  titleLength?: number;
  description: string;
  descriptionLength?: number;
  canonical: string;
  h1: string[];
  h2: string[];
  headings?: CrawlHeading[];
  metadata?: CrawlMetadata;
  indexability?: CrawlIndexability;
  wordCount: number;
  responseTimeMs?: number;
  redirectUrl?: string;
  redirectType?: string;
  issues: string[];
  discoveredFrom?: string;
  referrerUrls?: string[];
  incomingInternalLinks?: number;
  outgoingInternalLinks?: number;
  externalOutgoingLinks?: number;
  imageCount?: number;
}

export interface CrawlEvent {
  type: "ready" | "status" | "stats" | "page" | "link" | "image" | "sitemap" | "psi" | "log" | "complete" | "error" | "exported";
  payload?: unknown;
}
