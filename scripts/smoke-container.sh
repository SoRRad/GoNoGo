#!/usr/bin/env bash
#
# Builds the production image, starts it, and drives the whole study pipeline
# through the running container: seed frames, seed surgeons, build queues,
# annotate through the real HTTP API with both surgeons, and export.
#
# The two paths most likely to break in a real study are covered end to end:
# agreement between surgeons on a frame they both saw, and the hidden repeats
# a surgeon is shown twice. Writes are gated to the queue's current position,
# so a repeat sitting 30+ places later is reached by actually annotating the
# frames in between, not by reaching into the database.
#
#   ./scripts/smoke-container.sh
#
# This exists because a green test suite says nothing about whether the image
# builds or the container boots. Those are the two things that fail on the day
# of deployment, and nothing else here exercises them.
#
# Environment:
#   IMAGE_TAG          image to build, default sadi-gonogo:smoke
#   PORT               host port to bind, default 3210
#   KEEP               set to 1 to leave the container and data behind
#   DOCKERFILE         Dockerfile to build, default ./Dockerfile
#   DOCKER_RUN_EXTRA   extra flags for docker run (e.g. --init)

set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-sadi-gonogo:smoke}"
PORT="${PORT:-3210}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
DOCKER_RUN_EXTRA="${DOCKER_RUN_EXTRA:-}"
CONTAINER="sadi-smoke-$$"
DATA_DIR="$(mktemp -d)"
BASE="http://127.0.0.1:${PORT}"
COOKIES="${DATA_DIR}/cookies.txt"

# Set when the data directory could only be handed over via sudo, so cleanup
# can remove it the same way.
SUDO=""

# The image runs as uid 1001 and mounts DATA_DIR at /data; a bind mount keeps
# the host's ownership, so the directory has to be handed over before the
# container starts. That needs root, which not every machine grants silently.
prepare_data_dir() {
  if chown -R 1001:1001 "${DATA_DIR}" 2>/dev/null; then
    return 0
  fi

  local reason
  if ! command -v sudo >/dev/null 2>&1; then
    reason="sudo is not installed"
  elif ! sudo -n true 2>/dev/null; then
    reason="sudo would prompt for a password"
  elif sudo -n chown -R 1001:1001 "${DATA_DIR}" 2>/dev/null; then
    SUDO="sudo -n"
    return 0
  else
    reason="sudo is available but the chown still failed"
  fi

  cat >&2 <<MESSAGE
FAIL: cannot give ${DATA_DIR} to uid 1001 (${reason}).

The container runs as uid 1001 and mounts that directory at /data, so it must
belong to 1001 before the container starts. Changing the owner needs root.

Run this script as root, or from an account with passwordless sudo. Both hold
on a GitHub Actions runner, so this is usually a developer machine where sudo
prompts for a password: re-run it under sudo.
MESSAGE
  exit 1
}

prepare_data_dir

cleanup() {
  local status=$?
  if [[ "${KEEP:-0}" != "1" ]]; then
    if [[ $status -ne 0 ]]; then
      echo ""
      echo "--- container logs ---"
      docker logs "${CONTAINER}" 2>&1 | tail -40 || true
    fi
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    rm -rf "${DATA_DIR}" 2>/dev/null || ${SUDO} rm -rf "${DATA_DIR}" 2>/dev/null || true
  else
    echo "KEEP=1: container ${CONTAINER}, data ${DATA_DIR}"
  fi
  exit $status
}
trap cleanup EXIT

