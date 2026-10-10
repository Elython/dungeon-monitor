# Dungeon Watch — hosting guide

For the person running the bot. Discord moderators only need [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) and [WATCHER_GUIDE.md](WATCHER_GUIDE.md).

Run one production process per configuration/state file. Choose **Docker** or **native Node/systemd**, not both against the same data.

## 1. Choose how to run it

- **Ubuntu laptop-server with Docker:** follow [CONTAINER_GUIDE.md](CONTAINER_GUIDE.md) for container files, startup, updates and logs. You do not need Node installed on the host for this route.
- **Native Node:** install Node.js 22 or newer and use the native/systemd steps below.

You also need a dedicated game account in the monitored guild, a Discord application/bot, internet access and a laptop that stays awake.

The bot is configured for one Discord server and one monitoring game account. For independently hosted bots in different servers/clans, use separate Discord applications/tokens, game accounts, configurations and data folders. Do not run multiple copies with the same bot token or copy one bot's saved settings into a different application/server. Multi-server routing is not implemented.

## 2. Prepare local configuration

For a new installation, create `config.json` from [config.example.json](config.example.json). For an existing installation, edit its current file; do not overwrite it with the example.

With native Node, this creates the example only when no config exists:

```bash
npm ci
node src/cli.js init
```

Fill in the Discord IDs before starting. IDs must be quoted strings containing your actual numeric IDs. Leave `operatorRoleIds` as `[]` unless you want designated operator roles.

This is a complete example with placeholders to replace:

```json
{
  "pollSeconds": 120,
  "requestTimeoutSeconds": 20,
  "requestGapMilliseconds": 500,
  "missingConfirmations": 2,
  "watcherReadBudget": 6,
  "watcherReadGapMilliseconds": 2000,
  "sessionFile": "private/session.json",
  "stateFile": "data/state.json",
  "discord": {
    "dashboard": true,
    "announcements": true,
    "applicationId": "YOUR_APPLICATION_ID",
    "guildId": "YOUR_DISCORD_SERVER_ID",
    "channelId": "YOUR_INITIAL_CHANNEL_ID",
    "operatorRoleIds": [],
    "tokenFile": "private/discord-bot-token.txt",
    "templatesFile": "data/message-templates.json",
    "settingsFile": "data/discord-settings.json",
    "watcherFile": "data/watcher-settings.json"
  }
}
```

The watcher fields are optional; omitted fields use the defaults above. They belong at the top level, except `watcherFile`, which belongs inside `discord`.

## 3. Create/invite the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Copy its Application ID from General Information.
3. Obtain the bot token from the Bot section. Save only the token in `private/discord-bot-token.txt`. Do not reset it for ordinary updates.
4. In Discord, enable User Settings → Advanced → Developer Mode. Copy the server ID and initial posting-channel ID into your config.
5. Leave privileged intents disabled. This bot only uses the normal Guilds intent.

The token file is the recommended approach, especially with Docker. Native hosting can alternatively use `DISCORD_BOT_TOKEN`; a variable in your SSH shell is not automatically passed into a container or systemd service.

For native Node:

```bash
npm run invite
```

Open the printed invitation link. For Docker, the equivalent command is in the container guide. The bot needs View Channel, Send Messages, Read Message History and Embed Links for watcher cards—not Administrator permission. Confirm these permissions in both the posting channels and the channel where operators open the watcher panel.

For everyone pings or non-mentionable roles, also grant the bot **Mention @everyone, @here and All Roles** in the relevant channel. A role that is already mentionable does not need that extra permission. Your own Administrator status does not grant permissions to the bot.

