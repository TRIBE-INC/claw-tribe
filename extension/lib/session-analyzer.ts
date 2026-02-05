// ---------------------------------------------------------------------------
// Session Analyzer — aggregates and summarizes coding session data for
// trend analysis and pattern detection.
// ---------------------------------------------------------------------------

import { run } from "./tribe-runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisOptions {
  timeRange?: string;  // "24h", "7d", "30d", "90d", "all"
  limit?: number;
  project?: string;
  tool?: string;
}

export interface SessionAnalysis {
  totalSessions: number;
  uniqueProjects: string[];
  toolBreakdown: Record<string, number>;
  totalMinutes: number;
  avgMinutes: number;
  busiestDay: string | null;
  topProject: string | null;
  observations: string[];
}

export interface SessionSummary {
  sessionCount: number;
  themes: string[];
  recentIds: string[];
}

// ---------------------------------------------------------------------------
// Timeout helper (mirrors context-builder pattern)
// ---------------------------------------------------------------------------

const QUERY_TIMEOUT_MS = 10_000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---------------------------------------------------------------------------
// JSON extraction (duplicated from context-builder to keep module standalone)
// ---------------------------------------------------------------------------

function extractJSON(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const arrayStart = trimmed.indexOf("[");
  const objectStart = trimmed.indexOf("{");
  const start =
    arrayStart >= 0 && objectStart >= 0
      ? Math.min(arrayStart, objectStart)
      : Math.max(arrayStart, objectStart);
  if (start < 0) throw new SyntaxError("No JSON found in output");
  return JSON.parse(trimmed.slice(start));
}

// ---------------------------------------------------------------------------
// Analysis functions
// ---------------------------------------------------------------------------

/**
 * Analyze sessions — aggregate statistics and detect patterns.
 * Never throws; returns empty/default analysis on failure.
 */
export async function analyzeSessions(options: AnalysisOptions = {}): Promise<SessionAnalysis> {
  const empty: SessionAnalysis = {
    totalSessions: 0,
    uniqueProjects: [],
    toolBreakdown: {},
    totalMinutes: 0,
    avgMinutes: 0,
    busiestDay: null,
    topProject: null,
    observations: [],
  };

  try {
    const args = ["query", "sessions", "--all", "--format", "json"];
    if (options.limit) args.push("--limit", String(options.limit));
    if (options.timeRange) args.push("--time-range", options.timeRange);
    if (options.tool) args.push("--tool", options.tool);
    if (options.project) args.push("--project", options.project);

    const result = await withTimeout(
      run(args, { timeout: "slow" }),
      QUERY_TIMEOUT_MS,
      { stdout: "[]", stderr: "", exitCode: 1 },
    );

    if (result.exitCode !== 0) return empty;

    const raw = extractJSON(result.stdout);
    const sessions = Array.isArray(raw) ? raw : [];
    if (sessions.length === 0) return empty;

    // Aggregate
    const projects = new Set<string>();
    const tools: Record<string, number> = {};
    const dayCounts: Record<string, number> = {};
    const projectCounts: Record<string, number> = {};
    let totalMinutes = 0;

    for (const s of sessions as Record<string, unknown>[]) {
      const project = String(s.project ?? s.project_path ?? "unknown");
      const tool = String(s.tool ?? s.provider ?? "unknown");
      const minutes = Number(s.duration_minutes ?? 0);
      const startedAt = String(s.started_at ?? s.startedAt ?? s.first_event ?? "");

      projects.add(project);
      tools[tool] = (tools[tool] ?? 0) + 1;
      totalMinutes += minutes;

      if (project !== "unknown") {
        projectCounts[project] = (projectCounts[project] ?? 0) + 1;
      }

      if (startedAt) {
        try {
          const day = new Date(startedAt).toISOString().split("T")[0];
          dayCounts[day] = (dayCounts[day] ?? 0) + 1;
        } catch {
          // skip
        }
      }
    }

    // Find busiest day
    let busiestDay: string | null = null;
    let maxDayCount = 0;
    for (const [day, count] of Object.entries(dayCounts)) {
      if (count > maxDayCount) {
        maxDayCount = count;
        busiestDay = day;
      }
    }

    // Find top project
    let topProject: string | null = null;
    let maxProjectCount = 0;
    for (const [proj, count] of Object.entries(projectCounts)) {
      if (count > maxProjectCount) {
        maxProjectCount = count;
        topProject = proj;
      }
    }

    // Observations
    const observations: string[] = [];
    if (sessions.length > 10) {
      observations.push(`High activity: ${sessions.length} sessions in the period.`);
    }
    if (Object.keys(tools).length > 1) {
      observations.push(`Multi-tool usage: ${Object.keys(tools).join(", ")}.`);
    }
    if (totalMinutes > 0 && sessions.length > 0) {
      const avg = Math.round(totalMinutes / sessions.length);
      if (avg > 30) {
        observations.push(`Long sessions: average ${avg} minutes per session.`);
      }
    }

    return {
      totalSessions: sessions.length,
      uniqueProjects: Array.from(projects),
      toolBreakdown: tools,
      totalMinutes: Math.round(totalMinutes),
      avgMinutes: sessions.length > 0 ? Math.round(totalMinutes / sessions.length) : 0,
      busiestDay,
      topProject,
      observations,
    };
  } catch {
    return empty;
  }
}

