import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { getDb } from './db';
import type { Frame } from './db';
import { framePath } from './paths';
import { encodeBinaryMaskPng, majorityVote } from './masks';
import { loadRaters } from './analysis';

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

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Frames are exported as PNG regardless of how they were ingested. */
function framePngBuffer(frame: Frame): Buffer | null {
  const absolute = framePath(frame.filename);
  if (!fs.existsSync(absolute)) return null;
  const source = fs.readFileSync(absolute);
  const extension = path.extname(frame.filename).toLowerCase();
  if (extension === '.png') return source;

  const decoded = jpeg.decode(source, { useTArray: true, formatAsRGBA: true });
  const png = new PNG({ width: decoded.width, height: decoded.height });
  png.data = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length);
  return PNG.sync.write(png);
}

const README = `SADI Go/No-Go dissection zone study — data export
=================================================

Generated: {{GENERATED}}

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

consensus/<frame_id>__go_majority.png
consensus/<frame_id>__nogo_majority.png
    Pixel majority vote across the surgeons who rated that frame: a pixel is set
    where strictly more than half of them included it. Same format as the masks.
    Written for frames rated by two or more surgeons.

    Who counts as a rater: every surgeon whose annotation was submitted with
    status 'drawn' or 'nothing_to_mark'. A surgeon who said there was nothing to
    mark is a real opinion and votes zero across the whole frame. Annotations
    with status 'cannot_assess' are excluded from the vote entirely.

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
                      repeat_of_assignment_id to measure intra-rater reliability.
      display_order   Position in that surgeon's queue, 0-based. Practice frames
                      always occupy the first positions.
      is_practice     1 for the shared practice frames. Exclude these from
                      analysis: they were never scored and carry no feedback.

Independence
    Every surgeon annotated alone. No surgeon could see another surgeon's masks
    or any aggregate at any point, and no anatomy class labels appeared anywhere
    in the interface.
`;

export interface ExportStats {
  frames: number;
  masks: number;
  consensusFrames: number;
  annotations: number;
}

/**
 * Builds the export archive. The caller pipes it somewhere and awaits the
 * stream; `finalize()` has already been called by the time this returns.
 */
export function createExportArchive(): { archive: archiver.Archiver; stats: ExportStats } {
  const db = getDb();
  const archive = archiver('zip', { zlib: { level: 9 } });
  const stats: ExportStats = { frames: 0, masks: 0, consensusFrames: 0, annotations: 0 };

  const frames = db.prepare('SELECT * FROM frames ORDER BY id').all() as Frame[];
  const paintedCache = new Map<string, number>();

  for (const frame of frames) {
    const raters = loadRaters(db, frame.id, frame.width, frame.height);
    const contributing = raters.go.length;

    // Only export a frame that somebody actually rated.
    if (contributing === 0) continue;

    const frameBuffer = framePngBuffer(frame);
    if (frameBuffer) {
      archive.append(frameBuffer, { name: `export/frames/${frame.id}.png` });
      stats.frames++;
    }

    for (const layer of ['go', 'nogo'] as const) {
      for (const rater of raters[layer]) {
        paintedCache.set(`${frame.id}:${rater.surgeonId}:${layer}`, rater.painted);
        if (rater.painted === 0) continue;
        archive.append(encodeBinaryMaskPng(frame.width, frame.height, rater.occupancy), {
          name: `export/masks/${frame.id}__${rater.surgeonId}__${layer}.png`,
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
        archive.append(encodeBinaryMaskPng(frame.width, frame.height, vote), {
          name: `export/consensus/${frame.id}__${layer}_majority.png`,
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
  archive.append(lines.join('\n') + '\n', { name: 'export/annotations.csv' });

  archive.append(
    README.replace('{{GENERATED}}', new Date().toISOString()).replace(
      '{{COLUMNS}}',
      CSV_COLUMNS.map((column) => `      ${column}`).join('\n'),
    ),
    { name: 'export/README.txt' },
  );

  void archive.finalize();
  return { archive, stats };
}
