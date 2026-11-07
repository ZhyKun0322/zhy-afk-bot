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
  roam: false, // !roam toggles anti-AFK wandering (off by default: the bot stands still)
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
  return ctx.mode !== "idle" || ctx.home !== null || ctx.sleepNavigating || !ctx.roam;
}
// true only while the player has asked the bot to roam (!roam) and nothing else is running
function isRoaming() {
  return ctx.roam && !isStationary();
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
  const { addInterval, addLog, config, woodMove = defaultMove, rescueMove = null } = deps;
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
  // Alternate-route recovery: after a full round of failed waypoints the nav
  // controller re-plans with the permissive profile and tells the player once.
  nav.setRescueMovements(rescueMove || (woodMove !== defaultMove ? woodMove : null));
  nav.onUnreachable(() => {
    if (ctx.mode === "idle") return;
    say("I can't find a path to you yet - trying other routes.");
  });
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
  const killState = {
    target: null,
    lastScan: 0,
    emptyScans: 0,
    kills: 0,
    lastEmptyNotice: 0,
    lastVisibleCount: 0,
    lastVisibleNames: [],
    lastLostTarget: null,
  };
  let lostWarnAt = 0;

  const pvp = createPvp(bot, {
    nav,
    melee,
    say,
    cfg: cfg.pvp,
    onEnd: () => stopMode(false),
  });

  // Auto-sleep may temporarily preempt a long-running command at night. Save
  // enough information to resume the same task after the bot wakes.
  let sleepResumeState = null;
  let currentWoodLimit = 0;

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
  let lastSleepErrorNotice = 0;
  let sleepRetryAfter = 0;
  const BED_SEARCH_RADIUS = 48;

  function worldTimeOfDay() {
    const raw = bot.time && Number(bot.time.timeOfDay);
    if (!Number.isFinite(raw)) return null;
    return ((raw % 24000) + 24000) % 24000;
  }

  function isNight() {
    const timeOfDay = worldTimeOfDay();
    // Vanilla sleep window: dusk through dawn. This is Minecraft world time,
    // not the host computer's local clock.
    return timeOfDay !== null && timeOfDay >= 12542 && timeOfDay <= 23460;
  }

  function findNearbyBed() {
    return bot.findBlock({
      matching: (block) => block && typeof bot.isABed === "function" && bot.isABed(block),
      maxDistance: BED_SEARCH_RADIUS,
    });
  }

  function pauseModeForSleep() {
    if (ctx.mode === "idle" || sleepResumeState) return;
    const mode = ctx.mode;
    sleepResumeState = {
      mode,
      owner: ctx.owner,
      pvpTarget: mode === "pvp" ? pvp.currentTarget() : null,
      woodLimit: currentWoodLimit,
      kills: killState.kills,
    };
    log("Pausing " + mode + " temporarily so I can sleep; the task will resume after waking.");
    stopMode(true);
    currentWoodLimit = 0;
  }

  function resumeModeAfterSleep() {
    const saved = sleepResumeState;
    if (!saved || !bot.entity) return;
    sleepResumeState = null;
    ctx.sleepNavigating = false;
    sleepBedKey = null;

    try {
      if (saved.mode === "wood") {
        currentWoodLimit = saved.woodLimit || 0;
        const token = startMode("wood", saved.owner);
        woodLoop(token, currentWoodLimit).catch((e) => {
          log("wood resume error: " + e.message);
          if (token === ctx.token) stopMode(false);
        });
      } else if (saved.mode === "pvp") {
        const targetName = saved.pvpTarget;
        if (!targetName) return;
        startMode("pvp", saved.owner);
        pvp.start(targetName);
      } else if (["follow", "kill", "guard"].includes(saved.mode)) {
        startMode(saved.mode, saved.owner);
        if (saved.mode === "kill") killState.kills = saved.kills || 0;
      }
      say("Awake. Resuming " + saved.mode + ".");
    } catch (e) {
      log("could not resume " + saved.mode + " after sleeping: " + e.message);
      say("Awake, but I couldn't resume " + saved.mode + ". Use the command again.");
    }
  }

  function sleepStatusText() {
    const timeOfDay = worldTimeOfDay();
    const bed = bot.entity ? findNearbyBed() : null;
    const bedDistance = bed && bot.entity ? bot.entity.position.distanceTo(bed.position) : null;
    const hasBedItem = !!(bot.inventory && bot.inventory.items().some((item) => /_(bed)$/.test(item.name)));
    return "enabled=" + ctx.autoSleep +
      ", worldTime=" + (timeOfDay === null ? "unknown" : Math.floor(timeOfDay)) +
      ", phase=" + (timeOfDay === null ? "unknown" : (isNight() ? "sleep-window" : "daytime")) +
      ", mode=" + ctx.mode +
      ", bed=" + (bed ? (bed.name + " at " + bed.position.x + "," + bed.position.y + "," + bed.position.z + " (" + bedDistance.toFixed(1) + " blocks)") : "none within " + BED_SEARCH_RADIUS) +
      ", bedItem=" + hasBedItem +
      ", navigating=" + ctx.sleepNavigating +
      ", sleeping=" + !!bot.isSleeping;
  }

  async function autoSleepTick() {
    if (!ctx.autoSleep || !bot.entity || bot.isSleeping || sleepAttempt) return;

    if (!isNight()) {
      if (ctx.sleepNavigating) {
        try { nav.stop(); } catch (e) {}
        ctx.sleepNavigating = false;
        sleepBedKey = null;
        resumeModeAfterSleep();
        if (!sleepResumeState && ctx.mode === "idle" && ctx.home) goHome();
      }
      return;
    }

    // Eating or interacting with a window is a short, non-interruptible action.
    if (ctx.eating || ctx.pickup || bot.currentWindow) return;

    const now = Date.now();
    if (now < sleepRetryAfter || now - lastBedSearch < 5000) return;
    lastBedSearch = now;

    const bed = findNearbyBed();
    if (!bed) {
      if (ctx.sleepNavigating) {
        try { nav.stop(); } catch (e) {}
        ctx.sleepNavigating = false;
        sleepBedKey = null;
        resumeModeAfterSleep();
      }
      if (now - lastNoBedNotice > 60000) {
        lastNoBedNotice = now;
        const hasBedItem = bot.inventory && bot.inventory.items().some((item) => /_(bed)$/.test(item.name));
        say(hasBedItem
          ? "Auto-sleep is on, but I have no placed bed within " + BED_SEARCH_RADIUS + " blocks. Place the bed nearby and I'll use it."
          : "Auto-sleep is on, but there is no placed bed within " + BED_SEARCH_RADIUS + " blocks. I need a bed nearby; a bed item alone is not enough until it is placed.");
      }
      return;
    }

    // Sleep has priority over follow/kill/wood/guard/PvP. Those tasks are
    // suspended cleanly and resumed after the wake event.
    if (ctx.mode !== "idle") pauseModeForSleep();

    const distance = bot.entity.position.distanceTo(bed.position);
    const bedKey = `${bed.position.x},${bed.position.y},${bed.position.z}`;
    if (distance > 2.65) {
      ctx.sleepNavigating = true;
      if (sleepBedKey !== bedKey || !bot.pathfinder.goal) {
        sleepBedKey = bedKey;
        try {
          // Use the shared navigation manager so bed travel gets the same stuck
          // detection, escape candidates and replan handling as follow/PvP.
          nav.goto(bed.position.x, bed.position.y, bed.position.z, 1);
        } catch (e) {
          ctx.sleepNavigating = false;
          sleepBedKey = null;
          resumeModeAfterSleep();
          log("bed navigation error: " + e.message);
        }
      }
      return;
    }

    sleepAttempt = true;
    ctx.sleepNavigating = true;
    sleepBedKey = bedKey;
    try {
      nav.stop();
      // A sneaking player holding any item (e.g. an off-hand shield) cannot
      // activate a bed - the anti-AFK sneak made every attempt fail silently.
      try {
        bot.clearControlStates();
        bot.setControlState("sneak", false);
        bot.setControlState("sprint", false);
      } catch (e) {}
      const freshBed = bot.blockAt(bed.position) || bed;
      const trySleep = async () => {
        try { await bot.lookAt(freshBed.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
        await sleep(350); // let the server see the un-sneak + new rotation first
        await bot.sleep(freshBed);
      };
      try {
        await trySleep();
      } catch (firstError) {
        log("sleep attempt 1 failed: " + String((firstError && firstError.message) || firstError));
        await sleep(900);
        await trySleep(); // one retry before giving up
      }
      say("Sleeping now. I'll resume my previous task when I wake.");
    } catch (e) {
      ctx.sleepNavigating = false;
      sleepBedKey = null;
      // Avoid suspending/resuming the active job every five seconds when the
      // server refuses sleep because a hostile mob is nearby or it is not yet
      // valid to sleep. Retry at a calmer 30-second interval.
      sleepRetryAfter = Date.now() + 30000;
      log("sleep failed: " + String((e && e.message) || e));
      if (now - lastSleepErrorNotice > 30000) {
        lastSleepErrorNotice = now;
        say("I found a bed but couldn't sleep: " + String(e.message || e).slice(0, 120));
      }
      resumeModeAfterSleep();
      if (ctx.mode === "idle" && !ctx.roam && config.utils["anti-afk"] && config.utils["anti-afk"].enabled && config.utils["anti-afk"].sneak) {
        try { bot.setControlState("sneak", true); } catch (e) {}
      }
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
    resumeModeAfterSleep();
    if (ctx.mode === "idle" && !ctx.roam && config.utils["anti-afk"] && config.utils["anti-afk"].enabled && config.utils["anti-afk"].sneak) {
      try { bot.setControlState("sneak", true); } catch (e) {}
    }
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
    // A manually-issued new task supersedes any task saved before an earlier
    // sleep interruption. The next sleep cycle will save this new task instead.
    sleepResumeState = null;
    ctx.sleepNavigating = false;
    sleepBedKey = null;
    if (mode !== "wood") currentWoodLimit = 0;
    if (bot.isSleeping) bot.wake().catch(() => {});
    ctx.mode = mode;
    ctx.owner = owner || null;
    try {
      bot.pathfinder.setMovements(mode === "wood" ? woodMove : defaultMove);
    } catch (e) {
      log("movement profile switch error: " + e.message);
    }
    killState.target = null;
    killState.emptyScans = 0;
    killState.kills = 0;
    killState.lastScan = 0;
    killState.lastEmptyNotice = 0;
    killState.lastVisibleCount = 0;
    killState.lastVisibleNames = [];
    killState.lastLostTarget = null;
    // anti-AFK keeps the bot sneaking - that would cripple every mode below
    try {
      bot.setControlState("sneak", false);
    } catch (e) {}
    return ctx.token;
  }

  function stopMode(silent) {
    ctx.token++; // cancels async loops (wood, pickup)
    ctx.mode = "idle";
    ctx.roam = false;
    ctx.sleepNavigating = false;
    sleepBedKey = null;
    ctx.owner = null;
    ctx.pickup = false;
    killState.target = null;
    try {
      pvp.stop();
      melee.release();
      nav.stop();
      bot.pathfinder.setGoal(null);
      bot.pathfinder.setMovements(defaultMove);
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
    bot.pathfinder.setMovements(defaultMove);
    nav.forget();
    bot.pathfinder.setGoal(new goals.GoalNear(h.x, h.y, h.z, 1));
  }

  // keeps the bot on its fixed position while idle
  addInterval(() => {
    if (ctx.mode !== "idle" || ctx.sleepNavigating || !ctx.home || ctx.eating || !bot.entity) return;
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
        // Cancel the navigation wrapper too, not just the pathfinder goal. This
        // releases gotoGoal listeners and avoids orphaned movement promises.
        try { nav.stop(); } catch (e) {}
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

  function logLookGoal(position) {
    // GoalLookAtBlock plans to a spot from which a face of the log is visible
    // and within reach. Unlike GoalNear(3), this does not declare success while
    // the bot is still too far away or hidden behind leaves.
    if (typeof goals.GoalLookAtBlock === "function" && bot.world) {
      return new goals.GoalLookAtBlock(position, bot.world, {
        reach: 4.5,
        entityHeight: bot.entity ? bot.entity.height : 1.6,
      });
    }
    if (typeof goals.GoalGetToBlock === "function") {
      return new goals.GoalGetToBlock(position.x, position.y, position.z);
    }
    return new goals.GoalNear(position.x, position.y, position.z, 1);
  }

  async function chop(block, token) {
    const axe = bot.inventory
      .items()
      .filter((i) => /_axe$/.test(i.name))
      .sort((a, b) => (U.parseWeapon(b) ? U.parseWeapon(b).rank : 0) - (U.parseWeapon(a) ? U.parseWeapon(a).rank : 0))[0];
    if (axe && (!bot.heldItem || bot.heldItem.name !== axe.name)) {
      await bot.equip(axe, "hand").catch(() => {});
    }
    if (token !== ctx.token) return false;

    let fresh = bot.blockAt(block.position);
    if (!fresh || !isLogName(fresh.name)) return false;

    // First navigate to a genuinely visible, reachable face. Pathfinder may
    // dig leaves/soft foliage on the route and can tower if scaffold is in the
    // inventory; merely being within three Euclidean blocks is not enough.
    if (!bot.canDigBlock(fresh)) {
      const ok = await gotoTimeout(logLookGoal(fresh.position), 30000);
      if (token !== ctx.token || !ok) return false;
    }

    fresh = bot.blockAt(block.position);
    if (!fresh || !isLogName(fresh.name)) return false;

    // If the log is still outside reach, make one closer attempt. This also
    // gives the 1x1 tower movement a chance to climb to high trunks when the
    // bot has dirt/cobblestone (or another registered scaffold block).
    if (!bot.canDigBlock(fresh)) {
      const p = fresh.position;
      const closerGoal = new goals.GoalNear(p.x, p.y, p.z, 1);
      const ok = await gotoTimeout(closerGoal, 18000);
      if (token !== ctx.token || !ok) return false;
    }

    fresh = bot.blockAt(block.position);
    if (!fresh || !isLogName(fresh.name) || !bot.canDigBlock(fresh)) return false;
    try {
      await bot.dig(fresh);
      return true;
    } catch (e) {
      return false;
    }
  }

  function countTowerBlocks() {
    const ids = new Set((defaultMove && defaultMove.scafoldingBlocks) || []);
    if (!ids.size || !bot.inventory) return 0;
    return bot.inventory.items().reduce((total, item) => total + (ids.has(item.type) ? item.count : 0), 0);
  }

  async function woodLoop(token, limit) {
    const towerBlocks = countTowerBlocks();
    if (towerBlocks === 0) {
      say("No tower blocks in inventory. I can clear leaves, but I cannot pillar upward for high logs. Carry dirt, cobblestone, or planks.");
    } else {
      say("Tower blocks available: " + towerBlocks + ".");
    }
    const blacklist = new Set();
    const failures = new Map();
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
        failures.delete(pick.key);
        mined++;
        await pickupDrops(token, 6);
      } else {
        const count = (failures.get(pick.key) || 0) + 1;
        failures.set(pick.key, count);
        if (count >= 3) blacklist.add(pick.key);
        else await sleep(650); // let path recovery / foliage clearing settle before retry
      }
    }
    if (token === ctx.token) {
      say("Wood done: " + mined + " logs. " + reason);
      stopMode(false);
    }
  }

  // ============================================================
  // !kill: hunt configured passive animals and recognized hostiles.
  // Keep scanning while enabled; an empty scan is not a reason to stop.
  // ============================================================
  function isKillCandidate(entity) {
    return !!(
      entity && entity.position && entity !== bot.entity &&
      (cfg.kill.animals.includes(entity.name) || U.isHostile(entity))
    );
  }

  function nearestKillTarget() {
    let best = null;
    let bestDistance = Infinity;
    let count = 0;
    const names = new Set();
    for (const entity of Object.values(bot.entities)) {
      if (!isKillCandidate(entity)) continue;
      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > cfg.kill.radius) continue;
      count++;
      names.add(entity.name);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entity;
      }
    }
    killState.lastVisibleCount = count;
    killState.lastVisibleNames = [...names].slice(0, 8);
    return best;
  }

  function killConfirmedTarget(target) {
    // Only entityDead confirms a kill. Disappearing from the local entity map
    // can also mean despawn/unload and must not inflate the kill count.
    if (!target || !killState.target || target.id !== killState.target.id) return;
    const token = ctx.token;
    killState.target = null;
    killState.kills++;
    killState.lastLostTarget = null;
    ctx.pickup = true;
    melee.release();
    nav.stop();
    pickupDrops(token, 8).then(() => {
      if (token === ctx.token) ctx.pickup = false;
    }).catch((e) => {
      if (token === ctx.token) ctx.pickup = false;
      log("drop pickup after kill failed: " + e.message);
    });
  }

  function killTick() {
    if (ctx.pickup) return;
    const now = Date.now();
    let target = killState.target;

    // A target can disappear because it despawned or left entity-tracking
    // range. Clear it and scan again; do NOT count it as a kill or chase its
    // stale last-known position.
    if (target && (!bot.entities[target.id] || !target.position)) {
      killState.lastLostTarget = target.name || "unknown";
      log("kill target lost/untracked (not counted as a kill): " + killState.lastLostTarget);
      killState.target = null;
      target = null;
      melee.release();
      nav.stop();
    }

    if (!target) {
      if (now - killState.lastScan < 700) return;
      killState.lastScan = now;
      target = nearestKillTarget();
      if (!target) {
        killState.emptyScans++;
        // Stay in kill mode. Entities may enter tracking range later; the
        // former six-scan auto-stop made !kill silently quit after ~3 seconds.
        if (now - killState.lastEmptyNotice > 15000) {
          killState.lastEmptyNotice = now;
          const seen = killState.lastVisibleNames.length
            ? " Eligible nearby: " + killState.lastVisibleNames.join(", ") + "."
            : " No eligible animals/hostile mobs are currently tracked nearby.";
          say("Still hunting; no target is currently available. Move closer to loaded mobs or wait for one to spawn. Kills: " + killState.kills + "." + seen);
          log("kill scan empty; continuing to scan loaded entities within " + cfg.kill.radius + " blocks.");
        }
        return;
      }
      killState.emptyScans = 0;
      killState.target = target;
      say("Targeting " + target.name + ".");
      log("kill target acquired: " + target.name + " (entity " + target.id + ").");
    }

    melee.step(target, { crit: false, prefer: "sword" });
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
    nav.follow(ent, 2.25);
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
      nav.follow(player, 2.25);
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
      killConfirmedTarget(entity);
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
        say("!wood [n] !follow !kill !killstatus !guard !unguard !pvp [name] !sleep !sleepstatus !armor !inventory !pathstatus !radius !unsave !roam !stop");
        return;

      case "roam":
        if (ctx.roam) {
          stopMode(true);
          say("Roaming off. Standing still.");
          return;
        }
        if (ctx.home) {
          say("A fixed position is saved - use !unsave first, then !roam.");
          return;
        }
        stopMode(true);
        sleepResumeState = null;
        ctx.roam = true;
        try { bot.setControlState("sneak", false); } catch (e) {}
        say("Roaming on - I'll walk around to stay active. Type !roam or !stop to stop.");
        return;

      case "stop":
        sleepResumeState = null; // an explicit stop must not be undone after waking
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
          sleepRetryAfter = 0;
          const timeOfDay = worldTimeOfDay();
          say("Auto-sleep enabled. Minecraft time is " + (timeOfDay === null ? "unknown" : Math.floor(timeOfDay)) +
            (timeOfDay !== null && isNight() ? " (night)" : " (daytime; I'll sleep when night starts)") +
            ". I'll search up to " + BED_SEARCH_RADIUS + " blocks for a placed bed. Use !sleepstatus for details; !sleep again disables it.");
          autoSleepTick().catch((e) => log("auto-sleep error: " + e.message));
        } else {
          const wasSleepNavigating = ctx.sleepNavigating;
          ctx.sleepNavigating = false;
          sleepBedKey = null;
          try {
            if (wasSleepNavigating) nav.stop();
            if (bot.isSleeping) bot.wake().catch(() => resumeModeAfterSleep());
            else resumeModeAfterSleep();
            if (!sleepResumeState && ctx.mode === "idle" && ctx.home) goHome();
          } catch (e) {}
          say("Auto-sleep disabled.");
        }
        return;
      }

      case "sleepstatus": {
        const details = sleepStatusText();
        log("sleepstatus: " + details);
        say("Sleep status: " + details);
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

      case "pathstatus": {
        const pos = bot.entity && bot.entity.position;
        const goal = bot.pathfinder && bot.pathfinder.goal;
        const path = bot.pathfinder && Array.isArray(bot.pathfinder.path) ? bot.pathfinder.path : [];
        const planner = typeof nav.status === "function" ? nav.status() : {};
        const details = "mode=" + ctx.mode +
          ", goal=" + (goal ? (goal.constructor && goal.constructor.name || "active") : "none") +
          ", nodes=" + path.length +
          ", route=" + (planner.routeState || "unknown") +
          ", result=" + (planner.lastPathStatus || "unknown") +
          ", routeAge=" + Math.round((planner.routeAgeMs || 0) / 1000) + "s" +
          ", noProgress=" + Math.round((planner.noProgressMs || 0) / 1000) + "s" +
          ", escapes=" + (planner.escapes || 0) +
          (Number.isFinite(planner.approachRange) ? ", approach=" + planner.approachRange.toFixed(1) + "/" + planner.baseApproachRange.toFixed(1) : "") +
          ", moving=" + !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) +
          ", mining=" + !!(bot.pathfinder && bot.pathfinder.isMining && bot.pathfinder.isMining()) +
          ", building=" + !!(bot.pathfinder && bot.pathfinder.isBuilding && bot.pathfinder.isBuilding()) +
          (pos ? ", pos=" + pos.x.toFixed(1) + "," + pos.y.toFixed(1) + "," + pos.z.toFixed(1) : "");
        log("pathstatus: " + details);
        say("Path status: " + details);
        return;
      }

      case "wood": {
        if (ctx.mode === "wood") {
          stopMode(false);
          say("Stopped chopping.");
          return;
        }
        const limit = parseInt(args[0], 10) || 0;
        currentWoodLimit = limit;
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
        say("Hunting configured animals and hostile mobs within " + cfg.kill.radius + " blocks. I'll keep scanning until you type !kill again.");
        return;

      case "killstatus": {
        const target = killState.target;
        const distance = target && target.position && bot.entity
          ? bot.entity.position.distanceTo(target.position).toFixed(1) + " blocks"
          : "n/a";
        const details = "mode=" + ctx.mode +
          ", target=" + (target && bot.entities[target.id] ? target.name : "none") +
          ", distance=" + distance +
          ", visibleEligible=" + killState.lastVisibleCount +
          (killState.lastVisibleNames.length ? " [" + killState.lastVisibleNames.join(",") + "]" : "") +
          ", kills=" + killState.kills +
          (killState.lastLostTarget ? ", lastLost=" + killState.lastLostTarget : "");
        log("killstatus: " + details);
        say("Kill status: " + details);
        return;
      }

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

module.exports = { initCommands, isIdle, hasHome, isStationary, isRoaming, ctx, parseChatLine };
