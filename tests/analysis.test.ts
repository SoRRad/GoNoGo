import { describe, expect, it } from 'vitest';
import fs from 'fs';
import { frameAgreement, loadRaters, median } from '@/lib/analysis';
import { countSet } from '@/lib/masks';
import { fromRelative } from '@/lib/paths';
import { addAnnotation, addAssignment, addFrame, addSurgeon, rect, testDb, writeMask } from './helpers';

const W = 8;
const H = 8;

describe('loadRaters', () => {
  it('includes a nothing_to_mark surgeon as an all-zero voter', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const drawer = addSurgeon(db, 'Drawer');
    const abstainer = addSurgeon(db, 'Abstainer');

    const a1 = addAssignment(db, drawer, frameId, 0);
    const a2 = addAssignment(db, abstainer, frameId, 0);
    const maskPathRelative = writeMask(frameId, drawer, 'nogo', W, H, rect(W, H, 0, 0, 4, 4));
    addAnnotation(db, { assignmentId: a1, surgeonId: drawer, frameId, status: 'drawn', nogoMaskPath: maskPathRelative });
    addAnnotation(db, { assignmentId: a2, surgeonId: abstainer, frameId, status: 'nothing_to_mark' });

    const { nogo } = loadRaters(db, frameId, W, H);
    expect(nogo).toHaveLength(2);

    const abstained = nogo.find((rater) => rater.surgeonId === abstainer)!;
    // Saying there is nothing to mark is an opinion: it votes zero everywhere.
    expect(abstained.painted).toBe(0);
    expect(abstained.occupancy).toHaveLength(W * H);
    expect(countSet(abstained.occupancy)).toBe(0);
  });

  it('excludes a cannot_assess surgeon entirely', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const drawer = addSurgeon(db, 'Drawer');
    const unsure = addSurgeon(db, 'Unsure');

    const a1 = addAssignment(db, drawer, frameId, 0);
    const a2 = addAssignment(db, unsure, frameId, 0);
    addAnnotation(db, {
      assignmentId: a1,
      surgeonId: drawer,
      frameId,
      status: 'drawn',
      nogoMaskPath: writeMask(frameId, drawer, 'nogo', W, H, rect(W, H, 0, 0, 4, 4)),
    });
    addAnnotation(db, { assignmentId: a2, surgeonId: unsure, frameId, status: 'cannot_assess' });

    const { nogo } = loadRaters(db, frameId, W, H);
    // Not a vote of zero — not a vote at all.
    expect(nogo.map((rater) => rater.surgeonId)).toEqual([drawer]);
  });

  it('ignores annotations that were never submitted', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const inProgress = addSurgeon(db, 'InProgress');
    const assignment = addAssignment(db, inProgress, frameId, 0);
    addAnnotation(db, {
      assignmentId: assignment,
      surgeonId: inProgress,
      frameId,
      status: 'drawn',
      nogoMaskPath: writeMask(frameId, inProgress, 'nogo', W, H, rect(W, H, 0, 0, 4, 4)),
      submitted: false,
    });

    expect(loadRaters(db, frameId, W, H).nogo).toHaveLength(0);
  });

  it('degrades to all-zero when a mask file is missing from disk', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const surgeonId = addSurgeon(db, 'Vanished');
    const assignment = addAssignment(db, surgeonId, frameId, 0);
    const relative = writeMask(frameId, surgeonId, 'nogo', W, H, rect(W, H, 0, 0, 4, 4));
    addAnnotation(db, { assignmentId: assignment, surgeonId, frameId, status: 'drawn', nogoMaskPath: relative });

    fs.rmSync(fromRelative(relative));

    expect(() => loadRaters(db, frameId, W, H)).not.toThrow();
    const { nogo } = loadRaters(db, frameId, W, H);
    expect(nogo[0].painted).toBe(0);
  });

  it('degrades to all-zero when a mask does not match the frame dimensions', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const surgeonId = addSurgeon(db, 'Mismatch');
    const assignment = addAssignment(db, surgeonId, frameId, 0);
    // Written at the wrong size, as a stale file from a resized frame would be.
    const relative = writeMask(frameId, surgeonId, 'nogo', 4, 4, rect(4, 4, 0, 0, 2, 2));
    addAnnotation(db, { assignmentId: assignment, surgeonId, frameId, status: 'drawn', nogoMaskPath: relative });

    const { nogo } = loadRaters(db, frameId, W, H);
    expect(nogo[0].painted).toBe(0);
    expect(nogo[0].occupancy).toHaveLength(W * H);
  });

  it('returns go and nogo aligned by rater', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const surgeonId = addSurgeon(db, 'Both');
    const assignment = addAssignment(db, surgeonId, frameId, 0);
    addAnnotation(db, {
      assignmentId: assignment,
      surgeonId,
      frameId,
      status: 'drawn',
      goMaskPath: writeMask(frameId, surgeonId, 'go', W, H, rect(W, H, 0, 0, 2, 2)),
      nogoMaskPath: writeMask(frameId, surgeonId, 'nogo', W, H, rect(W, H, 4, 4, 8, 8)),
    });

    const { go, nogo } = loadRaters(db, frameId, W, H);
    expect(go[0].surgeonId).toBe(nogo[0].surgeonId);
    expect(go[0].painted).toBe(4);
    expect(nogo[0].painted).toBe(16);
  });
});

describe('frameAgreement', () => {
  it('summarises both layers and lists every rater', () => {
    const db = testDb();
    const frameId = addFrame(db, { width: W, height: H });
    const one = addSurgeon(db, 'One');
    const two = addSurgeon(db, 'Two');

    const a1 = addAssignment(db, one, frameId, 0);
    const a2 = addAssignment(db, two, frameId, 0);
    addAnnotation(db, {
      assignmentId: a1,
      surgeonId: one,
      frameId,
      status: 'drawn',
      nogoMaskPath: writeMask(frameId, one, 'nogo', W, H, rect(W, H, 0, 0, 4, 8)),
    });
    addAnnotation(db, {
      assignmentId: a2,
      surgeonId: two,
      frameId,
      status: 'drawn',
      nogoMaskPath: writeMask(frameId, two, 'nogo', W, H, rect(W, H, 2, 0, 6, 8)),
    });

    const summary = frameAgreement(db, frameId, W, H);
    expect(summary.raters).toHaveLength(2);
    expect(summary.nogo.n).toBe(2);
    // Two 4x8 halves overlapping in a 2x8 strip: intersection 16, union 48.
    expect(summary.nogo.meanIou).toBeCloseTo(16 / 48, 10);
  });
});

describe('median', () => {
  it('returns null for no values', () => {
    expect(median([])).toBeNull();
  });

  it('takes the middle of an odd-length set', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the two middles of an even-length set', () => {
    expect(median([1, 2, 3, 4])).toBe(3); // (2+3)/2 = 2.5, rounded
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});
