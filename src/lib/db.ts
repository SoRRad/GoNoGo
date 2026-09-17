import Database from 'better-sqlite3';
import { DB_PATH, ensureDataDirs } from './paths';

export type AnnotationStatus = 'drawn' | 'nothing_to_mark' | 'cannot_assess';
export type Confidence = 'low' | 'medium' | 'high';

export interface Surgeon {
  id: number;
  name: string;
  email: string;
  access_token: string;
  years_in_practice: number | null;
  cases_per_year: number | null;
  onboarded_at: string | null;
  created_at: string;
}

export interface Frame {
  id: number;
  filename: string;
  source_video: string | null;
  width: number;
  height: number;
  is_practice: number;
}

export interface Assignment {
  id: number;
  surgeon_id: number;
  frame_id: number;
  display_order: number;
  is_repeat: number;
  repeat_of_assignment_id: number | null;
}

export interface Annotation {
  id: number;
  assignment_id: number;
  surgeon_id: number;
  frame_id: number;
  status: AnnotationStatus | null;
  go_mask_path: string | null;
  nogo_mask_path: string | null;
  confidence: Confidence | null;
  seconds_spent: number;
  undo_count: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS surgeons (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  email             TEXT    NOT NULL UNIQUE,
  access_token      TEXT    NOT NULL UNIQUE,
  years_in_practice INTEGER,
  cases_per_year    INTEGER,
  onboarded_at      TEXT,
  created_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS frames (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT    NOT NULL UNIQUE,
  source_video TEXT,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  is_practice  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assignments (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  surgeon_id              INTEGER NOT NULL REFERENCES surgeons(id) ON DELETE CASCADE,
  frame_id                INTEGER NOT NULL REFERENCES frames(id)   ON DELETE CASCADE,
  display_order           INTEGER NOT NULL,
  is_repeat               INTEGER NOT NULL DEFAULT 0,
  repeat_of_assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
  UNIQUE (surgeon_id, display_order)
);

CREATE TABLE IF NOT EXISTS annotations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id  INTEGER NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
  surgeon_id     INTEGER NOT NULL REFERENCES surgeons(id) ON DELETE CASCADE,
  frame_id       INTEGER NOT NULL REFERENCES frames(id)   ON DELETE CASCADE,
  status         TEXT CHECK (status IN ('drawn', 'nothing_to_mark', 'cannot_assess')),
  go_mask_path   TEXT,
  nogo_mask_path TEXT,
  confidence     TEXT CHECK (confidence IN ('low', 'medium', 'high')),
  seconds_spent  INTEGER NOT NULL DEFAULT 0,
  undo_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  submitted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_assignments_queue      ON assignments (surgeon_id, display_order);
CREATE INDEX IF NOT EXISTS idx_annotations_surgeon    ON annotations (surgeon_id);
CREATE INDEX IF NOT EXISTS idx_annotations_frame      ON annotations (frame_id);
CREATE INDEX IF NOT EXISTS idx_annotations_submitted  ON annotations (surgeon_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_frames_practice        ON frames (is_practice);
`;

/**
 * Applies the schema to a connection. Exported so tests can build a database
 * from the same DDL the application runs, rather than a copy that can drift.
 */
export function applySchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
}

let instance: Database.Database | null = null;

// Next's dev server re-evaluates modules on every hot reload; without this the
// process would accumulate open handles to the same SQLite file.
const globalForDb = globalThis as unknown as { __sadiDb?: Database.Database };

export function getDb(): Database.Database {
  if (instance) return instance;
  if (globalForDb.__sadiDb) {
    instance = globalForDb.__sadiDb;
    return instance;
  }

  ensureDataDirs();
  const db = new Database(DB_PATH);
  // WAL lets the admin page read while a surgeon is autosaving.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applySchema(db);

  instance = db;
  globalForDb.__sadiDb = db;
  return db;
}
