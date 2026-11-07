"use strict";

const { addLog, getLogs } = require("./logger");
// Patch the installed pathfinder before loading it. This is also run from
// postinstall, but doing it here covers hosts that upload files without a
// fresh npm install after the upgrade.
const pathfinderPatchStatus = require("./scripts/patch-pathfinder").patchInstalledPathfinder();
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const { Vec3 } = require("vec3");
const config = require("./settings.json");
const cmd = require("./commands");
const { isHostile } = require("./combatUtils");
const { installPathUpdateInvalidationGuard } = require("./pathfinder-compat");
const express = require("express");
const http = require("http");
const https = require("https");

// mineflayer-pathfinder 2.4.5 has an overhead-reach error in GoalLookAtBlock:
// it measures from the bot's feet to the target block's raised center, then
// raycasts from the eyes. That rejects reachable logs above the player. This
// backport measures the actual eye-to-face distance before raycasting.
function installGoalLookAtBlockReachFix() {
  const proto = goals.GoalLookAtBlock && goals.GoalLookAtBlock.prototype;
  if (!proto || proto.__overheadReachFix) return;

  proto.isEnd = function (node) {
    // Measure reach from the bot's eye to a visible block face below; a feet-to-block
    // center pre-check incorrectly rejects logs directly overhead.
    const dx = node.x - (this.pos.x + 0.5);
    const dy = node.y + this.entityHeight - (this.pos.y + 0.5);
    const dz = node.z - (this.pos.z + 0.5);
    const visibleFaces = {
      y: Math.sign(Math.abs(dy) > 0.5 ? dy : 0),
      x: Math.sign(Math.abs(dx) > 0.5 ? dx : 0),
      z: Math.sign(Math.abs(dz) > 0.5 ? dz : 0),
    };

    for (const axis of ["y", "x", "z"]) {
      const sign = visibleFaces[axis];
      if (!sign) continue;
      const targetPos = new Vec3(this.pos.x, this.pos.y, this.pos.z).offset(
        0.5 + (axis === "x" ? sign * 0.5 : 0),
        0.5 + (axis === "y" ? sign * 0.5 : 0),
        0.5 + (axis === "z" ? sign * 0.5 : 0),
      );
      const startPos = new Vec3(node.x + 0.5, node.y + this.entityHeight, node.z + 0.5);
      if (startPos.distanceTo(targetPos) > this.reach) continue;
      const hit = this.world.raycast(
        startPos,
        targetPos.clone().subtract(startPos).normalize(),
        this.reach,
      );
      const hitPos = hit && hit.position;
      if (hitPos && hitPos.x === this.pos.x && hitPos.y === this.pos.y && hitPos.z === this.pos.z) {
        return true;
      }
    }
    return false;
  };
  proto.__overheadReachFix = true;
}

// Pillar timing is patched in mineflayer-pathfinder itself at postinstall.
// It waits until the player's feet clear the scaffold block and equips while
// rising, preventing vanilla servers from rejecting a block inside the player.

