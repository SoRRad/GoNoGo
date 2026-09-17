import fs from 'fs';
import type Database from 'better-sqlite3';
import { fromRelative } from './paths';
import {
  cohenKappa,
  emptyOccupancy,
  fleissKappa,
  isEmpty,
  readBinaryMaskPng,
  summariseAgreement,
  type AgreementSummary,
  type Occupancy,
  type PresenceAgreement,
} from './masks';
import { DEFAULT_TOLERANCE_FRACTION, meanPairwiseNsd } from './boundary';

/**
 * Reads a stored mask, degrading to an all-zero mask of the frame's size if the
 * file is absent, unreadable, or the wrong dimensions. A study export must not
 * fall over because one file went missing; the absence shows up as zero painted
 * pixels, which the CSV makes visible.
 */
export function readMaskOrEmpty(
  relative: string | null,
  width: number,
  height: number,
): Occupancy {
  if (!relative) return emptyOccupancy(width, height);
  const absolute = fromRelative(relative);
  if (!fs.existsSync(absolute)) return emptyOccupancy(width, height);
  try {
    const mask = readBinaryMaskPng(absolute);
    if (mask.width !== width || mask.height !== height) return emptyOccupancy(width, height);
    return mask.data;
  } catch {
    return emptyOccupancy(width, height);
  }
}

export interface RaterMask {
  surgeonId: number;
  surgeonName: string;
  status: string;
  /** Null when the surgeon marked the layer empty; treated as all-zero. */
  occupancy: Occupancy;
  painted: number;
}

export interface BoundarySummary {
  meanNsd: number | null;
  pairs: number;
  excludedEmptyPairs: number;
  tolerancePixels: number;
}

export interface LayerAgreement extends AgreementSummary {
  /** Contour agreement, which area overlap alone does not capture. */
  boundary: BoundarySummary;
}

export interface FrameAgreement {
  frameId: number;
  width: number;
  height: number;
  go: LayerAgreement;
  nogo: LayerAgreement;
  raters: { surgeonId: number; surgeonName: string; status: string; goPixels: number; nogoPixels: number }[];
}

/**
 * Who counts as a rater for a frame.
 *
 * A surgeon who said there was nothing to mark is a genuine vote of "no zone
 * here", so they contribute an all-zero mask. A surgeon who could not assess
 * the frame is not a vote at all and is left out.
 */
export function loadRaters(
  db: Database.Database,
  frameId: number,
  width: number,
  height: number,
): { go: RaterMask[]; nogo: RaterMask[] } {
  const rows = db
    .prepare(
      `SELECT an.surgeon_id AS surgeonId,
              s.name         AS surgeonName,
              an.status      AS status,
              an.go_mask_path   AS goPath,
              an.nogo_mask_path AS nogoPath
         FROM annotations an
         JOIN assignments a ON a.id = an.assignment_id
         JOIN surgeons   s ON s.id = an.surgeon_id
        WHERE an.frame_id = ?
          AND an.submitted_at IS NOT NULL
          AND an.status IN ('drawn', 'nothing_to_mark')
          -- Only the first showing. A surgeon who also got this frame as a
          -- hidden repeat has two submitted annotations for it; counting both
          -- would weight them twice in the majority vote and, worse, add a
          -- self-pair to the pairwise agreement, folding that surgeon's
          -- intra-rater consistency into the inter-rater figure and inflating
          -- it. The repeat belongs to intra-rater analysis and only there.
          AND a.is_repeat = 0
        ORDER BY an.surgeon_id`,
    )
    .all(frameId) as {
    surgeonId: number;
    surgeonName: string;
    status: string;
    goPath: string | null;
    nogoPath: string | null;
  }[];

  const read = (relative: string | null) => readMaskOrEmpty(relative, width, height);

  const count = (occupancy: Occupancy) => {
    let n = 0;
    for (let i = 0; i < occupancy.length; i++) if (occupancy[i]) n++;
    return n;
  };

  const go: RaterMask[] = [];
  const nogo: RaterMask[] = [];
  for (const row of rows) {
    const goMask = read(row.goPath);
    const nogoMask = read(row.nogoPath);
    go.push({
      surgeonId: row.surgeonId,
      surgeonName: row.surgeonName,
      status: row.status,
      occupancy: goMask,
      painted: count(goMask),
    });
    nogo.push({
      surgeonId: row.surgeonId,
      surgeonName: row.surgeonName,
      status: row.status,
      occupancy: nogoMask,
      painted: count(nogoMask),
    });
  }
  return { go, nogo };
}

