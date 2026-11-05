"use strict";

const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

// ============================================================
// ENTITY HELPERS
// ============================================================

// Mobs that are always worth killing. (Endermen, wardens, piglins, wolves,
// iron golems etc. are left out on purpose - attacking them starts trouble.)
const HOSTILE = new Set([
  "zombie", "zombie_villager", "husk", "drowned",
  "skeleton", "stray", "bogged", "wither_skeleton",
  "creeper", "spider", "cave_spider", "witch",
  "pillager", "vindicator", "evoker", "ravager", "vex",
  "phantom", "slime", "magma_cube", "silverfish", "endermite",
  "blaze", "ghast", "guardian", "elder_guardian", "shulker",
  "piglin_brute", "hoglin", "zoglin",
]);

function isHostile(e) {
  return !!e && e.type !== "player" && HOSTILE.has(e.name);
}

// Geyser puts a "." in front of Bedrock usernames (".Zhykun").
// Comparing without it lets "!pvp Zhykun" and "!pvp .Zhykun" both work.
function normalizeName(name) {
  return String(name || "").replace(/^\./, "").toLowerCase();
}

// Returns the bot.players record (it has .entity when the player is in range)
function findPlayer(bot, wanted) {
  if (!wanted) return null;
  if (bot.players[wanted] && bot.players[wanted].username !== bot.username) return bot.players[wanted];
  const w = normalizeName(wanted);
  if (!w) return null;
  let partial = null;
  for (const p of Object.values(bot.players)) {
    if (p.username === bot.username) continue;
    const n = normalizeName(p.username);
    if (n === w) return p;
    if (!partial && w.length >= 3 && n.startsWith(w)) partial = p;
  }
  return partial;
}

// ============================================================
// WEAPONS + ATTACK COOLDOWN (1.9+ combat)
// ============================================================
const MATERIAL_RANK = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 };
const AXE_SPEED = { wooden: 0.8, stone: 0.8, iron: 0.9, golden: 1.0, diamond: 1.0, netherite: 1.0 };

function parseWeapon(item) {
  if (!item) return null;
  const m = /^(wooden|stone|golden|iron|diamond|netherite)_(sword|axe)$/.exec(item.name);
  if (!m) return null;
  return { kind: m[2], material: m[1], rank: MATERIAL_RANK[m[1]] };
}

// Time (ms) until the attack bar is full again after a swing
function cooldownMs(item) {
  if (!item) return 250; // fist
  const w = parseWeapon(item);
  if (w) return w.kind === "sword" ? 625 : Math.round(1000 / AXE_SPEED[w.material]);
  if (/_pickaxe$/.test(item.name)) return 833;
  if (/_shovel$/.test(item.name)) return 1000;
  return 250;
}

