import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { ensureInstalled, checkAuthStatus, run, runJson, runText } from "./lib/tribe-runner.js";
import { buildContext, invalidateCache, type ContextDepth } from "./lib/context-builder.js";
import { captureConversation } from "./lib/knowledge-capture.js";
import { SessionAnalyzer } from "./lib/session-analyzer.js";
import { Logger } from "./lib/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    _id: string,
    params: Record<string, unknown>,
    context?: { messages?: Array<{ role: string; content: any }> },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
};

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

// Shared parameter fragments
const formatParam = Type.Optional(
  Type.String({ description: "Output format: json or text (default: text)" }),
);
const limitParam = Type.Optional(
  Type.Number({ description: "Maximum number of results" }),
);
const timeRangeParam = Type.Optional(
  Type.String({
    description: "Time range: 24h, 7d, 30d, 90d, all (default: all)",
  }),
);
const toolFilterParam = Type.Optional(
  Type.String({
    description: 'Filter by tool name (e.g. "Claude Code", "Cursor")',
  }),
);
const projectFilterParam = Type.Optional(
  Type.String({ description: "Filter by project path (partial match)" }),
);

// ---------------------------------------------------------------------------
// Tool Factories
// ---------------------------------------------------------------------------

function setupTools(): ToolDef[] {
  return [
    {
      name: "tribe_setup",
      label: "Tribe Setup",
      description:
        "Install and configure TRIBE. Run this first — it installs the CLI, " +
        "checks authentication, and reports what's working. Safe to run multiple times.",
      parameters: Type.Object({}),
      async execute() {
        const lines: string[] = [];

        // Step 1: Check if CLI is installed
        const installed = await ensureInstalled();

        if (!installed) {
          lines.push("TRIBE CLI is not installed. Installing now...");
          lines.push("");

          // Install via npx — this downloads the binary to ~/.tribe/bin/
          try {
            const install = await run(
              // npx runs the postinstall script which places the binary
              [],
              { timeout: "slow" },
            );
            // Check again after install attempt
            const nowInstalled = await ensureInstalled();
            if (nowInstalled) {
              lines.push("CLI installed successfully.");
            } else {
              // npx approach — exec npx directly
              const { execFile } = await import("node:child_process");
              const { promisify } = await import("node:util");
              const execFileAsync = promisify(execFile);
              try {
                await execFileAsync("npx", ["@_xtribe/cli@latest", "--version"], {
                  timeout: 60_000,
                  env: { ...process.env, NO_COLOR: "1" },
                });
                const installed2 = await ensureInstalled();
                if (installed2) {
                  lines.push("CLI installed successfully via npx.");
                } else {
                  lines.push(
                    "Automatic install failed. Please run this command in your terminal:",
                    "",
                    "  npx @_xtribe/cli@latest",
                    "",
                    "This will download and install the TRIBE CLI.",
                  );
                  return textResult(lines.join("\n"));
                }
              } catch (e) {
                lines.push(
                  "Automatic install failed. Please run this command in your terminal:",
                  "",
                  "  npx @_xtribe/cli@latest",
                  "",
                  "This will download and install the TRIBE CLI.",
                );
                return textResult(lines.join("\n"));
              }
            }
          } catch {
            lines.push(
              "Automatic install failed. Please run this command in your terminal:",
              "",
              "  npx @_xtribe/cli@latest",
              "",
              "This will download and install the TRIBE CLI.",
            );
            return textResult(lines.join("\n"));
          }
          lines.push("");
        } else {
          lines.push("TRIBE CLI is installed.");
        }

        // Step 2: Check authentication
        const authStatus = await checkAuthStatus();

        if (authStatus === "authenticated") {
          lines.push("Authentication: Logged in.");
          lines.push("");

          // Step 3: Check telemetry status
          const status = await run(["status"], { timeout: "fast" });
          if (status.stdout.includes("Active")) {
            lines.push("Telemetry: Active and collecting data.");
          } else {
            lines.push("Telemetry: Not active. Run the tribe_enable tool to start collecting.");
          }

          lines.push("");
          lines.push("Setup complete. TribeCode is fully operational.");
          lines.push("");
          lines.push("What's happening automatically:");
          lines.push("- Your prompts are enriched with context from past coding sessions");
          lines.push("- Useful conversations are saved to your knowledge base");
          lines.push("");
          lines.push("Available tools: search sessions, recall details, manage knowledge base, and more.");
        } else {
          lines.push("Authentication: Not logged in.");
          lines.push("");
          lines.push("To complete setup, run this command in your terminal:");
          lines.push("");
          lines.push("  tribe login");
          lines.push("");
          lines.push("This will open your browser for secure login. Once done, I'll be able to");
          lines.push("access your full session history, insights, and knowledge base.");
          lines.push("");
          lines.push("Without login, TribeCode still works in local-only mode (basic session data).");
        }

        return textResult(lines.join("\n"));
      },
    },
  ];
}

