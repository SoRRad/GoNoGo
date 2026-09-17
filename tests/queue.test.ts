import { describe, expect, it } from 'vitest';
import {
  CORE_TARGET,
  MIN_REPEAT_GAP,
  buildQueue,
  countDistinctVideos,
  dealIndividualSets,
  insertRepeats,
  makeRng,
  seededShuffle,
  selectCoreSet,
  videoGroupKey,
} from '@/lib/queue';
import type { Frame } from '@/lib/db';

function frame(id: number, sourceVideo: string | null): Frame {
  return { id, filename: `f${id}.png`, source_video: sourceVideo, width: 960, height: 540, is_practice: 0 };
}

/** A pool of `videos` videos with `per` frames each, ids in ingest order. */
function pool(videos: number, per: number): Frame[] {
  const frames: Frame[] = [];
  let id = 1;
  for (let v = 0; v < videos; v++) {
    for (let i = 0; i < per; i++) frames.push(frame(id++, `case${String(v + 1).padStart(2, '0')}`));
  }
  return frames;
}

describe('seededShuffle', () => {
  it('is deterministic for a fixed seed', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const a = seededShuffle(items, makeRng(1234));
    const b = seededShuffle(items, makeRng(1234));
    expect(a).toEqual(b);
  });

  it('differs between seeds', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(seededShuffle(items, makeRng(1))).not.toEqual(seededShuffle(items, makeRng(2)));
  });

  it('is a true permutation, keeping every element exactly once', () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled = seededShuffle(items, makeRng(seed));
      expect(shuffled).toHaveLength(items.length);
      expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    }
  });

  it('does not mutate its input', () => {
    const items = [1, 2, 3, 4, 5];
    seededShuffle(items, makeRng(7));
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('insertRepeats', () => {
  it('respects the minimum gap across 400 seeds', () => {
    const frameIds = Array.from({ length: 120 }, (_, i) => i + 1);
    let worstGap = Infinity;

    for (let seed = 1; seed <= 400; seed++) {
      const sequence = insertRepeats(frameIds, 12, makeRng(seed));
      const firstSeen = new Map<number, number>();

      sequence.forEach((entry, index) => {
        if (!entry.isRepeat) {
          if (!firstSeen.has(entry.frameId)) firstSeen.set(entry.frameId, index);
          return;
        }
        const original = firstSeen.get(entry.frameId);
        // A repeat can never appear before the frame's first showing.
        expect(original).toBeDefined();
        worstGap = Math.min(worstGap, index - original!);
      });
    }

    expect(worstGap).toBeGreaterThanOrEqual(MIN_REPEAT_GAP);
  });

  it('places the requested number of repeats', () => {
    const frameIds = Array.from({ length: 120 }, (_, i) => i + 1);
    const sequence = insertRepeats(frameIds, 12, makeRng(99));
    expect(sequence.filter((entry) => entry.isRepeat)).toHaveLength(12);
    expect(sequence).toHaveLength(132);
  });

  it('never shows a frame more than twice', () => {
    const frameIds = Array.from({ length: 120 }, (_, i) => i + 1);
    for (let seed = 1; seed <= 50; seed++) {
      const counts = new Map<number, number>();
      for (const entry of insertRepeats(frameIds, 12, makeRng(seed))) {
        counts.set(entry.frameId, (counts.get(entry.frameId) ?? 0) + 1);
      }
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    }
  });

  it('repeats a frame that was shown, never a fresh one', () => {
    const frameIds = Array.from({ length: 120 }, (_, i) => i + 1);
    const sequence = insertRepeats(frameIds, 12, makeRng(5));
    for (const entry of sequence) {
      if (entry.isRepeat) expect(frameIds).toContain(entry.frameId);
    }
  });
});

describe('buildQueue', () => {
  const practice = [901, 902, 903, 904, 905];
  const core = Array.from({ length: 50 }, (_, i) => i + 1);
  const individual = Array.from({ length: 70 }, (_, i) => i + 51);

  it('always places every practice frame first, in order', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { entries } = buildQueue(practice, core, individual, seed);
      expect(entries.slice(0, practice.length).map((entry) => entry.frameId)).toEqual(practice);
      // And no practice frame appears later in the queue.
      expect(entries.slice(practice.length).some((entry) => practice.includes(entry.frameId))).toBe(false);
    }
  });

  it('reports the expected counts', () => {
    const queue = buildQueue(practice, core, individual, 42);
    expect(queue.practiceCount).toBe(5);
    expect(queue.coreCount).toBe(50);
    expect(queue.individualCount).toBe(70);
    expect(queue.repeatCount).toBe(12); // 10% of the 120 non-practice frames
    expect(queue.entries).toHaveLength(5 + 50 + 70 + 12);
  });

  it('points every repeat at an earlier position showing the same frame', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { entries } = buildQueue(practice, core, individual, seed);
      const firstSeen = new Map<number, number>();
      entries.forEach((entry, index) => {
        if (entry.isRepeat) {
          const original = firstSeen.get(entry.frameId);
          expect(original).toBeDefined();
          expect(original!).toBeLessThan(index);
          expect(index - original!).toBeGreaterThanOrEqual(MIN_REPEAT_GAP);
        } else if (!firstSeen.has(entry.frameId)) {
          firstSeen.set(entry.frameId, index);
        }
      });
    }
  });

  it('is reproducible for a seed and differs between seeds', () => {
    const a = buildQueue(practice, core, individual, 7).entries.map((entry) => entry.frameId);
    const b = buildQueue(practice, core, individual, 7).entries.map((entry) => entry.frameId);
    const c = buildQueue(practice, core, individual, 8).entries.map((entry) => entry.frameId);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('selectCoreSet', () => {
  it('returns the same set for a fixed seed, sorted', () => {
    const frames = pool(6, 40);
    const a = selectCoreSet(frames, CORE_TARGET);
    const b = selectCoreSet(frames, CORE_TARGET);
    expect(a).toEqual(b);
    expect(a).toHaveLength(CORE_TARGET);
    expect(a).toEqual([...a].sort((x, y) => x - y));
  });

  it('does not simply take the first N by id', () => {
    const frames = pool(6, 40);
    const selected = selectCoreSet(frames, CORE_TARGET);
    const firstN = frames.slice(0, CORE_TARGET).map((f) => f.id);
    expect(selected).not.toEqual(firstN);
  });
});

describe('videoGroupKey', () => {
  it('groups frames that share a source video', () => {
    expect(videoGroupKey(frame(1, 'case01'))).toBe(videoGroupKey(frame(2, 'case01')));
  });

  it('gives each frame of unknown provenance its own group', () => {
    // Pooling unknown-provenance frames would assert they share a patient.
    expect(videoGroupKey(frame(1, null))).not.toBe(videoGroupKey(frame(2, null)));
  });
});

describe('dealIndividualSets', () => {
  it('keeps the sets disjoint and correctly sized', () => {
    const frames = pool(8, 60);
    const { sets } = dealIndividualSets(frames, 6, 70, 1234);

    expect(sets).toHaveLength(6);
    for (const set of sets) expect(set).toHaveLength(70);

    const all = sets.flat();
    expect(new Set(all).size).toBe(all.length);
    const available = new Set(frames.map((f) => f.id));
    for (const id of all) expect(available.has(id)).toBe(true);
  });

  it('spreads every surgeon across many videos instead of one block', () => {
    const frames = pool(8, 60); // 480 frames, 8 videos
    const { sets, videosPerSurgeon, maxVideoShare } = dealIndividualSets(frames, 6, 70, 1234);

    for (let i = 0; i < sets.length; i++) {
      // With 8 videos available, each surgeon should touch all of them.
      expect(videosPerSurgeon[i]).toBe(8);
      // And no single video should dominate: an even deal is 1/8 = 12.5%.
      expect(maxVideoShare[i]).toBeLessThanOrEqual(0.3);
    }
  });

  it('beats a contiguous slice, which confounds surgeon with patient', () => {
    const frames = pool(8, 60);
    const perSurgeon = 70;

    // What the old implementation did.
    const sliced = Array.from({ length: 6 }, (_, i) =>
      frames.slice(i * perSurgeon, (i + 1) * perSurgeon),
    );
    const slicedVideos = sliced.map((set) => countDistinctVideos(set));

    const { videosPerSurgeon } = dealIndividualSets(frames, 6, perSurgeon, 1234);

    expect(Math.max(...slicedVideos)).toBeLessThanOrEqual(2);
    expect(Math.min(...videosPerSurgeon)).toBeGreaterThan(Math.max(...slicedVideos));
  });

  it('is deterministic for a fixed seed and differs between seeds', () => {
    const frames = pool(8, 60);
    const a = dealIndividualSets(frames, 6, 70, 2024).sets;
    const b = dealIndividualSets(frames, 6, 70, 2024).sets;
    const c = dealIndividualSets(frames, 6, 70, 2025).sets;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('spreads as evenly as it can when there are fewer videos than surgeons', () => {
    const frames = pool(2, 120); // 2 videos, 6 surgeons
    const { sets, videosPerSurgeon, maxVideoShare } = dealIndividualSets(frames, 6, 40, 77);

    for (const set of sets) expect(set).toHaveLength(40);
    for (let i = 0; i < 6; i++) {
      // Both videos reachable, and as close to 50/50 as two videos allow.
      expect(videosPerSurgeon[i]).toBe(2);
      expect(maxVideoShare[i]).toBeCloseTo(0.5, 5);
    }
    const all = sets.flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('handles a single video without crashing', () => {
    const frames = pool(1, 100);
    const { sets, videosPerSurgeon, maxVideoShare } = dealIndividualSets(frames, 4, 20, 9);
    for (const set of sets) expect(set).toHaveLength(20);
    expect(videosPerSurgeon).toEqual([1, 1, 1, 1]);
    expect(maxVideoShare).toEqual([1, 1, 1, 1]);
  });

  it('deals what it can when the pool runs short, without duplicating', () => {
    const frames = pool(3, 5); // only 15 frames for 4 surgeons x 10
    const { sets } = dealIndividualSets(frames, 4, 10, 3);
    const all = sets.flat();
    expect(all).toHaveLength(15);
    expect(new Set(all).size).toBe(15);
  });

  it('returns empty sets for degenerate inputs', () => {
    expect(dealIndividualSets(pool(2, 10), 0, 5, 1).sets).toEqual([]);
    expect(dealIndividualSets(pool(2, 10), 3, 0, 1).sets).toEqual([[], [], []]);
    expect(dealIndividualSets([], 3, 5, 1).sets).toEqual([[], [], []]);
  });

  it('does not pool frames of unknown provenance into one pseudo-video', () => {
    const frames = Array.from({ length: 40 }, (_, i) => frame(i + 1, null));
    const { videosPerSurgeon, sets } = dealIndividualSets(frames, 4, 10, 11);
    // Each unknown frame is its own group, so every surgeon's 10 frames are 10 groups.
    expect(videosPerSurgeon).toEqual([10, 10, 10, 10]);
    expect(new Set(sets.flat()).size).toBe(40);
  });
});