step() { echo ""; echo "=== $* ==="; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------- build & boot

step "Build the image"
docker build -f "${DOCKERFILE}" -t "${IMAGE_TAG}" .

step "Start the container"
# shellcheck disable=SC2086  # DOCKER_RUN_EXTRA is intentionally word-split
docker run -d --name "${CONTAINER}" ${DOCKER_RUN_EXTRA} \
  -p "127.0.0.1:${PORT}:3000" \
  -e ADMIN_PASSWORD=smoke-admin-password \
  -e SESSION_SECRET=smoke-session-secret-at-least-32-chars \
  -e BASE_URL="${BASE}" \
  -v "${DATA_DIR}:/data" \
  "${IMAGE_TAG}" >/dev/null
echo "container ${CONTAINER} on ${BASE}"

step "Wait for the server to answer"
# Any HTTP status proves it booted; /api/health is expected to report 503
# frames_dir_empty until frames are seeded, which is the point of that check.
for attempt in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/health" || true)"
  if [[ "${code}" != "000" ]]; then
    echo "responding after ${attempt}s with HTTP ${code}"
    break
  fi
  [[ $attempt -eq 60 ]] && fail "server never answered on ${BASE}"
  sleep 1
done

step "Health reports the empty data volume"
health="$(curl -s "${BASE}/api/health")"
echo "${health}"
[[ "${health}" == *'"frames_dir_empty"'* ]] || fail "expected frames_dir_empty before seeding, got: ${health}"

# ------------------------------------------------------------------- pipeline

step "Seed dummy frames"
# 34 study frames, not a handful: queue.ts only weaves in a repeat when the
# queue is longer than MIN_REPEAT_GAP (30), and without one the intra-rater
# checks below would pass vacuously. With the pool under CORE_TARGET (50)
# every study frame is a core frame, so both surgeons see all of them.
docker exec "${CONTAINER}" npm run --silent make:dummy -- /data/incoming 34
docker exec "${CONTAINER}" npm run --silent seed:frames -- /data/incoming

step "Health turns ok once frames exist"
for attempt in $(seq 1 30); do
  health="$(curl -s "${BASE}/api/health" || true)"
  [[ "${health}" == '{"ok":true}' ]] && { echo "healthy after ${attempt}s"; break; }
  [[ $attempt -eq 30 ]] && fail "health never became ok, last: ${health}"
  sleep 1
done

step "Seed surgeons"
docker exec "${CONTAINER}" sh -c 'printf "name,email\nDr Smoke One,one@example.org\nDr Smoke Two,two@example.org\n" > /data/surgeons.csv'
docker exec "${CONTAINER}" npm run --silent seed:surgeons -- /data/surgeons.csv

step "Build queues"
docker exec "${CONTAINER}" npm run --silent assign

TOKEN="$(docker exec "${CONTAINER}" node -e "
  const D = require('better-sqlite3');
  const db = new D('/data/app.db', { readonly: true });
  process.stdout.write(db.prepare('SELECT access_token FROM surgeons ORDER BY id LIMIT 1').get().access_token);
")"
[[ -n "${TOKEN}" ]] || fail "no access token was generated"

# ------------------------------------------------------- annotate via the API

step "Sign in with the access link"
status="$(curl -s -o /dev/null -w '%{http_code}' -c "${COOKIES}" "${BASE}/a/${TOKEN}")"
[[ "${status}" == "303" ]] || fail "expected a redirect from /a/<token>, got ${status}"
grep -q sadi_session "${COOKIES}" || fail "no session cookie was set"
echo "session cookie set"

step "Redirects stay on the site behind a proxy"
# Caddy forwards the public Host and X-Forwarded-Proto, but Next builds
# request.url from its own listening address, so a redirect built from it sent
# browsers to https://localhost:3000/... -- every surgeon's access link and the
# admin login went nowhere. Hitting the container directly never showed it,
# because there the listening address IS the address in the browser.
PROXY_HEADERS=(-H "Host: study.example.org" -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: study.example.org")
location_of() { tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }'; }
link_to="$(curl -s -o /dev/null -D - "${PROXY_HEADERS[@]}" "${BASE}/a/${TOKEN}" | location_of)"
[[ "${link_to}" == "/welcome" ]] || fail "access link behind a proxy redirected to '${link_to}', expected /welcome"
admin_to="$(curl -s -o /dev/null -D - "${PROXY_HEADERS[@]}" -X POST \
  --data-urlencode "password=smoke-admin-password" "${BASE}/api/admin/login" | location_of)"
[[ "${admin_to}" == "/admin" ]] || fail "admin login behind a proxy redirected to '${admin_to}', expected /admin"
echo "access link -> ${link_to}, admin login -> ${admin_to}"

step "Complete onboarding"
curl -s -b "${COOKIES}" -c "${COOKIES}" -X POST \
  -F yearsInPractice=12 -F casesPerYear=30 "${BASE}/api/onboarding" | grep -q '"ok":true' \
  || fail "onboarding did not succeed"
echo "onboarded"

step "Read the queue"
QUEUE="$(curl -s -b "${COOKIES}" "${BASE}/api/queue")"
ASSIGNMENT="$(echo "${QUEUE}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).items[0].assignmentId')"
WIDTH="$(echo "${QUEUE}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).items[0].width')"
HEIGHT="$(echo "${QUEUE}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).items[0].height')"
TOTAL="$(echo "${QUEUE}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).state.total')"
echo "assignment ${ASSIGNMENT}, frame ${WIDTH}x${HEIGHT}, queue of ${TOTAL}"
[[ "${TOTAL}" -gt 0 ]] || fail "the queue is empty"