See [Discord's bot setup documentation](https://docs.discord.com/developers/quick-start/getting-started) for the Developer Portal.

## 4. Give operators access

Members with Manage Server can manage the bot. To allow moderators without that permission, add their numeric role IDs inside `discord`:

```text
"operatorRoleIds": ["YOUR_OPERATOR_ROLE_ID"]
```

Copy IDs with Discord Developer Mode enabled. Replace the placeholder with a numeric string. Several roles are allowed.

These roles authorize `/refresh`, `/test`, `/messages`, `/channel`, `/mentions` and `/watcher`, including watcher buttons/forms. With operator roles configured, Discord commands are visible more broadly, but the bot still checks authorization on every action.

After changing this list, restart and register commands again. Server Settings → Integrations can impose additional command restrictions. Regular members can use `/ping` and `/status` and read a posted watcher panel, but cannot change its controls.

## 5. Import the monitoring account's game session

Log into the dedicated account in Firefox, join the correct game guild, and open the Dashboard and Guild Dungeons pages at `https://demonicscans.org`.

In Firefox's Network panel, export **Save All As HAR**. The export must include the authenticated request cookies and the same browser User-Agent. Keep it local and private.

For native Node, with the production process stopped:

```bash
node src/cli.js import-session monitoring-account.har
npm run check
```

Docker has corresponding import/check commands in [CONTAINER_GUIDE.md](CONTAINER_GUIDE.md).

If you use a cookie JSON export instead, store it in `private/` and supply the matching User-Agent:

```bash
node src/cli.js import-session private/export.cookies.json --user-agent "PASTE_THE_SAME_BROWSER_USER_AGENT"
```

Do not post HAR files, tokens, cookies or session JSON in Discord/GitHub. Browser challenges must be completed manually in Firefox; then re-export/import the session. The bot does not bypass challenges.

## 6. Register commands and start

For native Node:

```bash
npm run register-commands
npm start
```

The first registration adds the commands, including `/watcher`. Re-register after command definitions/options or operator-role visibility change. You do not need registration for every bug fix, config edit or restart.

`npm start` in an SSH terminal is for a foreground check; do not rely on it surviving logout. Use Docker or systemd for unattended hosting.

In Discord, test `/ping`, `/status` and a silent `/test`. Configure the watcher paused, preview its data, then enable it in a quiet channel without a role ping for your first live check.

## 7. Polling and collection speed

| Setting | Default | Allowed values | Meaning |
| --- | --- | --- | --- |
| `pollSeconds` | 120 | 30–3,600 | Wait after each automatic scan finishes |
| `requestTimeoutSeconds` | 20 | 5–120 | Timeout for a game request |
| `requestGapMilliseconds` | 500 | 100–10,000 | Minimum spacing for game reads |
| `missingConfirmations` | 2 | 2–10 | Successful directory reads needed to confirm an absent dungeon closed |
| `watcherReadBudget` | 6 | Whole number 3–30 | Watcher page budget per cycle |
| `watcherReadGapMilliseconds` | 2,000 | 0–10,000 | Additional watcher-read spacing |

The polling wait has up to five seconds of jitter. Scan duration adds to it; 30 seconds is not an exact 30-second start-to-start schedule. Directory failures increase later waits; failed battle reads back off before retrying.

For example, merge these fields into an existing config to try faster collection:

```json
{
  "pollSeconds": 30,
  "watcherReadBudget": 12,
  "watcherReadGapMilliseconds": 1000
}
```

Do not replace the whole config with this partial settings example. Keep all IDs and file paths. The game request-rate limit is not known, so start conservatively and slow down if errors/challenges increase.

Manual refreshes still have a one-minute cooldown. They scan a batch; there is currently no separate “finish everything now” button. At most ten watcher cards are attempted per publish cycle; queued cards and Discord rate limits can delay posting.

## 8. Native systemd startup

Skip this section if using Docker.

From the project folder, find your absolute paths:

```bash
pwd
command -v node
```

Create the user service with a text editor:

```bash
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/dungeon-monitor.service
```

For a first installation, copy the contents of [deploy/dungeon-monitor.service](deploy/dungeon-monitor.service) into that file. Set `WorkingDirectory` to your actual project path and `ExecStart` to the actual Node executable followed by `src/cli.js run`. Preserve an already-configured service instead of replacing it.

Stop any foreground bot before enabling the service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now dungeon-monitor.service
sudo loginctl enable-linger "$USER"
journalctl --user -u dungeon-monitor.service -n 100 -f
```

Lingering lets the user's services start at boot and survive logout. A server administrator may need to approve it. [systemd documentation](https://github.com/systemd/systemd/blob/main/man/loginctl.xml)

Press Ctrl+C to leave the logs; the service keeps running. Keep the laptop awake and connected.

## 9. Update an existing installation

For Docker, follow the [update steps](CONTAINER_GUIDE.md#already-installed-update-the-code). A code update requires rebuilding the image; restarting the old image is not enough.

For native systemd, from the project folder:

```bash
systemctl --user stop dungeon-monitor.service
git pull
npm ci
npm test
```

If Git reports conflicts, resolve them before starting. If commands/options or operator roles changed, run `npm run register-commands` before the next step:

```bash
systemctl --user start dungeon-monitor.service
journalctl --user -u dungeon-monitor.service -n 100 -f
```

A config-only edit needs a restart, not a code rebuild. If you edit the installed systemd service file itself, run `systemctl --user daemon-reload` before restarting.

## 10. Preserve these files

Stop the bot before making a consistent backup. Preserve `config.json`, the entire `private/` folder and the entire `data/` folder:

| File | Purpose |
| --- | --- |
| `private/session.json` | Game session |
| `private/discord-bot-token.txt` | Discord bot token |
| `data/state.json` | Dungeon history, watcher observations/counters, delivery records and live-list message ID |
| `data/discord-settings.json` | Dungeon channel and ping rules |
| `data/message-templates.json` | Dungeon message templates |
| `data/watcher-settings.json` | Watcher rules and ignored game player IDs |

Also preserve Docker's `.env` and any custom configured file paths. Backups contain private information; do not share or commit them.

Updates do not require purging data. Deleting state can remove duplicate-alert protection. New Discord applications/servers need separate saved settings, not reused owner-bound files.

## 11. Unconfirmed deliveries

Stop the bot, check Discord, then inspect records:

```bash
node src/cli.js notifications
```

Use `resolve EVENT_ID delivered` only after confirming the message exists. Use `resolve EVENT_ID retry` only after confirming it is absent; retry can duplicate a message if your confirmation is wrong.

For an unconfirmed initial live-list post, check for an orphaned Discord message before using `reset-dashboard`. Docker equivalents are in the container guide.

Do not delete state to “fix” a send error. If an error persists, share the redacted host log, especially the detailed `Watcher interface error` line.
