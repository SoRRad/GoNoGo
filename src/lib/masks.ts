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

/** Intersection over union. Two empty masks agree perfectly, by convention 1. */
export function iou(a: Occupancy, b: Occupancy): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i];
    const inB = b[i];
    if (inA && inB) intersection++;
    if (inA || inB) union++;
  }
  if (union === 0) return 1;
  return intersection / union;
}

/** Fraction of pixels both masks classify the same way, background included. */
export function pixelAgreement(a: Occupancy, b: Occupancy): number {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return a.length === 0 ? 1 : same / a.length;
}

export interface AgreementSummary {
  /** Number of surgeons contributing to this layer. */
  n: number;
  /** Mean intersection-over-union across every surgeon pair. */
  meanIou: number;
  /** Mean whole-image pixel agreement across every surgeon pair. */
  meanPixelAgreement: number;
  /** Pixels in the majority-vote consensus. */
  consensusPixels: number;
}

export function summariseAgreement(masks: Occupancy[], width: number, height: number): AgreementSummary {
  const n = masks.length;
  if (n < 2) {
    return {
      n,
      meanIou: n === 1 ? 1 : 0,
      meanPixelAgreement: n === 1 ? 1 : 0,
      consensusPixels: n === 1 ? countSet(masks[0]) : 0,
    };
  }
  let iouSum = 0;
  let agreementSum = 0;
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      iouSum += iou(masks[i], masks[j]);
      agreementSum += pixelAgreement(masks[i], masks[j]);
      pairs++;
    }
  }
  return {
    n,
    meanIou: iouSum / pairs,
    meanPixelAgreement: agreementSum / pairs,
    consensusPixels: countSet(majorityVote(masks, width, height)),
  };
}
