import { ensureInstalled, run } from "./tribe-runner.js";
import { getCache } from "./intelligent-cache.js";

// ---------------------------------------------------------------------------
// JSON extraction — TRIBE CLI sometimes writes tips/warnings to stdout
// alongside JSON output, especially under parallel execution. This helper
// finds the actual JSON array/object in the output.
// ---------------------------------------------------------------------------

function extractJSON(stdout: string): unknown {
  const trimmed = stdout.trim();

  // Fast path: clean JSON
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  // Find the first [ or { — everything before it is a CLI tip/warning
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
// Types
// ---------------------------------------------------------------------------

export type ContextDepth = "minimal" | "standard" | "deep";

interface SessionMeta {
  id: string;
  tool: string;
  project: string;
  branch?: string;
  startedAt: string;
  duration?: string;
  summary?: string;
}

interface KBMatch {
  id: string;
  category?: string;
  text: string;
}

interface CachedContext {
  sessions: SessionMeta[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Session metadata cache (avoids re-querying within a short window)
// ---------------------------------------------------------------------------

let sessionCache: CachedContext | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

function isCacheFresh(): boolean {
  return sessionCache !== null && Date.now() - sessionCache.fetchedAt < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// TRIBE queries — each races against a hard timeout
// ---------------------------------------------------------------------------

const QUERY_TIMEOUT_MS = 2_000; // 2s hard ceiling per CLI call

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

async function fetchRecentSessions(depth: ContextDepth): Promise<SessionMeta[]> {
  if (isCacheFresh()) return sessionCache!.sessions;

  const limit = depth === "minimal" ? "5" : depth === "standard" ? "10" : "20";
  const timeRange = depth === "deep" ? "7d" : "24h";

  // Use `query sessions` which falls back to local cache when not authenticated.
  // `sessions list` requires auth and hard-fails without it.
  const result = await withTimeout(
    run(["query", "sessions", "--all", "--limit", limit, "--time-range", timeRange, "--format", "json"], {
      timeout: "fast",
    }),
    QUERY_TIMEOUT_MS,
    { stdout: "[]", stderr: "", exitCode: 1 },
  );

  if (result.exitCode !== 0) return [];

  try {
    const raw = extractJSON(result.stdout);
    const items = Array.isArray(raw) ? raw : [];
    // JSON fields vary by source:
    //   Local cache: { id, project, event_file }
    //   Authenticated API: { conversation_id, tool, project_path, first_event, last_event, duration_minutes }
    const sessions: SessionMeta[] = items.map(
      (s: Record<string, unknown>) => ({
        id: String(s.id ?? s.conversation_id ?? s.session_id ?? ""),
        tool: String(s.tool ?? s.provider ?? "unknown"),
        project: String(s.project ?? s.project_path ?? ""),
        branch: s.branch ? String(s.branch) : undefined,
        startedAt: String(s.started_at ?? s.startedAt ?? s.first_event ?? s.timestamp ?? ""),
        duration: s.duration_minutes != null
          ? `${s.duration_minutes}m`
          : s.duration ? String(s.duration) : undefined,
        summary: s.summary ? String(s.summary) : undefined,
      }),
    );
    sessionCache = { sessions, fetchedAt: Date.now() };
    return sessions;
  } catch {
    return [];
  }
}

// Stop-words to skip when extracting search keywords from the prompt.
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their",
  "this", "that", "these", "those", "what", "which", "who", "whom",
  "and", "but", "or", "nor", "not", "no", "so", "if", "then", "else",
  "for", "of", "in", "on", "at", "to", "by", "with", "from", "up", "out",
  "about", "into", "through", "during", "before", "after", "above", "below",
  "how", "when", "where", "why", "all", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "only", "same",
  "than", "too", "very", "just", "because", "as", "until", "while",
  "use", "using", "implement", "add", "create", "make", "get", "set",
]);

/**
 * Extract multiple search keywords from a prompt, scored by length + position.
 * Returns up to `count` keywords, longest first, deduplicated.
 */
function extractSearchKeywords(prompt: string, count: number = 3): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  if (words.length === 0) {
    const fallback = prompt.trim().split(/\s+/)[0] || prompt;
    return [fallback];
  }

  // Score by length (primary) + position bonus (earlier = small boost)
  const scored = words.map((w, i) => ({
    word: w,
    score: w.length * 10 + (words.length - i),
  }));

  // Deduplicate, keeping highest score
  const seen = new Map<string, number>();
  for (const { word, score } of scored) {
    const existing = seen.get(word);
    if (existing === undefined || score > existing) {
      seen.set(word, score);
    }
  }

  // Sort by score descending
  const unique = Array.from(seen.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);

  return unique.slice(0, count);
}

/**
 * Extract the best single search keyword from a prompt.
 * TRIBE's KB search uses LIKE matching which doesn't handle multi-word
 * queries well. We pick the longest non-stop-word as the most distinctive term.
 */
function extractSearchKeyword(prompt: string): string {
  return extractSearchKeywords(prompt, 1)[0];
}

async function runKBSearch(term: string): Promise<KBMatch[]> {
  const result = await withTimeout(
    run(["-beta", "kb", "search", term, "--format", "json"], {
      timeout: "fast",
    }),
    QUERY_TIMEOUT_MS,
    { stdout: "[]", stderr: "", exitCode: 1 },
  );

  if (result.exitCode !== 0) return [];

  try {
    const raw = extractJSON(result.stdout);
    // KB search returns: [{document: {id, content, category, ...}, score, snippet, match_type}]
    return (Array.isArray(raw) ? raw : []).slice(0, 5).map(
      (entry: Record<string, unknown>) => {
        const doc = (entry.document ?? {}) as Record<string, unknown>;
        return {
          id: String(doc.id ?? entry.id ?? ""),
          category: (doc.category ?? entry.category)
            ? String(doc.category ?? entry.category)
            : undefined,
          text: String(doc.content ?? entry.snippet ?? entry.content ?? entry.text ?? ""),
        };
      },
    );
  } catch {
    return [];
  }
}

async function searchKB(query: string): Promise<KBMatch[]> {
  // Check cache first
  const cache = getCache();
  const cached = await cache.get<KBMatch[]>("kb", query);
  if (cached) return cached;

  const keywords = extractSearchKeywords(query, 3);

  // Run all keyword searches in parallel
  const allResults = await Promise.all(keywords.map((kw) => runKBSearch(kw)));

  // Merge results by doc ID, rank by match frequency
  const docMap = new Map<string, { match: KBMatch; freq: number }>();
  for (const results of allResults) {
    for (const match of results) {
      const existing = docMap.get(match.id);
      if (existing) {
        existing.freq++;
      } else {
        docMap.set(match.id, { match, freq: 1 });
      }
    }
  }

  // Sort by frequency (most keyword hits first), return top 5
  const merged = Array.from(docMap.values())
    .sort((a, b) => b.freq - a.freq)
    .slice(0, 5)
    .map((entry) => entry.match);

  // Store in cache
  if (merged.length > 0) {
    cache.set("kb", query, merged);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  if (!iso) return "recently";
  try {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return "recently";
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 0) return "recently";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return "recently";
  }
}

function formatSessions(sessions: SessionMeta[], depth: ContextDepth): string {
  if (sessions.length === 0) return "";

  const lines = sessions.map((s) => {
    const time = formatTimestamp(s.startedAt);
    const dur = s.duration ? ` (${s.duration})` : "";
    const branch = s.branch ? `, branch: ${s.branch}` : "";
    const summary = depth === "deep" && s.summary ? `\n    ${s.summary}` : "";
    return `- ${time}: ${s.tool} on ${s.project || "unknown project"}${dur}${branch}${summary}`;
  });

  return `Recent Activity:\n${lines.join("\n")}`;
}

function formatKBResults(results: KBMatch[]): string {
  if (results.length === 0) return "";

  const lines = results.map((r) => {
    const cat = r.category ? `[${r.category}] ` : "";
    const text = r.text.length > 200 ? r.text.slice(0, 200) + "..." : r.text;
    return `- ${cat}${text}`;
  });

  return `Relevant Knowledge:\n${lines.join("\n")}`;
}

function detectActiveProject(sessions: SessionMeta[]): string {
  if (sessions.length === 0) return "";
  const recent = sessions[0];
  const branch = recent.branch ? ` (branch: ${recent.branch})` : "";
  return recent.project ? `Active Project: ${recent.project}${branch}` : "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a TRIBE context block for injection into the agent's system prompt.
 * Returns `null` if TRIBE is unavailable or no useful context was found.
 *
 * Target: <500ms total execution time.
 */
export async function buildContext(
  prompt: string,
  depth: ContextDepth = "standard",
): Promise<string | null> {
  // Bail early if TRIBE CLI is not installed
  const installed = await ensureInstalled();
  if (!installed) return null;

  // Run queries in parallel for speed
  const queries: [Promise<SessionMeta[]>, Promise<KBMatch[]>?] = [
    fetchRecentSessions(depth),
  ];

  // Only search KB for standard/deep depth AND when prompt has substance
  if (depth !== "minimal" && prompt.length >= 5) {
    queries.push(searchKB(prompt));
  }

  const [sessions, kbResults] = await Promise.all([
    queries[0],
    queries[1] ?? Promise.resolve([]),
  ]);

  // If we have nothing useful, skip injection
  if (sessions.length === 0 && kbResults.length === 0) return null;

  const parts: string[] = [];

  const sessionsBlock = formatSessions(sessions, depth);
  if (sessionsBlock) parts.push(sessionsBlock);

  const kbBlock = formatKBResults(kbResults);
  if (kbBlock) parts.push(kbBlock);

  const projectLine = detectActiveProject(sessions);
  if (projectLine) parts.push(projectLine);

  if (parts.length === 0) return null;

  return `<tribe-context>\n${parts.join("\n\n")}\n</tribe-context>`;
}

/**
 * Invalidate the session cache (useful after a sync).
 */
export function invalidateCache(): void {
  sessionCache = null;
  const cache = getCache();
  cache.invalidate("kb").catch(() => {});
  cache.invalidate("sessions").catch(() => {});
}

// Exported for unit testing only — not part of the public API.
export const _testing = { extractJSON, extractSearchKeyword, extractSearchKeywords, formatTimestamp };
