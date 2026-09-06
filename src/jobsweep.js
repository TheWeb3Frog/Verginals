'use strict';
// Which abandoned jobs are safe to finish, and in what order.
//
// A quote is driven by the buyer's own browser: GET /api/job/:id looks for the payment and, when it
// sees it, builds the commit and the reveal. Somebody who pays and closes the tab is therefore
// never finished by anybody. The money sits at a deposit address nothing will ever spend again, and
// thirty days later cleanupJobs deletes the file, taking the only record of it.
//
// Collection mints were already covered: they hold a reservation, and the reservation reaper walks
// those and finishes the paid ones. A plain inscription reserves nothing, so nothing ever looked at
// it a second time. That is the whole of the gap.
//
// The selection lives here, away from the RPC and the filesystem, because every rule in it is a
// rule about somebody's money and each one deserves to be stated once and tested.

/**
 * @param {Array} jobs        every job file on disk, parsed
 * @param {Object} o
 * @param {Map} o.paid        deposit address -> units actually received
 * @param {Set} o.processing  job ids a request is driving right now
 * @param {number} o.maxAttempts
 * @param {number} o.limit    how many to hand back
 * @returns {Array} jobs to drive, least-tried first
 */
function pickAbandoned(jobs, { paid, processing, maxAttempts = 12, limit = 3 }) {
  const ready = jobs.filter((j) => {
    if (!j || !j.id || !j.depositAddress) return false;
    if (j.status === 'done' || j.status === 'error') return false;

    // Mints are not ours. They hold a reservation and the reaper finishes them there, one per
    // cycle, because every parented reveal spends the single collection parent tip and a burst of
    // them rebuilds the long unconfirmed chain that makes reveals fail in the first place. Picking
    // them up here as well would race that, for no gain.
    if (j.mint) return false;

    // NOTHING PAST THE COMMIT. drivePayout rebuilds the funding transaction from the deposit
    // outputs unconditionally: run it again on a job whose commit already spent them and it either
    // throws or signs something different. A job in that state is stuck in a way this sweep must
    // not pretend to fix.
    if (j.splitTxid || j.revealTxid) return false;

    if (processing && processing.has(j.id)) return false;
    if ((j.driveAttempts || 0) >= maxAttempts) return false;

    // Paid IN FULL. A partial payment is not a job to finish, it is a job whose buyer stopped
    // halfway, and building a commit against it produces outputs the plan cannot cover.
    const got = (paid && paid.get(j.depositAddress)) || 0;
    return Number.isFinite(j.total) && j.total > 0 && got >= j.total;
  });

  // Least-tried first, then oldest, so one job that keeps failing cannot starve the ones behind it
  // and nobody waits longer for having paid earlier.
  ready.sort((a, b) => (a.driveAttempts || 0) - (b.driveAttempts || 0)
    || (a.createdAt || 0) - (b.createdAt || 0));
  return ready.slice(0, limit);
}

module.exports = { pickAbandoned };