function telemetryTools(): ToolDef[] {
  return [
    {
      name: "tribe_enable",
      label: "Tribe Enable",
      description: "Enable TRIBE telemetry collection for Claude, Cursor, and Codex.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["enable"]);
        return textResult(out);
      },
    },
    {
      name: "tribe_disable",
      label: "Tribe Disable",
      description: "Disable TRIBE telemetry collection.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["disable"]);
        return textResult(out);
      },
    },
    {
      name: "tribe_status",
      label: "Tribe Status",
      description:
        "Show TRIBE telemetry collection status including sync state and connected tools.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["status"]);
        return textResult(out);
      },
    },
    {
      name: "tribe_version",
      label: "Tribe Version",
      description: "Show TRIBE CLI version and build configuration.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["version"]);
        return textResult(out);
      },
    },
  ];
}

function authTools(): ToolDef[] {
  return [
    {
      name: "tribe_auth_status",
      label: "Tribe Auth Status",
      description:
        "Check if the user is authenticated with TRIBE. Returns auth state without triggering login.",
      parameters: Type.Object({}),
      async execute(_id, _params) {
        // Run status which shows auth state; avoid 'login' which opens browser
        const result = await run(["status"], { timeout: "fast" });
        const isAuthed = !result.stdout.includes("Not authenticated");
        return textResult(result.stdout, { authenticated: isAuthed });
      },
    },
    {
      name: "tribe_logout",
      label: "Tribe Logout",
      description: "Remove TRIBE authentication credentials.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["logout"], { timeout: "fast" });
        return textResult(out);
      },
    },
  ];
}

function searchTools(): ToolDef[] {
  return [
    {
      name: "tribe_search",
      label: "Tribe Search",
      description:
        "Search across all AI coding sessions for specific content. Returns matching session excerpts.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query text" }),
        limit: limitParam,
        timeRange: timeRangeParam,
        tool: toolFilterParam,
        project: projectFilterParam,
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "search", String(params.query)];
        if (params.limit) args.push("--limit", String(params.limit));
        if (params.timeRange) args.push("--time-range", String(params.timeRange));
        if (params.tool) args.push("--tool", String(params.tool));
        if (params.project) args.push("--project", String(params.project));
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "slow" });
        return textResult(out);
      },
    },
    {
      name: "tribe_recall",
      label: "Tribe Recall",
      description: "Generate a detailed summary of what happened in a specific coding session.",
      parameters: Type.Object({
        sessionId: Type.String({ description: "Session ID to recall" }),
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "recall", String(params.sessionId)];
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "slow" });
        return textResult(out);
      },
    },
    {
      name: "tribe_extract",
      label: "Tribe Extract",
      description:
        "Extract specific content types (code, commands, files, edits) from a coding session.",
      parameters: Type.Object({
        sessionId: Type.String({ description: "Session ID to extract from" }),
        type: Type.Optional(
          Type.String({
            description: "Content type: code, commands, files, edits (default: code)",
          }),
        ),
        limit: limitParam,
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "extract", String(params.sessionId)];
        if (params.type) args.push("--type", String(params.type));
        if (params.limit) args.push("--limit", String(params.limit));
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "default" });
        return textResult(out);
      },
    },
    {
      name: "tribe_query_sessions",
      label: "Tribe Query Sessions",
      description:
        "List coding sessions with optional filters for tool, time range, and project.",
      parameters: Type.Object({
        limit: limitParam,
        timeRange: timeRangeParam,
        tool: toolFilterParam,
        project: projectFilterParam,
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "query", "sessions", "--all"];
        if (params.limit) args.push("--limit", String(params.limit));
        if (params.timeRange) args.push("--time-range", String(params.timeRange));
        if (params.tool) args.push("--tool", String(params.tool));
        if (params.project) args.push("--project", String(params.project));
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "default" });
        return textResult(out);
      },
    },
    {
      name: "tribe_query_insights",
      label: "Tribe Query Insights",
      description: "Query your coding insights and session summaries.",
      parameters: Type.Object({
        limit: limitParam,
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "query", "insights"];
        if (params.limit) args.push("--limit", String(params.limit));
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "default" });
        return textResult(out);
      },
    },
    {
      name: "tribe_query_events",
      label: "Tribe Query Events",
      description: "Query events for a specific coding session.",
      parameters: Type.Object({
        sessionId: Type.String({ description: "Session ID to query events for" }),
        limit: limitParam,
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "query", "events", "--session", String(params.sessionId)];
        if (params.limit) args.push("--limit", String(params.limit));
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "default" });
        return textResult(out);
      },
    },
  ];
}

