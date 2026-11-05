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
