import { describe, expect, it } from 'vitest';
import { cohenKappa, dice, fleissKappa, iou, summariseAgreement } from '@/lib/masks';
import { loadRepeatPairs, summariseIntraRater } from '@/lib/intra-rater';
import { addAnnotation, addAssignment, addFrame, addSurgeon, rect, testDb, writeMask } from './helpers';

const W = 16;
const H = 16;
const empty = () => new Uint8Array(W * H);

describe('iou and dice on empty masks', () => {
  it('are null when both masks are empty, not 1', () => {
    // Two surgeons who both drew nothing have made no spatial claim. Scoring
    // that as perfect overlap inflates the mean.
    expect(iou(empty(), empty())).toBeNull();
    expect(dice(empty(), empty())).toBeNull();
  });

  it('are 0 when only one is empty', () => {
    const a = rect(W, H, 0, 0, 4, 4);
    expect(iou(a, empty())).toBe(0);
    expect(dice(a, empty())).toBe(0);
  });

  it('agree with the identity dice = 2 * iou / (1 + iou)', () => {
    const a = rect(W, H, 0, 0, 8, 8);
    const b = rect(W, H, 4, 0, 12, 8);
    const i = iou(a, b)!;
    expect(dice(a, b)!).toBeCloseTo((2 * i) / (1 + i), 12);
  });

  it('computes dice by hand', () => {
    // |A| = 64, |B| = 64, intersection = 32 -> 2*32 / 128 = 0.5
    const a = rect(W, H, 0, 0, 8, 8);
    const b = rect(W, H, 4, 0, 12, 8);
    expect(dice(a, b)!).toBeCloseTo(0.5, 12);
  });
});

describe('summariseAgreement', () => {
  it('excludes both-empty pairs from the spatial means and counts them', () => {
    const drawn = rect(W, H, 0, 0, 8, 8);
    const summary = summariseAgreement([drawn, drawn, empty(), empty()], W, H);

    expect(summary.n).toBe(4);
    // 6 pairs; the one empty-empty pair is excluded from IoU and Dice.
    expect(summary.spatialPairs).toBe(5);
    expect(summary.excludedEmptyPairs).toBe(1);

    // Pairs: drawn-drawn = 1, four drawn-empty = 0. Mean over 5 = 0.2.
    expect(summary.meanIou!).toBeCloseTo(1 / 5, 12);
  });

  it('would have reported a higher number under the old convention', () => {
    const drawn = rect(W, H, 0, 0, 8, 8);
    const masks = [drawn, drawn, empty(), empty()];
    const summary = summariseAgreement(masks, W, H);
    // Old behaviour scored the empty-empty pair as 1 and averaged over 6:
    // (1 + 1 + 0 + 0 + 0 + 0) / 6 = 0.333 versus the honest 0.2.
    const inflated = (1 + 1) / 6;
    expect(summary.meanIou!).toBeLessThan(inflated);
  });

  it('reports null spatial metrics when every rater drew nothing', () => {
    const summary = summariseAgreement([empty(), empty(), empty()], W, H);
    expect(summary.meanIou).toBeNull();
    expect(summary.meanDice).toBeNull();
    expect(summary.spatialPairs).toBe(0);
    expect(summary.excludedEmptyPairs).toBe(3);
    // But they unanimously agree there is nothing here, which is the real finding.
    expect(summary.presence.positive).toBe(0);
    expect(summary.presence.observedAgreement).toBe(1);
    expect(summary.presence.kappaNote).toBe('undefined_unanimous');
  });

  it('does not claim agreement from a single rater', () => {
    const summary = summariseAgreement([rect(W, H, 0, 0, 4, 4)], W, H);
    expect(summary.meanIou).toBeNull();
    expect(summary.meanDice).toBeNull();
    expect(summary.meanPixelAgreement).toBeNull();
  });

  it('separates presence from shape', () => {
    // Three drew, one did not: presence is 3 of 4, shape is measured on the
    // pairs where somebody drew.
    const a = rect(W, H, 0, 0, 8, 8);
    const summary = summariseAgreement([a, a, a, empty()], W, H);
    expect(summary.presence.positive).toBe(3);
    expect(summary.presence.n).toBe(4);
    // Pairs agreeing on presence: C(3,2)=3 yes-yes, 0 no-no, over C(4,2)=6.
    expect(summary.presence.observedAgreement).toBeCloseTo(3 / 6, 12);
  });
});