installGoalLookAtBlockReachFix();

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// Health check endpoint for monitoring
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 24px;
          }

          main { width: 100%; max-width: 400px; }

          header { margin-bottom: 28px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .status-section {
            border-radius: 12px;
            padding: 20px 24px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 16px;
            transition: background 0.3s, border-color 0.3s;
          }
          .status-section.online  { background: #0d2218; border: 2px solid #238636; }
          .status-section.offline { background: #200d0d; border: 2px solid #da3633; }

          .status-icon {
            width: 44px; height: 44px;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 20px; flex-shrink: 0;
            transition: background 0.3s;
          }
          .status-icon.online  { background: #238636; }
          .status-icon.offline { background: #da3633; }

          .status-label { font-size: 18px; font-weight: 700; line-height: 1.2; transition: color 0.3s; }
          .status-label.online  { color: #3fb950; }
          .status-label.offline { color: #f85149; }
          .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; }

          dl { margin: 0; }
          .stat-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 10px;
            padding: 16px 20px;
            margin-bottom: 10px;
          }
          dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
          dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; line-height: 1.3; }
          .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }

          .controls { margin-top: 8px; }
          .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; }
          .btn-grid-2 { grid-template-columns: 1fr 1fr; }

          .btn-primary {
            min-height: 52px; border-radius: 10px;
            font-size: 15px; font-weight: 700;
            cursor: pointer; letter-spacing: 0.3px;
            transition: opacity 0.2s, filter 0.2s;
            font-family: inherit;
          }
          .btn-primary:hover  { filter: brightness(1.1); }
          .btn-primary:active { opacity: 0.85; }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-stop  { border: 2px solid #da3633; background: #200d0d; color: #f85149; }

          .btn-secondary {
            min-height: 44px; border-radius: 10px;
            border: 1px solid #21262d; background: #161b22; color: #8b949e;
            font-size: 13px; font-weight: 500;
            text-decoration: none;
            display: flex; align-items: center; justify-content: center;
            font-family: inherit; cursor: pointer;
            transition: background 0.2s, color 0.2s;
          }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }

          footer { margin-top: 20px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main role="main" aria-label="AFK Bot Dashboard">

          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; Live status</p>
          </header>

          <section
            id="status-section"
            role="status"
            aria-live="polite"
            aria-label="Bot connection status"
            class="status-section offline"
          >
            <div id="status-icon" aria-hidden="true" class="status-icon offline">&#x2717;</div>
            <div>
              <div id="status-label" class="status-label offline">Connecting…</div>
              <div id="status-detail" class="status-detail">Establishing connection</div>
            </div>
          </section>

          <section aria-label="Bot statistics">
            <dl>
              <div class="stat-card">
                <dt>Uptime</dt>
                <dd id="uptime-text">—</dd>
                <p class="stat-detail">Time since last connection</p>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">Searching…</dd>
                <p class="stat-detail">Bot's current in-game position</p>
              </div>
              <div class="stat-card">
                <dt>Server address</dt>
                <dd>${config.server.ip}</dd>
                <p class="stat-detail">Minecraft server hostname</p>
              </div>
            </dl>
          </section>

          <section class="controls" aria-label="Bot controls">
            <div class="btn-grid btn-grid-2">
              <button class="btn-primary btn-start" onclick="startBot()" aria-label="Start bot">Start bot</button>
              <button class="btn-primary btn-stop" onclick="stopBot()" aria-label="Stop bot">Stop bot</button>
            </div>
            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary" aria-label="View setup guide">Setup guide</a>
              <a href="/logs" class="btn-secondary" aria-label="View bot logs">View logs</a>
            </div>
          </section>

          <footer>
            <p>Status updates every 5 seconds</p>
          </footer>

        </main>

        <script>
          function formatUptime(s) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
            if (m > 0) return m + 'm ' + sec + 's';
            return sec + ' seconds';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const data = await r.json();
              const online = data.status === 'connected';

              const section = document.getElementById('status-section');
              const icon    = document.getElementById('status-icon');
              const label   = document.getElementById('status-label');
              const detail  = document.getElementById('status-detail');

              section.className = 'status-section ' + (online ? 'online' : 'offline');
              icon.className    = 'status-icon '    + (online ? 'online' : 'offline');
              icon.textContent  = online ? '✓' : '✗';
              label.className   = 'status-label '   + (online ? 'online' : 'offline');
              label.textContent = online ? 'Connected' : 'Disconnected';
              detail.textContent = online ? 'Bot is active on the server' : 'Attempting to reconnect';

              document.getElementById('uptime-text').textContent = formatUptime(data.uptime);

              if (data.coords) {
                const x = Math.floor(data.coords.x);
                const y = Math.floor(data.coords.y);
                const z = Math.floor(data.coords.z);
                document.getElementById('coords-text').textContent = 'X ' + x + ', Y ' + y + ', Z ' + z;
              } else {
                document.getElementById('coords-text').textContent = 'Searching…';
              }
            } catch (e) {
              const label = document.getElementById('status-label');
              label.className = 'status-label offline';
              label.textContent = 'Unreachable';
            }
          }

          async function startBot() {
            const r = await fetch('/start', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot started!' : data.msg);
            update();
          }

          async function stopBot() {
            const r = await fetch('/stop', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot stopped!' : data.msg);
            update();
          }

          setInterval(update, 5000);
          update();
        </script>
      </body>
    </html>
  `);
});
app.get("/tutorial", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Setup Guide</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            margin: 0;
            padding: 40px 24px;
          }

          main {
            width: 100%;
            max-width: 560px;
            margin: 0 auto;
          }

          .back-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            color: #8b949e;
            text-decoration: none;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 8px;
            padding: 7px 14px;
            margin-bottom: 32px;
            transition: color 0.2s, background 0.2s;
          }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }

          header { margin-bottom: 32px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .step-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 16px;
          }

          .step-header {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 18px;
          }

          .step-number {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: #0d2218;
            border: 2px solid #238636;
            color: #3fb950;
            font-size: 14px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }

          .step-title {
            font-size: 16px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
          }

          ol {
            margin: 0;
            padding: 0;
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          li {
            font-size: 14px;
            color: #8b949e;
            line-height: 1.6;
            padding-left: 20px;
            position: relative;
          }

          li::before {
            content: "·";
            position: absolute;
            left: 6px;
            color: #3fb950;
            font-weight: 700;
          }

          li strong { color: #e6edf3; font-weight: 600; }

          code {
            background: #21262d;
            border: 1px solid #30363d;
            padding: 2px 7px;
            border-radius: 5px;
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 12px;
            color: #e6edf3;
          }

          a { color: #58a6ff; text-decoration: none; }
          a:hover { text-decoration: underline; }

          footer {
            margin-top: 32px;
            text-align: center;
          }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <header>
            <h1>Setup Guide</h1>
            <p>Get your AFK bot running in under 15 minutes</p>
          </header>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">1</div>
              <h2 class="step-title">Configure Aternos</h2>
            </div>
            <ol>
              <li>Go to <strong>Aternos</strong> and open your server.</li>
              <li>Install <strong>Paper/Bukkit</strong> as your server software.</li>
              <li>Enable <strong>Cracked</strong> mode using the green switch.</li>
              <li>Install these plugins: <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code></li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">2</div>
              <h2 class="step-title">GitHub Setup</h2>
            </div>
            <ol>
              <li>Download this project as a ZIP and extract it.</li>
              <li>Edit <code>settings.json</code> with your server IP and port.</li>
              <li>Upload all files to a new <strong>GitHub Repository</strong>.</li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">3</div>
              <h2 class="step-title">Deploy on Replit (Free 24/7)</h2>
            </div>
            <ol>
              <li>Import your GitHub repo into <strong>Replit</strong>.</li>
              <li>Set the run command to <code>npm start</code>.</li>
              <li>Hit <strong>Run</strong> — the bot connects automatically.</li>
              <li>The bot pings itself every 10 minutes to stay alive.</li>
            </ol>
          </div>

          <footer>
            <p>AFK Bot Dashboard &middot; ${config.name}</p>
          </footer>
        </main>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  const logs = getLogs();

  const escapeHTML = (str) =>
    str.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    );

  const logCount = logs.length;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Logs</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            margin: 0;
            padding: 40px 24px;
          }

          main {
            width: 100%;
            max-width: 760px;
            margin: 0 auto;
          }

          .back-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            color: #8b949e;
            text-decoration: none;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 8px;
            padding: 7px 14px;
            margin-bottom: 32px;
            transition: color 0.2s, background 0.2s;
          }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }

          .page-header {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            margin-bottom: 20px;
            gap: 12px;
            flex-wrap: wrap;
          }

          .page-header-left h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          .page-header-left p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
          }

          .badge {
            font-size: 12px;
            font-weight: 600;
            color: #8b949e;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 20px;
            padding: 4px 12px;
            white-space: nowrap;
          }

          .log-card {
            background: #0d1117;
            border: 1px solid #21262d;
            border-radius: 12px;
            overflow: hidden;
          }

          .log-card-header {
            background: #161b22;
            border-bottom: 1px solid #21262d;
            padding: 12px 18px;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .dot { width: 10px; height: 10px; border-radius: 50%; }
          .dot-red   { background: #ff5f57; }
          .dot-yellow{ background: #ffbd2e; }
          .dot-green { background: #28c840; }

          .log-card-title {
            font-size: 12px;
            font-weight: 500;
            color: #484f58;
            margin-left: 4px;
          }

          .log-body {
            padding: 16px 18px;
            max-height: 560px;
            overflow-y: auto;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            line-height: 1.7;
          }

          .log-entry { display: block; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
          .log-entry.error   { color: #ff7b72; }
          .log-entry.warn    { color: #e3b341; }
          .log-entry.success { color: #3fb950; }
          .log-entry.control { color: #58a6ff; }
          .log-entry.default { color: #8b949e; }

          .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: #484f58;
            font-size: 13px;
          }

          .refresh-bar {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            margin-top: 12px;
            font-size: 12px;
            color: #484f58;
          }
          .refresh-dot {
            width: 7px; height: 7px;
            border-radius: 50%;
            background: #3fb950;
            animation: pulse 2s infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }

          .console-row {
            display: flex;
            align-items: center;
            border-top: 1px solid #21262d;
            background: #0d1117;
            padding: 10px 18px;
            gap: 10px;
          }

          .console-prompt {
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 13px;
            color: #3fb950;
            font-weight: 700;
            flex-shrink: 0;
            user-select: none;
          }

          .console-input {
            flex: 1;
            background: transparent;
            border: none;
            outline: none;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            color: #e6edf3;
            caret-color: #3fb950;
          }

          .console-input::placeholder { color: #484f58; }

          .console-send {
            background: #0d2218;
            border: 1px solid #238636;
            color: #3fb950;
            font-size: 12px;
            font-weight: 600;
            padding: 5px 14px;
            border-radius: 6px;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.2s;
            flex-shrink: 0;
          }
          .console-send:hover { background: #122d1a; }
          .console-send:disabled { opacity: 0.5; cursor: default; }

          .console-wrap {
            position: relative;
          }

          .cmd-suggestions {
            display: none;
            position: absolute;
            bottom: calc(100% + 6px);
            left: 0; right: 0;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 10;
          }

          .cmd-suggestions.visible { display: block; }

          .cmd-item {
            display: flex;
            align-items: baseline;
            gap: 12px;
            padding: 9px 16px;
            cursor: pointer;
            transition: background 0.12s;
            border-bottom: 1px solid #21262d;
          }
          .cmd-item:last-child { border-bottom: none; }
          .cmd-item:hover, .cmd-item.active {
            background: #21262d;
          }

          .cmd-name {
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            font-weight: 700;
            color: #3fb950;
            flex-shrink: 0;
            min-width: 90px;
          }

          .cmd-desc {
            font-size: 12px;
            color: #6e7681;
          }

          footer { margin-top: 32px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <div class="page-header">
            <div class="page-header-left">
              <h1>Bot Logs</h1>
              <p>Live output from the AFK bot</p>
            </div>
            <span class="badge">${logCount} ${logCount === 1 ? "entry" : "entries"}</span>
          </div>

          <div class="log-card">
            <div class="log-card-header">
              <span class="dot dot-red"></span>
              <span class="dot dot-yellow"></span>
              <span class="dot dot-green"></span>
              <span class="log-card-title">bot.log</span>
            </div>
            <div class="log-body" id="log-body">
              ${logCount === 0
                ? `<div class="empty-state">No log entries yet. Start the bot to see output.</div>`
                : logs.map((l) => {
                    const escaped = escapeHTML(l);
                    const lower = l.toLowerCase();
                    let cls = "default";
                    if (lower.includes("error") || lower.includes("fail")) cls = "error";
                    else if (lower.includes("warn")) cls = "warn";
                    else if (lower.includes("[control]")) cls = "control";
                    else if (lower.includes("connect") || lower.includes("join") || lower.includes("spawn")) cls = "success";
                    return `<span class="log-entry ${cls}">${escaped}</span>`;
                  }).join("")
              }
            </div>
            <div class="console-wrap">
              <div class="cmd-suggestions" id="cmd-suggestions"></div>
              <div class="console-row">
                <span class="console-prompt">&gt;</span>
                <input
                  id="console-input"
                  class="console-input"
                  type="text"
                  placeholder="Type / for commands, or any message…"
                  autocomplete="off"
                  spellcheck="false"
                >
                <button id="console-send" class="console-send">Send</button>
              </div>
            </div>
          </div>

          <div class="refresh-bar">
            <span class="refresh-dot"></span>
            <span id="refresh-label">Auto-refreshing every 5 seconds</span>
          </div>

          <footer>
            <p>AFK Bot Dashboard &middot; ${config.name}</p>
          </footer>
        </main>

        <script>
          (function() {
            var logBody  = document.getElementById('log-body');
            var input    = document.getElementById('console-input');
            var sendBtn  = document.getElementById('console-send');
            var label    = document.getElementById('refresh-label');
            var sugBox   = document.getElementById('cmd-suggestions');
            var refreshTimer = null;
            var typing = false;
            var activeIdx = -1;

            var COMMANDS = [
              { name: '/help',   desc: 'Show all available commands' },
              { name: '/pos',    desc: "Show bot's current coordinates" },
              { name: '/status', desc: 'Show connection status & uptime' },
              { name: '/list',   desc: 'List players on the server' },
              { name: '/say',    desc: 'Send a chat message in-game' },
            ];

            function scrollBottom() {
              if (logBody) logBody.scrollTop = logBody.scrollHeight;
            }

            function scheduleRefresh() {
              clearTimeout(refreshTimer);
              if (!typing) {
                refreshTimer = setTimeout(function() { location.reload(); }, 5000);
              }
            }

            function appendLocalEntry(text, cls) {
              var span = document.createElement('span');
              span.className = 'log-entry ' + (cls || 'control');
              span.textContent = text;
              logBody.appendChild(span);
              scrollBottom();
            }

            function hideSuggestions() {
              sugBox.classList.remove('visible');
              sugBox.innerHTML = '';
              activeIdx = -1;
            }

            function setActive(idx) {
              var items = sugBox.querySelectorAll('.cmd-item');
              items.forEach(function(el, i) {
                el.classList.toggle('active', i === idx);
              });
              activeIdx = idx;
            }

            function showSuggestions(val) {
              var query = val.toLowerCase();
              var matches = COMMANDS.filter(function(c) {
                return c.name.startsWith(query);
              });

              if (!matches.length) { hideSuggestions(); return; }

              sugBox.innerHTML = matches.map(function(c, i) {
                return '<div class="cmd-item" data-cmd="' + c.name + '">' +
                  '<span class="cmd-name">' + c.name + '</span>' +
                  '<span class="cmd-desc">' + c.desc + '</span>' +
                '</div>';
              }).join('');

              sugBox.querySelectorAll('.cmd-item').forEach(function(el) {
                el.addEventListener('mousedown', function(e) {
                  e.preventDefault();
                  input.value = el.dataset.cmd + ' ';
                  hideSuggestions();
                  input.focus();
                });
              });

              activeIdx = -1;
              sugBox.classList.add('visible');
            }

            input.addEventListener('input', function() {
              var val = input.value;
              if (val.startsWith('/')) {
                showSuggestions(val);
              } else {
                hideSuggestions();
              }
            });

            input.addEventListener('keydown', function(e) {
              var items = sugBox.querySelectorAll('.cmd-item');
              if (sugBox.classList.contains('visible') && items.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive(Math.min(activeIdx + 1, items.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive(Math.max(activeIdx - 1, 0));
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && activeIdx >= 0)) {
                  e.preventDefault();
                  var chosen = items[activeIdx >= 0 ? activeIdx : 0];
                  input.value = chosen.dataset.cmd + ' ';
                  hideSuggestions();
                  return;
                }
                if (e.key === 'Escape') {
                  hideSuggestions();
                  return;
                }
              }
              if (e.key === 'Enter') sendCommand();
            });

            function sendCommand() {
              var cmd = input.value.trim();
              if (!cmd) return;
              hideSuggestions();
              input.value = '';
              sendBtn.disabled = true;
              appendLocalEntry('> ' + cmd, 'control');

              fetch('/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
              })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (data.msg) {
                  data.msg.split('\\n').forEach(function(line) {
                    appendLocalEntry(line, data.success ? 'default' : 'error');
                  });
                }
              })
              .catch(function() {
                appendLocalEntry('Failed to send command.', 'error');
              })
              .finally(function() {
                sendBtn.disabled = false;
                input.focus();
                scheduleRefresh();
              });
            }

            sendBtn.addEventListener('click', sendCommand);

            input.addEventListener('focus', function() {
              typing = true;
              clearTimeout(refreshTimer);
              label.textContent = 'Auto-refresh paused while typing';
            });
            input.addEventListener('blur', function() {
              setTimeout(function() {
                hideSuggestions();
                typing = false;
                label.textContent = 'Auto-refreshing every 5 seconds';
                scheduleRefresh();
              }, 150);
            });

            scrollBottom();
            scheduleRefresh();
          })();
        </script>
      </body>
    </html>
  `);
});

