import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_FRACTION,
  boundaryPixels,
  meanPairwiseNsd,
  normalisedSurfaceDistance,
} from '@/lib/boundary';
import { rect } from './helpers';

import { boundaryPoints } from '@/lib/boundary';

/** O(n*m) reference: does any point of B lie within tolerance of each point of A? */
function bruteForceWithin(
  pointsA: Int32Array,
  pointsB: Int32Array,
  tolerance: number,
): number {
  let within = 0;
  for (let i = 0; i < pointsA.length; i += 2) {
    for (let j = 0; j < pointsB.length; j += 2) {
      const dx = pointsA[i] - pointsB[j];
      const dy = pointsA[i + 1] - pointsB[j + 1];
      if (dx * dx + dy * dy <= tolerance * tolerance) {
        within++;
        break;
      }
    }
  }
  return within;
}

/** Recomputes NSD from first principles, with no spatial index at all. */
function bruteForceNsd(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  toleranceFraction: number,
): number | null {
  const pointsA = boundaryPoints(a, width, height);
  const pointsB = boundaryPoints(b, width, height);
  const countA = pointsA.length / 2;
  const countB = pointsB.length / 2;
  if (countA === 0 && countB === 0) return null;
  const tolerance = toleranceFraction * Math.sqrt(width * width + height * height);
  const within = bruteForceWithin(pointsA, pointsB, tolerance) + bruteForceWithin(pointsB, pointsA, tolerance);
  return within / (countA + countB);
}

describe('grid lookup versus brute force', () => {
  it('agrees with an unindexed computation on random shapes', () => {
    // Deterministic pseudo-random, so a failure is reproducible.
    let seed = 987654321;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (const [width, height] of [[40, 30], [64, 64], [23, 51]]) {
      for (let trial = 0; trial < 6; trial++) {
        const a = new Uint8Array(width * height);
        const b = new Uint8Array(width * height);
        // A few random blobs each, so the contours are irregular.
        for (let blob = 0; blob < 3; blob++) {
          const target = blob % 2 === 0 ? a : b;
          const cx = next() * width;
          const cy = next() * height;
          const r = 3 + next() * Math.min(width, height) * 0.3;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) target[y * width + x] = 1;
            }
          }
        }

        for (const tolerance of [0.001, 0.02, 0.1]) {
          const fast = normalisedSurfaceDistance(a, b, width, height, tolerance).nsd;
          const slow = bruteForceNsd(a, b, width, height, tolerance);
          if (slow === null) expect(fast).toBeNull();
          else expect(fast!).toBeCloseTo(slow, 12);
        }
      }
    }
  });

  it('agrees with brute force at a tolerance smaller than one pixel', () => {
    const width = 20;
    const height = 20;
    const a = rect(width, height, 4, 4, 12, 12);
    const b = rect(width, height, 5, 4, 13, 12);
    const fast = normalisedSurfaceDistance(a, b, width, height, 0.0001).nsd;
    expect(fast!).toBeCloseTo(bruteForceNsd(a, b, width, height, 0.0001)!, 12);
  });
});

describe('boundaryPixels', () => {
  it('keeps only the rim of a filled rectangle', () => {
    const width = 6;
    const height = 6;
    const mask = rect(width, height, 1, 1, 5, 5); // 4x4 block
    const boundary = boundaryPixels(mask, width, height);
    // A 4x4 block has a 12-pixel rim and a 2x2 interior.
    expect(boundary.reduce((sum, v) => sum + v, 0)).toBe(12);
    // The centre pixels are interior.
    expect(boundary[2 * width + 2]).toBe(0);
    expect(boundary[3 * width + 3]).toBe(0);
  });

  it('treats the image edge as outside, so a region touching it still has a contour', () => {
    const width = 4;
    const height = 4;
    const mask = rect(width, height, 0, 0, 4, 4); // fills the image
    const boundary = boundaryPixels(mask, width, height);
    // Every rim pixel of the image counts: 4x4 minus the 2x2 interior.
    expect(boundary.reduce((sum, v) => sum + v, 0)).toBe(12);
  });

  it('is empty for an empty mask', () => {
    const boundary = boundaryPixels(new Uint8Array(16), 4, 4);
    expect(boundary.reduce((sum, v) => sum + v, 0)).toBe(0);
  });
});

