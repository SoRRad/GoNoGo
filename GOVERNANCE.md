# Data governance

For an IRB reviewer, a data protection officer, or anyone deciding whether this
system is safe to point at real operative video. It describes what the software
does, not what anyone intends; where a decision is the study team's rather than
the software's, it says so.

## What is stored

**Operative still frames.** PNG or JPEG images extracted from robotic duodenal
switch procedures, supplied by the study team. The software never extracts,
receives or transmits video. It stores whatever frames are placed in its frames
directory and serves them only to signed-in participants who have that frame in
their own queue.

**Annotation masks.** One binary image per surgeon per frame per zone class,
recording which pixels that surgeon marked. Stored as 8-bit grayscale PNGs at
the frame's native resolution.

**Annotation metadata.** Per frame: the zone class drawn, a confidence rating,
a status (`drawn`, `nothing_to_mark`, `cannot_assess`), seconds spent, how many
times undo was pressed, and timestamps.

**Participant records.** Name, email address, a randomly generated 32-character
access token, years in independent practice, and approximate annual case volume.

**Nothing else.** There is no patient identifier, medical record number, date of
surgery, institution field, or free-text field anywhere in the schema. The
software cannot store them because there is nowhere to put them.

### Identifiability

The frames are the sensitive material. Whether a given still is identifiable is
a judgement about the images themselves and is the study team's to make before
ingestion — this software performs no de-identification, no face or text
redaction, and no checking. It will store exactly what it is given.

Frame filenames and the `source_video` field are chosen by whoever prepares the
frames. **They should not contain patient identifiers**, because they appear in
the export and in the admin interface.

## Where it physically lives

A single directory on one virtual machine, chosen by the study team at
deployment. In the documented deployment that is a Google Cloud persistent disk
mounted at `/mnt/disks/sadi-data` on an `e2-small` instance, containing:

```
app.db      SQLite database: participants, frames, queues, annotation metadata
frames/     the operative stills
masks/      the annotation masks
exports/    any export archives generated on the machine
backups/    local backup archives, if backups are enabled
```

**Frames never leave the host.** They are served to participants' browsers over
HTTPS for display, and they are included in an export archive when an
administrator downloads one. There is no other path off the machine. The
application makes no outbound network requests at all: no CDN, no web fonts, no
analytics, no error reporting, no telemetry. Next.js telemetry is disabled in
the image and in the repository.

If backups to Google Cloud Storage are enabled, the backup archive contains the
frames and masks and is uploaded to a bucket the study team controls. That is
the one deliberate copy off the host, and it is opt-in: nothing is uploaded
unless `BACKUP_BUCKET` is set.

## Who can see what

**A participating surgeon** sees only the frames assigned to their own queue,
and only their own annotations. The server checks ownership on every frame and
mask request. There is no interface, endpoint or export that shows one surgeon
another's work, and no aggregate is visible to participants at any point. This
is enforced in code, not by convention.

**An administrator** — anyone holding `ADMIN_PASSWORD` — can see every
participant's name, email, progress and annotations, every frame, and can
download the complete export. This is the only privileged role; there are no
per-user permissions and no audit trail of administrator actions beyond
successful and failed login timestamps in the container log.

**Access tokens are credentials.** A surgeon's link, `/a/<token>`, signs in
whoever opens it, with no second factor. Anyone who obtains a link has that
surgeon's access until the token is changed. Links are emailed individually by
the researcher; the software never sends email. The reverse proxy configuration
excludes these URLs from its access log so tokens are not written to disk.

**Who holds the password and the tokens is the study team's decision**, and
should be recorded in the study protocol rather than here. The software imposes
no limit on how many people hold them.

## Retention and study close

The software has no retention policy and deletes nothing on its own. Data
persists until someone removes it. Retention is therefore whatever the study
protocol says, enforced by the study team.

At study close the intended sequence is:

1. Generate a final export and verify it opens.
2. Move the export to wherever the analysis and archival copies are kept.
3. Destroy the virtual machine and delete the persistent disk and any disk
   snapshots.
4. Delete the backup bucket contents, if backups were enabled.

Steps 3 and 4 are the only ones that remove the frames from cloud infrastructure.
Deleting the VM alone does not: the persistent disk and any snapshots survive it.

## Removing a participant's data on request

A participant who withdraws can be removed completely. Their annotations are
identified by `surgeon_id` throughout, and the schema cascades on delete:

```sql
-- Removes the participant, their queue, and every annotation they made.
DELETE FROM surgeons WHERE email = 'them@example.org';
```

Their mask files are named by frame, surgeon and assignment, so the
corresponding files under `masks/` and any exports containing them must be
removed separately; the database delete does not touch the filesystem. Any
export archive generated before the withdrawal still contains their data and
must be regenerated or destroyed.

What cannot be undone: if an analysis has already been run and published on a
consensus mask their annotations contributed to, that aggregate cannot be
unpicked. Whether a withdrawal request extends to already-computed aggregates is
a protocol question, not a software one.

## Known limitations, stated plainly

- **A single shared administrator password**, with no individual accounts and no
  meaningful audit trail. Rotating it after any personnel change is the only
  available control.
- **Access tokens do not expire** and cannot be revoked through the interface.
  Changing a surgeon's `access_token` row invalidates their old link.
- **No encryption at rest** beyond whatever the cloud provider applies to the
  disk by default. The database and the frames are plain files.
- **Backups, if enabled, are as sensitive as the disk** and must be protected
  the same way.
- **One machine, no redundancy.** Loss of the disk without a backup is loss of
  the study.
