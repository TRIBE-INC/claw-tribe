// ---------------------------------------------------------------------------
// Error Diagnostics — pattern-based error classification and user-friendly
// suggestions for common TRIBE CLI failures.
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "auth"
  | "not-installed"
  | "timeout"
  | "network"
  | "cli-error"
  | "parse-error"
  | "permission"
  | "not-found"
  | "rate-limit"
  | "unknown";

export interface DiagnosticResult {
  category: ErrorCategory;
  summary: string;
  suggestedFixes: string[];
  docLink?: string;
}

interface ErrorPattern {
  category: ErrorCategory;
  test: (error: string) => boolean;
  summary: string;
  suggestedFixes: string[];
  docLink?: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    category: "not-installed",
    test: (e) =>
      e.includes("enoent") ||
      e.includes("not installed") ||
      e.includes("no such file") ||
      e.includes("command not found") ||
      e.includes("binary not found"),
    summary: "TRIBE CLI is not installed or not found on this system.",
    suggestedFixes: [
      "Run the tribe_setup tool to install automatically.",
      "Or install manually: npx @_xtribe/cli@latest",
      "Verify ~/.tribe/bin/tribe exists and is executable.",
    ],
    docLink: "https://docs.tribe.ai/install",
  },
  {
    category: "auth",
    test: (e) =>
      e.includes("not authenticated") ||
      e.includes("not logged in") ||
      e.includes("authentication") ||
      e.includes("unauthorized") ||
      e.includes("401") ||
      e.includes("login required"),
    summary: "Authentication required. TRIBE CLI is not logged in.",
    suggestedFixes: [
      "Run 'tribe login' in your terminal to authenticate.",
      "Or use the tribe_setup tool for guided setup.",
      "Some features work in local-only mode without auth.",
    ],
    docLink: "https://docs.tribe.ai/auth",
  },
  {
    category: "timeout",
    test: (e) =>
      e.includes("etimedout") ||
      e.includes("timeout") ||
      e.includes("timed out") ||
      e.includes("esockettimedout"),
    summary: "The operation timed out waiting for a response.",
    suggestedFixes: [
      "Check your network connection.",
      "Try again — the TRIBE API may be temporarily slow.",
      "For large queries, try adding --limit to reduce the result set.",
    ],
  },
  {
    category: "network",
    test: (e) =>
      e.includes("econnrefused") ||
      e.includes("econnreset") ||
      e.includes("enotfound") ||
      e.includes("network") ||
      e.includes("fetch failed") ||
      e.includes("socket hang up"),
    summary: "Network error — could not reach the TRIBE API.",
    suggestedFixes: [
      "Check your internet connection.",
      "Verify that api.tribe.ai is reachable.",
      "If behind a proxy, ensure HTTPS_PROXY is configured.",
    ],
  },
  {
    category: "rate-limit",
    test: (e) =>
      e.includes("rate limit") ||
      e.includes("429") ||
      e.includes("too many requests"),
    summary: "Rate limited — too many requests in a short period.",
    suggestedFixes: [
      "Wait a minute before retrying.",
      "Reduce the frequency of API calls.",
    ],
  },
  {
    category: "permission",
    test: (e) =>
      e.includes("eacces") ||
      e.includes("permission denied") ||
      e.includes("403"),
    summary: "Permission denied — insufficient access for this operation.",
    suggestedFixes: [
      "Check file permissions on ~/.tribe/ directory.",
      "Ensure you have the correct TRIBE plan for this feature.",
      "Try running 'tribe login' again to refresh credentials.",
    ],
  },
  {
    category: "not-found",
    test: (e) =>
      e.includes("404") ||
      e.includes("not found") ||
      e.includes("no such session") ||
      e.includes("no results"),
    summary: "The requested resource was not found.",
    suggestedFixes: [
      "Verify the session ID or document ID is correct.",
      "The resource may have been deleted or expired.",
      "Try listing available items first (tribe_sessions_list or tribe_kb_list).",
    ],
  },
  {
    category: "parse-error",
    test: (e) =>
      e.includes("json") ||
      e.includes("parse") ||
      e.includes("syntaxerror") ||
      e.includes("unexpected token") ||
      e.includes("cgo_enabled"),
    summary: "Failed to parse CLI output. The CLI may need updating.",
    suggestedFixes: [
      "Update the TRIBE CLI: npx @_xtribe/cli@latest",
      "If you see CGO_ENABLED errors, the CLI binary lacks SQLite support.",
      "Try running the command directly in your terminal to see full output.",
    ],
  },
  {
    category: "cli-error",
    test: (e) =>
      e.includes("exit code") ||
      e.includes("failed") ||
      e.includes("error:"),
    summary: "The TRIBE CLI command failed.",
    suggestedFixes: [
      "Check the error message for details.",
      "Run 'tribe version' to verify the CLI is working.",
      "Update to the latest CLI: npx @_xtribe/cli@latest",
    ],
  },
];

/**
 * Diagnose an error string and return a structured diagnostic result.
 */
export function diagnose(error: string | Error, context?: string): DiagnosticResult {
  const errorStr = typeof error === "string" ? error : error.message;
  const searchStr = errorStr.toLowerCase();

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(searchStr)) {
      return {
        category: pattern.category,
        summary: pattern.summary,
        suggestedFixes: pattern.suggestedFixes,
        docLink: pattern.docLink,
      };
    }
  }

  return {
    category: "unknown",
    summary: context
      ? `An unexpected error occurred during ${context}.`
      : "An unexpected error occurred.",
    suggestedFixes: [
      "Try running the command again.",
      "Check 'tribe status' for system health.",
      "If the issue persists, update the CLI: npx @_xtribe/cli@latest",
    ],
  };
}

/**
 * Format a diagnostic result as a user-friendly multi-line string.
 */
export function formatDiagnostic(diag: DiagnosticResult): string {
  const lines: string[] = [];
  lines.push(diag.summary);
  lines.push("");
  lines.push("Suggested fixes:");
  for (const fix of diag.suggestedFixes) {
    lines.push(`  - ${fix}`);
  }
  if (diag.docLink) {
    lines.push("");
    lines.push(`Documentation: ${diag.docLink}`);
  }
  return lines.join("\n");
}

// Exported for unit testing only.
export const _testing = { ERROR_PATTERNS, diagnose, formatDiagnostic };
