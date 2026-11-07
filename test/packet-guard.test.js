'use strict';
const assert = require('node:assert/strict');
const { installMovementPacketGuard } = require('../packet-guard');
const sent = [];
const bot = { entity: { position: { x: NaN, y: 64, z: 0 }, velocity: { x: NaN, y: 0, z: 0 }, yaw: NaN, pitch: 0 }, _client: { write: (n, p) => sent.push([n, { ...p }]) } };
installMovementPacketGuard(bot, () => {});
// bad packet before any good one is dropped
bot._client.write('position', { x: NaN, y: 64, z: 0, onGround: true });
assert.equal(sent.length, 0);
bot._client.write('position_look', { x: 10, y: 64, z: 5, yaw: 1, pitch: 0.5, onGround: true });
bot._client.write('position_look', { x: NaN, y: 64, z: Infinity, yaw: NaN, pitch: 0.5, onGround: true });
assert.equal(sent.length, 2);
const fixed = sent[1][1];
assert.deepEqual([fixed.x, fixed.z, fixed.yaw], [10, 5, 1]);
assert.ok(Number.isFinite(bot.entity.position.x) && Number.isFinite(bot.entity.yaw) && bot.entity.velocity.x === 0);
bot._client.write('chat', { message: 'hi' });
assert.equal(sent.length, 3);
console.log('Movement packet guard tests passed.');
