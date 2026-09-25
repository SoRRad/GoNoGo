import fs from 'fs';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from '@/lib/db';
import type { Surgeon } from '@/lib/db';
import {
  ManageError,
  addSurgeon,
  compactQueue,
  frameImpact,
  normaliseSurgeonInput,
  pauseSurgeon,
  removeFrame,
  removeSurgeon,
  replaceLink,
  resumeSurgeon,
  surgeonImpact,
} from '@/lib/manage';
import { CORE_TARGET, INDIVIDUAL_TARGET } from '@/lib/queue';
import { framePath } from '@/lib/paths';
import { encodeSurgeonSession, surgeonFromSession } from '@/lib/session';
import { addAnnotation, addAssignment, rect, testDb, writeMask } from './helpers';

/** 5 practice frames plus `study` frames spread over videos of 20, like a real ingest. */
function loadPool(db: Database.Database, study: number): void {
  const insert = db.prepare(
    'INSERT INTO frames (filename, source_video, width, height, is_practice) VALUES (?, ?, 8, 8, ?)',
  );
  for (let i = 0; i < 5; i++) insert.run(`practice_${i}.jpg`, null, 1);
  for (let i = 0; i < study; i++) {
    const video = `V${1 + Math.floor(i / 20)}`;
    insert.run(`${video}__${video}_frame_${i % 20}.jpg`, video, 0);
  }
}

function queueFrames(db: Database.Database, surgeonId: number): number[] {
  return (
    db
      .prepare(
        `SELECT a.frame_id AS id FROM assignments a JOIN frames f ON f.id = a.frame_id
          WHERE a.surgeon_id = ? AND f.is_practice = 0 AND a.is_repeat = 0`,
      )
      .all(surgeonId) as { id: number }[]
  ).map((row) => row.id);
}

function coreOf(db: Database.Database): Set<number> {
  return new Set(
    (db.prepare('SELECT id FROM frames WHERE is_core = 1').all() as { id: number }[]).map((row) => row.id),
  );
}

function displayOrders(db: Database.Database, surgeonId: number): number[] {
  return (
    db
      .prepare('SELECT display_order AS d FROM assignments WHERE surgeon_id = ? ORDER BY display_order')
      .all(surgeonId) as { d: number }[]
  ).map((row) => row.d);
}

let db: Database.Database;
beforeEach(() => {
  db = testDb();
});

