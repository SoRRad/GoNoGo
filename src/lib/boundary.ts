import type { Occupancy } from './masks';

/**
 * Boundary agreement between two masks.
 *
 * Area overlap (IoU, Dice) is dominated by the interior of a region, so two
 * surgeons can score well while disagreeing about exactly where the edge of a
 * zone runs — which for a dissection boundary is the part that matters. The
 * normalised surface distance answers the edge question directly: what fraction
 * of each contour lies within a stated tolerance of the other contour.
 */

/** Default tolerance, as a fraction of the image diagonal. */
export const DEFAULT_TOLERANCE_FRACTION = 0.005;

/**
 * Boundary pixels: set pixels with at least one 4-neighbour unset, counting
 * outside the image as unset so a region touching the edge still has a contour
 * there.
 */
export function boundaryPixels(mask: Occupancy, width: number, height: number): Occupancy {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!mask[index]) continue;
      const up = y === 0 || !mask[index - width];
      const down = y === height - 1 || !mask[index + width];
      const left = x === 0 || !mask[index - 1];
      const right = x === width - 1 || !mask[index + 1];
      if (up || down || left || right) out[index] = 1;
    }
  }
  return out;
}

/**
 * The same contour as (x, y) pairs.
 *
 * A contour is a few thousand pixels where the frame is one or two million, so
 * every step after this works on the point list rather than the image.
 */
export function boundaryPoints(mask: Occupancy, width: number, height: number): Int32Array {
  const boundary = boundaryPixels(mask, width, height);
  let count = 0;
  for (let i = 0; i < boundary.length; i++) if (boundary[i]) count++;

  const points = new Int32Array(count * 2);
  let cursor = 0;
  for (let i = 0; i < boundary.length; i++) {
    if (!boundary[i]) continue;
    points[cursor++] = i % width;
    points[cursor++] = (i / width) | 0;
  }
  return points;
}

/**
 * A uniform grid over a set of contour points, bucketed at the tolerance.
 *
 * NSD only ever asks "is this point within τ of that contour", never what the
 * exact distance is. A full-image Euclidean distance transform answers a much
 * harder question at O(width × height); at 1080p that measured ~45 ms per mask,
 * and a frame rated by six surgeons needs twelve of them per layer. Because
 * cells are τ wide, any point within τ is at most one cell away on each axis,
 * so a query scans a 3x3 block and the whole thing costs O(contour length).
 */
class ContourGrid {
  private readonly cellSize: number;
  private readonly columns: number;
  private readonly buckets: Map<number, number[]>;

  constructor(private readonly points: Int32Array, width: number, tolerance: number) {
    this.cellSize = Math.max(1, Math.ceil(tolerance));
    this.columns = Math.ceil(width / this.cellSize) + 2;
    this.buckets = new Map();

    for (let i = 0; i < points.length; i += 2) {
      const key = this.key(points[i], points[i + 1]);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(i);
      else this.buckets.set(key, [i]);
    }
  }

  private key(x: number, y: number): number {
    return ((y / this.cellSize) | 0) * this.columns + ((x / this.cellSize) | 0);
  }

  /** True when any contour point lies within the tolerance of (x, y). */
  hasPointWithin(x: number, y: number, toleranceSquared: number): boolean {
    const cellX = (x / this.cellSize) | 0;
    const cellY = (y / this.cellSize) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.buckets.get((cellY + dy) * this.columns + (cellX + dx));
        if (!bucket) continue;
        for (const index of bucket) {
          const deltaX = this.points[index] - x;
          const deltaY = this.points[index + 1] - y;
          if (deltaX * deltaX + deltaY * deltaY <= toleranceSquared) return true;
        }
      }
    }
    return false;
  }
}

/** How many of `points` lie within the tolerance of the contour in `grid`. */
function countWithin(points: Int32Array, grid: ContourGrid | null, toleranceSquared: number): number {
  if (!grid) return 0;
  let within = 0;
  for (let i = 0; i < points.length; i += 2) {
    if (grid.hasPointWithin(points[i], points[i + 1], toleranceSquared)) within++;
  }
  return within;
}

