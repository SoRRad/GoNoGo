import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import type Database from 'better-sqlite3';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { getDb } from './db';
import type { Frame } from './db';
import { framePath } from './paths';
import { encodeBinaryMaskPng, majorityVote } from './masks';
import {
  frameAgreementFromRaters,
  loadRaters,
  readMaskOrEmpty,
  studyPresenceAgreementBothLayers,
} from './analysis';
import type { RaterMask } from './analysis';
import { DEFAULT_TOLERANCE_FRACTION } from './boundary';
import { loadRepeatPairs, summariseIntraRater } from './intra-rater';
import { makeRng, seededShuffle } from './queue';

/** Fixed, so the suggested split is reproducible from the export alone. */
const SPLIT_SEED = 0x5A01;

const CSV_COLUMNS = [
  'annotation_id',
  'assignment_id',
  'surgeon_id',
  'surgeon_name',
  'surgeon_email',
  'years_in_practice',
  'cases_per_year',
  'frame_id',
  'frame_filename',
  'source_video',
  'frame_width',
  'frame_height',
  'is_practice',
  'display_order',
  'is_repeat',
  'repeat_of_assignment_id',
  'status',
  'confidence',
  'go_mask_path',
  'nogo_mask_path',
  'go_pixels',
  'nogo_pixels',
  'seconds_spent',
  'undo_count',
  'created_at',
  'updated_at',
  'submitted_at',
] as const;

/** RFC 4180 quoting: wrap in quotes and double any embedded quote. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A frame already stored as PNG is referenced by path so the archiver streams
 * it straight off disk; a JPEG has to be transcoded, one at a time, because the
 * export format is PNG throughout.
 */
function frameEntryBody(frame: Frame): { buffer: Buffer } | { sourcePath: string } | null {
  const absolute = framePath(frame.filename);
  if (!fs.existsSync(absolute)) return null;
  if (path.extname(frame.filename).toLowerCase() === '.png') return { sourcePath: absolute };

  const decoded = jpeg.decode(fs.readFileSync(absolute), { useTArray: true, formatAsRGBA: true });
  const png = new PNG({ width: decoded.width, height: decoded.height });
  png.data = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length);
  return { buffer: PNG.sync.write(png) };
}