/** Agreement for one layer from masks already in hand. */
export function summariseLayerAgreement(
  masks: Occupancy[],
  width: number,
  height: number,
  toleranceFraction: number = DEFAULT_TOLERANCE_FRACTION,
): LayerAgreement {
  return {
    ...summariseAgreement(masks, width, height),
    boundary: meanPairwiseNsd(masks, width, height, toleranceFraction),
  };
}

/**
 * Builds a frame summary from raters already loaded. Decoding every mask PNG
 * again is the dominant cost in the export, so callers that have the masks pass
 * them straight in.
 */
export function frameAgreementFromRaters(
  raters: { go: RaterMask[]; nogo: RaterMask[] },
  frameId: number,
  width: number,
  height: number,
  toleranceFraction: number = DEFAULT_TOLERANCE_FRACTION,
): FrameAgreement {
  const { go, nogo } = raters;
  return {
    frameId,
    width,
    height,
    go: summariseLayerAgreement(go.map((rater) => rater.occupancy), width, height, toleranceFraction),
    nogo: summariseLayerAgreement(nogo.map((rater) => rater.occupancy), width, height, toleranceFraction),
    raters: go.map((rater, index) => ({
      surgeonId: rater.surgeonId,
      surgeonName: rater.surgeonName,
      status: rater.status,
      goPixels: rater.painted,
      nogoPixels: nogo[index].painted,
    })),
  };
}

export function frameAgreement(
  db: Database.Database,
  frameId: number,
  width: number,
  height: number,
  toleranceFraction: number = DEFAULT_TOLERANCE_FRACTION,
): FrameAgreement {
  const { go, nogo } = loadRaters(db, frameId, width, height);

  const summarise = (masks: Occupancy[]): LayerAgreement =>
    summariseLayerAgreement(masks, width, height, toleranceFraction);

  return {
    frameId,
    width,
    height,
    go: summarise(go.map((rater) => rater.occupancy)),
    nogo: summarise(nogo.map((rater) => rater.occupancy)),
    raters: go.map((rater, index) => ({
      surgeonId: rater.surgeonId,
      surgeonName: rater.surgeonName,
      status: rater.status,
      goPixels: rater.painted,
      nogoPixels: nogo[index].painted,
    })),
  };
}

export interface StudyPresenceAgreement {
  layer: 'go' | 'nogo';
  /** Frames contributing, all with the same rater count. */
  frames: number;
  /** The rater count those frames share. */
  raters: number;
  /** Frames on which at least one surgeon marked this layer. */
  framesWithAnyMark: number;
  observedAgreement: number | null;
  kappa: number | null;
  kappaNote: PresenceAgreement['kappaNote'];
}

/**
 * Presence agreement across the study: for each frame, did the surgeons agree
 * that a zone of this class exists at all?
 *
 * Kappa needs several items to estimate how often raters would agree by chance,
 * so it is computed over frames rather than within one. Fleiss' kappa also
 * assumes a fixed number of raters per item, so only the largest group of
 * frames sharing a rater count is used; `frames` and `raters` say which.
 */
/**
 * Presence agreement for both layers, from the database alone.
 *
 * Presence asks only whether a surgeon marked any pixel of a class, and the
 * save path already answers that: a mask is written only when it is non-empty,
 * and an emptied layer has its file removed and its path set back to NULL. So
 * `go_mask_path IS NOT NULL` is exactly "this surgeon marked a Go zone", with
 * no PNG to decode. Deriving it from the pixels instead meant decoding every
 * mask in the study on every admin page load — about 7 seconds for a 60-frame
 * test set, and roughly a minute for a full one.
 */
export function studyPresenceAgreementBothLayers(db: Database.Database): {
  go: StudyPresenceAgreement;
  nogo: StudyPresenceAgreement;
} {
  const rows = db
    .prepare(
      `SELECT an.frame_id                          AS frameId,
              COUNT(*)                             AS raters,
              SUM(CASE WHEN an.go_mask_path   IS NOT NULL THEN 1 ELSE 0 END) AS goPositives,
              SUM(CASE WHEN an.nogo_mask_path IS NOT NULL THEN 1 ELSE 0 END) AS nogoPositives
         FROM annotations an
         JOIN assignments a ON a.id = an.assignment_id
         JOIN frames     f ON f.id = an.frame_id
        WHERE f.is_practice = 0
          AND an.submitted_at IS NOT NULL
          AND an.status IN ('drawn', 'nothing_to_mark')
          -- First showings only; see loadRaters for why.
          AND a.is_repeat = 0
        GROUP BY an.frame_id
       HAVING COUNT(*) >= 2
        ORDER BY an.frame_id`,
    )
    .all() as { frameId: number; raters: number; goPositives: number; nogoPositives: number }[];

  const buckets = {
    go: new Map<number, { positives: number; total: number }[]>(),
    nogo: new Map<number, { positives: number; total: number }[]>(),
  };

  for (const row of rows) {
    for (const layer of ['go', 'nogo'] as const) {
      const positives = layer === 'go' ? row.goPositives : row.nogoPositives;
      const bucket = buckets[layer].get(row.raters) ?? [];
      bucket.push({ positives, total: row.raters });
      buckets[layer].set(row.raters, bucket);
    }
  }

  return {
    go: summarisePresenceBuckets('go', buckets.go),
    nogo: summarisePresenceBuckets('nogo', buckets.nogo),
  };
}

