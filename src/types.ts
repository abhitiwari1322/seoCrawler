export type CrawlStatus = "idle" | "running" | "paused" | "stopped" | "complete" | "error";

export interface CrawlSettings {
  rootUrl: string;
  maxUrls: number;
  maxDepth: number;
  concurrency: number;
  delayMs: number;
  userAgent: string;
  respectRobots: boolean;
  minWordCount: number;
}

export interface CrawlStats {
  discovered: number;
  crawled: number;
  queued: number;
  active: number;
  errors: number;
  urlsPerSecond: number;
  durationMs: number;
}

export interface CrawlPage {
  url: string;
  finalUrl: string;
  depth: number;
  status: number | null;
  contentType: string;
  title: string;
  description: string;
  canonical: string;
  h1: string[];
  h2: string[];
  wordCount: number;
  issues: string[];
  discoveredFrom?: string;
}

export interface CrawlEvent {
  type: "ready" | "status" | "stats" | "page" | "log" | "complete" | "error" | "exported";
  payload?: unknown;
}