const README = `SADI Go/No-Go dissection zone study — data export
=================================================

Generated: {{GENERATED}}

-------------------------------------------------------------------------------
IMAGES
-------------------------------------------------------------------------------

frames/<frame_id>.png
    The still frame that was shown, at its native resolution. Always PNG, even
    if the frame was ingested as JPEG.

masks/<frame_id>__<surgeon_id>__go.png
masks/<frame_id>__<surgeon_id>__nogo.png
    One binary mask per surgeon per layer, at the frame's native resolution.
    8-bit grayscale: 255 means the surgeon included that pixel, 0 means they did
    not. Go and No-Go are independent layers and may overlap; they are never
    merged. A file is present only where that surgeon painted something, so an
    absent file means an empty layer, not missing data.

repeats/<frame_id>__<surgeon_id>__<assignment_id>__go.png
repeats/<frame_id>__<surgeon_id>__<assignment_id>__nogo.png
    The surgeon's SECOND attempt at a frame they were shown twice. Same format
    as masks/. Kept separate because masks/ holds exactly one opinion per
    (frame, surgeon, layer) and can be read positionally; a repeat is the same
    surgeon again, not another surgeon. Pair them using assignment_id, or read
    intra_rater_pairs.csv, which has already done the comparison.

consensus/<frame_id>__go_majority.png
consensus/<frame_id>__nogo_majority.png
    Pixel majority vote across the surgeons who rated that frame: a pixel is set
    where strictly more than half of them included it. Same format as the masks.
    Written for frames rated by two or more surgeons.

-------------------------------------------------------------------------------
WHO COUNTS AS A RATER
-------------------------------------------------------------------------------

Every surgeon whose annotation was submitted with status 'drawn' or
'nothing_to_mark'.

A surgeon who said there was nothing to mark is a real opinion and votes zero
across the whole frame. Annotations with status 'cannot_assess' are excluded
from every statistic in this export: not being able to judge a frame is not a
judgement about it.

FIRST SHOWINGS ONLY, FOR EVERYTHING BETWEEN SURGEONS
    masks/, consensus/, frame_agreement.csv and presence_agreement.csv use only
    each surgeon's FIRST showing of a frame (is_repeat = 0).

    A surgeon who also received a frame as a hidden repeat has two submitted
    annotations for it. Counting both would weight that surgeon twice in the
    majority vote and, worse, introduce a pair of that surgeon with themselves
    into the pairwise agreement — folding their intra-rater consistency into a
    figure that is supposed to be between surgeons, and inflating it. The second
    showing appears only in repeats/ and the intra-rater tables.

-------------------------------------------------------------------------------
HOW AGREEMENT IS MEASURED
-------------------------------------------------------------------------------

Two different questions are reported separately, and should stay separate in
any analysis:

  PRESENCE  Did the surgeons agree that a zone of this class exists on this
            frame at all?
  SHAPE     Given that they drew one, how closely do the regions correspond?

Collapsing these into a single number hides which one is driving a result. A
frame where everyone agrees there is no Go zone, and a frame where everyone
drew the same Go zone, are both "perfect agreement" but mean different things.

EXCLUSION RULE FOR SHAPE METRICS
    A pair of surgeons contributes to IoU, Dice and NSD only if AT LEAST ONE of
    the two marked at least one pixel of that layer.

    Pairs where BOTH masks are empty are excluded and counted separately in
    'excluded_empty_pairs'. Overlap is undefined for such a pair, not perfect:
    two surgeons who both drew nothing have made no spatial claim to compare.
    Scoring them 1 and averaging them in would inflate the mean towards 1 on
    exactly those frames where the least was drawn. Their agreement about
    absence is captured by the presence statistics instead, which is where it
    belongs.

    A pair where exactly one surgeon drew something scores 0, not null. That is
    a real and total disagreement about shape, and it is counted.

METRICS
    mean_iou        Mean pairwise intersection over union, |A∩B| / |A∪B|.
                    Ignores the shared background. 1 is identical regions.
    mean_dice       Mean pairwise Dice / F1, 2|A∩B| / (|A|+|B|). Monotonically
                    related to IoU as Dice = 2·IoU/(1+IoU), so it always reads
                    higher than IoU on the same data. Both are given because
                    the segmentation literature is split on which to quote;
                    quote one, not whichever is larger.
    mean_nsd        Mean pairwise normalised surface distance. The fraction of
                    both contours lying within a tolerance of the other
                    contour:
                        NSD = (|∂A within τ of ∂B| + |∂B within τ of ∂A|)
                              / (|∂A| + |∂B|)
                    Area overlap is dominated by the interior of a region, so
                    two surgeons can score well on IoU while disagreeing about
                    exactly where the edge runs — which for a dissection
                    boundary is the part that matters. NSD asks the edge
                    question directly. τ is ${(DEFAULT_TOLERANCE_FRACTION * 100).toFixed(
                      1,
                    )}% of the image diagonal,
                    given per row in 'nsd_tolerance_px' (about 11 px on a
                    1920x1080 frame). Distances are exact Euclidean.
    mean_pixel_agreement
                    Mean pairwise share of the WHOLE frame classified the same
                    way, background included. Reported for completeness and
                    because it is what a naive pixel-accuracy figure would give.
                    It is dominated by background on a sparse frame and will
                    read above 90% even for poor spatial agreement. DO NOT quote
                    it as the headline agreement figure.
    presence_observed_agreement
                    Share of surgeon pairs on this frame making the same yes/no
                    call about whether this class is present.

CHANCE-CORRECTED AGREEMENT
    Kappa needs several items to estimate how often raters would agree by
    chance, so it cannot be computed within a single frame and is not given in
    frame_agreement.csv. It appears in:
      presence_agreement.csv    across frames, for the study as a whole
      intra_rater_summary.csv   across a surgeon's own repeat pairs

    Cohen's kappa is used for exactly two raters, Fleiss' kappa for three or
    more. Fleiss' assumes a fixed number of raters per item, so
    presence_agreement.csv uses only the largest group of frames sharing a
    rater count; 'frames' and 'raters' record which group that was.

    kappa is EMPTY, never NaN, when it is undefined. 'kappa_note' says why:
      cohen                 Cohen's kappa, two raters.
      fleiss                Fleiss' kappa, three or more raters.
      undefined_unanimous   Every rater made the same call on every frame.
                            Expected agreement is then 1 and kappa is 0/0.
                            This is a favourable result, not missing data:
                            read it together with observed_agreement, which
                            will be 1.
      insufficient_raters   Fewer than two raters, or no items.

-------------------------------------------------------------------------------
TABLES
-------------------------------------------------------------------------------

videos.csv
    frame_id to source_video, with dimensions. The grouping every split and every
    cross-validation fold should respect.

splits.csv
    A SUGGESTED train / validation / test split, 70/15/15, assigned BY VIDEO with
    a fixed seed so it is reproducible from this archive alone.

    SPLIT BY VIDEO, NOT BY FRAME.
    Frames taken from one operation are highly correlated: neighbouring stills
    share anatomy, lighting, camera pose and the same patient. Assigning frames
    independently puts near-duplicates of a training image into the test set, so
    a model is scored partly on images it has effectively already seen and the
    reported performance is optimistic — sometimes dramatically so. Every frame
    of a video is therefore assigned to exactly one split here.

    Frames with no recorded source_video are each treated as their own group,
    since pooling them would assert they came from the same operation.

    This split is a default, not a recommendation for any particular analysis.

    CHECK IT BEFORE USING IT. With few videos the proportions cannot be met: at
    four videos, 15% rounds down to zero and the validation set comes out EMPTY.
    It is also worth confirming the split did not put all of one surgeon's
    individual frames on one side. videos.csv has what you need to build your
    own folds, and grouped k-fold over videos is usually the better choice when
    the number of operations is small.

annotations.csv
    One row per submitted annotation, with the surgeon and frame metadata
    joined in. Columns:

{{COLUMNS}}

    Notes on particular columns:
      status          drawn | nothing_to_mark | cannot_assess
      confidence      low | medium | high. Empty for the two status buttons,
                      which advance without asking for a confidence.
      go_pixels       Painted pixel count, recomputed from the mask file.
      nogo_pixels     Same, for the No-Go layer.
      seconds_spent   Wall-clock seconds on the frame, paused whenever the tab
                      was not in front. Never shown to the surgeon.
      undo_count      How many times undo was pressed on that frame.
      is_repeat       1 when this assignment is a hidden second showing of a
                      frame the same surgeon already annotated. Use with
                      repeat_of_assignment_id to measure intra-rater
                      reliability, or read intra_rater_pairs.csv which has
                      already done it.
      display_order   Position in that surgeon's queue, 0-based. Practice frames
                      always occupy the first positions.
      is_practice     1 for the shared practice frames. Exclude these from
                      analysis: they were never scored and carry no feedback.

frame_agreement.csv
    One row per frame per layer, for every frame at least one surgeon rated.
    Inter-rater agreement, using the metrics and exclusion rule above.
      n_raters                    Surgeons contributing an opinion.
      n_marked                    How many of them marked at least one pixel.
      spatial_pairs               Pairs used for IoU, Dice and NSD.
      excluded_empty_pairs        Pairs skipped because both masks were empty.
      consensus_pixels            Area of the majority-vote mask.

intra_rater_pairs.csv
    One row per hidden repeat per layer: the same surgeon's two attempts at the
    same frame, compared with the same metrics.

    This is the ceiling on what inter-rater agreement can mean. If a surgeon
    agrees with themselves at IoU 0.5, two surgeons agreeing at 0.5 is not
    evidence that they disagree — it is the measurement noise floor. Report
    inter-rater agreement against this baseline, not against 1.

      queue_gap               Positions between the two showings, always >= 30.
                              Useful for checking that a repeat was not simply
                              remembered.
      first_display_order     Where each showing fell in the queue. A surgeon
      repeat_display_order    whose repeats diverge as the numbers grow is
                              drifting mid-study.
      presence_disagreement   1 when the surgeon marked this layer on exactly
                              one of the two attempts.
    Pairs where either attempt was 'cannot_assess', or where either attempt is
    not yet submitted, are omitted entirely.

intra_rater_summary.csv
    One row per surgeon per layer, aggregating intra_rater_pairs.csv.
      presence_kappa          Cohen's kappa of the surgeon against themselves,
                              one binary item per repeat pair. Empty when
                              undefined; see presence_kappa_note.
      status_changes          Repeat pairs where the surgeon gave a different
                              status the second time.
      confidence_changes      Repeat pairs where the confidence differed.

presence_agreement.csv
    Study-level presence agreement, one row per layer. See the kappa notes
    above for how the frame group is chosen.

-------------------------------------------------------------------------------
INDEPENDENCE
-------------------------------------------------------------------------------

Every surgeon annotated alone. No surgeon could see another surgeon's masks or
any aggregate at any point, and no anatomy class labels appeared anywhere in the
interface. Repeat frames were presented identically to first showings, with
nothing marking them as repeats.
`;

