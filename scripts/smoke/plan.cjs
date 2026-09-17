/**
 * Chooses the frames the smoke test will annotate and draws the masks it will
 * upload, then writes /data/plan.json for drive.cjs and the check scripts.
 *
 * This runs inside the container so it reads the same database the server is
 * serving and encodes PNGs with the image's own pngjs, rather than the host's.
 *
 * Nothing here is hardcoded: which frames are shared and which assignment is a
 * repeat both depend on the seeded shuffle, so they are discovered from the
 * assignments table.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PNG } = require('pngjs');

const DATA = '/data';
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new Database(path.join(DATA, 'app.db'), { readonly: true });

const surgeons = db.prepare('SELECT id, name, access_token FROM surgeons ORDER BY id').all();
if (surgeons.length < 2) {
  throw new Error(`the multi-rater checks need two surgeons, found ${surgeons.length}`);
}
const [first, second] = surgeons;

const assignments = db
  .prepare(
    `SELECT a.id, a.surgeon_id, a.frame_id, a.display_order, a.is_repeat,
            a.repeat_of_assignment_id, f.width, f.height, f.is_practice
       FROM assignments a
       JOIN frames f ON f.id = a.frame_id
      ORDER BY a.surgeon_id, a.display_order`,
  )
  .all();

// ---------------------------------------------------------------- the repeat
// A repeat is only woven in when the queue is longer than MIN_REPEAT_GAP, so a
// small frame pool silently produces none and the intra-rater checks would
// vacuously pass. Fail loudly instead, naming the cause.
const repeatRow = assignments.find((a) => a.is_repeat === 1 && a.repeat_of_assignment_id);
if (!repeatRow) {
  throw new Error(
    'no repeat assignment exists, so the intra-rater path cannot be exercised.\n' +
      'queue.ts places a repeat at least MIN_REPEAT_GAP (30) positions after its\n' +
      'first showing, so a short queue produces none. Seed a larger frame pool.',
  );
}
const repeatFirst = assignments.find((a) => a.id === repeatRow.repeat_of_assignment_id);
if (!repeatFirst) throw new Error(`repeat ${repeatRow.id} points at a missing first showing`);
if (repeatFirst.frame_id !== repeatRow.frame_id) {
  throw new Error(
    `repeat ${repeatRow.id} is frame ${repeatRow.frame_id} but its first showing ` +
      `${repeatFirst.id} is frame ${repeatFirst.frame_id}`,
  );
}

// --------------------------------------------------------- the shared frames
// Frames both surgeons see as a first showing. Frames caught up in anybody's
// repeat are excluded so the inter-rater assertions stay about two surgeons.
const repeatFrames = new Set(assignments.filter((a) => a.is_repeat === 1).map((a) => a.frame_id));
const seenBy = new Map();
for (const a of assignments) {
  if (a.is_practice === 1 || a.is_repeat === 1 || repeatFrames.has(a.frame_id)) continue;
  if (!seenBy.has(a.frame_id)) seenBy.set(a.frame_id, new Map());
  seenBy.get(a.frame_id).set(a.surgeon_id, a);
}
const shared = [...seenBy.entries()]
  .filter(([, bySurgeon]) => bySurgeon.has(first.id) && bySurgeon.has(second.id))
  .sort((a, b) => a[0] - b[0]);
if (shared.length < 2) {
  throw new Error(`need two frames shared by both surgeons, found ${shared.length}`);
}
const [[frameAId, frameA], [frameBId, frameB]] = shared;

// ------------------------------------------------------------------- drawing
/**
 * A filled rectangle in fractional coordinates, shaped like a canvas upload:
 * colour on a transparent background. The occupancy is kept alongside so the
 * expected statistics can be worked out from the geometry that was actually
 * drawn, rather than asserted as "some number".
 */
function rectangle(width, height, [x0, x1, y0, y1]) {
  const png = new PNG({ width, height });
  const occupancy = new Uint8Array(width * height);
  const left = Math.round(width * x0);
  const right = Math.round(width * x1);
  const top = Math.round(height * y0);
  const bottom = Math.round(height * y1);
  let area = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= left && x < right && y >= top && y < bottom;
      const i = (width * y + x) << 2;
      png.data[i] = 0xef;
      png.data[i + 1] = 0x44;
      png.data[i + 2] = 0x44;
      png.data[i + 3] = inside ? 255 : 0;
      if (inside) { occupancy[width * y + x] = 1; area++; }
    }
  }
  return { buffer: PNG.sync.write(png), occupancy, area };
}

function draw(name, dims, box) {
  const drawn = rectangle(dims.width, dims.height, box);
  const file = path.join(UPLOADS, `${name}.png`);
  fs.writeFileSync(file, drawn.buffer);
  return { file, occupancy: drawn.occupancy, area: drawn.area };
}

/**
 * What the export should report for a pair of drawn masks. Worked out here
 * from the shapes themselves, so the checks compare the numbers that survived
 * the round trip against the numbers the geometry implies.
 */
function expected(a, b) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.occupancy.length; i++) {
    if (a.occupancy[i] && b.occupancy[i]) intersection++;
    if (a.occupancy[i] || b.occupancy[i]) union++;
  }
  return {
    firstPixels: a.area,
    secondPixels: b.area,
    intersection,
    union,
    iou: intersection / union,
    dice: (2 * intersection) / (a.area + b.area),
  };
}

