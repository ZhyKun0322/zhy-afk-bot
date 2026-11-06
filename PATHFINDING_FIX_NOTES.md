# Pathfinding update v5

This update is based on the supplied screenshot showing the bot inside a narrow, uneven dirt/grass trench.

## Changes

- Stuck recovery now searches a 3D area (up to three blocks horizontally and two blocks vertically), rather than only the four same-height cardinal neighbors.
- It checks for enough body clearance and a safe landing surface, and only treats an unsupported elevated tile as a candidate when scaffold blocks are available.
- Recovery now temporarily asks Mineflayer Pathfinder to navigate to a checked escape waypoint, then restores the original follow/combat/wood goal. It no longer tries a blind 300 ms forward shove.
- Removed the custom scaffold placement wrapper that waited for the bot to rise more than two blocks above the placement reference; native Mineflayer block placement is used instead.
- Removed the feet-to-log-center early-rejection from the overhead log reach check; reach is evaluated from the bot's eye to a visible block face.

## Notes

- Automatic digging and 1x1 tower placement still depend on the active server version, available tool/scaffold items, and Mineflayer's view of loaded blocks.
- The bot can break ordinary terrain while navigating because `canDig` is enabled. Valuable blocks and containers remain excluded by the movement configuration.
- This package passed local syntax/configuration checks. It has not been tested against the user's live Aternos world, so a live test is still needed.

# Pathfinding update v6

This update is based on a second screenshot showing the bot following at the edge of a lower path beside a raised grass ledge. The screenshot alone cannot prove the bot hitbox is inside a solid block; the foreground ledge also hides the bot's lower body from the camera.

## Changes

- Completed the diagonal-collision backport from PrismarineJS/mineflayer-pathfinder PR #393: diagonal neighbors are rejected when either cardinal side corridor is blocked, and raised diagonal jumps are left to cardinal jump moves.
- Added recovery for path_update statuses `noPath` and `timeout`, plus path_reset reasons `dig_error`, `place_error`, and `no_scaffolding_blocks`.
- Fixed the no-progress watchdog so it checks actual entity displacement even when `pathfinder.isMoving()` has become false. Previously the stationary branch reset the timer every physics tick and could prevent recovery forever.
- If an active task loses its pathfinder goal without completing, restore the task goal after a short grace period. This prevents the follow/PvP loop from de-duplicating a goal that the pathfinder has already cleared.
- Kept the `gotoGoal()` promise alive while the shared navigation controller runs an escape attempt, so wood/drop navigation does not cancel its own recovery on the first `noPath` event.
- Prevented melee swings through obstructed sightlines or blocked walking lanes.

## Validation

- `npm test` passes (JavaScript syntax checks and settings JSON parse).
- The upstream diagonal-corner patch is documented in PR #393 and merged October 3, 2026.
- This package has not been run against the user's live Aternos server. Live collision behavior still needs in-world verification.


# Pathfinding/reconnect update v7

This build responds to the supplied screenshot of the bot stopped beside a village house and the report of repeated reconnect cycles.

## Root-cause corrections

- The previous global movement profile had `canDig=true` and `digCost=0.75`. That can make the planner prefer digging through a nearby house wall/foundation. On protected plots the server may reject the dig, so the bot appears to push into the structure.
- Follow, combat, guard and normal movement now use a safe profile (`canDig=false`, no 1x1 towers). The pathfinder must route around structures instead of trying to mine them.
- `!wood` switches to a separate harvesting profile that can clear leaves and pillar upward, while protecting common structural blocks (planks, logs/stems, stone/cobble, stairs/slabs, fences/walls, glass, brick, wool, terracotta and concrete). The explicit `bot.dig()` operation still chops the selected target log.
- Close-range melee no longer calls `nav.stop()` and manually pushes forward/strafe. It keeps a live dynamic `GoalFollow` path so the pathfinder can route around corners during mob combat, guard and PvP.
- Follow/melee goal range is tightened from 2 blocks to 1.1 blocks so the bot does not consider itself finished on the wrong side of a nearby wall just because the player is within a 2-block radius.
- Bow PvP now pathfinds toward a blocked target until line of sight is restored; it does not stop navigation and wait behind the obstacle.
- Added `!pathstatus` to report command mode, active goal, path nodes, moving/mining/building state and current coordinates in chat/logs.

