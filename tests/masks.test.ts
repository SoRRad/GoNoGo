import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  countSet,
  emptyOccupancy,
  encodeBinaryMaskPng,
  iou,
  isEmpty,
  majorityVote,
  occupancyFromUploadedPng,
  pixelAgreement,
  readBinaryMaskPng,
} from '@/lib/masks';
import fs from 'fs';
import os from 'os';
import path from 'path';

function writeTemp(buffer: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-test-'));
  const file = path.join(dir, 'mask.png');
  fs.writeFileSync(file, buffer);
  return file;
}

/** An RGBA PNG as the browser canvas produces it: colour on transparency. */
function uploadedPng(width: number, height: number, on: (x: number, y: number) => boolean): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (width * y + x) << 2;
      const painted = on(x, y);
      // Deliberately dark green: brightness must not be what decides occupancy.
      png.data[index] = 0x22;
      png.data[index + 1] = 0x55;
      png.data[index + 2] = 0x22;
      png.data[index + 3] = painted ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

describe('binary mask PNG round-trip', () => {
  it('preserves an arbitrary mask exactly', () => {
    const width = 64;
    const height = 48;
    const occupancy = emptyOccupancy(width, height);
    for (let y = 10; y < 30; y++) for (let x = 5; x < 25; x++) occupancy[y * width + x] = 1;

    const file = writeTemp(encodeBinaryMaskPng(width, height, occupancy));
    const back = readBinaryMaskPng(file);

    expect(back.width).toBe(width);
    expect(back.height).toBe(height);
    expect(Array.from(back.data)).toEqual(Array.from(occupancy));
    expect(countSet(back.data)).toBe(400);
  });

  it('round-trips an all-zero mask', () => {
    const occupancy = emptyOccupancy(32, 32);
    const back = readBinaryMaskPng(writeTemp(encodeBinaryMaskPng(32, 32, occupancy)));
    expect(countSet(back.data)).toBe(0);
    expect(isEmpty(back.data)).toBe(true);
  });

  it('round-trips an all-one mask', () => {
    const occupancy = emptyOccupancy(32, 32).fill(1);
    const back = readBinaryMaskPng(writeTemp(encodeBinaryMaskPng(32, 32, occupancy)));
    expect(countSet(back.data)).toBe(32 * 32);
    expect(isEmpty(back.data)).toBe(false);
  });

  it('writes strictly binary pixel values', () => {
    const occupancy = emptyOccupancy(16, 16);
    occupancy[0] = 1;
    const decoded = PNG.sync.read(encodeBinaryMaskPng(16, 16, occupancy));
    const values = new Set<number>();
    for (let i = 0; i < decoded.data.length; i += 4) values.add(decoded.data[i]);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it('treats a non-zero value as occupied only above the midpoint', () => {
    // Guards the >127 threshold used when reading masks back.
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([100, 100, 100, 255, 200, 200, 200, 255]);
    const file = writeTemp(PNG.sync.write(png));
    expect(Array.from(readBinaryMaskPng(file).data)).toEqual([0, 1]);
  });
});

describe('occupancyFromUploadedPng', () => {
  it('reads alpha, not brightness', () => {
    // Every painted pixel here is dark; a brightness rule would see nothing.
    const buffer = uploadedPng(20, 20, (x, y) => x < 10 && y < 10);
    const mask = occupancyFromUploadedPng(buffer);
    expect(countSet(mask.data)).toBe(100);
    expect(mask.data[0]).toBe(1);
    expect(mask.data[19 * 20 + 19]).toBe(0);
  });

  it('treats a fully transparent upload as empty', () => {
    const mask = occupancyFromUploadedPng(uploadedPng(10, 10, () => false));
    expect(isEmpty(mask.data)).toBe(true);
  });

  it('reports the uploaded dimensions so a mismatch can be rejected', () => {
    const mask = occupancyFromUploadedPng(uploadedPng(37, 19, () => true));
    expect(mask.width).toBe(37);
    expect(mask.height).toBe(19);
    // The annotations route rejects an upload whose size is not the frame's.
    expect(mask.width === 40 && mask.height === 20).toBe(false);
  });
});

describe('majorityVote', () => {
  const width = 4;
  const height = 1;
  /** Builds a 4x1 mask from a bit pattern like '1100'. */
  const mask = (bits: string) => Uint8Array.from(bits.split('').map(Number));

  it('with 2 raters requires both, which is the intersection', () => {
    const vote = majorityVote([mask('1100'), mask('0110')], width, height);
    expect(Array.from(vote)).toEqual([0, 1, 0, 0]);
  });

  it('with 3 raters requires 2', () => {
    const vote = majorityVote([mask('1100'), mask('0110'), mask('0100')], width, height);
    expect(Array.from(vote)).toEqual([0, 1, 0, 0]);
  });

  it('with 4 raters requires 3, not 2 — strict majority', () => {
    const votes = [mask('1100'), mask('1100'), mask('0110'), mask('0110')];
    // Pixel 1 has exactly 4/2 = 2 votes... in fact all four cover it, check each.
    const vote = majorityVote(votes, width, height);
    // pixel0: 2 of 4 -> not > 2 -> 0. pixel1: 4 of 4 -> 1. pixel2: 2 of 4 -> 0. pixel3: 0.
    expect(Array.from(vote)).toEqual([0, 1, 0, 0]);
  });

  it('with 5 raters requires 3', () => {
    const votes = [mask('1000'), mask('1000'), mask('1000'), mask('0100'), mask('0100')];
    expect(Array.from(majorityVote(votes, width, height))).toEqual([1, 0, 0, 0]);
  });

  it('an even split never carries, at any even rater count', () => {
    for (const n of [2, 4, 6]) {
      const votes = [
        ...Array.from({ length: n / 2 }, () => mask('1000')),
        ...Array.from({ length: n / 2 }, () => mask('0100')),
      ];
      expect(Array.from(majorityVote(votes, width, height))).toEqual([0, 0, 0, 0]);
    }
  });

  it('returns an empty mask for no raters', () => {
    expect(countSet(majorityVote([], width, height))).toBe(0);
  });
});

describe('iou and pixelAgreement', () => {
  const size = 100;
  const range = (from: number, to: number) => {
    const occupancy = emptyOccupancy(size, 1);
    for (let i = from; i < to; i++) occupancy[i] = 1;
    return occupancy;
  };

  it('computes intersection over union by hand', () => {
    // a = [0,100), b = [50,150) clipped to 100 -> intersection 50, union 100
    const a = range(0, 100);
    const b = range(50, 100);
    expect(iou(a, b)).toBeCloseTo(50 / 100, 10);
  });

  it('is 1 for identical non-empty masks', () => {
    const a = range(10, 40);
    expect(iou(a, range(10, 40))).toBe(1);
  });

  it('is 0 for disjoint non-empty masks', () => {
    expect(iou(range(0, 10), range(20, 30))).toBe(0);
  });

  it('computes whole-image pixel agreement by hand', () => {
    // Differ on [10,20) and [30,40): 20 of 100 pixels disagree.
    const a = range(0, 30);
    const b = range(20, 40);
    // a: 0..29, b: 20..39. Same where both 1 (20..29 = 10) or both 0 (40..99 = 60) => 70.
    expect(pixelAgreement(a, b)).toBeCloseTo(0.7, 10);
  });

  it('is 1 for identical masks, including two empty ones', () => {
    expect(pixelAgreement(range(5, 8), range(5, 8))).toBe(1);
    expect(pixelAgreement(emptyOccupancy(size, 1), emptyOccupancy(size, 1))).toBe(1);
  });
});