step "Draw a mask at the frame's native resolution"
# Built inside the container so it uses the image's own pngjs, exactly as the
# browser upload would be shaped: colour on a transparent background.
docker exec "${CONTAINER}" node -e "
  const { PNG } = require('pngjs');
  const fs = require('fs');
  const width = ${WIDTH}, height = ${HEIGHT};
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const inside = x > width * 0.3 && x < width * 0.7 && y > height * 0.3 && y < height * 0.7;
      png.data[i] = 0xef; png.data[i+1] = 0x44; png.data[i+2] = 0x44;
      png.data[i+3] = inside ? 255 : 0;
    }
  }
  fs.writeFileSync('/data/upload.png', PNG.sync.write(png));
"
cp "${DATA_DIR}/upload.png" "${DATA_DIR}/mask.png"

step "Submit the annotation"
RESPONSE="$(curl -s -b "${COOKIES}" -X POST \
  -F "assignmentId=${ASSIGNMENT}" \
  -F "status=drawn" \
  -F "confidence=high" \
  -F "secondsSpent=42" \
  -F "undoCount=2" \
  -F "submit=1" \
  -F "nogo=@${DATA_DIR}/mask.png;type=image/png" \
  "${BASE}/api/annotations")"
echo "${RESPONSE}" | grep -q '"ok":true' || fail "submit failed: ${RESPONSE}"

STORED="$(docker exec "${CONTAINER}" node -e "
  const D = require('better-sqlite3');
  const db = new D('/data/app.db', { readonly: true });
  const row = db.prepare('SELECT status, confidence, seconds_spent, undo_count, nogo_mask_path, submitted_at FROM annotations WHERE assignment_id = ?').get(${ASSIGNMENT});
  process.stdout.write(JSON.stringify(row));
")"
echo "stored: ${STORED}"
[[ "${STORED}" == *'"status":"drawn"'* ]]      || fail "status was not recorded"
[[ "${STORED}" == *'"confidence":"high"'* ]]   || fail "confidence was not recorded"
[[ "${STORED}" == *'"seconds_spent":42'* ]]    || fail "seconds were not recorded"
[[ "${STORED}" == *'masks/'* ]]                || fail "no mask path was stored"

step "The mask on disk is binary and native resolution"
docker exec "${CONTAINER}" node -e "
  const m = require('/app/dist/src/lib/masks.js');
  const D = require('better-sqlite3');
  const db = new D('/data/app.db', { readonly: true });
  const row = db.prepare('SELECT nogo_mask_path FROM annotations WHERE assignment_id = ?').get(${ASSIGNMENT});
  const mask = m.readBinaryMaskPng('/data/' + row.nogo_mask_path);
  const painted = m.countSet(mask.data);
  if (mask.width !== ${WIDTH} || mask.height !== ${HEIGHT}) throw new Error('wrong dimensions: ' + mask.width + 'x' + mask.height);
  if (painted === 0) throw new Error('mask is empty');
  console.log('mask ' + mask.width + 'x' + mask.height + ', ' + painted + ' px painted');