## Reconnect loop corrections

- The previous code reset reconnectAttempts immediately on every spawn. A server that accepted the login and kicked the bot a few seconds later therefore caused the backoff to restart at its minimum forever.
- Retry attempts now reset only after five continuous minutes connected.
- Default reconnect delay is now 10 seconds, with exponential backoff to 180 seconds; throttle/rate-limit kicks wait 90–180 seconds.
- Dashboard Stop cancels pending reconnect timers, and `end` does not restart the bot when it was stopped or auto-reconnect is disabled.
- Reconnect log entries include the disconnect/kick reason.

## Validation

- `npm test` passes (syntax checks and JSON parsing).
- No live connection to the user's Aternos world was available, so actual route behavior and the server's kick reason remain to be confirmed from the bot log.


# Pathfinding/reconnect update v7 (follow-up)

- Follow goals now require both a lower-body clear corridor and upper-body line-of-sight from a candidate path node. Vanilla `GoalFollow` only evaluates distance, so it can consider the bot finished when a player is nearby on the opposite side of a house wall.
- Mining/building state is no longer an unconditional blind spot for recovery. If a dig or scaffold operation stays active without progress for 12 seconds, the controller cancels the stalled action and retries the task goal. Mineflayer documents `bot.stopDigging()` as the supported way to interrupt an in-progress dig.
- Removed the obsolete timed leave/rejoin behavior from the compatibility module. It was not imported by `index.js`, but is now harmless if another entry point uses it.
- The normal and woodcutting movement profiles are now separate. This protects village structures during follow/combat and confines digging/towering to woodcutting.


# Kill targeting update v8
- `!kill` now targets configured passive animals plus recognized hostile mobs from the combat helper's safe hostile list.
- Empty scans no longer stop kill mode after ~3 seconds; the bot keeps scanning while the command remains enabled and reports when no eligible entity is currently tracked.
- A target disappearing from `bot.entities` is treated as despawn/untracking, not a confirmed kill. Only `entityDead` increments the kill counter and starts drop pickup.
- Added `!killstatus` to report the current target, distance, eligible tracked-entity count/names, and confirmed kills.


# Adaptive pathfinding update v9

This update responds to the two newest screenshots: the bot remained on a lower terrace beneath a raised hillside/structure instead of finding a route to the player's higher position.

## Main changes

- Kept the official `mineflayer-pathfinder` A* engine and pinned the project dependency to `^2.4.5` (the lockfile already resolves 2.4.5). No unverified third-party pathfinder fork was substituted.
- Re-enabled the official planner's native parkour moves and sprinting for both normal navigation and woodcutting. The prior builds had explicitly disabled both, which removed useful jumps over gaps and uneven ledges.
- Re-enabled 1x1 scaffolding towers in normal follow/combat navigation while keeping `canDig=false`. This lets the bot climb out of terrain pockets without mining through player structures; it only towers when a supported scaffold item is in its inventory.
- Reduced `liquidCost` from 1000 to 6 so water is strongly disfavored but is not treated like an impossible route. The unused `fallDamageCost` setting was removed; official Movements options use `maxDropDown` and `infiniteLiquidDropdownDistance` instead.
- Kept the wood profile separate: it can clear leaves and tower, but protected blocks still prevent it from digging through common house/building materials.
- Removed the lower-body raycast from the follow endpoint test. It could reject walkable nodes near grass ledges and slabs. Follow endpoints now need only an eye-to-torso line of sight; combat still checks its own melee/shot visibility before attacking.
- Changed follow/guard approach ranges to tolerate height differences, and kept melee approach close enough to enter hit range.
- Reworked the navigation watchdog to distinguish `pending`, `partial`, `ready`, and `failed` A* results. It no longer cancels the planner after 3.2 seconds while a complex search is still running. It records actual body displacement during partial routes and only declares a route stalled after the configured think timeout plus a grace period, or after a ready route has made no progress for 7–9.5 seconds.
- Expanded `!pathstatus` output to include planner state, latest result status, route age, no-progress time and escape count.

