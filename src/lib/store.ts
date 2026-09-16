import { getDb } from './db';
import type { Annotation, AnnotationStatus, Confidence, Frame, Surgeon } from './db';
import { nowIso } from './ids';

export interface QueueItem {
  assignmentId: number;
  index: number;
  frameId: number;
  filename: string;
  width: number;
  height: number;
  isPractice: boolean;
  status: AnnotationStatus | null;
  confidence: Confidence | null;
  hasGoMask: boolean;
  hasNogoMask: boolean;
  secondsSpent: number;
  undoCount: number;
  submitted: boolean;
}

export interface QueueState {
  total: number;
  /** Position of the first unsubmitted assignment, or `total` when finished. */
  currentIndex: number;
  completed: number;
  practiceTotal: number;
  finished: boolean;
}

export function getSurgeonByToken(token: string): Surgeon | undefined {
  return getDb().prepare('SELECT * FROM surgeons WHERE access_token = ?').get(token) as Surgeon | undefined;
}

export function getSurgeonById(id: number): Surgeon | undefined {
  return getDb().prepare('SELECT * FROM surgeons WHERE id = ?').get(id) as Surgeon | undefined;
}

export function getQueueState(surgeonId: number): QueueState {
  const db = getDb();
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE surgeon_id = ?').get(surgeonId) as { n: number }
  ).n;
  const completed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM annotations an
           JOIN assignments a ON a.id = an.assignment_id
          WHERE a.surgeon_id = ? AND an.submitted_at IS NOT NULL`,
      )
      .get(surgeonId) as { n: number }
  ).n;
  const practiceTotal = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM assignments a
           JOIN frames f ON f.id = a.frame_id
          WHERE a.surgeon_id = ? AND f.is_practice = 1`,
      )
      .get(surgeonId) as { n: number }
  ).n;

  // The queue position is the first gap, not the count: a surgeon can step back
  // and resubmit an earlier frame without moving the frontier.
  const next = db
    .prepare(
      `SELECT a.display_order AS displayOrder
         FROM assignments a
         LEFT JOIN annotations an ON an.assignment_id = a.id
        WHERE a.surgeon_id = ? AND (an.id IS NULL OR an.submitted_at IS NULL)
        ORDER BY a.display_order
        LIMIT 1`,
    )
    .get(surgeonId) as { displayOrder: number } | undefined;

  const currentIndex = next ? next.displayOrder : total;
  return { total, currentIndex, completed, practiceTotal, finished: currentIndex >= total && total > 0 };
}

export function getQueueItem(surgeonId: number, index: number): QueueItem | null {
  const row = getDb()
    .prepare(
      `SELECT a.id            AS assignmentId,
              a.display_order AS displayOrder,
              f.id            AS frameId,
              f.filename      AS filename,
              f.width         AS width,
              f.height        AS height,
              f.is_practice   AS isPractice,
              an.status       AS status,
              an.confidence   AS confidence,
              an.go_mask_path AS goMaskPath,
              an.nogo_mask_path AS nogoMaskPath,
              an.seconds_spent  AS secondsSpent,
              an.undo_count     AS undoCount,
              an.submitted_at   AS submittedAt
         FROM assignments a
         JOIN frames f ON f.id = a.frame_id
         LEFT JOIN annotations an ON an.assignment_id = a.id
        WHERE a.surgeon_id = ? AND a.display_order = ?`,
    )
    .get(surgeonId, index) as
    | {
        assignmentId: number;
        displayOrder: number;
        frameId: number;
        filename: string;
        width: number;
        height: number;
        isPractice: number;
        status: AnnotationStatus | null;
        confidence: Confidence | null;
        goMaskPath: string | null;
        nogoMaskPath: string | null;
        secondsSpent: number | null;
        undoCount: number | null;
        submittedAt: string | null;
      }
    | undefined;

  if (!row) return null;
  return {
    assignmentId: row.assignmentId,
    index: row.displayOrder,
    frameId: row.frameId,
    filename: row.filename,
    width: row.width,
    height: row.height,
    isPractice: row.isPractice === 1,
    status: row.status,
    confidence: row.confidence,
    hasGoMask: Boolean(row.goMaskPath),
    hasNogoMask: Boolean(row.nogoMaskPath),
    secondsSpent: row.secondsSpent ?? 0,
    undoCount: row.undoCount ?? 0,
    submitted: Boolean(row.submittedAt),
  };
}

