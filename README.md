# SADI Go/No-Go annotation platform

A web application where 4–6 surgeons independently draw **Go** and **No-Go** dissection zones on
still frames from robotic duodenal switch video.

It is a research data collection instrument. Everything in it is built around one screen — the
annotation screen — and around keeping every surgeon's judgement independent of every other's.

---

## What a surgeon sees

1. They open a personal link from their email: `https://your-domain/a/<token>`. No password, no
   account, no app to install.
2. **`/welcome`** — six instruction lines, one worked example showing a green region and a red
   region, and two background questions (years in practice, cases per year). Asked once.
3. Five practice frames, with no scoring and no feedback, then straight into the real queue with
   no announcement.
4. Each frame fills the screen, letterboxed. They lasso or paint a Go zone, a No-Go zone, both, or
   neither; pick a confidence; press Next.
5. They can close the tab at any moment and resume on the exact frame they left.

## What the software guarantees

- **No surgeon can ever see another surgeon's work.** Masks are served per assignment and checked
  against the session, admin mask routes reject surgeon sessions, and no aggregate is shown
  anywhere in the annotation interface.
- **No anatomy class labels appear in the interface.** The only vocabulary is Go and No-Go.
- **Repeat frames are indistinguishable.** A repeat is a separate assignment with its own empty
  annotation, so it renders exactly like a first showing and counts in the progress readout.
- **Navigation is one step back, never forward.** The server rejects writes outside the current
  frame and the one before it.
- **The timer is never shown**, and it pauses whenever the tab is not in front.
- **Nothing is fetched from a third party.** No webfonts, no CDN, no analytics. Next.js telemetry
  is disabled in the image and in the repo, and the Content Security Policy pins every source to
  this origin.
- **Access tokens stay out of logs.** A surgeon's link is a working credential, so
  `Referrer-Policy: no-referrer` stops the browser leaking it to anywhere the page navigates, and
  the Caddy config excludes `/a/*` from the access log entirely.
- **The admin password cannot be guessed at leisure.** Five failed attempts from an address earns a
  fifteen minute lockout, checked before the password is. Failures are logged with a timestamp; the
  password never is.
- **Statistics never lie by convention.** An undefined agreement figure is reported as empty with a
  reason, never as `NaN` and never as a flattering 1.

---

## Quick start, locally

```bash
npm install
cp .env.example .env.local        # then edit ADMIN_PASSWORD and SESSION_SECRET

# Optional: synthetic frames, so you can try the whole pipeline before you have real ones
npm run make:dummy -- ./data/dummy-frames 60
npm run seed:frames -- ./data/dummy-frames

printf 'name,email\nDr A Smith,a@example.org\nDr B Jones,b@example.org\n' > surgeons.csv
npm run seed:surgeons -- surgeons.csv     # prints one /a/<token> link per surgeon
npm run assign

npm run dev                                # http://localhost:3000
```

Open a printed link to annotate. Open `/admin` and enter `ADMIN_PASSWORD` to watch progress.

### The canvas on its own

`http://localhost:3000/canvas-lab` is a standalone harness for the drawing surface: no database, no
session, no queue. Open it on the iPad you intend to use and hammer on it. It reports pointer type,
pressure, painted pixel counts and export size.

---

## Frames, surgeons and queues

### `npm run seed:frames -- <dir> [--source-video=NAME]`

Copies frames into `data/frames` and records their native dimensions. Layout inside `<dir>`:

```
<dir>/practice/*.png      the 5 shared practice frames, always shown first
<dir>/<video-name>/*.png  study frames; source_video comes from the folder name
<dir>/*.png               study frames; source_video comes from --source-video
```

PNG and JPEG are both accepted. Re-running updates existing rows rather than duplicating them, so
it is safe to run again after adding frames.

### `npm run seed:surgeons -- <csv>`

CSV of `name,email` (a header row is detected and skipped). Generates a 32-character url-safe access
token per surgeon and prints the links. **Email these individually and treat a link like a
password** — it is the only credential. Re-running keeps existing tokens, so links already sent
never stop working.

### `npm run assign`

