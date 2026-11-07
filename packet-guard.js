'use strict';

/**
 * Movement packet guard.
 *
 * Vanilla/Paper servers kick with "multiplayer.disconnect.invalid_player_movement"
 * when a movement packet contains NaN/Infinity (or absurd) coordinates or
 * rotations. A single bad value from physics, pathfinding or a look call is
 * enough to get the bot kicked. This wraps the client's write() and, when a
 * movement packet is invalid, replaces the bad fields with the last known good
 * ones (and repairs the bot's own entity state) instead of sending it.
 */
const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying']);
const POS_FIELDS = ['x', 'y', 'z'];
const ROT_FIELDS = ['yaw', 'pitch'];
const LIMIT = 2.9e7;

function installMovementPacketGuard(bot, log = console.warn) {
  const client = bot && bot._client;
  if (!client || typeof client.write !== 'function' || client.__movementGuard) return () => {};
  const originalWrite = client.write.bind(client);
  const good = { x: null, y: null, z: null, yaw: 0, pitch: 0 };
  let repairs = 0;
  let lastLog = 0;

  let tickEndBroken = false;
  const tickEndSupported = () => {
    if (tickEndBroken) return false;
    try {
      const reg = bot.registry;
      if (reg && reg.version && typeof reg.version['>='] === 'function') return reg.version['>=']('1.21.2');
    } catch (_) {}
    return false;
  };

  const bad = (v) => typeof v !== 'number' || !Number.isFinite(v);

  client.write = function guardedWrite(name, params) {
    if (MOVE_PACKETS.has(name) && params && typeof params === 'object') {
      let repaired = false;
      for (const f of POS_FIELDS) {
        if (!(f in params)) continue;
        if (bad(params[f]) || Math.abs(params[f]) > LIMIT) {
          if (good[f] === null) return; // nothing safe to send yet: drop the packet
          params[f] = good[f];
          repaired = true;
        }
      }
      for (const f of ROT_FIELDS) {
        if (!(f in params)) continue;
        if (bad(params[f])) { params[f] = good[f]; repaired = true; }
      }
      if (repaired) {
        repairs++;
        const now = Date.now();
        if (now - lastLog > 5000) {
          lastLog = now;
          log(`[PacketGuard] Replaced invalid movement values in '${name}' packet (#${repairs}); prevented an invalid_player_movement kick.`);
        }
        try {
          const e = bot.entity;
          if (e) {
            if (e.position && POS_FIELDS.some((f) => bad(e.position[f]))) {
              e.position.x = good.x; e.position.y = good.y; e.position.z = good.z;
            }
            if (e.velocity && ['x', 'y', 'z'].some((f) => bad(e.velocity[f]))) e.velocity.x = e.velocity.y = e.velocity.z = 0;
            if (bad(e.yaw)) e.yaw = good.yaw;
            if (bad(e.pitch)) e.pitch = good.pitch;
          }
        } catch (_) {}
      } else {
        for (const f of POS_FIELDS) if (f in params) good[f] = params[f];
        for (const f of ROT_FIELDS) if (f in params) good[f] = params[f];
      }
    }
    const result = originalWrite(name, params);
    // Newer servers (1.21.2+ protocol; strictly enforced by 26.x servers, also
    // behind ViaVersion) allow one movement packet per tick and reset that
    // counter only when the client sends tick_end. Mineflayer never sends it, so
    // the 2nd movement packet gets the bot kicked with invalid_player_movement
    // about 1.5s after joining. Send it right after every movement packet.
    if (MOVE_PACKETS.has(name) && tickEndSupported()) {
      try { originalWrite('tick_end', {}); } catch (_) { tickEndBroken = true; }
    }
    return result;
  };
  client.__movementGuard = true;
  return () => { client.write = originalWrite; delete client.__movementGuard; };
}

module.exports = { installMovementPacketGuard };
