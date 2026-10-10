# Dungeon Watch

A standalone Discord bot for monitoring DemonicScans guild dungeons and player damage. It uses a dedicated game account in the guild being monitored.

Game access is read-only. The bot does not join battles, attack, loot, claim rewards or change game settings. It runs independently of Veybot/Electron.

## Choose the right guide

| Who is reading? | Guide |
| --- | --- |
| Discord operators managing dungeon announcements | [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) |
| Discord operators managing damage limits | [WATCHER_GUIDE.md](WATCHER_GUIDE.md) |
| The person setting up accounts and configuration | [HOSTING_GUIDE.md](HOSTING_GUIDE.md) |
| The person running/updating it with Docker on Ubuntu | [CONTAINER_GUIDE.md](CONTAINER_GUIDE.md) |

Share the operator and watcher guides with your moderators. Never share the bot token, game session, HAR exports, `private/`, or private backups.

## What it does

- Announces newly opened dungeons, closures and verified boss-room unlocks.
- Maintains one edited live-list message showing active dungeons.
- Recognizes active, cleared and failed instances from the guild dungeon directory.
- Tracks regular dungeon boss rooms and verified Cube PvE boss nodes; ignores Army, Forge, Shop and Cube PvP trials.
- Watches cumulative player damage on selected dungeon monsters.
- Saves Discord channels, ping rules, message formats, watcher rules, ignored game IDs and notification records across restarts.

The first successful directory scan establishes a baseline without announcing every existing dungeon as newly opened. Later openings are identified by dungeon instance ID. Unknown or failed reads do not prove that a dungeon closed or a boss room opened.

## Discord controls

`/ping` and `/status` provide private checks. Operators can use `/refresh`, `/channel`, `/mentions`, `/messages`, `/test` and `/watcher`.

Operators need a configured bot operator role or Manage Server permission. The shared `/watcher` panel is visible in the channel; only authorized operators can change it. Watcher errors and evidence replies are private.

Dungeon announcement controls and watcher controls are separate. `/channel`, `/mentions`, `/messages` and `/test` manage dungeon notifications. Each watcher rule has its own channel and optional role ping.

## Damage watcher

**Add rule** opens one popup containing Dungeon, Monster, X, Y and optional H. Monster choices show their dungeon; mismatched selections are rejected. Rules receive an automatic name that can be renamed later.

- **X:** count a monster once when that player's cumulative damage exceeds X.
- **Y:** send one occurrence alert when the player reaches Y qualifying monsters in that dungeon instance.
- **H:** optionally alert when one monster's damage reaches or exceeds H, without waiting for Y.

Ignored players are matched by game player ID, never by name or Discord membership. Exclusions apply to all watcher rules.

Rules follow matching dungeon and monster names when new instances open. Each new instance starts fresh counters. Further damage or repeated scans on the same monster do not count it twice. The counting ledger and saved notification records protect against re-queueing the same alert.

Old Discord announcements remain as history. Cards identify the player ID, battle ID and a stable alert reference; several different game players can legitimately trigger the same rule.

## Timing and limits

- Automatic polling defaults to 120 seconds and accepts 30–3,600 seconds.
- This is the wait **after a scan finishes**, plus up to five seconds of jitter—not a fixed start-to-start schedule.
- Manual refresh controls retain a one-minute cooldown and process a batch, not necessarily an entire dungeon.
- Watcher reads default to six pages per cycle, with a two-second watcher request gap. Locations and battle reads rotate; already-fetched room pages can be reused.
- At most ten watcher alert creates are attempted per publishing cycle. Discord rate limits may defer more.
- Failed directory scans increase later waits; failed leaderboard reads retain old observations and back off before retrying.

Only accessible pages and server-visible leaderboard rows can be observed. Changes entirely between scans, server-truncated lists or inaccessible closed-dungeon pages can cause missed information. Unsupported markup is reported rather than guessed.

## Running and testing

Use Node.js 22 or newer for native hosting, or follow the Docker guide.

```bash
npm ci
npm test
npm run demo
```

Tests use fixtures and mocked network responses; the demo is offline. `npm run check` reads the configured game account without posting to Discord. `npm run preview` performs one read/preview cycle without connecting to Discord or saving notification history. Stop the production bot before running state-locking diagnostic commands.

Discord bot operation is the only production mode. There is no webhook-only mode. One installation is configured for one Discord server and one monitoring game account.

The pure parsers in `vendor/dungeonParsers.js` and redacted fixtures provide regression coverage. Automated checks do not replace a live check of your own account, Discord permissions and game page layouts.
