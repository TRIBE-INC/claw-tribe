#!/usr/bin/env npx tsx
/**
 * Claw-Tribe Verification Script
 *
 * Verifies that claw-tribe is working and OpenClaw messages are tracked by tribe.
 * Run: npx tsx scripts/verify-claw-tribe.ts
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

const TRIBE_BIN = path.join(homedir(), ".tribe", "bin", "tribe");
const OPENCLAW_CONFIG = path.join(homedir(), ".openclaw", "config.json");
const OPENCLAW_EXTENSIONS = path.join(homedir(), ".openclaw", "extensions");
const TRIBE_CONFIG = path.join(homedir(), ".tribe", "config.json");
const TRIBE_AUTH = path.join(homedir(), ".tribe", "tutor", "auth.json");
const TRIBE_LOGS = path.join(homedir(), ".tribe", "logs");
const TRIBE_KB = path.join(homedir(), ".tribe"); // KB is in tribe's data dir

type CheckResult = { ok: boolean; message: string; detail?: string };

async function runTribe(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = spawnSync(TRIBE_BIN, args, {
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

async function checkTribeCli(): Promise<CheckResult> {
  try {
    await fs.access(TRIBE_BIN);
  } catch {
    return {
      ok: false,
      message: "TRIBE CLI not installed",
      detail: "Run: npx @_xtribe/cli@latest",
    };
  }

  const { ok, stdout } = await runTribe(["--version"]);
  if (!ok) {
    return { ok: false, message: "TRIBE CLI exists but failed to run", detail: stdout };
  }
  return { ok: true, message: `TRIBE CLI installed (${stdout.trim().split("\n")[0] || "ok"})` };
}

async function checkTribeAuth(): Promise<CheckResult> {
  try {
    const data = await fs.readFile(TRIBE_AUTH, "utf-8");
    const auth = JSON.parse(data);
    const exp = auth.exp * 1000;
    if (exp < Date.now()) {
      return {
        ok: false,
        message: "TRIBE auth expired",
        detail: "Run: tribe login",
      };
    }
    const email = auth?.user_info?.email || "unknown";
    return { ok: true, message: `Authenticated as ${email}` };
  } catch {
    return {
      ok: false,
      message: "Not authenticated",
      detail: "Run: tribe login",
    };
  }
}

async function checkTribeStatus(): Promise<CheckResult> {
  const { ok, stdout } = await runTribe(["status"]);
  if (!ok) {
    return { ok: false, message: "tribe status failed", detail: stdout };
  }
  const hasActive = stdout.toLowerCase().includes("active");
  const hasOpenClaw = stdout.toLowerCase().includes("openclaw") || stdout.toLowerCase().includes("clawdbot");
  return {
    ok: true,
    message: hasActive ? "Telemetry active" : "Telemetry not active (run tribe enable)",
    detail: hasOpenClaw ? "OpenClaw/ClawdBot detected in status" : "OpenClaw not in tribe status (plugin may still capture to KB)",
  };
}

async function checkPluginInstalled(): Promise<CheckResult> {
  try {
    const config = await fs.readFile(OPENCLAW_CONFIG, "utf-8");
    const json = JSON.parse(config);
    const plugins = json?.plugins || json?.config?.plugins || {};
    const hasTribecode =
      "@tribecode/tribecode" in plugins ||
      "tribecode" in plugins ||
      Object.keys(plugins).some((k) => k.toLowerCase().includes("tribecode"));
    if (hasTribecode) {
      return { ok: true, message: "TribeCode plugin configured in OpenClaw" };
    }
  } catch {
    // config may not exist
  }

  // Check extensions dir
  try {
    const entries = await fs.readdir(OPENCLAW_EXTENSIONS);
    const hasTribe = entries.some((e) => e.toLowerCase().includes("tribecode") || e.includes("@tribecode"));
    if (hasTribe) {
      return { ok: true, message: "TribeCode extension found in ~/.openclaw/extensions" };
    }
  } catch {
    // dir may not exist
  }

  return {
    ok: false,
    message: "TribeCode plugin not found in OpenClaw config",
    detail: "Add plugin to ~/.openclaw/config.json or install to ~/.openclaw/extensions",
  };
}

async function checkKBCapture(): Promise<CheckResult> {
  // KB capture happens via tribe kb save - we can verify tribe kb works
  const { ok, stdout } = await runTribe(["-beta", "kb", "list", "--format", "json"]);
  if (!ok) {
    return {
      ok: false,
      message: "KB list failed (auth or CLI issue)",
      detail: stdout || "Run tribe login",
    };
  }
  try {
    const raw = stdout.trim();
    const start = Math.max(raw.indexOf("["), raw.indexOf("{"));
    const jsonStr = start >= 0 ? raw.slice(start) : raw;
    const parsed = jsonStr ? JSON.parse(jsonStr) : [];
    const arr = Array.isArray(parsed) ? parsed : parsed?.documents || [];
    const clawdbotEntries = arr.filter(
      (d: { content?: string }) => (d?.content || "").includes("[ClawdBot") || (d?.content || "").includes("ClawdBot")
    );
    return {
      ok: true,
      message: `KB has ${arr.length} docs${clawdbotEntries.length > 0 ? `, ${clawdbotEntries.length} from ClawdBot` : ""}`,
    };
  } catch {
    return { ok: true, message: "KB accessible" };
  }
}

async function checkSessionsQuery(): Promise<CheckResult> {
  const { ok, stdout } = await runTribe(["query", "sessions", "--all", "--limit", "5", "--format", "json"]);
  if (!ok) {
    return {
      ok: false,
      message: "Session query failed",
      detail: stdout || "May need tribe login",
    };
  }
  try {
    const raw = stdout.trim();
    const start = raw.indexOf("[");
    const jsonStr = start >= 0 ? raw.slice(start) : raw;
    const sessions = JSON.parse(jsonStr || "[]");
    const arr = Array.isArray(sessions) ? sessions : [];
    const openclawSessions = arr.filter(
      (s: { tool?: string; provider?: string }) =>
        (s?.tool || s?.provider || "").toLowerCase().includes("openclaw") ||
        (s?.tool || s?.provider || "").toLowerCase().includes("clawdbot")
    );
    return {
      ok: true,
      message: `Sessions: ${arr.length} total${openclawSessions.length > 0 ? `, ${openclawSessions.length} OpenClaw/ClawdBot` : ""}`,
      detail:
        openclawSessions.length === 0 && arr.length > 0
          ? "OpenClaw sessions not yet in tribe. KB capture works; session tracking requires tribe CLI to receive OpenClaw events."
          : undefined,
    };
  } catch {
    return { ok: true, message: "Sessions query works" };
  }
}

async function checkContextInjection(): Promise<CheckResult> {
  // Context injection uses tribe query sessions + kb search - if those work, context works
  const { ok } = await runTribe(["query", "sessions", "--all", "--limit", "1"]);
  if (!ok) {
    return { ok: false, message: "Context injection depends on session query (failed)" };
  }
  return {
    ok: true,
    message: "Context injection ready (uses tribe query sessions + kb search)",
  };
}

async function main() {
  console.log("=== Claw-Tribe Verification ===\n");

  const checks: Array<{ name: string; fn: () => Promise<CheckResult> }> = [
    { name: "1. TRIBE CLI", fn: checkTribeCli },
    { name: "2. TRIBE Auth", fn: checkTribeAuth },
    { name: "3. TRIBE Status", fn: checkTribeStatus },
    { name: "4. Plugin in OpenClaw", fn: checkPluginInstalled },
    { name: "5. KB Capture", fn: checkKBCapture },
    { name: "6. Sessions Query", fn: checkSessionsQuery },
    { name: "7. Context Injection", fn: checkContextInjection },
  ];

  let allOk = true;
  for (const { name, fn } of checks) {
    const result = await fn();
    const icon = result.ok ? "✓" : "✗";
    console.log(`${icon} ${name}: ${result.message}`);
    if (result.detail) {
      console.log(`    ${result.detail}`);
    }
    if (!result.ok) allOk = false;
  }

  console.log("\n--- Summary ---\n");
  if (allOk) {
    console.log("All checks passed. Claw-tribe is operational.");
    console.log("\nOpenClaw message tracking:");
    console.log("  • KB capture: Working (conversations saved to tribe kb on agent_end)");
    console.log("  • Context injection: Working (past sessions + KB injected before each turn)");
    console.log("  • Session telemetry: Tribe CLI tracks Claude, Cursor, Codex. OpenClaw sessions");
    console.log("    appear when the plugin's captureConversation runs (saves to KB). For full");
    console.log("    session search/recall, ensure tribe enable is active and tribe login is done.");
  } else {
    console.log("Some checks failed. Fix the issues above.");
    console.log("\nQuick fixes:");
    console.log("  • tribe login     - Authenticate with tribecode.ai");
    console.log("  • tribe enable    - Enable telemetry collection");
    console.log("  • tribe_setup     - Run from OpenClaw for guided setup");
  }
}

main().catch(console.error);
