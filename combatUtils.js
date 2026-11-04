"use strict";

const { goals } = require("mineflayer-pathfinder");

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
  let lastFollowPosition = null;
  let lastFollowProgress = 0;
  let lastFollowRecovery = 0;
  let gotoState = null;
  let lastGotoPosition = null;
  let lastGotoProgress = 0;
  let lastGotoRecovery = 0;

  function followGoal(entity, range) {
    return new goals.GoalFollow(entity, range);
  }

  return {
    follow(entity, range = 2) {
      const k = "f:" + entity.id + ":" + range;
      if (k !== key) {
        key = k;
        followState = { entity, range };
        gotoState = null;
        lastGotoPosition = null;
        lastFollowPosition = bot.entity && bot.entity.position.clone();
        lastFollowProgress = Date.now();
        lastFollowRecovery = 0;
        bot.pathfinder.setGoal(followGoal(entity, range), true);
        return;
      }

      // GoalFollow is dynamic, but the path executor can remain wedged against
      // a collision edge or a closed interactable block. Re-issue the goal if
      // the target is still out of range and the bot has not made progress.
      if (!followState || !bot.entity || !entity.position) return;
      const now = Date.now();
      const position = bot.entity.position;
      const moved = lastFollowPosition ? position.distanceTo(lastFollowPosition) : 0;
      if (moved >= 0.12) {
        lastFollowPosition = position.clone();
        lastFollowProgress = now;
      }

      const distance = position.distanceTo(entity.position);
      if (distance <= range + 0.8) {
        lastFollowPosition = position.clone();
        lastFollowProgress = now;
        return;
      }

      if (now - lastFollowProgress > 2200 && now - lastFollowRecovery > 2200) {
        lastFollowRecovery = now;
        lastFollowProgress = now;
        lastFollowPosition = position.clone();
        try {
          bot.pathfinder.setGoal(null);
          bot.pathfinder.setGoal(followGoal(entity, range), true);
        } catch (e) {
          // A new path will be attempted on the next follow tick.
          key = null;
        }
      }
    },
    goto(x, y, z, range = 1) {
      const nextKey = "g:" + Math.floor(x) + "," + Math.floor(y) + "," + Math.floor(z) + ":" + range;
      const now = Date.now();
      if (nextKey !== key) {
        key = nextKey;
        followState = null;
        lastFollowPosition = null;
        gotoState = { x, y, z, range };
        lastGotoPosition = bot.entity && bot.entity.position.clone();
        lastGotoProgress = now;
        lastGotoRecovery = 0;
        bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
        return;
      }

      // Static destinations (such as a PvP retreat point) need the same
      // stuck recovery as dynamic follow goals.
      if (!gotoState || !bot.entity) return;
      const position = bot.entity.position;
      const moved = lastGotoPosition ? position.distanceTo(lastGotoPosition) : 0;
      if (moved >= 0.12) {
        lastGotoPosition = position.clone();
        lastGotoProgress = now;
      }
      const distance = position.distanceTo({ x: gotoState.x, y: gotoState.y, z: gotoState.z });
      if (distance <= gotoState.range + 0.8) {
        lastGotoPosition = position.clone();
        lastGotoProgress = now;
        return;
      }
      if (now - lastGotoProgress > 2200 && now - lastGotoRecovery > 2200) {
        lastGotoRecovery = now;
        lastGotoProgress = now;
        lastGotoPosition = position.clone();
        try {
          bot.pathfinder.setGoal(null);
          bot.pathfinder.setGoal(new goals.GoalNear(gotoState.x, gotoState.y, gotoState.z, gotoState.range));
        } catch (e) {
          key = null;
        }
      }
    },
    stop() {
      if (key !== null) {
        key = null;
        followState = null;
        lastFollowPosition = null;
        gotoState = null;
        lastGotoPosition = null;
        bot.pathfinder.setGoal(null);
      }
    },
    forget() {
      key = null;
      followState = null;
      lastFollowPosition = null;
      gotoState = null;
      lastGotoPosition = null;
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

    const useManual = manual ? d < 5.0 && Math.abs(dy) < 2 : d < 3.8 && Math.abs(dy) < 1.5;
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
  setCtl,
  look,
  lookAtPoint,
  reachDistance,
  createNav,
  createMelee,
};
