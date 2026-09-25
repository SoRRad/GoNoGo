/**
 * Builds each surgeon's annotation queue.
 *
 *   npm run assign [-- --reset] [-- --strict]
 *
 * The rules live in src/lib/assign.ts, shared with the admin panel's "add
 * surgeon". This prints what they did.
 *
 * Surgeons who already have a queue are left alone, so adding a surgeon later
 * never disturbs anyone's in-progress work. --reset rebuilds queues for
 * surgeons who have not submitted anything yet.
 */
import { getDb } from '../src/lib/db';
import { buildQueues } from '../src/lib/assign';
import type { ResetSummary } from '../src/lib/assign';
import { ensureDataDirs } from '../src/lib/paths';

/** Above this, one video dominates a surgeon's set enough to worry about. */
const VIDEO_CONCENTRATION_WARNING = 0.3;

function printReset(reset: ResetSummary | null) {
  if (!reset) return;
  console.log(`--reset: cleared queues for ${reset.cleared} surgeon(s) with no submitted work.`);
  if (reset.kept > 0) {
    console.log(`         ${reset.kept} surgeon(s) kept their queue because they have submitted annotations.`);
  }
}

function main() {
  const reset = process.argv.includes('--reset');
  // For the real study run: refuse to build undersized queues rather than
  // quietly reducing statistical power.
  const strict = process.argv.includes('--strict');
  ensureDataDirs();
  const result = buildQueues(getDb(), { reset, strict });

  if (result.kind === 'no_surgeons') {
    console.error('No surgeons yet. Run: npm run seed:surgeons -- <csv>');
    process.exit(1);
  }
  if (result.kind === 'no_frames') {
    console.error('No study frames yet. Run: npm run seed:frames -- <dir>');
    process.exit(1);
  }

  printReset(result.reset);

  if (result.kind === 'nothing_to_do') {
    console.log('Every surgeon already has a queue. Nothing to do.');
    console.log('Use --reset to rebuild queues for surgeons who have not submitted anything.');
    return;
  }

  if (result.kind === 'refused') {
    console.log('');
    console.log('  ' + '='.repeat(72));
    console.log('  REFUSING TO BUILD: the frame pool is smaller than the protocol calls for.');
    for (const warning of result.warnings) console.log(`    - ${warning}`);
    console.log('');
    console.log('  --strict was given, so no queues were built and nothing was changed.');
    console.log('  Load more frames and run again, or drop --strict to accept reduced');
    console.log('  statistical power deliberately.');
    console.log('  ' + '='.repeat(72));
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    console.log('');
    console.log('  ' + '='.repeat(72));
    console.log('  WARNING: the frame pool is smaller than the protocol calls for.');
    console.log('  Queues were scaled down to fit. Statistical power will be reduced.');
    for (const warning of result.warnings) console.log(`    - ${warning}`);
    console.log('  Load more frames and re-run with --reset to build full-size queues.');
    console.log('  Use --strict to refuse instead of scaling down.');
    console.log('  ' + '='.repeat(72));
    console.log('');
  }

  if (result.perSurgeon === 0 && result.availableIndividual > 0) {
    console.log('  Not enough unassigned frames to give every surgeon a unique set; core frames only.');
  }

  console.log(`Built queues for ${result.built.length} surgeon(s):`);
  for (const queue of result.built) {
    console.log(
      `  ${queue.name.padEnd(24)} ${String(queue.total).padStart(4)} frames  ` +
        `(${queue.practice} practice, ${queue.core} core, ${queue.individual} individual, ` +
        `${queue.repeats} repeats)`,
    );
  }

  if (result.perSurgeon > 0) {
    console.log('');
    console.log('Source-video spread of each surgeon\'s individual frames:');
    const concentrated: string[] = [];
    for (const queue of result.built) {
      const share = queue.largestVideoShare;
      const flag = share > VIDEO_CONCENTRATION_WARNING ? '  <-- concentrated' : '';
      console.log(
        `  ${queue.name.padEnd(24)} ${String(queue.distinctVideos).padStart(3)} distinct videos  ` +
          `largest single video ${(share * 100).toFixed(0).padStart(3)}%${flag}`,
      );
      if (share > VIDEO_CONCENTRATION_WARNING) concentrated.push(queue.name);
    }
    if (concentrated.length > 0) {
      console.log('');
      console.log(`  WARNING: ${concentrated.length} surgeon(s) draw more than ` +
        `${Math.round(VIDEO_CONCENTRATION_WARNING * 100)}% of their individual frames from a single video.`);
      console.log('  That ties their results to one patient. Load frames from more videos if you can;');
      console.log('  the deal already spreads them as widely as the pool allows.');
    }
  }

  console.log('');
  console.log(`Core set: ${result.coreCount} frames spanning ${result.coreDistinctVideos} distinct source videos.`);
  console.log('');
  console.log(`${result.sharedFrames} study frames now carry independent opinions from 2 or more surgeons.`);
}

main();
