'use strict';

const assert = require('node:assert/strict');
const { patchPillarPlacement, patchPathInvalidation, patchPartialSearch, patchGotoTimeout } = require('../scripts/patch-pathfinder');

const pillarFixture = [
  'function place (placingBlock, bot, block, lockEquipItem) {',
  '  let canPlace = true',
  '  if (placingBlock.jump) {',
  "    bot.setControlState('jump', true)",
  '    canPlace = placingBlock.y + 1 < bot.entity.position.y',
  '  }',
  '  if (canPlace) return true',
  '}'
].join('\n');
const firstPillar = patchPillarPlacement(pillarFixture);
assert.equal(firstPillar.changed, true);
assert.match(firstPillar.source, /placingBlock\.y \+ 1\.95/);
assert.match(firstPillar.source, /lockEquipItem\.tryAcquire\(\)/);
assert.equal(patchPillarPlacement(firstPillar.source).status, 'already-patched');

const invalidationFixture = [
  'let path = []',
  'function resetPath (reason, clearStates = true) {',
  '  path = []',
  '}',
  'function stop () {',
  '  path = []',
  '}',
  'function monitorMovement () {',
  "  bot.emit('path_update', results)",
  '  path = results.path',
  "  bot.emit('path_update', results)",
  '  path = results.path',
  '}'
].join('\n');
const invalidation = patchPathInvalidation(invalidationFixture);
assert.equal(invalidation.changed, true);
assert.match(invalidation.source, /let pathRevision = 0/);
assert.equal((invalidation.source.match(/pathRevision\+\+/g) || []).length, 2);
assert.equal((invalidation.source.match(/if \(revision !== pathRevision\) return/g) || []).length, 2);
assert.equal(patchPathInvalidation(invalidation.source).status, 'already-patched');

const partialFixture = [
  "bot.emit('path_update', results)",
  'path = results.path',
  "astartTimedout = results.status === 'partial'",
  'pathUpdated = true'
].join('\n');
const partial = patchPartialSearch(partialFixture);
assert.equal(partial.changed, true);
assert.match(partial.source, /pathUpdated = results\.status !== 'timeout'/);
assert.equal(patchPartialSearch(partial.source).status, 'already-patched');

const gotoFixture = [
  "} else if (results.status === 'timeout') {",
  "  cleanup(error('Timeout', 'Took to long to decide path to goal!'))",
  "}"
].join('\n');
const goto = patchGotoTimeout(gotoFixture);
assert.equal(goto.changed, true);
assert.match(goto.source, /if \(results\.path\.length === 0\)/);
assert.equal(patchGotoTimeout(goto.source).status, 'already-patched');
// Exercise the same patch order used by postinstall against a compact fixture
// containing both search paths and the scaffold placement branch.
let completeRootFixture = [
  'let path = []',
  'function resetPath (reason, clearStates = true) {',
  '  path = []',
  '}',
  'function stop () {',
  '  path = []',
  '}',
  'function monitorMovement () {',
  '  if (freshSearch) {',
  "    bot.emit('path_update', results)",
  '    path = results.path',
  "    astartTimedout = results.status === 'partial'",
  '  } else {',
  "    bot.emit('path_update', results)",
  '    path = results.path',
  "    astartTimedout = results.status === 'partial'",
  '    pathUpdated = true',
  '  }',
  '}',
  'function place (placingBlock, bot, block, lockEquipItem) {',
  '  canPlace = placingBlock.y + 1 < bot.entity.position.y',
  '}'
].join('\n');
completeRootFixture = patchPillarPlacement(completeRootFixture).source;
completeRootFixture = patchPartialSearch(completeRootFixture).source;
completeRootFixture = patchPathInvalidation(completeRootFixture).source;
assert.match(completeRootFixture, /pathUpdated = results\.status !== 'timeout'/);
assert.equal((completeRootFixture.match(/if \(revision !== pathRevision\) return/g) || []).length, 2);
assert.match(completeRootFixture, /placingBlock\.y \+ 1\.95/);

console.log('Pathfinder package patch tests passed.');