## Why not the separate human-walking controller or a third-party fork?

The current upstream `createHuman()` controller is for following already-planned walking routes; the official documentation says it does not dig, place, swim or parkour. Those are required by this bot's terrain and woodcutting tasks, so it is not a replacement for A*. The alternative fork also has a different API and would require rewriting the bot's command/combat navigation integration.

## Validation

- `npm test` passes (JavaScript syntax checks and JSON parsing).
- A focused mock test checks that a still-pending planner is not cancelled by the old 3.2-second watchdog and that a successful route transitions the navigation status to ready.
- No live Aternos connection was available. The new `!pathstatus` output should be used to capture the next in-game route result if it still stalls.

# Advanced navigation upgrade v10

This version upgrades the navigation behavior rather than only adding more watchdog resets.

## Pathfinder engine compatibility/backports

- The installer backports the upstream path invalidation guard from PrismarineJS/mineflayer-pathfinder PR #386 directly into the pathfinder executor: it tracks a `pathRevision`, increments it whenever the path is reset/stopped, and discards a just-computed A* result if a synchronous `path_update` listener invalidated it. `pathfinder-compat.js` is a runtime fallback only when the installed source does not match the patcher.
- Added an automatic package patcher (`scripts/patch-pathfinder.js`, run at `postinstall` and before the pathfinder plugin is loaded). It backports the partial-search continuation changes from PR #399 to `index.js` and `lib/goto.js`, so a timed-out A* search can walk its best partial route and continue searching instead of stopping at the partial endpoint.
- The same patcher applies the pillar placement hitbox timing from PR #400. It waits for the bot's feet to clear the scaffold block and equips while rising, avoiding server rejection of a block placed inside the player hitbox.
- The published npm version of `mineflayer-pathfinder` remains 2.4.5; 2.5.0 has not been released. These targeted compatibility fixes are backported locally instead of depending on an unreleased package version.

## Smarter goal approach

- Follow/combat goals now check visibility against multiple target hitbox heights rather than only a single torso ray.
- On `noPath`, timeout, or stuck reset, the controller widens the acceptable visible approach radius in stages up to 9 blocks. Once it reaches an outer visible waypoint, it tries a closer stage again; ranges that already failed for this target are skipped to avoid endless oscillation.
- When a moving target travels more than one block, the staged approach cache resets and A* replans from the bot's current position.
- `!pathstatus` now reports the current approach radius and the original requested radius.

## Hybrid terrain movement

- Normal follow/combat movement can dig only a high-cost whitelist of soft natural terrain and foliage (leaves, grass/ferns, dirt-like blocks, sand/gravel/clay, and similar listed natural blocks). This gives A* another route through natural hills and shallow trenches when parkour/towering cannot find a path.
- All non-whitelisted blocks are added to `blocksCantBreak` for the normal movement profile. This protects common building materials, stone, paths, containers, ores, logs, doors and gates from routine path excavation.
- Digging is deliberately expensive (`digCost=8`) so it is a last resort after walking, parkour and scaffolding. The dedicated wood profile remains more permissive but keeps its structural protections.
- Think timeout increased to 22 seconds for complex hillside searches.

## Validation

- `npm test` passes: syntax checks, settings JSON parse, navigation goal regression test, stale-path invalidation regression test, and source-patch fixture tests.
- The actual installed `node_modules` is not included in this ZIP. The patcher runs during `npm install` and again before the pathfinder module is loaded at startup; it logs whether each upstream backport matched the installed source.
- Not yet tested on the live Aternos world. Server permissions can still reject digging or placement, and dirt/sand/gravel terrain is intentionally breakable as a last-resort movement option. Check `!pathstatus` and the startup `[Pathfinder patch]` messages if the bot still stalls.
