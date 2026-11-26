import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MediaAssetSchema, type MediaAsset } from '../../shared/library.js';

interface AssetRow {
  id: string; file_path: string; fingerprint: string; type: string; name: string;
  duration_ms: number | null; width: number | null; height: number | null; fps: number | null;
  has_audio: number; thumbnail_path: string | null; tags_json: string; transcript: string;
  license_json: string; created_at: string; metadata_json: string;
}

function fromRow(row: AssetRow): MediaAsset {
  return MediaAssetSchema.parse({
    id: row.id, filePath: row.file_path, fingerprint: row.fingerprint, type: row.type, name: row.name,
    durationMs: row.duration_ms ?? undefined, width: row.width ?? undefined, height: row.height ?? undefined,
    fps: row.fps ?? undefined, hasAudio: Boolean(row.has_audio), thumbnailPath: row.thumbnail_path ?? undefined,
    tags: JSON.parse(row.tags_json), transcript: row.transcript, license: JSON.parse(row.license_json), createdAt: row.created_at,
    manualTags: JSON.parse(row.tags_json), ...JSON.parse(row.metadata_json || '{}')
  });
}

export class LibraryDatabase {
  readonly sqlite: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, name TEXT NOT NULL, duration_ms INTEGER, width INTEGER, height INTEGER,
        fps REAL, has_audio INTEGER NOT NULL, thumbnail_path TEXT, tags_json TEXT NOT NULL,
        transcript TEXT NOT NULL DEFAULT '', license_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(asset_id UNINDEXED, name, tags, transcript, tokenize='unicode61');
      CREATE INDEX IF NOT EXISTS assets_type_idx ON assets(type);
    `);
    const columns = this.sqlite.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'metadata_json')) {
      this.sqlite.exec("ALTER TABLE assets ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'; PRAGMA user_version=2;");
    }
    this.sqlite.exec('PRAGMA user_version=2;');
  }

  upsert(assetInput: MediaAsset): MediaAsset {
    const asset = MediaAssetSchema.parse(assetInput);
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      this.sqlite.prepare(`INSERT INTO assets
        (id,file_path,fingerprint,type,name,duration_ms,width,height,fps,has_audio,thumbnail_path,tags_json,transcript,license_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path,fingerprint=excluded.fingerprint,type=excluded.type,
        name=excluded.name,duration_ms=excluded.duration_ms,width=excluded.width,height=excluded.height,fps=excluded.fps,
        has_audio=excluded.has_audio,thumbnail_path=excluded.thumbnail_path,tags_json=excluded.tags_json,
        transcript=excluded.transcript,license_json=excluded.license_json`).run(
        asset.id, asset.filePath, asset.fingerprint, asset.type, asset.name, asset.durationMs ?? null,
        asset.width ?? null, asset.height ?? null, asset.fps ?? null, asset.hasAudio ? 1 : 0,
        asset.thumbnailPath ?? null, JSON.stringify(asset.tags), asset.transcript,
        JSON.stringify(asset.license), asset.createdAt
      );
      this.sqlite.prepare('UPDATE assets SET metadata_json=? WHERE id=?').run(
        JSON.stringify({ autoTags: asset.autoTags, manualTags: asset.manualTags, additionalLicenses: asset.additionalLicenses }), asset.id);
      this.sqlite.prepare('DELETE FROM asset_fts WHERE asset_id=?').run(asset.id);
      this.sqlite.prepare('INSERT INTO asset_fts(asset_id,name,tags,transcript) VALUES(?,?,?,?)')
        .run(asset.id, asset.name, asset.tags.join(' '), asset.transcript);
      this.sqlite.exec('COMMIT');
      return asset;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  byId(id: string): MediaAsset | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assets WHERE id=?').get(id) as AssetRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  byFingerprint(fingerprint: string): MediaAsset | undefined {
    const row = this.sqlite.prepare('SELECT * FROM assets WHERE fingerprint=?').get(fingerprint) as AssetRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(limit = 100): MediaAsset[] {
    return (this.sqlite.prepare('SELECT * FROM assets ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as AssetRow[]).map(fromRow);
  }

  remove(id: string): void {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      this.sqlite.prepare('DELETE FROM asset_fts WHERE asset_id=?').run(id);
      this.sqlite.prepare('DELETE FROM assets WHERE id=?').run(id);
      this.sqlite.exec('COMMIT');
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }

  fullText(query: string, limit = 100): Array<{ asset: MediaAsset; bm25: number }> {
    const rows = this.sqlite.prepare(`SELECT assets.*, bm25(asset_fts) AS rank FROM asset_fts
      JOIN assets ON assets.id=asset_fts.asset_id WHERE asset_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(query, limit) as unknown as Array<AssetRow & { rank: number }>;
    return rows.map(row => ({ asset: fromRow(row), bm25: row.rank }));
  }

  close(): void { this.sqlite.close(); }
}
