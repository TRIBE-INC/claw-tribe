/**
 * Session Sync - Synchronize local sessions with tutor.tribecode.ai
 *
 * Features:
 * - Upload local sessions to server
 * - Download sessions from server
 * - Track sync state
 * - Conflict resolution (last-write-wins)
 * - Offline queue with retry
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { Logger } from "./logger.js";
import { getTelemetryClient } from "./telemetry-client.js";
import { getInteractionLogger, type LogSession, type InteractionEntry } from "./interaction-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  errors: string[];
  lastSyncTime: number;
}

export interface SyncState {
  lastSyncTime: number;
  pendingSessions: string[];
  syncedSessions: Record<string, number>; // sessionId -> lastSyncedAt
  version: number;
}

export interface ServerSession {
  id: string;
  userId: string;
  startTime: number;
  endTime?: number;
  status: "active" | "completed" | "error";
  agents: string[];
  entryCount: number;
  lastModified: number;
}

export interface SyncConfig {
  serverUrl: string;
  autoSync: boolean;
  syncIntervalMs: number;
  maxSessionsPerSync: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOGS_DIR = path.join(homedir(), ".tribe", "logs");
const SYNC_STATE_FILE = path.join(homedir(), ".tribe", "sync-state.json");
const CONFIG_FILE = path.join(homedir(), ".tribe", "config.json");
const AUTH_FILE = path.join(homedir(), ".tribe", "tutor", "auth.json");

const DEFAULT_CONFIG: SyncConfig = {
  serverUrl: "https://tutor.tribecode.ai",
  autoSync: false,
  syncIntervalMs: 5 * 60 * 1000, // 5 minutes
  maxSessionsPerSync: 10,
};

const STORAGE_VERSION = 1;

// ---------------------------------------------------------------------------
// SessionSync Class
// ---------------------------------------------------------------------------

export class SessionSync {
  private config: SyncConfig = DEFAULT_CONFIG;
  private state: SyncState;
  private logger: Logger;
  private initialized: boolean = false;
  private syncInterval: NodeJS.Timeout | null = null;
  private isSyncing: boolean = false;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger("session-sync");
    this.state = {
      lastSyncTime: 0,
      pendingSessions: [],
      syncedSessions: {},
      version: STORAGE_VERSION,
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.loadConfig();
      await this.loadState();
      this.initialized = true;

      if (this.config.autoSync) {
        this.startAutoSync();
      }

      this.logger.debug("Session sync initialized");
    } catch (error) {
      this.logger.error(`Failed to initialize: ${error}`);
      this.initialized = true;
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const data = await fs.readFile(CONFIG_FILE, "utf-8");
      const config = JSON.parse(data);

      if (config.tutor_server_url) {
        this.config.serverUrl = config.tutor_server_url;
      }

      if (config.sync) {
        this.config = { ...this.config, ...config.sync };
      }
    } catch {
      // Use defaults
    }
  }

  private async loadState(): Promise<void> {
    try {
      const data = await fs.readFile(SYNC_STATE_FILE, "utf-8");
      const state: SyncState = JSON.parse(data);

      if (state.version === STORAGE_VERSION) {
        this.state = state;
      }
    } catch {
      // Use fresh state
    }
  }

  private async saveState(): Promise<void> {
    try {
      const dir = path.dirname(SYNC_STATE_FILE);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(SYNC_STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (error) {
      this.logger.error(`Failed to save sync state: ${error}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  private async getAuthToken(): Promise<string | null> {
    try {
      const data = await fs.readFile(AUTH_FILE, "utf-8");
      const auth = JSON.parse(data);

      if (auth.exp * 1000 < Date.now()) {
        return null; // Token expired
      }

      return auth.access_token;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Sync Operations
  // ---------------------------------------------------------------------------

  async sync(options: { force?: boolean } = {}): Promise<SyncResult> {
    await this.init();

    if (this.isSyncing) {
      return {
        uploaded: 0,
        downloaded: 0,
        conflicts: 0,
        errors: ["Sync already in progress"],
        lastSyncTime: this.state.lastSyncTime,
      };
    }

    this.isSyncing = true;
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      errors: [],
      lastSyncTime: Date.now(),
    };

    try {
      const token = await this.getAuthToken();
      if (!token) {
        result.errors.push("Not authenticated");
        return result;
      }

      // Get local sessions
      const localSessions = await this.getLocalSessions();

      // Get server sessions list
      const serverSessions = await this.fetchServerSessionsList(token);

      // Find sessions to upload (local but not on server or modified)
      const toUpload = this.findSessionsToUpload(localSessions, serverSessions, options.force);

      // Find sessions to download (on server but not local or newer)
      const toDownload = this.findSessionsToDownload(localSessions, serverSessions);

      // Upload sessions
      for (const sessionId of toUpload.slice(0, this.config.maxSessionsPerSync)) {
        try {
          const session = await this.loadLocalSession(sessionId);
          if (session) {
            await this.uploadSession(session, token);
            this.state.syncedSessions[sessionId] = Date.now();
            result.uploaded++;
          }
        } catch (error) {
          result.errors.push(`Upload ${sessionId}: ${error}`);
        }
      }

      // Download sessions
      for (const sessionId of toDownload.slice(0, this.config.maxSessionsPerSync)) {
        try {
          const session = await this.downloadSession(sessionId, token);
          if (session) {
            await this.saveLocalSession(session);
            this.state.syncedSessions[sessionId] = Date.now();
            result.downloaded++;
          }
        } catch (error) {
          result.errors.push(`Download ${sessionId}: ${error}`);
        }
      }

      // Update state
      this.state.lastSyncTime = result.lastSyncTime;
      this.state.pendingSessions = toUpload.slice(this.config.maxSessionsPerSync);
      await this.saveState();

      this.logger.debug(`Sync complete: ${result.uploaded} up, ${result.downloaded} down`);
    } catch (error) {
      result.errors.push(`Sync failed: ${error}`);
    } finally {
      this.isSyncing = false;
    }

    return result;
  }

  private async getLocalSessions(): Promise<Map<string, { mtime: number; entryCount: number }>> {
    const sessions = new Map<string, { mtime: number; entryCount: number }>();

    try {
      const files = await fs.readdir(LOGS_DIR);

      for (const file of files) {
        if (file.startsWith("session-") && file.endsWith(".json")) {
          const filepath = path.join(LOGS_DIR, file);
          try {
            const stat = await fs.stat(filepath);
            const data = await fs.readFile(filepath, "utf-8");
            const session: LogSession = JSON.parse(data);

            sessions.set(session.id, {
              mtime: stat.mtimeMs,
              entryCount: session.entries.length,
            });
          } catch {
            // Skip invalid files
          }
        }
      }

      // Also check current session
      try {
        const currentPath = path.join(LOGS_DIR, "current-session.json");
        const stat = await fs.stat(currentPath);
        const data = await fs.readFile(currentPath, "utf-8");
        const session: LogSession = JSON.parse(data);

        sessions.set(session.id, {
          mtime: stat.mtimeMs,
          entryCount: session.entries.length,
        });
      } catch {
        // No current session
      }
    } catch {
      // LOGS_DIR doesn't exist
    }

    return sessions;
  }

  private async fetchServerSessionsList(token: string): Promise<ServerSession[]> {
    try {
      const response = await fetch(`${this.config.serverUrl}/api/v1/sessions`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const data = await response.json();
      return data.sessions || [];
    } catch (error) {
      this.logger.error(`Failed to fetch server sessions: ${error}`);
      return [];
    }
  }

  private findSessionsToUpload(
    local: Map<string, { mtime: number; entryCount: number }>,
    server: ServerSession[],
    force?: boolean
  ): string[] {
    const serverMap = new Map(server.map((s) => [s.id, s]));
    const toUpload: string[] = [];

    for (const [sessionId, localInfo] of local) {
      const serverSession = serverMap.get(sessionId);
      const lastSynced = this.state.syncedSessions[sessionId] || 0;

      if (force) {
        toUpload.push(sessionId);
      } else if (!serverSession) {
        // Session doesn't exist on server
        toUpload.push(sessionId);
      } else if (localInfo.mtime > lastSynced) {
        // Local session modified since last sync
        toUpload.push(sessionId);
      }
    }

    return toUpload;
  }

  private findSessionsToDownload(
    local: Map<string, { mtime: number; entryCount: number }>,
    server: ServerSession[]
  ): string[] {
    const toDownload: string[] = [];

    for (const serverSession of server) {
      const localInfo = local.get(serverSession.id);
      const lastSynced = this.state.syncedSessions[serverSession.id] || 0;

      if (!localInfo) {
        // Session doesn't exist locally
        toDownload.push(serverSession.id);
      } else if (serverSession.lastModified > lastSynced && serverSession.entryCount > localInfo.entryCount) {
        // Server has newer version with more entries
        toDownload.push(serverSession.id);
      }
    }

    return toDownload;
  }

  private async loadLocalSession(sessionId: string): Promise<LogSession | null> {
    // Try current session first
    try {
      const currentPath = path.join(LOGS_DIR, "current-session.json");
      const data = await fs.readFile(currentPath, "utf-8");
      const session: LogSession = JSON.parse(data);
      if (session.id === sessionId) {
        return session;
      }
    } catch {
      // Not current session
    }

    // Try archived session
    try {
      const archivePath = path.join(LOGS_DIR, `session-${sessionId}.json`);
      const data = await fs.readFile(archivePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private async saveLocalSession(session: LogSession): Promise<void> {
    const filepath = path.join(LOGS_DIR, `session-${session.id}.json`);
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.writeFile(filepath, JSON.stringify(session, null, 2));
  }

  private async uploadSession(session: LogSession, token: string): Promise<void> {
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
          syncedAt: Date.now(),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }
  }

  private async downloadSession(sessionId: string, token: string): Promise<LogSession | null> {
    const response = await fetch(`${this.config.serverUrl}/api/v1/sessions/${sessionId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const data = await response.json();
    return data.session || null;
  }

  // ---------------------------------------------------------------------------
  // Auto Sync
  // ---------------------------------------------------------------------------

  startAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    this.syncInterval = setInterval(() => {
      this.sync().catch((error) => {
        this.logger.error(`Auto-sync failed: ${error}`);
      });
    }, this.config.syncIntervalMs);

    this.logger.debug(`Auto-sync started (interval: ${this.config.syncIntervalMs}ms)`);
  }

  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  getSyncStatus(): {
    lastSyncTime: number;
    pendingCount: number;
    syncedCount: number;
    autoSyncEnabled: boolean;
    isSyncing: boolean;
  } {
    return {
      lastSyncTime: this.state.lastSyncTime,
      pendingCount: this.state.pendingSessions.length,
      syncedCount: Object.keys(this.state.syncedSessions).length,
      autoSyncEnabled: this.config.autoSync,
      isSyncing: this.isSyncing,
    };
  }

  async markSessionPending(sessionId: string): Promise<void> {
    await this.init();

    if (!this.state.pendingSessions.includes(sessionId)) {
      this.state.pendingSessions.push(sessionId);
      await this.saveState();
    }
  }

  async markSessionSynced(sessionId: string): Promise<void> {
    await this.init();

    this.state.syncedSessions[sessionId] = Date.now();
    this.state.pendingSessions = this.state.pendingSessions.filter((id) => id !== sessionId);
    await this.saveState();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let sessionSyncInstance: SessionSync | null = null;

export function getSessionSync(logger?: Logger): SessionSync {
  if (!sessionSyncInstance) {
    sessionSyncInstance = new SessionSync(logger);
    sessionSyncInstance.init().catch(() => {});
  }
  return sessionSyncInstance;
}

// Export for testing
export const _testing = {
  LOGS_DIR,
  SYNC_STATE_FILE,
  CONFIG_FILE,
  DEFAULT_CONFIG,
};