Builds one queue per surgeon:

| Part | Count | Shared? |
| --- | --- | --- |
| Practice | 5 | identical for everyone, always first |
| Core | 50 | identical for everyone, so each gets 4–6 independent opinions |
| Individual | 70 | unique to that surgeon |
| Repeats | ~10% of the 120 non-practice frames | hidden duplicates, at least 30 positions later |

Order is shuffled independently per surgeon; practice frames stay first. A full-size queue is
137 frames.

Surgeons who already have a queue are skipped, so adding a late participant never disturbs anyone's
work — and they still receive the same core set everyone else got. `-- --reset` rebuilds queues for
surgeons who have not submitted anything yet; it refuses to touch a surgeon who has.

**If the frame pool is too small**, queues are scaled down to fit and the script prints a loud
warning naming exactly how many frames are missing. It never fails silently. A full-size study needs
`5 + 50 + 70 × surgeons` frames — 475 for six surgeons.

### `npm run export`

Writes the full export zip to `data/exports/`. The admin page has a button that streams the same
archive.

### `npm run db:reset -- --yes`

Deletes every annotation, mask and queue, keeping frames and surgeons. For clearing test data
before the study opens. Refuses to run without `--yes` and prints what it will destroy first.

---

## Export format

```
export/
  frames/<frame_id>.png                        native resolution, always PNG
  masks/<frame_id>__<surgeon_id>__go.png       8-bit grayscale, 0 or 255
  masks/<frame_id>__<surgeon_id>__nogo.png     first showings only
  repeats/<frame_id>__<surgeon_id>__<assignment_id>__go.png
  repeats/<frame_id>__<surgeon_id>__<assignment_id>__nogo.png
  consensus/<frame_id>__go_majority.png        pixel majority vote
  consensus/<frame_id>__nogo_majority.png
  annotations.csv          every annotation column plus surgeon and frame metadata
  frame_agreement.csv      inter-rater agreement, one row per frame per layer
  intra_rater_pairs.csv    each hidden repeat against its first showing
  intra_rater_summary.csv  per surgeon per layer
  presence_agreement.csv   study-level, chance-corrected
  README.txt               describes every file and every column
```

Go and No-Go are stored as independent layers and are never merged. An absent
mask file means that layer was empty, not that data is missing.

**Who counts as a rater**: every surgeon whose annotation was submitted as
`drawn` or `nothing_to_mark`. Saying there is nothing to mark is a real opinion,
and it votes zero across the frame. `cannot_assess` is excluded from every
statistic.

**First showings only, for everything between surgeons.** A surgeon who also
received a frame as a hidden repeat has two submitted annotations for it.
`masks/`, `consensus/` and the inter-rater tables use only the first
(`is_repeat = 0`); the second appears in `repeats/` and the intra-rater tables.
Counting both would weight that surgeon twice in the majority vote and pair them
with themselves in the agreement statistics.

`README.txt` inside the archive states all of this too, so the export is
self-describing.

## Statistics

Two different questions are reported separately, because collapsing them hides
which one is driving a result:

- **Presence** — did the surgeons agree a zone of this class exists at all?
- **Shape** — given that they drew one, how closely do the regions correspond?

| Metric | What it answers |
| --- | --- |
| IoU | Mean pairwise area overlap, \|A∩B\| / \|A∪B\| |
| Dice | Mean pairwise 2\|A∩B\| / (\|A\|+\|B\|). Always reads higher than IoU; quote one, not whichever is larger |
| NSD | Fraction of each contour within 0.5% of the image diagonal (~11 px at 1080p) of the other. Edges, not areas |
| Pixel agreement | Whole-image, background included. Reads above 90% even for poor spatial agreement — **not** a headline figure |
| Cohen's / Fleiss' kappa | Chance-corrected presence agreement, across frames |

Three deliberate choices worth knowing about:

1. **A pair where both surgeons drew nothing is excluded from the shape
   metrics**, and counted in `excluded_empty_pairs`. Overlap is undefined for
   that pair, not perfect. Scoring it 1 would pull the mean towards 1 on exactly
   the frames where least was drawn. Their agreement about absence is captured
   by the presence statistics instead.
