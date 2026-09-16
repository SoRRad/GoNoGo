import type Database from 'better-sqlite3';
import type { Frame } from './db';

export const PRACTICE_TARGET = 5;
export const CORE_TARGET = 50;
export const INDIVIDUAL_TARGET = 70;
export const REPEAT_FRACTION = 0.1;
/** A repeat must sit at least this many positions after its first showing. */
export const MIN_REPEAT_GAP = 30;
/** Fixed so that re-running `npm run assign` reproduces the same core set. */
export const CORE_SELECTION_SEED = 0x5AD1;

/** mulberry32: small, fast, and reproducible from a 32-bit seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface QueueEntry {
  frameId: number;
  isRepeat: boolean;
  /** Index into the pre-repeat sequence that this entry duplicates. */
  repeatOfSequenceIndex: number | null;
}

/**
 * Inserts repeats into an already shuffled sequence of non-practice frames.
 *
 * Indices are recomputed from the live array before each insertion, and an
 * insertion can only ever push a later element further back, so once a pair
 * satisfies the minimum gap it keeps satisfying it.
 */
export function insertRepeats(
  frameIds: readonly number[],
  repeatCount: number,
  rng: () => number,
  minGap: number = MIN_REPEAT_GAP,
): QueueEntry[] {
  const sequence: QueueEntry[] = frameIds.map((frameId, index) => ({
    frameId,
    isRepeat: false,
    repeatOfSequenceIndex: index,
  }));

  // Candidates are originals early enough that a legal slot exists for them.
  const candidates = seededShuffle(
    sequence.map((_, index) => index).filter((index) => index + minGap <= frameIds.length + repeatCount),
    rng,
  );

  let placed = 0;
  for (const originalIndex of candidates) {
    if (placed >= repeatCount) break;
    const currentIndex = sequence.findIndex(
      (entry) => !entry.isRepeat && entry.repeatOfSequenceIndex === originalIndex,
    );
    if (currentIndex < 0) continue;

    const earliest = currentIndex + minGap;
    if (earliest > sequence.length) continue;
    const slot = earliest + Math.floor(rng() * (sequence.length - earliest + 1));
    sequence.splice(slot, 0, {
      frameId: sequence[currentIndex].frameId,
      isRepeat: true,
      repeatOfSequenceIndex: originalIndex,
    });
    placed++;
  }

  return sequence;
}

export interface BuiltQueue {
  entries: QueueEntry[];
  practiceCount: number;
  coreCount: number;
  individualCount: number;
  repeatCount: number;
}

/**
 * Builds one surgeon's queue: practice frames first in a fixed order, then a
 * per-surgeon shuffle of their core and individual frames with repeats woven in.
 */
export function buildQueue(
  practiceFrameIds: readonly number[],
  coreFrameIds: readonly number[],
  individualFrameIds: readonly number[],
  surgeonSeed: number,
): BuiltQueue {
  const rng = makeRng(surgeonSeed);
  const nonPractice = seededShuffle([...coreFrameIds, ...individualFrameIds], rng);
  const repeatCount = Math.round(nonPractice.length * REPEAT_FRACTION);
  const withRepeats = insertRepeats(nonPractice, repeatCount, rng);

  const practice: QueueEntry[] = practiceFrameIds.map((frameId) => ({
    frameId,
    isRepeat: false,
    repeatOfSequenceIndex: null,
  }));

  return {
    entries: [...practice, ...withRepeats],
    practiceCount: practice.length,
    coreCount: coreFrameIds.length,
    individualCount: individualFrameIds.length,
    repeatCount: withRepeats.filter((entry) => entry.isRepeat).length,
  };
}

/**
 * The core set is the frames deliberately shown to everybody. Once assignments
 * exist it is read back off them, so adding a surgeon later never reshuffles
 * which frames are core.
 */
export function deriveEstablishedCoreSet(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT a.frame_id AS frameId
         FROM assignments a
         JOIN frames f ON f.id = a.frame_id
        WHERE f.is_practice = 0
        GROUP BY a.frame_id
       HAVING COUNT(DISTINCT a.surgeon_id) >= 2
        ORDER BY a.frame_id`,
    )
    .all() as { frameId: number }[];
  return rows.map((row) => row.frameId);
}

/** Non-practice frames already handed to exactly one surgeon as individual work. */
export function frameIdsAlreadyIndividual(db: Database.Database, coreSet: Set<number>): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.frame_id AS frameId
         FROM assignments a
         JOIN frames f ON f.id = a.frame_id
        WHERE f.is_practice = 0`,
    )
    .all() as { frameId: number }[];
  const used = new Set<number>();
  for (const row of rows) if (!coreSet.has(row.frameId)) used.add(row.frameId);
  return used;
}

export function selectCoreSet(pool: readonly Frame[], target: number): number[] {
  const rng = makeRng(CORE_SELECTION_SEED);
  return seededShuffle(pool.map((frame) => frame.id), rng)
    .slice(0, target)
    .sort((a, b) => a - b);
}
