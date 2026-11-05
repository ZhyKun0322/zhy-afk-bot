# Bot chat commands

Type these in Minecraft chat. Bedrock (Geyser) players work too - the "." in front of their name is handled automatically.

| Command | What it does |
|---|---|
| `!wood [n]` | Chops nearby trees and picks up the logs. Optional `n` = stop after n logs. Type again to stop. |
| `!follow` | Follows whoever typed it. Type again to stop. |
| `!kill` | Hunts pigs, cows, sheep and chickens (100 block radius) and picks up the drops. Type again to stop. |
| `!radius` | Saves the bot's current spot as its fixed position. It stays there and walks back when pushed away. |
| `!unsave` | Clears the fixed position. |
| `!guard` | Follows you and kills hostile mobs within 10 blocks of you. |
| `!unguard` | Stops guarding and returns to the fixed position. |
| `!pvp` | Fights whoever typed it. `!pvp <name>` fights that player (`!pvp Zhykun` also matches `.Zhykun`). Type `!pvp` again or `!pvp stop` to stop. |
| `!sleep` | Toggles automatic sleeping. When enabled, the bot looks for a nearby bed at night, walks to it, and sleeps. Type again to disable it. |
| `!armor` | Toggles automatic best-armor and shield equipment. Type again to unequip armor and the off-hand shield. |
| `!inventory` | Drops all stored items, equipped armor, and the off-hand item. |
| `!pathstatus` | Shows current mode, active path goal, remaining path nodes, moving/mining/building state and coordinates. |
| `!stop` | Stops whatever it is doing. |
| `!help` | Lists commands in chat. |

## Automatic food
- When hunger drops below 18, the bot checks its inventory and eats the best available edible item. This works even when mob-combat is disabled, as long as `combat.auto-eat` is enabled in `settings.json`.

## Automatic food
- When hunger drops below 18, the bot checks its inventory and eats the best available edible item. This works even when mob-combat is disabled, as long as `combat.auto-eat` is enabled in `settings.json`.

## PvP behaviour
- **Sword/axe:** uses the pathfinder to approach around obstacles and attacks only when the target is in reach and not hidden behind a block. Manual forward/strafe steering is disabled because it could override navigation at walls and corners. The old optional critical-jump steering is disabled in favor of reliable pathfinding.
- **Bow:** if the target is 8+ blocks away (`bow-min-range`) and the bot has a bow and arrows, it leads the target and shoots. Closer than ~5 blocks, or out of arrows, it switches to sword/axe.
- **Shield:** equips a shield in the off-hand and raises it when the opponent is close and facing the bot, while continuing to attack when possible.
- **Retreat:** at 10 health or lower, it backs away to eat and recover. It returns when health reaches 16 and hunger reaches 18.
- It uses whatever is in its inventory: best sword (or axe if `prefer-weapon` is `"axe"`), bow, arrows, and shield.

## Navigation
- Follow goals require a clear body corridor and line of sight, not just a small Euclidean distance. This helps the bot walk around a house wall instead of stopping on the other side of it.
- Follow, guard, PvP and normal movement use a safe route profile that does not mine through buildings or pillar. The `!wood` command switches to a separate profile that can clear leaves and tower while protecting common building blocks.
- The path recovery watchdog can cancel a dig or scaffold action if it stays busy without progress for 12 seconds.
- Follow and PvP navigation reissue their path when the bot is no longer making progress.
- Wooden doors, trapdoors, and fence gates are configured as interactable path blocks. Iron doors and iron trapdoors still require redstone, so the bot will not try to open them directly.
- Reconnect attempts now back off progressively after short-lived connections. The retry counter resets only after 5 minutes online; throttle kicks use a 90-180 second delay.

## Settings (`settings.json` -> `commands`)
- `owners`: list of player names allowed to use commands. **Empty = anyone can.** Recommended: `["Zhykun"]`.
- `kill.radius`, `wood.radius`, `guard.radius`, `pvp.*`: tuning.