describe('normalisedSurfaceDistance', () => {
  const W = 64;
  const H = 64;

  it('is 1 for identical masks', () => {
    const a = rect(W, H, 10, 10, 40, 40);
    expect(normalisedSurfaceDistance(a, rect(W, H, 10, 10, 40, 40), W, H).nsd).toBe(1);
  });

  it('is null when neither surgeon drew anything', () => {
    const empty = new Uint8Array(W * H);
    const result = normalisedSurfaceDistance(empty, empty, W, H);
    expect(result.nsd).toBeNull();
    expect(result.boundaryPixelsA).toBe(0);
  });

  it('is 0 when only one surgeon drew, which is disagreement not missing data', () => {
    const a = rect(W, H, 10, 10, 40, 40);
    const empty = new Uint8Array(W * H);
    expect(normalisedSurfaceDistance(a, empty, W, H).nsd).toBe(0);
  });

  it('is 0 for contours far apart relative to the tolerance', () => {
    const a = rect(W, H, 0, 0, 10, 10);
    const b = rect(W, H, 50, 50, 60, 60);
    expect(normalisedSurfaceDistance(a, b, W, H).nsd).toBe(0);
  });

  it('forgives a shift inside the tolerance but not outside it', () => {
    const a = rect(W, H, 20, 20, 44, 44);
    const shifted = rect(W, H, 21, 20, 45, 44); // one pixel right

    // Diagonal of a 64x64 image is ~90.5 px, so 5% is ~4.5 px: a 1 px shift is fine.
    const generous = normalisedSurfaceDistance(a, shifted, W, H, 0.05).nsd!;
    expect(generous).toBe(1);

    // At a sub-pixel tolerance the shifted vertical edges no longer match.
    const strict = normalisedSurfaceDistance(a, shifted, W, H, 0.0001).nsd!;
    expect(strict).toBeLessThan(1);
    expect(strict).toBeGreaterThan(0);
  });

  it('separates boundary disagreement from area overlap', () => {
    // Same area, same centre, very different shape: a square and a thin cross
    // arm can overlap substantially while their contours do not line up.
    const square = rect(W, H, 24, 24, 40, 40);
    const wide = rect(W, H, 8, 30, 56, 34);
    const result = normalisedSurfaceDistance(square, wide, W, H);
    expect(result.nsd).toBeLessThan(0.5);
  });

  it('scales the tolerance with the image diagonal', () => {
    const small = normalisedSurfaceDistance(rect(8, 8, 0, 0, 4, 4), rect(8, 8, 0, 0, 4, 4), 8, 8);
    const large = normalisedSurfaceDistance(rect(W, H, 0, 0, 4, 4), rect(W, H, 0, 0, 4, 4), W, H);
    expect(large.tolerancePixels).toBeGreaterThan(small.tolerancePixels);
    expect(small.tolerancePixels).toBeCloseTo(DEFAULT_TOLERANCE_FRACTION * Math.sqrt(128), 10);
  });
});

describe('meanPairwiseNsd', () => {
  const W = 32;
  const H = 32;

  it('averages over pairs and excludes the both-empty ones', () => {
    const a = rect(W, H, 4, 4, 20, 20);
    const b = rect(W, H, 5, 4, 21, 20);
    const empty = new Uint8Array(W * H);

    const result = meanPairwiseNsd([a, b, empty, empty], W, H, 0.2);
    // 6 pairs total, one of which is empty-empty.
    expect(result.pairs).toBe(5);
    expect(result.excludedEmptyPairs).toBe(1);
    expect(result.meanNsd).not.toBeNull();
  });

  it('returns null when every pair is empty', () => {
    const empty = new Uint8Array(W * H);
    const result = meanPairwiseNsd([empty, empty], W, H);
    expect(result.meanNsd).toBeNull();
    expect(result.pairs).toBe(0);
  });
});
