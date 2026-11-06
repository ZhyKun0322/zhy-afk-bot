'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../commands'), 'utf8');

assert.match(source, /const BED_SEARCH_RADIUS = 48/);
assert.match(source, /function worldTimeOfDay\(\)/);
assert.match(source, /function sleepStatusText\(\)/);
assert.match(source, /case "sleepstatus"/);
assert.match(source, /nav\.goto\(bed\.position\.x, bed\.position\.y, bed\.position\.z, 1\)/,
  'bed navigation must use the shared stuck-recovery controller');
assert.match(source, /function pauseModeForSleep\(\)/,
  'sleep must be able to pause an active follow/kill/wood/PvP task');
assert.match(source, /function resumeModeAfterSleep\(\)/,
  'the paused task must resume after waking');
assert.doesNotMatch(source, /Do not interrupt active combat, harvesting, or player-follow commands/,
  'the old mode gate prevented auto-sleep while commands were active');

console.log('Automatic sleep contract regression tests passed.');

const pathfinderSource = fs.readFileSync(require.resolve('../combatUtils'), 'utf8');
assert.match(pathfinderSource, /thinkTimeout \+ 5000/);
assert.doesNotMatch(pathfinderSource, /setTimeout\(tryNextCandidate, 6500\)/,
  'escape candidate timer must not abort A* before thinkTimeout');
assert.match(pathfinderSource, /recovery_no_safe_tile_retry/);
