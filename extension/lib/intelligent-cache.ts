// ---------------------------------------------------------------------------
// Intelligent Cache — two-tier caching (L1 in-memory + L2 disk) with
// namespace-based TTLs for TRIBE data.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheNamespace = "kb" | "sessions" | "search";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface DiskCacheFormat {
  version: 1;
  entries: Record<string, { value: unknown; expiresAt: number }>;
}

// TTLs per namespace (milliseconds)
const L1_TTLS: Record<CacheNamespace, number> = {
  kb: 10 * 60_000,       // 10 minutes
  sessions: 1 * 60_000,  // 1 minute
  search: 5 * 60_000,    // 5 minutes
};

const L2_TTLS: Record<CacheNamespace, number> = {
  kb: 30 * 60_000,       // 30 minutes
  sessions: 5 * 60_000,  // 5 minutes
  search: 15 * 60_000,   // 15 minutes
};

const CACHE_DIR = join(homedir(), ".tribe", "cache");
const DEBOUNCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Cache key helper
// ---------------------------------------------------------------------------

function cacheKey(namespace: CacheNamespace, key: string): string {
  const hash = createHash("md5").update(key).digest("hex");
  return `${namespace}:${hash}`;
}

function diskPath(namespace: CacheNamespace): string {
  return join(CACHE_DIR, `${namespace}.json`);
}

// ---------------------------------------------------------------------------
// IntelligentCache class
// ---------------------------------------------------------------------------

export class IntelligentCache {
  private l1 = new Map<string, CacheEntry<unknown>>();
  private l2Dirty = new Set<CacheNamespace>();
  private l2Timers = new Map<CacheNamespace, ReturnType<typeof setTimeout>>();
  private l2Loaded = new Set<CacheNamespace>();

  /**
   * Get a cached value. Checks L1 first, then L2 (disk).
   * Promotes L2 hits to L1.
   */
  async get<T>(namespace: CacheNamespace, key: string): Promise<T | undefined> {
    const ck = cacheKey(namespace, key);

    // Check L1
    const l1Entry = this.l1.get(ck);
    if (l1Entry && l1Entry.expiresAt > Date.now()) {
      return l1Entry.value as T;
    }
    if (l1Entry) {
      this.l1.delete(ck); // expired
    }

    // Check L2
    const l2Value = await this.l2Get<T>(namespace, ck);
    if (l2Value !== undefined) {
      // Promote to L1
      this.l1.set(ck, {
        value: l2Value,
        expiresAt: Date.now() + L1_TTLS[namespace],
      });
      return l2Value;
    }

    return undefined;
  }

  /**
   * Set a cached value in both L1 and L2 (debounced disk write).
   */
  set<T>(namespace: CacheNamespace, key: string, value: T): void {
    const ck = cacheKey(namespace, key);

    // Write to L1 immediately
    this.l1.set(ck, {
      value,
      expiresAt: Date.now() + L1_TTLS[namespace],
    });

    // Schedule debounced L2 write
    this.l2Dirty.add(namespace);
    this.scheduleL2Write(namespace);
  }

  /**
   * Invalidate all entries in a namespace.
   */
  async invalidate(namespace: CacheNamespace): Promise<void> {
    // Clear L1 entries for this namespace
    const prefix = `${namespace}:`;
    for (const key of this.l1.keys()) {
      if (key.startsWith(prefix)) {
        this.l1.delete(key);
      }
    }

    // Delete L2 file
    try {
      await rm(diskPath(namespace), { force: true });
    } catch {
      // ignore
    }
    this.l2Loaded.delete(namespace);
  }

  /**
   * Clear all caches.
   */
  async invalidateAll(): Promise<void> {
    this.l1.clear();
    this.l2Loaded.clear();
    for (const ns of ["kb", "sessions", "search"] as CacheNamespace[]) {
      try {
        await rm(diskPath(ns), { force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Return cache statistics.
   */
  stats(): { l1Size: number; namespaces: CacheNamespace[] } {
    const namespaces = new Set<CacheNamespace>();
    for (const key of this.l1.keys()) {
      const ns = key.split(":")[0] as CacheNamespace;
      namespaces.add(ns);
    }
    return {
      l1Size: this.l1.size,
      namespaces: Array.from(namespaces),
    };
  }

  // -----------------------------------------------------------------------
  // L2 (disk) operations
  // -----------------------------------------------------------------------

  private async ensureCacheDir(): Promise<void> {
    try {
      await mkdir(CACHE_DIR, { recursive: true });
    } catch {
      // ignore
    }
  }

  private async l2Get<T>(namespace: CacheNamespace, ck: string): Promise<T | undefined> {
    await this.loadL2(namespace);

    // Re-check L1 after load (l2 load populates L1-accessible entries)
    // Actually, we need to read from disk directly
    try {
      const data = await readFile(diskPath(namespace), "utf-8");
      const parsed: DiskCacheFormat = JSON.parse(data);
      if (parsed.version !== 1) return undefined;

      const entry = parsed.entries[ck];
      if (!entry || entry.expiresAt <= Date.now()) return undefined;
      return entry.value as T;
    } catch {
      return undefined;
    }
  }

  private async loadL2(namespace: CacheNamespace): Promise<void> {
    if (this.l2Loaded.has(namespace)) return;
    this.l2Loaded.add(namespace);
    // Just mark as loaded — actual reads happen on-demand in l2Get
  }

  private scheduleL2Write(namespace: CacheNamespace): void {
    if (this.l2Timers.has(namespace)) return; // already scheduled

    const timer = setTimeout(async () => {
      this.l2Timers.delete(namespace);
      if (!this.l2Dirty.has(namespace)) return;
      this.l2Dirty.delete(namespace);

      await this.flushL2(namespace);
    }, DEBOUNCE_MS);

    this.l2Timers.set(namespace, timer);
  }

  private async flushL2(namespace: CacheNamespace): Promise<void> {
    await this.ensureCacheDir();

    // Read existing disk entries
    let existing: DiskCacheFormat = { version: 1, entries: {} };
    try {
      const data = await readFile(diskPath(namespace), "utf-8");
      existing = JSON.parse(data);
      if (existing.version !== 1) existing = { version: 1, entries: {} };
    } catch {
      // no existing file
    }

    // Merge L1 entries for this namespace into disk
    const prefix = `${namespace}:`;
    const now = Date.now();
    for (const [key, entry] of this.l1.entries()) {
      if (key.startsWith(prefix) && entry.expiresAt > now) {
        existing.entries[key] = {
          value: entry.value,
          expiresAt: now + L2_TTLS[namespace],
        };
      }
    }

    // Prune expired entries
    for (const [key, entry] of Object.entries(existing.entries)) {
      if (entry.expiresAt <= now) {
        delete existing.entries[key];
      }
    }

    try {
      await writeFile(diskPath(namespace), JSON.stringify(existing), "utf-8");
    } catch {
      // ignore write failures
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let cacheInstance: IntelligentCache | null = null;

export function getCache(): IntelligentCache {
  if (!cacheInstance) {
    cacheInstance = new IntelligentCache();
  }
  return cacheInstance;
}

// Exported for unit testing only.
export const _testing = { IntelligentCache, cacheKey, L1_TTLS, L2_TTLS };
