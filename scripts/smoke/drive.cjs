/**
 * Walks both surgeons through their whole queue over the real HTTP API.
 *
 * Writes are gated to the current position, so a repeat sitting 30+ places
 * after its first showing can only be reached by actually annotating the
 * frames in between. That is the point: this exercises the queue the way a
 * surgeon does, rather than reaching past it into the database.
 *
 * Runs as one process inside the container because ~40 frames per surgeon is
 * too many round trips to spawn a curl and a JSON parser for each.
 */
const fs = require('fs');

const plan = JSON.parse(fs.readFileSync('/data/plan.json', 'utf8'));
const BASE = plan.base;

/** The session cookie is the only credential; /a/<token> exchanges for it. */
async function signIn(token) {
  const res = await fetch(`${BASE}/a/${token}`, { redirect: 'manual' });
  if (res.status !== 303) throw new Error(`expected 303 from /a/<token>, got ${res.status}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  const session = cookies.find((c) => c.startsWith('sadi_session='));
  if (!session) throw new Error('no sadi_session cookie was set');
  return session;
}

async function onboard(cookie) {
  const form = new FormData();
  form.set('yearsInPractice', '12');
  form.set('casesPerYear', '30');
  const res = await fetch(`${BASE}/api/onboarding`, { method: 'POST', headers: { cookie }, body: form });
  const body = await res.json();
  if (!body.ok) throw new Error(`onboarding failed: ${JSON.stringify(body)}`);
}

async function readQueue(cookie) {
  const res = await fetch(`${BASE}/api/queue`, { headers: { cookie } });
  if (!res.ok) throw new Error(`queue read failed: ${res.status}`);
  return res.json();
}

async function submit(cookie, assignmentId, action) {
  const form = new FormData();
  form.set('assignmentId', String(assignmentId));
  form.set('submit', '1');
  form.set('secondsSpent', String(action.seconds ?? 5));
  form.set('undoCount', String(action.undo ?? 0));
  if (action.kind === 'mask') {
    form.set('status', 'drawn');
    form.set('confidence', action.confidence);
    const png = fs.readFileSync(action.file);
    form.set('nogo', new Blob([png], { type: 'image/png' }), 'mask.png');
  } else {
    form.set('status', 'nothing_to_mark');
  }
  const res = await fetch(`${BASE}/api/annotations`, { method: 'POST', headers: { cookie }, body: form });
  const body = await res.json();
  if (!res.ok || !body.ok) {
    throw new Error(`submit of assignment ${assignmentId} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  // The response carries the next window, so the walk needs no second request.
  return body;
}

async function walk(surgeon) {
  const cookie = await signIn(surgeon.token);
  await onboard(cookie);

  const actions = plan.actions[surgeon.id] || {};
  let window = await readQueue(cookie);
  let drawn = 0;
  let submitted = 0;

  while (!window.state.finished) {
    const index = window.state.currentIndex;
    const item = window.items.find((i) => i.index === index);
    if (!item) throw new Error(`queue window for surgeon ${surgeon.id} has no item at index ${index}`);

    const action = actions[item.assignmentId] || { kind: 'nothing' };
    window = await submit(cookie, item.assignmentId, action);
    submitted++;
    if (action.kind === 'mask') drawn++;

    // A submit that does not advance would otherwise spin here forever.
    if (window.state.currentIndex <= index && !window.state.finished) {
      throw new Error(
        `queue did not advance past index ${index} for surgeon ${surgeon.id} ` +
          `after submitting assignment ${item.assignmentId}`,
      );
    }
  }

  const total = window.state.total;
  if (window.state.completed !== total) {
    throw new Error(
      `surgeon ${surgeon.id} finished with ${window.state.completed} of ${total} complete`,
    );
  }
  console.log(
    `  ${surgeon.name.padEnd(26)} ${String(submitted).padStart(3)} submitted this pass, ` +
      `${drawn} with a mask, queue of ${total} complete`,
  );
}

(async () => {
  for (const surgeon of plan.surgeons) await walk(surgeon);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