2. **An undefined statistic is reported as empty, never as `NaN` or a
   placeholder number.** Kappa is undefined when raters are unanimous
   (expected agreement is 1, so the coefficient is 0/0); the accompanying
   `kappa_note` says `undefined_unanimous`, which is a favourable result rather
   than missing data.
3. **Intra-rater agreement is the baseline for inter-rater agreement.** Roughly
   one frame in ten returns unannounced at least 30 positions later. If a
   surgeon reproduces their own judgement at IoU 0.5, then two surgeons agreeing
   at 0.5 is the measurement noise floor, not evidence that they disagree.
   Report inter-rater agreement against this baseline, not against 1.

## Admin

`/admin`, gated by `ADMIN_PASSWORD`.

- **Surgeons** — frames completed, median seconds per frame, last active, and the
  background answers.
- **Self-agreement on hidden repeats** — per surgeon: how closely they reproduce
  their own judgement, and how often their status or confidence changed between
  showings. Watch this while the study runs: a surgeon whose repeats drift apart
  is changing their criteria mid-study, and that is worth a conversation before
  the data is collected rather than after.
- **Presence agreement** — study-level, chance-corrected, per layer.
- **Per frame** — every surgeon's masks overlaid, each at equal opacity so
  brightness reads directly as how many surgeons included that pixel. Presence
  and shape metrics reported separately, with the excluded-pair count shown.
- **Export** — one button, streams the zip.

The repeat analysis decodes four mask files per pair, so it is cached against a
fingerprint of the annotations table and recomputed only after a save.

## Deploying on a Google Cloud `e2-small`

Exact steps. Replace `study.example.org`, the project and the zone.

### 1. Create a persistent disk and the VM

```bash
gcloud compute disks create sadi-data \
  --size=50GB --type=pd-balanced --zone=us-central1-a

gcloud compute instances create sadi-study \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --disk=name=sadi-data,device-name=sadi-data,mode=rw,boot=no \
  --tags=http-server,https-server

gcloud compute firewall-rules create allow-http-https \
  --allow=tcp:80,tcp:443 --target-tags=http-server,https-server

# A static IP, so DNS keeps pointing at the right place across reboots
gcloud compute addresses create sadi-ip --region=us-central1
gcloud compute addresses describe sadi-ip --region=us-central1 --format='value(address)'
```

Point an `A` record for `study.example.org` at that address **before** starting Caddy.

### 2. Mount the persistent disk

```bash
gcloud compute ssh sadi-study --zone=us-central1-a

# Format ONCE, on first setup only. This erases the disk.
sudo mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard \
  /dev/disk/by-id/google-sadi-data

sudo mkdir -p /mnt/disks/sadi-data
sudo mount -o discard,defaults /dev/disk/by-id/google-sadi-data /mnt/disks/sadi-data

# Survive reboots
echo "/dev/disk/by-id/google-sadi-data /mnt/disks/sadi-data ext4 discard,defaults,nofail 0 2" \
  | sudo tee -a /etc/fstab

# The container runs as uid 1001, so the data directory must be writable by it
sudo chown -R 1001:1001 /mnt/disks/sadi-data
```

### 3. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker
```

### 4. Start the app

```bash
sudo mkdir -p /opt/sadi && sudo chown $USER:$USER /opt/sadi
git clone <your-repo-url> /opt/sadi/app
cd /opt/sadi/app

cat > .env <<EOF
ADMIN_PASSWORD=$(openssl rand -base64 24)
SESSION_SECRET=$(openssl rand -hex 32)
BASE_URL=https://study.example.org
DATA_HOST_PATH=/mnt/disks/sadi-data
EOF
chmod 600 .env
cat .env          # write the admin password down somewhere safe

docker compose up -d --build
docker compose ps        # wait for "healthy"
curl -s localhost:3000/api/health
```

`e2-small` has 2 GB of RAM. The build is the heaviest step; if it is ever killed, build the image
elsewhere and push it, or add swap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 5. HTTPS with Caddy

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo cp /opt/sadi/app/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # set your domain and email
sudo systemctl reload caddy
sudo systemctl status caddy
```