/**
 * Summarize recent sessions — get IDs, run recall on each, extract themes.
 * Never throws; returns empty summary on failure.
 */
export async function summarizeRecentSessions(
  options: { count?: number; timeRange?: string } = {},
): Promise<SessionSummary> {
  const empty: SessionSummary = { sessionCount: 0, themes: [], recentIds: [] };

  try {
    const count = options.count ?? 5;
    const args = ["query", "sessions", "--all", "--limit", String(count), "--format", "json"];
    if (options.timeRange) args.push("--time-range", options.timeRange);

    const result = await withTimeout(
      run(args, { timeout: "default" }),
      QUERY_TIMEOUT_MS,
      { stdout: "[]", stderr: "", exitCode: 1 },
    );

    if (result.exitCode !== 0) return empty;

    const raw = extractJSON(result.stdout);
    const sessions = Array.isArray(raw) ? raw : [];
    if (sessions.length === 0) return empty;

    const ids = sessions.map((s: Record<string, unknown>) =>
      String(s.id ?? s.conversation_id ?? s.session_id ?? ""),
    ).filter((id) => id.length > 0);

    // Recall each session in parallel
    const recalls = await Promise.all(
      ids.slice(0, count).map(async (id) => {
        try {
          const r = await withTimeout(
            run(["-beta", "recall", id], { timeout: "slow" }),
            QUERY_TIMEOUT_MS,
            { stdout: "", stderr: "", exitCode: 1 },
          );
          return r.exitCode === 0 ? r.stdout : "";
        } catch {
          return "";
        }
      }),
    );

    // Extract themes via word frequency
    const wordCounts: Record<string, number> = {};
    const STOP = new Set([
      "the", "and", "was", "for", "that", "with", "this", "from", "are",
      "were", "been", "have", "has", "had", "not", "but", "what", "all",
      "can", "will", "one", "each", "which", "their", "said", "use",
      "she", "her", "him", "his", "how", "its", "may", "you", "into",
      "about", "out", "also", "then", "them", "some", "when", "where",
    ]);

    for (const text of recalls) {
      if (!text) continue;
      const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
      for (const w of words) {
        if (w.length >= 4 && !STOP.has(w)) {
          wordCounts[w] = (wordCounts[w] ?? 0) + 1;
        }
      }
    }

    const themes = Object.entries(wordCounts)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);

    return {
      sessionCount: sessions.length,
      themes,
      recentIds: ids,
    };
  } catch {
    return empty;
  }
}

// Exported for unit testing only.
export const _testing = { analyzeSessions, summarizeRecentSessions, extractJSON };
