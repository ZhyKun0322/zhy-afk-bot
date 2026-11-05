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
