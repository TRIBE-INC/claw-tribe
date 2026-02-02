import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TRIBE_BIN = join(homedir(), ".tribe", "bin", "tribe");

export type TimeoutCategory = "fast" | "default" | "slow" | "long";

const TIMEOUTS: Record<TimeoutCategory, number> = {
  fast: 15_000,
  default: 30_000,
  slow: 60_000,
  long: 120_000,
};

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function ensureInstalled(): Promise<boolean> {
  try {
    await access(TRIBE_BIN, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the TRIBE CLI is authenticated. Returns:
 * - "authenticated" — logged in and ready
 * - "not-authenticated" — CLI exists but not logged in
 * - "not-installed" — CLI binary not found
 */
export async function checkAuthStatus(): Promise<
  "authenticated" | "not-authenticated" | "not-installed"
> {
  const installed = await ensureInstalled();
  if (!installed) return "not-installed";

  try {
    const result = await run(["status"], { timeout: "fast" });
    const out = result.stdout;
    if (
      out.includes("Not logged in") ||
      out.includes("Not authenticated") ||
      out.includes("Skip-auth")
    ) {
      return "not-authenticated";
    }
    return "authenticated";
  } catch {
    return "not-authenticated";
  }
}

export function run(
  args: string[],
  options: {
    timeout?: TimeoutCategory;
    json?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<RunResult> {
  const { timeout = "default", json = false, signal } = options;
  const finalArgs = json ? [...args, "--format", "json"] : args;
  const timeoutMs = TIMEOUTS[timeout];

  return new Promise((resolve, reject) => {
    const child = execFile(
      TRIBE_BIN,
      finalArgs,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const exitCode =
          error && "code" in error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({ stdout, stderr, exitCode });
      },
    );

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
        },
        { once: true },
      );
    }
  });
}

export async function runJson<T = unknown>(
  args: string[],
  options: {
    timeout?: TimeoutCategory;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const result = await run(args, { ...options, json: true });
  if (result.exitCode !== 0) {
    throw new Error(
      `tribe ${args[0]} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `tribe ${args[0]} returned non-JSON output: ${result.stdout.slice(0, 200)}`,
    );
  }
}

export async function runText(
  args: string[],
  options: {
    timeout?: TimeoutCategory;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const result = await run(args, { ...options, json: false });
  if (result.exitCode !== 0) {
    throw new Error(
      `tribe ${args[0]} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}
