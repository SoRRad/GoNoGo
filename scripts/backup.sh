#!/usr/bin/env bash
#
# Nightly backup of the whole study.
#
#   BACKUP_BUCKET=gs://your-bucket ./scripts/backup.sh
#
# Takes a consistent SQLite snapshot through the online backup API, tars it with
# the frames and masks, uploads to Google Cloud Storage, and prunes old local
# copies.
#
# A plain `cp` of app.db is NOT safe. The database runs in WAL mode, so at any
# instant the committed state is split between app.db and app.db-wal; copying
# them separately while a surgeon is autosaving can produce a file that opens
# perfectly and is quietly missing the most recent annotations. The snapshot
# step below uses SQLite's online backup API instead, and verifies the result
# before anything is uploaded.
#
# Environment:
#   BACKUP_BUCKET   required, e.g. gs://<project-id>-sadi-backups
#   DATA_DIR        host path of the data volume, default /mnt/disks/sadi-data
#   KEEP_LOCAL      local archives to keep, default 7
#   USE_DOCKER      1 (default) runs the snapshot inside the app container,
#                   0 runs it directly with node from this directory
#
# Uploads with `gcloud storage`, which is on every Compute Engine image and in
# Cloud Shell. The VM needs a storage read-write access scope as well as IAM on
# the bucket; the README's backup section has both.

set -euo pipefail

# docker compose and dist/ are both resolved from the repository root, so run
# from there whatever directory this was started in.
cd "$(dirname "$(readlink -f "$0")")/.."

DATA_DIR="${DATA_DIR:-/mnt/disks/sadi-data}"
KEEP_LOCAL="${KEEP_LOCAL:-7}"
USE_DOCKER="${USE_DOCKER:-1}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
BACKUP_DIR="${DATA_DIR}/backups"
ARCHIVE="${BACKUP_DIR}/sadi-${STAMP}.tar.gz"
SNAPSHOT="${BACKUP_DIR}/app-${STAMP}.db"

if [[ -z "${BACKUP_BUCKET:-}" ]]; then
  echo "BACKUP_BUCKET is not set (e.g. gs://<project-id>-sadi-backups). Refusing to run." >&2
  exit 1
fi
if [[ ! -f "${DATA_DIR}/app.db" ]]; then
  echo "No database at ${DATA_DIR}/app.db. Is DATA_DIR correct?" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
if [[ "${USE_DOCKER}" == "1" && "${EUID}" -eq 0 ]]; then
  # The snapshot is written by the app container, which runs as the owner of the
  # data volume (uid 1001), not as root. Left root-owned, as mkdir just made it,
  # this directory refuses the write and every backup fails at step 1 with
  # SQLITE_CANTOPEN.
  chown --reference="${DATA_DIR}" "${BACKUP_DIR}"
fi
# Remove the intermediate snapshot however this exits; the tarball is the artefact.
trap 'rm -f "${SNAPSHOT}"' EXIT

echo "[1/4] Consistent database snapshot"
if [[ "${USE_DOCKER}" == "1" ]]; then
  # The container sees the same volume at /data, so this lands on the host at
  # ${BACKUP_DIR} and needs no dependencies installed outside the image.
  docker compose exec -T app node dist/scripts/db-snapshot.js "/data/backups/app-${STAMP}.db"
else
  node dist/scripts/db-snapshot.js "${SNAPSHOT}"
fi
if [[ ! -f "${SNAPSHOT}" ]]; then
  echo "Snapshot was not written to ${SNAPSHOT}" >&2
  exit 1
fi

echo "[2/4] Archiving database, frames and masks"
tar czf "${ARCHIVE}" \
  -C "${BACKUP_DIR}" "$(basename "${SNAPSHOT}")" \
  -C "${DATA_DIR}" frames masks
echo "      ${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1))"

echo "[3/4] Uploading to ${BACKUP_BUCKET}"
REMOTE="${BACKUP_BUCKET}/$(basename "${ARCHIVE}")"
gcloud storage cp "${ARCHIVE}" "${REMOTE}"
# Confirm it is actually there, and whole. An upload nobody verified is not an
# upload.
LOCAL_BYTES="$(stat -c %s "${ARCHIVE}")"
REMOTE_BYTES="$(gcloud storage objects describe "${REMOTE}" --format='value(size)')"
if [[ "${REMOTE_BYTES}" != "${LOCAL_BYTES}" ]]; then
  echo "Upload check failed: ${REMOTE} is ${REMOTE_BYTES:-missing} bytes, local archive is ${LOCAL_BYTES}" >&2
  exit 1
fi
echo "      uploaded and confirmed in the bucket (${REMOTE_BYTES} bytes, matching)"

echo "[4/4] Pruning local archives, keeping ${KEEP_LOCAL}"
ls -1t "${BACKUP_DIR}"/sadi-*.tar.gz 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f

echo "Done: $(basename "${ARCHIVE}")"
