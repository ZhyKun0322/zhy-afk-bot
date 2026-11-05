"use strict";

// Deprecated compatibility shim.
// Older versions intentionally quit and rejoined every 1-5 minutes, which
// created needless reconnect loops. The active reconnect policy now lives in
// index.js and only runs after an actual disconnect/kick.
function setupLeaveRejoin(bot) {
  let stopped = false;
  const cleanup = () => {
    stopped = true;
  };
  if (bot && typeof bot.once === "function") {
    bot.once("end", cleanup);
    bot.once("kicked", cleanup);
  }
  return {
    stop: cleanup,
    get stopped() { return stopped; },
  };
}

module.exports = setupLeaveRejoin;
