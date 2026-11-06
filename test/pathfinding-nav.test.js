'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');

let fakeNow = 1000;
const realNow = Date.now;
Date.now = () => fakeNow;

class Vec3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  floored() { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z); }
  offset(x, y, z) { return new Vec3(this.x + x, this.y + y, this.z + z); }
  minus(other) { return new Vec3(this.x - other.x, this.y - other.y, this.z - other.z); }
  norm() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const n = this.norm() || 1; return new Vec3(this.x / n, this.y / n, this.z / n); }
}

class GoalFollow {
  constructor(entity, range) { this.entity = entity; this.range = range; this.rangeSq = range * range; }
  isEnd(node) {
    return Math.hypot(node.x + 0.5 - this.entity.position.x, node.y - this.entity.position.y,
      node.z + 0.5 - this.entity.position.z) <= this.range;
  }
}
class GoalNear { constructor(x, y, z, range) { Object.assign(this, { x, y, z, range }); } isEnd() { return false; } }
class GoalBlock { constructor(x, y, z) { Object.assign(this, { x, y, z }); } isEnd() { return false; } }

// Stub only the pathfinder types so this regression test can run without a
// Minecraft server or installed runtime dependencies.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mineflayer-pathfinder') return { goals: { GoalFollow, GoalNear, GoalBlock } };
  if (request === 'vec3') return { Vec3 };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { createNav } = require('../combatUtils');
  const bot = new EventEmitter();
  bot.entity = { id: 1, height: 1.8, position: new Vec3(0, 64, 0) };
  bot.world = { raycast: () => null };
  bot.clearControlStates = () => {};
  bot.pathfinder = {
    goal: null,
    path: [],
    thinkTimeout: 15000,
    movements: {},
    setGoalCalls: 0,
    setGoal(goal, dynamic) {
      this.setGoalCalls++;
      this.goal = goal;
      bot.emit('goal_updated', goal, dynamic);
    },
    isMining: () => false,
    isBuilding: () => false,
    isMoving: () => false,
  };

  const target = { id: 2, height: 1.8, position: new Vec3(20, 64, 0) };
  const nav = createNav(bot);
  nav.follow(target, 2.25);
  assert.equal(nav.status().routeState, 'pending');
  assert.equal(bot.pathfinder.setGoalCalls, 1);
  assert.equal(nav.status().approachRange, 2.25);

  // A failed close-approach search widens its visible endpoint instead of
  // immediately abandoning the target for a random same-area escape tile.
  bot.emit('path_update', { status: 'noPath', path: [] });
  assert.equal(nav.status().routeState, 'pending');
  assert.ok(['goal_updated', 'smart_range_expand'].includes(nav.status().lastPathStatus));
  assert.equal(nav.status().approachRange, 3.75);
  assert.equal(bot.pathfinder.setGoalCalls, 2);

  // A path search is allowed to take longer than the old 3.2s watchdog.
  fakeNow += 4000;
  bot.emit('physicsTick');
  assert.equal(bot.pathfinder.setGoalCalls, 2, 'pending A* search must not be cancelled at 4 seconds');
  assert.equal(nav.status().routeState, 'pending');

  bot.pathfinder.path = [{}, {}, {}];
  bot.emit('path_update', { status: 'partial', path: bot.pathfinder.path });
  assert.equal(nav.status().routeState, 'partial');

  // Partial routes can execute while A* continues; actual displacement must
  // refresh the no-progress timer without falsely declaring a stall.
  fakeNow += 1500;
  bot.entity.position = new Vec3(0.2, 64, 0);
  bot.emit('physicsTick');
  assert.equal(nav.status().noProgressMs, 0);

  bot.pathfinder.path = [{}, {}];
  bot.emit('path_update', { status: 'success', path: bot.pathfinder.path });
  assert.equal(nav.status().routeState, 'ready');
  assert.equal(nav.status().lastPathStatus, 'success');

  // A moving target invalidates cached failed approach radii and starts a new
  // close-range search instead of permanently following at the widened range.
  target.position = new Vec3(22, 64, 0);
  nav.follow(target, 2.25);
  assert.equal(nav.status().approachRange, 2.25);
  assert.equal(bot.pathfinder.setGoalCalls, 3);

  nav.stop();

  // Regression: when there is no immediately safe escape tile, the old code
  // left routeState="failed" forever. A failed state skipped the watchdog on
  // every later physics tick. The controller must re-arm and schedule retry.
  bot.blockAt = () => null;
  bot.pathfinder.movements = { countScaffoldingItems: () => 0 };
  const secondTarget = { id: 3, height: 1.8, position: new Vec3(30, 64, 0) };
  nav.follow(secondTarget, 2.25);
  for (let i = 0; i < 6; i++) bot.emit('path_update', { status: 'noPath', path: [] });
  assert.notEqual(nav.status().routeState, 'failed', 'no-safe-tile recovery must not deadlock in failed state');
  assert.equal(nav.status().lastPathStatus, 'goal_updated');
  nav.stop(); // also clears the scheduled recovery retry

  console.log('Pathfinding navigation regression tests passed.');
} finally {
  Date.now = realNow;
  Module._load = originalLoad;
}
