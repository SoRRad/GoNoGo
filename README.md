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
  is disabled in the image and in the repo.

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
  masks/<frame_id>__<surgeon_id>__nogo.png
  consensus/<frame_id>__go_majority.png        pixel majority vote
  consensus/<frame_id>__nogo_majority.png
  annotations.csv                              every annotation column plus
                                               surgeon and frame metadata
  README.txt                                   describes each file
```

Go and No-Go are stored as independent layers and are never merged. An absent mask file means that
layer was empty, not that data is missing.

**Who counts as a rater** for consensus and agreement: every surgeon whose annotation was submitted
as `drawn` or `nothing_to_mark`. Saying there is nothing to mark is a real opinion, and it votes
zero across the whole frame. `cannot_assess` is excluded from the vote entirely. `README.txt` inside
the export states this too, so the archive is self-describing.

---

## Admin

`/admin`, gated by `ADMIN_PASSWORD`.

- **Surgeons** — frames completed, median seconds per frame, last active, and the background answers.
- **Per frame** — every surgeon's masks overlaid, each at equal opacity so brightness reads directly
  as how many surgeons included that pixel. Layers and individual surgeons can be toggled.
- **Agreement** — mean pairwise pixel agreement (share of the frame two surgeons classify the same
  way) and mean pairwise IoU (overlap of the marked regions, ignoring the shared background), plus
  the majority-vote area.
- **Export** — one button, streams the zip.

---

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

### 7. Back up

Everything is under one directory. There is nothing else to back up.

```bash
sudo tar czf /tmp/sadi-$(date +%F).tar.gz -C /mnt/disks/sadi-data .
gcloud compute scp sadi-study:/tmp/sadi-$(date +%F).tar.gz . --zone=us-central1-a
```

Or take a disk snapshot:

```bash
gcloud compute disks snapshot sadi-data --zone=us-central1-a --snapshot-names=sadi-$(date +%F)
```

To pull the finished study off the machine, use the export button in `/admin`, or:

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

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | yes | Gates `/admin`. Compared in constant time. |
| `SESSION_SECRET` | in production | Signs the surgeon and admin cookies. 32+ random characters. Changing it signs everyone out; their `/a/<token>` links still work. |
| `BASE_URL` | yes | Public origin. Used to print access links, and decides whether cookies are marked `Secure`. |
| `DATA_DIR` | no | Where the database, frames and masks live. Defaults to `./data`, set to `/data` in the image. |
| `DATA_HOST_PATH` | compose only | Host directory behind the named volume. Defaults to `./data`. |

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
npm run typecheck     # both the app and the CLI scripts
npm run build         # production build
```

The pipeline was verified end to end against synthetic frames: queue invariants (repeat gap,
practice ordering, disjoint individual sets) over 400 shuffle seeds, mask PNG round-trips, the full
surgeon flow including resume-after-reload and one-step-back, admin access control, and a consensus
export that recomputes to the exact same pixels from the individual masks it ships alongside.

**Not yet done:** the Docker image has not been built and run — this was developed in a sandbox with
a Docker CLI but no daemon. `docker compose config` validates and the production build and server
were exercised directly, but please run `docker compose up -d --build` once before the study opens.

**Still required before the study opens:** test on the real iPad, with a finger and with the pencil,
on `/canvas-lab` first and then on a real frame. Emulated touch and pen input pass, but that is not
the same as the glass.

### Note on `npm audit`

Two advisories remain, both inside the copy of `postcss` bundled with Next 15. They are build-time
CSS-parsing issues, and every stylesheet here is authored in this repository. Clearing them means
moving to Next 16.
