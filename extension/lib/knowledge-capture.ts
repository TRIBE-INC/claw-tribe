import { ensureInstalled, run } from "./tribe-runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

type Category =
  | "debugging"
  | "architecture"
  | "pattern"
  | "solution"
  | "decision"
  | "general";

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function extractTexts(messages: unknown[]): string[] {
  const texts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;

    const role = m.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = m.content;

    if (typeof content === "string") {
      texts.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }

  return texts;
}

// ---------------------------------------------------------------------------
// Content analysis
// ---------------------------------------------------------------------------

const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|bye|goodbye|yes|no|sure|got it|np|ty|thx)\s*[!.?]*$/i,
  /^.{0,15}$/,
];

function isSubstantive(text: string): boolean {
  const trimmed = text.trim();
  return !TRIVIAL_PATTERNS.some((p) => p.test(trimmed));
}

const CATEGORY_SIGNALS: Array<{ pattern: RegExp; category: Category }> = [
  { pattern: /\b(debug|error|fix|bug|issue|stack\s*trace|exception|crash)\b/i, category: "debugging" },
  { pattern: /\b(architect|design|structure|refactor|pattern|abstraction|module)\b/i, category: "architecture" },
  { pattern: /\b(pattern|convention|best\s*practice|idiom|approach)\b/i, category: "pattern" },
  { pattern: /\b(solution|solve|resolved|fixed|workaround|answer)\b/i, category: "solution" },
  { pattern: /\b(decided|decision|chose|choice|went\s*with|opted)\b/i, category: "decision" },
];

function detectCategory(text: string): Category {
  for (const { pattern, category } of CATEGORY_SIGNALS) {
    if (pattern.test(text)) return category;
  }
  return "general";
}

/**
 * Build a summary suitable for KB storage from the conversation texts.
 * Takes the most substantive assistant messages and condenses them.
 */
function buildSummary(texts: string[]): string | null {
  // Keep only substantive texts
  const useful = texts.filter(isSubstantive);
  if (useful.length === 0) return null;

  // Take up to the last 3 substantive messages (most recent = most relevant)
  const selected = useful.slice(-3);

  // Truncate each to a reasonable length
  const condensed = selected.map((t) => {
    const trimmed = t.trim();
    if (trimmed.length <= 500) return trimmed;
    return trimmed.slice(0, 500) + "...";
  });

  return condensed.join("\n\n---\n\n");
}

/**
 * Extract tags from conversation content for KB indexing.
 */
function extractTags(texts: string[]): string[] {
  const tags = new Set<string>();

  const TAG_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
    { pattern: /\btypescript\b/i, tag: "typescript" },
    { pattern: /\bjavascript\b/i, tag: "javascript" },
    { pattern: /\bpython\b/i, tag: "python" },
    { pattern: /\breact\b/i, tag: "react" },
    { pattern: /\bnode\.?js\b/i, tag: "nodejs" },
    { pattern: /\bdocker\w*/i, tag: "docker" },
    { pattern: /\bkubernetes\b|\bk8s\b/i, tag: "kubernetes" },
    { pattern: /\bgit\b/i, tag: "git" },
    { pattern: /\bapi\b/i, tag: "api" },
    { pattern: /\bdatabase\b|\bsql\b|\bpostgres\w*/i, tag: "database" },
    { pattern: /\bauth\b|\boauth\b|\bjwt\b/i, tag: "auth" },
    { pattern: /\btest\b|\btesting\b|\bspec\b/i, tag: "testing" },
    { pattern: /\bcss\b|\bstyl\b|\btailwind\b/i, tag: "css" },
  ];

  const combined = texts.join(" ");
  for (const { pattern, tag } of TAG_PATTERNS) {
    if (pattern.test(combined)) tags.add(tag);
  }

  return Array.from(tags).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Exported for unit testing only — not part of the public API.
export const _testing = { extractTexts, isSubstantive, detectCategory, extractTags, buildSummary };

/**
 * Analyze a completed agent conversation and capture insights to TRIBE KB.
 * Runs fire-and-forget — errors are logged but never thrown.
 */
export async function captureConversation(
  messages: unknown[],
  logger: { info(msg: string): void; warn(msg: string): void },
): Promise<void> {
  try {
    const installed = await ensureInstalled();
    if (!installed) return;

    const texts = extractTexts(messages);
    if (texts.length === 0) return;

    const summary = buildSummary(texts);
    if (!summary) return;

    const category = detectCategory(texts.join(" "));
    const tags = extractTags(texts);

    // Build the KB content with metadata markers
    const tagLine = tags.length > 0 ? `\nTags: ${tags.join(", ")}` : "";
    const content = `[ClawdBot ${category}]${tagLine}\n\n${summary}`;

    // Save to TRIBE KB — fire and forget with a timeout
    const result = await Promise.race([
      run(["-beta", "kb", "save", content], { timeout: "default" }),
      new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) =>
        setTimeout(() => resolve({ exitCode: 1, stdout: "", stderr: "timeout" }), 10_000),
      ),
    ]);

    if (result.exitCode === 0) {
      logger.info(`tribecode: captured ${category} insight to KB (${tags.join(", ") || "no tags"})`);
    } else {
      logger.warn(`tribecode: KB save returned exit ${result.exitCode}`);
    }
  } catch (err) {
    logger.warn(`tribecode: knowledge capture failed: ${String(err)}`);
  }
}
