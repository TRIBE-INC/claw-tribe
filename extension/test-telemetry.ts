/**
 * Test suite for Telemetry Client
 *
 * Run with: npx tsx test-telemetry.ts
 */

import { TelemetryClient, getTelemetryClient, _testing } from "./lib/telemetry-client.js";
import { Logger } from "./lib/logger.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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

async function cleanup() {
  // Clean up test artifacts
  try {
    await fs.unlink(_testing.QUEUE_FILE);
  } catch {
    // Ignore if doesn't exist
  }
}

// ---------------------------------------------------------------------------
// Test: TelemetryClient Initialization
// ---------------------------------------------------------------------------

async function testInitialization() {
  console.log("\n=== TelemetryClient Initialization ===");

  const logger = new Logger("test-telemetry");
  const client = new TelemetryClient(logger);

  await client.init();

  test("Client initializes without error", true);

  const stats = client.getStats();
  test("Stats has queueSize property", typeof stats.queueSize === "number");
  test("Stats has sentCount property", typeof stats.sentCount === "number");
  test("Stats has failedCount property", typeof stats.failedCount === "number");
  test("Stats has isOnline property", typeof stats.isOnline === "boolean");

  const serverUrl = client.getServerUrl();
  test("Server URL is configured", serverUrl.includes("tribecode.ai"));

  test("Client is enabled by default", client.isEnabled() === true);
}

// ---------------------------------------------------------------------------
// Test: Auth Token Management
// ---------------------------------------------------------------------------

async function testAuthTokens() {
  console.log("\n=== Auth Token Management ===");

  const client = new TelemetryClient();
  await client.init();

  // Check if auth file exists
  let hasAuth = false;
  try {
    await fs.access(_testing.AUTH_FILE);
    hasAuth = true;
  } catch {
    hasAuth = false;
  }

  if (!hasAuth) {
    skip("getAuthToken returns token", "No auth file present");
    skip("isAuthenticated returns true", "No auth file present");
    skip("getUserInfo returns user info", "No auth file present");
    return;
  }

  const token = await client.getAuthToken();
  test("getAuthToken returns token", typeof token === "string" && token.length > 0);

  const isAuth = client.isAuthenticated();
  test("isAuthenticated returns boolean", typeof isAuth === "boolean");

  const userInfo = client.getUserInfo();
  if (userInfo) {
    test("getUserInfo returns user info", typeof userInfo.email === "string");
    test("User info has id", typeof userInfo.id === "string");
    test("User info has name", typeof userInfo.name === "string");
  } else {
    skip("getUserInfo returns user info", "No user info available");
    skip("User info has id", "No user info available");
    skip("User info has name", "No user info available");
  }
}

// ---------------------------------------------------------------------------
// Test: Event Queue
// ---------------------------------------------------------------------------

async function testEventQueue() {
  console.log("\n=== Event Queue ===");

  // Start fresh
  await cleanup();

  const client = new TelemetryClient();
  await client.init();

  const initialStats = client.getStats();
  const initialQueueSize = initialStats.queueSize;

  // Send an event
  await client.send({
    type: "session_start",
    sessionId: "test-session-1",
    agentType: "clawdbot",
    payload: { test: true },
    tags: ["test"],
  });

  const afterSendStats = client.getStats();
  test("Queue size increases after send", afterSendStats.queueSize === initialQueueSize + 1);

  // Send multiple events
  await client.send({
    type: "interaction",
    sessionId: "test-session-1",
    agentType: "user",
    payload: { content: "Hello" },
    tags: [],
  });

  await client.send({
    type: "session_end",
    sessionId: "test-session-1",
    agentType: "clawdbot",
    payload: { status: "completed" },
    tags: [],
  });

  const finalStats = client.getStats();
  test("Queue size is correct after multiple sends", finalStats.queueSize === initialQueueSize + 3);

  // Test clear queue
  await client.clearQueue();
  const clearedStats = client.getStats();
  test("clearQueue empties the queue", clearedStats.queueSize === 0);
}

// ---------------------------------------------------------------------------
// Test: Convenience Methods
// ---------------------------------------------------------------------------

async function testConvenienceMethods() {
  console.log("\n=== Convenience Methods ===");

  await cleanup();

  const client = new TelemetryClient();
  await client.init();
  await client.clearQueue();

  // Test sendSessionStart
  await client.sendSessionStart("session-1", "clawdbot", "ClawdBot", "anthropic", ["test"]);
  let stats = client.getStats();
  test("sendSessionStart queues event", stats.queueSize === 1);

  // Test sendSessionEnd
  await client.sendSessionEnd("session-1", "clawdbot", "completed", { duration: 1000 });
  stats = client.getStats();
  test("sendSessionEnd queues event", stats.queueSize === 2);

  // Test sendMetric
  await client.sendMetric("session-1", "response_time", 150, { tool: "test" });
  stats = client.getStats();
  test("sendMetric queues event", stats.queueSize === 3);

  // Test sendError
  await client.sendError("session-1", "system", "test_error", "Test error message");
  stats = client.getStats();
  test("sendError queues event", stats.queueSize === 4);

  // Test sendInteraction
  await client.sendInteraction("session-1", {
    id: "entry-1",
    timestamp: Date.now(),
    sessionId: "session-1",
    actor: "user",
    actorName: "User",
    type: "message",
    content: "Test message",
  });
  stats = client.getStats();
  test("sendInteraction queues event", stats.queueSize === 5);
}