function bestWeapon(bot, prefer) {
  let best = null;
  let bestScore = -1;
  for (const it of bot.inventory.items()) {
    const w = parseWeapon(it);
    if (!w) continue;
    const score = w.rank + (w.kind === prefer ? 10 : 0);
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return best;
}

function findBow(bot) {
  return bot.inventory.items().find((i) => i.name === "bow") || null;
}

function countArrows(bot) {
  return bot.inventory
    .items()
    .filter((i) => /^(arrow|tipped_arrow|spectral_arrow)$/.test(i.name))
    .reduce((n, i) => n + i.count, 0);
}

// ============================================================
// BOW BALLISTICS
// Arrow physics per tick: pos += vel; vel *= 0.99; vel.y -= 0.05
// ============================================================
const ARROW_SPEED = 3.0; // fully drawn bow, blocks per tick

// Height (relative to launch) and flight time of an arrow when it has travelled h blocks horizontally
function flightAt(pitch, h, speed) {
  let x = 0;
  let y = 0;
  let vx = speed * Math.cos(pitch);
  let vy = speed * Math.sin(pitch);
  for (let t = 1; t <= 200; t++) {
    const px = x;
    const py = y;
    x += vx;
    y += vy;
    if (x >= h) {
      const f = (h - px) / (x - px);
      return { y: py + (y - py) * f, ticks: t - 1 + f };
    }
    vx *= 0.99;
    vy = vy * 0.99 - 0.05;
    if (vx <= 0.001) return null;
  }
  return null;
}

// Lowest pitch (radians, + = up) that makes the arrow pass through (h, dy)
function solvePitch(h, dy, speed = ARROW_SPEED) {
  let prev = null;
  for (let p = -1.0; p <= 0.9; p += 0.003) {
    const r = flightAt(p, h, speed);
    if (!r) continue;
    if (r.y >= dy) {
      if (!prev) return { pitch: p, ticks: r.ticks };
      const f = (dy - prev.y) / (r.y - prev.y);
      return { pitch: prev.pitch + (p - prev.pitch) * f, ticks: prev.ticks + (r.ticks - prev.ticks) * f };
    }
    prev = { pitch: p, y: r.y, ticks: r.ticks };
  }
  return null; // out of range
}

// origin: arrow launch point. targetPos: target feet. targetVel: {x,z} blocks/tick.
// Returns {yaw, pitch, ticks} or null when the target is out of range.
function computeAim(origin, targetPos, targetVel, aimHeight = 1.0, latencyTicks = 2) {
  let ticks = 0;
  let result = null;
  for (let i = 0; i < 4; i++) {
    const lead = ticks + latencyTicks;
    const px = targetPos.x + targetVel.x * lead;
    const pz = targetPos.z + targetVel.z * lead;
    const dx = px - origin.x;
    const dz = pz - origin.z;
    const h = Math.hypot(dx, dz);
    const dy = targetPos.y + aimHeight - origin.y;
    const sol = solvePitch(h, dy);
    if (!sol) return null;
    ticks = sol.ticks;
    result = { yaw: Math.atan2(-dx, -dz), pitch: sol.pitch, ticks: sol.ticks };
  }
  return result;
}

// Estimates horizontal target velocity (blocks/tick) from position samples
function createVelocityTracker() {
  let hist = [];
  return {
    push(pos) {
      hist.push({ t: Date.now(), x: pos.x, z: pos.z });
      if (hist.length > 12) hist.shift();
    },
    reset() {
      hist = [];
    },
    get() {
      if (hist.length < 4) return { x: 0, z: 0 };
      const a = hist[0];
      const b = hist[hist.length - 1];
      const dt = (b.t - a.t) / 50;
      if (dt <= 0) return { x: 0, z: 0 };
      let vx = (b.x - a.x) / dt;
      let vz = (b.z - a.z) / dt;
      const mag = Math.hypot(vx, vz);
      if (mag > 0.4) {
        vx = (vx / mag) * 0.4;
        vz = (vz / mag) * 0.4;
      }
      return { x: vx, z: vz };
    },
  };
}

function hasLineOfSight(bot, target) {
  try {
    const from = bot.entity.position.offset(0, bot.entity.height, 0);
    const to = target.position.offset(0, (target.height || 1.8) * 0.6, 0);
    const delta = to.minus(from);
    const dist = delta.norm();
    if (dist < 0.5) return true;
    const hit = bot.world.raycast(from, delta.normalize(), dist);
    return !hit;
  } catch (e) {
    return true; // can't tell - don't block the shot
  }
}

// A clear eye-ray is not enough for melee: the bot can see over a slab or
// fence while its feet are still blocked. Only use manual close-range steering
// when the two-block walking corridor is clear. Otherwise leave movement to
// the pathfinder so it can route around the obstruction.
function hasClearMeleeLane(bot, target, maxDistance = 2.2) {
  try {
    if (!bot.entity || !target || !target.position || typeof bot.blockAt !== "function") return false;
    const origin = bot.entity.position;
    const dx = target.position.x - origin.x;
    const dz = target.position.z - origin.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal < 0.65) return true;
    const ux = dx / horizontal;
    const uz = dz / horizontal;
    const limit = Math.min(maxDistance, horizontal - 0.35);
    for (let d = 0.45; d <= limit; d += 0.3) {
      for (const y of [0.1, 1.0]) {
        const probe = origin.offset(ux * d, y, uz * d);
        const block = bot.blockAt(probe, false);
        // Unknown/unloaded space is not safe for direct steering.
        if (!block) return false;
        if (block.boundingBox === "block") return false;
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
function setCtl(bot, name, value) {
  if (bot.controlState[name] !== value) bot.setControlState(name, value);
}

function look(bot, yaw, pitch) {
  try {
    Promise.resolve(bot.look(yaw, pitch, true)).catch(() => {});
  } catch (e) {}
}

function lookAtPoint(bot, point) {
  const eye = bot.entity.position.offset(0, bot.entity.height, 0);
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  look(bot, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
}

// Distance from the bot's eyes to the target's hitbox (approximate)
function reachDistance(bot, target) {
  const eye = bot.entity.position.offset(0, bot.entity.height, 0);
  const tp = target.position;
  const h = target.height || 1.8;
  const w = (target.width || 0.6) / 2;
  const cy = Math.min(Math.max(eye.y, tp.y), tp.y + h);
  const hd = Math.max(0, Math.hypot(tp.x - eye.x, tp.z - eye.z) - w * 1.2);
  return Math.hypot(hd, cy - eye.y);
}

// Thin wrapper so several features can share the pathfinder without
// re-issuing the same goal every tick.
function createNav(bot) {
  let key = null;
  let followState = null;
  let gotoState = null;
  let activeGoal = null;
  let lastEscapeAt = 0;
  let escapeCount = 0;
  let escapeInProgress = false;
  let recoverySwappingGoal = false;
  let cancelGoalPromise = null;
  let lastProgressPosition = null;
  let lastProgressAt = Date.now();
  let missingGoalSince = 0;
  let busyActionSince = 0;

  function followGoal(entity, range) {
    const goal = new goals.GoalFollow(entity, range);
    const originalIsEnd = goal.isEnd.bind(goal);
    // GoalFollow normally uses only Euclidean distance. That lets it report
    // "arrived" when the player is close on the other side of a house wall.
    // Require both a body-height corridor and eye line-of-sight from the
    // candidate node before accepting the node as the follow destination.
    goal.isEnd = (node) => {
      if (!originalIsEnd(node) || !entity.position || !bot.world) return false;
      try {
        const candidateFeet = new Vec3(node.x + 0.5, node.y, node.z + 0.5);
        const targetFeet = entity.position;
        const fromBody = candidateFeet.offset(0, 0.35, 0);
        const toBody = targetFeet.offset(0, 0.35, 0);
        const bodyDelta = toBody.minus(fromBody);
        const bodyDistance = bodyDelta.norm();
        if (bodyDistance > 0.6) {
          const bodyHit = bot.world.raycast(fromBody, bodyDelta.normalize(), bodyDistance);
          if (bodyHit) return false;
        }

        const fromEyes = candidateFeet.offset(0, bot.entity.height || 1.62, 0);
        const toEyes = targetFeet.offset(0, (entity.height || 1.8) * 0.6, 0);
        const eyeDelta = toEyes.minus(fromEyes);
        const eyeDistance = eyeDelta.norm();
        if (eyeDistance > 0.6) {
          const eyeHit = bot.world.raycast(fromEyes, eyeDelta.normalize(), eyeDistance);
          if (eyeHit) return false;
        }
        return true;
      } catch (e) {
        // If the world raycast cannot be evaluated (e.g. an unloaded edge),
        // stay conservative and keep navigating rather than stopping early.
        return false;
      }
    };
    return goal;
  }

  function setActiveGoal(goal, dynamic = false) {
    activeGoal = { goal, dynamic };
    lastProgressPosition = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
    lastProgressAt = Date.now();
    missingGoalSince = 0;
    bot.pathfinder.setGoal(goal, dynamic);
  }

  function isClearBodyBlock(block) {
    return Boolean(block && (block.boundingBox === "empty" || (Array.isArray(block.shapes) && block.shapes.length === 0)));
  }

  function hasSafeFloor(block) {
    if (!block || !block.shapes || block.shapes.length === 0) return false;
    // Accept full blocks and high partial surfaces, but reject thin carpets/slabs
    // that are not a dependable landing surface for this escape routine.
    return block.shapes.some((shape) => Number(shape[4]) >= 0.7);
  }

  function hasTowerBlocks() {
    const movements = bot.pathfinder && bot.pathfinder.movements;
    if (movements && typeof movements.countScaffoldingItems === "function") {
      try { return movements.countScaffoldingItems() > 0; } catch (e) {}
    }
    return false;
  }

  function targetPosition(goal) {
    if (!goal) return null;
    if (goal.entity && goal.entity.position) return goal.entity.position;
    if (goal.pos) return goal.pos;
    if (Number.isFinite(goal.x) && Number.isFinite(goal.y) && Number.isFinite(goal.z)) {
      return { x: goal.x, y: goal.y, z: goal.z };
    }
    return null;
  }

  // Search in 3D, not just the four same-height neighbors. A bot in a trench
  // needs to find a one-block-higher ledge; a same-level-only search reports
  // no escape even when the top of the dirt wall is immediately beside it.
  function findSafeEscapeTiles(goal) {
    const p = bot.entity.position.floored();
    const target = targetPosition(goal);
    const canTower = hasTowerBlocks();
    const candidates = [];
    const bodyHeight = bot.entity.height || 1.8;
    const bodyBlocks = Math.max(2, Math.ceil(bodyHeight));

    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        if (dx === 0 && dz === 0) continue;
        const horizontalDistance = Math.hypot(dx, dz);
        if (horizontalDistance > 3.25) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const feetPos = p.offset(dx, dy, dz);
          const feet = bot.blockAt(feetPos, false);
          if (!isClearBodyBlock(feet)) continue;

          let bodyClear = true;
          for (let h = 1; h < bodyBlocks; h++) {
            const bodyBlock = bot.blockAt(feetPos.offset(0, h, 0), false);
            if (!isClearBodyBlock(bodyBlock)) { bodyClear = false; break; }
          }
          if (!bodyClear) continue;

          const hazardNames = new Set(["lava", "flowing_lava", "fire", "soul_fire", "cactus", "magma_block"]);
          if (hazardNames.has(feet.name)) continue;

          const floor = bot.blockAt(feetPos.offset(0, -1, 0), false);
          const supported = hasSafeFloor(floor);
          // Let the pathfinder plan a scaffold move to an elevated escape
          // waypoint when it has blocks; do not simulate a fake floor here.
          const towerable = canTower && dy > 0;
          if (!supported && !towerable) continue;

          const targetDistance = target
            ? Math.hypot(feetPos.x + 0.5 - target.x, feetPos.y - target.y, feetPos.z + 0.5 - target.z)
            : 0;
          const currentTargetDistance = target
            ? Math.hypot(bot.entity.position.x - target.x, bot.entity.position.y - target.y, bot.entity.position.z - target.z)
            : 0;
          const progressPenalty = target ? (targetDistance - currentTargetDistance) * 1.5 : 0;
          const verticalPenalty = dy > 0 ? dy * 0.9 : Math.abs(dy) * 0.7;
          const score = horizontalDistance + verticalPenalty + progressPenalty;
          candidates.push({ pos: feetPos, score, supported, towerable });
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates;
  }

  function escapeBlockedNode() {
    const now = Date.now();
    if (escapeInProgress || !activeGoal || !bot.entity || now - lastEscapeAt < 5000) return;
    if (bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) return;

    const goalSnapshot = activeGoal;
    const candidates = findSafeEscapeTiles(goalSnapshot.goal);
    if (!candidates.length) {
      lastEscapeAt = now;
      console.warn("[Pathfinder] Stuck recovery found no safe 3D escape tile; keeping the original goal and waiting for a new world/path update.");
      try { bot.pathfinder.setGoal(goalSnapshot.goal, goalSnapshot.dynamic); } catch (e) {}
      return;
    }

    escapeInProgress = true;
    recoverySwappingGoal = true;
    lastEscapeAt = now;
    escapeCount++;
    try {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
    } catch (e) {
      recoverySwappingGoal = false;
      escapeInProgress = false;
      return;
    }

    let candidateIndex = 0;
    let attemptTimer = null;
    let activeEscapeGoal = null;
    let listeners = null;
    const finishRecovery = (restoreOriginal) => {
      if (attemptTimer) clearTimeout(attemptTimer);
      if (listeners) {
        bot.removeListener("goal_reached", listeners.onReached);
        bot.removeListener("path_update", listeners.onPathUpdate);
      }
      listeners = null;
      activeEscapeGoal = null;
      if (restoreOriginal && activeGoal === goalSnapshot && bot.entity) {
        try {
          lastProgressPosition = bot.entity.position.clone();
          lastProgressAt = Date.now();
          bot.pathfinder.setGoal(goalSnapshot.goal, goalSnapshot.dynamic);
        } catch (e) {
          key = null;
        }
      }
      recoverySwappingGoal = false;
      escapeInProgress = false;
    };

    const tryNextCandidate = () => {
      if (attemptTimer) clearTimeout(attemptTimer);
      if (listeners) {
        bot.removeListener("goal_reached", listeners.onReached);
        bot.removeListener("path_update", listeners.onPathUpdate);
      }
      listeners = null;
      if (!bot.entity || activeGoal !== goalSnapshot || candidateIndex >= candidates.length) {
        finishRecovery(true);
        return;
      }

      const candidate = candidates[candidateIndex++];
      const tile = candidate.pos;
      activeEscapeGoal = new goals.GoalBlock(tile.x, tile.y, tile.z);
      console.warn(`[Pathfinder] Trying 3D escape waypoint ${tile.x},${tile.y},${tile.z} (${candidate.supported ? "supported" : "tower candidate"}).`);
      listeners = {
        onReached: (reachedGoal) => {
          if (reachedGoal === activeEscapeGoal) finishRecovery(true);
        },
        onPathUpdate: (result) => {
          if (result && (result.status === "noPath" || result.status === "timeout")) {
            tryNextCandidate();
          }
        },
      };
      bot.on("goal_reached", listeners.onReached);
      bot.on("path_update", listeners.onPathUpdate);
      try {
        bot.pathfinder.setGoal(activeEscapeGoal, false);
      } catch (e) {
        tryNextCandidate();
        return;
      }
      // Don't let one impossible waypoint hold the bot forever.
      attemptTimer = setTimeout(tryNextCandidate, 6500);
    };

    tryNextCandidate();
  }

  const onPathReset = (reason) => {
    // `stuck` is the normal movement failure; digging/placing failures can
    // leave the same active goal stranded and deserve the same recovery path.
    if (["stuck", "dig_error", "place_error", "no_scaffolding_blocks"].includes(reason)) {
      escapeBlockedNode();
    }
  };
  const onPathUpdate = (result) => {
    // noPath/timeout are path_update statuses, NOT path_reset reasons. v5 did
    // not listen for these, so follow/PvP could silently keep a dead goal key.
    if (!result || !["noPath", "timeout"].includes(result.status)) return;
    if (!escapeInProgress) escapeBlockedNode();
  };
  const onPhysicsTick = () => {
    if (!bot.entity || !activeGoal || escapeInProgress) return;
    const now = Date.now();
    const mining = !!(bot.pathfinder.isMining && bot.pathfinder.isMining());
    const building = !!(bot.pathfinder.isBuilding && bot.pathfinder.isBuilding());
    if (mining || building) {
      if (!busyActionSince) busyActionSince = now;
      // A permission-rejected dig or scaffold placement can leave the path
      // executor busy without moving. Never let that state disable recovery
      // forever; cancel only after a generous grace period.
      if (now - busyActionSince > 12000) {
        const snapshot = activeGoal;
        console.warn(`[Pathfinder] ${mining ? "dig" : "scaffold placement"} made no progress for 12s; cancelling the stalled action and retrying the same goal.`);
        recoverySwappingGoal = true;
        try {
          if (mining && typeof bot.stopDigging === "function") bot.stopDigging();
          bot.pathfinder.setGoal(null);
        } catch (e) {}
        setTimeout(() => {
          if (activeGoal === snapshot && bot.entity) {
            try { bot.pathfinder.setGoal(snapshot.goal, snapshot.dynamic); } catch (e) {}
          }
          recoverySwappingGoal = false;
          busyActionSince = 0;
          lastProgressPosition = bot.entity ? bot.entity.position.clone() : null;
          lastProgressAt = Date.now();
        }, 250);
        busyActionSince = now;
      }
      return;
    }
    busyActionSince = 0;
    // A dynamic GoalFollow remains active when its target is in range. Static
    // goals can also complete on this tick, so don't mistake arrival for a jam.
    let reached = false;
    try {
      reached = !!(activeGoal.goal && typeof activeGoal.goal.isEnd === "function" &&
        activeGoal.goal.isEnd(bot.entity.position.floored()));
    } catch (e) {}
    if (reached) {
      lastProgressPosition = bot.entity.position.clone();
      lastProgressAt = now;
      missingGoalSince = 0;
      return;
    }

    // The library can clear its goal after a failed search. Since nav.follow()
    // intentionally de-duplicates identical goals, it would otherwise never
    // submit the target again. Re-arm the original active goal after a grace
    // period (unless recovery currently owns the pathfinder).
    if (!bot.pathfinder.goal) {
      if (!missingGoalSince) missingGoalSince = now;
      if (now - missingGoalSince > 900) {
        missingGoalSince = now;
        try {
          console.warn("[Pathfinder] Active task lost its pathfinder goal; restoring it.");
          bot.pathfinder.setGoal(activeGoal.goal, activeGoal.dynamic);
        } catch (e) {}
      }
      return;
    }
    missingGoalSince = 0;

    // Detect lack of actual body displacement whether isMoving() says true or
    // false. In v5, the !isMoving branch refreshed the timer every tick, so a
    // route that had stopped without clearing its goal could never time out.
    const moved = lastProgressPosition
      ? bot.entity.position.distanceTo(lastProgressPosition)
      : Infinity;
    if (moved > 0.08) {
      lastProgressPosition = bot.entity.position.clone();
      lastProgressAt = now;
      return;
    }
    if (now - lastProgressAt > 3200) escapeBlockedNode();
  };
  bot.on("path_reset", onPathReset);
  bot.on("path_update", onPathUpdate);
  bot.on("physicsTick", onPhysicsTick);
  bot.once("end", () => {
    bot.removeListener("path_reset", onPathReset);
    bot.removeListener("path_update", onPathUpdate);
    bot.removeListener("physicsTick", onPhysicsTick);
  });

  return {
    follow(entity, range = 2) {
      if (!entity || !entity.position) return;
      const k = "f:" + entity.id + ":" + range;
      if (k === key) return;
      key = k;
      followState = { entity, range };
      gotoState = null;
      escapeInProgress = false;
      setActiveGoal(followGoal(entity, range), true);
    },
    goto(x, y, z, range = 1) {
      const nextKey = "g:" + Math.floor(x) + "," + Math.floor(y) + "," + Math.floor(z) + ":" + range;
      if (nextKey === key) return;
      key = nextKey;
      followState = null;
      gotoState = { x, y, z, range };
      escapeInProgress = false;
      setActiveGoal(new goals.GoalNear(x, y, z, range));
    },
    // Used by wood/drop pickup routes that need a completion Promise. This
    // listens for goal_reached itself so the temporary null-goal used during
    // stuck recovery does not make pathfinder.goto() reject as GoalChanged.
    gotoGoal(goal) {
      key = "promise-goal:" + Date.now();
      followState = null;
      gotoState = null;
      escapeInProgress = false;
      const goalState = { goal, dynamic: false };
      activeGoal = goalState;
      lastProgressPosition = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
      lastProgressAt = Date.now();

      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          bot.removeListener("goal_reached", onReached);
          bot.removeListener("path_update", onPathUpdate);
          bot.removeListener("goal_updated", onGoalUpdated);
          bot.removeListener("path_stop", onPathStop);
          if (cancelGoalPromise === cancel) cancelGoalPromise = null;
        };
        const finish = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const onReached = (reachedGoal) => {
          if (reachedGoal === goal) finish();
        };
        const onPathUpdate = (result) => {
          if (!result || !["noPath", "timeout"].includes(result.status)) return;
          // The createNav-level listener runs first and starts a temporary
          // escape goal. Keep this promise alive while that recovery is active;
          // otherwise wood/drop routes cancel their own recovery immediately.
          if (escapeInProgress || recoverySwappingGoal) return;
          finish(new Error(result.status === "noPath" ? "No path to the goal" : "Pathfinding timed out"));
        };
        const onGoalUpdated = (nextGoal) => {
          if (recoverySwappingGoal) return;
          if (nextGoal !== goal) finish(new Error("Navigation goal was replaced"));
        };
        const onPathStop = () => {
          if (recoverySwappingGoal) return;
          finish(new Error("Navigation stopped"));
        };
        const cancel = (error) => finish(error || new Error("Navigation cancelled"));

        cancelGoalPromise = cancel;
        bot.on("goal_reached", onReached);
        bot.on("path_update", onPathUpdate);
        bot.on("goal_updated", onGoalUpdated);
        bot.on("path_stop", onPathStop);
        try {
          bot.pathfinder.setGoal(goal, false);
        } catch (e) {
          finish(e);
        }
      });
    },
    stop() {
      if (cancelGoalPromise) cancelGoalPromise(new Error("Navigation stopped"));
      key = null;
      followState = null;
      gotoState = null;
      activeGoal = null;
      escapeInProgress = false;
      recoverySwappingGoal = false;
      lastProgressPosition = null;
      bot.pathfinder.setGoal(null);
    },
    forget() {
      key = null;
      followState = null;
      gotoState = null;
      activeGoal = null;
      escapeInProgress = false;
      recoverySwappingGoal = false;
      lastProgressPosition = null;
    },
  };
}

// ============================================================
// MELEE ENGINE
// opts.crit  -> stop sprinting, jump, and hit while falling (critical hit)
// !opts.crit -> sprint in and hit whenever the attack bar is full
// ============================================================
function createMelee(bot, nav) {
  let lastAttack = 0;
  let switching = false;

  async function ensureWeapon(prefer) {
    const best = bestWeapon(bot, prefer);
    if (!best) return;
    if (bot.heldItem && bot.heldItem.name === best.name) return;
    if (switching) return;
    switching = true;
    try {
      await bot.equip(best, "hand");
    } catch (e) {
      /* ignore */
    } finally {
      switching = false;
    }
  }

  function release() {
    // Combat no longer drives forward/strafe controls manually. Those controls
    // can fight the pathfinder at corners and against house foundations.
    for (const c of ["forward", "back", "left", "right", "sprint", "jump"]) {
      try {
        if (bot.controlState && bot.controlState[c]) bot.setControlState(c, false);
      } catch (e) {}
    }
  }

  function hit(target) {
    try {
      bot.attack(target);
      lastAttack = Date.now();
    } catch (e) {}
  }

  function step(target, opts = {}) {
    if (!target || !target.position || !bot.entity) return;
    const now = Date.now();
    const reach = Number.isFinite(opts.reach) ? opts.reach : 3.0;

    ensureWeapon(opts.prefer || "sword");

    const distance = reachDistance(bot, target);
    lookAtPoint(bot, target.position.offset(0, (target.height || 1.8) * 0.6, 0));

    // Always keep a live pathfinder goal while approaching. The older close-
    // range controller called nav.stop() and pushed forward/strafe directly;
    // near a wall, fence, tree or house corner that left no recovery goal at
    // all. A smaller follow radius also prevents stopping on the wrong side
    // of a wall merely because the target is within two Euclidean blocks.
    nav.follow(target, 1.1);

    const visible = hasLineOfSight(bot, target);
    const laneClear = hasClearMeleeLane(bot, target, 2.2);
    const cooldown = cooldownMs(bot.heldItem);
    const charged = now - lastAttack >= cooldown + 30;

    // Attack only when the hitbox is in reach and a block is not between the
    // bot and target. Movement remains exclusively pathfinder-controlled.
    if (distance <= reach - 0.05 && visible && laneClear && charged) {
      hit(target);
    }
  }

  return { step, release, ensureWeapon };
}

module.exports = {
  HOSTILE,
  isHostile,
  normalizeName,
  findPlayer,
  parseWeapon,
  cooldownMs,
  bestWeapon,
  findBow,
  countArrows,
  ARROW_SPEED,
  flightAt,
  solvePitch,
  computeAim,
  createVelocityTracker,
  hasLineOfSight,
  hasClearMeleeLane,
  setCtl,
  look,
  lookAtPoint,
  reachDistance,
  createNav,
  createMelee,
};