let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });

  botRunning = true;
  clearBotTimeouts();
  isReconnecting = false;
  botState.reconnectAttempts = 0;
  createBot();
  addLog("[Control] Bot started");

  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });

  botRunning = false;
  clearBotTimeouts();
  if (stableConnectionTimerId) {
    clearTimeout(stableConnectionTimerId);
    stableConnectionTimerId = null;
  }
  isReconnecting = false;

  if (bot) {
    const currentBot = bot;
    bot = null;
    try { currentBot.end(); } catch (e) {}
  }

  botState.connected = false;
  clearAllIntervals();
  addLog("[Control] Bot stopped");

  res.json({ success: true });
});

app.post("/command", express.json(), (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });

  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help          - Show this help message",
      "  /pos           - Show bot's current coordinates",
      "  /status        - Show bot connection status",
      "  /list          - Ask server for player list",
      "  /say <message> - Send a chat message in-game",
      "  /<anything>    - Send any Minecraft command directly",
      "  <text>         - Send plain chat (no slash needed)",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const pos = bot && bot.entity ? bot.entity.position : null;
    const msg = pos
      ? `Position: X=${Math.floor(pos.x)}  Y=${Math.floor(pos.y)}  Z=${Math.floor(pos.z)}`
      : "Position unavailable (bot not spawned).";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (cmd === "/status") {
    const status = botState.connected ? "Connected" : "Disconnected";
    const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `Status: ${status} | Uptime: ${uptime}s | Reconnects: ${botState.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (!bot || typeof bot.chat !== "function") {
    const msg = bot
      ? "Bot is still connecting — try again in a moment."
      : "Bot is not running.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent to server: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    addLog(`[Console] Error: ${err.message}`);
    return res.json({ success: false, msg: err.message });
  }
});

// ============================================================
//                    END OF WEB TOOLS
//============================================================

// FIX: handle port conflict gracefully - try next port if taken
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port} `);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = PORT + 1;
    addLog(`[Server] Port ${PORT} in use - trying port ${fallbackPort} `);
    server.listen(fallbackPort, "0.0.0.0");
  } else {
    addLog(`[Server] HTTP server error: ${err.message} `);
  }
});