The app only listens on `127.0.0.1:3000`, so Caddy is the only way in. Certificates are issued and
renewed automatically.

### 6. Load the study

```bash
cd /opt/sadi/app

# Put your frames on the VM, e.g.:
#   gcloud compute scp --recurse ./frames sadi-study:/mnt/disks/sadi-data/incoming --zone=us-central1-a
# with a practice/ subdirectory inside it, then:
docker compose exec app npm run seed:frames -- /data/incoming

docker compose exec app sh -c 'cat > /data/surgeons.csv' <<'EOF'
name,email
Dr A Smith,a@example.org
Dr B Jones,b@example.org
EOF
docker compose exec app npm run seed:surgeons -- /data/surgeons.csv   # prints the links
docker compose exec app npm run assign
```

Email each surgeon their own link. Nothing else is needed from them.

### 7. Back up, nightly

Everything is under one directory, so there is nothing else to back up.

`scripts/backup.sh` takes a consistent SQLite snapshot through the online backup
API, tars it with the frames and masks, uploads to Google Cloud Storage, and
verifies the upload arrived. It refuses to run without a bucket.

> A plain `cp` of `app.db` is **not** safe. The database runs in WAL mode, so at
> any instant the committed state is split between `app.db` and `app.db-wal`;
> copying them separately while a surgeon is autosaving produces a file that
> opens perfectly and is quietly missing the most recent annotations.

```bash
# Create the bucket, in the same region as the VM
gsutil mb -l us-central1 gs://sadi-study-backups
gsutil versioning set on gs://sadi-study-backups

# Tell the backup where to put things
sudo tee /etc/sadi-backup.env > /dev/null <<'EOF'
BACKUP_BUCKET=gs://sadi-study-backups
EOF
sudo chmod 600 /etc/sadi-backup.env

# Run it once by hand and watch it work
sudo BACKUP_BUCKET=gs://sadi-study-backups /opt/sadi/app/scripts/backup.sh

# Then schedule it for 02:30 UTC nightly
sudo cp /opt/sadi/app/deploy/sadi-backup.service /etc/systemd/system/
sudo cp /opt/sadi/app/deploy/sadi-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sadi-backup.timer
systemctl list-timers sadi-backup.timer
```

The VM's service account needs `roles/storage.objectCreator` on the bucket.

Disk snapshots are a useful second line, but they are not a substitute: they
capture the WAL mid-write just as a file copy does.

```bash
gcloud compute disks snapshot sadi-data --zone=us-central1-a   --snapshot-names=sadi-$(date +%F)
```

### 8. Restore, and prove it works

**A backup nobody has restored is not a backup.** Do this once, on a throwaway
machine or a scratch directory, before the study opens — and put a tick in the
checklist below only after you have seen the annotation count come back.

```bash
# 1. Fetch an archive
gsutil ls gs://sadi-study-backups
gsutil cp gs://sadi-study-backups/sadi-2026-09-17T02-30-11Z.tar.gz /tmp/

# 2. Unpack it somewhere that is NOT the live data directory
mkdir -p /tmp/restore && tar xzf /tmp/sadi-*.tar.gz -C /tmp/restore
ls /tmp/restore                      # app-<stamp>.db, frames/, masks/

# 3. Check the database opens and holds what you expect
docker compose exec -T app node -e "
  const D = require('better-sqlite3');
  const db = new D('/data/restore/app-<stamp>.db', { readonly: true });
  console.log('integrity:', db.pragma('integrity_check', { simple: true }));
  console.log('annotations:', db.prepare('SELECT COUNT(*) n FROM annotations').get().n);
  console.log('submitted:', db.prepare('SELECT COUNT(*) n FROM annotations WHERE submitted_at IS NOT NULL').get().n);
"
```

To restore for real, onto a fresh machine:

