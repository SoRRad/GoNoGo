/**
 * Reads the exported archive back and checks the statistics a study actually
 * depends on: a consensus mask where surgeons disagreed, a frame_agreement row
 * with real overlap numbers, a surgeon who marked nothing counted as a vote
 * rather than dropped, and both showings of a repeat shipped separately.
 *
 * There is no unzip binary in the image, so the archive is read here: locate
 * the end-of-central-directory record, walk the entries it points at, and
 * inflate each one. Scanning for signatures instead would match byte patterns
 * inside the compressed data.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const masks = require('/app/dist/src/lib/masks.js');

const DATA = '/data';
const plan = JSON.parse(fs.readFileSync(path.join(DATA, 'plan.json'), 'utf8'));

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

// ------------------------------------------------------------- read the zip
function readArchive(file) {
  const buf = fs.readFileSync(file);
  let end = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('no end-of-central-directory record: not a zip');

  const count = buf.readUInt16LE(end + 10);
  let offset = buf.readUInt32LE(end + 16);
  const entries = new Map();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`bad central directory entry ${n}`);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    // The local header's extra field may be a different length from the
    // central one, so the data offset has to come from the local header.
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(start, start + compressedSize);

    entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Minimal RFC 4180 reader: the export quotes any cell containing a comma. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const dir = path.join(DATA, 'exports');
const file = fs
  .readdirSync(dir)
  .filter((n) => n.endsWith('.zip'))
  .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (!file) throw new Error('no export archive to read');
const entries = readArchive(path.join(dir, file.n));
console.log(`read ${entries.size} entries from ${file.n}`);

const agreement = parseCsv(entries.get('export/frame_agreement.csv').toString('utf8'));
const pairs = parseCsv(entries.get('export/intra_rater_pairs.csv').toString('utf8'));

const numeric = (value) => value !== '' && value !== undefined && Number.isFinite(Number(value));
/** Pixel rounding can move a metric a hair; anything larger is a real change. */
const near = (value, target) => numeric(value) && Math.abs(Number(value) - target) < 1e-6;

// ------------------------------------------------- the frame they disagreed on
console.log('');
console.log(`consensus and agreement for frame ${plan.sharedA.frameId}, drawn by both`);
const consensusName = `export/consensus/${plan.sharedA.frameId}__nogo_majority.png`;
check(entries.has(consensusName), `${consensusName} was written`);
if (entries.has(consensusName)) {
  const tmp = path.join(DATA, 'consensus-check.png');
  fs.writeFileSync(tmp, entries.get(consensusName));
  const decoded = masks.readBinaryMaskPng(tmp);
  fs.rmSync(tmp, { force: true });
  check(
    decoded.width === plan.sharedA.width && decoded.height === plan.sharedA.height,
    `it is at the frame's native resolution, ${decoded.width}x${decoded.height}`,
  );
  check(
    masks.countSet(decoded.data) === plan.sharedA.expected.intersection,
    `it has ${masks.countSet(decoded.data)} px set, the overlap of the two masks`,
  );
}

const rowA = agreement.find((r) => Number(r.frame_id) === plan.sharedA.frameId && r.layer === 'nogo');
check(!!rowA, 'frame_agreement.csv has a nogo row for it');
if (rowA) {
  check(Number(rowA.n_raters) === 2, `n_raters is ${rowA.n_raters}`);
  check(Number(rowA.n_marked) === 2, `both marked the frame: n_marked ${rowA.n_marked}`);
  // Not merely "a number": the value the shapes imply, carried intact through
  // upload, storage, re-decoding and the analysis.
  const want = plan.sharedA.expected;
  check(near(rowA.mean_iou, want.iou),
    `mean_iou is ${rowA.mean_iou}, the ${want.iou.toFixed(6)} the two rectangles imply`);
  check(near(rowA.mean_dice, want.dice),
    `mean_dice is ${rowA.mean_dice}, the ${want.dice.toFixed(6)} the two rectangles imply`);
  check(Number(rowA.mean_iou) > 0 && Number(rowA.mean_iou) < 1,
    'and it is a partial overlap, not a degenerate 0 or 1');
  check(Number(rowA.spatial_pairs) === 1, `the pair was compared: spatial_pairs ${rowA.spatial_pairs}`);
  check(Number(rowA.excluded_empty_pairs) === 0,
    `it was not dropped as empty-vs-empty: excluded_empty_pairs ${rowA.excluded_empty_pairs}`);
  check(Number(rowA.consensus_pixels) === want.intersection,
    `consensus_pixels is ${rowA.consensus_pixels}, exactly where the rectangles overlap`);
}

