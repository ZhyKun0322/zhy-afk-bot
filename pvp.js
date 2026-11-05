"use strict";

const U = require("./combatUtils");

// deps: { nav, melee, say, onEnd(reason), cfg }  (cfg = commands.pvp block)
function createPvp(bot, deps) {
  const { nav, melee, say, onEnd, cfg } = deps;
  const tracker = U.createVelocityTracker();

  let active = false;
  let targetName = null;
  let lostSince = 0;
  let trackedId = null;

  // bow state
  let bowMode = false;
  let drawing = false;
  let drawStart = 0;
  let lastShot = 0;
  let bowItem = null;
  let arrows = 0;
  let lastInv = 0;
  let noArrowsTold = false;
  let strafeDir = 0;
  let strafeUntil = 0;
  let equipping = false;
  let equippingShield = false;
  let shieldBlocking = false;
  let retreating = false;
  let retreatStarted = 0;
  let retreatGoal = null;

  function cancelDraw() {
    if (drawing) {
      try {
        bot.deactivateItem();
      } catch (e) {}
      drawing = false;
    }
  }

  function reset() {
    cancelDraw();
    releaseShield();
    active = false;
    targetName = null;
    lostSince = 0;
    trackedId = null;
    bowMode = false;
    noArrowsTold = false;
    retreating = false;
    retreatStarted = 0;
    retreatGoal = null;
    tracker.reset();
  }

  function start(name) {
    reset();
    active = true;
    targetName = name;
    refreshInventory(true);
    const weapon = U.bestWeapon(bot, cfg["prefer-weapon"]);
    if (!weapon && !(cfg["use-bow"] && bowItem && arrows > 0)) {
      say("I have no sword, axe or bow - I'll have to use my fists.");
    }
  }

  function stop() {
    nav.stop();
    melee.release();
    releaseShield();
    reset();
    for (const c of ["left", "right", "forward", "back", "sprint"]) {
      if (bot.controlState[c]) bot.setControlState(c, false);
    }
  }

  function isActive() {
    return active;
  }

  function currentTarget() {
    return targetName;
  }

  function refreshInventory(force) {
    const now = Date.now();
    if (!force && now - lastInv < 500) return;
    lastInv = now;
    bowItem = U.findBow(bot);
    arrows = U.countArrows(bot);
  }

  function offhandItem() {
    return bot.inventory && bot.inventory.slots ? bot.inventory.slots[45] || null : null;
  }

  function ensureShield() {
    if (cfg["use-shield"] === false || equippingShield) return;
    const offhand = offhandItem();
    if (offhand && offhand.name === "shield") return;
    const shield = bot.inventory.items().find((item) => item.name === "shield");
    if (!shield) return;
    equippingShield = true;
    bot.equip(shield, "off-hand")
      .catch(() => {})
      .finally(() => {
        equippingShield = false;
      });
  }

  function releaseShield() {
    if (!shieldBlocking) return;
    shieldBlocking = false;
    try {
      bot.deactivateItem();
    } catch (e) {}
  }

  function targetFacingBot(target) {
    if (!target || !bot.entity || !Number.isFinite(target.yaw)) return false;
    const dx = bot.entity.position.x - target.position.x;
    const dz = bot.entity.position.z - target.position.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) return true;
    // Minecraft yaw 0 faces north (-Z).
    const facingX = -Math.sin(target.yaw);
    const facingZ = -Math.cos(target.yaw);
    return (facingX * dx + facingZ * dz) / length > 0.2;
  }

  function shieldStep(target, distance, enabled) {
    const canBlock = enabled && cfg["use-shield"] !== false &&
      offhandItem() && offhandItem().name === "shield" &&
      distance <= 5.2 && targetFacingBot(target);
    if (canBlock && !shieldBlocking) {
      try {
        bot.activateItem(true);
        shieldBlocking = true;
      } catch (e) {}
    } else if (!canBlock) {
      releaseShield();
    }
  }

  function retreatStep(target, now) {
    const health = Number(bot.health);
    const food = Number(bot.food);
    const lowHealth = Number.isFinite(health) && health <= (cfg["retreat-health"] || 10);
    if (!retreating && lowHealth) {
      retreating = true;
      retreatStarted = now;
      retreatGoal = null;
      say("Low health! Retreating to eat and recover.");
    }

    if (!retreating) return false;
    if (health >= (cfg["recover-health"] || 16) && food >= 18) {
      retreating = false;
      retreatStarted = 0;
      retreatGoal = null;
      nav.stop();
      say("Recovered! Returning to the fight.");
      return false;
    }

    // Keep a stable retreat waypoint; moving it every tick would continually
    // reset pathfinding and prevent the bot from reaching safety.
    const targetDistance = bot.entity.position.distanceTo(target.position);
    if (!retreatGoal || targetDistance < 7 || bot.entity.position.distanceTo(retreatGoal) < 3) {
      const dx = bot.entity.position.x - target.position.x;
      const dz = bot.entity.position.z - target.position.z;
      const length = Math.max(0.001, Math.hypot(dx, dz));
      retreatGoal = {
        x: bot.entity.position.x + (dx / length) * 12,
        y: bot.entity.position.y,
        z: bot.entity.position.z + (dz / length) * 12,
      };
    }
    nav.goto(retreatGoal.x, retreatGoal.y, retreatGoal.z, 2);
    shieldStep(target, targetDistance, true);

    if (now - retreatStarted > 45000 && health > 0 && health <= 10) {
      // Do not blindly resume at critical health. Stay defensive until recovery.
      say("Still recovering; keeping distance from the target.");
      retreatStarted = now;
    }
    return true;
  }

  async function equipBow() {
    if (equipping || !bowItem) return;
    equipping = true;
    try {
      await bot.equip(bowItem, "hand");
    } catch (e) {
      /* ignore */
    } finally {
      equipping = false;
    }
  }

  function strafe(now, enabled) {
    if (!enabled) {
      U.setCtl(bot, "left", false);
      U.setCtl(bot, "right", false);
      return;
    }
    if (now > strafeUntil) {
      strafeDir = [-1, 0, 1][Math.floor(Math.random() * 3)];
      strafeUntil = now + 600 + Math.random() * 800;
    }
    U.setCtl(bot, "left", strafeDir < 0);
    U.setCtl(bot, "right", strafeDir > 0);
  }

  function bowStep(target, d, now) {
    releaseShield();
    melee.release();

    // A target behind a wall/house is not a reason to stand still and wait.
    // Keep a close follow goal so the pathfinder can move around the obstacle.
    if (!U.hasLineOfSight(bot, target)) {
      cancelDraw();
      nav.follow(target, 1.1);
      return;
    }

    if (!bot.heldItem || bot.heldItem.name !== "bow") {
      cancelDraw();
      equipBow();
      return;
    }

    // too far away - walk closer, no shooting
    if (d > cfg["bow-max-range"]) {
      cancelDraw();
      nav.follow(target, Math.max(10, cfg["bow-max-range"] - 8));
      return;
    }

    const origin = bot.entity.position.offset(0, bot.entity.height - 0.1, 0);
    const aim = U.computeAim(origin, target.position, tracker.get(), 1.0, cfg["aim-latency-ticks"]);
    if (!aim) {
      cancelDraw();
      nav.follow(target, 12); // out of arrow range (or too steep) - reposition
      return;
    }

    // Stop only after the shot lane is visibly clear; do not combine manual
    // strafing with pathfinder navigation near buildings and obstacles.
    nav.stop();
    U.look(bot, aim.yaw, aim.pitch);

    if (!drawing) {
      if (now - lastShot < 350) return;
      if (!U.hasLineOfSight(bot, target)) return; // wait for a clear shot
      bot.activateItem();
      drawing = true;
      drawStart = now;
    } else if (now - drawStart >= cfg["bow-draw-ms"]) {
      bot.deactivateItem();
      drawing = false;
      lastShot = now;
      arrows = Math.max(0, arrows - 1);
    }
  }

  function tick() {
    if (!active || !bot.entity) return;
    const now = Date.now();
    // Eating/equipping can end off-hand use; allow the shield to be raised again.
    if (shieldBlocking && !bot.usingHeldItem) shieldBlocking = false;

    const rec = U.findPlayer(bot, targetName);
    const target = rec && rec.entity;
    if (!target || !target.position) {
      if (!lostSince) lostSince = now;
      if (now - lostSince > 10000) {
        say("I lost " + targetName + ", stopping PvP.");
        onEnd("lost");
      }
      return;
    }
    lostSince = 0;

    if (trackedId !== target.id) {
      trackedId = target.id;
      tracker.reset();
    }
    tracker.push(target.position);

    const d = bot.entity.position.distanceTo(target.position);
    refreshInventory(false);
    ensureShield();

    if (retreatStep(target, now)) return;

    const canBow = cfg["use-bow"] && bowItem && arrows > 0;
    let wantBow = false;
    if (canBow) wantBow = bowMode ? d >= cfg["bow-min-range"] - 3 : d >= cfg["bow-min-range"];

    if (!canBow && bowMode && cfg["use-bow"] && bowItem && !noArrowsTold) {
      noArrowsTold = true;
      say("Out of arrows, switching to melee.");
    }
    if (canBow) noArrowsTold = false;

    if (wantBow) {
      bowMode = true;
      bowStep(target, d, now);
      return;
    }

    if (bowMode) {
      bowMode = false;
      cancelDraw();
      U.setCtl(bot, "left", false);
      U.setCtl(bot, "right", false);
    }

    // Raise the off-hand shield when the opponent is close and facing the bot.
    // Melee attacks still run below, so the bot does not just stand and block.
    shieldStep(target, d, true);

    melee.step(target, {
      crit: cfg["crit-jumps"],
      strafe: cfg.strafe,
      prefer: cfg["prefer-weapon"],
      reach: cfg.reach,
    });
  }

  // call when any entity dies
  function onEntityDead(entity) {
    if (!active || !entity || entity.type !== "player") return;
    const rec = U.findPlayer(bot, targetName);
    if (rec && rec.entity && rec.entity.id === entity.id) {
      say("GG " + targetName + "!");
      onEnd("dead");
    }
  }

  return { start, stop, tick, isActive, currentTarget, onEntityDead };
}

module.exports = { createPvp };
