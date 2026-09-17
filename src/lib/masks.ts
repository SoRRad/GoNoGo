import fs from 'fs';
import { PNG } from 'pngjs';

/**
 * A mask in memory is one byte per pixel, 0 or 1, row-major. On disk it is an
 * 8-bit grayscale PNG with values 0 and 255 at the frame's native resolution,
 * which is what the analysis pipeline downstream expects.
 */
export type Occupancy = Uint8Array;

export interface MaskImage {
  width: number;
  height: number;
  data: Occupancy;
}

export function emptyOccupancy(width: number, height: number): Occupancy {
  return new Uint8Array(width * height);
}

/** Encodes a binary mask as an 8-bit grayscale PNG. Values are strictly 0 or 255. */
export function encodeBinaryMaskPng(width: number, height: number, occupancy: Occupancy): Buffer {
  const png = new PNG({ width, height, colorType: 0, inputColorType: 0, bitDepth: 8 });
  for (let i = 0; i < width * height; i++) {
    png.data[i] = occupancy[i] ? 255 : 0;
  }
  return PNG.sync.write(png, { colorType: 0, inputColorType: 0 });
}

/**
 * Reads a mask we wrote ourselves. pngjs normalises every input to RGBA, so a
 * grayscale 0/255 file comes back with r == g == b; brightness decides.
 */
export function readBinaryMaskPng(absolutePath: string): MaskImage {
  const png = PNG.sync.read(fs.readFileSync(absolutePath));
  const data = new Uint8Array(png.width * png.height);
  for (let i = 0; i < data.length; i++) {
    data[i] = png.data[i * 4] > 127 ? 1 : 0;
  }
  return { width: png.width, height: png.height, data };
}

/**
 * Reads a mask uploaded by the browser. The canvas exports the drawing colour
 * on a transparent background, so alpha — not brightness — carries occupancy.
 */
export function occupancyFromUploadedPng(buffer: Buffer): MaskImage {
  const png = PNG.sync.read(buffer);
  const data = new Uint8Array(png.width * png.height);
  for (let i = 0; i < data.length; i++) {
    data[i] = png.data[i * 4 + 3] > 127 ? 1 : 0;
  }
  return { width: png.width, height: png.height, data };
}

export function countSet(occupancy: Occupancy): number {
  let n = 0;
  for (let i = 0; i < occupancy.length; i++) if (occupancy[i]) n++;
  return n;
}

export function isEmpty(occupancy: Occupancy): boolean {
  for (let i = 0; i < occupancy.length; i++) if (occupancy[i]) return false;
  return true;
}

/**
 * Pixel majority vote across surgeons: a pixel is in the consensus when strictly
 * more than half of the contributing surgeons marked it.
 */
export function majorityVote(masks: Occupancy[], width: number, height: number): Occupancy {
  const out = emptyOccupancy(width, height);
  if (masks.length === 0) return out;
  const threshold = masks.length / 2;
  for (let i = 0; i < out.length; i++) {
    let votes = 0;
    for (const mask of masks) votes += mask[i];
    out[i] = votes > threshold ? 1 : 0;
  }
  return out;
}

/**
 * Intersection over union.
 *
 * Returns null when both masks are empty. Overlap is undefined for that pair:
 * two surgeons who both drew nothing have made no spatial claim to compare, and
 * scoring them 1 would inflate a mean IoU by counting agreement about absence
 * as perfect agreement about shape. Whether they agreed a zone exists at all is
 * a separate question, answered by the presence statistics below.
 */
export function iou(a: Occupancy, b: Occupancy): number | null {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i];
    const inB = b[i];
    if (inA && inB) intersection++;
    if (inA || inB) union++;
  }
  if (union === 0) return null;
  return intersection / union;
}