// FIX: only one definition of formatUptime
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s} s`;
}

// ============================================================
// SELF-PING - Prevent Render from sleeping
// FIX: only ping if RENDER_EXTERNAL_URL is set (skip useless localhost ping)
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) {
    addLog(
      "[KeepAlive] No RENDER_EXTERNAL_URL set - self-ping disabled (running locally)",
    );
    return;
  }
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol
      .get(`${renderUrl}/ping`, (res) => {
        // Silent success
      })
      .on("error", (err) => {
        addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
      });
  }, SELF_PING_INTERVAL);
  addLog("[KeepAlive] Self-ping system started (every 10 min)");
}

startSelfPing();

// ============================================================
// MEMORY MONITORING
// ============================================================
setInterval(
  () => {
    const mem = process.memoryUsage();
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    addLog(`[Memory] Heap: ${heapMB} MB`);
  },
  5 * 60 * 1000,
);

// ============================================================
// BOT CREATION WITH RECONNECTION LOGIC
// ============================================================
// ============================================================
// RECONNECTION & TIMEOUT MANAGEMENT
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let stableConnectionTimerId = null;
let lastKickReason = null;
let isReconnecting = false;

function clearBotTimeouts() {
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }
}

// FIX: Discord rate limiting - track last send time
let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000; // min 5s between webhook calls

function clearAllIntervals() {
  addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const throttleDelay = 90000 + Math.floor(Math.random() * 90000);
    addLog(`[Bot] Server throttle detected; backing off for ${Math.round(throttleDelay / 1000)}s.`);
    return throttleDelay;
  }

  // Do not hammer Aternos after a fast post-spawn kick. Attempts are reset
  // only after a five-minute stable session, not immediately on every spawn.
  const baseDelay = Math.max(5000, Number(config.utils["auto-reconnect-delay"]) || 10000);
  const maxDelay = Math.max(baseDelay, Number(config.utils["max-reconnect-delay"]) || 180000);
  const exponent = Math.min(8, Math.max(0, botState.reconnectAttempts - 1));
  const delay = Math.min(baseDelay * (2 ** exponent), maxDelay);
  const jitter = Math.floor(Math.random() * Math.min(5000, Math.max(500, delay * 0.15)));
  return delay + jitter;
}

// The pathfinder's stock door support only adds fence gates to its openable
// set. It also treats the upper half of a wooden door as a solid wall when
// canDig=false (which this bot intentionally uses). Mark both door halves as
// safe for path calculation, and only queue an interaction for the closed
// lower half / closed trapdoor / closed fence gate.
function configureDoorAwareMovements(bot, movements) {
  if (!bot || !movements || typeof movements.getBlock !== "function") return;
  if (!movements.__doorAwareBlockPatch) {
    movements.canOpenDoors = true;
    if (!movements.openable) movements.openable = new Set();

    for (const blockInfo of bot.registry.blocksArray || []) {
      const name = String(blockInfo.name || "");
      const woodenDoor = name.endsWith("_door") && !name.startsWith("iron_");
      const woodenTrapdoor = name.endsWith("_trapdoor") && !name.startsWith("iron_");
      const fenceGate = name.endsWith("_fence_gate");
      if ((woodenDoor || woodenTrapdoor || fenceGate) && Number.isInteger(blockInfo.id)) {
        movements.openable.add(blockInfo.id);
      }
    }

  const getBlockOriginal = movements.getBlock.bind(movements);
  movements.getBlock = function (pos, dx, dy, dz) {
    const block = getBlockOriginal(pos, dx, dy, dz);
    if (!block || !block.position || !block.name) return block;

    const name = String(block.name);
    const isDoor = name.endsWith("_door") && !name.startsWith("iron_");
    const isTrapdoor = name.endsWith("_trapdoor") && !name.startsWith("iron_");
    const isGate = name.endsWith("_fence_gate");
    if (!isDoor && !isTrapdoor && !isGate) return block;

    const properties = typeof block.getProperties === "function"
      ? block.getProperties()
      : (block._properties || block.properties || {});

    // An openable block must not be sent to safeOrBreak: with canDig=false
    // that makes the route impossible, and with canDig=true it would break it.
    block.safe = true;

    if (isDoor) {
      const upperHalf = properties.half === "upper";
      const lowerBlock = upperHalf
        ? bot.blockAt(block.position.offset(0, -1, 0))
        : block;
      const lowerProperties = lowerBlock && typeof lowerBlock.getProperties === "function"
        ? lowerBlock.getProperties()
        : (lowerBlock && (lowerBlock._properties || lowerBlock.properties)) || properties;
      block.openable = !upperHalf && lowerProperties.open !== true;
    } else {
      // Do not click an already-open block: activating it would close it again
      // and could trap the bot on the next path update.
      block.openable = properties.open !== true;
    }
    return block;
  };
    movements.__doorAwareBlockPatch = true;
  }

  if (bot.__doorAwarePassagePatch) return;
  bot.__doorAwarePassagePatch = true;

  // Remember passages opened by the pathfinder and close them again after the
  // bot has crossed. This prevents doors/gates being left open while avoiding
  // toggling a block that was already open before the bot reached it.
  const openedPassages = new Map();
  const activateBlockOriginal = typeof bot.activateBlock === "function"
    ? bot.activateBlock.bind(bot)
    : null;
  if (activateBlockOriginal) {
    bot.activateBlock = async function (block, ...args) {
      const name = String(block && block.name || "");
      const isPassage = (name.endsWith("_door") && !name.startsWith("iron_")) ||
        (name.endsWith("_trapdoor") && !name.startsWith("iron_")) ||
        name.endsWith("_fence_gate");
      const properties = block && typeof block.getProperties === "function"
        ? block.getProperties()
        : (block && (block._properties || block.properties)) || {};
      const wasClosed = isPassage && properties.open !== true;

      const result = await activateBlockOriginal(block, ...args);
      if (wasClosed && block.position && bot.entity) {
        const key = block.position.x + "," + block.position.y + "," + block.position.z;
        openedPassages.set(key, {
          position: block.position.clone(),
          startPosition: bot.entity.position.clone(),
          openedAt: Date.now(),
          closing: false,
        });
      }
      return result;
    };

    bot.on("physicsTick", () => {
      if (!bot.entity || !openedPassages.size || bot.usingHeldItem) return;
      const now = Date.now();
      for (const [key, passage] of openedPassages) {
        if (passage.closing || now - passage.openedAt < 900) continue;
        const block = bot.blockAt(passage.position);
        if (!block) {
          openedPassages.delete(key);
          continue;
        }
        const properties = typeof block.getProperties === "function"
          ? block.getProperties()
          : (block._properties || block.properties || {});
        if (properties.open !== true) {
          openedPassages.delete(key);
          continue;
        }

        const distance = bot.entity.position.distanceTo(passage.position);
        const movedPast = bot.entity.position.distanceTo(passage.startPosition) > 1.25;
        if (movedPast && distance > 1.35 && distance <= 4.5) {
          passage.closing = true;
          Promise.resolve(activateBlockOriginal(block))
            .catch(() => {})
            .finally(() => openedPassages.delete(key));
        } else if (distance > 8 || now - passage.openedAt > 12000) {
          openedPassages.delete(key);
        }
      }
    });
  }
}


// Backport two path-execution fixes missing from mineflayer-pathfinder 2.4.5.
// 1) A waypoint inside an openable block must stay at the floor center. Older
//    post-processors can move it to the top of the door/gate collision shape,
//    making the bot walk into the frame forever.
// 2) Diagonal jumps into a raised block can clip its corner. The safe route is
//    to use the cardinal jump generated by getMoveJumpUp instead.
function installPathfinderCollisionFixes(bot, movements) {
  if (!bot || !bot.pathfinder || !movements) return;

  if (typeof movements.getMoveDiagonal === "function" && !movements.__safeDiagonalPatch) {
    const originalDiagonal = movements.getMoveDiagonal;
    movements.getMoveDiagonal = function (node, dir, neighbors) {
      // Backport upstream mineflayer-pathfinder PR #393. A diagonal is only
      // valid when BOTH cardinal side corridors are clear for the full body.
      // Checking only the diagonal landing block still lets the 0.6-block
      // player hitbox clip a wall/tree corner during execution.
      const landing = this.getBlock(node, dir.x, 0, dir.z);
      const y = landing && landing.physical ? 1 : 0;

      // Raised diagonal landings are especially likely to clip a corner. The
      // pathfinder will consider the two safer cardinal jump options instead.
      if (y === 1) return;

      const side1Head = this.getBlock(node, 0, y + 1, dir.z);
      const side1Body = this.getBlock(node, 0, y, dir.z);
      const side2Head = this.getBlock(node, dir.x, y + 1, 0);
      const side2Body = this.getBlock(node, dir.x, y, 0);
      if (!side1Head || !side1Body || !side2Head || !side2Body) return;
      if (!side1Head.safe || !side1Body.safe || !side2Head.safe || !side2Body.safe) return;

      return originalDiagonal.call(this, node, dir, neighbors);
    };
    movements.__safeDiagonalPatch = true;
  }

  if (typeof bot.pathfinder.getPathFromTo === "function" && !bot.pathfinder.__waypointPatch) {
    const originalGetPathFromTo = bot.pathfinder.getPathFromTo.bind(bot.pathfinder);
    bot.pathfinder.getPathFromTo = function* (...args) {
      const iterator = originalGetPathFromTo(...args);
      for (const step of iterator) {
        const result = step && step.result;
        const path = result && result.path;
        const moveConfig = args[0] || bot.pathfinder.movements;
        if (Array.isArray(path) && moveConfig) {
          let continueAfterUseBlock = false;
          for (let i = 0; i < path.length; i++) {
            const point = path[i];
            const toBreak = point.toBreak || [];
            const toPlace = point.toPlace || [];
            const usesBlock = toPlace.some((placement) => placement && placement.useOne);

            // Match the newer upstream behavior: opening a door/gate is an
            // interaction, not a placement, so keep post-processing past it.
            if (toBreak.length || (toPlace.length && !usesBlock)) break;
            if (usesBlock) continueAfterUseBlock = true;

            const blockPos = new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z));
            const block = bot.blockAt(blockPos, false);
            if (!block) continue;

            const isOpenable = moveConfig.openable && moveConfig.openable.has(block.type);
            const isLiquid = block.boundingBox === "empty" && moveConfig.liquids &&
              (moveConfig.liquids.has(block.type) || block.isWaterlogged === true);
            const nextPoint = path[i + 1];
            const isDescendingClimbable = nextPoint && nextPoint.y < point.y &&
              (block.name === "ladder" || block.name === "vine");

            if (usesBlock || isOpenable || isLiquid || isDescendingClimbable) {
              // A doorway waypoint is the floor tile inside the opening, not
              // the top of the door leaf / gate collision shape.
              point.x = blockPos.x + 0.5;
              point.y = blockPos.y;
              point.z = blockPos.z + 0.5;
              continue;
            }

            // In 2.4.5 postProcessPath stops at the first useOne interaction.
            // Complete its normal block-top waypoint conversion for the nodes
            // after that interaction so the executor doesn't steer at corners.
            if (continueAfterUseBlock) {
              let top = null;
              if (block.shapes && block.shapes.length) {
                let px = 0.5;
                let py = 0;
                let pz = 0.5;
                let count = 1;
                for (const shape of block.shapes) {
                  const height = shape[4];
                  if (height === py) {
                    px += (shape[0] + shape[3]) / 2;
                    pz += (shape[2] + shape[5]) / 2;
                    count++;
                  } else if (height > py) {
                    count = 2;
                    px = 0.5 + (shape[0] + shape[3]) / 2;
                    py = height;
                    pz = 0.5 + (shape[2] + shape[5]) / 2;
                  }
                }
                top = { x: blockPos.x + px / count, y: blockPos.y + py, z: blockPos.z + pz / count };
              }
              if (!top) {
                const below = bot.blockAt(blockPos.offset(0, -1, 0), false);
                if (below && below.shapes && below.shapes.length) {
                  let px = 0.5;
                  let py = 0;
                  let pz = 0.5;
                  let count = 1;
                  for (const shape of below.shapes) {
                    const height = shape[4];
                    if (height === py) {
                      px += (shape[0] + shape[3]) / 2;
                      pz += (shape[2] + shape[5]) / 2;
                      count++;
                    } else if (height > py) {
                      count = 2;
                      px = 0.5 + (shape[0] + shape[3]) / 2;
                      py = height;
                      pz = 0.5 + (shape[2] + shape[5]) / 2;
                    }
                  }
                  top = { x: blockPos.x + px / count, y: blockPos.y - 1 + py, z: blockPos.z + pz / count };
                }
              }
              if (top) {
                point.x = top.x;
                point.y = top.y;
                point.z = top.z;
              } else {
                point.x = blockPos.x + 0.5;
                point.y = blockPos.y - 1;
                point.z = blockPos.z + 0.5;
              }
            }
          }
        }
        yield step;
      }
    };
    bot.pathfinder.__waypointPatch = true;
  }
}

function createBot() {
  if (!botRunning) {
    addLog("[Bot] Start skipped: bot is stopped.");
    return;
  }
  if (isReconnecting) {
    addLog("[Bot] Already reconnecting, skipping...");
    return;
  }

  // Cleanup previous bot properly to avoid ghost bots
  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      addLog("[Cleanup] Error ending previous bot:", e.message);
    }
    bot = null;
  }

  addLog(`[Bot] Creating bot instance...`);
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    // FIX: use version:false to auto-detect server version so the bot can join any server.
    // If the user explicitly sets a version in settings.json it is still respected.
    const botVersion =
      config.server.version && config.server.version.trim() !== ""
        ? config.server.version
        : false;
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
      checkTimeoutInterval: 600000,
    });

    bot.loadPlugin(pathfinder);
    // Backport the upstream path_update invalidation fix: recovery listeners
    // may replace goals during a path_update callback, and old pathfinder
    // builds can otherwise install the stale result after the callback.
    if (!pathfinderPatchStatus || !["patched", "already-patched"].includes(pathfinderPatchStatus.invalidation)) {
      installPathUpdateInvalidationGuard(bot);
      addLog("[Pathfinder patch] Internal invalidation patch unavailable; runtime compatibility guard enabled.");
    }

    // FIX: connection timeout - end the old bot before reconnecting to avoid ghost bots
    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout - no spawn received");
        try {
          bot.removeAllListeners();
          bot.end();
        } catch (e) {
          /* ignore */
        }
        bot = null;
        scheduleReconnect();
      }
    }, 150000); // 150s - Aternos servers can take 90-120s to finish spawning a player

    // FIX: guard against spawn firing twice (can happen on some servers)
    let spawnHandled = false;

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      isReconnecting = false;
      lastKickReason = null;
      if (stableConnectionTimerId) clearTimeout(stableConnectionTimerId);
      stableConnectionTimerId = setTimeout(() => {
        if (botState.connected) {
          botState.reconnectAttempts = 0;
          botState.wasThrottled = false;
          addLog("[Bot] Connection stable for 5 minutes; reconnect backoff reset.");
        }
        stableConnectionTimerId = null;
      }, 5 * 60 * 1000);

      addLog(
        `[Bot] [+] Successfully spawned on server! (Version: ${bot.version})`,
      );
      if (
        config.discord &&
        config.discord.events &&
        config.discord.events.connect
      ) {
        sendDiscordWebhook(
          `[+] **Connected** to \`${config.server.ip}\``,
          0x4ade80,
        );
      }

      // FIX: use bot.version (auto-detected) instead of config value so minecraft-data always matches
      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      // Adaptive safe-navigation profile for follow, combat, guard and normal
      // movement. It never mines through buildings, but it can use native
      // parkour, sprint-jumps, water routes and 1x1 scaffolding to climb ledges
      // or escape shallow trenches when suitable blocks are in the inventory.
      // Hybrid terrain profile: A* may break selected natural soft blocks only
      // (leaves/foliage and dirt-like terrain) at a high cost as a last resort.
      // All other blocks are placed in blocksCantBreak below, including common
      // house materials, containers, ores and logs.
      defaultMove.canDig = true;
      defaultMove.digCost = 8.0;
      defaultMove.liquidCost = 5; // prefer land, but water is not an impassable wall
      defaultMove.maxDropDown = 4;
      defaultMove.infiniteLiquidDropdownDistance = true;
      defaultMove.allow1by1towers = true;
      defaultMove.allowParkour = true;
      defaultMove.allowSprinting = true;
      defaultMove.allowEntityDetection = true;

      // Dedicated wood profile: clear foliage, parkour and tower when required.
      // Structural blocks and non-natural blocks are protected below so it will
      // not mine houses/paths. Default movement can only clear soft natural terrain.
      const woodMove = new Movements(bot, mcData);
      woodMove.allowFreeMotion = false;
      woodMove.canDig = true;
      woodMove.digCost = 1.0;
      woodMove.liquidCost = 6;
      woodMove.maxDropDown = 4;
      woodMove.infiniteLiquidDropdownDistance = true;
      woodMove.allow1by1towers = true;
      woodMove.allowParkour = true;
      woodMove.allowSprinting = true;
      woodMove.allowEntityDetection = true;
      bot.pathfinder.thinkTimeout = 22000;
      if (defaultMove.blocksCantBreak && mcData.blocksByName) {
        const protectedNames = [
          'bedrock','barrier','end_portal_frame','end_portal','nether_portal',
          'chest','trapped_chest','ender_chest','barrel','shulker_box',
          'spawner','trial_spawner','vault','beacon','enchanting_table',
          'anvil','chipped_anvil','damaged_anvil','furnace','blast_furnace',
          'smoker','brewing_stand','hopper','dispenser','dropper',
          'diamond_ore','deepslate_diamond_ore','emerald_ore','deepslate_emerald_ore',
          'ancient_debris','gold_ore','deepslate_gold_ore','iron_ore','deepslate_iron_ore',
          'redstone_ore','deepslate_redstone_ore','lapis_ore','deepslate_lapis_ore',
          'oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log',
          'mangrove_log','cherry_log','crimson_stem','warped_stem',
          'stripped_oak_log','stripped_spruce_log','stripped_birch_log','stripped_jungle_log',
          'stripped_acacia_log','stripped_dark_oak_log','stripped_mangrove_log',
          'stripped_cherry_log','stripped_crimson_stem','stripped_warped_stem'
        ];
        for (const name of protectedNames) {
          const block = mcData.blocksByName[name];
          if (block) defaultMove.blocksCantBreak.add(block.id);
        }
      }
      // 1x1 towers only work if the bot has a supported scaffold block.
      if (Array.isArray(defaultMove.scafoldingBlocks)) {
        for (const name of [
          'dirt','coarse_dirt','rooted_dirt','cobblestone','cobbled_deepslate',
          'deepslate','polished_deepslate','netherrack','stone','andesite',
          'stone_bricks','mossy_cobblestone','bricks',
          'oak_planks','spruce_planks','birch_planks','jungle_planks',
          'acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks',
          'crimson_planks','warped_planks'
        ]) {
          const item = mcData.itemsByName && mcData.itemsByName[name];
          if (item && !defaultMove.scafoldingBlocks.includes(item.id)) defaultMove.scafoldingBlocks.push(item.id);
        }
      }
      // Woodcutting must not dig through constructed blocks. Protect common
      // house/building materials while leaving leaves and soft foliage breakable.
      const structuralPatterns = [
        /_planks$/, /_log$/, /_wood$/, /_stem$/, /_hyphae$/, /_stairs$/,
        /_slab$/, /_fence$/, /_fence_gate$/, /_wall$/, /_door$/, /_trapdoor$/,
        /_glass$/, /_glass_pane$/, /_wool$/, /_terracotta$/, /_concrete$/,
        /_bricks$/, /_brick$/, /_carpet$/, /_bed$/, /_sign$/, /_hanging_sign$/,
      ];
      const structuralNames = new Set([
        "stone", "cobblestone", "mossy_cobblestone", "stone_bricks",
        "mossy_stone_bricks", "cracked_stone_bricks", "chiseled_stone_bricks",
        "andesite", "polished_andesite", "diorite", "polished_diorite",
        "granite", "polished_granite", "deepslate", "cobbled_deepslate",
        "polished_deepslate", "deepslate_bricks", "deepslate_tiles",
        "bricks", "mud_bricks", "packed_mud", "sandstone", "red_sandstone",
        "smooth_sandstone", "smooth_red_sandstone", "prismarine",
        "dark_prismarine", "prismarine_bricks", "quartz_block", "quartz_bricks",
        "glass", "glass_pane", "iron_bars", "chain", "lantern", "soul_lantern",
        "torch", "wall_torch", "crafting_table", "furnace", "blast_furnace",
        "smoker", "barrel", "chest", "trapped_chest", "ender_chest",
      ]);
      if (woodMove.blocksCantBreak && mcData.blocksArray) {
        const leafIds = new Set();
        const defaultDiggable = /(_leaves$|^(short_grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|hanging_roots|cave_vines|cave_vines_plant|seagrass|tall_seagrass|kelp|kelp_plant|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|gravel|sand|red_sand|clay|snow_block)$)/;
        for (const block of mcData.blocksArray) {
          const name = String(block.name || "");
          if (name.endsWith("_leaves")) leafIds.add(block.id);
          if (structuralNames.has(name) || structuralPatterns.some((pattern) => pattern.test(name))) {
            woodMove.blocksCantBreak.add(block.id);
          }
          // The general profile is deliberately more conservative than the
          // woodcutting profile: only common soft natural terrain/vegetation
          // may be cleared. Every other registered block is protected.
          if (defaultMove.blocksCantBreak && !defaultDiggable.test(name)) {
            defaultMove.blocksCantBreak.add(block.id);
          }
        }
        // Allow leaves to be cleared by both profiles; all non-leaf blocks in
        // the normal profile remain protected unless listed in defaultDiggable.
        for (const id of leafIds) {
          woodMove.blocksCantBreak.delete(id);
          if (woodMove.blocksToAvoid) woodMove.blocksToAvoid.delete(id);
          if (defaultMove.blocksCantBreak) defaultMove.blocksCantBreak.delete(id);
          if (defaultMove.blocksToAvoid) defaultMove.blocksToAvoid.delete(id);
        }
        // Leaves can be adjacent to water. Preserve Mineflayer's normal safety
        // checks, but permit the foliage dig while avoiding fluid-flow stalls.
        for (const movement of [defaultMove, woodMove]) {
          if (!leafIds.size || typeof movement.safeToBreak !== "function") continue;
          const originalSafeToBreak = movement.safeToBreak.bind(movement);
          movement.safeToBreak = function (block) {
            if (block && leafIds.has(block.type)) {
              const oldDontCreateFlow = this.dontCreateFlow;
              this.dontCreateFlow = false;
              try { return originalSafeToBreak(block); }
              finally { this.dontCreateFlow = oldDontCreateFlow; }
            }
            return originalSafeToBreak(block);
          };
        }
        addLog(`[Pathfinder] Hybrid terrain profile: default may clear only whitelisted soft terrain and foliage (digCost=${defaultMove.digCost}); wood profile clears foliage and protected non-structural natural blocks; buildings/ores/containers protected.`);
      }
      if (Array.isArray(woodMove.scafoldingBlocks)) {
        for (const name of [
          'dirt','coarse_dirt','rooted_dirt','cobblestone','cobbled_deepslate',
          'deepslate','polished_deepslate','netherrack','stone','andesite',
          'stone_bricks','mossy_cobblestone','bricks',
          'oak_planks','spruce_planks','birch_planks','jungle_planks',
          'acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks',
          'crimson_planks','warped_planks'
        ]) {
          const item = mcData.itemsByName && mcData.itemsByName[name];
          if (item && !woodMove.scafoldingBlocks.includes(item.id)) woodMove.scafoldingBlocks.push(item.id);
        }
      }
      addLog(`[Pathfinder] ${bot.version}: hybrid(canDig=${defaultMove.canDig}, digCost=${defaultMove.digCost}, parkour=${defaultMove.allowParkour}, sprint=${defaultMove.allowSprinting}, towers=${defaultMove.allow1by1towers}, liquidCost=${defaultMove.liquidCost}) wood(canDig=${woodMove.canDig}, parkour=${woodMove.allowParkour}, sprint=${woodMove.allowSprinting}, towers=${woodMove.allow1by1towers}, liquidCost=${woodMove.liquidCost})`);
      configureDoorAwareMovements(bot, defaultMove);
      configureDoorAwareMovements(bot, woodMove);
      installPathfinderCollisionFixes(bot, defaultMove);
      installPathfinderCollisionFixes(bot, woodMove);
      // Rescue profile: used by alternate-route recovery when the normal route
      // fails. Parkour + sprint-jumps, longer drops, cheap terrain clearing and
      // scaffolding, while buildings/ores/containers stay protected.
      const rescueMove = new Movements(bot, mcData);
      rescueMove.allowFreeMotion = false;
      rescueMove.canDig = true;
      rescueMove.digCost = 2.0;
      rescueMove.liquidCost = 2;
      rescueMove.maxDropDown = 6;
      rescueMove.infiniteLiquidDropdownDistance = true;
      rescueMove.allow1by1towers = true;
      rescueMove.allowParkour = true;
      rescueMove.allowSprinting = true;
      rescueMove.allowEntityDetection = true;
      if (woodMove.blocksCantBreak) rescueMove.blocksCantBreak = new Set(woodMove.blocksCantBreak);
      if (Array.isArray(woodMove.scafoldingBlocks)) rescueMove.scafoldingBlocks = [...woodMove.scafoldingBlocks];
      if (typeof woodMove.safeToBreak === "function") rescueMove.safeToBreak = woodMove.safeToBreak;
      configureDoorAwareMovements(bot, rescueMove);
      installPathfinderCollisionFixes(bot, rescueMove);
      addLog("[Pathfinder] Hybrid A* movement enabled: parkour, sprint-jumps, water routes, safe scaffolding, and high-cost soft-terrain clearing; structures and valuable blocks remain protected.");
      let lastPathDiagnosticAt = 0;
      bot.on("path_reset", (reason) => {
        if (!["stuck", "no_scaffolding_blocks", "place_error", "dig_error"].includes(reason)) return;
        const now = Date.now();
        if (now - lastPathDiagnosticAt < 2500) return;
        lastPathDiagnosticAt = now;
        const pos = bot.entity && bot.entity.position;
        addLog(`[Pathfinder] reset=${reason}${pos ? ` at ${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}` : ""}`);
      });
      bot.on("path_update", (result) => {
        if (!result || !["noPath", "timeout"].includes(result.status)) return;
        const now = Date.now();
        if (now - lastPathDiagnosticAt < 2500) return;
        lastPathDiagnosticAt = now;
        addLog(`[Pathfinder] search=${result.status}`);
      });

      initializeModules(bot, mcData, defaultMove);

      // chat commands: !wood !follow !kill !guard !pvp ...
      if (!config.commands || config.commands.enabled !== false) {
        cmd.initCommands(bot, mcData, defaultMove, { addInterval, addLog, config, woodMove, rescueMove });
      }

      // Attempt creative mode (only works if bot has OP and enabled in settings)
      setTimeout(() => {
        if (bot && botState.connected && config.server["try-creative"]) {
          bot.chat("/gamemode creative");
          addLog("[INFO] Attempted to set creative mode (requires OP)");
        }
      }, 3000);

      bot.on("messagestr", (message) => {
        if (
          message.includes("commands.gamemode.success.self") ||
          message.includes("Set own game mode to Creative Mode")
        ) {
          addLog("[INFO] Bot is now in Creative Mode.");
        }
      });
    });

    // FIX: 'kicked' fires before 'end'. Remove the scheduleReconnect from 'kicked'
    // so that 'end' is the single source of reconnect truth, preventing double-trigger.
    bot.on("kicked", (reason) => {
      // FIX: stringify reason if it's an object to make it readable in logs
      const kickReason =
        typeof reason === "object" ? JSON.stringify(reason) : reason;
      lastKickReason = String(kickReason || "Unknown kick reason");
      addLog(`[Bot] Kicked: ${lastKickReason}`);
      botState.connected = false;
      botState.errors.push({
        type: "kicked",
        reason: kickReason,
        time: Date.now(),
      });
      clearAllIntervals();

      const reasonStr = String(kickReason).toLowerCase();
      if (
        reasonStr.includes("throttl") ||
        reasonStr.includes("wait before reconnect") ||
        reasonStr.includes("too fast") ||
        reasonStr.includes("too many login") ||
        reasonStr.includes("rate limit")
      ) {
        addLog(
          "[Bot] Throttle kick detected - will use extended reconnect delay",
        );
        botState.wasThrottled = true;
      }

      if (
        config.discord &&
        config.discord.events &&
        config.discord.events.disconnect
      ) {
        sendDiscordWebhook(`[!] **Kicked**: ${kickReason}`, 0xff0000);
      }
      // NOTE: do NOT call scheduleReconnect() here - 'end' will fire right after 'kicked' and handle it
    });

    // FIX: 'end' is the single reconnect trigger
    bot.on("end", (reason) => {
      const disconnectReason = String(reason || lastKickReason || "Socket closed without a reason");
      addLog(`[Bot] Disconnected: ${disconnectReason}`);
      if (stableConnectionTimerId) {
        clearTimeout(stableConnectionTimerId);
        stableConnectionTimerId = null;
      }
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false; // reset for next connection

      if (
        config.discord &&
        config.discord.events &&
        config.discord.events.disconnect
      ) {
        sendDiscordWebhook(
          `[-] **Disconnected**: ${disconnectReason}`,
          0xf87171,
        );
      }

      scheduleReconnect(disconnectReason);
    });

    bot.on("error", (err) => {
      // Many network errors (AggregateError, ECONNREFUSED...) have an empty
      // .message; show the code and nested errors so the cause is visible.
      const parts = [];
      if (err.message) parts.push(err.message);
      if (err.code) parts.push(`code=${err.code}`);
      if (err.syscall) parts.push(`syscall=${err.syscall}`);
      if (err.address) parts.push(`address=${err.address}${err.port ? ":" + err.port : ""}`);
      if (Array.isArray(err.errors)) {
        for (const sub of err.errors) parts.push(`[${sub.code || sub.name}${sub.address ? " " + sub.address + ":" + sub.port : ""}]`);
      }
      const msg = parts.join(" ") || String(err.name || err);
      addLog(`[Bot] Error: ${msg}`);
      botState.errors.push({ type: "error", message: msg, time: Date.now() });
      // Don't reconnect on error - let 'end' event handle it
    });
  } catch (err) {
    addLog(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect(reason = "connection ended") {
  clearBotTimeouts();

  if (!botRunning || config.utils["auto-reconnect"] === false) {
    addLog("[Bot] Reconnect skipped: bot was stopped or auto-reconnect is disabled.");
    isReconnecting = false;
    return;
  }
  if (isReconnecting) {
    addLog("[Bot] Reconnect already scheduled; duplicate request ignored.");
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${Math.round(delay / 1000)}s (attempt #${botState.reconnectAttempts}; reason: ${reason}).`);

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    if (botRunning && config.utils["auto-reconnect"] !== false) createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  addLog("[Modules] Initializing all modules...");

  // ---------- AUTO AUTH (REACTIVE) ----------
  if (config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
    const password = config.utils["auto-auth"].password;
    let authHandled = false;

    const tryAuth = (type) => {
      if (authHandled || !bot || !botState.connected) return;
      authHandled = true;
      if (type === "register") {
        bot.chat(`/register ${password} ${password}`);
        addLog("[Auth] Detected register prompt - sent /register");
      } else {
        bot.chat(`/login ${password}`);
        addLog("[Auth] Detected login prompt - sent /login");
      }
    };

    bot.on("messagestr", (message) => {
      if (authHandled) return;
      const msg = message.toLowerCase();
      if (
        msg.includes("/register") ||
        msg.includes("register ") ||
        msg.includes("지정된 비밀번호")
      ) {
        tryAuth("register");
      } else if (
        msg.includes("/login") ||
        msg.includes("login ") ||
        msg.includes("로그인")
      ) {
        tryAuth("login");
      }
    });

    // Failsafe: if no prompt after 10s, try login anyway
    setTimeout(() => {
      if (!authHandled && bot && botState.connected) {
        addLog(
          "[Auth] No prompt detected after 10s, sending /login as failsafe",
        );
        bot.chat(`/login ${password}`);
        authHandled = true;
      }
    }, 10000);
  }

  // ---------- CHAT MESSAGES ----------
  if (config.utils["chat-messages"] && config.utils["chat-messages"].enabled) {
    const messages = config.utils["chat-messages"].messages;
    if (config.utils["chat-messages"].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, config.utils["chat-messages"]["repeat-delay"] * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => {
          if (bot && botState.connected) bot.chat(msg);
        }, idx * 1000);
      });
    }
  }

  // ---------- MOVE TO POSITION ----------
  // FIX: only use position goal if circle-walk is NOT enabled (they fight over pathfinder)
  if (
    config.position &&
    config.position.enabled &&
    !cmd.hasHome() &&
    !(
      config.movement &&
      config.movement["circle-walk"] &&
      config.movement["circle-walk"].enabled
    )
  ) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(
      new GoalBlock(config.position.x, config.position.y, config.position.z),
    );
    addLog("[Position] Navigating to configured position...");
  }

  // ---------- ANTI-AFK ----------
  if (config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
    // Arm swinging
    addInterval(
      () => {
        if (!bot || !botState.connected) return;
        try {
          bot.swingArm();
        } catch (e) {}
      },
      10000 + Math.floor(Math.random() * 50000),
    );

    // Hotbar cycling
    addInterval(
      () => {
        if (!bot || !botState.connected || !cmd.isIdle()) return;
        try {
          const slot = Math.floor(Math.random() * 9);
          bot.setQuickBarSlot(slot);
        } catch (e) {}
      },
      30000 + Math.floor(Math.random() * 90000),
    );

    // Teabagging
    addInterval(
      () => {
        if (
          !bot ||
          !botState.connected ||
          !cmd.isIdle() ||
          typeof bot.setControlState !== "function"
        )
          return;
        if (Math.random() > 0.9) {
          let count = 2 + Math.floor(Math.random() * 4);
          const doTeabag = () => {
            if (count <= 0 || !bot || typeof bot.setControlState !== "function")
              return;
            try {
              bot.setControlState("sneak", true);
              setTimeout(() => {
                if (bot && typeof bot.setControlState === "function")
                  bot.setControlState("sneak", false);
                count--;
                setTimeout(doTeabag, 150);
              }, 150);
            } catch (e) {}
          };
          doTeabag();
        }
      },
      120000 + Math.floor(Math.random() * 180000),
    );

    // FIX: micro-walk only when circle-walk is NOT running, to avoid interrupting pathfinder
    if (
      !(
        config.movement &&
        config.movement["circle-walk"] &&
        config.movement["circle-walk"].enabled
      )
    ) {
      addInterval(
        () => {
          if (
            !bot ||
            !botState.connected ||
            !cmd.isRoaming() ||
            typeof bot.setControlState !== "function"
          )
            return;
          try {
            const yaw = Math.random() * Math.PI * 2;
            bot.look(yaw, 0, true);
            bot.setControlState("forward", true);
            setTimeout(
              () => {
                if (bot && typeof bot.setControlState === "function")
                  bot.setControlState("forward", false);
              },
              500 + Math.floor(Math.random() * 1500),
            );
            botState.lastActivity = Date.now();
          } catch (e) {
            addLog("[AntiAFK] Walk error:", e.message);
          }
        },
        120000 + Math.floor(Math.random() * 360000),
      );
    }

    if (config.utils["anti-afk"].sneak) {
      try {
        if (typeof bot.setControlState === "function")
          bot.setControlState("sneak", true);
      } catch (e) {}
    }
  }

  // ---------- MOVEMENT MODULES ----------
  // FIX: check top-level movement.enabled flag
  if (config.movement && config.movement.enabled !== false) {
    // FIX: circle-walk and random-jump both jump - only run one jumping mechanism
    // random-jump is skipped if anti-afk jump is handled elsewhere; we only use random-jump here
    if (
      config.movement["circle-walk"] &&
      config.movement["circle-walk"].enabled
    ) {
      startCircleWalk(bot, defaultMove);
    }
    // FIX: only run random-jump if circle-walk is NOT running (circle-walk also keeps bot moving)
    if (
      config.movement["random-jump"] &&
      config.movement["random-jump"].enabled &&
      !(
        config.movement["circle-walk"] && config.movement["circle-walk"].enabled
      )
    ) {
      startRandomJump(bot);
    }
    if (
      config.movement["look-around"] &&
      config.movement["look-around"].enabled
    ) {
      startLookAround(bot);
    }
  }

  // ---------- CUSTOM MODULES ----------
  // FIX: avoidMobs AND combatModule conflict - if combat is enabled, don't run avoidMobs at the same time
  if (config.modules.avoidMobs && !config.modules.combat) {
    avoidMobs(bot);
  }
  // Auto-eat is independent of the optional mob-combat module.
  if (config.modules.combat || (config.combat && config.combat["auto-eat"])) {
    combatModule(bot, mcData, !!config.modules.combat);
  }
  if (config.modules.beds) {
    bedModule(bot, mcData);
  }
  if (config.modules.chat) {
    chatModule(bot);
  }

  addLog("[Modules] All modules initialized!");
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
function startCircleWalk(bot, defaultMove) {
  const radius = config.movement["circle-walk"].radius;
  let angle = 0;
  let lastPathTime = 0;
  let lastPos = null;

  addInterval(() => {
    if (!bot || !botState.connected || cmd.isStationary()) return;
    const now = Date.now();
    if (now - lastPathTime < 2000) return;
    lastPathTime = now;
    try {
      // Roam stuck-breaker: if the last roam step barely moved us, the bot is
      // wedged on a corner/ledge. Pick a very different heading and shake loose.
      const here = bot.entity.position;
      if (lastPos && here.distanceTo(lastPos) < 0.6 && bot.pathfinder.isMoving()) {
        angle += Math.PI * 0.75 + Math.random();
        const side = Math.random() < 0.5 ? "left" : "right";
        bot.setControlState(side, true);
        bot.setControlState("jump", true);
        setTimeout(() => {
          try { bot.setControlState(side, false); bot.setControlState("jump", false); } catch (e) {}
        }, 450);
      }
      lastPos = here.clone();
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(
        new GoalBlock(
          Math.floor(x),
          Math.floor(bot.entity.position.y),
          Math.floor(z),
        ),
      );
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[CircleWalk] Error:", e.message);
    }
  }, config.movement["circle-walk"].speed);
}

function startRandomJump(bot) {
  addInterval(() => {
    if (
      !bot ||
      !botState.connected ||
      !cmd.isRoaming() ||
      typeof bot.setControlState !== "function"
    )
      return;
    try {
      bot.setControlState("jump", true);
      setTimeout(() => {
        if (bot && typeof bot.setControlState === "function")
          bot.setControlState("jump", false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[RandomJump] Error:", e.message);
    }
  }, config.movement["random-jump"].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    if (!bot || !botState.connected || !cmd.isRoaming()) return;
    try {
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
      bot.look(yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[LookAround] Error:", e.message);
    }
  }, config.movement["look-around"].interval);
}

// ============================================================
// CUSTOM MODULES
// ============================================================

// Avoid mobs/players
// FIX: e.username only exists on players; use e.name for mobs - now handled properly
function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (
      !bot ||
      !botState.connected ||
      typeof bot.setControlState !== "function"
    )
      return;
    try {
      const entities = Object.values(bot.entities).filter(
        (e) =>
          e.type === "mob" ||
          (e.type === "player" && e.username !== bot.username),
      );
      for (const e of entities) {
        if (!e.position) continue;
        const distance = bot.entity.position.distanceTo(e.position);
        if (distance < safeDistance) {
          bot.setControlState("back", true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === "function")
              bot.setControlState("back", false);
          }, 500);
          break;
        }
      }
    } catch (e) {
      addLog("[AvoidMobs] Error:", e.message);
    }
  }, 2000);
}

