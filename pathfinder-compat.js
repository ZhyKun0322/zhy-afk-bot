'use strict';

/**
 * Backport of the path_update invalidation guard discussed upstream in
 * PrismarineJS/mineflayer-pathfinder#386.
 *
 * Pathfinder emits `path_update` synchronously from inside its movement loop.
 * This bot has listeners which may replace the goal or movement profile from
 * those callbacks (for example, stuck recovery). Older pathfinder builds can
 * then install the just-computed, now-stale path after the callback returns.
 * Re-asserting the most recent goal on the next microtask makes that invalidation
 * win after the old monitorMovement stack has finished installing its result.
 *
 * The patch is deliberately runtime-only: no unsupported fork or modified
 * node_modules is required, and the original methods are restored on `end`.
 */
function installPathUpdateInvalidationGuard (bot) {
  if (!bot || !bot.pathfinder || typeof bot.emit !== 'function') return () => {};
  if (bot.__pathUpdateInvalidationGuard) return bot.__pathUpdateInvalidationGuard.dispose;

  const pf = bot.pathfinder;
  const originalEmit = bot.emit;
  const originalSetGoal = typeof pf.setGoal === 'function' ? pf.setGoal : null;
  const originalSetMovements = typeof pf.setMovements === 'function' ? pf.setMovements : null;
  if (!originalSetGoal || !originalSetMovements) return () => {};

  let revision = 0;
  let dispatchDepth = 0;
  let disposed = false;
  let latestGoal = { goal: pf.goal || null, dynamic: false };
  let latestMovements = pf.movements;

  pf.setGoal = function guardedSetGoal (goal, dynamic = false) {
    revision++;
    latestGoal = { goal, dynamic: !!dynamic };
    return originalSetGoal.call(this, goal, dynamic);
  };

  pf.setMovements = function guardedSetMovements (movements) {
    revision++;
    latestMovements = movements;
    return originalSetMovements.call(this, movements);
  };

  bot.emit = function guardedEmit (eventName, ...args) {
    if (eventName !== 'path_update') return originalEmit.call(this, eventName, ...args);

    const beforeRevision = revision;
    dispatchDepth++;
    try {
      return originalEmit.call(this, eventName, ...args);
    } finally {
      dispatchDepth--;
      if (dispatchDepth === 0 && revision !== beforeRevision) {
        try {
          if (typeof bot.clearControlStates === 'function') bot.clearControlStates();
        } catch (_) {}
        const scheduledRevision = revision;
        const scheduledGoal = latestGoal;
        const scheduledMovements = latestMovements;

        queueMicrotask(() => {
          if (disposed || revision !== scheduledRevision) return;
          try {
            // Reapply movements first because setMovements invalidates the
            // search context, then reassert the latest goal to start a fresh A*.
            if (pf.movements !== scheduledMovements) {
              originalSetMovements.call(pf, scheduledMovements);
            }
            if (latestGoal === scheduledGoal) {
              originalSetGoal.call(pf, scheduledGoal.goal, scheduledGoal.dynamic);
            }
          } catch (error) {
            try {
              bot.emit('pathfinder_compat_error', error);
            } catch (_) {}
          }
        });
      }
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (bot.emit !== originalEmit) bot.emit = originalEmit;
    if (pf.setGoal !== originalSetGoal) pf.setGoal = originalSetGoal;
    if (pf.setMovements !== originalSetMovements) pf.setMovements = originalSetMovements;
    delete bot.__pathUpdateInvalidationGuard;
  };

  bot.__pathUpdateInvalidationGuard = { dispose };
  bot.once('end', dispose);
  return dispose;
}

module.exports = { installPathUpdateInvalidationGuard };
