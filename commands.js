"use strict";

const fs = require("fs");
const path = require("path");
const { goals } = require("mineflayer-pathfinder");
const U = require("./combatUtils");
const { createPvp } = require("./pvp");

const HOME_FILE = path.join(__dirname, "bot-home.json");

// Shared state - lives outside the bot object so it survives reconnects
const ctx = {
  mode: "idle", // idle | wood | follow | kill | guard | pvp
  owner: null, // player the current mode is tied to
  home: null, // { x, y, z } fixed position saved with !radius
  eating: false, // set by auto-eat so combat doesn't fight the eating
  pickup: false, // collecting drops
  autoSleep: false, // !sleep toggles automatic night-time bed use
  sleepNavigating: false,
  autoArmor: false, // !armor toggles armor + shield equipment
  token: 0, // bumps on every mode change - cancels old async loops
};

const DEFAULTS = {
  enabled: true,
  prefix: "!",
  owners: [],
  wood: { radius: 48, "natural-only": true },
  kill: { radius: 100, animals: ["pig", "cow", "sheep", "chicken"] },
  guard: { radius: 10 },
  home: { leash: 2 },
  pvp: {
    "prefer-weapon": "sword",
    "crit-jumps": true,
    strafe: true,
    reach: 3.0,
    "use-bow": true,
    "bow-min-range": 8,
    "bow-max-range": 30,
    "bow-draw-ms": 1100,
    "aim-latency-ticks": 2,
    "use-shield": true,
    "retreat-health": 10,
    "recover-health": 16,
  },
};

function buildConfig(user) {
  const u = user || {};
  const cfg = {};
  for (const k of Object.keys(DEFAULTS)) {
    const d = DEFAULTS[k];
    if (d && typeof d === "object" && !Array.isArray(d)) cfg[k] = Object.assign({}, d, u[k] || {});
    else cfg[k] = u[k] !== undefined ? u[k] : d;
  }
  return cfg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isIdle() {
  return ctx.mode === "idle";
}
function hasHome() {
  return ctx.home !== null;
}
// true when the bot should stand still instead of wandering (anti-AFK circle walk etc.)
function isStationary() {
  return ctx.mode !== "idle" || ctx.home !== null || ctx.sleepNavigating;
}

function loadHome(config) {
  try {
    const saved = JSON.parse(fs.readFileSync(HOME_FILE, "utf8"));
    if (saved && saved.server === config.server.ip + ":" + config.server.port && saved.pos) {
      ctx.home = saved.pos;
    }
  } catch (e) {
    /* no saved home */
  }
}

function saveHome(config) {
  try {
    if (ctx.home) {
      fs.writeFileSync(
        HOME_FILE,
        JSON.stringify({ server: config.server.ip + ":" + config.server.port, pos: ctx.home }),
      );
    } else if (fs.existsSync(HOME_FILE)) {
      fs.unlinkSync(HOME_FILE);
    }
  } catch (e) {
    /* read-only filesystem is fine, home just won't survive a restart */
  }
}

// Pulls "Name" and "!command ..." out of plugin-formatted chat lines such as
//   <Name> !cmd | Name: !cmd | [Rank] Name » !cmd
const CHAT_RE = /^(?:\[[^\]]*\]\s*)*<?(\.?\w{2,16})>?\s*(?:[:»›]|>)?\s*(!\S.*)$/;
function parseChatLine(line) {
  const m = CHAT_RE.exec(String(line).trim());
  return m ? { username: m[1], message: m[2] } : null;
}

