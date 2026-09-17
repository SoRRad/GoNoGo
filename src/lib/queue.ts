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

/** The grouping key for a frame, for the purposes of spreading sets across videos. */
export function videoGroupKey(frame: Pick<Frame, 'id' | 'source_video'>): string {
  // A frame with no recorded source video has unknown provenance. It is given a
  // group of its own rather than being pooled with every other unknown frame,
  // because pooling would assert they share a patient, which is not known.
  return frame.source_video ?? `\u0000unknown:${frame.id}`;
}

export interface DealSummary {
  /** Frame ids for each surgeon, in deal order. Index matches the input order. */
  sets: number[][];
  /** Distinct source videos each surgeon's set draws from. */
  videosPerSurgeon: number[];
  /** Largest share of one surgeon's set contributed by a single video, 0..1. */
  maxVideoShare: number[];
}

/**
 * Deals each surgeon a unique set of frames, spread across as many source
 * videos as the pool allows.
 *
 * Why this is not a slice: frame ids follow ingest order, which follows video
 * order, so handing each surgeon a contiguous block gives each of them frames
 * from a different patient. Surgeon identity then becomes confounded with
 * patient, and any analysis that pools individual frames across surgeons cannot
 * separate rater effects from case effects.
 *
 * The deal is greedy: in each round every surgeon takes a frame from whichever
 * video is currently least represented in their own set, breaking ties towards
 * the video with the most frames left. That keeps every surgeon's set as even
 * across videos as the pool permits, and keeps the sets disjoint because each
 * frame is handed out exactly once.
 */
export function dealIndividualSets(
  frames: readonly Pick<Frame, 'id' | 'source_video'>[],
  surgeonCount: number,
  perSurgeon: number,
  seed: number,
): DealSummary {
  const sets: number[][] = Array.from({ length: surgeonCount }, () => []);
  const perSurgeonVideoCounts: Map<string, number>[] = Array.from(
    { length: surgeonCount },
    () => new Map<string, number>(),
  );

  if (surgeonCount <= 0 || perSurgeon <= 0) {
    return { sets, videosPerSurgeon: sets.map(() => 0), maxVideoShare: sets.map(() => 0) };
  }

  const rng = makeRng(seed);

  const groups = new Map<string, number[]>();
  for (const frame of frames) {
    const key = videoGroupKey(frame);
    const bucket = groups.get(key);
    if (bucket) bucket.push(frame.id);
    else groups.set(key, [frame.id]);
  }

  // Both the order videos are considered in and the order within a video are
  // shuffled, so a fixed seed reproduces the deal without ingest order leaking in.
  const videoKeys = seededShuffle([...groups.keys()], rng);
  const pools = new Map<string, number[]>(
    videoKeys.map((key) => [key, seededShuffle(groups.get(key)!, rng)]),
  );

  for (let round = 0; round < perSurgeon; round++) {
    for (let offset = 0; offset < surgeonCount; offset++) {
      // Rotate who picks first, so a video that runs dry mid-round does not
      // always short-change the same surgeon.
      const surgeon = (offset + round) % surgeonCount;
      const mine = perSurgeonVideoCounts[surgeon];

      let chosenKey: string | null = null;
      let chosenMine = Infinity;
      let chosenRemaining = -1;
      for (const key of videoKeys) {
        const remaining = pools.get(key)!.length;
        if (remaining === 0) continue;
        const held = mine.get(key) ?? 0;
        if (held < chosenMine || (held === chosenMine && remaining > chosenRemaining)) {
          chosenKey = key;
          chosenMine = held;
          chosenRemaining = remaining;
        }
      }
      if (chosenKey === null) break; // pool exhausted

      sets[surgeon].push(pools.get(chosenKey)!.pop()!);
      mine.set(chosenKey, chosenMine + 1);
    }
  }

  const videosPerSurgeon = perSurgeonVideoCounts.map((counts) => counts.size);
  const maxVideoShare = perSurgeonVideoCounts.map((counts, index) => {
    const total = sets[index].length;
    if (total === 0) return 0;
    return Math.max(...counts.values()) / total;
  });

  return { sets, videosPerSurgeon, maxVideoShare };
}

/** Distinct source videos spanned by a set of frames. */
export function countDistinctVideos(frames: readonly Pick<Frame, 'id' | 'source_video'>[]): number {
  return new Set(frames.map(videoGroupKey)).size;
}

export function selectCoreSet(pool: readonly Frame[], target: number): number[] {
  const rng = makeRng(CORE_SELECTION_SEED);
  return seededShuffle(pool.map((frame) => frame.id), rng)
    .slice(0, target)
    .sort((a, b) => a - b);
}