/** The assignment row itself, used to authorise mask and frame reads. */
export function getAssignmentForSurgeon(surgeonId: number, assignmentId: number) {
  return getDb()
    .prepare('SELECT * FROM assignments WHERE id = ? AND surgeon_id = ?')
    .get(assignmentId, surgeonId) as
    | { id: number; surgeon_id: number; frame_id: number; display_order: number }
    | undefined;
}

export function surgeonCanSeeFrame(surgeonId: number, frameId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM assignments WHERE surgeon_id = ? AND frame_id = ? LIMIT 1')
    .get(surgeonId, frameId) as { ok: number } | undefined;
  return Boolean(row);
}

export function getFrame(frameId: number): Frame | undefined {
  return getDb().prepare('SELECT * FROM frames WHERE id = ?').get(frameId) as Frame | undefined;
}

export function getAnnotationByAssignment(assignmentId: number): Annotation | undefined {
  return getDb().prepare('SELECT * FROM annotations WHERE assignment_id = ?').get(assignmentId) as
    | Annotation
    | undefined;
}

export interface UpsertInput {
  assignmentId: number;
  surgeonId: number;
  frameId: number;
  status: AnnotationStatus | null;
  goMaskPath: string | null;
  nogoMaskPath: string | null;
  confidence: Confidence | null;
  secondsSpent: number;
  undoCount: number;
  submit: boolean;
}

/** One annotation row per assignment; every save upserts onto the same row. */
export function upsertAnnotation(input: UpsertInput): Annotation {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO annotations (
        assignment_id, surgeon_id, frame_id, status, go_mask_path, nogo_mask_path,
        confidence, seconds_spent, undo_count, created_at, updated_at, submitted_at
     ) VALUES (
        @assignmentId, @surgeonId, @frameId, @status, @goMaskPath, @nogoMaskPath,
        @confidence, @secondsSpent, @undoCount, @now, @now, @submittedAt
     )
     ON CONFLICT (assignment_id) DO UPDATE SET
        status         = excluded.status,
        go_mask_path   = excluded.go_mask_path,
        nogo_mask_path = excluded.nogo_mask_path,
        confidence     = excluded.confidence,
        -- Time and undos accumulate across resumed sittings.
        seconds_spent  = MAX(annotations.seconds_spent, excluded.seconds_spent),
        undo_count     = MAX(annotations.undo_count, excluded.undo_count),
        updated_at     = excluded.updated_at,
        submitted_at   = COALESCE(excluded.submitted_at, annotations.submitted_at)`,
  ).run({
    assignmentId: input.assignmentId,
    surgeonId: input.surgeonId,
    frameId: input.frameId,
    status: input.status,
    goMaskPath: input.goMaskPath,
    nogoMaskPath: input.nogoMaskPath,
    confidence: input.confidence,
    secondsSpent: Math.max(0, Math.round(input.secondsSpent)),
    undoCount: Math.max(0, Math.round(input.undoCount)),
    now,
    submittedAt: input.submit ? now : null,
  });
  return getAnnotationByAssignment(input.assignmentId)!;
}

export function completeOnboarding(surgeonId: number, yearsInPractice: number, casesPerYear: number): void {
  getDb()
    .prepare(
      `UPDATE surgeons
          SET years_in_practice = ?, cases_per_year = ?, onboarded_at = COALESCE(onboarded_at, ?)
        WHERE id = ?`,
    )
    .run(yearsInPractice, casesPerYear, nowIso(), surgeonId);
}