```bash
docker compose down                  # stop writers first
sudo rm -rf /mnt/disks/sadi-data/{app.db,app.db-wal,app.db-shm,frames,masks}
sudo cp /tmp/restore/app-<stamp>.db /mnt/disks/sadi-data/app.db
sudo cp -r /tmp/restore/frames /tmp/restore/masks /mnt/disks/sadi-data/
sudo chown -R 1001:1001 /mnt/disks/sadi-data
docker compose up -d
curl -s localhost:3000/api/health     # expect {"ok":true}
```

Surgeons' links keep working: tokens live in the database and are restored with
it. `SESSION_SECRET` must be the same as before, or everyone is signed out and
has to reopen their link.

To pull the finished study off the machine, use the export button in `/admin`,
or:

```bash
docker compose exec app npm run export
# lands in /mnt/disks/sadi-data/exports/ on the host
```

### Updating

```bash
cd /opt/sadi/app && git pull && docker compose up -d --build
```

The database and masks live on the mounted disk, untouched by a rebuild.

---

## Operational status

Tick every line before a real surgeon is sent a link. Each is something that has
silently failed for somebody else.

- [ ] **Docker image built and run.** `docker compose up -d --build`, then
      `docker compose ps` shows `healthy`. Never exercised in development — see
      Testing below.
- [ ] **iPad tested, finger and pencil.** `/canvas-lab` first, then a real frame
      through a real access link. Lasso must not lag and the page must not
      scroll under the hand.
- [ ] **Backup taken and restored once.** Not just scheduled: actually unpacked,
      opened, and the annotation count checked. See step 8.
- [ ] **Admin password rotated** off anything that appeared in a README, a
      script, or a shell history. `openssl rand -base64 24`.
- [ ] **SESSION_SECRET generated** and recorded somewhere it can be recovered.
      `openssl rand -hex 32`. Losing it signs everyone out; changing it after
      launch does the same.
- [ ] **HTTPS verified.** `curl -sI https://your-domain | head -1` returns 200
      over TLS, and plain http redirects. Check the certificate is real.
- [ ] **Frames reviewed for identifiers** — in the images themselves and in the
      filenames, which appear in the export and the admin interface. The
      software does no de-identification. See `GOVERNANCE.md`.
- [ ] **Queue sizes confirmed.** `npm run assign` reported no shortfall warning,
      or the reduced sizes were a deliberate decision.
- [ ] **GOVERNANCE.md read** by whoever is answering to the ethics committee.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | yes | Gates `/admin`. Compared in constant time. |
| `SESSION_SECRET` | in production | Signs the surgeon and admin cookies. 32+ random characters. Changing it signs everyone out; their `/a/<token>` links still work. |
| `BASE_URL` | yes | Public origin. Used to print access links, and decides whether cookies are marked `Secure`. |
| `DATA_DIR` | no | Where the database, frames and masks live. Defaults to `./data`, set to `/data` in the image. |
| `DATA_HOST_PATH` | compose only | Host directory behind the named volume. Defaults to `./data`. |
| `BACKUP_BUCKET` | backups only | Google Cloud Storage bucket for `scripts/backup.sh`, e.g. `gs://sadi-study-backups`. Nothing is uploaded unless it is set. |
| `KEEP_LOCAL` | no | Local backup archives to keep on the VM. Defaults to 7. |

---

## How it is built

- **Next.js 15** (App Router, TypeScript) and **Tailwind**.
- **SQLite** through `better-sqlite3`, in WAL mode. No external database service.
- **Masks as PNG files on disk**, never as blobs in the database. The database stores paths.
- **The canvas is hand-written** over pointer events. No drawing library.

### The drawing surface

`src/components/AnnotationCanvas.tsx` is the whole product. Worth knowing:

- Two independent native-resolution offscreen canvases, one per class. They are never merged, and
  the eraser only ever composites against the layer it is applied to.
- The display canvas is sized to the letterboxed rectangle times the device pixel ratio (capped at
  2). Pointer coordinates are mapped back to native pixels, so a mask is always drawn at the
  frame's true resolution regardless of screen size.
- **Undo replays commands, it does not snapshot pixels.** Each stroke is kept as
  `{layer, tool, size, points}`; undo pops the last one and repaints that layer from its base. An
  ImageData snapshot of a 1080p frame is 8 MB, and a command is a few hundred bytes.
