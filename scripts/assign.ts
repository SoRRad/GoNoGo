/**
 * Builds each surgeon's annotation queue.
 *
 *   npm run assign [-- --reset]
 *
 * Per surgeon: every practice frame first, then 50 core frames that every
 * surgeon sees, then 70 frames unique to them, with ~10% of the non-practice
 * frames repeated at least 30 positions later. Order is shuffled independently
 * per surgeon; practice frames stay first.
 *
 * Surgeons who already have a queue are left alone, so adding a surgeon later
 * never disturbs anyone's in-progress work. --reset rebuilds queues for
 * surgeons who have not submitted anything yet.
 */
import { getDb } from '../src/lib/db';
import type { Frame, Surgeon } from '../src/lib/db';
import { ensureDataDirs } from '../src/lib/paths';
import {
  CORE_SELECTION_SEED,
  CORE_TARGET,
  INDIVIDUAL_TARGET,
  buildQueue,
  countDistinctVideos,
  dealIndividualSets,
  deriveEstablishedCoreSet,
  frameIdsAlreadyIndividual,
  selectCoreSet,
} from '../src/lib/queue';

/** Above this, one video dominates a surgeon's set enough to worry about. */
const VIDEO_CONCENTRATION_WARNING = 0.3;

function main() {
  const reset = process.argv.includes('--reset');
  ensureDataDirs();
  const db = getDb();

  const surgeons = db.prepare('SELECT * FROM surgeons ORDER BY id').all() as Surgeon[];
  if (surgeons.length === 0) {
    console.error('No surgeons yet. Run: npm run seed:surgeons -- <csv>');
    process.exit(1);
  }

  const practiceFrames = db
    .prepare('SELECT * FROM frames WHERE is_practice = 1 ORDER BY filename')
    .all() as Frame[];
  const studyFrames = db.prepare('SELECT * FROM frames WHERE is_practice = 0 ORDER BY id').all() as Frame[];

  if (studyFrames.length === 0) {
    console.error('No study frames yet. Run: npm run seed:frames -- <dir>');
    process.exit(1);
  }

  if (reset) {
    const clearable = surgeons.filter((surgeon) => {
      const submitted = db
        .prepare(
          `SELECT COUNT(*) AS n FROM annotations WHERE surgeon_id = ? AND submitted_at IS NOT NULL`,
        )
        .get(surgeon.id) as { n: number };
      return submitted.n === 0;
    });
    const clear = db.transaction(() => {
      for (const surgeon of clearable) {
        db.prepare('DELETE FROM assignments WHERE surgeon_id = ?').run(surgeon.id);
      }
    });
    clear();
    console.log(`--reset: cleared queues for ${clearable.length} surgeon(s) with no submitted work.`);
    const protectedCount = surgeons.length - clearable.length;
    if (protectedCount > 0) {
      console.log(`         ${protectedCount} surgeon(s) kept their queue because they have submitted annotations.`);
    }
  }

  const pending = surgeons.filter((surgeon) => {
    const existing = db
      .prepare('SELECT COUNT(*) AS n FROM assignments WHERE surgeon_id = ?')
      .get(surgeon.id) as { n: number };
    return existing.n === 0;
  });

  if (pending.length === 0) {
    console.log('Every surgeon already has a queue. Nothing to do.');
    console.log('Use --reset to rebuild queues for surgeons who have not submitted anything.');
    return;
  }

  // Reuse the core set already in play, so a late-joining surgeon still gets
  // exactly the frames everyone else was given.
  const established = deriveEstablishedCoreSet(db);
  const coreTarget = Math.min(CORE_TARGET, studyFrames.length);
  const coreIds = established.length > 0 ? established : selectCoreSet(studyFrames, coreTarget);
  const coreSet = new Set(coreIds);

  const taken = frameIdsAlreadyIndividual(db, coreSet);
  const availableIndividual = studyFrames.filter((frame) => !coreSet.has(frame.id) && !taken.has(frame.id));

  const perSurgeon = Math.min(INDIVIDUAL_TARGET, Math.floor(availableIndividual.length / pending.length));

  const warnings: string[] = [];
  if (practiceFrames.length !== 5) {
    warnings.push(`practice frames: ${practiceFrames.length} (protocol expects 5)`);
  }
  if (coreIds.length < CORE_TARGET) {
    warnings.push(`core frames: ${coreIds.length} (protocol expects ${CORE_TARGET})`);
  }
  if (perSurgeon < INDIVIDUAL_TARGET) {
    const needed = coreIds.length + INDIVIDUAL_TARGET * pending.length + practiceFrames.length;
    warnings.push(
      `individual frames: ${perSurgeon} each (protocol expects ${INDIVIDUAL_TARGET}). ` +
        `${studyFrames.length + practiceFrames.length} frames are loaded; ${needed} are needed for ` +
        `${pending.length} surgeon(s) at full size.`,
    );
  }

  if (warnings.length > 0) {
    console.log('');
    console.log('  ' + '='.repeat(72));
    console.log('  WARNING: the frame pool is smaller than the protocol calls for.');
    console.log('  Queues were scaled down to fit. Statistical power will be reduced.');
    for (const warning of warnings) console.log(`    - ${warning}`);
    console.log('  Load more frames and re-run with --reset to build full-size queues.');
    console.log('  ' + '='.repeat(72));
    console.log('');
  }

  if (perSurgeon === 0 && availableIndividual.length > 0) {
    console.log('  Not enough unassigned frames to give every surgeon a unique set; core frames only.');
  }

  // Spread each surgeon's unique frames across videos rather than handing out
  // contiguous blocks, which would tie surgeon identity to patient identity.
  const deal = dealIndividualSets(availableIndividual, pending.length, perSurgeon, CORE_SELECTION_SEED ^ 0x9e37);

  const insertAssignment = db.prepare(
    `INSERT INTO assignments (surgeon_id, frame_id, display_order, is_repeat, repeat_of_assignment_id)
     VALUES (?, ?, ?, ?, NULL)`,
  );
  const linkRepeat = db.prepare('UPDATE assignments SET repeat_of_assignment_id = ? WHERE id = ?');

  const summaries: string[] = [];

  const run = db.transaction(() => {
    for (const [surgeonIndex, surgeon] of pending.entries()) {
      const individual = deal.sets[surgeonIndex];

      const queue = buildQueue(
        practiceFrames.map((frame) => frame.id),
        coreIds,
        individual,
        surgeon.id * 2654435761,
      );

      // Insert in display order, then resolve repeat links now that ids exist.
      const idBySequenceIndex = new Map<number, number>();
      const repeatsToLink: { assignmentId: number; sourceSequenceIndex: number }[] = [];

      queue.entries.forEach((entry, displayOrder) => {
        const info = insertAssignment.run(
          surgeon.id,
          entry.frameId,
          displayOrder,
          entry.isRepeat ? 1 : 0,
        );
        const assignmentId = Number(info.lastInsertRowid);
        if (!entry.isRepeat && entry.repeatOfSequenceIndex !== null) {
          idBySequenceIndex.set(entry.repeatOfSequenceIndex, assignmentId);
        }
        if (entry.isRepeat && entry.repeatOfSequenceIndex !== null) {
          repeatsToLink.push({ assignmentId, sourceSequenceIndex: entry.repeatOfSequenceIndex });
        }
      });

      for (const repeat of repeatsToLink) {
        const originalId = idBySequenceIndex.get(repeat.sourceSequenceIndex);
        if (originalId) linkRepeat.run(originalId, repeat.assignmentId);
      }

      summaries.push(
        `  ${surgeon.name.padEnd(24)} ${String(queue.entries.length).padStart(4)} frames  ` +
          `(${queue.practiceCount} practice, ${queue.coreCount} core, ${queue.individualCount} individual, ` +
          `${queue.repeatCount} repeats)`,
      );
    }
  });
  run();

  console.log(`Built queues for ${pending.length} surgeon(s):`);
  for (const summary of summaries) console.log(summary);

  if (perSurgeon > 0) {
    console.log('');
    console.log('Source-video spread of each surgeon\'s individual frames:');
    const concentrated: string[] = [];
    for (const [surgeonIndex, surgeon] of pending.entries()) {
      const videos = deal.videosPerSurgeon[surgeonIndex];
      const share = deal.maxVideoShare[surgeonIndex];
      const flag = share > VIDEO_CONCENTRATION_WARNING ? '  <-- concentrated' : '';
      console.log(
        `  ${surgeon.name.padEnd(24)} ${String(videos).padStart(3)} distinct videos  ` +
          `largest single video ${(share * 100).toFixed(0).padStart(3)}%${flag}`,
      );
      if (share > VIDEO_CONCENTRATION_WARNING) concentrated.push(surgeon.name);
    }
    if (concentrated.length > 0) {
      console.log('');
      console.log(`  WARNING: ${concentrated.length} surgeon(s) draw more than ` +
        `${Math.round(VIDEO_CONCENTRATION_WARNING * 100)}% of their individual frames from a single video.`);
      console.log('  That ties their results to one patient. Load frames from more videos if you can;');
      console.log('  the deal already spreads them as widely as the pool allows.');
    }
  }

  const coreFrames = studyFrames.filter((frame) => coreSet.has(frame.id));
  console.log('');
  console.log(
    `Core set: ${coreIds.length} frames spanning ${countDistinctVideos(coreFrames)} distinct source videos.`,
  );

  const overlap = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT a.frame_id FROM assignments a JOIN frames f ON f.id = a.frame_id
          WHERE f.is_practice = 0
          GROUP BY a.frame_id HAVING COUNT(DISTINCT a.surgeon_id) >= 2)`,
    )
    .get() as { n: number };
  console.log('');
  console.log(`${overlap.n} study frames now carry independent opinions from 2 or more surgeons.`);
}

main();