describe('cohenKappa', () => {
  it('is null rather than NaN when both raters are unanimous', () => {
    const result = cohenKappa([true, true, true], [true, true, true]);
    expect(result.kappa).toBeNull();
    expect(result.note).toBe('undefined_unanimous');
  });

  it('is 1 for perfect non-trivial agreement', () => {
    const result = cohenKappa([true, false, true, false], [true, false, true, false]);
    expect(result.kappa).toBeCloseTo(1, 12);
  });

  it('is about 0 for chance-level agreement', () => {
    // Both mark half the items, but never the same ones.
    const result = cohenKappa([true, true, false, false], [true, false, true, false]);
    expect(result.kappa).toBeCloseTo(0, 12);
  });

  it('is negative for systematic disagreement', () => {
    const result = cohenKappa([true, true, false, false], [false, false, true, true]);
    expect(result.kappa!).toBeLessThan(0);
  });

  it('matches a hand-computed example', () => {
    // a yes on 1,2,3; b yes on 1,2,4. po = 2/4 agree... compute directly:
    // both yes: 2 (items 1,2). both no: 0. po = 0.5
    // pYes_a = 3/4, pYes_b = 3/4 -> pe = 0.5625 + 0.0625 = 0.625
    // kappa = (0.5 - 0.625) / 0.375 = -0.3333
    const result = cohenKappa([true, true, true, false], [true, true, false, true]);
    expect(result.kappa!).toBeCloseTo(-1 / 3, 10);
  });
});

describe('fleissKappa', () => {
  it('is null rather than NaN when every rater agrees on every item', () => {
    const result = fleissKappa([4, 4, 4], 4);
    expect(result.kappa).toBeNull();
    expect(result.note).toBe('undefined_unanimous');
  });

  it('is 1 for perfect agreement with a mixed marginal', () => {
    const result = fleissKappa([4, 0, 4, 0], 4);
    expect(result.kappa).toBeCloseTo(1, 12);
  });

  it('is near 0 when raters split evenly on every item', () => {
    const result = fleissKappa([2, 2, 2, 2], 4);
    expect(result.kappa!).toBeLessThan(0.01);
  });

  it('refuses fewer than two raters', () => {
    expect(fleissKappa([1, 1], 1).note).toBe('insufficient_raters');
  });
});