// --------------------------------------------- draw against nothing_to_mark
console.log('');
console.log(`frame ${plan.sharedB.frameId}: one surgeon drew, the other marked nothing`);
const rowB = agreement.find((r) => Number(r.frame_id) === plan.sharedB.frameId && r.layer === 'nogo');
check(!!rowB, 'frame_agreement.csv has a nogo row for it');
if (rowB) {
  check(Number(rowB.n_raters) === 2, `the silent surgeon still counts as a rater: n_raters ${rowB.n_raters}`);
  check(Number(rowB.n_marked) === 1, `only one of them marked it: n_marked ${rowB.n_marked}`);
  check(Number(rowB.spatial_pairs) === 1, `the pair was still compared: spatial_pairs ${rowB.spatial_pairs}`);
  check(Number(rowB.excluded_empty_pairs) === 0,
    `it was not dropped as empty-vs-empty: excluded_empty_pairs ${rowB.excluded_empty_pairs}`);
  check(numeric(rowB.mean_iou) && Number(rowB.mean_iou) === 0,
    `drawn against all-zero scores 0, not blank: mean_iou ${JSON.stringify(rowB.mean_iou)}`);
  check(numeric(rowB.presence_observed_agreement),
    `presence agreement is reported: ${rowB.presence_observed_agreement}`);
}

// ------------------------------------------------------------- the repeat
console.log('');
console.log(`repeat: surgeon ${plan.repeat.surgeonId} on frame ${plan.repeat.frameId}`);
const firstName = `export/masks/${plan.repeat.frameId}__${plan.repeat.surgeonId}__nogo.png`;
const repeatName =
  `export/repeats/${plan.repeat.frameId}__${plan.repeat.surgeonId}__${plan.repeat.repeatAssignmentId}__nogo.png`;
check(entries.has(firstName), `the first showing ships as ${firstName}`);
check(entries.has(repeatName), `the second ships separately as ${repeatName}`);
if (entries.has(firstName) && entries.has(repeatName)) {
  check(!entries.get(firstName).equals(entries.get(repeatName)),
    'the two exported masks differ, so neither overwrote the other');
}

const pairRow = pairs.find(
  (r) =>
    Number(r.surgeon_id) === plan.repeat.surgeonId &&
    Number(r.frame_id) === plan.repeat.frameId &&
    r.layer === 'nogo',
);
check(!!pairRow, 'intra_rater_pairs.csv has a nogo row for the pair');
if (pairRow) {
  check(Number(pairRow.first_assignment_id) === plan.repeat.firstAssignmentId &&
    Number(pairRow.repeat_assignment_id) === plan.repeat.repeatAssignmentId,
    `it pairs assignments ${pairRow.first_assignment_id} and ${pairRow.repeat_assignment_id}`);
  check(Number(pairRow.queue_gap) >= 30, `the repeat sat ${pairRow.queue_gap} places later`);
  const wantRepeat = plan.repeat.expected;
  check(near(pairRow.iou, wantRepeat.iou),
    `iou is ${pairRow.iou}, the ${wantRepeat.iou.toFixed(6)} the two outlines imply`);
  check(near(pairRow.dice, wantRepeat.dice),
    `dice is ${pairRow.dice}, the ${wantRepeat.dice.toFixed(6)} the two outlines imply`);
  check(Number(pairRow.iou) > 0 && Number(pairRow.iou) < 1,
    'and it is a real partial agreement, not blank or degenerate');
  check(Number(pairRow.first_pixels) === wantRepeat.firstPixels &&
    Number(pairRow.repeat_pixels) === wantRepeat.secondPixels,
    `the two showings are ${pairRow.first_pixels} and ${pairRow.repeat_pixels} px, ` +
      'the sizes drawn, so neither was read from the other');
}

const summary = parseCsv(entries.get('export/intra_rater_summary.csv').toString('utf8'));
const summaryRow = summary.find(
  (r) => Number(r.surgeon_id) === plan.repeat.surgeonId && r.layer === 'nogo',
);
check(!!summaryRow && Number(summaryRow.repeat_pairs) >= 1,
  `intra_rater_summary.csv aggregates ${summaryRow ? summaryRow.repeat_pairs : 0} pair(s) for them`);

// The repeat must not leak into the between-surgeon figures.
const repeatFrameRow = agreement.find(
  (r) => Number(r.frame_id) === plan.repeat.frameId && r.layer === 'nogo',
);
check(!!repeatFrameRow && Number(repeatFrameRow.n_raters) === 2,
  `the repeated frame still counts ${repeatFrameRow ? repeatFrameRow.n_raters : '?'} raters, ` +
    'not 3: the second showing stays out of the inter-rater figure');

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} export check(s) failed`);
  process.exit(1);
}
console.log('export checks passed');