// Two equal rectangles offset along x so they share exactly half their width.
// The overlap is deliberate arithmetic: each is 0.4w by 0.4h and they meet on
// x in [0.50, 0.70], which puts IoU at 1/3 and Dice at 1/2 -- strictly between
// the degenerate 0 and 1, and checkable by hand.
const AREA_ONE = [0.3, 0.7, 0.3, 0.7];
const AREA_TWO = [0.5, 0.9, 0.3, 0.7];
// The repeat is drawn off the first showing in both position and size, the way
// a surgeon on a second pass does not reproduce their own outline exactly.
const REPEAT_ONE = [0.2, 0.5, 0.2, 0.6];
const REPEAT_TWO = [0.35, 0.72, 0.28, 0.74];

const drawn = {
  sharedAFirst: draw('shared-a-first', frameA.get(first.id), AREA_ONE),
  sharedASecond: draw('shared-a-second', frameA.get(second.id), AREA_TWO),
  sharedBFirst: draw('shared-b-first', frameB.get(first.id), AREA_ONE),
  repeatFirst: draw('repeat-first', repeatFirst, REPEAT_ONE),
  repeatSecond: draw('repeat-second', repeatRow, REPEAT_TWO),
};
const files = Object.fromEntries(Object.entries(drawn).map(([k, v]) => [k, v.file]));

// ------------------------------------------------------------------- actions
// Everything not named here is answered 'nothing to mark', which needs no
// upload and keeps the walk through ~40 frames per surgeon quick.
const actions = {};
for (const surgeon of surgeons) actions[surgeon.id] = {};

const mask = (file, confidence) => ({ kind: 'mask', file, confidence, seconds: 37, undo: 2 });

actions[first.id][frameA.get(first.id).id] = mask(files.sharedAFirst, 'high');
actions[second.id][frameA.get(second.id).id] = mask(files.sharedASecond, 'medium');

// The partial-agreement frame's counterpart: one surgeon draws, the other says
// there is nothing to mark, which must count as an all-zero vote.
actions[first.id][frameB.get(first.id).id] = mask(files.sharedBFirst, 'high');
actions[second.id][frameB.get(second.id).id] = { kind: 'nothing', seconds: 11, undo: 0 };

actions[repeatFirst.surgeon_id][repeatFirst.id] = mask(files.repeatFirst, 'high');
actions[repeatRow.surgeon_id][repeatRow.id] = mask(files.repeatSecond, 'medium');

const plan = {
  base: process.env.SMOKE_BASE || 'http://127.0.0.1:3000',
  surgeons: surgeons.map((s) => ({ id: s.id, name: s.name, token: s.access_token })),
  sharedA: {
    frameId: frameAId,
    width: frameA.get(first.id).width,
    height: frameA.get(first.id).height,
    assignments: { [first.id]: frameA.get(first.id).id, [second.id]: frameA.get(second.id).id },
    expected: expected(drawn.sharedAFirst, drawn.sharedASecond),
  },
  sharedB: {
    frameId: frameBId,
    drawnBy: first.id,
    nothingBy: second.id,
    assignments: { [first.id]: frameB.get(first.id).id, [second.id]: frameB.get(second.id).id },
  },
  repeat: {
    surgeonId: repeatRow.surgeon_id,
    frameId: repeatRow.frame_id,
    firstAssignmentId: repeatFirst.id,
    repeatAssignmentId: repeatRow.id,
    firstDisplayOrder: repeatFirst.display_order,
    repeatDisplayOrder: repeatRow.display_order,
    expected: expected(drawn.repeatFirst, drawn.repeatSecond),
  },
  actions,
};

fs.writeFileSync(path.join(DATA, 'plan.json'), JSON.stringify(plan, null, 2));

const sharedExpected = expected(drawn.sharedAFirst, drawn.sharedASecond);
const repeatExpected = expected(drawn.repeatFirst, drawn.repeatSecond);
console.log(
  `shared frame ${frameAId}: both surgeons draw, ${sharedExpected.firstPixels} and ` +
    `${sharedExpected.secondPixels} px overlapping on ${sharedExpected.intersection} ` +
    `(IoU ${sharedExpected.iou.toFixed(4)}, Dice ${sharedExpected.dice.toFixed(4)})`,
);
console.log(`shared frame ${frameBId}: surgeon ${first.id} draws, surgeon ${second.id} marks nothing`);
console.log(
  `repeat: surgeon ${repeatRow.surgeon_id} sees frame ${repeatRow.frame_id} at position ` +
    `${repeatFirst.display_order} and again at ${repeatRow.display_order} ` +
    `(gap ${repeatRow.display_order - repeatFirst.display_order}), assignments ` +
    `${repeatFirst.id} then ${repeatRow.id}`,
);
console.log(
  `  the two showings are ${repeatExpected.firstPixels} and ${repeatExpected.secondPixels} px ` +
    `(IoU ${repeatExpected.iou.toFixed(4)}, Dice ${repeatExpected.dice.toFixed(4)})`,
);
