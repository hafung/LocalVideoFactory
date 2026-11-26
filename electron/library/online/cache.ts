import type { DatabaseSync } from 'node:sqlite';
import { remotePageSchema, type RemotePage } from './adapter.js';

export class OnlineMediaCache {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS pixabay_search_cache (
      cache_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, response TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS online_media_cooldown (
      cache_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
    )`);
  }

  readPixabay(key: string, now: number): { page: RemotePage; expires: number } | undefined {
    const row = this.database.prepare('SELECT response, expires_at FROM pixabay_search_cache WHERE cache_key=? AND expires_at>?').get(key, now);
    if (typeof row?.response !== 'string' || typeof row.expires_at !== 'number') return;
    try {
      const page = remotePageSchema.safeParse(JSON.parse(row.response));
      if (page.success) return { page: page.data, expires: row.expires_at };
    } catch { /* Refresh unusable cached data. */ }
  }

  writePixabay(key: string, now: number, expiresAt: number, page: RemotePage) {
    this.database.prepare('DELETE FROM pixabay_search_cache WHERE expires_at<=?').run(now);
    this.database.prepare('INSERT OR REPLACE INTO pixabay_search_cache VALUES (?, ?, ?)').run(key, expiresAt, JSON.stringify(page));
  }

  retryAt(key: string, now: number) {
    return Number(this.database.prepare('SELECT expires_at FROM online_media_cooldown WHERE cache_key=? AND expires_at>?').get(key, now)?.expires_at ?? 0);
  }

  recordCooldown(key: string, now: number, expiresAt: number) {
    this.database.prepare('DELETE FROM online_media_cooldown WHERE expires_at<=?').run(now);
    this.database.prepare(`INSERT INTO online_media_cooldown VALUES (?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET expires_at=max(excluded.expires_at, expires_at)`).run(key, expiresAt);
  }
}
