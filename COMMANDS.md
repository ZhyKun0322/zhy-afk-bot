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
| `!stop` | Stops whatever it is doing. |
| `!help` | Lists commands in chat. |

## PvP behaviour
- **Sword/axe:** stops sprinting, jumps, and hits while falling for critical hits. It waits for the attack cooldown bar so it never wastes a swing.
- **Bow:** if the target is 8+ blocks away (`bow-min-range`) and the bot has a bow and arrows, it leads the target and shoots. Closer than ~5 blocks, or out of arrows, it switches to sword/axe.
- It uses whatever is in its inventory: best sword (or axe if `prefer-weapon` is `"axe"`), bow, arrows.

## Settings (`settings.json` -> `commands`)
- `owners`: list of player names allowed to use commands. **Empty = anyone can.** Recommended: `["Zhykun"]`.
- `kill.radius`, `wood.radius`, `guard.radius`, `pvp.*`: tuning.