// Combat module
// Respects the 1.9+ attack cooldown, keeps a target briefly, and auto-eats
// from every edible item known to the active Minecraft registry.
function combatModule(bot, mcData, enableMobCombat = true) {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;
  let eatingNow = false;
  let lastEatAttempt = 0;

  bot.on("physicsTick", () => {
    if (!bot || !botState.connected) return;
    if (!enableMobCombat || !config.combat["attack-mobs"]) return;
    if (!cmd.isIdle() || cmd.ctx.eating) return; // command modes manage their own combat

    const now = Date.now();
    if (now - lastAttackTime < 620) return;

    try {
      if (
        lockedTarget &&
        now < lockedTargetExpiry &&
        bot.entities[lockedTarget.id] &&
        lockedTarget.position
      ) {
        const dist = bot.entity.position.distanceTo(lockedTarget.position);
        if (dist < 4) {
          bot.attack(lockedTarget);
          lastAttackTime = now;
          return;
        }
        lockedTarget = null;
      }

      const mobs = Object.values(bot.entities).filter(
        (e) => isHostile(e) && e.position && bot.entity.position.distanceTo(e.position) < 4,
      );
      if (mobs.length > 0) {
        lockedTarget = mobs[0];
        lockedTargetExpiry = now + 3000;
        bot.attack(lockedTarget);
        lastAttackTime = now;
      }
    } catch (e) {
      addLog("[Combat] Error:", e.message);
    }
  });

  function foodData(item) {
    const registry = bot.registry || {};
    const foods = registry.foodsByName || mcData.foodsByName || {};
    const food = foods[item.name] || (registry.foods && registry.foods[item.name]) || {};
    const itemFoodPoints = Number(item.foodPoints);
    const itemSaturation = Number(item.saturation);
    const foodPoints = itemFoodPoints > 0 ? itemFoodPoints : Number(food.foodPoints || 0);
    const saturation = itemSaturation > 0 ? itemSaturation : Number(food.saturation || 0);
    return { foodPoints, saturation };
  }

  async function tryAutoEat() {
    if (!config.combat["auto-eat"] || !bot || !botState.connected || !bot.entity) return;
    if (eatingNow || cmd.ctx.eating || bot.food >= 18 || Date.now() - lastEatAttempt < 1200) return;
    lastEatAttempt = Date.now();

    const choices = bot.inventory.items()
      .map((item) => ({ item, data: foodData(item) }))
      .filter((entry) => entry.data.foodPoints > 0)
      .sort((a, b) =>
        b.data.foodPoints - a.data.foodPoints || b.data.saturation - a.data.saturation,
      );
    if (!choices.length) return;

    const food = choices[0].item;
    const previousHeld = bot.heldItem;
    eatingNow = true;
    cmd.ctx.eating = true;
    try {
      await bot.equip(food, "hand");
      await bot.consume();
    } catch (e) {
      addLog("[AutoEat] Error:", e.message);
    } finally {
      try {
        // Restore the previous hand item when the same stack still exists.
        if (previousHeld && previousHeld.name !== food.name) {
          const restore = bot.inventory.items().find(
            (item) => item.name === previousHeld.name && item.metadata === previousHeld.metadata,
          );
          if (restore) await bot.equip(restore, "hand");
        }
      } catch (e) {
        // The prior item may have been moved or consumed in the meantime.
      }
      eatingNow = false;
      cmd.ctx.eating = false;
    }
  }

  // physicsTick makes eating reliable even when a server does not emit a
  // separate health event for every hunger update.
  bot.on("physicsTick", () => {
    if (bot && botState.connected && bot.food < 18) {
      tryAutoEat().catch((e) => addLog("[AutoEat] Error:", e.message));
    }
  });
  bot.on("health", () => {
    if (bot && botState.connected && bot.food < 18) {
      tryAutoEat().catch((e) => addLog("[AutoEat] Error:", e.message));
    }
  });
}

