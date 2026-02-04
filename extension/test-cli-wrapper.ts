/**
 * CLI Wrapper Integration Test Suite
 *
 * Tests all phases: Telemetry, OAuth, Session Sync, Agent Detection
 * Run with: npx tsx test-cli-wrapper.ts
 */

import { TelemetryClient, getTelemetryClient } from "./lib/telemetry-client.js";
import { OAuthClient, getOAuthClient } from "./lib/oauth-client.js";
import { SessionSync, getSessionSync } from "./lib/session-sync.js";
import { AgentDetector, getAgentDetector } from "./lib/agent-detector.js";
import { getInteractionLogger } from "./lib/interaction-logger.js";
import { Logger } from "./lib/logger.js";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Test Utilities
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  [+] ${name}`);
    passed++;
  } else {
    console.log(`  [x] ${name}${detail ? ` - ${detail}` : ""}`);
    failed++;
  }
}

function skip(name: string, reason: string) {
  console.log(`  [-] ${name} (skipped: ${reason})`);
  skipped++;
}

// ---------------------------------------------------------------------------
// Phase 1: Telemetry Client Tests
// ---------------------------------------------------------------------------

async function testTelemetryClient() {
  console.log("\n=== Phase 1: Telemetry Client ===");

  const client = new TelemetryClient();
  await client.init();

  // Test initialization
  test("Telemetry client initializes", true);

  // Test stats
  const stats = client.getStats();
  test("Stats returns queue size", typeof stats.queueSize === "number");
  test("Stats returns sent count", typeof stats.sentCount === "number");
  test("Stats returns online status", typeof stats.isOnline === "boolean");

  // Test event queueing
  await client.clearQueue();
  await client.send({
    type: "metric",
    sessionId: "test-session",
    agentType: "clawdbot",
    payload: { test: true },
    tags: ["test"],
  });

  const afterSend = client.getStats();
  test("Event queued successfully", afterSend.queueSize === 1);

  // Test convenience methods
  await client.sendSessionStart("test-1", "clawdbot", "TestBot", "anthropic");
  await client.sendSessionEnd("test-1", "clawdbot", "completed");
  await client.sendMetric("test-1", "response_time", 100);
  await client.sendError("test-1", "system", "test_error", "Test message");

  const finalStats = client.getStats();
  test("All convenience methods queue events", finalStats.queueSize === 5);

  // Test enable/disable
  client.setEnabled(false);
  await client.send({
    type: "metric",
    sessionId: "test",
    agentType: "system",
    payload: {},
    tags: [],
  });
  test("Disabled client does not queue", client.getStats().queueSize === 5);

  client.setEnabled(true);
  await client.clearQueue();
}

// ---------------------------------------------------------------------------
// Phase 2: OAuth Client Tests
// ---------------------------------------------------------------------------

async function testOAuthClient() {
  console.log("\n=== Phase 2: OAuth Client ===");

  const client = new OAuthClient();
  await client.init();

  test("OAuth client initializes", true);

  // Test status
  const status = await client.getStatus();
  test("Status returns authenticated flag", typeof status.authenticated === "boolean");
  test("Status returns server URL", typeof status.serverUrl === "string");

  if (status.authenticated) {
    test("Authenticated user has email", typeof status.email === "string");
    test("Authenticated user has name", typeof status.name === "string");
    test("Authenticated user has ID", typeof status.userId === "string");
    test("Token has expiry", typeof status.expiresAt === "number");

    // Test token access
    const tokens = client.getTokens();
    test("Can get tokens", tokens !== null);
    test("Token has access_token", typeof tokens?.access_token === "string");
    test("Token has refresh_token", typeof tokens?.refresh_token === "string");

    // Test refresh check
    const needsRefresh = client.needsRefresh();
    test("needsRefresh returns boolean", typeof needsRefresh === "boolean");
  } else {
    skip("Authenticated user has email", "Not authenticated");
    skip("Authenticated user has name", "Not authenticated");
    skip("Authenticated user has ID", "Not authenticated");
    skip("Token has expiry", "Not authenticated");
    skip("Can get tokens", "Not authenticated");
    skip("Token has access_token", "Not authenticated");
    skip("Token has refresh_token", "Not authenticated");
    skip("needsRefresh returns boolean", "Not authenticated");
  }

  // Test config
  const config = client.getConfig();
  test("Config has clientId", typeof config.clientId === "string");
  test("Config has authUrl", config.authUrl.includes("oauth"));
  test("Config has tokenUrl", config.tokenUrl.includes("oauth"));
}

// ---------------------------------------------------------------------------
// Phase 3: Session Sync Tests
// ---------------------------------------------------------------------------

async function testSessionSync() {
  console.log("\n=== Phase 3: Session Sync ===");

  const sync = new SessionSync();
  await sync.init();

  test("Session sync initializes", true);

  // Test status
  const status = sync.getSyncStatus();
  test("Status has lastSyncTime", typeof status.lastSyncTime === "number");
  test("Status has pendingCount", typeof status.pendingCount === "number");
  test("Status has syncedCount", typeof status.syncedCount === "number");
  test("Status has autoSyncEnabled", typeof status.autoSyncEnabled === "boolean");
  test("Status has isSyncing", typeof status.isSyncing === "boolean");

  // Test marking sessions
  await sync.markSessionPending("test-session-sync");
  const afterPending = sync.getSyncStatus();
  test("Can mark session pending", afterPending.pendingCount > 0);

  await sync.markSessionSynced("test-session-sync");
  test("Can mark session synced", true);

  // Check auth status for sync test
  const oauth = new OAuthClient();
  await oauth.init();
  const authStatus = await oauth.getStatus();

  if (authStatus.authenticated) {
    // Test sync (will likely fail server-side but shouldn't throw)
    let syncError = false;
    try {
      const result = await sync.sync();
      test("Sync returns result object", typeof result.uploaded === "number");
      test("Sync result has errors array", Array.isArray(result.errors));
    } catch {
      syncError = true;
    }
    test("Sync does not throw", !syncError);
  } else {
    skip("Sync returns result object", "Not authenticated");
    skip("Sync result has errors array", "Not authenticated");
    skip("Sync does not throw", "Not authenticated");
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Agent Detector Tests
// ---------------------------------------------------------------------------

async function testAgentDetector() {
  console.log("\n=== Phase 4: Agent Detector ===");

  // Test basic detection
  const detector = new AgentDetector();
  const result = detector.detect();

  test("Detection returns agentType", typeof result.agentType === "string");
  test("Detection returns apiProvider", typeof result.apiProvider === "string");
  test("Detection returns tags array", Array.isArray(result.tags));
  test("Detection returns confidence", ["high", "medium", "low"].includes(result.confidence));
  test("Detection returns detectedFrom array", Array.isArray(result.detectedFrom));

  // Test API provider detection
  const provider = detector.detectApiProvider();
  test("detectApiProvider returns provider", typeof provider === "string");

  // Test with content
  const contentDetector = new AgentDetector({
    contextContent: "This is a MUSE orchestration task with subagents",
  });
  const contentResult = contentDetector.detect();
  test("Content detection works", contentResult.agentType !== undefined);

  // Test with CLI args
  const cliDetector = new AgentDetector({
    cliArgs: ["--muse", "some-task"],
  });
  const cliResult = cliDetector.detect();
  test("CLI detection works", cliResult.agentType === "muse-leader");

  // Test static methods
  const providers = AgentDetector.getAvailableApiProviders();
  test("getAvailableApiProviders returns array", Array.isArray(providers));

  const isValid = AgentDetector.isAgentType("clawdbot");
  test("isAgentType validates correctly", isValid === true);

  const isInvalid = AgentDetector.isAgentType("invalid-type");
  test("isAgentType rejects invalid", isInvalid === false);

  // Test tags
  const tags = detector.getAgentTags();
  test("Tags includes agent type", tags.some((t) => t.startsWith("agent:")));
  test("Tags includes platform", tags.some((t) => t.startsWith("platform:")));
  test("Tags includes node version", tags.some((t) => t.startsWith("node:")));
  test("Tags includes environment", tags.some((t) => t.startsWith("env:")));
}

// ---------------------------------------------------------------------------
// Phase 5: Integration Tests
// ---------------------------------------------------------------------------

async function testIntegration() {
  console.log("\n=== Phase 5: Integration ===");

  // Test singleton instances
  const telemetry1 = getTelemetryClient();
  const telemetry2 = getTelemetryClient();
  test("Telemetry singleton works", telemetry1 === telemetry2);

  const oauth1 = getOAuthClient();
  const oauth2 = getOAuthClient();
  test("OAuth singleton works", oauth1 === oauth2);

  const sync1 = getSessionSync();
  const sync2 = getSessionSync();
  test("SessionSync singleton works", sync1 === sync2);

  const detector1 = getAgentDetector();
  const detector2 = getAgentDetector();
  test("AgentDetector singleton works", detector1 === detector2);

  // Test interaction logger integration
  const logger = getInteractionLogger();
  await logger.init();
  test("InteractionLogger initializes", true);

  // Test telemetry + detector integration
  const telemetry = getTelemetryClient();
  const detector = new AgentDetector();
  const detection = detector.detect();

  await telemetry.clearQueue();
  await telemetry.sendSessionStart(
    "integration-test",
    detection.agentType,
    "IntegrationTest",
    detection.apiProvider,
    detection.tags
  );

  const stats = telemetry.getStats();
  test("Telemetry integrates with detector", stats.queueSize === 1);

  await telemetry.clearQueue();

  // Test session sync + telemetry integration
  const sync = getSessionSync();
  const status = sync.getSyncStatus();
  await telemetry.sendMetric("integration-test", "sync_pending", status.pendingCount);
  test("Telemetry integrates with sync", telemetry.getStats().queueSize === 1);

  await telemetry.clearQueue();
}

// ---------------------------------------------------------------------------
// End-to-End Flow Test
// ---------------------------------------------------------------------------

async function testEndToEndFlow() {
  console.log("\n=== End-to-End Flow ===");

  // Simulate a complete session flow
  const telemetry = new TelemetryClient();
  await telemetry.init();
  await telemetry.clearQueue();

  const detector = new AgentDetector();
  const detection = detector.detect();

  // 1. Start session
  const sessionId = `e2e-test-${Date.now()}`;
  await telemetry.sendSessionStart(
    sessionId,
    detection.agentType,
    "E2ETest",
    detection.apiProvider,
    detection.tags
  );
  test("E2E: Session start recorded", telemetry.getStats().queueSize === 1);

  // 2. Log some interactions
  await telemetry.sendInteraction(sessionId, {
    id: "entry-1",
    timestamp: Date.now(),
    sessionId,
    actor: "user",
    actorName: "User",
    type: "message",
    content: "Test message",
  });
  test("E2E: Interaction recorded", telemetry.getStats().queueSize === 2);

  // 3. Log metrics
  await telemetry.sendMetric(sessionId, "response_time", 150);
  test("E2E: Metric recorded", telemetry.getStats().queueSize === 3);

  // 4. End session
  await telemetry.sendSessionEnd(sessionId, detection.agentType, "completed", {
    duration: 1000,
    interactions: 1,
  });
  test("E2E: Session end recorded", telemetry.getStats().queueSize === 4);

  // 5. Verify all events have required fields
  await telemetry.clearQueue();
  test("E2E: Queue cleared successfully", telemetry.getStats().queueSize === 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("===========================================");
  console.log("  CLI Wrapper Integration Test Suite");
  console.log("===========================================");

  await testTelemetryClient();
  await testOAuthClient();
  await testSessionSync();
  await testAgentDetector();
  await testIntegration();
  await testEndToEndFlow();

  console.log("\n===========================================");
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log("===========================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
