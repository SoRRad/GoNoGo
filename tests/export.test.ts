import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { collectExportEntries, csvCell, type ExportEntry } from '@/lib/export';
import { majorityVote } from '@/lib/masks';
import { addAnnotation, addAssignment, addFrame, addSurgeon, rect, testDb, writeMask } from './helpers';

const W = 8;
const H = 8;

function collect(db: Parameters<typeof collectExportEntries>[0]) {
  const entries: ExportEntry[] = [];
  const stats = collectExportEntries(db, (entry) => entries.push(entry));
  return { entries, stats };
}

function textOf(entries: ExportEntry[], name: string): string {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry || !('text' in entry)) throw new Error(`no text entry named ${name}`);
  return entry.text;
}

function maskOf(entries: ExportEntry[], name: string): Uint8Array {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry || !('buffer' in entry)) throw new Error(`no buffer entry named ${name}`);
  const png = PNG.sync.read(entry.buffer);
  const data = new Uint8Array(png.width * png.height);
  for (let i = 0; i < data.length; i++) data[i] = png.data[i * 4] > 127 ? 1 : 0;
  return data;
}

/** Splits one CSV line, honouring RFC 4180 quoting. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') inQuotes = false;
      else cell += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

describe('csvCell', () => {
  it('leaves a plain value alone', () => {
    expect(csvCell('drawn')).toBe('drawn');
    expect(csvCell(42)).toBe('42');
  });

  it('renders null and undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a value containing a comma', () => {
    expect(csvCell('Smith, John')).toBe('"Smith, John"');
  });

  it('doubles embedded quotes and wraps the cell', () => {
    expect(csvCell('say "hello"')).toBe('"say ""hello"""');
  });

  it('quotes a value containing a newline or carriage return', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell('line one\r\nline two')).toBe('"line one\r\nline two"');
  });

  it('round-trips a nasty value through a parser', () => {
    const nasty = 'Doe, "Jane"\nthe second';
    expect(parseCsvLine(csvCell(nasty))).toEqual([nasty]);
  });
});

describe('annotations.csv', () => {
  it('escapes a surgeon name containing a comma and a quote', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const surgeonId = addSurgeon(db, 'Doe, "Jane"');
    const assignment = addAssignment(db, surgeonId, frameId, 0);
    addAnnotation(db, {
      assignmentId: assignment,
      surgeonId,
      frameId,
      status: 'drawn',
      confidence: 'high',
      nogoMaskPath: writeMask(frameId, surgeonId, 'nogo', W, H, rect(W, H, 0, 0, 4, 4)),
    });

    const { entries } = collect(db);
    const csv = textOf(entries, 'export/annotations.csv');
    const lines = csv.trim().split('\n');
    const header = parseCsvLine(lines[0]);

    // The quoted name contains no newline, so the row is still one line.
    expect(lines).toHaveLength(2);
    const row = parseCsvLine(lines[1]);
    expect(row).toHaveLength(header.length);
    expect(row[header.indexOf('surgeon_name')]).toBe('Doe, "Jane"');
    expect(row[header.indexOf('status')]).toBe('drawn');
    expect(row[header.indexOf('nogo_pixels')]).toBe('16');
    expect(row[header.indexOf('go_pixels')]).toBe('0');
  });

  it('omits annotations that were never submitted', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const surgeonId = addSurgeon(db, 'Unfinished');
    const assignment = addAssignment(db, surgeonId, frameId, 0);
    addAnnotation(db, { assignmentId: assignment, surgeonId, frameId, status: 'drawn', submitted: false });

    const { entries, stats } = collect(db);
    expect(stats.annotations).toBe(0);
    expect(textOf(entries, 'export/annotations.csv').trim().split('\n')).toHaveLength(1);
  });

  it('carries the repeat linkage needed for intra-rater analysis', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const surgeonId = addSurgeon(db, 'Repeater');
    const first = addAssignment(db, surgeonId, frameId, 0);
    const second = addAssignment(db, surgeonId, frameId, 40, { isRepeat: 1, repeatOf: first });
    const mask = writeMask(frameId, surgeonId, 'nogo', W, H, rect(W, H, 0, 0, 4, 4));
    addAnnotation(db, { assignmentId: first, surgeonId, frameId, status: 'drawn', nogoMaskPath: mask });
    addAnnotation(db, { assignmentId: second, surgeonId, frameId, status: 'drawn', nogoMaskPath: mask });

    const { entries } = collect(db);
    const lines = textOf(entries, 'export/annotations.csv').trim().split('\n');
    const header = parseCsvLine(lines[0]);
    const repeatRow = lines.slice(1).map(parseCsvLine).find((row) => row[header.indexOf('is_repeat')] === '1')!;
    expect(repeatRow[header.indexOf('repeat_of_assignment_id')]).toBe(String(first));
  });
});

describe('consensus masks', () => {
  it('recompute to the same pixels from the individual masks shipped alongside', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });

    // Three overlapping but distinct rectangles.
    const shapes = [rect(W, H, 0, 0, 5, 8), rect(W, H, 1, 0, 6, 8), rect(W, H, 3, 0, 8, 8)];
    const surgeonIds = shapes.map((shape, index) => {
      const surgeonId = addSurgeon(db, `Rater${index}`);
      const assignment = addAssignment(db, surgeonId, frameId, index);
      addAnnotation(db, {
        assignmentId: assignment,
        surgeonId,
        frameId,
        status: 'drawn',
        nogoMaskPath: writeMask(frameId, surgeonId, 'nogo', W, H, shape),
      });
      return surgeonId;
    });

    const { entries, stats } = collect(db);
    expect(stats.consensusFrames).toBe(1);

    const individual = surgeonIds.map((surgeonId) =>
      maskOf(entries, `export/masks/${frameId}__${surgeonId}__nogo.png`),
    );
    const shipped = maskOf(entries, `export/consensus/${frameId}__nogo_majority.png`);
    const recomputed = majorityVote(individual, W, H);

    expect(Array.from(shipped)).toEqual(Array.from(recomputed));
    // Hand-computed. Column coverage: A=[0,5) B=[1,6) C=[3,8), so votes per
    // column are 1,2,2,3,3,2,1,1 and a strict majority of 3 needs 2.
    expect(Array.from(shipped.slice(0, W))).toEqual([0, 1, 1, 1, 1, 1, 0, 0]);
  });

  it('counts a nothing_to_mark rater as a zero vote, which can defeat a majority', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });

    const drawerA = addSurgeon(db, 'DrawA');
    const drawerB = addSurgeon(db, 'DrawB');
    const abstainerA = addSurgeon(db, 'AbstainA');

    for (const [index, surgeonId] of [drawerA, drawerB].entries()) {
      const assignment = addAssignment(db, surgeonId, frameId, index);
      addAnnotation(db, {
        assignmentId: assignment,
        surgeonId,
        frameId,
        status: 'drawn',
        nogoMaskPath: writeMask(frameId, surgeonId, 'nogo', W, H, rect(W, H, 0, 0, 4, 8)),
      });
    }
    const abstainAssignment = addAssignment(db, abstainerA, frameId, 2);
    addAnnotation(db, {
      assignmentId: abstainAssignment,
      surgeonId: abstainerA,
      frameId,
      status: 'nothing_to_mark',
    });

    const { entries } = collect(db);
    // 2 of 3 still carries a strict majority.
    const shipped = maskOf(entries, `export/consensus/${frameId}__nogo_majority.png`);
    expect(Array.from(shipped.slice(0, W))).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);

    // The abstainer contributes no mask file, because there is nothing to write.
    expect(entries.some((entry) => entry.name.includes(`__${abstainerA}__`))).toBe(false);
  });

  it('is not written for a frame with only one rater', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const surgeonId = addSurgeon(db, 'Lonely');
    const assignment = addAssignment(db, surgeonId, frameId, 0);
    addAnnotation(db, {
      assignmentId: assignment,
      surgeonId,
      frameId,
      status: 'drawn',
      nogoMaskPath: writeMask(frameId, surgeonId, 'nogo', W, H, rect(W, H, 0, 0, 4, 4)),
    });

    const { entries, stats } = collect(db);
    expect(stats.consensusFrames).toBe(0);
    expect(entries.some((entry) => entry.name.startsWith('export/consensus/'))).toBe(false);
  });

  it('skips a frame nobody rated', () => {
    const db = testDb();
    addFrame(db, { width: W, height: H });
    const { entries, stats } = collect(db);
    expect(stats.frames).toBe(0);
    expect(entries.some((entry) => entry.name.startsWith('export/frames/'))).toBe(false);
  });
});

describe('export README', () => {
  it('lists every CSV column it documents', () => {
    const db = testDb();
    const { entries } = collect(db);
    const readme = textOf(entries, 'export/README.txt');
    const header = textOf(entries, 'export/annotations.csv').trim().split('\n')[0].split(',');
    for (const column of header) expect(readme).toContain(column);
  });
});

describe('metric tables', () => {
  it('writes one frame_agreement row per layer, with the exclusion counts', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });

    // Two surgeons draw No-Go; neither draws Go.
    const ids = [0, 1].map((index) => {
      const surgeonId = addSurgeon(db, `Rater${index}`);
      const assignment = addAssignment(db, surgeonId, frameId, index);
      addAnnotation(db, {
        assignmentId: assignment,
        surgeonId,
        frameId,
        status: 'drawn',
        nogoMaskPath: writeMask(frameId, surgeonId, 'nogo', W, H, rect(W, H, index, 0, 4 + index, 8)),
      });
      return surgeonId;
    });
    expect(ids).toHaveLength(2);

    const { entries, stats } = collect(db);
    const lines = textOf(entries, 'export/frame_agreement.csv').trim().split('\n');
    const header = parseCsvLine(lines[0]);
    expect(stats.agreementRows).toBe(2);

    const rows = lines.slice(1).map(parseCsvLine);
    const nogoRow = rows.find((row) => row[header.indexOf('layer')] === 'nogo')!;
    const goRow = rows.find((row) => row[header.indexOf('layer')] === 'go')!;

    // No-Go: one usable pair, nothing excluded.
    expect(nogoRow[header.indexOf('spatial_pairs')]).toBe('1');
    expect(nogoRow[header.indexOf('excluded_empty_pairs')]).toBe('0');
    expect(Number(nogoRow[header.indexOf('mean_iou')])).toBeGreaterThan(0);
    expect(Number(nogoRow[header.indexOf('nsd_tolerance_px')])).toBeGreaterThan(0);

    // Go: nobody drew, so the one pair is excluded and the metrics are empty.
    expect(goRow[header.indexOf('spatial_pairs')]).toBe('0');
    expect(goRow[header.indexOf('excluded_empty_pairs')]).toBe('1');
    expect(goRow[header.indexOf('mean_iou')]).toBe('');
    expect(goRow[header.indexOf('mean_dice')]).toBe('');
    // But they unanimously agree nothing is there.
    expect(goRow[header.indexOf('presence_observed_agreement')]).toBe('1');
  });

  it('writes intra-rater tables for a completed repeat pair', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const surgeonId = addSurgeon(db, 'Repeater');

    const first = addAssignment(db, surgeonId, frameId, 0);
    const repeat = addAssignment(db, surgeonId, frameId, 40, { isRepeat: 1, repeatOf: first });
    addAnnotation(db, {
      assignmentId: first,
      surgeonId,
      frameId,
      status: 'drawn',
      confidence: 'high',
      nogoMaskPath: writeMask(frameId, surgeonId, 'nogo', W, H, rect(W, H, 0, 0, 4, 8)),
    });
    addAnnotation(db, {
      assignmentId: repeat,
      surgeonId,
      frameId,
      status: 'drawn',
      confidence: 'low',
      nogoMaskPath: writeMask(frameId, surgeonId + 500, 'nogo', W, H, rect(W, H, 0, 0, 4, 8)),
    });

    const { entries, stats } = collect(db);
    expect(stats.repeatPairs).toBe(1);

    const pairLines = textOf(entries, 'export/intra_rater_pairs.csv').trim().split('\n');
    const pairHeader = parseCsvLine(pairLines[0]);
    const nogoPair = pairLines.slice(1).map(parseCsvLine).find((row) => row[pairHeader.indexOf('layer')] === 'nogo')!;

    expect(nogoPair[pairHeader.indexOf('queue_gap')]).toBe('40');
    expect(nogoPair[pairHeader.indexOf('iou')]).toBe('1');
    expect(nogoPair[pairHeader.indexOf('first_confidence')]).toBe('high');
    expect(nogoPair[pairHeader.indexOf('repeat_confidence')]).toBe('low');

    const summaryLines = textOf(entries, 'export/intra_rater_summary.csv').trim().split('\n');
    const summaryHeader = parseCsvLine(summaryLines[0]);
    const nogoSummary = summaryLines
      .slice(1)
      .map(parseCsvLine)
      .find((row) => row[summaryHeader.indexOf('layer')] === 'nogo')!;
    expect(nogoSummary[summaryHeader.indexOf('repeat_pairs')]).toBe('1');
    expect(nogoSummary[summaryHeader.indexOf('confidence_changes')]).toBe('1');
    // One item cannot support a kappa, and the note says so rather than NaN.
    expect(nogoSummary[summaryHeader.indexOf('presence_kappa')]).toBe('');
    expect(nogoSummary[summaryHeader.indexOf('presence_kappa_note')]).not.toBe('');
  });

  it('never writes NaN into any table', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    // Everyone abstains: the degenerate case that produces 0/0 everywhere.
    for (const index of [0, 1, 2]) {
      const surgeonId = addSurgeon(db, `Abstain${index}`);
      const assignment = addAssignment(db, surgeonId, frameId, index);
      addAnnotation(db, { assignmentId: assignment, surgeonId, frameId, status: 'nothing_to_mark' });
    }

    const { entries } = collect(db);
    for (const entry of entries) {
      if (!('text' in entry) || !entry.name.endsWith('.csv')) continue;
      // Checked cell by cell: 'undefined_unanimous' is a legitimate note value,
      // a bare 'undefined' or 'NaN' in a numeric cell is not.
      for (const line of entry.text.trim().split('\n')) {
        for (const cell of parseCsvLine(line)) {
          expect(['NaN', 'Infinity', '-Infinity', 'undefined', 'null']).not.toContain(cell);
        }
      }
    }

    // An undefined metric is written as an empty cell, not a placeholder.
    const presence = textOf(entries, 'export/presence_agreement.csv').trim().split('\n');
    const header = parseCsvLine(presence[0]);
    const row = parseCsvLine(presence[1]);
    expect(row[header.indexOf('kappa')]).toBe('');
    expect(row[header.indexOf('kappa_note')]).toBe('undefined_unanimous');
  });

  it('documents every metric column it emits', () => {
    const db = testDb();
    const { entries } = collect(db);
    const readme = textOf(entries, 'export/README.txt');
    for (const name of [
      'frame_agreement.csv',
      'intra_rater_pairs.csv',
      'intra_rater_summary.csv',
      'presence_agreement.csv',
      'mean_nsd',
      'excluded_empty_pairs',
      'undefined_unanimous',
      'queue_gap',
    ]) {
      expect(readme).toContain(name);
    }
  });
});