function sessionTools(): ToolDef[] {
  return [
    {
      name: "tribe_sessions_list",
      label: "Tribe Sessions List",
      description: "List AI coding sessions with optional project and search filters.",
      parameters: Type.Object({
        cwd: Type.Optional(
          Type.Boolean({ description: "Filter to current working folder only" }),
        ),
        project: projectFilterParam,
        search: Type.Optional(
          Type.String({ description: "Search in session titles" }),
        ),
        limit: limitParam,
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "sessions", "list"];
        if (params.cwd) args.push("--cwd");
        if (params.project) args.push("--project", String(params.project));
        if (params.search) args.push("--search", String(params.search));
        if (params.limit) args.push("--limit", String(params.limit));
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "default" });
        return textResult(out);
      },
    },
    {
      name: "tribe_sessions_read",
      label: "Tribe Sessions Read",
      description: "Read the full details of a specific coding session.",
      parameters: Type.Object({
        sessionId: Type.String({ description: "Session ID to read" }),
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "sessions", "read", String(params.sessionId)];
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "default" });
        return textResult(out);
      },
    },
    {
      name: "tribe_sessions_search",
      label: "Tribe Sessions Search",
      description: "Search within session content for specific text.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "sessions", "search", String(params.query)];
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "slow" });
        return textResult(out);
      },
    },
  ];
}

function kbTools(): ToolDef[] {
  return [
    {
      name: "tribe_kb_search",
      label: "Tribe KB Search",
      description: "Search the TRIBE knowledge base for relevant documents.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      async execute(_id, params) {
        const out = await runText(
          ["-beta", "kb", "search", String(params.query)],
          { timeout: "default" },
        );
        return textResult(out);
      },
    },
    {
      name: "tribe_kb_list",
      label: "Tribe KB List",
      description: "List all documents in the TRIBE knowledge base.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["-beta", "kb", "list"], { timeout: "default" });
        return textResult(out);
      },
    },
    {
      name: "tribe_kb_save",
      label: "Tribe KB Save",
      description: "Save content to the TRIBE knowledge base.",
      parameters: Type.Object({
        content: Type.String({ description: "Content to save to the knowledge base" }),
      }),
      async execute(_id, params) {
        const out = await runText(
          ["-beta", "kb", "save", String(params.content)],
          { timeout: "default" },
        );
        return textResult(out);
      },
    },
    {
      name: "tribe_kb_get",
      label: "Tribe KB Get",
      description: "Retrieve a specific knowledge base document by ID.",
      parameters: Type.Object({
        docId: Type.String({ description: "Document ID" }),
      }),
      async execute(_id, params) {
        const out = await runText(
          ["-beta", "kb", "get", String(params.docId)],
          { timeout: "fast" },
        );
        return textResult(out);
      },
    },
    {
      name: "tribe_kb_delete",
      label: "Tribe KB Delete",
      description: "Delete a knowledge base document by ID.",
      parameters: Type.Object({
        docId: Type.String({ description: "Document ID to delete" }),
      }),
      async execute(_id, params) {
        const out = await runText(
          ["-beta", "kb", "delete", String(params.docId)],
          { timeout: "fast" },
        );
        return textResult(out);
      },
    },
    {
      name: "tribe_kb_stats",
      label: "Tribe KB Stats",
      description: "Show knowledge base statistics and sync status.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["-beta", "kb", "sync"], { timeout: "default" });
        return textResult(out);
      },
    },
  ];
}

