'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { installPathUpdateInvalidationGuard } = require('../pathfinder-compat');

async function run () {
  const bot = new EventEmitter();
  const firstGoal = { id: 'first' };
  const replacementGoal = { id: 'replacement' };
  const safeMovements = { id: 'safe' };
  const rescueMovements = { id: 'rescue' };

  bot.pathfinder = {
    goal: firstGoal,
    movements: safeMovements,
    path: ['old'],
    setGoalCalls: 0,
    setMovementsCalls: 0,
    setGoal (goal, dynamic) {
      this.setGoalCalls++;
      this.goal = goal;
      this.dynamic = !!dynamic;
      // Setting a goal clears the old path, as the real plugin does.
      this.path = [];
    },
    setMovements (movements) {
      this.setMovementsCalls++;
      this.movements = movements;
      this.path = [];
    }
  };

  const dispose = installPathUpdateInvalidationGuard(bot);
  bot.on('path_update', () => {
    // This simulates the bot's recovery listener replacing the current goal
    // synchronously while the pathfinder is still emitting path_update.
    bot.pathfinder.setGoal(replacementGoal, true);
  });

  bot.emit('path_update', { status: 'noPath', path: [] });
  // Simulate the old pathfinder's bug: it installs the stale result after the
  // callback returns, overwriting the callback's clear/replacement operation.
  bot.pathfinder.path = ['stale-result'];
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(bot.pathfinder.goal, replacementGoal, 'the replacement goal must remain active');
  assert.deepEqual(bot.pathfinder.path, [], 'the stale result must be invalidated after the callback');
  assert.equal(bot.pathfinder.setGoalCalls, 2, 'the latest goal should be reasserted once');

  // Movement-profile changes in a path_update listener must also restart the
  // search with the same current goal and the latest movement object.
  bot.removeAllListeners('path_update');
  bot.on('path_update', () => bot.pathfinder.setMovements(rescueMovements));
  bot.emit('path_update', { status: 'partial', path: ['partial'] });
  bot.pathfinder.path = ['stale-partial'];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bot.pathfinder.movements, rescueMovements);
  assert.equal(bot.pathfinder.goal, replacementGoal);
  assert.deepEqual(bot.pathfinder.path, []);

  dispose();
  assert.equal(bot.__pathUpdateInvalidationGuard, undefined);
  console.log('Pathfinder compatibility regression tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
