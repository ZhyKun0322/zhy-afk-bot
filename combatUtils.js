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

  function followGoal(entity, range) {
    return new goals.GoalFollow(entity, range);
  }

  function setActiveGoal(goal, dynamic = false) {
    activeGoal = { goal, dynamic };
    lastProgressPosition = bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
    lastProgressAt = Date.now();
    bot.pathfinder.setGoal(goal, dynamic);
  }

  function isClearBodyBlock(block) {
    return Boolean(block && (block.boundingBox === "empty" || (Array.isArray(block.shapes) && block.shapes.length === 0)));
  }

  function findSafeEscapeTile(goal) {
    const p = bot.entity.position.floored();
    const dirs = [
      { x: 1, z: 0 }, { x: -1, z: 0 },
      { x: 0, z: 1 }, { x: 0, z: -1 },
    ];
    const target = goal && Number.isFinite(goal.x) && Number.isFinite(goal.z) ? goal : null;
    const candidates = [];
    for (const dir of dirs) {
      const feetPos = p.offset(dir.x, 0, dir.z);
      const feet = bot.blockAt(feetPos, false);
      const head = bot.blockAt(feetPos.offset(0, 1, 0), false);
      const floor = bot.blockAt(feetPos.offset(0, -1, 0), false);
      const floorHeight = floor && Array.isArray(floor.shapes)
        ? floor.shapes.reduce((height, shape) => Math.max(height, shape[4] || 0), 0)
        : 0;
      if (!isClearBodyBlock(feet) || !isClearBodyBlock(head)) continue;
      if (!floor || floor.boundingBox !== "block" || floorHeight < 0.5) continue;
      if (feet.name === "lava" || feet.name === "fire" || head.name === "lava" || head.name === "fire") continue;
      const score = target
        ? Math.pow(feetPos.x + 0.5 - (target.x + 0.5), 2) + Math.pow(feetPos.z + 0.5 - (target.z + 0.5), 2)
        : Math.random();
      candidates.push({ pos: feetPos, score });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0] ? candidates[0].pos : null;
  }

  // On a real stall, move toward a block-checked adjacent tile rather than
  // blindly pressing in a randomly rotated direction (which can drive the bot
  // straight into another wall or off an edge). Then rebuild the original goal.
  function escapeBlockedNode() {
    const now = Date.now();
    if (escapeInProgress || !activeGoal || !bot.entity || now - lastEscapeAt < 1800) return;
    if (bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) return;

    escapeInProgress = true;
    lastEscapeAt = now;
    escapeCount++;
    const goalSnapshot = activeGoal;
    const escapeTile = findSafeEscapeTile(goalSnapshot.goal);

    const restoreGoal = () => {
      try {
        if (activeGoal === goalSnapshot && bot.entity) {
          if (goalSnapshot.goal && goalSnapshot.goal.entity && !goalSnapshot.goal.entity.position) {
            activeGoal = null;
            key = null;
          } else {
            lastProgressPosition = bot.entity.position.clone();
            lastProgressAt = Date.now();
            bot.pathfinder.setGoal(goalSnapshot.goal, goalSnapshot.dynamic);
          }
        }
      } catch (e) {
        key = null;
      }
      recoverySwappingGoal = false;
      escapeInProgress = false;
    };

    try {
      recoverySwappingGoal = true;
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      if (!escapeTile) {
        // No adjacent safe floor is known (for example, a ledge or unloaded
        // chunk). Do not blindly walk into unknown space; just replan once.
        setTimeout(restoreGoal, 350);
        return;
      }
      const dx = escapeTile.x + 0.5 - bot.entity.position.x;
      const dz = escapeTile.z + 0.5 - bot.entity.position.z;
      const escapeYaw = Math.atan2(-dx, -dz);
      Promise.resolve(bot.look(escapeYaw, 0, true))
        .catch(() => {})
        .finally(() => {
          if (!bot.entity) return restoreGoal();
          bot.setControlState("forward", true);
          bot.setControlState("sprint", false);
          setTimeout(() => {
            try { bot.setControlState("forward", false); } catch (e) {}
            restoreGoal();
          }, 300);
        });
    } catch (e) {
      restoreGoal();
      key = null;
    }
  }

  const onPathReset = (reason) => {
    if (reason === "stuck") escapeBlockedNode();
  };
  const onPhysicsTick = () => {
    if (!bot.entity || !activeGoal || !bot.pathfinder.goal || escapeInProgress) return;
    if (bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) return;
    let moving = false;
    try { moving = bot.pathfinder.isMoving(); } catch (e) {}
    if (!moving) {
      lastProgressPosition = bot.entity.position.clone();
      lastProgressAt = Date.now();
      return;
    }
    const now = Date.now();
    if (!lastProgressPosition || bot.entity.position.distanceTo(lastProgressPosition) > 0.14) {
      lastProgressPosition = bot.entity.position.clone();
      lastProgressAt = now;
      return;
    }
    // Some collision stalls do not emit path_reset('stuck') promptly. Detect
    // a live goal with no physical displacement and trigger the same recovery.
    if (now - lastProgressAt > 2400) escapeBlockedNode();
  };
  bot.on("path_reset", onPathReset);
  bot.on("physicsTick", onPhysicsTick);
  bot.once("end", () => {
    bot.removeListener("path_reset", onPathReset);
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
          if (!result) return;
          if (result.status === "noPath") finish(new Error("No path to the goal"));
          else if (result.status === "timeout") finish(new Error("Pathfinding timed out"));
        };
        const onGoalUpdated = (nextGoal) => {
          if (recoverySwappingGoal) return;
          if (nextGoal !== goal) finish(new Error("Navigation goal was replaced"));
        };
        const onPathStop = () => finish(new Error("Navigation stopped"));
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
  let lastJump = 0;
  let manual = false;
  let strafeDir = 0;
  let strafeUntil = 0;
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
    manual = false;
    for (const c of ["forward", "back", "left", "right", "sprint"]) {
      if (bot.controlState[c]) bot.setControlState(c, false);
    }
  }

  function jump() {
    lastJump = Date.now();
    bot.setControlState("jump", true);
    setTimeout(() => {
      try {
        bot.setControlState("jump", false);
      } catch (e) {}
    }, 120);
  }

  function hit(target) {
    bot.attack(target);
    lastAttack = Date.now();
  }

  function step(target, opts = {}) {
    if (!target || !target.position || !bot.entity) return;
    const now = Date.now();
    const reach = opts.reach || 3.0;

    ensureWeapon(opts.prefer || "sword");

    const d = reachDistance(bot, target);
    const dy = target.position.y - bot.entity.position.y;
    lookAtPoint(bot, target.position.offset(0, (target.height || 1.8) * 0.6, 0));

    const visible = hasLineOfSight(bot, target);
    const laneClear = hasClearMeleeLane(bot, target);
    const useManual = visible && laneClear &&
      (manual ? d < 5.0 && Math.abs(dy) < 2 : d < 3.8 && Math.abs(dy) < 1.5);
    const cd = cooldownMs(bot.heldItem);
    const chargedIn = Math.max(0, lastAttack + cd + 30 - now);
    const inReach = d <= reach - 0.05;

    if (!useManual) {
      if (manual) release();
      nav.follow(target, 2);
      if (inReach && chargedIn === 0) hit(target);
      return;
    }

    // ---- close range: we drive the controls ourselves ----
    nav.stop();
    manual = true;
    const crit = !!opts.crit;

    // crits can't happen while sprinting; plain hits want the sprint knockback
    setCtl(bot, "sprint", !crit);
    setCtl(bot, "forward", d > (crit ? 2.3 : 1.6));
    setCtl(bot, "back", crit && d < 1.1);

    if (opts.strafe && d < 3.5) {
      if (now > strafeUntil) {
        strafeDir = [-1, 0, 1][Math.floor(Math.random() * 3)];
        strafeUntil = now + 500 + Math.random() * 700;
      }
      setCtl(bot, "left", strafeDir < 0);
      setCtl(bot, "right", strafeDir > 0);
    } else {
      setCtl(bot, "left", false);
      setCtl(bot, "right", false);
    }

    if (!crit) {
      if (inReach && chargedIn === 0) hit(target);
      return;
    }

    // ---- crit logic ----
    const e = bot.entity;
    const inAir = !e.onGround && !e.isInWater && !e.isInLava;
    const falling = inAir && e.velocity.y < -0.03;

    if (falling) {
      if (inReach && chargedIn === 0) hit(target);
    } else if (e.onGround) {
      // A jump needs ~300ms to start falling, so launch when the bar is almost full
      if (d <= reach + 1.0 && chargedIn <= 330 && now - lastJump > 500) {
        jump();
      } else if (inReach && chargedIn === 0 && now - lastAttack > cd + 1200) {
        hit(target); // jumping isn't working (low ceiling, cobweb...) - don't just stand there
      }
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