- Resumed work is loaded as an un-undoable *base* underneath the command list, so undo can never
  erase something from an earlier sitting.
- Pointer input uses `getCoalescedEvents()`, so a fast pencil stroke keeps every sample the digitiser
  produced rather than one per frame.
- **Palm rejection:** once a `pen` pointer is seen, `touch` pointers stop drawing.
- Scroll and zoom are refused three ways: `touch-action: none`, non-passive `touchstart`/`touchmove`
  handlers that `preventDefault`, and `gesturestart`/`gesturechange` blockers for iOS Safari, which
  ignores `user-scalable=no`.
- Emptiness is judged on a 128×128 downscale rather than a full-resolution alpha scan, so the Next
  button can update on every stroke without a multi-millisecond pause.

Measured in Chromium at 4× CPU throttling: 0.11 ms per pointer event, 5.8 ms to commit a 400-point
lasso including the fill, the full layer replay and the occupancy probe, at a steady 60 fps.

### Saving

Autosave every 5 seconds while the frame is dirty, plus on tab blur and on page hide. Both autosave
and submit hit the same endpoint and upsert the single annotation row for that assignment. Masks
are uploaded as canvas PNGs and rewritten server-side as binary grayscale at the frame's native
resolution; an upload whose dimensions do not match the frame is rejected rather than stored.

A frame the surgeon has not touched never creates a row.

---

## Testing

```bash
npm test          # Vitest: queue, masks, analysis, export
npm run typecheck # both the app and the CLI scripts
npm run lint
npm run build
```

`.github/workflows/ci.yml` runs all four on every push and pull request, on Node 20
to match the image.

The suite covers the pure logic, with no browser and no fixtures beyond an
in-memory SQLite database built from the real schema:

- **Queue** — seeded shuffles are permutations and reproduce per seed; the repeat
  gap holds across 400 seeds; practice frames always lead; every repeat points at
  an earlier showing of the same frame; individual sets are disjoint and spread
  across videos, including when there are fewer videos than surgeons.
- **Masks** — binary PNG round-trips exactly, including all-zero and all-one;
  uploads are read by alpha rather than brightness; majority vote is checked
  against hand-computed answers at 2, 3, 4 and 5 raters, and an even split never
  carries; IoU and pixel agreement against hand-computed values.
- **Analysis** — `nothing_to_mark` counts as an all-zero voter, `cannot_assess` is
  excluded, unsubmitted annotations are ignored, and a missing or wrongly sized
  mask file degrades to all-zero instead of throwing.
- **Export** — CSV quoting round-trips commas, quotes and newlines; the consensus
  mask recomputes to the same pixels from the individual masks shipped beside it.

Beyond the suite, the browser behaviour was exercised by driving a real Chromium:
the full surgeon flow including resume-after-reload and one-step-back, admin
access control, and pointer input with finger, pen and palm rejection.

**Not yet done:** the Docker image has not been built and run — this was
developed in a sandbox with a Docker CLI but no daemon. `docker compose config`
validates and the production build and server were exercised directly, but please
run `docker compose up -d --build` once before the study opens.

**Still required before the study opens:** test on the real iPad, with a finger
and with the pencil, on `/canvas-lab` first and then on a real frame. Emulated
touch and pen input pass, but that is not the same as the glass.

## Governance, licence and citation

- **`GOVERNANCE.md`** — what is stored, where it lives, who can see it, how long
  it is kept, what happens at study close, and how to remove a participant's data
  on request. Written to be handed to an IRB reviewer.
- **`LICENSE`** — MIT, and it covers **the software only**. It grants no rights
  in the surgical frames, the annotations, or any dataset assembled with it;
  those are governed by the study protocol and the ethics approval.
- **`CITATION.cff`** — carries a placeholder DOI. Replace it when a release is
  archived.

### Note on `npm audit`

Two advisories remain, both inside the copy of `postcss` bundled with Next 15. They are build-time
CSS-parsing issues, and every stylesheet here is authored in this repository. Clearing them means
moving to Next 16.