// Bed module
// FIX: bot.isSleeping can be stale; use a local isTryingToSleep guard to prevent double-sleep errors
// FIX: place-night was false in default settings - documentation note added
function bedModule(bot, mcData) {
  let isTryingToSleep = false;

  addInterval(async () => {
    if (!bot || !botState.connected) return;
    if (!config.beds["place-night"]) return; // FIX: check flag (was always skipping before)

    try {
      const isNight =
        bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;

      // FIX: use local guard instead of stale bot.isSleeping
      if (isNight && !isTryingToSleep) {
        const bedBlock = bot.findBlock({
          matching: (block) => block.name.includes("bed"),
          maxDistance: 8,
        });

        if (bedBlock) {
          isTryingToSleep = true;
          try {
            await bot.sleep(bedBlock);
            addLog("[Bed] Sleeping...");
          } catch (e) {
            // Can't sleep - maybe not night enough or monsters nearby
          } finally {
            isTryingToSleep = false;
          }
        }
      }
    } catch (e) {
      isTryingToSleep = false;
      addLog("[Bed] Error:", e.message);
    }
  }, 10000);
}

// Chat module
// FIX: wire up discord.events.chat flag
function chatModule(bot) {
  bot.on("chat", (username, message) => {
    if (!bot || username === bot.username) return;

    try {
      // FIX: send chat events to Discord if enabled
      if (
        config.discord &&
        config.discord.enabled &&
        config.discord.events &&
        config.discord.events.chat
      ) {
        sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
      }

      if (config.chat && config.chat.respond) {
        const lowerMsg = message.toLowerCase();
        if (!message.startsWith("!") && (lowerMsg.includes("hello") || lowerMsg.includes("hi"))) {
          bot.chat(`Hello, ${username}!`);
        }
        if (message.startsWith("!tp ")) {
          const target = message.split(" ")[1];
          if (target) bot.chat(`/tp ${target}`);
        }
      }
    } catch (e) {
      addLog("[Chat] Error:", e.message);
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  if (!bot || !botState.connected) {
    addLog("[Console] Bot not connected");
    return;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith("say ")) {
    bot.chat(trimmed.slice(4));
  } else if (trimmed.startsWith("cmd ")) {
    bot.chat("/" + trimmed.slice(4));
  } else if (trimmed === "status") {
    addLog(
      `Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`,
    );
  } else {
    bot.chat(trimmed);
  }
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// FIX: use Buffer.byteLength for Content-Length (handles non-ASCII usernames correctly)
// FIX: rate limiting to avoid spam when bot is flapping
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (
    !config.discord ||
    !config.discord.enabled ||
    !config.discord.webhookUrl ||
    config.discord.webhookUrl.includes("YOUR_DISCORD")
  )
    return;

  // FIX: Discord rate limiting - skip if sent too recently
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    addLog("[Discord] Rate limited - skipping webhook");
    return;
  }
  lastDiscordSend = now;

  const protocol = config.discord.webhookUrl.startsWith("https") ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);

  const payload = JSON.stringify({
    username: config.name,
    embeds: [
      {
        description: content,
        color: color,
        timestamp: new Date().toISOString(),
        footer: { text: "Slobos AFK Bot" },
      },
    ],
  });

  const options = {
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // FIX: use Buffer.byteLength instead of payload.length - handles non-ASCII (e.g. usernames with accents/emoji)
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    },
  };

  const req = protocol.request(options, (res) => {
    // Silent success
  });

  req.on("error", (e) => {
    addLog(`[Discord] Error sending webhook: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY - IMMORTAL MODE
// FIX: guard against uncaughtException stacking reconnects when isReconnecting is already true
// ============================================================
process.on("uncaughtException", (err) => {
  const msg = err.message || "Unknown";
  addLog(`[FATAL] Uncaught Exception: ${msg}`);
  botState.errors.push({ type: "uncaught", message: msg, time: Date.now() });

  // Cap errors array to prevent memory leak over long uptimes
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError =
    msg.includes("PartialReadError") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("timed out") ||
    msg.includes("write after end") ||
    msg.includes("This socket has been ended");

  if (isNetworkError) {
    addLog("[FATAL] Known network/protocol error - recovering gracefully...");
  }

  // ALWAYS recover — bot must never stay disconnected
  clearAllIntervals();
  botState.connected = false;

  // FIX: reset isReconnecting if it was stuck, then schedule reconnect
  if (isReconnecting) {
    addLog(
      "[FATAL] isReconnecting was stuck - resetting before crash recovery",
    );
    isReconnecting = false;
    // BUG FIX: was referencing non-existent 'reconnectTimeout' — correct name is 'reconnectTimeoutId'
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  setTimeout(
    () => {
      scheduleReconnect();
    },
    isNetworkError ? 5000 : 10000,
  );
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  addLog(`[FATAL] Unhandled Rejection: ${reason}`);
  botState.errors.push({ type: "rejection", message: msg, time: Date.now() });
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError =
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("timed out") ||
    msg.includes("PartialReadError");

  if (isNetworkError && !isReconnecting) {
    addLog("[FATAL] Network rejection — triggering reconnect...");
    clearAllIntervals();
    botState.connected = false;
    if (bot) {
      try { bot.end(); } catch (_) {}
      bot = null;
    }
    scheduleReconnect();
  }
});

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  addLog(`[System] ${signal} received — shutting down cleanly.`);

  // Do not allow a disconnect event to schedule another Minecraft connection
  // while the host is stopping or replacing this process.
  botRunning = false;
  isReconnecting = false;
  clearBotTimeouts();
  clearAllIntervals();
  if (stableConnectionTimerId) {
    clearTimeout(stableConnectionTimerId);
    stableConnectionTimerId = null;
  }

  const activeBot = bot;
  bot = null;
  botState.connected = false;
  if (activeBot) {
    try { activeBot.end(); } catch (error) {
      addLog(`[System] Error closing Minecraft connection: ${error.message}`);
    }
  }

  // Close the dashboard HTTP listener too, then let the container exit.
  server.close((error) => {
    if (error) {
      addLog(`[System] HTTP shutdown error: ${error.message}`);
      process.exitCode = 1;
    }
    process.exit();
  });

  // Avoid hanging forever if an HTTP request or socket fails to close.
  const forceExit = setTimeout(() => {
    addLog("[System] Graceful shutdown timed out; forcing process exit.");
    process.exit(1);
  }, 10000);
  forceExit.unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// =============================
//===============================
// START THE BOT
// ============================================================
addLog("=".repeat(50));
addLog("  Minecraft AFK Bot v2.5 - Bug-Fixed Edition");
addLog("=".repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version}`);
addLog(
  `Auto-Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled"}`,
);
addLog("=".repeat(50));

createBot();
