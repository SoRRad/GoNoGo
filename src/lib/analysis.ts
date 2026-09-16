import fs from 'fs';
import type Database from 'better-sqlite3';
import { fromRelative } from './paths';
import { emptyOccupancy, readBinaryMaskPng, summariseAgreement, type AgreementSummary, type Occupancy } from './masks';

export interface RaterMask {
  surgeonId: number;
  surgeonName: string;
  status: string;
  /** Null when the surgeon marked the layer empty; treated as all-zero. */
  occupancy: Occupancy;
  painted: number;
}

export interface FrameAgreement {
  frameId: number;
  width: number;
  height: number;
  go: AgreementSummary;
  nogo: AgreementSummary;
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
         JOIN surgeons s ON s.id = an.surgeon_id
        WHERE an.frame_id = ?
          AND an.submitted_at IS NOT NULL
          AND an.status IN ('drawn', 'nothing_to_mark')
        ORDER BY an.surgeon_id`,
    )
    .all(frameId) as {
    surgeonId: number;
    surgeonName: string;
    status: string;
    goPath: string | null;
    nogoPath: string | null;
  }[];

  const read = (relative: string | null): Occupancy => {
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
  };

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

export function frameAgreement(
  db: Database.Database,
  frameId: number,
  width: number,
  height: number,
): FrameAgreement {
  const { go, nogo } = loadRaters(db, frameId, width, height);
  return {
    frameId,
    width,
    height,
    go: summariseAgreement(go.map((rater) => rater.occupancy), width, height),
    nogo: summariseAgreement(nogo.map((rater) => rater.occupancy), width, height),
    raters: go.map((rater, index) => ({
      surgeonId: rater.surgeonId,
      surgeonName: rater.surgeonName,
      status: rater.status,
      goPixels: rater.painted,
      nogoPixels: nogo[index].painted,
    })),
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
