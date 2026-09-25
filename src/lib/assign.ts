/**
 * Builds surgeons' annotation queues. Shared by `npm run assign` and the admin
 * panel's "add surgeon", so both deal frames by exactly the same rules.
 *
 * Per surgeon: every practice frame first, then 50 core frames that every
 * surgeon sees, then 70 frames unique to them, with ~10% of the non-practice
 * frames repeated at least 30 positions later. Order is shuffled independently
 * per surgeon; practice frames stay first.
 *
 * Surgeons who already have a queue are left alone, so adding a surgeon later
 * never disturbs anyone's in-progress work.
 */
import type Database from 'better-sqlite3';
import type { Frame, Surgeon } from './db';
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
} from './queue';

export interface BuildQueuesOptions {
  /** Clear the queues of surgeons with no submitted work first, then rebuild them. */
  reset?: boolean;
  /** Refuse, changing nothing, if any part of the protocol would be short. */
  strict?: boolean;
  /**
   * Refuse only if a surgeon would receive fewer than the protocol's unique
   * frames. For adding one surgeon to a running study, where a study-wide
   * shortfall (a removed core frame, say) is not that surgeon's to fix.
   */
  requireFullIndividual?: boolean;
  /** Limit the build to these surgeons. Surgeons who already have a queue are still skipped. */
  surgeonIds?: number[];
}

export interface BuiltQueue {
  surgeonId: number;
  name: string;
  total: number;
  practice: number;
  core: number;
  individual: number;
  repeats: number;
  distinctVideos: number;
  largestVideoShare: number;
}

export interface ResetSummary {
  cleared: number;
  kept: number;
}

export type BuildQueuesResult =
  | { kind: 'no_surgeons' }
  | { kind: 'no_frames' }
  | { kind: 'nothing_to_do'; reset: ResetSummary | null }
  | {
      kind: 'refused';
      reset: ResetSummary | null;
      warnings: string[];
      /** Unique frames each pending surgeon could have been given. */
      perSurgeon: number;
    }
  | {
      kind: 'built';
      reset: ResetSummary | null;
      warnings: string[];
      perSurgeon: number;
      availableIndividual: number;
      built: BuiltQueue[];
      coreCount: number;
      coreDistinctVideos: number;
      /** Study frames that now carry opinions from two or more surgeons. */
      sharedFrames: number;
    };

export function buildQueues(db: Database.Database, options: BuildQueuesOptions = {}): BuildQueuesResult {
  const { reset = false, strict = false, requireFullIndividual = false, surgeonIds } = options;

  const surgeons = db.prepare('SELECT * FROM surgeons ORDER BY id').all() as Surgeon[];
  if (surgeons.length === 0) return { kind: 'no_surgeons' };

  const practiceFrames = db
    .prepare('SELECT * FROM frames WHERE is_practice = 1 ORDER BY filename')
    .all() as Frame[];
  const studyFrames = db.prepare('SELECT * FROM frames WHERE is_practice = 0 ORDER BY id').all() as Frame[];
  if (studyFrames.length === 0) return { kind: 'no_frames' };

  let resetSummary: ResetSummary | null = null;
  if (reset) {
    const clearable = surgeons.filter((surgeon) => {
      const submitted = db
        .prepare('SELECT COUNT(*) AS n FROM annotations WHERE surgeon_id = ? AND submitted_at IS NOT NULL')
        .get(surgeon.id) as { n: number };
      return submitted.n === 0;
    });
    db.transaction(() => {
      for (const surgeon of clearable) {
        db.prepare('DELETE FROM assignments WHERE surgeon_id = ?').run(surgeon.id);
      }
    })();
    resetSummary = { cleared: clearable.length, kept: surgeons.length - clearable.length };
  }

  const wanted = surgeonIds ? new Set(surgeonIds) : null;
  const pending = surgeons.filter((surgeon) => {
    if (wanted && !wanted.has(surgeon.id)) return false;
    const existing = db
      .prepare('SELECT COUNT(*) AS n FROM assignments WHERE surgeon_id = ?')
      .get(surgeon.id) as { n: number };
    return existing.n === 0;
  });
  if (pending.length === 0) return { kind: 'nothing_to_do', reset: resetSummary };

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
  const individualShort = perSurgeon < INDIVIDUAL_TARGET;
  if (individualShort) {
    const needed = coreIds.length + INDIVIDUAL_TARGET * pending.length + practiceFrames.length;
    warnings.push(
      `individual frames: ${perSurgeon} each (protocol expects ${INDIVIDUAL_TARGET}). ` +
        `${studyFrames.length + practiceFrames.length} frames are loaded; ${needed} are needed for ` +
        `${pending.length} surgeon(s) at full size.`,
    );
  }

  if ((strict && warnings.length > 0) || (requireFullIndividual && individualShort)) {
    return { kind: 'refused', reset: resetSummary, warnings, perSurgeon };
  }

  // Spread each surgeon's unique frames across videos rather than handing out
  // contiguous blocks, which would tie surgeon identity to patient identity.
  const deal = dealIndividualSets(availableIndividual, pending.length, perSurgeon, CORE_SELECTION_SEED ^ 0x9e37);

  const insertAssignment = db.prepare(
    `INSERT INTO assignments (surgeon_id, frame_id, display_order, is_repeat, repeat_of_assignment_id)
     VALUES (?, ?, ?, ?, NULL)`,
  );
  const linkRepeat = db.prepare('UPDATE assignments SET repeat_of_assignment_id = ? WHERE id = ?');
  const built: BuiltQueue[] = [];
  const markCore = db.prepare('UPDATE frames SET is_core = 1 WHERE id = ? AND is_core = 0');

  db.transaction(() => {
    // Record the core set the first time it is dealt, so it stays fixed no
    // matter which surgeons come and go afterwards.
    for (const frameId of coreIds) markCore.run(frameId);

    for (const [surgeonIndex, surgeon] of pending.entries()) {
      const queue = buildQueue(
        practiceFrames.map((frame) => frame.id),
        coreIds,
        deal.sets[surgeonIndex],
        surgeon.id * 2654435761,
      );

      // Insert in display order, then resolve repeat links now that ids exist.
      const idBySequenceIndex = new Map<number, number>();
      const repeatsToLink: { assignmentId: number; sourceSequenceIndex: number }[] = [];
      queue.entries.forEach((entry, displayOrder) => {
        const info = insertAssignment.run(surgeon.id, entry.frameId, displayOrder, entry.isRepeat ? 1 : 0);
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

      built.push({
        surgeonId: surgeon.id,
        name: surgeon.name,
        total: queue.entries.length,
        practice: queue.practiceCount,
        core: queue.coreCount,
        individual: queue.individualCount,
        repeats: queue.repeatCount,
        distinctVideos: deal.videosPerSurgeon[surgeonIndex],
        largestVideoShare: deal.maxVideoShare[surgeonIndex],
      });
    }
  })();

  const coreFrames = studyFrames.filter((frame) => coreSet.has(frame.id));
  const shared = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT a.frame_id FROM assignments a JOIN frames f ON f.id = a.frame_id
          WHERE f.is_practice = 0
          GROUP BY a.frame_id HAVING COUNT(DISTINCT a.surgeon_id) >= 2)`,
    )
    .get() as { n: number };

  return {
    kind: 'built',
    reset: resetSummary,
    warnings,
    perSurgeon,
    availableIndividual: availableIndividual.length,
    built,
    coreCount: coreIds.length,
    coreDistinctVideos: countDistinctVideos(coreFrames),
    sharedFrames: shared.n,
  };
}
