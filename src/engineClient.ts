import { isTauri } from "@tauri-apps/api/core";
import { Child, Command } from "@tauri-apps/plugin-shell";
import type { CrawlEvent, CrawlSettings } from "./types";

type Listener = (event: CrawlEvent) => void;

export class EngineClient {
  private command?: Command<string>;
  private child?: Child;
  private listeners = new Set<Listener>();
  private buffer = "";

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect() {
    if (this.child) return;

    if (!isTauri()) {
      const message = "The crawler engine can only start inside the Tauri desktop app. The browser preview can render the UI, but it cannot spawn the Node sidecar.";
      this.emit({ type: "error", payload: message });
      throw new Error(message);
    }

    this.command = Command.sidecar("binaries/crawler-engine", ["--stdio"]);
    this.command.on("error", (error) => this.emit({ type: "error", payload: `Crawler engine failed: ${error}` }));
    this.command.on("close", (event) => {
      if (this.child && event.code !== 0) {
        this.emit({ type: "error", payload: `Crawler engine exited with code ${event.code ?? "signal"} ${event.signal ?? ""}`.trim() });
      }
      this.child = undefined;
      this.command = undefined;
    });
    this.command.stdout.on("data", (chunk) => this.handleOutput(chunk));
    this.command.stderr.on("data", (chunk) => this.emit({ type: "log", payload: String(chunk) }));

    try {
      this.child = await this.command.spawn();
      this.emit({ type: "log", payload: "Crawler engine connected." });
    } catch (error) {
      this.command = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", payload: `Could not start crawler engine: ${message}` });
      throw error;
    }
  }

  start(settings: CrawlSettings) {
    this.send("start", settings);
  }

  pause() {
    this.send("pause");
  }

  resume() {
    this.send("resume");
  }

  stop() {
    this.send("stop");
  }

  exportCsv(report: string) {
    this.send("export", { report, format: "csv" });
  }

  private send(type: string, payload?: unknown) {
    if (!this.child) {
      this.emit({ type: "error", payload: "Crawler engine is not connected." });
      return;
    }
    void this.child.write(JSON.stringify({ type, payload }) + "\n");
  }

  private handleOutput(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.emit(JSON.parse(line) as CrawlEvent);
      } catch {
        this.emit({ type: "log", payload: line });
      }
    }
  }

  private emit(event: CrawlEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
