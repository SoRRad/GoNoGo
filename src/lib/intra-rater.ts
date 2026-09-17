import type Database from 'better-sqlite3';
import { readMaskOrEmpty } from './analysis';
import { meanPairwiseNsd, normalisedSurfaceDistance, DEFAULT_TOLERANCE_FRACTION } from './boundary';
import { memoiseOnAnnotations } from './cache';
import { cohenKappa, countSet, dice, iou, isEmpty, pixelAgreement } from './masks';
import type { Layer } from './types';

/**
 * Intra-rater reliability: how closely a surgeon reproduces their own judgement
 * when the same frame comes back, unannounced, at least 30 positions later.
 *
 * This is the ceiling on what inter-rater agreement can mean. If a surgeon
 * agrees with themselves at IoU 0.5, two surgeons agreeing at 0.5 is not
 * evidence of disagreement between them — it is the measurement noise floor.
 * It also catches drift: a surgeon whose repeats diverge as the study runs is
 * changing their criteria mid-study, and that is worth knowing while there is
 * still time to ask them about it.
 */

export interface LayerRepeatMetrics {
  /** Null when neither attempt marked anything: nothing spatial to compare. */
  iou: number | null;
  dice: number | null;
  nsd: number | null;
  pixelAgreement: number;
  firstPixels: number;
  repeatPixels: number;
  /** True when the surgeon marked this layer on exactly one of the two attempts. */
  presenceDisagreement: boolean;
}

export interface RepeatPair {
  surgeonId: number;
  surgeonName: string;
  frameId: number;
  firstAssignmentId: number;
  repeatAssignmentId: number;
  /** Queue positions, so drift over the session can be plotted. */
  firstDisplayOrder: number;
  repeatDisplayOrder: number;
  firstStatus: string;
  repeatStatus: string;
  firstConfidence: string | null;
  repeatConfidence: string | null;
  firstSeconds: number;
  repeatSeconds: number;
  go: LayerRepeatMetrics;
  nogo: LayerRepeatMetrics;
}

export interface SurgeonIntraRater {
  surgeonId: number;
  surgeonName: string;
  /** Repeat pairs where both showings were submitted. */
  pairs: number;
  go: LayerIntraRaterSummary;
  nogo: LayerIntraRaterSummary;
  /** Pairs where the surgeon gave a different status the second time. */
  statusChanges: number;
  /** Pairs where the confidence differed between showings. */
  confidenceChanges: number;
}

export interface LayerIntraRaterSummary {
  /** Pairs contributing to the spatial means (at least one attempt non-empty). */
  spatialPairs: number;
  excludedEmptyPairs: number;
  meanIou: number | null;
  meanDice: number | null;
  meanNsd: number | null;
  /** Did they make the same "is there a zone here" call both times? */
  presenceAgreement: number | null;
  presenceKappa: number | null;
  presenceKappaNote: string;
}

interface RepeatRow {
  surgeonId: number;
  surgeonName: string;
  frameId: number;
  width: number;
  height: number;
  firstAssignmentId: number;
  repeatAssignmentId: number;
  firstDisplayOrder: number;
  repeatDisplayOrder: number;
  firstStatus: string;
  repeatStatus: string;
  firstConfidence: string | null;
  repeatConfidence: string | null;
  firstSeconds: number;
  repeatSeconds: number;
  firstGo: string | null;
  firstNogo: string | null;
  repeatGo: string | null;
  repeatNogo: string | null;
}

const REPEAT_QUERY = `
  SELECT s.id                AS surgeonId,
         s.name              AS surgeonName,
         f.id                AS frameId,
         f.width             AS width,
         f.height            AS height,
         original.id         AS firstAssignmentId,
         repeat.id           AS repeatAssignmentId,
         original.display_order AS firstDisplayOrder,
         repeat.display_order   AS repeatDisplayOrder,
         firstAnnotation.status        AS firstStatus,
         repeatAnnotation.status       AS repeatStatus,
         firstAnnotation.confidence    AS firstConfidence,
         repeatAnnotation.confidence   AS repeatConfidence,
         firstAnnotation.seconds_spent AS firstSeconds,
         repeatAnnotation.seconds_spent AS repeatSeconds,
         firstAnnotation.go_mask_path    AS firstGo,
         firstAnnotation.nogo_mask_path  AS firstNogo,
         repeatAnnotation.go_mask_path   AS repeatGo,
         repeatAnnotation.nogo_mask_path AS repeatNogo
    FROM assignments repeat
    JOIN assignments original ON original.id = repeat.repeat_of_assignment_id
    JOIN frames   f ON f.id = repeat.frame_id
    JOIN surgeons s ON s.id = repeat.surgeon_id
    JOIN annotations firstAnnotation  ON firstAnnotation.assignment_id  = original.id
    JOIN annotations repeatAnnotation ON repeatAnnotation.assignment_id = repeat.id
   WHERE repeat.is_repeat = 1
     AND firstAnnotation.submitted_at  IS NOT NULL
     AND repeatAnnotation.submitted_at IS NOT NULL
     -- 'cannot_assess' is not a spatial judgement, so it cannot be compared.
     AND firstAnnotation.status  IN ('drawn', 'nothing_to_mark')
     AND repeatAnnotation.status IN ('drawn', 'nothing_to_mark')
   ORDER BY s.id, original.display_order`;

