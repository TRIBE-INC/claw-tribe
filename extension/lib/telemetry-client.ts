/**
 * Telemetry Client - Sends session and telemetry data to tutor.tribecode.ai
 *
 * Features:
 * - Event queue with batch flush
 * - Auth token management with auto-refresh
 * - Offline queue with retry
 * - Configurable telemetry server URL
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { Logger } from "./logger.js";
import type { ActorType, LogSession, InteractionEntry } from "./interaction-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelemetryEventType =
  | "session_start"
  | "session_end"
  | "session_sync"
  | "interaction"
  | "metric"
  | "error"
  | "auth";

export interface TelemetryEvent {
  id: string;
  type: TelemetryEventType;
  timestamp: number;
  sessionId: string;
  agentType: ActorType;
  agentName?: string;
  apiProvider?: string;
  payload: Record<string, unknown>;
  tags: string[];
}

export interface TelemetryConfig {
  serverUrl: string;
  batchSize: number;
  flushIntervalMs: number;
  maxRetries: number;
  maxQueueSize: number;
  enabled: boolean;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  exp: number;
  expires_in: number;
  iat: number;
  token_type: string;
  user_info: {
    id: string;
    email: string;
    name: string;
  };
}

export interface TelemetryStats {
  queueSize: number;
  sentCount: number;
  failedCount: number;
  lastFlushTime: number | null;
  lastError: string | null;
  isOnline: boolean;
}

interface QueuedEvent {
  event: TelemetryEvent;
  retries: number;
  addedAt: number;
}

interface TelemetryStorage {
  queue: QueuedEvent[];
  sentCount: number;
  failedCount: number;
  lastFlushTime: number | null;
  version: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join(homedir(), ".tribe", "config.json");
const AUTH_FILE = path.join(homedir(), ".tribe", "tutor", "auth.json");
const QUEUE_FILE = path.join(homedir(), ".tribe", "telemetry-queue.json");

const DEFAULT_CONFIG: TelemetryConfig = {
  serverUrl: "https://tutor.tribecode.ai",
  batchSize: 50,
  flushIntervalMs: 30000, // 30 seconds
  maxRetries: 3,
  maxQueueSize: 1000,
  enabled: true,
};

const STORAGE_VERSION = 1;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

// ---------------------------------------------------------------------------
// TelemetryClient Class
// ---------------------------------------------------------------------------

export class TelemetryClient {
  private queue: QueuedEvent[] = [];
  private config: TelemetryConfig = DEFAULT_CONFIG;
  private tokens: AuthTokens | null = null;
  private sentCount: number = 0;
  private failedCount: number = 0;
  private lastFlushTime: number | null = null;
  private lastError: string | null = null;
  private logger: Logger;
  private initialized: boolean = false;
  private flushTimeout: NodeJS.Timeout | null = null;
  private saveDebounce: NodeJS.Timeout | null = null;
  private isOnline: boolean = true;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger("telemetry-client");
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load config
      await this.loadConfig();

      // Load auth tokens
      await this.loadTokens();

      // Load persisted queue
      await this.loadQueue();

      this.initialized = true;

      // Start flush interval
      this.startFlushInterval();

      this.logger.debug(`Initialized with ${this.queue.length} queued events`);
    } catch (error) {
      this.logger.error(`Failed to initialize: ${error}`);
      this.initialized = true; // Mark as initialized to prevent repeated failures
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const data = await fs.readFile(CONFIG_FILE, "utf-8");
      const config = JSON.parse(data);

      if (config.tutor_server_url) {
        this.config.serverUrl = config.tutor_server_url;
      }

      // Load any telemetry-specific config
      if (config.telemetry) {
        this.config = { ...this.config, ...config.telemetry };
      }
    } catch {
      // Use defaults if config doesn't exist
    }
  }

  private async loadTokens(): Promise<void> {
    try {
      const data = await fs.readFile(AUTH_FILE, "utf-8");
      this.tokens = JSON.parse(data);
    } catch {
      this.tokens = null;
    }
  }

  private async loadQueue(): Promise<void> {
    try {
      const data = await fs.readFile(QUEUE_FILE, "utf-8");
      const storage: TelemetryStorage = JSON.parse(data);

      if (storage.version === STORAGE_VERSION) {
        this.queue = storage.queue || [];
        this.sentCount = storage.sentCount || 0;
        this.failedCount = storage.failedCount || 0;
        this.lastFlushTime = storage.lastFlushTime;
      }
    } catch {
      // No queue file, start fresh
    }
  }

  // ---------------------------------------------------------------------------
  // Auth Token Management
  // ---------------------------------------------------------------------------

  async getAuthToken(): Promise<string | null> {
    if (!this.tokens) {
      await this.loadTokens();
    }

    if (!this.tokens) {
      return null;
    }

    // Check if token needs refresh
    const now = Date.now();
    const expMs = this.tokens.exp * 1000;

    if (now >= expMs - TOKEN_REFRESH_BUFFER_MS) {
      await this.refreshToken();
    }

    return this.tokens?.access_token || null;
  }

  async refreshToken(): Promise<boolean> {
    if (!this.tokens?.refresh_token) {
      this.logger.warn("No refresh token available");
      return false;
    }

    try {
      const response = await fetch(`${this.config.serverUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          refresh_token: this.tokens.refresh_token,
        }),
      });

      if (!response.ok) {
        this.logger.error(`Token refresh failed: ${response.status}`);
        return false;
      }

      const newTokens: AuthTokens = await response.json();
      this.tokens = newTokens;

      // Save refreshed tokens
      await this.saveTokens();

      this.logger.debug("Token refreshed successfully");
      return true;
    } catch (error) {
      this.logger.error(`Token refresh error: ${error}`);
      return false;
    }
  }

  private async saveTokens(): Promise<void> {
    if (!this.tokens) return;

    try {
      const dir = path.dirname(AUTH_FILE);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(AUTH_FILE, JSON.stringify(this.tokens, null, 2));
    } catch (error) {
      this.logger.error(`Failed to save tokens: ${error}`);
    }
  }

  isAuthenticated(): boolean {
    if (!this.tokens) return false;
    const now = Date.now();
    const expMs = this.tokens.exp * 1000;
    return now < expMs;
  }

  getUserInfo(): AuthTokens["user_info"] | null {
    return this.tokens?.user_info || null;
  }

  // ---------------------------------------------------------------------------
  // Event Sending
  // ---------------------------------------------------------------------------

  async send(event: Omit<TelemetryEvent, "id" | "timestamp">): Promise<void> {
    await this.init();

    if (!this.config.enabled) {
      return;
    }

    const fullEvent: TelemetryEvent = {
      id: this.generateId(),
      timestamp: Date.now(),
      ...event,
    };

    const queuedEvent: QueuedEvent = {
      event: fullEvent,
      retries: 0,
      addedAt: Date.now(),
    };

    this.queue.push(queuedEvent);

    // Enforce max queue size
    if (this.queue.length > this.config.maxQueueSize) {
      this.queue = this.queue.slice(-this.config.maxQueueSize);
    }

    this.scheduleSave();

    // Flush immediately if batch size reached
    if (this.queue.length >= this.config.batchSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<{ sent: number; failed: number }> {
    await this.init();

    if (this.queue.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const token = await this.getAuthToken();
    if (!token) {
      this.logger.debug("No auth token, skipping flush");
      return { sent: 0, failed: 0 };
    }

    const batch = this.queue.slice(0, this.config.batchSize);
    let sent = 0;
    let failed = 0;

    try {
      const response = await fetch(`${this.config.serverUrl}/api/v1/telemetry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          events: batch.map((q) => q.event),
        }),
      });

      if (response.ok) {
        // Remove sent events from queue
        this.queue = this.queue.slice(batch.length);
        sent = batch.length;
        this.sentCount += sent;
        this.lastFlushTime = Date.now();
        this.lastError = null;
        this.isOnline = true;
        this.logger.debug(`Flushed ${sent} events`);
      } else if (response.status === 401) {
        // Auth failed, try refresh
        const refreshed = await this.refreshToken();
        if (refreshed) {
          // Retry flush
          return this.flush();
        }
        this.lastError = "Authentication failed";
        failed = batch.length;
      } else {
        this.lastError = `Server error: ${response.status}`;
        failed = batch.length;
        this.handleRetry(batch);
      }
    } catch (error) {
      this.isOnline = false;
      this.lastError = `Network error: ${error}`;
      failed = batch.length;
      this.handleRetry(batch);
    }

    this.failedCount += failed;
    this.scheduleSave();

    return { sent, failed };
  }

  private handleRetry(batch: QueuedEvent[]): void {
    // Increment retry count and move to back of queue
    for (const item of batch) {
      item.retries++;
      if (item.retries >= this.config.maxRetries) {
        // Drop after max retries
        const index = this.queue.indexOf(item);
        if (index > -1) {
          this.queue.splice(index, 1);
        }
        this.logger.warn(`Dropping event after ${item.retries} retries: ${item.event.type}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience Methods
  // ---------------------------------------------------------------------------

  async sendSessionStart(
    sessionId: string,
    agentType: ActorType,
    agentName?: string,
    apiProvider?: string,
    tags: string[] = []
  ): Promise<void> {
    await this.send({
      type: "session_start",
      sessionId,
      agentType,
      agentName,
      apiProvider,
      payload: {
        platform: process.platform,
        nodeVersion: process.version,
      },
      tags,
    });
  }

  async sendSessionEnd(
    sessionId: string,
    agentType: ActorType,
    status: "completed" | "error",
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.send({
      type: "session_end",
      sessionId,
      agentType,
      payload: {
        status,
        ...metadata,
      },
      tags: [],
    });
  }

  async sendInteraction(
    sessionId: string,
    entry: InteractionEntry
  ): Promise<void> {
    await this.send({
      type: "interaction",
      sessionId,
      agentType: entry.actor,
      agentName: entry.actorName,
      payload: {
        entryId: entry.id,
        entryType: entry.type,
        content: entry.content.substring(0, 1000), // Truncate large content
        target: entry.target,
        metadata: entry.metadata,
      },
      tags: [],
    });
  }

  async sendMetric(
    sessionId: string,
    metricType: string,
    value: number,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.send({
      type: "metric",
      sessionId,
      agentType: "system",
      payload: {
        metricType,
        value,
        ...metadata,
      },
      tags: [],
    });
  }

  async sendError(
    sessionId: string,
    agentType: ActorType,
    errorType: string,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.send({
      type: "error",
      sessionId,
      agentType,
      payload: {
        errorType,
        message: message.substring(0, 500),
        ...metadata,
      },
      tags: ["error"],
    });
  }

  async syncSession(session: LogSession): Promise<boolean> {
    await this.init();

    const token = await this.getAuthToken();
    if (!token) {
      this.logger.debug("No auth token, cannot sync session");
      return false;
    }

    try {
      const response = await fetch(`${this.config.serverUrl}/api/v1/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: session.id,
          startTime: session.startTime,
          endTime: session.endTime,
          status: session.status,
          agents: session.agents,
          entries: session.entries,
          metadata: {
            platform: process.platform,
            nodeVersion: process.version,
          },
        }),
      });

      if (response.ok) {
        this.logger.debug(`Session ${session.id} synced successfully`);
        return true;
      } else {
        this.logger.error(`Session sync failed: ${response.status}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Session sync error: ${error}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Stats & Status
  // ---------------------------------------------------------------------------

  getStats(): TelemetryStats {
    return {
      queueSize: this.queue.length,
      sentCount: this.sentCount,
      failedCount: this.failedCount,
      lastFlushTime: this.lastFlushTime,
      lastError: this.lastError,
      isOnline: this.isOnline,
    };
  }

  getServerUrl(): string {
    return this.config.serverUrl;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async saveQueue(): Promise<void> {
    try {
      const dir = path.dirname(QUEUE_FILE);
      await fs.mkdir(dir, { recursive: true });

      const storage: TelemetryStorage = {
        queue: this.queue,
        sentCount: this.sentCount,
        failedCount: this.failedCount,
        lastFlushTime: this.lastFlushTime,
        version: STORAGE_VERSION,
      };

      await fs.writeFile(QUEUE_FILE, JSON.stringify(storage, null, 2));
    } catch (error) {
      this.logger.error(`Failed to save queue: ${error}`);
    }
  }

  private scheduleSave(): void {
    if (this.saveDebounce) {
      clearTimeout(this.saveDebounce);
    }
    this.saveDebounce = setTimeout(() => {
      this.saveQueue().catch(() => {});
    }, 5000); // Debounce saves by 5 seconds
  }

  private startFlushInterval(): void {
    if (this.flushTimeout) {
      clearInterval(this.flushTimeout);
    }
    this.flushTimeout = setInterval(() => {
      if (this.queue.length > 0) {
        this.flush().catch(() => {});
      }
    }, this.config.flushIntervalMs);
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private generateId(): string {
    return `tel-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  async clearQueue(): Promise<void> {
    this.queue = [];
    await this.saveQueue();
  }

  async shutdown(): Promise<void> {
    // Flush remaining events
    await this.flush();

    // Clear intervals
    if (this.flushTimeout) {
      clearInterval(this.flushTimeout);
    }
    if (this.saveDebounce) {
      clearTimeout(this.saveDebounce);
    }

    // Final save
    await this.saveQueue();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let telemetryClientInstance: TelemetryClient | null = null;

export function getTelemetryClient(logger?: Logger): TelemetryClient {
  if (!telemetryClientInstance) {
    telemetryClientInstance = new TelemetryClient(logger);
    telemetryClientInstance.init().catch(() => {});
  }
  return telemetryClientInstance;
}

// Export for testing
export const _testing = {
  CONFIG_FILE,
  AUTH_FILE,
  QUEUE_FILE,
  DEFAULT_CONFIG,
  TOKEN_REFRESH_BUFFER_MS,
};