// ---------------------------------------------------------------------------
// Test: Flush Behavior
// ---------------------------------------------------------------------------

async function testFlushBehavior() {
  console.log("\n=== Flush Behavior ===");

  await cleanup();

  const client = new TelemetryClient();
  await client.init();
  await client.clearQueue();

  // Queue some events
  for (let i = 0; i < 5; i++) {
    await client.send({
      type: "metric",
      sessionId: `test-session-${i}`,
      agentType: "system",
      payload: { value: i },
      tags: [],
    });
  }

  const beforeFlush = client.getStats();
  test("Events queued before flush", beforeFlush.queueSize === 5);

  // Attempt flush (will fail without valid auth, but should not throw)
  let flushResult: { sent: number; failed: number } | null = null;
  try {
    flushResult = await client.flush();
    test("Flush completes without throwing", true);
  } catch {
    test("Flush completes without throwing", false);
  }

  // Check if we have auth
  const hasAuth = client.isAuthenticated();
  if (!hasAuth) {
    test("Flush returns zero sent without auth", flushResult?.sent === 0);
    skip("Flush sends events to server", "Not authenticated");
  } else {
    // With auth, flush might succeed or fail based on server availability
    test("Flush returns result object", flushResult !== null);
  }
}

// ---------------------------------------------------------------------------
// Test: Enable/Disable
// ---------------------------------------------------------------------------

async function testEnableDisable() {
  console.log("\n=== Enable/Disable ===");

  await cleanup();

  const client = new TelemetryClient();
  await client.init();
  await client.clearQueue();

  test("Client is enabled by default", client.isEnabled() === true);

  // Queue an event while enabled
  await client.send({
    type: "metric",
    sessionId: "test",
    agentType: "system",
    payload: {},
    tags: [],
  });

  let stats = client.getStats();
  test("Event queued when enabled", stats.queueSize === 1);

  // Disable and try to queue
  client.setEnabled(false);
  test("setEnabled(false) disables client", client.isEnabled() === false);

  await client.send({
    type: "metric",
    sessionId: "test",
    agentType: "system",
    payload: {},
    tags: [],
  });

  stats = client.getStats();
  test("Event NOT queued when disabled", stats.queueSize === 1);

  // Re-enable
  client.setEnabled(true);
  test("setEnabled(true) enables client", client.isEnabled() === true);

  await client.send({
    type: "metric",
    sessionId: "test",
    agentType: "system",
    payload: {},
    tags: [],
  });

  stats = client.getStats();
  test("Event queued after re-enabling", stats.queueSize === 2);
}

// ---------------------------------------------------------------------------
// Test: Singleton
// ---------------------------------------------------------------------------

async function testSingleton() {
  console.log("\n=== Singleton ===");

  const client1 = getTelemetryClient();
  const client2 = getTelemetryClient();

  test("getTelemetryClient returns same instance", client1 === client2);
}

// ---------------------------------------------------------------------------
// Test: Config Loading
// ---------------------------------------------------------------------------

async function testConfigLoading() {
  console.log("\n=== Config Loading ===");

  // Check if config file exists
  let hasConfig = false;
  try {
    await fs.access(_testing.CONFIG_FILE);
    hasConfig = true;
  } catch {
    hasConfig = false;
  }

  if (!hasConfig) {
    skip("Config file loaded", "No config file present");
    return;
  }

  const data = await fs.readFile(_testing.CONFIG_FILE, "utf-8");
  const config = JSON.parse(data);

  test("Config file parsed successfully", typeof config === "object");

  if (config.tutor_server_url) {
    const client = new TelemetryClient();
    await client.init();
    test("Server URL from config", client.getServerUrl() === config.tutor_server_url);
  } else {
    skip("Server URL from config", "tutor_server_url not in config");
  }
}

// ---------------------------------------------------------------------------
// Test: Queue Persistence
// ---------------------------------------------------------------------------

async function testQueuePersistence() {
  console.log("\n=== Queue Persistence ===");

  await cleanup();

  // Create client and queue events
  const client1 = new TelemetryClient();
  await client1.init();
  await client1.clearQueue();

  await client1.send({
    type: "session_start",
    sessionId: "persist-test",
    agentType: "clawdbot",
    payload: {},
    tags: [],
  });

  await client1.send({
    type: "session_end",
    sessionId: "persist-test",
    agentType: "clawdbot",
    payload: {},
    tags: [],
  });

  // Force save
  await client1.shutdown();

  // Wait a bit for save to complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Check if queue file exists
  let queueExists = false;
  try {
    await fs.access(_testing.QUEUE_FILE);
    queueExists = true;
  } catch {
    queueExists = false;
  }

  test("Queue file created after shutdown", queueExists);

  if (queueExists) {
    const data = await fs.readFile(_testing.QUEUE_FILE, "utf-8");
    const storage = JSON.parse(data);
    test("Queue file has correct structure", storage.version === 1);
    test("Queue file has events", Array.isArray(storage.queue));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("===========================================");
  console.log("  Telemetry Client Test Suite");
  console.log("===========================================");

  await testInitialization();
  await testAuthTokens();
  await testEventQueue();
  await testConvenienceMethods();
  await testFlushBehavior();
  await testEnableDisable();
  await testSingleton();
  await testConfigLoading();
  await testQueuePersistence();

  // Cleanup
  await cleanup();

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