"

step "The queue advanced"
AFTER="$(curl -s -b "${COOKIES}" "${BASE}/api/queue" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).state.currentIndex')"
[[ "${AFTER}" == "1" ]] || fail "expected the queue to advance to index 1, got ${AFTER}"
echo "currentIndex is now ${AFTER}"

# ------------------------------------------------- the whole cohort, end to end
# Everything above is one annotation from one surgeon, which says nothing about
# agreement or repeats. The helpers live in scripts/smoke/ rather than inline
# here because they do real work: choosing frames, driving ~40 submissions per
# surgeon, and reading the exported archive back.

step "Copy the smoke helpers into the container"
docker cp scripts/smoke "${CONTAINER}:/app/"
echo "scripts/smoke -> /app/smoke"

step "Choose the frames to disagree on, and draw the masks"
docker exec "${CONTAINER}" node /app/smoke/plan.cjs

step "Both surgeons work their whole queue"
docker exec "${CONTAINER}" node /app/smoke/drive.cjs

step "What landed on disk"
docker exec "${CONTAINER}" node /app/smoke/check-disk.cjs

# ---------------------------------------------------------------- export

step "Export the study"
docker exec "${CONTAINER}" npm run --silent export
ARCHIVE="$(ls -1 "${DATA_DIR}"/exports/*.zip 2>/dev/null | head -1)"
[[ -n "${ARCHIVE}" ]] || fail "no export archive was written"
echo "archive: $(basename "${ARCHIVE}") ($(du -h "${ARCHIVE}" | cut -f1))"

step "The archive contains what it should"
NAMES="$(docker exec "${CONTAINER}" node -e "
  const fs = require('fs'), path = require('path');
  const dir = '/data/exports';
  const file = path.join(dir, fs.readdirSync(dir).filter(n => n.endsWith('.zip'))[0]);
  const buf = fs.readFileSync(file);
  // Walk the zip central directory; no unzip binary in the image.
  const names = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const len = buf.readUInt16LE(i + 28);
    names.push(buf.subarray(i + 46, i + 46 + len).toString('utf8'));
  }
  process.stdout.write(names.join('\n'));
")"
for expected in "export/annotations.csv" "export/README.txt" "export/frame_agreement.csv" \
                "export/intra_rater_pairs.csv" "export/intra_rater_summary.csv" \
                "export/presence_agreement.csv" "export/videos.csv" "export/splits.csv" \
                "export/frames/" "export/masks/" "export/consensus/" "export/repeats/"; do
  echo "${NAMES}" | grep -q "${expected}" || fail "export is missing ${expected}"
done
echo "${NAMES}" | tr ' ' '\n' | sed 's/^/  /' | head -12
echo "  ... $(echo "${NAMES}" | wc -l) entries total"

step "The statistics in the export"
docker exec "${CONTAINER}" node /app/smoke/check-export.cjs

step "Admin is reachable and gated"
admin_code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/admin")"
[[ "${admin_code}" == "200" ]] || fail "admin page did not render: ${admin_code}"
export_code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/admin/export")"
[[ "${export_code}" == "401" ]] || fail "admin export should reject an unauthenticated caller, got ${export_code}"
echo "admin login renders, admin export rejects anonymous callers"

step "Docker reports the container healthy"
for attempt in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null || echo unknown)"
  [[ "${state}" == "healthy" ]] && { echo "HEALTHCHECK: ${state} after ${attempt}s"; break; }
  [[ $attempt -eq 60 ]] && fail "container health never became healthy (last: ${state})"
  sleep 2
done

echo ""
echo "SMOKE TEST PASSED"
