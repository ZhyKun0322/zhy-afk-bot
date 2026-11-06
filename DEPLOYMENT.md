# Deployment (v11)

## Important: do not deploy the Minecraft bot as a Vercel Function

This application is a continuously running Node.js process. It opens and maintains an outbound TCP connection to the Minecraft server, runs reconnect timers and movement/combat loops, and also serves an Express dashboard. Vercel Functions are request/invocation-based and are terminated when an invocation exceeds its configured maximum duration; they are not a 24/7 persistent process host. A Vercel deployment can therefore show `500 FUNCTION_INVOCATION_FAILED`, and increasing `maxDuration` does not turn it into an always-on bot.

Use a **persistent service** host instead (for example Railway Services). Do not create a Railway Function or Cron Job for this app.

## Railway deployment

1. Extract this ZIP. The files inside it are already at the project root; do not upload the parent ZIP folder as an extra nested directory.
2. Put the project in a **private** Git repository. Review `settings.json` before pushing: it contains the Minecraft server/account and auto-auth configuration. Never publish real passwords or tokens in a public repository.
3. In Railway, create a project and deploy the repository as a **Service**. Keep the root directory as `.` (the repository root).
4. Railway will use `railway.toml` and `Dockerfile`. The Docker build copies `scripts/` before running `npm ci`, so the `postinstall` pathfinder patcher is present when npm executes it.
5. Check the deployment logs for `[Pathfinder patch]` messages, then open the service's public domain to view the Express dashboard.
6. The service must remain a persistent/always-on service. Do not switch it to a Function or Cron Job.

## Local verification

- Node.js 22 is specified in `package.json` and the Dockerfile.
- `npm ci` installs dependencies and applies `scripts/patch-pathfinder.js` in `postinstall`.
- `npm test` runs syntax, config, and navigation regression checks.
- `npm start` runs the bot and its HTTP dashboard.

## What changed from v10

- Flattened the ZIP so `package.json`, `index.js`, and `scripts/patch-pathfinder.js` are all at the archive/project root. This fixes the nested-root layout that caused `Cannot find module '/vercel/path0/scripts/patch-pathfinder.js'` when the deploy root was incorrect.
- Added a Dockerfile and Railway persistent-service configuration.
- Replaced the old SIGTERM/SIGINT handlers (which ignored shutdown signals) with graceful shutdown, stopping reconnect timers and closing the Minecraft and HTTP connections before exit.

A successful build does not prove the Minecraft server will accept the bot connection; inspect the runtime logs for server-side kick/auth/version errors.

## v12 application update

- Automatic sleep has priority over active command modes at Minecraft night. It pauses and later resumes the saved task, searches for a placed bed within 48 blocks, and sends bed navigation through the shared stuck-recovery controller.
- Use `!sleepstatus` in Minecraft chat to confirm whether the toggle is on, whether the server's Minecraft world time is in the sleep window, and whether a loaded bed is nearby. A bed item in inventory is not a placed bed.
- Stuck recovery no longer remains permanently failed when no safe escape position is immediately available. Its candidate timeout now respects the configured A* think timeout instead of cancelling searches after 6.5 seconds.