export interface SurfaceDistanceResult {
  /**
   * Fraction of both contours lying within tolerance of the other, 0..1.
   * Null when neither surgeon drew anything, where the measure is undefined.
   */
  nsd: number | null;
  /** Tolerance actually used, in pixels. */
  tolerancePixels: number;
  /** Boundary pixel counts, useful for judging how much contour was compared. */
  boundaryPixelsA: number;
  boundaryPixelsB: number;
}

/**
 * Normalised surface distance at a tolerance.
 *
 *   NSD = (|∂A within τ of ∂B| + |∂B within τ of ∂A|) / (|∂A| + |∂B|)
 *
 * 1 means every part of both contours is within τ of the other. The tolerance
 * is expressed as a fraction of the image diagonal so the number is comparable
 * across frames of different resolutions; at the 0.5% default that is about
 * 11 px on a 1920x1080 frame.
 *
 * If exactly one surgeon drew a zone, the result is 0: one contour exists and
 * none of it is near the other, which is a genuine total disagreement rather
 * than a missing value.
 */
export function normalisedSurfaceDistance(
  a: Occupancy,
  b: Occupancy,
  width: number,
  height: number,
  toleranceFraction: number = DEFAULT_TOLERANCE_FRACTION,
): SurfaceDistanceResult {
  const tolerancePixels = toleranceFraction * Math.sqrt(width * width + height * height);
  const toleranceSquared = tolerancePixels * tolerancePixels;

  const pointsA = boundaryPoints(a, width, height);
  const pointsB = boundaryPoints(b, width, height);
  const countA = pointsA.length / 2;
  const countB = pointsB.length / 2;

  if (countA === 0 && countB === 0) {
    return { nsd: null, tolerancePixels, boundaryPixelsA: 0, boundaryPixelsB: 0 };
  }

  const gridA = countA > 0 ? new ContourGrid(pointsA, width, tolerancePixels) : null;
  const gridB = countB > 0 ? new ContourGrid(pointsB, width, tolerancePixels) : null;

  const within =
    countWithin(pointsA, gridB, toleranceSquared) + countWithin(pointsB, gridA, toleranceSquared);

  return {
    nsd: within / (countA + countB),
    tolerancePixels,
    boundaryPixelsA: countA,
    boundaryPixelsB: countB,
  };
}

/**
 * Mean NSD over every pair where at least one surgeon drew something.
 *
 * Each mask's contour and grid are built once and reused across every pair they
 * appear in, rather than rebuilt for each of the k(k-1)/2 pairs.
 */
export function meanPairwiseNsd(
  masks: readonly Occupancy[],
  width: number,
  height: number,
  toleranceFraction: number = DEFAULT_TOLERANCE_FRACTION,
): { meanNsd: number | null; pairs: number; excludedEmptyPairs: number; tolerancePixels: number } {
  const tolerancePixels = toleranceFraction * Math.sqrt(width * width + height * height);
  const toleranceSquared = tolerancePixels * tolerancePixels;

  const points = masks.map((mask) => boundaryPoints(mask, width, height));
  const grids = points.map((list) =>
    list.length > 0 ? new ContourGrid(list, width, tolerancePixels) : null,
  );

  let sum = 0;
  let pairs = 0;
  let excludedEmptyPairs = 0;

  for (let i = 0; i < masks.length; i++) {
    for (let j = i + 1; j < masks.length; j++) {
      const countI = points[i].length / 2;
      const countJ = points[j].length / 2;
      if (countI === 0 && countJ === 0) {
        excludedEmptyPairs++;
        continue;
      }
      const within =
        countWithin(points[i], grids[j], toleranceSquared) +
        countWithin(points[j], grids[i], toleranceSquared);
      sum += within / (countI + countJ);
      pairs++;
    }
  }

  return {
    meanNsd: pairs > 0 ? sum / pairs : null,
    pairs,
    excludedEmptyPairs,
    tolerancePixels,
  };
}