function museTools(): ToolDef[] {
  return [
    {
      name: "tribe_muse_start",
      label: "Tribe MUSE Start",
      description: "Start the MUSE leader agent for orchestrating subagents.",
      parameters: Type.Object({
        agent: Type.Optional(
          Type.String({ description: "Agent to use: claude, gemini (default: auto-detect)" }),
        ),
      }),
      async execute(_id, params) {
        const args = ["-beta", "muse", "start"];
        if (params.agent) args.push("--agent", String(params.agent));
        const out = await runText(args, { timeout: "slow" });
        return textResult(out);
      },
    },
    {
      name: "tribe_muse_spawn",
      label: "Tribe MUSE Spawn",
      description: "Spawn a new MUSE subagent with a specific task.",
      parameters: Type.Object({
        task: Type.String({ description: "Task description for the subagent" }),
        name: Type.Optional(Type.String({ description: "Session name for the subagent" })),
        agent: Type.Optional(Type.String({ description: "Agent to use: claude, gemini" })),
      }),
      async execute(_id, params) {
        const args = ["-beta", "muse", "spawn"];
        if (params.agent) args.push("--agent", String(params.agent));
        args.push(String(params.task));
        if (params.name) args.push(String(params.name));
        const out = await runText(args, { timeout: "slow" });
        return textResult(out);
      },
    },
    {
      name: "tribe_muse_status",
      label: "Tribe MUSE Status",
      description: "Show MUSE leader and subagent status.",
      parameters: Type.Object({
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "muse", "status"];
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "fast" });
        return textResult(out);
      },
    },
    {
      name: "tribe_muse_agents",
      label: "Tribe MUSE Agents",
      description: "Show the MUSE agent registry with all registered agents.",
      parameters: Type.Object({
        format: formatParam,
      }),
      async execute(_id, params) {
        const args = ["-beta", "muse", "agents"];
        if (params.format) args.push("--format", String(params.format));
        const out = await runText(args, { timeout: "fast" });
        return textResult(out);
      },
    },
    {
      name: "tribe_muse_prompt",
      label: "Tribe MUSE Prompt",
      description: "Send a prompt message to a running MUSE subagent.",
      parameters: Type.Object({
        session: Type.String({ description: "Subagent session name" }),
        message: Type.String({ description: "Message to send to the subagent" }),
      }),
      async execute(_id, params) {
        const out = await runText(
          ["-beta", "muse", "prompt", String(params.session), String(params.message)],
          { timeout: "slow" },
        );
        return textResult(out);
      },
    },
    {
      name: "tribe_muse_kill",
      label: "Tribe MUSE Kill",
      description: "Kill an unresponsive MUSE subagent session.",
      parameters: Type.Object({
        session: Type.String({ description: "Subagent session name to kill" }),
        reason: Type.Optional(Type.String({ description: "Reason for killing the session" })),
      }),
      async execute(_id, params) {
        const args = ["-beta", "muse", "kill", String(params.session)];
        if (params.reason) args.push("--reason", String(params.reason));
        const out = await runText(args, { timeout: "fast" });
        return textResult(out);
      },
    },
  ];
}