export interface ExportStats {
  frames: number;
  masks: number;
  consensusFrames: number;
  annotations: number;
  agreementRows: number;
  repeatPairs: number;
}

/** One file in the export: either bytes we built, or a file to stream off disk. */
export type ExportEntry =
  | { name: string; buffer: Buffer }
  | { name: string; text: string }
  | { name: string; sourcePath: string };

/**
 * Walks the study and hands every export file to `emit`, in order.
 *
 * Emitting rather than returning an array keeps memory bounded: a finished
 * study is hundreds of megabytes of frames, and the archiver consumes each
 * entry as it is produced. It also gives tests a seam that does not involve
 * unzipping anything.
 */
export function collectExportEntries(
  db: Database.Database,
  emit: (entry: ExportEntry) => void,
): ExportStats {
  const stats: ExportStats = {
    frames: 0,
    masks: 0,
    consensusFrames: 0,
    annotations: 0,
    agreementRows: 0,
    repeatPairs: 0,
  };

  const frames = db.prepare('SELECT * FROM frames ORDER BY id').all() as Frame[];
  const paintedCache = new Map<string, number>();
  // Masks are kept from the emit pass so the agreement pass does not decode
  // every PNG in the study a second time.
  const ratedFrames: { frame: Frame; raters: { go: RaterMask[]; nogo: RaterMask[] } }[] = [];

  for (const frame of frames) {
    const raters = loadRaters(db, frame.id, frame.width, frame.height);
    const contributing = raters.go.length;

    // Only export a frame that somebody actually rated.
    if (contributing === 0) continue;
    ratedFrames.push({ frame, raters });

    const frameBody = frameEntryBody(frame);
    if (frameBody) {
      emit({ name: `export/frames/${frame.id}.png`, ...frameBody });
      stats.frames++;
    }

    for (const layer of ['go', 'nogo'] as const) {
      for (const rater of raters[layer]) {
        paintedCache.set(`${frame.id}:${rater.surgeonId}:${layer}`, rater.painted);
        if (rater.painted === 0) continue;
        emit({
          name: `export/masks/${frame.id}__${rater.surgeonId}__${layer}.png`,
          buffer: encodeBinaryMaskPng(frame.width, frame.height, rater.occupancy),
        });
        stats.masks++;
      }
    }

    if (contributing >= 2) {
      for (const layer of ['go', 'nogo'] as const) {
        const vote = majorityVote(
          raters[layer].map((rater) => rater.occupancy),
          frame.width,
          frame.height,
        );
        emit({
          name: `export/consensus/${frame.id}__${layer}_majority.png`,
          buffer: encodeBinaryMaskPng(frame.width, frame.height, vote),
        });
      }
      stats.consensusFrames++;
    }
  }

  const rows = db
    .prepare(
      `SELECT an.id                      AS annotation_id,
              an.assignment_id           AS assignment_id,
              an.surgeon_id              AS surgeon_id,
              s.name                     AS surgeon_name,
              s.email                    AS surgeon_email,
              s.years_in_practice        AS years_in_practice,
              s.cases_per_year           AS cases_per_year,
              an.frame_id                AS frame_id,
              f.filename                 AS frame_filename,
              f.source_video             AS source_video,
              f.width                    AS frame_width,
              f.height                   AS frame_height,
              f.is_practice              AS is_practice,
              a.display_order            AS display_order,
              a.is_repeat                AS is_repeat,
              a.repeat_of_assignment_id  AS repeat_of_assignment_id,
              an.status                  AS status,
              an.confidence              AS confidence,
              an.go_mask_path            AS go_mask_path,
              an.nogo_mask_path          AS nogo_mask_path,
              an.seconds_spent           AS seconds_spent,
              an.undo_count              AS undo_count,
              an.created_at              AS created_at,
              an.updated_at              AS updated_at,
              an.submitted_at            AS submitted_at
         FROM annotations an
         JOIN assignments a ON a.id = an.assignment_id
         JOIN surgeons s    ON s.id = an.surgeon_id
         JOIN frames f      ON f.id = an.frame_id
        WHERE an.submitted_at IS NOT NULL
        ORDER BY an.surgeon_id, a.display_order`,
    )
    .all() as Record<string, unknown>[];

  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    row.go_pixels = paintedCache.get(`${row.frame_id}:${row.surgeon_id}:go`) ?? '';
    row.nogo_pixels = paintedCache.get(`${row.frame_id}:${row.surgeon_id}:nogo`) ?? '';
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  stats.annotations = rows.length;
  emit({ name: 'export/annotations.csv', text: lines.join('\n') + '\n' });

  // ---- frame_agreement.csv: one row per frame per layer -------------------
  const agreementColumns = [
    'frame_id', 'source_video', 'frame_width', 'frame_height', 'layer',
    'n_raters', 'n_marked', 'presence_observed_agreement',
    'spatial_pairs', 'excluded_empty_pairs',
    'mean_iou', 'mean_dice', 'mean_nsd', 'nsd_tolerance_px',
    'mean_pixel_agreement', 'consensus_pixels',
  ];
  const agreementLines = [agreementColumns.join(',')];

  for (const { frame, raters } of ratedFrames) {
    const agreement = frameAgreementFromRaters(
      raters,
      frame.id,
      frame.width,
      frame.height,
      DEFAULT_TOLERANCE_FRACTION,
    );
    for (const layer of ['go', 'nogo'] as const) {
      const summary = agreement[layer];
      agreementLines.push(
        [
          frame.id, frame.source_video, frame.width, frame.height, layer,
          summary.n, summary.presence.positive, summary.presence.observedAgreement,
          summary.spatialPairs, summary.excludedEmptyPairs,
          summary.meanIou, summary.meanDice, summary.boundary.meanNsd,
          summary.boundary.tolerancePixels.toFixed(3),
          summary.meanPixelAgreement, summary.consensusPixels,
        ].map(csvCell).join(','),
      );
      stats.agreementRows++;
    }
  }
  emit({ name: 'export/frame_agreement.csv', text: agreementLines.join('\n') + '\n' });

  // ---- repeat masks -------------------------------------------------------
  // loadRaters deliberately returns first showings only, so the repeats need
  // their own pass. They go in a separate directory: masks/ must stay one file
  // per (frame, surgeon, layer) so it can be read positionally, and a repeat is
  // a second opinion from the same surgeon, not another surgeon's.
  const repeatMaskRows = db
    .prepare(
      `SELECT an.frame_id       AS frameId,
              an.surgeon_id     AS surgeonId,
              an.assignment_id  AS assignmentId,
              an.go_mask_path   AS goPath,
              an.nogo_mask_path AS nogoPath,
              f.width           AS width,
              f.height          AS height
         FROM annotations an
         JOIN assignments a ON a.id = an.assignment_id
         JOIN frames      f ON f.id = an.frame_id
        WHERE a.is_repeat = 1
          AND an.submitted_at IS NOT NULL
          AND an.status IN ('drawn', 'nothing_to_mark')
        ORDER BY an.surgeon_id, an.frame_id`,
    )
    .all() as {
    frameId: number;
    surgeonId: number;
    assignmentId: number;
    goPath: string | null;
    nogoPath: string | null;
    width: number;
    height: number;
  }[];

  for (const row of repeatMaskRows) {
    for (const layer of ['go', 'nogo'] as const) {
      const stored = layer === 'go' ? row.goPath : row.nogoPath;
      if (!stored) continue;
      const occupancy = readMaskOrEmpty(stored, row.width, row.height);
      emit({
        name: `export/repeats/${row.frameId}__${row.surgeonId}__${row.assignmentId}__${layer}.png`,
        buffer: encodeBinaryMaskPng(row.width, row.height, occupancy),
      });
      stats.masks++;
    }
  }

  // ---- intra_rater_pairs.csv: one row per repeat pair per layer ------------
  const pairColumns = [
    'surgeon_id', 'surgeon_name', 'frame_id', 'layer',
    'first_assignment_id', 'repeat_assignment_id',
    'first_display_order', 'repeat_display_order', 'queue_gap',
    'first_status', 'repeat_status', 'first_confidence', 'repeat_confidence',
    'first_seconds', 'repeat_seconds',
    'first_pixels', 'repeat_pixels',
    'iou', 'dice', 'nsd', 'pixel_agreement', 'presence_disagreement',
  ];
  const pairLines = [pairColumns.join(',')];
  const repeatPairs = loadRepeatPairs(db, DEFAULT_TOLERANCE_FRACTION);
  for (const pair of repeatPairs) {
    for (const layer of ['go', 'nogo'] as const) {
      const metrics = pair[layer];
      pairLines.push(
        [
          pair.surgeonId, pair.surgeonName, pair.frameId, layer,
          pair.firstAssignmentId, pair.repeatAssignmentId,
          pair.firstDisplayOrder, pair.repeatDisplayOrder,
          pair.repeatDisplayOrder - pair.firstDisplayOrder,
          pair.firstStatus, pair.repeatStatus, pair.firstConfidence, pair.repeatConfidence,
          pair.firstSeconds, pair.repeatSeconds,
          metrics.firstPixels, metrics.repeatPixels,
          metrics.iou, metrics.dice, metrics.nsd, metrics.pixelAgreement,
          metrics.presenceDisagreement ? 1 : 0,
        ].map(csvCell).join(','),
      );
    }
  }
  stats.repeatPairs = repeatPairs.length;
  emit({ name: 'export/intra_rater_pairs.csv', text: pairLines.join('\n') + '\n' });

  // ---- intra_rater_summary.csv: one row per surgeon per layer --------------
  const summaryColumns = [
    'surgeon_id', 'surgeon_name', 'layer', 'repeat_pairs',
    'spatial_pairs', 'excluded_empty_pairs',
    'mean_iou', 'mean_dice', 'mean_nsd',
    'presence_agreement', 'presence_kappa', 'presence_kappa_note',
    'status_changes', 'confidence_changes',
  ];
  const summaryLines = [summaryColumns.join(',')];
  for (const surgeon of summariseIntraRater(db, DEFAULT_TOLERANCE_FRACTION)) {
    for (const layer of ['go', 'nogo'] as const) {
      const layerSummary = surgeon[layer];
      summaryLines.push(
        [
          surgeon.surgeonId, surgeon.surgeonName, layer, surgeon.pairs,
          layerSummary.spatialPairs, layerSummary.excludedEmptyPairs,
          layerSummary.meanIou, layerSummary.meanDice, layerSummary.meanNsd,
          layerSummary.presenceAgreement, layerSummary.presenceKappa, layerSummary.presenceKappaNote,
          surgeon.statusChanges, surgeon.confidenceChanges,
        ].map(csvCell).join(','),
      );
    }
  }
  emit({ name: 'export/intra_rater_summary.csv', text: summaryLines.join('\n') + '\n' });

  // ---- presence_agreement.csv: study-level, one row per layer --------------
  const presenceColumns = [
    'layer', 'frames', 'raters', 'frames_with_any_mark',
    'observed_agreement', 'kappa', 'kappa_note',
  ];
  const presenceLines = [presenceColumns.join(',')];
  const presenceByLayer = studyPresenceAgreementBothLayers(db);
  for (const layer of ['go', 'nogo'] as const) {
    const summary = presenceByLayer[layer];
    presenceLines.push(
      [
        summary.layer, summary.frames, summary.raters, summary.framesWithAnyMark,
        summary.observedAgreement, summary.kappa, summary.kappaNote,
      ].map(csvCell).join(','),
    );
  }
  emit({ name: 'export/presence_agreement.csv', text: presenceLines.join('\n') + '\n' });

  // ---- videos.csv and splits.csv -----------------------------------------
  // Frames from one operation are highly correlated: adjacent stills share
  // anatomy, lighting and camera pose. Splitting by frame puts near-duplicates
  // on both sides of the split, so a model is scored partly on images it has
  // effectively already seen. Splitting by video is the only honest unit here.
  const videoRows = ratedFrames.map(({ frame }) => ({
    frameId: frame.id,
    sourceVideo: frame.source_video,
    width: frame.width,
    height: frame.height,
    isPractice: frame.is_practice,
  }));

  emit({
    name: 'export/videos.csv',
    text:
      ['frame_id', 'source_video', 'frame_width', 'frame_height', 'is_practice'].join(',') +
      '\n' +
      videoRows
        .map((row) =>
          [row.frameId, row.sourceVideo, row.width, row.height, row.isPractice].map(csvCell).join(','),
        )
        .join('\n') +
      '\n',
  });

  // A frame with no recorded source video gets a group of its own rather than
  // being pooled with every other unknown frame, which would assert they share
  // an operation when that is simply not known.
  const videoKeys = [...new Set(videoRows.map((row) => row.sourceVideo ?? `__unknown_frame_${row.frameId}`))];
  const shuffledVideos = seededShuffle(videoKeys, makeRng(SPLIT_SEED));

  // 70 / 15 / 15 by video count, rounded so nothing is lost.
  const trainCount = Math.floor(shuffledVideos.length * 0.7);
  const validationCount = Math.floor(shuffledVideos.length * 0.15);
  const splitOf = new Map<string, string>();
  shuffledVideos.forEach((video, index) => {
    splitOf.set(
      video,
      index < trainCount ? 'train' : index < trainCount + validationCount ? 'validation' : 'test',
    );
  });

  emit({
    name: 'export/splits.csv',
    text:
      ['frame_id', 'source_video', 'split'].join(',') +
      '\n' +
      videoRows
        .map((row) => {
          const key = row.sourceVideo ?? `__unknown_frame_${row.frameId}`;
          return [row.frameId, row.sourceVideo, splitOf.get(key) ?? 'test'].map(csvCell).join(',');
        })
        .join('\n') +
      '\n',
  });

  emit({
    name: 'export/README.txt',
    text: README.replace('{{GENERATED}}', new Date().toISOString()).replace(
      '{{COLUMNS}}',
      CSV_COLUMNS.map((column) => `      ${column}`).join('\n'),
    ),
  });

  return stats;
}

/**
 * Builds the export archive. The caller pipes it somewhere and awaits the
 * stream; `finalize()` has already been called by the time this returns.
 */
export function createExportArchive(
  db: Database.Database = getDb(),
): { archive: archiver.Archiver; stats: ExportStats } {
  const archive = archiver('zip', { zlib: { level: 9 } });

  const stats = collectExportEntries(db, (entry) => {
    if ('sourcePath' in entry) archive.file(entry.sourcePath, { name: entry.name });
    else if ('buffer' in entry) archive.append(entry.buffer, { name: entry.name });
    else archive.append(entry.text, { name: entry.name });
  });

  void archive.finalize();
  return { archive, stats };
}