describe('intra-rater reliability', () => {
  // The schema enforces UNIQUE(surgeon_id, display_order), so each seeded pair
  // needs its own slot in that surgeon's queue.
  const nextSlot = new Map<number, number>();

  /** A surgeon annotating the same frame twice, with the given masks. */
  function seedRepeat(
    db: ReturnType<typeof testDb>,
    surgeonId: number,
    firstShape: Uint8Array | null,
    repeatShape: Uint8Array | null,
    options: { firstConfidence?: string; repeatConfidence?: string } = {},
  ) {
    const frameId = addFrame(db, { width: W, height: H });
    const slot = nextSlot.get(surgeonId) ?? 0;
    nextSlot.set(surgeonId, slot + 1);
    const firstOrder = slot;
    const repeatOrder = 40 + slot;
    const first = addAssignment(db, surgeonId, frameId, firstOrder);
    const repeat = addAssignment(db, surgeonId, frameId, repeatOrder, { isRepeat: 1, repeatOf: first });

    const firstMask = firstShape ? writeMask(frameId, surgeonId, 'nogo', W, H, firstShape) : null;
    addAnnotation(db, {
      assignmentId: first,
      surgeonId,
      frameId,
      status: firstShape ? 'drawn' : 'nothing_to_mark',
      nogoMaskPath: firstMask,
      confidence: options.firstConfidence ?? 'high',
    });

    // The repeat's mask must not overwrite the first: store it under a path of
    // its own by using a second frame-scoped name.
    let repeatMask: string | null = null;
    if (repeatShape) {
      repeatMask = writeMask(frameId, surgeonId * 1000 + 7, 'nogo', W, H, repeatShape);
    }
    addAnnotation(db, {
      assignmentId: repeat,
      surgeonId,
      frameId,
      status: repeatShape ? 'drawn' : 'nothing_to_mark',
      nogoMaskPath: repeatMask,
      confidence: options.repeatConfidence ?? 'high',
    });
    return frameId;
  }

  it('pairs a repeat with its original and compares the two attempts', () => {
    const db = testDb();
    const surgeonId = addSurgeon(db, 'Consistent');
    seedRepeat(db, surgeonId, rect(W, H, 0, 0, 8, 16), rect(W, H, 0, 0, 8, 16));

    const pairs = loadRepeatPairs(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].nogo.iou).toBe(1);
    expect(pairs[0].nogo.dice).toBe(1);
    expect(pairs[0].nogo.nsd).toBe(1);
    expect(pairs[0].firstDisplayOrder).toBe(0);
    expect(pairs[0].repeatDisplayOrder).toBe(40);
    expect(pairs[0].repeatDisplayOrder - pairs[0].firstDisplayOrder).toBeGreaterThanOrEqual(30);
  });

  it('measures a surgeon who drew something different the second time', () => {
    const db = testDb();
    const surgeonId = addSurgeon(db, 'Drifting');
    seedRepeat(db, surgeonId, rect(W, H, 0, 0, 8, 16), rect(W, H, 4, 0, 12, 16));

    const [pair] = loadRepeatPairs(db);
    // Two 8x16 halves overlapping in 4x16: intersection 64, union 192.
    expect(pair.nogo.iou!).toBeCloseTo(64 / 192, 10);
  });

  it('flags a presence disagreement when a zone appears only once', () => {
    const db = testDb();
    const surgeonId = addSurgeon(db, 'Inconsistent');
    seedRepeat(db, surgeonId, rect(W, H, 0, 0, 8, 8), null);

    const [pair] = loadRepeatPairs(db);
    expect(pair.nogo.presenceDisagreement).toBe(true);
    expect(pair.nogo.iou).toBe(0);
    expect(pair.firstStatus).toBe('drawn');
    expect(pair.repeatStatus).toBe('nothing_to_mark');
  });

  it('excludes a pair where either attempt was cannot_assess', () => {
    const db = testDb();
    const surgeonId = addSurgeon(db, 'Unsure');
    const frameId = addFrame(db, { width: W, height: H });
    const first = addAssignment(db, surgeonId, frameId, 0);
    const repeat = addAssignment(db, surgeonId, frameId, 40, { isRepeat: 1, repeatOf: first });
    addAnnotation(db, { assignmentId: first, surgeonId, frameId, status: 'drawn' });
    addAnnotation(db, { assignmentId: repeat, surgeonId, frameId, status: 'cannot_assess' });

    expect(loadRepeatPairs(db)).toHaveLength(0);
  });

  it('excludes a pair where the repeat has not been submitted yet', () => {
    const db = testDb();
    const surgeonId = addSurgeon(db, 'InProgress');
    const frameId = addFrame(db, { width: W, height: H });
    const first = addAssignment(db, surgeonId, frameId, 0);
    const repeat = addAssignment(db, surgeonId, frameId, 40, { isRepeat: 1, repeatOf: first });
    addAnnotation(db, { assignmentId: first, surgeonId, frameId, status: 'drawn' });
    addAnnotation(db, { assignmentId: repeat, surgeonId, frameId, status: 'drawn', submitted: false });

    expect(loadRepeatPairs(db)).toHaveLength(0);
  });

  it('summarises per surgeon, including status and confidence changes', () => {
    const db = testDb();
    const steady = addSurgeon(db, 'Steady');
    const wobbly = addSurgeon(db, 'Wobbly');

    seedRepeat(db, steady, rect(W, H, 0, 0, 8, 16), rect(W, H, 0, 0, 8, 16));
    seedRepeat(db, steady, rect(W, H, 2, 2, 10, 14), rect(W, H, 2, 2, 10, 14));
    seedRepeat(db, wobbly, rect(W, H, 0, 0, 8, 16), rect(W, H, 8, 0, 16, 16), {
      firstConfidence: 'high',
      repeatConfidence: 'low',
    });
    seedRepeat(db, wobbly, rect(W, H, 0, 0, 4, 4), null);

    const summaries = summariseIntraRater(db);
    expect(summaries).toHaveLength(2);

    const steadySummary = summaries.find((row) => row.surgeonId === steady)!;
    expect(steadySummary.pairs).toBe(2);
    expect(steadySummary.nogo.meanIou).toBe(1);
    expect(steadySummary.statusChanges).toBe(0);

    const wobblySummary = summaries.find((row) => row.surgeonId === wobbly)!;
    expect(wobblySummary.pairs).toBe(2);
    // Disjoint halves score 0, and the vanished zone scores 0 too.
    expect(wobblySummary.nogo.meanIou).toBe(0);
    expect(wobblySummary.statusChanges).toBe(1);
    expect(wobblySummary.confidenceChanges).toBe(1);
    expect(wobblySummary.nogo.presenceAgreement).toBeCloseTo(0.5, 12);
  });

  it('returns nothing when no repeats have been completed', () => {
    const db = testDb();
    addSurgeon(db, 'Nobody');
    expect(summariseIntraRater(db)).toEqual([]);
  });
});