function circuitTools(): ToolDef[] {
  return [
    {
      name: "tribe_circuit_list",
      label: "Tribe CIRCUIT List",
      description: "List autonomous agent sessions with health status.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["-beta", "circuit", "list"], { timeout: "fast" });
        return textResult(out);
      },
    },
    {
      name: "tribe_circuit_spawn",
      label: "Tribe CIRCUIT Spawn",
      description: "Spawn an autonomous agent for a GitHub issue number.",
      parameters: Type.Object({
        issue: Type.Number({ description: "GitHub issue number to assign to the agent" }),
        force: Type.Optional(
          Type.Boolean({ description: "Override agent limit" }),
        ),
      }),
      async execute(_id, params) {
        const args = ["-beta", "circuit", "spawn", String(params.issue)];
        if (params.force) args.push("--force");
        const out = await runText(args, { timeout: "slow" });
        return textResult(out);
      },
    },
    {
      name: "tribe_circuit_status",
      label: "Tribe CIRCUIT Status",
      description: "Show a quick status summary of CIRCUIT autonomous agents.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["-beta", "circuit", "status"], { timeout: "fast" });
        return textResult(out);
      },
    },
    {
      name: "tribe_circuit_metrics",
      label: "Tribe CIRCUIT Metrics",
      description: "Show performance metrics for CIRCUIT autonomous agents.",
      parameters: Type.Object({}),
      async execute() {
        const out = await runText(["-beta", "circuit", "metrics"], { timeout: "fast" });
        return textResult(out);
      },
    },
    {
      name: "tribe_circuit_auto",
      label: "Tribe CIRCUIT Auto",
      description:
        "Auto-spawn agents up to the configured limit, processing issues by priority.",
      parameters: Type.Object({
        interval: Type.Optional(
          Type.Number({ description: "Check interval in seconds (default: 30)" }),
        ),
      }),
      async execute(_id, params) {
        const args = ["-beta", "circuit", "auto"];
        if (params.interval) args.push("--interval", String(params.interval));
        const out = await runText(args, { timeout: "long" });
        return textResult(out);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Session Analysis Tools (NEW)
// ---------------------------------------------------------------------------

function sessionAnalysisTools(analyzer: SessionAnalyzer): ToolDef[] {
  return [
    {
      name: "tribe_analyze_sessions",
      label: "Analyze Sessions",
      description:
        "Mine improvement signals from recent OpenClaw sessions. Detects errors, " +
        "user frustration, and improvement opportunities automatically.",
      parameters: Type.Object({
        maxSessions: Type.Optional(
          Type.Number({ description: "Maximum number of sessions to analyze (default: 50)" })
        ),
        sessionIds: Type.Optional(
          Type.Array(Type.String(), { description: "Specific session IDs to analyze" })
        ),
      }),
      async execute(_id, params) {
        const result = await analyzer.analyze({
          maxSessions: params.maxSessions as number | undefined,
          sessionIds: params.sessionIds as string[] | undefined,
        });

        const summary = [
          `Found ${result.signals.length} signals in ${result.rollups.length} clusters.`,
          "",
          "Top Issues:",
          ...result.topIssues.slice(0, 5).map((issue, idx) =>
            `${idx + 1}. [${issue.max_severity}] ${issue.canonical_summary} (score: ${issue.score.toFixed(1)})`
          ),
        ];

        return textResult(summary.join("\n"), {
          signalCount: result.signals.length,
          rollupCount: result.rollups.length,
          topIssues: result.topIssues,
        });
      },
    },
    {
      name: "tribe_rollup_details",
      label: "Rollup Details",
      description: "Get detailed information about a signal rollup/cluster",
      parameters: Type.Object({
        rollupId: Type.String({ description: "Rollup fingerprint ID" }),
      }),
      async execute(_id, params) {
        // This would retrieve from a cache in a real implementation
        return textResult(
          `Rollup details for ${params.rollupId}.\n\n` +
          "Run tribe_analyze_sessions first to generate rollups.",
        );
      },
    },
    {
      name: "tribe_generate_brief",
      label: "Generate Research Brief",
      description: "Generate detailed research brief for an issue using actor-critic pattern",
      parameters: Type.Object({
        rollupId: Type.String({ description: "Rollup fingerprint ID to research" }),
      }),
      async execute(_id, params) {
        const brief = await analyzer.generateBrief(params.rollupId as string);

        const summary = [
          `# ${brief.title}`,
          "",
          "## Evidence Snapshot",
          brief.evidence.substring(0, 500) + "...",
          "",
          "## Analysis",
          brief.analysis.substring(0, 500) + "...",
          "",
          "## Recommendations",
          brief.recommendations,
        ];

        return textResult(summary.join("\n"), { brief });
      },
    },
    {
      name: "tribe_self_improve",
      label: "Self-Improve",
      description:
        "Run full self-improvement pipeline: analyze sessions, cluster issues, " +
        "and generate research briefs for top problems",
      parameters: Type.Object({
        maxSessions: Type.Optional(
          Type.Number({ description: "Maximum sessions to analyze (default: 100)" })
        ),
      }),
      async execute(_id, params) {
        const result = await analyzer.analyze({
          maxSessions: (params.maxSessions as number) || 100,
        });

        // Generate briefs for top 3 issues
        const briefs = [];
        for (const issue of result.topIssues.slice(0, 3)) {
          try {
            const brief = await analyzer.generateBrief(issue.fingerprint_id);
            briefs.push(brief.title);
          } catch (err) {
            // Brief generation might fail, continue with others
          }
        }

        const summary = [
          "Self-Improvement Analysis Complete",
          "",
          `Analyzed ${result.signals.length} signals from sessions`,
          `Found ${result.topIssues.length} top issues`,
          `Generated ${briefs.length} research briefs`,
          "",
          "Research Briefs:",
          ...briefs.map((title, idx) => `${idx + 1}. ${title}`),
        ];

        return textResult(summary.join("\n"), {
          signalCount: result.signals.length,
          issueCount: result.topIssues.length,
          briefCount: briefs.length,
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Semantic Search & Smart Suggestions Tools (NEW)
// ---------------------------------------------------------------------------

function semanticTools(): ToolDef[] {
  return [
    {
      name: "tribe_semantic_search",
      label: "Semantic Search",
      description:
        "Search knowledge base using semantic similarity (vector embeddings). " +
        "Finds conceptually related content, not just keyword matches.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default: 10)" })
        ),
        minSimilarity: Type.Optional(
          Type.Number({ description: "Minimum similarity score 0-1 (default: 0.7)" })
        ),
      }),
      async execute(_id, params) {
        const { SemanticSearch } = await import("./lib/semantic-search.js");
        const { Logger } = await import("./lib/logger.js");

        const semantic = new SemanticSearch(new Logger("semantic-search"));

        if (!semantic.isInitialized()) {
          return textResult(
            "Vector index not initialized. Run tribe_reindex_knowledge first."
          );
        }

        const results = await semantic.search(params.query as string, {
          limit: (params.limit as number) || 10,
          minSimilarity: (params.minSimilarity as number) || 0.7,
        });

        if (results.length === 0) {
          return textResult("No results found.");
        }

        const lines = [
          `Found ${results.length} results:`,
          "",
          ...results.map((r, idx) => {
            const preview = r.entry.content.substring(0, 200) + "...";
            return `${idx + 1}. [${r.entry.category}] ${preview}\n   (${(r.similarity * 100).toFixed(0)}% similarity, ${r.relevance} relevance)`;
          }),
        ];

        return textResult(lines.join("\n"), { results });
      },
    },
    {
      name: "tribe_reindex_knowledge",
      label: "Reindex Knowledge",
      description:
        "Rebuild semantic search vector index for all knowledge base entries. " +
        "Run this after adding new KB content or on first use.",
      parameters: Type.Object({}),
      async execute() {
        const { SemanticSearch } = await import("./lib/semantic-search.js");
        const { Logger } = await import("./lib/logger.js");

        const semantic = new SemanticSearch(new Logger("semantic-search"));

        // Get all KB entries
        const kbResult = await run(["kb", "list", "--format", "json"], {
          timeout: "slow",
        });

        if (kbResult.exitCode !== 0) {
          return textResult("Failed to list knowledge base entries.");
        }

        const kbEntries = JSON.parse(kbResult.stdout);

        if (!Array.isArray(kbEntries) || kbEntries.length === 0) {
          return textResult("No knowledge base entries found.");
        }

        // Index them
        await semantic.indexKnowledge(
          kbEntries.map((e: any) => ({
            id: e.id || String(Math.random()),
            content: e.content || e.text || "",
            category: e.category || "general",
            tags: e.tags || [],
            timestamp: e.timestamp || Date.now(),
          }))
        );

        return textResult(
          `Successfully indexed ${kbEntries.length} knowledge base entries.\n\n` +
          "Semantic search is now available!"
        );
      },
    },
    {
      name: "tribe_suggest_knowledge",
      label: "Suggest Knowledge",
      description:
        "Get smart knowledge suggestions based on current conversation context. " +
        "Proactively finds relevant past insights.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({ description: "Max suggestions (default: 5)" })
        ),
      }),
      async execute(_id, params, context) {
        const { SemanticSearch } = await import("./lib/semantic-search.js");
        const { SmartSuggestions } = await import("./lib/smart-suggestions.js");
        const { Logger } = await import("./lib/logger.js");

        const logger = new Logger("smart-suggestions");
        const semantic = new SemanticSearch(logger);

        if (!semantic.isInitialized()) {
          return textResult(
            "Semantic search not initialized. Run tribe_reindex_knowledge first."
          );
        }

        const suggestions = new SmartSuggestions(semantic, logger);

        const results = await suggestions.suggestRelevant(
          context.messages || [],
          { limit: (params.limit as number) || 5 }
        );

        if (results.length === 0) {
          return textResult("No relevant suggestions found for this conversation.");
        }

        const lines = [
          `Found ${results.length} relevant suggestions:`,
          "",
          ...results.map((s, idx) => {
            const preview = s.content.substring(0, 150) + "...";
            return `${idx + 1}. [${s.category}] ${preview}\n   ${s.reason} (${(s.similarity * 100).toFixed(0)}% match)`;
          }),
        ];

        return textResult(lines.join("\n"), { suggestions: results });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const tribecodePlugin = {
  id: "tribecode",
  name: "TribeCode",
  description: "AI coding analytics and agent orchestration via TRIBE CLI",

  configSchema: {
    type: "object" as const,
    additionalProperties: false as const,
    properties: {
      autoContext: {
        type: "boolean" as const,
        default: true,
        description: "Automatically inject TRIBE context before every agent turn",
      },
      autoCapture: {
        type: "boolean" as const,
        default: true,
        description: "Automatically capture ClawdBot conversations to TRIBE KB",
      },
      autoSync: {
        type: "boolean" as const,
        default: false,
        description: "Run tribe sync in background every 5 minutes",
      },
      contextDepth: {
        type: "string" as const,
        enum: ["minimal", "standard", "deep"] as const,
        default: "standard",
        description:
          "How much TRIBE context to inject (minimal=recent sessions, standard=+KB, deep=+full session details)",
      },
    },
  },

  register(api: ClawdbotPluginApi) {
    const pluginCfg = api.pluginConfig as {
      autoContext?: boolean;
      autoCapture?: boolean;
      autoSync?: boolean;
      contextDepth?: ContextDepth;
    } | undefined;

    // -------------------------------------------------------------------
    // Initialize Session Analyzer
    // -------------------------------------------------------------------

    const logger = new Logger("tribecode");
    const sessionAnalyzer = new SessionAnalyzer(logger);

    // -------------------------------------------------------------------
    // Startup health check — tell the user what's going on
    // -------------------------------------------------------------------

    checkAuthStatus().then((status) => {
      if (status === "not-installed") {
        api.logger.warn(
          "tribecode: TRIBE CLI not found. Use the tribe_setup tool to install.",
        );
      } else if (status === "not-authenticated") {
        api.logger.warn(
          "tribecode: Not authenticated. Run 'tribe login' in your terminal, or use tribe_setup.",
        );
        api.logger.info(
          "tribecode: Active in local-only mode (limited session data).",
        );
      } else {
        api.logger.info("tribecode: TRIBE connected and authenticated.");
        api.logger.info(
          `tribecode: autoContext=${pluginCfg?.autoContext ?? true}, ` +
          `autoCapture=${pluginCfg?.autoCapture ?? true}, ` +
          `depth=${pluginCfg?.contextDepth ?? "standard"}`,
        );
      }
    }).catch(() => {
      // Don't block plugin load on health check failure
    });

    // -------------------------------------------------------------------
    // Register tools with auth-aware error messages
    // -------------------------------------------------------------------

    const allTools: ToolDef[] = [
      ...setupTools(),
      ...telemetryTools(),
      ...authTools(),
      ...searchTools(),
      ...sessionTools(),
      ...kbTools(),
      ...museTools(),
      ...circuitTools(),
      ...sessionAnalysisTools(sessionAnalyzer),
      ...semanticTools(),
    ];

    for (const tool of allTools) {
      api.registerTool(
        {
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
          async execute(toolCallId: string, params: Record<string, unknown>) {
            // tribe_setup handles its own install/auth logic
            if (tool.name === "tribe_setup") {
              return tool.execute(toolCallId, params);
            }
            const status = await checkAuthStatus();
            if (status === "not-installed") {
              return textResult(
                "TRIBE CLI is not installed. Use the tribe_setup tool to install it automatically.",
              );
            }
            // Let tools that work without auth proceed
            const noAuthRequired = [
              "tribe_status", "tribe_version", "tribe_enable", "tribe_disable", "tribe_auth_status",
            ];
            if (status === "not-authenticated" && !noAuthRequired.includes(tool.name)) {
              return textResult(
                "TRIBE CLI is not authenticated.\n\n" +
                "To authenticate, run this in your terminal: tribe login\n\n" +
                "Or use the tribe_setup tool for guided setup.\n\n" +
                "Without login, TribeCode works in local-only mode (basic session data).",
              );
            }
            return tool.execute(toolCallId, params);
          },
        },
      );
    }

    // -------------------------------------------------------------------
    // Layer 1: Context injection (before_agent_start)
    // -------------------------------------------------------------------

    api.on("before_agent_start", async (event) => {
      if (pluginCfg?.autoContext === false) return;
      if (!event.prompt || event.prompt.length < 5) return;

      try {
        const depth = pluginCfg?.contextDepth ?? "standard";
        const context = await buildContext(event.prompt, depth, event.messages);
        if (!context) {
          api.logger.debug("tribecode: no relevant context found for this prompt.");
          return;
        }

        // Count what we're injecting so the log is informative
        const hasSessions = context.includes("Recent Activity:");
        const hasKB = context.includes("Relevant Knowledge:");
        const hasProject = context.includes("Active Project:");
        const parts = [
          hasSessions && "sessions",
          hasKB && "knowledge",
          hasProject && "project",
        ].filter(Boolean);

        api.logger.info(
          `tribecode: injecting context (${parts.join(", ")}) — ${context.length} chars`,
        );
        return { prependContext: context };
      } catch (err) {
        api.logger.warn(`tribecode: context injection failed: ${String(err)}`);
      }
    });

    // -------------------------------------------------------------------
    // Layer 2: Knowledge capture (agent_end)
    // -------------------------------------------------------------------

    api.on("agent_end", async (event) => {
      if (pluginCfg?.autoCapture === false) return;
      if (!event.success || !event.messages || event.messages.length === 0) return;

      captureConversation(event.messages, api.logger).catch(() => {
        // captureConversation logs internally
      });
    });

    // -------------------------------------------------------------------
    // Background sync service
    // -------------------------------------------------------------------

    let syncInterval: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "tribe-sync",
      start() {
        if (!pluginCfg?.autoSync) return;
        api.logger.info("tribecode: background sync enabled (every 5 minutes).");
        syncInterval = setInterval(
          async () => {
            try {
              await run(["-force"], { timeout: "slow" });
              invalidateCache();
              api.logger.debug("tribecode: background sync completed.");
            } catch (err) {
              api.logger.warn(`tribecode: background sync failed: ${String(err)}`);
            }
          },
          5 * 60 * 1000,
        );
      },
      stop() {
        if (syncInterval) {
          clearInterval(syncInterval);
          syncInterval = null;
        }
      },
    });
  },
};

export default tribecodePlugin;
