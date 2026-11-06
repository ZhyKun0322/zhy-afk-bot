'use strict';

const fs = require('node:fs');
const path = require('node:path');

const moduleDir = path.join(__dirname, '..', 'node_modules', 'mineflayer-pathfinder');
const moduleFile = path.join(moduleDir, 'index.js');
const gotoFile = path.join(moduleDir, 'lib', 'goto.js');

function patchPillarPlacement (source) {
  if (source.includes('canPlace = placingBlock.y + 1.95 < bot.entity.position.y')) {
    return { source, changed: false, status: 'already-patched' };
  }
  const oldLine = 'canPlace = placingBlock.y + 1 < bot.entity.position.y';
  if (!source.includes(oldLine)) return { source, changed: false, status: 'pattern-not-found' };
  const newBlock = [
    'canPlace = placingBlock.y + 1.95 < bot.entity.position.y',
    '// Equip the scaffold block while rising so placement can happen as soon as',
    '// the player feet clear the block. Vanilla servers reject blocks inside the',
    '// player hitbox; the old +1 threshold often attempted placement too early.',
    "if (!canPlace && bot.heldItem?.name !== block.name && lockEquipItem.tryAcquire()) {",
    "  bot.equip(block, 'hand').catch(() => {}).then(() => lockEquipItem.release())",
    '}'
  ].join('\n');
  return { source: source.replace(oldLine, newBlock), changed: true, status: 'patched' };
}


function patchPathInvalidation (source) {
  if (source.includes('let pathRevision = 0') &&
      (source.match(/if \(revision !== pathRevision\) return/g) || []).length >= 2) {
    return { source, changed: false, status: 'already-patched' };
  }

  let patched = source;
  if (!patched.includes('let pathRevision = 0')) {
    const pathDeclaration = /^([ \t]*)let path = \[\][ \t]*$/m;
    if (!pathDeclaration.test(patched)) return { source, changed: false, status: 'pattern-not-found' };
    patched = patched.replace(pathDeclaration, "$1let path = []\n$1let pathRevision = 0");
  }

  // Increment the revision whenever the executor clears/stops the current
  // route. A path_update listener can do either synchronously.
  const resetPattern = /(function resetPath \(reason, clearStates = true\) \{\r?\n)([ \t]*)/;
  if (!/function resetPath \(reason, clearStates = true\) \{\r?\n[ \t]*pathRevision\+\+/.test(patched)) {
    if (!resetPattern.test(patched)) return { source, changed: false, status: 'pattern-not-found' };
    patched = patched.replace(resetPattern, "$1$2pathRevision++\n$2");
  }
  const stopPattern = /(function stop \(\) \{\r?\n)([ \t]*)/;
  if (!/function stop \(\) \{\r?\n[ \t]*pathRevision\+\+/.test(patched)) {
    if (!stopPattern.test(patched)) return { source, changed: false, status: 'pattern-not-found' };
    patched = patched.replace(stopPattern, "$1$2pathRevision++\n$2");
  }

  // Both fresh and continued A* searches emit path_update before installing
  // results.path. Snapshot the revision and discard the result if a listener
  // called resetPath/stop (for example by replacing the goal or movements).
  const emitPattern = /^([ \t]*)bot\.emit\(['"]path_update['"], results\)\r?\n\1path = results\.path/gm;
  const matches = patched.match(emitPattern) || [];
  if (matches.length < 2 && !patched.includes('if (revision !== pathRevision) return')) {
    return { source, changed: false, status: 'pattern-not-found' };
  }
  patched = patched.replace(emitPattern, (_match, indent) =>
    `${indent}const revision = pathRevision\n${indent}bot.emit('path_update', results)\n${indent}if (revision !== pathRevision) return\n${indent}path = results.path`);

  const changed = patched !== source;
  return { source: patched, changed, status: changed ? 'patched' : 'already-patched' };
}

function patchPartialSearch (source) {
  if (source.includes("pathUpdated = results.status !== 'timeout'")) {
    return { source, changed: false, status: 'already-patched' };
  }
  const pattern = /(bot\.emit\(['"]path_update['"], results\)\s*path = results\.path\s*astartTimedout = results\.status === ['"]partial['"]\s*)pathUpdated = true/;
  if (!pattern.test(source)) return { source, changed: false, status: 'pattern-not-found' };
  return {
    source: source.replace(pattern, "$1pathUpdated = results.status !== 'timeout'"),
    changed: true,
    status: 'patched'
  };
}

function patchGotoTimeout (source) {
  if (source.includes('a search out of time still walks its best partial path')) {
    return { source, changed: false, status: 'already-patched' };
  }
  const pattern = /(} else if \(results\.status === ['"]timeout['"]\) \{\s*)cleanup\(error\(['"]Timeout['"], ['"]Took to long to decide path to goal!['"]\)\)/;
  if (!pattern.test(source)) return { source, changed: false, status: 'pattern-not-found' };
  const replacement = "$1// a search out of time still walks its best partial path, then searches again: only an empty one fails\n    if (results.path.length === 0) cleanup(error('Timeout', 'Took to long to decide path to goal!'))";
  return { source: source.replace(pattern, replacement), changed: true, status: 'patched' };
}

function writePatchedFile (file, patcher, label) {
  if (!fs.existsSync(file)) {
    console.warn(`[Pathfinder patch] Missing ${path.relative(moduleDir, file)}; skipped ${label}.`);
    return 'not-found';
  }
  const before = fs.readFileSync(file, 'utf8');
  const result = patcher(before);
  if (result.changed) {
    fs.writeFileSync(file, result.source, 'utf8');
    console.log(`[Pathfinder patch] Applied ${label}.`);
  } else if (result.status === 'already-patched') {
    console.log(`[Pathfinder patch] ${label} already applied.`);
  } else {
    console.warn(`[Pathfinder patch] Could not match the installed source for ${label}; left that file unchanged.`);
  }
  return result.status;
}

function patchInstalledPathfinder () {
  if (!fs.existsSync(moduleDir)) {
    console.warn('[Pathfinder patch] mineflayer-pathfinder is not installed yet; skipping package patch.');
    return 'not-installed';
  }
  const pillar = writePatchedFile(moduleFile, patchPillarPlacement, 'pillar placement hitbox timing (upstream PR #400)');
  const partial = writePatchedFile(moduleFile, patchPartialSearch, 'partial-search continuation (upstream PR #399)');
  const invalidation = writePatchedFile(moduleFile, patchPathInvalidation, 'stale path_update invalidation (upstream PR #386)');
  const goto = writePatchedFile(gotoFile, patchGotoTimeout, 'goto partial-timeout handling (upstream PR #399)');
  return { pillar, invalidation, partial, goto };
}

if (require.main === module) patchInstalledPathfinder();
module.exports = { patchPillarPlacement, patchPathInvalidation, patchPartialSearch, patchGotoTimeout, patchInstalledPathfinder };