/**
 * Dice / F1 coefficient, the overlap measure segmentation papers report
 * alongside IoU. Dice = 2|A∩B| / (|A|+|B|), and relates to IoU monotonically as
 * Dice = 2·IoU / (1+IoU), so it always reads higher; both are reported because
 * the literature is split on which to quote.
 *
 * Null for the same reason as iou: undefined when both masks are empty.
 */
export function dice(a: Occupancy, b: Occupancy): number | null {
  let intersection = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]) sizeA++;
    if (b[i]) sizeB++;
    if (a[i] && b[i]) intersection++;
  }
  if (sizeA + sizeB === 0) return null;
  return (2 * intersection) / (sizeA + sizeB);
}

/** Fraction of pixels both masks classify the same way, background included. */
export function pixelAgreement(a: Occupancy, b: Occupancy): number {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return a.length === 0 ? 1 : same / a.length;
}

/**
 * Presence agreement: did the surgeons agree that a zone of this class exists
 * on this frame at all, regardless of where they put it.
 *
 * This is deliberately separate from the spatial metrics. "Four surgeons all
 * saw a No-Go zone here" and "the four zones they drew overlapped by 60%" are
 * different findings, and collapsing them into one number hides which one is
 * driving the result.
 */
export interface PresenceAgreement {
  /** Raters contributing an opinion on this layer. */
  n: number;
  /** How many of them marked at least one pixel. */
  positive: number;
  /** Proportion of rater pairs that made the same presence call. */
  observedAgreement: number | null;
  /**
   * Chance-corrected agreement: Cohen's kappa for exactly two raters, Fleiss'
   * kappa for three or more. Null when undefined — see kappaNote.
   */
  kappa: number | null;
  /** Which coefficient was used, or why none could be. */
  kappaNote:
    | 'cohen'
    | 'fleiss'
    | 'undefined_unanimous'
    | 'insufficient_raters';
}

export interface AgreementSummary {
  /** Number of surgeons contributing to this layer. */
  n: number;
  /**
   * Pairs used for the spatial metrics: those where at least one of the two
   * masks is non-empty. Pairs where both are empty are excluded, because
   * overlap is undefined rather than perfect.
   */
  spatialPairs: number;
  /** Pairs skipped because neither surgeon marked anything. */
  excludedEmptyPairs: number;
  /** Mean IoU over the spatial pairs. Null when there are none. */
  meanIou: number | null;
  /** Mean Dice over the spatial pairs. Null when there are none. */
  meanDice: number | null;
  /**
   * Mean whole-image pixel agreement across every pair, empty ones included.
   * Background dominates it on a sparse frame, so it reads high by
   * construction and should not be quoted as the headline.
   */
  meanPixelAgreement: number | null;
  /** Presence agreement, kept apart from the shape metrics above. */
  presence: PresenceAgreement;
  /** Pixels in the majority-vote consensus. */
  consensusPixels: number;
}

/**
 * Cohen's kappa for two raters over a binary call.
 *
 * Undefined when the raters are unanimous across the board: expected agreement
 * is then 1, the denominator 1 - pe is 0, and the coefficient is 0/0. That case
 * is reported as null rather than NaN, because unanimity is a real and
 * favourable result that should not be rendered as a missing value.
 */
export function cohenKappa(a: readonly boolean[], b: readonly boolean[]): { kappa: number | null; note: PresenceAgreement['kappaNote'] } {
  const n = a.length;
  if (n === 0 || b.length !== n) return { kappa: null, note: 'insufficient_raters' };

  let bothYes = 0;
  let bothNo = 0;
  let aYes = 0;
  let bYes = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] && b[i]) bothYes++;
    if (!a[i] && !b[i]) bothNo++;
    if (a[i]) aYes++;
    if (b[i]) bYes++;
  }
  const po = (bothYes + bothNo) / n;
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  if (1 - pe === 0) return { kappa: null, note: 'undefined_unanimous' };
  return { kappa: (po - pe) / (1 - pe), note: 'cohen' };
}