function initCommands(bot, mcData, defaultMove, deps) {
  const { addInterval, addLog, config } = deps;
  const cfg = buildConfig(config.commands);
  if (!cfg.enabled) return;

  const log = (m) => addLog("[Cmd] " + m);

  if (ctx.home === null) loadHome(config);
  ctx.mode = "idle";
  ctx.owner = null;
  ctx.eating = false;
  ctx.pickup = false;
  ctx.sleepNavigating = false;
  ctx.token++;

  bot.pathfinder.setMovements(defaultMove);
  const nav = U.createNav(bot);
  const melee = U.createMelee(bot, nav);

  // ---------- chat output (throttled so we don't get kicked for spam) ----------
  let sayQueue = [];
  let sayTimer = null;
  function pump() {
    const m = sayQueue.shift();
    if (m === undefined) {
      sayTimer = null;
      return;
    }
    try {
      bot.chat(m);
    } catch (e) {}
    sayTimer = setTimeout(pump, 1100);
  }
  function say(msg) {
    sayQueue.push(String(msg).slice(0, 250));
    if (!sayTimer) pump();
  }
  bot.once("end", () => {
    ctx.token++;
    if (sayTimer) clearTimeout(sayTimer);
    sayQueue = [];
    sayTimer = null;
  });

  // ---------- mode bookkeeping ----------
  const killState = { target: null, lastScan: 0, emptyScans: 0, kills: 0 };
  let lostWarnAt = 0;

  const pvp = createPvp(bot, {
    nav,
    melee,
    say,
    cfg: cfg.pvp,
    onEnd: () => stopMode(false),
  });

  // ---------- armor helpers ----------
  const armorSlots = [
    { destination: "head", slot: 5, test: (name) => /_(helmet|cap)$/.test(name) || name === "turtle_helmet" },
    { destination: "torso", slot: 6, test: (name) => /_chestplate$/.test(name) || name === "elytra" },
    { destination: "legs", slot: 7, test: (name) => /_leggings$/.test(name) },
    { destination: "feet", slot: 8, test: (name) => /_boots$/.test(name) },
  ];
  const armorMaterialRank = {
    netherite: 7,
    diamond: 6,
    iron: 5,
    chainmail: 4,
    gold: 3,
    golden: 3,
    turtle: 3,
    leather: 2,
  };
  let armorBusy = false;

  function armorScore(item) {
    if (!item) return 0;
    const name = item.name || "";
    const material = Object.keys(armorMaterialRank).find((m) => name.startsWith(m + "_"));
    return material ? armorMaterialRank[material] : name === "elytra" ? 1 : 0;
  }

  function itemInEquipmentSlot(slot) {
    return bot.inventory && bot.inventory.slots ? bot.inventory.slots[slot] || null : null;
  }

  async function equipBestArmor() {
    if (armorBusy || !bot.entity) return;
    armorBusy = true;
    try {
      for (const rule of armorSlots) {
        const best = bot.inventory.items()
          .filter((item) => rule.test(item.name))
          .sort((a, b) => armorScore(b) - armorScore(a))[0];
        const current = itemInEquipmentSlot(rule.slot);
        if (best && armorScore(best) > armorScore(current)) {
          await bot.equip(best, rule.destination);
        }
      }

      const shield = bot.inventory.items().find((item) => item.name === "shield");
      const offhand = itemInEquipmentSlot(45);
      if (shield && (!offhand || offhand.name !== "shield")) {
        await bot.equip(shield, "off-hand");
      }
    } catch (e) {
      log("armor equip error: " + e.message);
    } finally {
      armorBusy = false;
    }
  }

  async function unequipArmor() {
    if (armorBusy || !bot.entity) return;
    armorBusy = true;
    try {
      for (const destination of ["head", "torso", "legs", "feet", "off-hand"]) {
        try {
          await bot.unequip(destination);
        } catch (e) {
          // An empty equipment slot is normal.
        }
      }
    } finally {
      armorBusy = false;
    }
  }

  // Keep the best available gear equipped while !armor is enabled.
  addInterval(() => {
    if (ctx.autoArmor && bot.entity && !ctx.eating) equipBestArmor();
  }, 5000);

  // ---------- automatic sleeping ----------
  let sleepAttempt = false;
  let sleepBedKey = null;
  let lastBedSearch = 0;
  let lastNoBedNotice = 0;

  function isNight() {
    const timeOfDay = bot.time && Number(bot.time.timeOfDay);
    return Number.isFinite(timeOfDay) && timeOfDay >= 12542 && timeOfDay <= 23460;
  }

  async function autoSleepTick() {
    if (!ctx.autoSleep || !bot.entity) {
      return;
    }
    if (bot.isSleeping || sleepAttempt) return;
    if (!isNight()) {
      if (ctx.sleepNavigating) {
        ctx.sleepNavigating = false;
        sleepBedKey = null;
        if (ctx.home) goHome();
        else bot.pathfinder.setGoal(null);
      }
      return;
    }
    // Do not interrupt active combat, harvesting, or player-follow commands.
    if (ctx.mode !== "idle" || ctx.eating || ctx.pickup || bot.currentWindow) return;
    const now = Date.now();
    if (now - lastBedSearch < 5000) return;
    lastBedSearch = now;

    const bed = bot.findBlock({
      matching: (block) => block && typeof bot.isABed === "function" && bot.isABed(block),
      maxDistance: 16,
    });
    if (!bed) {
      if (ctx.sleepNavigating) {
        ctx.sleepNavigating = false;
        sleepBedKey = null;
        bot.pathfinder.setGoal(null);
      }
      if (now - lastNoBedNotice > 60000) {
        lastNoBedNotice = now;
        say("Auto-sleep is on, but I can't find a bed within 16 blocks.");
      }
      return;
    }

    const distance = bot.entity.position.distanceTo(bed.position);
    const bedKey = `${bed.position.x},${bed.position.y},${bed.position.z}`;
    if (distance > 3.2) {
      ctx.sleepNavigating = true;
      if (sleepBedKey !== bedKey) {
        sleepBedKey = bedKey;
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1));
        } catch (e) {
          ctx.sleepNavigating = false;
          sleepBedKey = null;
        }
      }
      return;
    }

    sleepAttempt = true;
    ctx.sleepNavigating = true; // keep anti-AFK movement from interrupting the sleep action
    sleepBedKey = null;
    try {
      bot.pathfinder.setGoal(null);
      await bot.sleep(bed);
      say("Sleeping now.");
    } catch (e) {
      // Server may deny sleep because it is not quite night or monsters are nearby.
      ctx.sleepNavigating = false;
    } finally {
      sleepAttempt = false;
    }
  }

  addInterval(() => {
    autoSleepTick().catch((e) => log("auto-sleep error: " + e.message));
  }, 2500);

  bot.on("wake", () => {
    ctx.sleepNavigating = false;
    sleepBedKey = null;
  });

  async function dropAllInventory() {
    if (!bot.entity) return;
    // Stop jobs and auto-equipping first so nothing fights the drop operation.
    stopMode(true);
    ctx.autoArmor = false;
    ctx.sleepNavigating = false;
    sleepBedKey = null;
    try {
      bot.pathfinder.setGoal(null);
    } catch (e) {}

    let droppedStacks = 0;
    let droppedItems = 0;
    async function tossStoredItems() {
      // Re-read the inventory after every toss because slot references shift.
      for (let guard = 0; guard < 80; guard++) {
        const item = bot.inventory.items()[0];
        if (!item) break;
        const count = item.count || 1;
        await bot.tossStack(item);
        droppedStacks++;
        droppedItems += count;
        await sleep(80);
      }
    }

    try {
      // Clear normal slots first, making room for armor that is unequipped next.
      if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow); } catch (e) {}
      }
      await tossStoredItems();
      for (const destination of ["head", "torso", "legs", "feet", "off-hand"]) {
        try {
          await bot.unequip(destination);
          await sleep(80);
          await tossStoredItems();
        } catch (e) {
          // Empty equipment slots are expected.
        }
      }
      await tossStoredItems();
      say("Dropped " + droppedItems + " items in " + droppedStacks + " stacks, including equipped armor and off-hand.");
    } catch (e) {
      say("Inventory drop stopped: " + e.message);
      log("inventory drop error: " + e.message);
    }
  }

  function startMode(mode, owner) {
    stopMode(true);
    ctx.sleepNavigating = false;
    sleepBedKey = null;
    ctx.mode = mode;
    ctx.owner = owner || null;
    killState.target = null;
    killState.emptyScans = 0;
    killState.kills = 0;
    // anti-AFK keeps the bot sneaking - that would cripple every mode below
    try {
      bot.setControlState("sneak", false);
    } catch (e) {}
    return ctx.token;
  }

  function stopMode(silent) {
    ctx.token++; // cancels async loops (wood, pickup)
    ctx.mode = "idle";
    ctx.owner = null;
    ctx.pickup = false;
    killState.target = null;
    try {
      pvp.stop();
      melee.release();
      nav.stop();
      bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      bot.deactivateItem();
    } catch (e) {}
    if (config.utils["anti-afk"] && config.utils["anti-afk"].enabled && config.utils["anti-afk"].sneak) {
      try {
        bot.setControlState("sneak", true);
      } catch (e) {}
    }
    if (!silent && ctx.home) goHome();
  }

  function goHome() {
    if (!ctx.home || !bot.entity) return;
    const h = ctx.home;
    nav.forget();
    bot.pathfinder.setGoal(new goals.GoalNear(h.x, h.y, h.z, 1));
  }

  // keeps the bot on its fixed position while idle
  addInterval(() => {
    if (ctx.mode !== "idle" || !ctx.home || ctx.eating || !bot.entity) return;
    const p = bot.entity.position;
    const h = ctx.home;
    const d = Math.hypot(p.x - (h.x + 0.5), p.z - (h.z + 0.5)) + Math.abs(p.y - h.y) * 0.5;
    if (d > cfg.home.leash && !bot.pathfinder.isMoving()) goHome();
  }, 2000);

  // ---------- small helpers ----------
  function playerEntity(name) {
    const rec = U.findPlayer(bot, name);
    return rec && rec.entity ? rec.entity : null;
  }

  function gotoTimeout(goal, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!ok) {
          try { bot.pathfinder.setGoal(null); } catch (e) {}
        }
        nav.forget();
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try {
          bot.pathfinder.setGoal(null);
        } catch (e) {}
        finish(false);
      }, ms);
      nav.gotoGoal(goal)
        .then(() => finish(true))
        .catch(() => finish(false));
    });
  }

  function nearestItem(radius) {
    let best = null;
    let bd = radius;
    for (const e of Object.values(bot.entities)) {
      if (!e.position || (e.name !== "item" && e.displayName !== "Item")) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  async function pickupDrops(token, radius) {
    await sleep(700); // let the drops settle
    for (let i = 0; i < 8 && token === ctx.token; i++) {
      const item = nearestItem(radius);
      if (!item) break;
      const p = item.position;
      await gotoTimeout(new goals.GoalNear(p.x, p.y, p.z, 1), 4000);
      await sleep(150);
    }
  }

  // ============================================================
  // !wood
  // ============================================================
  const isLogName = (n) => /_log$/.test(n) && !/^stripped_/.test(n);
  const logIds = mcData.blocksArray.filter((b) => isLogName(b.name)).map((b) => b.id);
  const leafIds = mcData.blocksArray.filter((b) => /_leaves$/.test(b.name)).map((b) => b.id);

  function nearTreeLeaves(pos) {
    return !!bot.findBlock({ point: pos, matching: leafIds, maxDistance: 5 });
  }

  function pickLog(blacklist) {
    const found = bot.findBlocks({ matching: logIds, maxDistance: cfg.wood.radius, count: 64 });
    const scored = [];
    for (const p of found) {
      const k = p.x + "," + p.y + "," + p.z;
      if (blacklist.has(k)) continue;
      const below = bot.blockAt(p.offset(0, -1, 0));
      // prefer the bottom log of a trunk - the bot can only reach so high
      const score = bot.entity.position.distanceTo(p) + (below && isLogName(below.name) ? 5 : 0);
      scored.push({ p, k, score });
    }
    scored.sort((a, b) => a.score - b.score);
    for (const s of scored.slice(0, 12)) {
      if (cfg.wood["natural-only"] && !nearTreeLeaves(s.p)) {
        blacklist.add(s.k); // looks like part of a build, not a tree - leave it alone
        continue;
      }
      return { block: bot.blockAt(s.p), key: s.k };
    }
    return null;
  }

  async function chop(block, token) {
    const axe = bot.inventory
      .items()
      .filter((i) => /_axe$/.test(i.name))
      .sort((a, b) => (U.parseWeapon(b) ? U.parseWeapon(b).rank : 0) - (U.parseWeapon(a) ? U.parseWeapon(a).rank : 0))[0];
    if (axe && (!bot.heldItem || bot.heldItem.name !== axe.name)) {
      await bot.equip(axe, "hand").catch(() => {});
    }
    if (!bot.canDigBlock(block)) {
      const p = block.position;
      const ok = await gotoTimeout(new goals.GoalNear(p.x, p.y, p.z, 3), 12000);
      if (token !== ctx.token || !ok) return false;
    }
    const fresh = bot.blockAt(block.position);
    if (!fresh || !isLogName(fresh.name) || !bot.canDigBlock(fresh)) return false;
    try {
      await bot.dig(fresh);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function woodLoop(token, limit) {
    const blacklist = new Set();
    let mined = 0;
    let reason = "";
    while (token === ctx.token) {
      if (limit && mined >= limit) {
        reason = "Reached " + limit + " logs.";
        break;
      }
      if (bot.inventory.emptySlotCount() === 0) {
        reason = "Inventory is full.";
        break;
      }
      const pick = pickLog(blacklist);
      if (!pick || !pick.block) {
        reason = "No more trees within " + cfg.wood.radius + " blocks.";
        break;
      }
      const ok = await chop(pick.block, token);
      if (token !== ctx.token) return;
      if (ok) {
        mined++;
        await pickupDrops(token, 6);
      } else {
        blacklist.add(pick.key);
      }
    }
    if (token === ctx.token) {
      say("Wood done: " + mined + " logs. " + reason);
      stopMode(false);
    }
  }

  // ============================================================
  // !kill  (pig, cow, sheep, chicken)
  // ============================================================
  function nearestAnimal() {
    let best = null;
    let bd = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (!e.position || e === bot.entity || !cfg.kill.animals.includes(e.name)) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d <= cfg.kill.radius && d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  function killTarget(target) {
    const token = ctx.token;
    killState.target = null;
    killState.kills++;
    ctx.pickup = true;
    pickupDrops(token, 8).then(() => {
      if (token === ctx.token) ctx.pickup = false;
    });
  }

  function killTick() {
    if (ctx.pickup) return;
    const now = Date.now();
    let t = killState.target;
    if (t && !bot.entities[t.id]) {
      killTarget(t);
      return;
    }
    if (!t) {
      if (now - killState.lastScan < 500) return;
      killState.lastScan = now;
      t = nearestAnimal();
      if (!t) {
        killState.emptyScans++;
        if (killState.emptyScans >= 6) {
          say("No more animals in range. Killed " + killState.kills + ".");
          stopMode(false);
        }
        return;
      }
      killState.emptyScans = 0;
      killState.target = t;
    }
    melee.step(t, { crit: false, prefer: "sword" });
  }

  // ============================================================
  // !follow
  // ============================================================
  function followTick() {
    const ent = playerEntity(ctx.owner);
    if (!ent) {
      const now = Date.now();
      if (now - lostWarnAt > 20000) {
        lostWarnAt = now;
        say("I can't see " + ctx.owner + " - get closer so I can follow.");
      }
      return;
    }
    nav.follow(ent, 2);
  }

  // ============================================================
  // !guard
  // ============================================================
  function guardTick() {
    const player = playerEntity(ctx.owner);
    if (!player) {
      const now = Date.now();
      if (now - lostWarnAt > 20000) {
        lostWarnAt = now;
        say("I can't see " + ctx.owner + " - get closer so I can guard you.");
      }
      return;
    }
    let threat = null;
    let best = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (!e.position || !U.isHostile(e)) continue;
      const d = e.position.distanceTo(player.position);
      if (d <= cfg.guard.radius && d < best) {
        best = d;
        threat = e;
      }
    }
    if (threat) {
      melee.step(threat, { crit: false, prefer: "sword" });
    } else {
      melee.release();
      nav.follow(player, 3);
    }
  }

  // ============================================================
  // main tick - runs every physics tick (20x / second)
  // ============================================================
  bot.on("physicsTick", () => {
    if (ctx.mode === "idle" || ctx.eating || !bot.entity) return;
    try {
      switch (ctx.mode) {
        case "follow":
          followTick();
          break;
        case "kill":
          killTick();
          break;
        case "guard":
          guardTick();
          break;
        case "pvp":
          pvp.tick();
          break;
      }
    } catch (e) {
      log("tick error (" + ctx.mode + "): " + e.message);
    }
  });

  bot.on("entityDead", (entity) => {
    if (ctx.mode === "pvp") pvp.onEntityDead(entity);
    if (ctx.mode === "kill" && killState.target && entity && entity.id === killState.target.id) {
      killTarget(entity);
    }
  });

  bot.on("death", () => {
    if (ctx.mode !== "idle") {
      log("Bot died - stopping " + ctx.mode);
      stopMode(true);
    }
  });

  // ============================================================
  // command dispatcher
  // ============================================================
  function isAllowed(username) {
    if (!cfg.owners.length) return true;
    const u = U.normalizeName(username);
    return cfg.owners.some((o) => U.normalizeName(o) === u);
  }

  function run(name, args, username) {
    switch (name) {
      case "help":
        say("!wood [n] !follow !kill !guard !unguard !pvp [name] !sleep !armor !inventory !radius !unsave !stop");
        return;

      case "stop":
        stopMode(false);
        say("Stopped.");
        return;

      case "radius": {
        const p = bot.entity.position;
        ctx.home = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
        saveHome(config);
        say("Fixed position saved: " + ctx.home.x + " " + ctx.home.y + " " + ctx.home.z);
        return;
      }

      case "unsave":
        if (!ctx.home) {
          say("No fixed position was saved.");
          return;
        }
        ctx.home = null;
        saveHome(config);
        if (ctx.mode === "idle") {
          bot.pathfinder.setGoal(null);
        }
        say("Fixed position cleared.");
        return;

      case "sleep": {
        ctx.autoSleep = !ctx.autoSleep;
        if (ctx.autoSleep) {
          say("Auto-sleep enabled. I'll look for a nearby bed at night. Type !sleep again to disable it.");
          autoSleepTick().catch((e) => log("auto-sleep error: " + e.message));
        } else {
          const wasSleepNavigating = ctx.sleepNavigating;
          ctx.sleepNavigating = false;
          sleepBedKey = null;
          try {
            // Only clear the pathfinder goal when it belongs to auto-sleep.
            if (wasSleepNavigating && ctx.mode === "idle") {
              bot.pathfinder.setGoal(null);
              if (ctx.home) goHome();
            }
            if (bot.isSleeping) bot.wake().catch(() => {});
          } catch (e) {}
          say("Auto-sleep disabled.");
        }
        return;
      }

      case "armor":
        ctx.autoArmor = !ctx.autoArmor;
        if (ctx.autoArmor) {
          say("Auto-armor enabled. Equipping the best armor and shield available.");
          equipBestArmor().catch((e) => log("armor equip error: " + e.message));
        } else {
          say("Auto-armor disabled. Unequipping armor and off-hand shield.");
          unequipArmor().catch((e) => log("armor unequip error: " + e.message));
        }
        return;

      case "inventory":
        say("Dropping everything from my inventory and equipment...");
        dropAllInventory().catch((e) => log("inventory drop error: " + e.message));
        return;

      case "wood": {
        if (ctx.mode === "wood") {
          stopMode(false);
          say("Stopped chopping.");
          return;
        }
        const limit = parseInt(args[0], 10) || 0;
        const token = startMode("wood", username);
        say("Chopping trees" + (limit ? " (" + limit + " logs)" : "") + ".");
        woodLoop(token, limit).catch((e) => {
          log("wood error: " + e.message);
          if (token === ctx.token) stopMode(false);
        });
        return;
      }

      case "follow":
        if (ctx.mode === "follow" && ctx.owner === username) {
          stopMode(false);
          say("Stopped following.");
          return;
        }
        if (!playerEntity(username)) {
          say("I can't see you, " + username + ".");
          return;
        }
        startMode("follow", username);
        say("Following " + username + ".");
        return;

      case "kill":
        if (ctx.mode === "kill") {
          const n = killState.kills;
          stopMode(false);
          say("Stopped hunting. Killed " + n + ".");
          return;
        }
        startMode("kill", username);
        say("Hunting pigs, cows, sheep and chickens within " + cfg.kill.radius + " blocks.");
        return;

      case "guard":
        if (!playerEntity(username)) {
          say("I can't see you, " + username + ".");
          return;
        }
        startMode("guard", username);
        say("Guarding " + username + " (" + cfg.guard.radius + " block radius).");
        return;

      case "unguard":
        if (ctx.mode !== "guard") {
          say("I'm not guarding anyone.");
          return;
        }
        stopMode(false);
        say(ctx.home ? "Guard stopped, heading back to my position." : "Guard stopped.");
        return;

      case "pvp": {
        const arg = args[0];
        if (arg && arg.toLowerCase() === "stop") {
          if (ctx.mode === "pvp") {
            stopMode(false);
            say("PvP stopped.");
          }
          return;
        }
        if (ctx.mode === "pvp" && (!arg || U.normalizeName(arg) === U.normalizeName(pvp.currentTarget()))) {
          stopMode(false);
          say("PvP stopped.");
          return;
        }
        const wanted = arg || username;
        const rec = U.findPlayer(bot, wanted);
        if (!rec || !rec.entity) {
          say("I can't see " + wanted + ".");
          return;
        }
        if (rec.username === bot.username) return;
        startMode("pvp", username);
        pvp.start(rec.username);
        say("PvP vs " + rec.username + "! Type !pvp to stop.");
        return;
      }
    }
  }

  const recent = new Map();
  function handleChat(username, message, source) {
    if (!username || username === bot.username) return;
    if (!message.startsWith(cfg.prefix)) return;

    // the same line can arrive through both 'chat' and 'messagestr' - count it once.
    // (two separate 'chat' events are a player really typing it twice, so those both count)
    const key = username + "|" + message;
    const now = Date.now();
    const prev = recent.get(key);
    if (prev && now - prev.t < 1000 && prev.source !== source) return;
    recent.set(key, { t: now, source });
    if (recent.size > 50) recent.clear();

    if (!isAllowed(username)) {
      log("Ignored '" + message + "' from " + username + " (not in owners)");
      return;
    }
    const parts = message.slice(cfg.prefix.length).trim().split(/\s+/);
    const name = (parts.shift() || "").toLowerCase();
    log(username + " > " + name + (parts.length ? " " + parts.join(" ") : ""));
    try {
      run(name, parts, username);
    } catch (e) {
      log("command '" + name + "' failed: " + e.message);
    }
  }

  bot.on("chat", (username, message) => handleChat(username, message, "chat"));

  // fallback for servers whose chat plugin formats messages as system text
  bot.on("messagestr", (text, position) => {
    if (position === "game_info") return;
    const parsed = parseChatLine(text);
    if (parsed) handleChat(parsed.username, parsed.message, "messagestr");
  });

  log("Commands ready (" + cfg.prefix + "help)." + (ctx.home ? " Fixed position: " + ctx.home.x + " " + ctx.home.y + " " + ctx.home.z : ""));
}

module.exports = { initCommands, isIdle, hasHome, isStationary, ctx, parseChatLine };