describe('addSurgeon', () => {
  it('adds a surgeon with a full-size queue in one step', () => {
    loadPool(db, 495);
    const { surgeon, queue } = addSurgeon(db, { name: '  Dr  Simon   Laplante ', email: 'Laplante.Simon@Mayo.edu' });
    expect(surgeon.name).toBe('Dr Simon Laplante');
    expect(surgeon.email).toBe('laplante.simon@mayo.edu');
    expect(surgeon.access_token).toHaveLength(32);
    expect(queue).toMatchObject({ practice: 5, core: CORE_TARGET, individual: INDIVIDUAL_TARGET, repeats: 12, total: 137 });
    expect(displayOrders(db, surgeon.id)).toEqual([...Array(137).keys()]);
  });

  it('gives every surgeon the same core set and their own individual frames', () => {
    loadPool(db, 495);
    const a = addSurgeon(db, { name: 'A', email: 'a@x.org' }).surgeon;
    const b = addSurgeon(db, { name: 'B', email: 'b@x.org' }).surgeon;
    const core = coreOf(db);
    expect(core.size).toBe(CORE_TARGET);
    const individualA = queueFrames(db, a.id).filter((id) => !core.has(id));
    const individualB = queueFrames(db, b.id).filter((id) => !core.has(id));
    expect(queueFrames(db, a.id).filter((id) => core.has(id))).toHaveLength(CORE_TARGET);
    expect(queueFrames(db, b.id).filter((id) => core.has(id))).toHaveLength(CORE_TARGET);
    expect(individualA.filter((id) => individualB.includes(id))).toEqual([]);
  });

  it('refuses when the unused pool is short, and leaves nothing behind', () => {
    loadPool(db, 150); // 50 core + 70 for the first surgeon leaves 30
    addSurgeon(db, { name: 'First', email: 'first@x.org' });
    const before = (db.prepare('SELECT COUNT(*) AS n FROM assignments').get() as { n: number }).n;
    let error: unknown;
    try {
      addSurgeon(db, { name: 'Second', email: 'second@x.org' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ManageError);
    expect((error as ManageError).code).toBe('not_enough_images');
    expect((error as ManageError).detail).toEqual({ available: 30, needed: INDIVIDUAL_TARGET });
    expect(db.prepare('SELECT 1 FROM surgeons WHERE email = ?').get('second@x.org')).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM assignments').get() as { n: number }).n).toBe(before);
  });

  it('refuses a duplicate email whatever its case, and bad input', () => {
    loadPool(db, 495);
    addSurgeon(db, { name: 'A', email: 'a@x.org' });
    expect(() => addSurgeon(db, { name: 'Again', email: 'A@X.org' })).toThrow(/already a surgeon/);
    expect(() => normaliseSurgeonInput({ name: '   ', email: 'a@x.org' })).toThrow(ManageError);
    expect(() => normaliseSurgeonInput({ name: 'A', email: 'not-an-email' })).toThrow(ManageError);
    expect(() => normaliseSurgeonInput({ name: 'A\u0007', email: 'a@x.org' })).toThrow(ManageError);
  });

  it('refuses when no study images are loaded', () => {
    expect(() => addSurgeon(db, { name: 'A', email: 'a@x.org' })).toThrow(/No study images/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM surgeons').get()).toEqual({ n: 0 });
  });
});

describe('the core set outlives the surgeons who were dealt it', () => {
  it('survives the pilot plan: testers, a real surgeon, testers removed, a frame removed, then another surgeon', () => {
    loadPool(db, 495);
    const tester1 = addSurgeon(db, { name: 'Tester 1', email: 't1@x.org' }).surgeon;
    const tester2 = addSurgeon(db, { name: 'Tester 2', email: 't2@x.org' }).surgeon;
    const laplante = addSurgeon(db, { name: 'Dr Laplante', email: 'l@x.org' }).surgeon;
    const core = coreOf(db);

    removeSurgeon(db, tester1.id);
    removeSurgeon(db, tester2.id);
    // With one surgeon left nothing is shared, which is exactly when an
    // inferred core set used to forget itself.
    const spare = (
      db
        .prepare('SELECT id FROM frames WHERE is_practice = 0 AND is_core = 0 AND id NOT IN (SELECT frame_id FROM assignments)')
        .get() as { id: number }
    ).id;
    removeFrame(db, spare); // changes the pool a reshuffle would draw from

    const next = addSurgeon(db, { name: 'Next', email: 'n@x.org' }).surgeon;
    const nextFrames = queueFrames(db, next.id);
    const laplanteFrames = queueFrames(db, laplante.id);
    expect(new Set(nextFrames.filter((id) => core.has(id)))).toEqual(core);
    expect(new Set(laplanteFrames.filter((id) => core.has(id)))).toEqual(core);
    const laplanteOwn = laplanteFrames.filter((id) => !core.has(id));
    expect(nextFrames.filter((id) => laplanteOwn.includes(id))).toEqual([]);
  });
});

describe('pause, resume and replacing a link', () => {
  function lookup(id: number) {
    return db.prepare('SELECT * FROM surgeons WHERE id = ?').get(id) as Surgeon | undefined;
  }

  it('a paused surgeon keeps their queue but their session stops working', () => {
    loadPool(db, 495);
    const surgeon = addSurgeon(db, { name: 'A', email: 'a@x.org' }).surgeon;
    const session = encodeSurgeonSession(surgeon, 1);
    expect(surgeonFromSession(session, lookup)?.id).toBe(surgeon.id);

    const paused = pauseSurgeon(db, surgeon.id);
    expect(paused.paused_at).not.toBeNull();
    expect(surgeonFromSession(session, lookup)).toBeNull();
    expect(displayOrders(db, surgeon.id)).toHaveLength(137);

    expect(resumeSurgeon(db, surgeon.id).paused_at).toBeNull();
    expect(surgeonFromSession(session, lookup)?.id).toBe(surgeon.id);
  });

  it('pausing twice keeps the first pause time', () => {
    loadPool(db, 495);
    const surgeon = addSurgeon(db, { name: 'A', email: 'a@x.org' }).surgeon;
    const first = pauseSurgeon(db, surgeon.id).paused_at;
    expect(pauseSurgeon(db, surgeon.id).paused_at).toBe(first);
  });

  it('a new link locks out every browser that opened the old one', () => {
    loadPool(db, 495);
    const surgeon = addSurgeon(db, { name: 'A', email: 'a@x.org' }).surgeon;
    const oldSession = encodeSurgeonSession(surgeon, 1);
    const renewed = replaceLink(db, surgeon.id);
    expect(renewed.access_token).not.toBe(surgeon.access_token);
    expect(db.prepare('SELECT 1 FROM surgeons WHERE access_token = ?').get(surgeon.access_token)).toBeUndefined();
    expect(surgeonFromSession(oldSession, lookup)).toBeNull();
    expect(surgeonFromSession(encodeSurgeonSession(renewed, 2), lookup)?.id).toBe(surgeon.id);
  });

  it('refuses sessions in the old format and for unknown surgeons', () => {
    loadPool(db, 495);
    const surgeon = addSurgeon(db, { name: 'A', email: 'a@x.org' }).surgeon;
    expect(surgeonFromSession(`s1:${surgeon.id}:123`, lookup)).toBeNull();
    expect(surgeonFromSession(encodeSurgeonSession({ ...surgeon, id: 999 }, 1), lookup)).toBeNull();
    expect(surgeonFromSession(null, lookup)).toBeNull();
  });

  it('reports a surgeon that no longer exists', () => {
    expect(() => pauseSurgeon(db, 42)).toThrow(ManageError);
    expect(() => replaceLink(db, 42)).toThrow(ManageError);
  });
});

describe('removeSurgeon', () => {
  it('deletes their queue, annotations and mask files, and frees their frames', () => {
    loadPool(db, 190); // exactly 50 core + 70 + 70
    const keep = addSurgeon(db, { name: 'Keep', email: 'k@x.org' }).surgeon;
    const tester = addSurgeon(db, { name: 'Tester', email: 't@x.org' }).surgeon;
    expect(() => addSurgeon(db, { name: 'Late', email: 'late@x.org' })).toThrow(ManageError);

    const [assignment] = db
      .prepare('SELECT id, frame_id AS frameId FROM assignments WHERE surgeon_id = ? LIMIT 1')
      .all(tester.id) as { id: number; frameId: number }[];
    const mask = writeMask(assignment.frameId, tester.id, 'nogo', 8, 8, rect(8, 8, 0, 0, 4, 4), assignment.id);
    addAnnotation(db, { assignmentId: assignment.id, surgeonId: tester.id, frameId: assignment.frameId, status: 'drawn', nogoMaskPath: mask });

    expect(surgeonImpact(db, tester.id)).toMatchObject({ queued: 137, annotations: 1, submitted: 1, maskFiles: 1 });
    const impact = removeSurgeon(db, tester.id);
    expect(impact.submitted).toBe(1);
    expect(db.prepare('SELECT 1 FROM surgeons WHERE id = ?').get(tester.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE surgeon_id = ?').get(tester.id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM annotations WHERE surgeon_id = ?').get(tester.id)).toEqual({ n: 0 });
    expect(fs.existsSync(`${process.env.DATA_DIR}/${mask}`)).toBe(false);

    // The tester's 70 frames are free again, so a late surgeon now fits.
    expect(addSurgeon(db, { name: 'Late', email: 'late@x.org' }).queue.individual).toBe(INDIVIDUAL_TARGET);
    expect(displayOrders(db, keep.id)).toHaveLength(137);
  });
});

describe('removeFrame', () => {
  it('takes a frame out of every queue, repeats included, and renumbers them without gaps', () => {
    loadPool(db, 495);
    const a = addSurgeon(db, { name: 'A', email: 'a@x.org' }).surgeon;
    const b = addSurgeon(db, { name: 'B', email: 'b@x.org' }).surgeon;

    // A core frame that A also has as a hidden repeat, so both showings go.
    const repeated = db
      .prepare(
        `SELECT a.frame_id AS frameId FROM assignments a JOIN frames f ON f.id = a.frame_id
          WHERE a.surgeon_id = ? AND a.is_repeat = 1 AND f.is_core = 1 LIMIT 1`,
      )
      .get(a.id) as { frameId: number } | undefined;
    const target = repeated?.frameId ?? [...coreOf(db)][0];
    fs.writeFileSync(framePath((db.prepare('SELECT filename FROM frames WHERE id = ?').get(target) as { filename: string }).filename), 'x');

    const orderBefore = (surgeonId: number) =>
      (
        db
          .prepare('SELECT id FROM assignments WHERE surgeon_id = ? AND frame_id != ? ORDER BY display_order')
          .all(surgeonId, target) as { id: number }[]
      ).map((row) => row.id);
    const beforeA = orderBefore(a.id);
    const beforeB = orderBefore(b.id);

    const impact = frameImpact(db, target);
    expect(impact.surgeons).toBe(2);
    const removed = removeFrame(db, target);
    expect(removed.queued).toBe(impact.queued);

    for (const [surgeonId, before] of [[a.id, beforeA], [b.id, beforeB]] as const) {
      const after = (
        db.prepare('SELECT id FROM assignments WHERE surgeon_id = ? ORDER BY display_order').all(surgeonId) as { id: number }[]
      ).map((row) => row.id);
      expect(after).toEqual(before); // same entries, same order
      expect(displayOrders(db, surgeonId)).toEqual([...Array(before.length).keys()]); // contiguous
    }
    expect(db.prepare('SELECT 1 FROM frames WHERE id = ?').get(target)).toBeUndefined();
    expect(coreOf(db).size).toBe(CORE_TARGET - 1);
    expect(fs.existsSync(framePath(removed.frame.filename))).toBe(false);
  });

  it('deletes the annotations and masks drawn on it, and nothing else', () => {
    loadPool(db, 495);
    const a = addSurgeon(db, { name: 'A', email: 'a@x.org' }).surgeon;
    const rows = db
      .prepare('SELECT id, frame_id AS frameId FROM assignments WHERE surgeon_id = ? AND is_repeat = 0 ORDER BY display_order LIMIT 2')
      .all(a.id) as { id: number; frameId: number }[];
    const masks = rows.map((row) => {
      const mask = writeMask(row.frameId, a.id, 'go', 8, 8, rect(8, 8, 0, 0, 2, 2), row.id);
      addAnnotation(db, { assignmentId: row.id, surgeonId: a.id, frameId: row.frameId, status: 'drawn', goMaskPath: mask });
      return mask;
    });
    removeFrame(db, rows[0].frameId);
    expect(fs.existsSync(`${process.env.DATA_DIR}/${masks[0]}`)).toBe(false);
    expect(fs.existsSync(`${process.env.DATA_DIR}/${masks[1]}`)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM annotations').get()).toEqual({ n: 1 });
  });

  it('reports a frame that no longer exists', () => {
    expect(() => removeFrame(db, 7)).toThrow(ManageError);
  });
});

describe('compactQueue', () => {
  it('closes gaps anywhere without colliding on the unique position', () => {
    loadPool(db, 10);
    const surgeon = db
      .prepare('INSERT INTO surgeons (name, email, access_token, created_at) VALUES (?, ?, ?, ?)')
      .run('A', 'a@x.org', 't', '2026-01-01');
    const id = Number(surgeon.lastInsertRowid);
    for (const [frameId, order] of [[1, 0], [2, 2], [3, 3], [4, 7], [5, 8]]) addAssignment(db, id, frameId, order);
    compactQueue(db, id);
    expect(
      db.prepare('SELECT frame_id AS f, display_order AS d FROM assignments ORDER BY display_order').all(),
    ).toEqual([{ f: 1, d: 0 }, { f: 2, d: 1 }, { f: 3, d: 2 }, { f: 4, d: 3 }, { f: 5, d: 4 }]);
  });
});

describe('migrating a database from before these columns existed', () => {
  it('adds paused_at, and records the core set from the queues already dealt', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    old.exec(`
      CREATE TABLE surgeons (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL UNIQUE, years_in_practice INTEGER, cases_per_year INTEGER, onboarded_at TEXT,
        created_at TEXT NOT NULL);
      CREATE TABLE frames (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, source_video TEXT,
        width INTEGER NOT NULL, height INTEGER NOT NULL, is_practice INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE assignments (id INTEGER PRIMARY KEY AUTOINCREMENT,
        surgeon_id INTEGER NOT NULL REFERENCES surgeons(id) ON DELETE CASCADE,
        frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE, display_order INTEGER NOT NULL,
        is_repeat INTEGER NOT NULL DEFAULT 0, repeat_of_assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
        UNIQUE (surgeon_id, display_order));
    `);
    old.exec(`INSERT INTO surgeons (name, email, access_token, created_at) VALUES ('A','a@x','ta','t'), ('B','b@x','tb','t');
              INSERT INTO frames (filename, width, height, is_practice) VALUES ('p',8,8,1), ('shared',8,8,0), ('onlyA',8,8,0), ('free',8,8,0);
              INSERT INTO assignments (surgeon_id, frame_id, display_order) VALUES (1,1,0),(1,2,1),(1,3,2),(2,1,0),(2,2,1);`);

    applySchema(old);
    applySchema(old); // a second start must change nothing

    expect(old.prepare('SELECT paused_at FROM surgeons WHERE id = 1').get()).toEqual({ paused_at: null });
    expect(old.prepare('SELECT filename FROM frames WHERE is_core = 1').all()).toEqual([{ filename: 'shared' }]);
  });
});