/**
 * Fleiss' kappa for a fixed set of raters over binary items.
 *
 * `items` is one entry per frame: how many raters said yes, out of `raters`.
 * Undefined when every rater agrees on every item, for the same 0/0 reason as
 * Cohen's.
 */
export function fleissKappa(
  items: readonly number[],
  raters: number,
): { kappa: number | null; note: PresenceAgreement['kappaNote'] } {
  if (raters < 2 || items.length === 0) return { kappa: null, note: 'insufficient_raters' };

  let agreementSum = 0;
  let yesTotal = 0;
  for (const yes of items) {
    const no = raters - yes;
    // Proportion of rater pairs on this item that agree.
    agreementSum += (yes * (yes - 1) + no * (no - 1)) / (raters * (raters - 1));
    yesTotal += yes;
  }
  const pBar = agreementSum / items.length;
  const pYes = yesTotal / (items.length * raters);
  const pe = pYes * pYes + (1 - pYes) * (1 - pYes);
  if (1 - pe === 0) return { kappa: null, note: 'undefined_unanimous' };
  return { kappa: (pBar - pe) / (1 - pe), note: 'fleiss' };
}

/**
 * Presence agreement for one frame, across the raters of one layer.
 *
 * With a single frame there is one binary item per rater, so Fleiss' kappa has
 * nothing to estimate the marginal from and Cohen's is only defined for a pair.
 * Presence kappa is therefore reported across frames by the caller; here only
 * the counts and observed pairwise agreement are filled in.
 */
function presenceForFrame(masks: Occupancy[]): PresenceAgreement {
  const n = masks.length;
  const positive = masks.filter((mask) => !isEmpty(mask)).length;
  if (n < 2) {
    return { n, positive, observedAgreement: null, kappa: null, kappaNote: 'insufficient_raters' };
  }
  // Pairs making the same yes/no call, over all pairs.
  const negative = n - positive;
  const agreeingPairs = (positive * (positive - 1)) / 2 + (negative * (negative - 1)) / 2;
  const totalPairs = (n * (n - 1)) / 2;
  return {
    n,
    positive,
    observedAgreement: agreeingPairs / totalPairs,
    kappa: null,
    kappaNote: positive === n || positive === 0 ? 'undefined_unanimous' : 'insufficient_raters',
  };
}

export function summariseAgreement(masks: Occupancy[], width: number, height: number): AgreementSummary {
  const n = masks.length;
  const presence = presenceForFrame(masks);

  if (n < 2) {
    return {
      n,
      spatialPairs: 0,
      excludedEmptyPairs: 0,
      // One rater is not agreement. Reporting 1 would be a lie of convenience.
      meanIou: null,
      meanDice: null,
      meanPixelAgreement: null,
      presence,
      consensusPixels: n === 1 ? countSet(masks[0]) : 0,
    };
  }

  let iouSum = 0;
  let diceSum = 0;
  let spatialPairs = 0;
  let excludedEmptyPairs = 0;
  let agreementSum = 0;
  let allPairs = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pairIou = iou(masks[i], masks[j]);
      const pairDice = dice(masks[i], masks[j]);
      if (pairIou === null || pairDice === null) {
        // Both masks empty: no shape to compare.
        excludedEmptyPairs++;
      } else {
        iouSum += pairIou;
        diceSum += pairDice;
        spatialPairs++;
      }
      agreementSum += pixelAgreement(masks[i], masks[j]);
      allPairs++;
    }
  }

  return {
    n,
    spatialPairs,
    excludedEmptyPairs,
    meanIou: spatialPairs > 0 ? iouSum / spatialPairs : null,
    meanDice: spatialPairs > 0 ? diceSum / spatialPairs : null,
    meanPixelAgreement: allPairs > 0 ? agreementSum / allPairs : null,
    presence,
    consensusPixels: countSet(majorityVote(masks, width, height)),
  };
}
