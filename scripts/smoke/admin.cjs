/**
 * The admin panel's study management, driven over HTTP against the running
 * container: refusing requests from other pages, replacing a link, pausing,
 * removing a frame that surgeons have drawn on, removing a surgeon, emailing
 * an invitation (to a stand-in mail server on port 2525, which the container
 * is configured to use), editing its wording, and uploading an image.
 *
 * Runs after the export checks, since it deliberately changes the study.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PNG } = require('pngjs');
const { startSmtpSink } = require('./smtp-sink.cjs');

const DATA = '/data';
const BASE = 'http://127.0.0.1:3000';
const plan = JSON.parse(fs.readFileSync(path.join(DATA, 'plan.json'), 'utf8'));
const db = () => new Database(path.join(DATA, 'app.db'), { readonly: true });

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

function cookieFrom(response, name) {
  const found = response.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
  return found ?? null;
}

async function post(url, { cookie, headers = {}, form = {} } = {}) {
  const body = new URLSearchParams(form);
  return fetch(`${BASE}${url}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), 'sec-fetch-site': 'same-origin', ...headers },
    body,
  });
}

const tokenOf = (id) => db().prepare('SELECT access_token AS t FROM surgeons WHERE id = ?').get(id)?.t;
const ordersOf = (id) =>
  db().prepare('SELECT display_order AS d FROM assignments WHERE surgeon_id = ? ORDER BY display_order').all(id).map((r) => r.d);
const contiguous = (orders) => orders.every((d, i) => d === i);

(async () => {
  const [one, two] = plan.surgeons;

  console.log('the database was migrated in place');
  const surgeonColumns = db().prepare('PRAGMA table_info(surgeons)').all().map((c) => c.name);
  const frameColumns = db().prepare('PRAGMA table_info(frames)').all().map((c) => c.name);
  check(
    surgeonColumns.includes('paused_at') && surgeonColumns.includes('invited_at') &&
      frameColumns.includes('is_core') && frameColumns.includes('content_sha256') &&
      Boolean(db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()),
    'paused_at, invited_at, is_core, content_sha256 and settings exist',
  );
  const core = db().prepare('SELECT COUNT(*) AS n FROM frames WHERE is_core = 1').get().n;
  const shared = db()
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT frame_id FROM assignments a JOIN frames f ON f.id = a.frame_id
               WHERE f.is_practice = 0 GROUP BY frame_id HAVING COUNT(DISTINCT surgeon_id) >= 2)`)
    .get().n;
  check(core > 0 && core === shared, `the core set is recorded: ${core} frames, the ${shared} both surgeons share`);

  console.log('');
  console.log('admin actions refuse anyone but the admin, on this site’s own pages');
  const login = await post('/api/admin/login', { form: { password: 'smoke-admin-password' } });
  const admin = cookieFrom(login, 'sadi_admin');
  check(login.status === 303 && Boolean(admin), 'the admin signs in');
  check((await post('/api/admin/surgeons', { form: { name: 'X', email: 'x@example.org' } })).status === 401, 'no admin cookie: 401');
  check(
    (await post('/api/admin/surgeons', { cookie: admin, headers: { 'sec-fetch-site': 'same-site' }, form: { name: 'X', email: 'x@example.org' } })).status === 403,
    'posted from another address on the same site (another *.sslip.io): 403',
  );
  check(
    (await post('/api/admin/surgeons', { cookie: admin, headers: { 'sec-fetch-site': 'cross-site' }, form: { name: 'X', email: 'x@example.org' } })).status === 403,
    'posted from another site: 403',
  );

  console.log('');
  console.log('adding a surgeon without enough unused images changes nothing');
  const refused = await post('/api/admin/surgeons', { cookie: admin, form: { name: 'Dr Late', email: 'late@example.org' } });
  check(refused.status === 303 && refused.headers.get('location').includes('problem=not_enough_images'), `refused, and says why: ${refused.headers.get('location')}`);
  check(!db().prepare("SELECT 1 FROM surgeons WHERE email = 'late@example.org'").get(), 'no surgeon was left behind');

  console.log('');
  console.log('a new link locks out the old one everywhere');
  const oldToken = tokenOf(one.id);
  const signedIn = await fetch(`${BASE}/a/${oldToken}`, { redirect: 'manual' });
  const oldSession = cookieFrom(signedIn, 'sadi_session');
  check((await fetch(`${BASE}/api/queue`, { headers: { cookie: oldSession } })).status === 200, 'an open session works before');
  const renewed = await post(`/api/admin/surgeons/${one.id}/link`, { cookie: admin });
  check(renewed.status === 303 && tokenOf(one.id) !== oldToken, 'the link is replaced');
  check((await fetch(`${BASE}/a/${oldToken}`, { redirect: 'manual' })).status === 404, 'the old link is no longer recognised');
  check((await fetch(`${BASE}/api/queue`, { headers: { cookie: oldSession } })).status === 401, 'the session opened with it is refused');
  check((await fetch(`${BASE}/a/${tokenOf(one.id)}`, { redirect: 'manual' })).status === 303, 'the new link signs in');

  console.log('');
  console.log('pause and resume');
  await post(`/api/admin/surgeons/${two.id}/pause`, { cookie: admin });
  check((await fetch(`${BASE}/a/${tokenOf(two.id)}`, { redirect: 'manual' })).status === 403, 'a paused surgeon’s link is refused');
  check(ordersOf(two.id).length > 0, 'their queue is kept');
  await post(`/api/admin/surgeons/${two.id}/resume`, { cookie: admin });
  check((await fetch(`${BASE}/a/${tokenOf(two.id)}`, { redirect: 'manual' })).status === 303, 'after resume it works again');

  console.log('');
  console.log(`removing frame ${plan.sharedA.frameId}, which both surgeons drew on`);
  const frameId = plan.sharedA.frameId;
  const filename = db().prepare('SELECT filename FROM frames WHERE id = ?').get(frameId).filename;
  const masksBefore = fs.readdirSync(path.join(DATA, 'masks')).filter((n) => n.startsWith(`${frameId}__`));
  const lengths = [one.id, two.id].map((id) => ordersOf(id).length);
  const inQueues = [one.id, two.id].map((id) => db().prepare('SELECT COUNT(*) AS n FROM assignments WHERE surgeon_id = ? AND frame_id = ?').get(id, frameId).n);
  check(masksBefore.length === 2 && fs.existsSync(path.join(DATA, 'frames', filename)), 'before: two masks and the image file on disk');
  const unconfirmed = await post(`/api/admin/frames/${frameId}/remove`, { cookie: admin });
  check(unconfirmed.status === 303 && Boolean(db().prepare('SELECT 1 FROM frames WHERE id = ?').get(frameId)), 'without confirm=remove it only sends you to the confirmation page');
  const removed = await post(`/api/admin/frames/${frameId}/remove`, { cookie: admin, form: { confirm: 'remove' } });
  check(removed.status === 303 && removed.headers.get('location').includes('submitted=2'), `removed: ${removed.headers.get('location')}`);
  for (const [i, id] of [one.id, two.id].entries()) {
    const orders = ordersOf(id);
    check(orders.length === lengths[i] - inQueues[i] && contiguous(orders), `surgeon ${id}’s queue: ${lengths[i]} -> ${orders.length}, no gaps`);
  }
  check(fs.readdirSync(path.join(DATA, 'masks')).filter((n) => n.startsWith(`${frameId}__`)).length === 0, 'its masks are gone');
  check(!fs.existsSync(path.join(DATA, 'frames', filename)), 'the image file is gone');
  check(db().prepare('SELECT COUNT(*) AS n FROM annotations WHERE frame_id = ?').get(frameId).n === 0, 'its annotations are gone');

  console.log('');
  // Surgeon one, because their drawings on other frames are still on disk;
  // surgeon two's only drawing was on the frame just removed.
  console.log('removing a surgeon');
  const theirMasks = fs.readdirSync(path.join(DATA, 'masks')).filter((n) => n.split('__')[1] === String(one.id));
  const othersMasks = fs.readdirSync(path.join(DATA, 'masks')).filter((n) => n.split('__')[1] !== String(one.id));
  const othersQueue = ordersOf(two.id).length;
  const notConfirmed = await post(`/api/admin/surgeons/${one.id}/remove`, { cookie: admin });
  check(notConfirmed.status === 303 && Boolean(tokenOf(one.id)), 'without confirm=remove nothing is deleted');
  const gone = await post(`/api/admin/surgeons/${one.id}/remove`, { cookie: admin, form: { confirm: 'remove' } });
  check(gone.status === 303 && !tokenOf(one.id), `removed: ${gone.headers.get('location')}`);
  check(db().prepare('SELECT COUNT(*) AS n FROM annotations WHERE surgeon_id = ?').get(one.id).n === 0, 'their annotations are gone');
  check(ordersOf(one.id).length === 0, 'their queue is gone');
  check(
    theirMasks.length > 0 && theirMasks.every((n) => !fs.existsSync(path.join(DATA, 'masks', n))),
    `their ${theirMasks.length} mask files are gone`,
  );
  check(
    ordersOf(two.id).length === othersQueue && contiguous(ordersOf(two.id)) &&
      othersMasks.every((n) => fs.existsSync(path.join(DATA, 'masks', n))),
    'the other surgeon’s work is untouched',
  );

  console.log('');
  console.log('emailing an invitation');
  const sink = await startSmtpSink({ port: 2525 });
  const invite = await post(`/api/admin/surgeons/${two.id}/invite`, { cookie: admin });
  check(invite.status === 303 && invite.headers.get('location').includes('notice=invited'), `sent: ${invite.headers.get('location')}`);
  const email = db().prepare('SELECT email, access_token AS token, invited_at AS at FROM surgeons WHERE id = ?').get(two.id);
  const [letter] = sink.messages;
  check(Boolean(letter) && letter.to.includes(email.email) && letter.to.includes('lab@example.org'), 'to the surgeon, with a hidden copy to the study inbox');
  check(Boolean(letter) && !letter.headers.bcc && letter.body.includes(`/a/${email.token}`), 'carrying their own link, and no Bcc header');
  check(sink.logins.length === 1 && sink.logins[0].pass === 'abcdefghijklmnop', 'signed in with the app password, spaces removed');
  check(Boolean(email.at), 'the invitation is recorded');
  const twice = await post(`/api/admin/surgeons/${two.id}/invite`, { cookie: admin });
  check(twice.headers.get('location').includes('problem=just_sent') && sink.messages.length === 1, 'a second click straight away sends nothing');
  check((await post(`/api/admin/surgeons/${two.id}/invite`, { cookie: admin, headers: { 'sec-fetch-site': 'same-site' } })).status === 403, 'and a post from another page is refused');

  const noLink = await post('/api/admin/invitation', { cookie: admin, form: { intent: 'save', fromName: 'Lab', subject: 'Hi', body: 'No link' } });
  check(noLink.headers.get('location').includes('problem=template_needs_link'), 'wording without {link} is not saved');
  const tested = await post('/api/admin/invitation', {
    cookie: admin,
    form: { intent: 'test', fromName: 'Smoke Lab', subject: 'Hello {name}', body: 'Dear {name},\r\n\r\n{link}\r\n' },
  });
  const test = sink.messages[1];
  check(tested.headers.get('location').includes('notice=test_sent') && Boolean(test), 'saved, and a test sent');
  check(
    Boolean(test) && test.to.join() === 'lab@example.org' && test.headers.subject === '[Test] Hello Dr Example Surgeon' &&
      test.body.includes('/a/example-only-not-a-real-link'),
    'the test goes to the study inbox, with an example name and a link that does not work',
  );
  await sink.close();

  console.log('');
  console.log('uploading an image');
  const image = new PNG({ width: 32, height: 18 });
  for (let i = 0; i < image.data.length; i++) image.data[i] = (i * 37) % 256;
  const bytes = PNG.sync.write(image);
  const upload = (form = {}, body = bytes, headers = {}) =>
    fetch(`${BASE}/api/admin/frames/upload?${new URLSearchParams({ operation: 'Case 99', name: 'new frame.png', ...form })}`, {
      method: 'POST',
      headers: { cookie: admin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream', ...headers },
      body,
    });
  const added = await (await upload()).json();
  check(added.kind === 'added' && added.filename === 'Case_99__new_frame.png', `added as ${added.filename}`);
  const stored = db().prepare('SELECT * FROM frames WHERE id = ?').get(added.id);
  check(
    stored && stored.source_video === 'Case 99' && stored.width === 32 && stored.height === 18 && !stored.is_core &&
      fs.readFileSync(path.join(DATA, 'frames', added.filename)).equals(bytes),
    'recorded in the spare pool, with the file on disk',
  );
  check(!db().prepare('SELECT 1 FROM assignments WHERE frame_id = ?').get(added.id), 'nobody’s list changed');
  const again = await (await upload({ operation: 'Renamed', name: 'copy.png' })).json();
  check(again.kind === 'duplicate' && again.reason === 'same_image', 'the same image again, renamed, is skipped');
  const existing = db().prepare('SELECT filename FROM frames WHERE id = ?').get(plan.sharedB.frameId).filename;
  const old = await (await upload({ operation: 'Anything', name: 'x.png' }, fs.readFileSync(path.join(DATA, 'frames', existing)))).json();
  check(old.kind === 'duplicate' && old.id === plan.sharedB.frameId, 'an image loaded before uploads existed is recognised');
  const junk = await (await upload({ name: 'notes.png' }, Buffer.from('not an image'))).json();
  check(junk.kind === 'refused' && junk.reason === 'not_an_image', 'a file that is not an image is refused');
  check((await upload({}, bytes, { cookie: '' })).status === 401, 'no admin cookie: 401');
  check((await upload({}, bytes, { 'sec-fetch-site': 'same-site' })).status === 403, 'from another page: 403');

  console.log('');
  console.log('the new admin pages render');
  for (const page of ['/admin', '/admin/images', `/admin/surgeons/${two.id}/remove`, `/admin/frames/${plan.sharedB.frameId}/remove`]) {
    const response = await fetch(`${BASE}${page}`, { headers: { cookie: admin } });
    const html = await response.text();
    check(response.status === 200 && !html.includes('Unlock'), `${page}: 200`);
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`${failures.length} admin check(s) failed`);
    process.exit(1);
  }
  console.log('admin checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
