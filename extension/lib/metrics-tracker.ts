// ---------------------------------------------------------------------------
// Metrics Tracker — lightweight analytics for tool usage, context injection,
// and knowledge capture activity.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolMetrics {
  count: number;
  errors: number;
  totalMs: number;
}

interface ContextMetrics {
  hits: number;
  misses: number;
  totalChars: number;
}

interface CaptureMetrics {
  saved: number;
  skipped: number;
  attempted: number;
}

export interface MetricsData {
  tools: Record<string, ToolMetrics>;
  context: ContextMetrics;
  capture: CaptureMetrics;
  startedAt: string;
}

const METRICS_PATH = join(homedir(), ".tribe", "metrics.json");
const DEBOUNCE_MS = 5_000;

// ---------------------------------------------------------------------------
// MetricsTracker class
// ---------------------------------------------------------------------------

export class MetricsTracker {
  private data: MetricsData;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initial?: MetricsData) {
    this.data = initial ?? {
      tools: {},
      context: { hits: 0, misses: 0, totalChars: 0 },
      capture: { saved: 0, skipped: 0, attempted: 0 },
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Record a tool call with duration and error status.
   */
  recordToolCall(name: string, durationMs: number, isError: boolean): void {
    if (!this.data.tools[name]) {
      this.data.tools[name] = { count: 0, errors: 0, totalMs: 0 };
    }
    const t = this.data.tools[name];
    t.count++;
    t.totalMs += durationMs;
    if (isError) t.errors++;
    this.scheduleSave();
  }

  /**
   * Record a context injection event.
   * Pass the character count for a hit, or null for a miss.
   */
  recordContextInjection(chars: number | null): void {
    if (chars !== null) {
      this.data.context.hits++;
      this.data.context.totalChars += chars;
    } else {
      this.data.context.misses++;
    }
    this.scheduleSave();
  }

  /**
   * Record a knowledge capture result.
   */
  recordCapture(result: "saved" | "skipped" | "attempted"): void {
    this.data.capture[result]++;
    this.scheduleSave();
  }

  /**
   * Get a formatted summary string.
   */
  getSummary(): string {
    const lines: string[] = [];
    lines.push("TRIBE Metrics Summary");
    lines.push("=====================");
    lines.push(`Tracking since: ${this.data.startedAt}`);
    lines.push("");

    // Tool usage
    const toolEntries = Object.entries(this.data.tools);
    if (toolEntries.length > 0) {
      lines.push("Tool Usage:");
      const sorted = toolEntries.sort((a, b) => b[1].count - a[1].count);
      for (const [name, metrics] of sorted) {
        const avgMs = metrics.count > 0 ? Math.round(metrics.totalMs / metrics.count) : 0;
        const errorStr = metrics.errors > 0 ? ` (${metrics.errors} errors)` : "";
        lines.push(`  ${name}: ${metrics.count} calls, avg ${avgMs}ms${errorStr}`);
      }
    } else {
      lines.push("Tool Usage: No tools called yet.");
    }

    lines.push("");

    // Context injection
    const ctx = this.data.context;
    const totalCtx = ctx.hits + ctx.misses;
    if (totalCtx > 0) {
      const hitRate = Math.round((ctx.hits / totalCtx) * 100);
      const avgChars = ctx.hits > 0 ? Math.round(ctx.totalChars / ctx.hits) : 0;
      lines.push(`Context Injection: ${ctx.hits} hits, ${ctx.misses} misses (${hitRate}% hit rate, avg ${avgChars} chars)`);
    } else {
      lines.push("Context Injection: No injections yet.");
    }

    // Capture
    const cap = this.data.capture;
    const totalCap = cap.saved + cap.skipped + cap.attempted;
    if (totalCap > 0) {
      lines.push(`Knowledge Capture: ${cap.saved} saved, ${cap.skipped} skipped, ${cap.attempted} attempted`);
    } else {
      lines.push("Knowledge Capture: No captures yet.");
    }

    return lines.join("\n");
  }

  /**
   * Get raw metrics data for JSON output.
   */
  getData(): MetricsData {
    return structuredClone(this.data);
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.data = {
      tools: {},
      context: { hits: 0, misses: 0, totalChars: 0 },
      capture: { saved: 0, skipped: 0, attempted: 0 },
      startedAt: new Date().toISOString(),
    };
    this.scheduleSave();
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      await this.saveToDisk();
    }, DEBOUNCE_MS);
  }

  private async saveToDisk(): Promise<void> {
    try {
      await mkdir(join(homedir(), ".tribe"), { recursive: true });
      await writeFile(METRICS_PATH, JSON.stringify(this.data, null, 2), "utf-8");
    } catch {
      // ignore write failures
    }
  }

  /**
   * Load metrics from disk. Called lazily on first use.
   */
  async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(METRICS_PATH, "utf-8");
      const parsed = JSON.parse(raw) as MetricsData;
      if (parsed.tools && parsed.context && parsed.capture) {
        this.data = parsed;
      }
    } catch {
      // No existing file or invalid — start fresh
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton with lazy disk load
// ---------------------------------------------------------------------------

let metricsInstance: MetricsTracker | null = null;
let loadPromise: Promise<void> | null = null;

export function getMetrics(): MetricsTracker {
  if (!metricsInstance) {
    metricsInstance = new MetricsTracker();
    loadPromise = metricsInstance.loadFromDisk();
  }
  return metricsInstance;
}

// Exported for unit testing only.
export const _testing = { MetricsTracker, METRICS_PATH };
