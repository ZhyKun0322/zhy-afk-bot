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
