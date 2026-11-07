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
  let escapeRetryTimer = null;
  let recoverySwappingGoal = false;
  let cancelGoalPromise = null;
  let lastProgressPosition = null;
  let lastProgressAt = Date.now();
  let movementObserved = false;
  let missingGoalSince = 0;
  let busyActionSince = 0;
  // Do not run the stuck watchdog while A* is still calculating. The old
  // 3.2-second timer could cancel a valid search long before thinkTimeout.
  let routeState = "idle"; // idle | pending | partial | ready | failed
  let routeStateAt = Date.now();
  let lastPathStatus = "idle";
  let lastPathNodeCount = 0;
  // Alternate-route fallback state. When the direct route to a goal fails, the
  // controller tries reachable standing tiles on the target's side, then (after
  // a whole round of failures) re-plans with a more permissive rescue profile.
  let rescueMovements = null;
  let unreachableCallback = null;
  let lastUnreachableNoticeAt = 0;

  // Dynamic, staged approach goal. It first seeks a close, visible position;
  // if terrain makes that impossible it expands the acceptable distance in
  // small steps, reaches a visible waypoint, then tries a closer stage again.
  // This prevents a one-block ridge / cave lip from being treated as a hard
  // no-path condition while still trying to close distance for melee combat.
  function followGoal(entity, range) {
    const goal = new goals.GoalFollow(entity, range);
    const originalIsEnd = goal.isEnd.bind(goal);
    const baseRange = Math.max(1.25, Number(range) || 2);
    const maxRange = Math.min(9, baseRange + 7);
    goal.__smartBaseRange = baseRange;
    goal.__smartRange = baseRange;
    goal.__smartMaxRange = maxRange;
    goal.__smartFailedRanges = new Set();
    goal.__smartLastRefineAt = 0;

    const applyRange = (next) => {
      const value = Math.max(baseRange, Math.min(maxRange, Number(next)));
      goal.range = value;
      goal.rangeSq = value * value;
      goal.__smartRange = value;
    };
    goal.__smartExpandRange = () => {
      goal.__smartFailedRanges.add(Number(goal.__smartRange.toFixed(2)));
      let next = Math.min(maxRange, goal.__smartRange + 1.5);
      while (next > goal.__smartRange + 0.001) {
        const value = Number(next.toFixed(2));
        if (!goal.__smartFailedRanges.has(value)) {
          applyRange(value);
          return true;
        }
        if (value >= maxRange) break;
        next = Math.min(maxRange, next + 1.5);
      }
      return false;
    };
    goal.__smartRefineRange = (now) => {
      if (goal.__smartRange <= baseRange + 0.01 || now - goal.__smartLastRefineAt < 1200) return false;
      goal.__smartLastRefineAt = now;
      for (let next = goal.__smartRange - 1.5; next >= baseRange - 0.001; next -= 1.5) {
        const value = Number(Math.max(baseRange, next).toFixed(2));
        if (!goal.__smartFailedRanges.has(value)) {
          applyRange(value);
          return true;
        }
      }
      return false;
    };
    goal.__smartReset = () => {
      goal.__smartFailedRanges.clear();
      applyRange(baseRange);
    };

    goal.isEnd = (node) => {
      if (!originalIsEnd(node) || !entity.position || !bot.world || !bot.entity) return false;
      try {
        const fromEyes = new Vec3(node.x + 0.5, node.y + (bot.entity.height || 1.62) * 0.9, node.z + 0.5);
        const targetHeight = entity.height || 1.8;
        // A single torso ray is overly strict around grass edges, slabs and
        // uneven cave entrances. Any clear ray to a sensible hitbox sample is
        // a valid approach point; melee still performs its own body-lane test.
        const targetSamples = [0.35, Math.min(targetHeight * 0.55, 1.0), Math.max(0.3, targetHeight - 0.2)];
        for (const sampleY of targetSamples) {
          const targetPoint = entity.position.offset(0, sampleY, 0);
          const delta = targetPoint.minus(fromEyes);
          const distance = delta.norm();
          if (distance <= 0.35 || !bot.world.raycast(fromEyes, delta.normalize(), distance)) return true;
        }
        return false;
      } catch (e) {
        // Unknown/unloaded raycasts should not be treated as proof of arrival.
        return false;
      }
    };
    return goal;
  }

  function expandSmartGoal(goal, reason) {
    if (!goal || typeof goal.__smartExpandRange !== "function") return false;
    if (!goal.__smartExpandRange()) return false;
    console.warn(`[Pathfinder] Smart approach widened to ${goal.__smartRange.toFixed(1)} blocks after ${reason}; will tighten again when a visible waypoint is reached.`);
    return true;
  }

  function setActiveGoal(goal, dynamic = false) {
    if (escapeRetryTimer) {
      clearTimeout(escapeRetryTimer);
      escapeRetryTimer = null;
    }
    activeGoal = { goal, dynamic };
    lastProgressPosition = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
    lastProgressAt = Date.now();
    movementObserved = false;
    missingGoalSince = 0;
    routeState = "pending";
    routeStateAt = Date.now();
    lastPathStatus = "pending";
    lastPathNodeCount = 0;
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
        if (horizontalDistance > 5.25) continue;
        for (let dy = -3; dy <= 3; dy++) {
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
    // Keep the recovery search bounded. The best 20 candidates cover nearby
    // lateral routes and higher ledges without issuing dozens of expensive A* searches.
    return candidates.slice(0, 20);
  }

  const HAZARD_BLOCKS = new Set(["lava", "flowing_lava", "fire", "soul_fire", "cactus", "magma_block", "sweet_berry_bush", "wither_rose", "powder_snow"]);

  // Can the bot stand with its feet in this block? Returns null when not.
  function evaluateStandable(feetPos, allowTower) {
    const bodyBlocks = Math.max(2, Math.ceil(bot.entity.height || 1.8));
    const feet = bot.blockAt(feetPos, false);
    if (!isClearBodyBlock(feet) || HAZARD_BLOCKS.has(feet.name)) return null;
    for (let h = 1; h < bodyBlocks; h++) {
      if (!isClearBodyBlock(bot.blockAt(feetPos.offset(0, h, 0), false))) return null;
    }
    const floor = bot.blockAt(feetPos.offset(0, -1, 0), false);
    if (floor && HAZARD_BLOCKS.has(floor.name)) return null;
    const supported = hasSafeFloor(floor);
    if (!supported && !allowTower) return null;
    return { supported, towerable: !supported };
  }

  // Alternate route planner: standing tiles around the *target* (not around the
  // bot) ranked by closeness to the target. If the exact approach tile is
  // unreachable (wall, fence, water moat, cliff) the pathfinder is asked to get
  // to one of these tiles instead - different sides and heights - and the
  // original goal is re-planned from there.
  function findTargetSideWaypoints(goal, failed) {
    const target = targetPosition(goal);
    if (!target || !bot.entity) return [];
    const t = new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
    const me = bot.entity.position;
    const canTower = hasTowerBlocks();
    const R = 8;
    const found = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const horizontal = Math.hypot(dx, dz);
        if (horizontal > R + 0.5 || horizontal < 1) continue;
        for (let dy = -3; dy <= 3; dy++) {
          const feetPos = t.offset(dx, dy, dz);
          const info = evaluateStandable(feetPos, canTower && dy > 0);
          if (!info) continue;
          const key = feetPos.x + "," + feetPos.y + "," + feetPos.z;
          const failCount = (failed && failed.get(key)) || 0;
          const score = horizontal + Math.abs(dy) * 0.6 +
            Math.hypot(feetPos.x + 0.5 - me.x, feetPos.z + 0.5 - me.z) * 0.1 +
            failCount * 8 + (info.supported ? 0 : 3);
          found.push({ pos: feetPos, score, supported: info.supported, towerable: info.towerable, kind: "target-side", key });
        }
      }
    }
    found.sort((a, b) => a.score - b.score);
    // Spread the picks: skip tiles that sit next to an already chosen one at
    // the same height so each attempt approaches from a genuinely new angle.
    const picked = [];
    for (const c of found) {
      if (picked.some((p) => p.pos.y === c.pos.y && Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z) < 2.5)) continue;
      picked.push(c);
      if (picked.length >= 10) break;
    }
    return picked;
  }

  function scheduleEscapeRetry(delay) {
    if (escapeRetryTimer || escapeInProgress) return;
    escapeRetryTimer = setTimeout(() => {
      escapeRetryTimer = null;
      escapeBlockedNode();
    }, Math.max(250, delay));
  }

  function escapeBlockedNode() {
    const now = Date.now();
    if (escapeInProgress || !activeGoal || !bot.entity) return;
    const cooldownRemaining = 5000 - (now - lastEscapeAt);
    if (cooldownRemaining > 0) {
      scheduleEscapeRetry(cooldownRemaining);
      return;
    }
    if ((bot.pathfinder.isMining && bot.pathfinder.isMining()) || (bot.pathfinder.isBuilding && bot.pathfinder.isBuilding())) {
      scheduleEscapeRetry(1000);
      return;
    }
    if (escapeRetryTimer) {
      clearTimeout(escapeRetryTimer);
      escapeRetryTimer = null;
    }

    const goalSnapshot = activeGoal;
    const failedWaypoints = goalSnapshot.failedWaypoints || (goalSnapshot.failedWaypoints = new Map());
    const localTiles = findSafeEscapeTiles(goalSnapshot.goal).map((c) => ({
      ...c, kind: "local", key: c.pos.x + "," + c.pos.y + "," + c.pos.z,
    }));
    const targetTiles = findTargetSideWaypoints(goalSnapshot.goal, failedWaypoints);
    // Interleave "get out of here" tiles with "get around to the target" tiles
    // so a trapped bot and a walled-off target are both handled quickly.
    const candidates = [];
    const seen = new Set();
    for (let i = 0; i < Math.max(localTiles.length, targetTiles.length); i++) {
      for (const c of [targetTiles[i], localTiles[i]]) {
        if (c && !seen.has(c.key)) { seen.add(c.key); candidates.push(c); }
      }
    }
    if (!candidates.length) {
      lastEscapeAt = now;
      // Critical: do not leave routeState="failed" here. That state suppresses
      // the physics watchdog permanently. Re-arm the original goal and retry
      // the escape search after chunks/nearby entities have had time to update.
      routeState = "pending";
      routeStateAt = now;
      lastProgressAt = now;
      lastProgressPosition = bot.entity.position.clone();
      lastPathNodeCount = 0;
      lastPathStatus = "recovery_no_safe_tile_retry";
      console.warn("[Pathfinder] No safe 3D escape tile is loaded yet; rearming the route and retrying recovery shortly.");
      try { bot.pathfinder.setGoal(goalSnapshot.goal, goalSnapshot.dynamic); } catch (e) {}
      scheduleEscapeRetry(8000);
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

    // After one whole round of failed waypoints, escalate to the rescue
    // movement profile (wider terrain clearing) for the next round.
    let previousMovements = null;
    if (rescueMovements && (goalSnapshot.recoveryFailures || 0) >= 1 && bot.pathfinder.movements !== rescueMovements) {
      try {
        previousMovements = bot.pathfinder.movements;
        bot.pathfinder.setMovements(rescueMovements);
        console.warn("[Pathfinder] Alternate-route recovery is using the rescue movement profile.");
      } catch (e) { previousMovements = null; }
    }

    let candidateIndex = 0;
    let attemptTimer = null;
    let activeEscapeGoal = null;
    let activeCandidate = null;
    let reachedWaypoint = false;
    let listeners = null;
    const finishRecovery = (restoreOriginal) => {
      if (attemptTimer) clearTimeout(attemptTimer);
      if (listeners) {
        bot.removeListener("goal_reached", listeners.onReached);
        bot.removeListener("path_update", listeners.onPathUpdate);
      }
      listeners = null;
      activeEscapeGoal = null;
      activeCandidate = null;
      if (previousMovements) {
        try { bot.pathfinder.setMovements(previousMovements); } catch (e) {}
        previousMovements = null;
      }
      if (reachedWaypoint) {
        goalSnapshot.recoveryFailures = 0;
      } else {
        goalSnapshot.recoveryFailures = (goalSnapshot.recoveryFailures || 0) + 1;
        if (goalSnapshot.recoveryFailures >= 2 && typeof unreachableCallback === "function" &&
            Date.now() - lastUnreachableNoticeAt > 60000) {
          lastUnreachableNoticeAt = Date.now();
          try { unreachableCallback({ failures: goalSnapshot.recoveryFailures }); } catch (e) {}
        }
      }
      if (restoreOriginal && activeGoal === goalSnapshot && bot.entity) {
        try {
          lastProgressPosition = bot.entity.position.clone();
          lastProgressAt = Date.now();
          movementObserved = false;
          routeState = "pending";
          routeStateAt = Date.now();
          lastPathStatus = "recovery_replan";
          lastPathNodeCount = 0;
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

      // The waypoint we are leaving did not get us anywhere: remember that so
      // the next recovery round ranks it last instead of retrying it first.
      if (activeCandidate && !reachedWaypoint) {
        failedWaypoints.set(activeCandidate.key, (failedWaypoints.get(activeCandidate.key) || 0) + 1);
      }
      const candidate = candidates[candidateIndex++];
      activeCandidate = candidate;
      const tile = candidate.pos;
      activeEscapeGoal = new goals.GoalBlock(tile.x, tile.y, tile.z);
      console.warn(`[Pathfinder] Trying ${candidate.kind === "target-side" ? "alternate route via tile near target" : "3D escape waypoint"} ${tile.x},${tile.y},${tile.z} (${candidate.supported ? "supported" : "tower candidate"}).`);
      listeners = {
        onReached: (reachedGoal) => {
          if (reachedGoal === activeEscapeGoal) {
            reachedWaypoint = true;
            finishRecovery(true);
          }
        },
        onPathUpdate: (result) => {
          if (!result) return;
          if (result.status === "noPath" || result.status === "timeout") {
            tryNextCandidate();
            return;
          }
          if (result.status === "success") {
            // Once a route exists, give the executor time to actually walk it.
            // A* search timeout and physical movement timeout are different.
            if (attemptTimer) clearTimeout(attemptTimer);
            attemptTimer = setTimeout(tryNextCandidate, 10000);
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
      // Do not cancel a live A* search before thinkTimeout. The old 6.5s
      // candidate timer repeatedly replaced routes while the planner was still
      // computing (configured thinkTimeout is 22s), making escape impossible.
      const thinkTimeout = Math.max(5000, Number(bot.pathfinder.thinkTimeout) || 5000);
      attemptTimer = setTimeout(tryNextCandidate, thinkTimeout + 5000);
    };

    tryNextCandidate();
  }

  const onGoalUpdated = () => {
    if (recoverySwappingGoal || escapeInProgress || !activeGoal) return;
    routeState = "pending";
    routeStateAt = Date.now();
    lastPathStatus = "goal_updated";
    lastPathNodeCount = 0;
    lastProgressPosition = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
    lastProgressAt = Date.now();
    movementObserved = false;
    missingGoalSince = 0;
  };

  const onPathReset = (reason) => {
    const now = Date.now();
    if (["stuck", "dig_error", "place_error", "no_scaffolding_blocks"].includes(reason)) {
      if (!escapeInProgress) {
        if (reason === "stuck" && tryStepUp("path stuck")) return;
        routeState = "failed";
        routeStateAt = now;
        lastPathStatus = reason;
        if (activeGoal && expandSmartGoal(activeGoal.goal, reason)) {
          routeState = "pending";
          routeStateAt = now;
          lastPathStatus = "smart_range_expand";
          lastPathNodeCount = 0;
          try { bot.pathfinder.setGoal(activeGoal.goal, activeGoal.dynamic); } catch (e) { escapeBlockedNode(); }
        } else {
          escapeBlockedNode();
        }
      }
      return;
    }
    // World/chunk/goal changes invalidate the previous route. Wait for the
    // next path_update before deciding whether the bot itself is stalled.
    if (["goal_updated", "goal_moved", "block_updated", "chunk_loaded", "movements_updated"].includes(reason) && !recoverySwappingGoal && !escapeInProgress) {
      routeState = "pending";
      routeStateAt = now;
      lastPathStatus = reason;
      lastPathNodeCount = 0;
    }
  };

  const onPathUpdate = (result) => {
    if (!result || recoverySwappingGoal || escapeInProgress) return;
    const now = Date.now();
    const status = String(result.status || "unknown");
    const resultLength = Array.isArray(result.path) ? result.path.length : 0;
    const liveLength = bot.pathfinder && Array.isArray(bot.pathfinder.path) ? bot.pathfinder.path.length : 0;
    lastPathStatus = status;
    lastPathNodeCount = resultLength || liveLength;

    if (status === "success") {
      routeState = "ready";
      routeStateAt = now;
      if (!movementObserved) {
        lastProgressPosition = bot.entity && bot.entity.position ? bot.entity.position.clone() : lastProgressPosition;
        lastProgressAt = now;
      }
      return;
    }
    if (status === "partial") {
      // Partial results may be walkable while the planner continues. Preserve
      // the original start time and progress clock across repeated partials.
      if (routeState !== "partial" && routeState !== "ready") routeStateAt = now;
      routeState = "partial";
      return;
    }
    if (status === "noPath" || status === "timeout") {
      routeState = "failed";
      routeStateAt = now;
      if (activeGoal && expandSmartGoal(activeGoal.goal, status)) {
        routeState = "pending";
        routeStateAt = now;
        lastPathStatus = "smart_range_expand";
        lastPathNodeCount = 0;
        try { bot.pathfinder.setGoal(activeGoal.goal, activeGoal.dynamic); } catch (e) { escapeBlockedNode(); }
      } else if (activeGoal) {
        escapeBlockedNode();
      }
    }
  };

  // Real progress is horizontal movement (or a net climb / big drop). Pure
  // up-and-down bobbing - jumping at a wall and falling back - is NOT progress;
  // counting it hid the stall from every watchdog.
  function madeProgress() {
    const p = bot.entity.position;
    const a = lastProgressPosition;
    if (!a) return true;
    const h = Math.hypot(p.x - a.x, p.z - a.z);
    const dy = p.y - a.y;
    return h > 0.08 || dy > 0.9 || dy < -1.5;
  }

  // Step-up assist ("just jump"): when blocked by a one-block ledge, face it and
  // hold forward + jump ourselves until the bot is standing on top. The path
  // executor is paused meanwhile so it cannot cancel the jump half-way, and the
  // original goal is restored afterwards.
  let stepAssist = null;
  let lastStepAssistAt = 0;
  let stepAssistFails = 0;
  let stepAssistPauseUntil = 0;

  function topOf(block) {
    if (!block || !Array.isArray(block.shapes) || !block.shapes.length) return null;
    let top = 0;
    for (const sh of block.shapes) top = Math.max(top, sh[4]);
    return block.position.y + top;
  }

  function findStepUp() {
    if (!bot.entity || !activeGoal) return null;
    const pos = bot.entity.position;
    const base = Math.floor(pos.y + 0.0625 + 1e-6);
    const target = targetPosition(activeGoal.goal);
    let hx = target ? target.x - pos.x : -Math.sin(bot.entity.yaw || 0);
    let hz = target ? target.z - pos.z : -Math.cos(bot.entity.yaw || 0);
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    // Our own headroom must allow a jump.
    const ownX = Math.floor(pos.x), ownZ = Math.floor(pos.z);
    for (let h = 1; h <= 2; h++) {
      if (!isClearBodyBlock(bot.blockAt(new Vec3(ownX, base + h, ownZ), false))) return null;
    }
    const dirs = [];
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const dx = Math.round(Math.cos(a) * 1000) / 1000, dz = Math.round(Math.sin(a) * 1000) / 1000;
      const norm = Math.hypot(dx, dz);
      const ux = dx / norm, uz = dz / norm;
      const dot = ux * hx + uz * hz;
      if (dot < 0.2) continue; // never climb away from the goal
      dirs.push({ ux, uz, dot });
    }
    dirs.sort((a, b) => b.dot - a.dot);
    for (const d of dirs) {
      const fx = Math.floor(pos.x + d.ux * 0.75);
      const fz = Math.floor(pos.z + d.uz * 0.75);
      if (fx === ownX && fz === ownZ) continue;
      const ledge = bot.blockAt(new Vec3(fx, base, fz), false);
      const top = topOf(ledge);
      if (top === null || ledge.boundingBox !== "block") continue;
      const rise = top - pos.y;
      if (rise < 0.4 || rise > 1.26) continue;
      let clear = true;
      for (let h = 1; h <= 2; h++) {
        if (!isClearBodyBlock(bot.blockAt(new Vec3(fx, base + h, fz), false))) { clear = false; break; }
      }
      if (!clear) continue;
      return { yaw: Math.atan2(-d.ux, -d.uz), ledgeTop: top, fx, fz };
    }
    return null;
  }

  function tryStepUp(reason) {
    const now = Date.now();
    if (stepAssist || !activeGoal || escapeInProgress || now < stepAssistPauseUntil || now - lastStepAssistAt < 1200) return false;
    let info = null;
    try { info = findStepUp(); } catch (e) { info = null; }
    if (!info) return false;
    lastStepAssistAt = now;
    const snapshot = activeGoal;
    escapeInProgress = true;
    recoverySwappingGoal = true;
    try {
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      bot.setControlState("sneak", false);
      bot.look(info.yaw, 0, true);
      bot.setControlState("forward", true);
      bot.setControlState("sprint", false);
    } catch (e) {
      escapeInProgress = false;
      recoverySwappingGoal = false;
      return false;
    }
    console.warn(`[Pathfinder] Step-up assist (${reason}): jumping onto ledge at ${info.fx},${Math.floor(info.ledgeTop) - 1},${info.fz}.`);
    let ticks = 0;
    let settle = -1;
    const finish = (ok) => {
      bot.removeListener("physicsTick", onTick);
      try { bot.setControlState("jump", false); bot.setControlState("forward", false); } catch (e) {}
      stepAssist = null;
      stepAssistFails = ok ? 0 : stepAssistFails + 1;
      if (stepAssistFails >= 3) { stepAssistPauseUntil = Date.now() + 10000; stepAssistFails = 0; }
      if (activeGoal === snapshot && bot.entity) {
        try {
          lastProgressPosition = bot.entity.position.clone();
          lastProgressAt = Date.now();
          movementObserved = false;
          routeState = "pending";
          routeStateAt = Date.now();
          lastPathStatus = "step_assist_replan";
          lastPathNodeCount = 0;
          bot.pathfinder.setGoal(snapshot.goal, snapshot.dynamic);
        } catch (e) { key = null; }
      }
      recoverySwappingGoal = false;
      escapeInProgress = false;
    };
    const onTick = () => {
      if (!bot.entity || activeGoal !== snapshot) { finish(false); return; }
      ticks++;
      const y = bot.entity.position.y;
      bot.setControlState("jump", !!bot.entity.onGround && y < info.ledgeTop - 0.3);
      bot.setControlState("forward", true);
      if (settle < 0 && bot.entity.onGround && y >= info.ledgeTop - 0.1) settle = 0;
      if (settle >= 0 && ++settle > 5) { finish(true); return; }
      if (ticks > 45) finish(false);
    };
    stepAssist = { finish };
    bot.on("physicsTick", onTick);
    return true;
  }

  // Unstick nudges. A 0.6-block-wide hitbox can wedge against a block corner
  // or keep bumping a ledge it cannot clear (jump lands on the edge, slides
  // back, repeat). Long before the full stall recovery, shake the bot loose:
  // jump, strafe either way, or back off for a run-up. Pathfinder only drives
  // forward/jump/sprint, so strafe/back inputs are not overwritten.
  let nudgeStep = 0;
  let lastNudgeAt = 0;
  const releaseNudge = (...states) => setTimeout(() => {
    try { for (const st of states) bot.setControlState(st, false); } catch (e) {}
  }, 420);
  function maybeNudge(now) {
    if (now - lastProgressAt < 1300 || now - lastNudgeAt < 1000) return;
    let moving = false;
    try { moving = !!(bot.pathfinder.isMoving && bot.pathfinder.isMoving()); } catch (e) {}
    if (!moving || typeof bot.setControlState !== "function") return;
    if (tryStepUp("no progress")) { lastNudgeAt = now; return; }
    lastNudgeAt = now;
    const step = nudgeStep++ % 4;
    try {
      if (step === 0) {
        bot.setControlState("jump", true);
        releaseNudge("jump");
      } else if (step === 1 || step === 2) {
        const side = step === 1 ? "right" : "left";
        bot.setControlState(side, true);
        bot.setControlState("jump", true);
        releaseNudge(side, "jump");
      } else {
        bot.setControlState("back", true);
        releaseNudge("back");
      }
      console.warn(`[Pathfinder] No progress for ${((now - lastProgressAt) / 1000).toFixed(1)}s - unstick nudge #${step + 1}.`);
    } catch (e) {}
  }

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
            routeState = "pending";
            routeStateAt = Date.now();
            lastPathStatus = "busy_action_retry";
            lastPathNodeCount = 0;
            try { bot.pathfinder.setGoal(snapshot.goal, snapshot.dynamic); } catch (e) {}
          }
          recoverySwappingGoal = false;
          busyActionSince = 0;
          lastProgressPosition = bot.entity ? bot.entity.position.clone() : null;
          lastProgressAt = Date.now();
          movementObserved = false;
        }, 250);
        busyActionSince = now;
      }
      return;
    }
    busyActionSince = 0;

    let reached = false;
    try {
      reached = !!(activeGoal.goal && typeof activeGoal.goal.isEnd === "function" &&
        activeGoal.goal.isEnd(bot.entity.position.floored()));
    } catch (e) {}
    if (reached) {
      lastProgressPosition = bot.entity.position.clone();
      lastProgressAt = now;
      missingGoalSince = 0;
      const smartGoal = activeGoal.goal;
      if (smartGoal && typeof smartGoal.__smartRefineRange === "function" && smartGoal.__smartRefineRange(now)) {
        routeState = "pending";
        routeStateAt = now;
        lastPathStatus = "smart_approach_refine";
        lastPathNodeCount = 0;
        try { bot.pathfinder.setGoal(smartGoal, activeGoal.dynamic); } catch (e) {}
      }
      return;
    }

    if (!bot.pathfinder.goal) {
      if (!missingGoalSince) missingGoalSince = now;
      if (now - missingGoalSince > 900) {
        missingGoalSince = now;
        try {
          console.warn("[Pathfinder] Active task lost its pathfinder goal; restoring it.");
          routeState = "pending";
          routeStateAt = now;
          lastPathStatus = "goal_restore";
          lastPathNodeCount = 0;
          bot.pathfinder.setGoal(activeGoal.goal, activeGoal.dynamic);
        } catch (e) {}
      }
      return;
    }
    missingGoalSince = 0;

    // The planner may legitimately spend up to thinkTimeout computing around
    // complicated terrain. Do not cancel a pending/partial search after only
    // a few seconds. If it never produces a route, recover after a full grace.
    if (routeState === "pending" || routeState === "partial" || routeState === "idle") {
      // A partial route can already be moving the bot while A* continues its
      // search. Record real displacement, but do not interrupt the search
      // until its timeout budget plus a grace period has elapsed.
      if (routeState === "partial" && lastProgressPosition) {
        if (madeProgress()) {
          lastProgressPosition = bot.entity.position.clone();
          lastProgressAt = now;
          movementObserved = true;
        }
      }
      if (routeState === "partial") maybeNudge(now);
      const thinkTimeout = Math.max(5000, Number(bot.pathfinder.thinkTimeout) || 5000);
      const plannerExpired = now - routeStateAt > thinkTimeout + 7000;
      const partialRouteStalled = routeState !== "partial" || now - lastProgressAt > 7000;
      if (plannerExpired && partialRouteStalled) {
        console.warn(`[Pathfinder] Planner remained ${routeState} without a usable completed route for ${now - routeStateAt}ms; beginning recovery.`);
        routeState = "failed";
        lastPathStatus = "planner_stalled";
        escapeBlockedNode();
      }
      return;
    }
    if (routeState === "failed") return;

    if (madeProgress()) {
      lastProgressPosition = bot.entity.position.clone();
      lastProgressAt = now;
      movementObserved = true;
      return;
    }
    // Allow for jump arcs, entity collisions and step-up animations before
    // declaring the executor stuck. Use actual displacement, not isMoving().
    maybeNudge(now);
    const stallLimit = lastPathNodeCount > 0 ? 7000 : 9500;
    if (now - lastProgressAt > stallLimit) escapeBlockedNode();
  };
  bot.on("goal_updated", onGoalUpdated);
  bot.on("path_reset", onPathReset);
  bot.on("path_update", onPathUpdate);
  bot.on("physicsTick", onPhysicsTick);
  bot.once("end", () => {
    if (escapeRetryTimer) clearTimeout(escapeRetryTimer);
    escapeRetryTimer = null;
    bot.removeListener("goal_updated", onGoalUpdated);
    bot.removeListener("path_reset", onPathReset);
    bot.removeListener("path_update", onPathUpdate);
    bot.removeListener("physicsTick", onPhysicsTick);
  });

  return {
    follow(entity, range = 2) {
      if (!entity || !entity.position) return;
      const k = "f:" + entity.id + ":" + range;
      if (k === key) {
        if (followState && followState.lastPos && entity.position.distanceTo(followState.lastPos) > 1.0) {
          followState.lastPos = entity.position.clone();
          if (activeGoal && activeGoal.goal && typeof activeGoal.goal.__smartReset === "function") {
            activeGoal.goal.__smartReset();
            activeGoal.failedWaypoints = null;
            activeGoal.recoveryFailures = 0;
            routeState = "pending";
            routeStateAt = Date.now();
            lastPathStatus = "target_moved_replan";
            lastPathNodeCount = 0;
            try { bot.pathfinder.setGoal(activeGoal.goal, true); } catch (e) {}
          }
        }
        return;
      }
      key = k;
      followState = { entity, range, lastPos: entity.position.clone() };
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
      movementObserved = false;
      routeState = "pending";
      routeStateAt = Date.now();
      lastPathStatus = "pending";
      lastPathNodeCount = 0;

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
      if (stepAssist) stepAssist.finish(false);
      if (escapeRetryTimer) clearTimeout(escapeRetryTimer);
      escapeRetryTimer = null;
      if (cancelGoalPromise) cancelGoalPromise(new Error("Navigation stopped"));
      key = null;
      followState = null;
      gotoState = null;
      activeGoal = null;
      escapeInProgress = false;
      recoverySwappingGoal = false;
      lastProgressPosition = null;
      routeState = "idle";
      lastPathStatus = "idle";
      lastPathNodeCount = 0;
      bot.pathfinder.setGoal(null);
    },
    forget() {
      if (escapeRetryTimer) clearTimeout(escapeRetryTimer);
      escapeRetryTimer = null;
      key = null;
      followState = null;
      gotoState = null;
      activeGoal = null;
      escapeInProgress = false;
      recoverySwappingGoal = false;
      lastProgressPosition = null;
      routeState = "idle";
      lastPathStatus = "idle";
      lastPathNodeCount = 0;
    },
    // Movement profile used for the second and later rounds of alternate-route
    // recovery (usually the permissive woodcutting profile).
    setRescueMovements(movements) {
      rescueMovements = movements || null;
    },
    // Called (rate-limited) when repeated alternate-route rounds all fail.
    onUnreachable(callback) {
      unreachableCallback = typeof callback === "function" ? callback : null;
    },
    status() {
      return {
        recoveryFailures: activeGoal ? (activeGoal.recoveryFailures || 0) : 0,
        routeState,
        lastPathStatus,
        pathNodes: lastPathNodeCount,
        routeAgeMs: Math.max(0, Date.now() - routeStateAt),
        noProgressMs: Math.max(0, Date.now() - lastProgressAt),
        escapes: escapeCount,
        escapeInProgress,
        approachRange: activeGoal && activeGoal.goal && Number.isFinite(activeGoal.goal.__smartRange)
          ? activeGoal.goal.__smartRange : null,
        baseApproachRange: activeGoal && activeGoal.goal && Number.isFinite(activeGoal.goal.__smartBaseRange)
          ? activeGoal.goal.__smartBaseRange : null,
      };
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
    // all. The eye-to-torso follow endpoint avoids stopping behind a wall,
    // while the wider range is tolerant of vertical terrain differences.
    nav.follow(target, 2.0);

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