function summarisePresenceBuckets(
  layer: 'go' | 'nogo',
  byRaterCount: Map<number, { positives: number; total: number }[]>,
): StudyPresenceAgreement {
  let chosenCount = 0;
  let chosen: { positives: number; total: number }[] = [];
  for (const [count, items] of byRaterCount) {
    if (items.length > chosen.length) {
      chosen = items;
      chosenCount = count;
    }
  }

  if (chosen.length === 0) {
    return {
      layer,
      frames: 0,
      raters: 0,
      framesWithAnyMark: 0,
      observedAgreement: null,
      kappa: null,
      kappaNote: 'insufficient_raters',
    };
  }

  let observedSum = 0;
  for (const item of chosen) {
    const yes = item.positives;
    const no = item.total - yes;
    observedSum += (yes * (yes - 1) + no * (no - 1)) / (item.total * (item.total - 1));
  }

  const counts = chosen.map((item) => item.positives);
  const { kappa, note } =
    chosenCount === 2
      ? cohenKappa(
          counts.map((positives) => positives >= 1),
          counts.map((positives) => positives === 2),
        )
      : fleissKappa(counts, chosenCount);

  return {
    layer,
    frames: chosen.length,
    raters: chosenCount,
    framesWithAnyMark: chosen.filter((item) => item.positives > 0).length,
    observedAgreement: observedSum / chosen.length,
    kappa,
    kappaNote: note,
  };
}

export function studyPresenceAgreement(
  db: Database.Database,
  layer: 'go' | 'nogo',
): StudyPresenceAgreement {
  const frames = db
    .prepare(
      `SELECT f.id AS frameId, f.width AS width, f.height AS height
         FROM frames f
        WHERE f.is_practice = 0
          AND EXISTS (SELECT 1 FROM annotations an
                       WHERE an.frame_id = f.id AND an.submitted_at IS NOT NULL
                         AND an.status IN ('drawn', 'nothing_to_mark'))
        ORDER BY f.id`,
    )
    .all() as { frameId: number; width: number; height: number }[];

  // Group frames by how many surgeons rated them.
  const byRaterCount = new Map<number, { positives: number; total: number }[]>();
  for (const frame of frames) {
    const raters = loadRaters(db, frame.frameId, frame.width, frame.height)[layer];
    if (raters.length < 2) continue;
    const positives = raters.filter((rater) => !isEmpty(rater.occupancy)).length;
    const bucket = byRaterCount.get(raters.length) ?? [];
    bucket.push({ positives, total: raters.length });
    byRaterCount.set(raters.length, bucket);
  }

  let chosenCount = 0;
  let chosen: { positives: number; total: number }[] = [];
  for (const [count, items] of byRaterCount) {
    if (items.length > chosen.length) {
      chosen = items;
      chosenCount = count;
    }
  }

  if (chosen.length === 0) {
    return {
      layer,
      frames: 0,
      raters: 0,
      framesWithAnyMark: 0,
      observedAgreement: null,
      kappa: null,
      kappaNote: 'insufficient_raters',
    };
  }

  // Observed agreement: mean proportion of rater pairs making the same call.
  let observedSum = 0;
  for (const item of chosen) {
    const yes = item.positives;
    const no = item.total - yes;
    observedSum +=
      (yes * (yes - 1) + no * (no - 1)) / (item.total * (item.total - 1));
  }

  const counts = chosen.map((item) => item.positives);
  const { kappa, note } =
    chosenCount === 2
      ? cohenKappa(
          // With two raters the per-frame counts do not say who said yes, so
          // reconstruct a consistent pair: both yes, both no, or a split.
          counts.map((positives) => positives >= 1),
          counts.map((positives) => positives === 2),
        )
      : fleissKappa(counts, chosenCount);

  return {
    layer,
    frames: chosen.length,
    raters: chosenCount,
    framesWithAnyMark: chosen.filter((item) => item.positives > 0).length,
    observedAgreement: observedSum / chosen.length,
    kappa,
    kappaNote: note,
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
