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
    active = false;
    targetName = null;
    lostSince = 0;
    trackedId = null;
    bowMode = false;
    noArrowsTold = false;
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
    nav.stop();
    melee.release();

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

    U.look(bot, aim.yaw, aim.pitch);
    strafe(now, cfg.strafe && !drawing);

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
