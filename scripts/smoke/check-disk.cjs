/**
 * What actually landed on disk and in the database once both surgeons had
 * finished: one mask file per opinion, and a repeat that did not overwrite the
 * first showing it duplicates.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const masks = require('/app/dist/src/lib/masks.js');

const DATA = '/data';
const plan = JSON.parse(fs.readFileSync(path.join(DATA, 'plan.json'), 'utf8'));
const db = new Database(path.join(DATA, 'app.db'), { readonly: true });

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const annotationFor = (assignmentId) =>
  db
    .prepare(
      `SELECT assignment_id, surgeon_id, frame_id, status, confidence, nogo_mask_path
         FROM annotations WHERE assignment_id = ?`,
    )
    .get(assignmentId);

/** Decoded mask plus the bytes on disk, so two files can be compared exactly. */
function readMask(relative) {
  const absolute = path.join(DATA, relative);
  const decoded = masks.readBinaryMaskPng(absolute);
  return {
    absolute,
    bytes: fs.readFileSync(absolute),
    width: decoded.width,
    height: decoded.height,
    data: decoded.data,
    painted: masks.countSet(decoded.data),
  };
}

// ------------------------------------------- two surgeons, one shared frame
console.log('two distinct mask files for the frame both surgeons drew');
const sharedA = plan.sharedA;
const rows = Object.values(sharedA.assignments).map(annotationFor);
check(rows.every((r) => r && r.status === 'drawn'), 'both surgeons submitted a drawn annotation');
check(
  new Set(rows.map((r) => r.nogo_mask_path)).size === 2,
  `two different mask paths: ${rows.map((r) => r.nogo_mask_path).join(' and ')}`,
);
for (const row of rows) {
  check(
    row.nogo_mask_path.includes(`a${row.assignment_id}__`),
    `mask for assignment ${row.assignment_id} is keyed by its assignment id`,
  );
}
const drawnA = rows.map((r) => readMask(r.nogo_mask_path));
check(
  drawnA.every((m) => m.painted > 0),
  `both masks carry paint (${drawnA.map((m) => m.painted).join(' and ')} px)`,
);
check(
  drawnA.map((m) => m.painted).sort((a, b) => a - b).join() ===
    [sharedA.expected.firstPixels, sharedA.expected.secondPixels].sort((a, b) => a - b).join(),
  'each stored mask has exactly the area that was uploaded',
);
check(!drawnA[0].bytes.equals(drawnA[1].bytes), 'the two masks differ, so this is a real disagreement');
const overlap = masks.iou(drawnA[0].data, drawnA[1].data);
check(
  overlap !== null && overlap > 0 && overlap < 1,
  `they partly overlap: IoU ${overlap === null ? 'null' : overlap.toFixed(4)}`,
);

// ------------------------------------------------------ draw vs nothing
console.log('');
console.log('the surgeon who marked nothing is recorded, not dropped');
const drewB = annotationFor(plan.sharedB.assignments[plan.sharedB.drawnBy]);
const nothingB = annotationFor(plan.sharedB.assignments[plan.sharedB.nothingBy]);
check(drewB && drewB.status === 'drawn' && !!drewB.nogo_mask_path, 'one surgeon drew');
check(nothingB && nothingB.status === 'nothing_to_mark', 'the other submitted nothing_to_mark');
check(nothingB && nothingB.nogo_mask_path === null, 'and stored no mask file, which is the all-zero vote');

// ------------------------------------------------------------- the repeat
console.log('');
console.log('the repeat did not overwrite its first showing');
const repeat = plan.repeat;
const firstShowing = annotationFor(repeat.firstAssignmentId);
const secondShowing = annotationFor(repeat.repeatAssignmentId);
check(!!firstShowing && !!secondShowing, 'both showings were submitted');
check(
  firstShowing.frame_id === repeat.frameId && secondShowing.frame_id === repeat.frameId,
  `both are frame ${repeat.frameId}`,
);
check(
  firstShowing.nogo_mask_path !== secondShowing.nogo_mask_path,
  `separate paths: ${firstShowing.nogo_mask_path} and ${secondShowing.nogo_mask_path}`,
);
const pair = [firstShowing, secondShowing].map((r) => readMask(r.nogo_mask_path));
check(pair.every((m) => fs.existsSync(m.absolute)), 'both files are still on disk');
check(
  pair[0].painted === repeat.expected.firstPixels && pair[1].painted === repeat.expected.secondPixels,
  `they hold the two areas that were drawn, ${pair.map((m) => m.painted).join(' then ')} px, ` +
    'so neither file is the other',
);
check(!pair[0].bytes.equals(pair[1].bytes), 'the two files differ, so the second did not overwrite the first');
const repeatIou = masks.iou(pair[0].data, pair[1].data);
check(
  repeatIou !== null && repeatIou > 0 && repeatIou < 1,
  `intra-rater overlap is a real number: IoU ${repeatIou === null ? 'null' : repeatIou.toFixed(4)}`,
);

// Under the old naming both showings collapsed onto one path, so the directory
// would hold one file for this (frame, surgeon) instead of two.
const forPair = fs
  .readdirSync(path.join(DATA, 'masks'))
  .filter((name) => name.startsWith(`${repeat.frameId}__${repeat.surgeonId}__`) && name.endsWith('__nogo.png'));
check(forPair.length === 2, `masks/ holds ${forPair.length} files for this frame and surgeon: ${forPair.join(', ')}`);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} disk check(s) failed`);
  process.exit(1);
}
console.log('disk checks passed');