function layerMetrics(
  firstPath: string | null,
  repeatPath: string | null,
  width: number,
  height: number,
  toleranceFraction: number,
): LayerRepeatMetrics {
  const first = readMaskOrEmpty(firstPath, width, height);
  const repeat = readMaskOrEmpty(repeatPath, width, height);
  const firstEmpty = isEmpty(first);
  const repeatEmpty = isEmpty(repeat);

  return {
    iou: iou(first, repeat),
    dice: dice(first, repeat),
    nsd: normalisedSurfaceDistance(first, repeat, width, height, toleranceFraction).nsd,
    pixelAgreement: pixelAgreement(first, repeat),
    firstPixels: countSet(first),
    repeatPixels: countSet(repeat),
    presenceDisagreement: firstEmpty !== repeatEmpty,
  };
}

/** Every repeat pair in the study, with both attempts compared. */
export function loadRepeatPairs(
  db: Database.Database,
  toleranceFraction: number = DEFAULT_TOLERANCE_FRACTION,
): RepeatPair[] {
  const rows = db.prepare(REPEAT_QUERY).all() as RepeatRow[];

  return rows.map((row) => ({
    surgeonId: row.surgeonId,
    surgeonName: row.surgeonName,
    frameId: row.frameId,
    firstAssignmentId: row.firstAssignmentId,
    repeatAssignmentId: row.repeatAssignmentId,
    firstDisplayOrder: row.firstDisplayOrder,
    repeatDisplayOrder: row.repeatDisplayOrder,
    firstStatus: row.firstStatus,
    repeatStatus: row.repeatStatus,
    firstConfidence: row.firstConfidence,
    repeatConfidence: row.repeatConfidence,
    firstSeconds: row.firstSeconds,
    repeatSeconds: row.repeatSeconds,
    go: layerMetrics(row.firstGo, row.repeatGo, row.width, row.height, toleranceFraction),
    nogo: layerMetrics(row.firstNogo, row.repeatNogo, row.width, row.height, toleranceFraction),
  }));
}

function summariseLayer(pairs: RepeatPair[], layer: Layer): LayerIntraRaterSummary {
  const metrics = pairs.map((pair) => pair[layer]);
  const spatial = metrics.filter((metric) => metric.iou !== null);

  const mean = (values: (number | null)[]): number | null => {
    const present = values.filter((value): value is number => value !== null);
    return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
  };

  // Presence: the surgeon versus themselves, one binary item per repeat pair.
  // That is exactly the two-rater setting Cohen's kappa is defined for.
  const firstCalls = metrics.map((metric) => metric.firstPixels > 0);
  const repeatCalls = metrics.map((metric) => metric.repeatPixels > 0);
  const { kappa, note } = cohenKappa(firstCalls, repeatCalls);
  const agreeing = metrics.filter((metric) => !metric.presenceDisagreement).length;

  return {
    spatialPairs: spatial.length,
    excludedEmptyPairs: metrics.length - spatial.length,
    meanIou: mean(spatial.map((metric) => metric.iou)),
    meanDice: mean(spatial.map((metric) => metric.dice)),
    meanNsd: mean(spatial.map((metric) => metric.nsd)),
    presenceAgreement: metrics.length > 0 ? agreeing / metrics.length : null,
    presenceKappa: kappa,
    presenceKappaNote: note,
  };
}

/** One row per surgeon who has completed at least one repeat pair. */
export function summariseIntraRater(
  db: Database.Database,
  toleranceFraction: number = DEFAULT_TOLERANCE_FRACTION,
): SurgeonIntraRater[] {
  const pairs = loadRepeatPairs(db, toleranceFraction);
  const bySurgeon = new Map<number, RepeatPair[]>();
  for (const pair of pairs) {
    const bucket = bySurgeon.get(pair.surgeonId);
    if (bucket) bucket.push(pair);
    else bySurgeon.set(pair.surgeonId, [pair]);
  }

  return [...bySurgeon.entries()]
    .map(([surgeonId, surgeonPairs]) => ({
      surgeonId,
      surgeonName: surgeonPairs[0].surgeonName,
      pairs: surgeonPairs.length,
      go: summariseLayer(surgeonPairs, 'go'),
      nogo: summariseLayer(surgeonPairs, 'nogo'),
      statusChanges: surgeonPairs.filter((pair) => pair.firstStatus !== pair.repeatStatus).length,
      confidenceChanges: surgeonPairs.filter((pair) => pair.firstConfidence !== pair.repeatConfidence).length,
    }))
    .sort((a, b) => a.surgeonId - b.surgeonId);
}

export { meanPairwiseNsd };

/**
 * The same summary, cached against the annotations table.
 *
 * Use this on the admin page, which is opened repeatedly while the study runs.
 * Use summariseIntraRater directly for the export, which runs once and should
 * always read fresh.
 */
export const summariseIntraRaterCached = memoiseOnAnnotations((db) => summariseIntraRater(db));
