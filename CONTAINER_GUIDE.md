# Dungeon Watch — Docker on Ubuntu

For the person hosting the bot. Run commands from your `dungeon-monitor` project folder on the Ubuntu machine, not from inside Discord.

Use [HOSTING_GUIDE.md](HOSTING_GUIDE.md) for Discord IDs, the token and game-session preparation. Share [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) and [WATCHER_GUIDE.md](WATCHER_GUIDE.md) with moderators.

## Already installed? Update the code

If the bot is already running with Docker:

```bash
sudo docker compose stop bot
git pull
sudo docker compose build bot
sudo docker compose up -d bot
sudo docker compose logs --tail=100 -f bot
```

If you already pulled the code, skip `git pull`. Stop if Git reports conflicts. Keep `config.json`, `.env`, `private/` and `data/`.

**A code update requires rebuilding the image. Restarting an old image does not load new source files or new validation limits.** [Docker build documentation](https://docs.docker.com/reference/cli/docker/compose/build/)

If command definitions/options changed—or you changed operator roles—register commands after building and before starting:

```bash
sudo docker compose run --rm bot node src/cli.js register-commands
```

You do not need registration for every bug fix, UI change, config edit or restart. Open a fresh `/watcher` panel after updates; old controls may be outdated.

## First installation: Docker

Install Docker Engine and the Compose plugin using the [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/). Then verify:

```bash
sudo systemctl enable --now docker.service containerd.service
sudo docker compose version
```

You do not need Node installed on the host when running entirely through Docker.

## First installation: container files

Create these files with a text editor if they do not already exist. Preserve an existing setup's custom paths and values.

**Dockerfile**

```dockerfile
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY vendor ./vendor
COPY config.example.json ./

CMD ["node", "src/cli.js", "run"]
```

**.dockerignore**

```text
node_modules
.git
config.json
private
data
*.har
*.cookies.json
*.log
.env
```

**compose.yaml**

```yaml
services:
  bot:
    build: .
    restart: unless-stopped
    init: true
    user: "${BOT_UID:-1000}:${BOT_GID:-1000}"
    stop_grace_period: 30s
    volumes:
      - ./config.json:/app/config.json:ro
      - ./private:/app/private
      - ./data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

The example mounts the standard file paths. Adjust mounts if your config uses custom paths. No inbound port mapping is needed for this bot; it connects out to the game and Discord.

The runtime image does not contain the test fixtures. Run `npm ci` and `npm test` on a development checkout with Node 22+ if you want to run tests; do not expect `npm test` to work in this minimal runtime image.

## First installation: files and ownership

Stop an existing foreground/systemd bot before switching to Docker. If you used the provided user service:

```bash
systemctl --user disable --now dungeon-monitor.service
```

Run only one production bot against the same data.

Create `config.json` from the example only if no current config exists. Fill in your Discord IDs as described in the hosting guide. Then create the private/state folders:

```bash
mkdir -p private data
id -u
id -g
```

Create or edit `.env` with a text editor. Set `BOT_UID` and `BOT_GID` to the numbers printed above. For example, only if both printed 1000:

```text
BOT_UID=1000
BOT_GID=1000
```

Preserve other existing `.env` settings. Matching the user IDs lets the container write its session/state files without running as root. If permission errors occur, inspect folder ownership and these IDs; do not make private folders world-writable.

Save the Discord token in `private/discord-bot-token.txt`. Exporting `DISCORD_BOT_TOKEN` in an SSH terminal does not automatically pass it into this container.

## First installation: build, invite, import and start

Build the image:

```bash
sudo docker compose build bot
sudo docker compose run --rm bot node src/cli.js invite-link
```

Open the invitation link and authorize the bot. Confirm View Channel, Send Messages, Read Message History and Embed Links permissions in the relevant channels.

Export a signed-in game session from Firefox as explained in the hosting guide. Place `monitoring-account.har` in the project folder temporarily and import it:

```bash
sudo docker compose run --rm +  -v "$PWD/monitoring-account.har:/tmp/monitoring-account.har:ro" +  bot node src/cli.js import-session /tmp/monitoring-account.har
sudo docker compose run --rm bot node src/cli.js check
sudo docker compose run --rm bot node src/cli.js register-commands
sudo docker compose up -d bot
sudo docker compose logs --tail=100 -f bot
```

`check` reads the game without posting to Discord. Keep the HAR private; do not share it with moderators. Store any retained export securely.

Press Ctrl+C to leave followed logs. The detached container keeps running.

## Edit config.json or polling speed

Edit the existing file on the host. Optional watcher settings can be added at the top level; keep all other fields.

Example settings to merge into your current config:

```json
{
  "pollSeconds": 30,
  "watcherReadBudget": 12,
  "watcherReadGapMilliseconds": 1000
}
```

This is not a replacement for your whole config. Polling accepts 30–3,600 seconds, and the watcher budget accepts whole numbers 3–30. An older image may reject 30 seconds; install/rebuild the updated source first.

For an application-config-only edit, restart:

```bash
sudo docker compose restart bot
sudo docker compose logs --tail=100 bot
```

If the edited config file still appears stale, recreate the container without rebuilding:

```bash
sudo docker compose up -d --force-recreate bot
```

After changing `compose.yaml` or Compose environment variables, use `sudo docker compose up -d bot`. Restart alone does not apply Compose configuration changes. [Docker restart documentation](https://docs.docker.com/reference/cli/docker/compose/restart/)

Polling is a wait after each scan completes, with up to five seconds of jitter. It is not an exact start-to-start schedule. Manual refreshes still have a one-minute cooldown. Reads are batched, at most ten watcher cards are attempted per publishing cycle, and Discord rate limits can delay the queue.

## Start, stop, status and logs

```bash
sudo docker compose up -d bot
sudo docker compose stop bot
sudo docker compose ps -a
sudo docker compose logs --tail=100 bot
sudo docker compose logs --tail=100 -f bot
```

Use the command matching your task, not the entire block at once. `up -d` starts in the background; leaving SSH or the log view does not stop it. [Docker up documentation](https://docs.docker.com/reference/cli/docker/compose/up/)

## Startup after reboot

With Docker enabled at boot and `restart: unless-stopped`, the container can restart after a crash or reboot. An intentionally stopped container stays stopped until started again. [Docker restart-policy documentation](https://docs.docker.com/engine/containers/start-containers-automatically/)

After reboot:

```bash
sudo systemctl is-active docker
sudo docker compose ps -a
sudo docker compose logs --tail=100 bot
```

Keep the laptop awake, powered and connected. The bot cannot monitor while the machine is suspended.

## Refresh an expired game session

Stop the bot, complete any browser challenge manually in Firefox, and export a fresh HAR. Then:

```bash
sudo docker compose stop bot
sudo docker compose run --rm +  -v "$PWD/monitoring-account.har:/tmp/monitoring-account.har:ro" +  bot node src/cli.js import-session /tmp/monitoring-account.har
sudo docker compose run --rm bot node src/cli.js check
sudo docker compose up -d bot
```

If `check` still fails, fix the session/guild-access problem before starting. Re-importing a session does not require deleting saved rules or counts.

## Backups and moving the installation

Stop the bot before backing up. Preserve:

- `config.json` and `.env`.
- All of `private/`, including the token and game session.
- All of `data/`, including `state.json`, `discord-settings.json`, `message-templates.json` and **`watcher-settings.json`**.
- Any custom configured paths and your container files.

These bind-mounted folders survive normal rebuilds/container recreation. Do not delete them or purge state to update the bot. Backups contain credentials and must not be shared.

When moving to a new machine, stop the old bot, restore the files privately, correct UID/GID/mount paths, then build/check/start on the new host.

## Unconfirmed or failed messages

Stop the bot before inspecting or changing its delivery records:

```bash
sudo docker compose stop bot
sudo docker compose run --rm bot node src/cli.js notifications
```

After checking the Discord channel, replace `EVENT_ID` with the listed ID and use only the appropriate resolution:

```bash
sudo docker compose run --rm bot node src/cli.js resolve EVENT_ID delivered
sudo docker compose run --rm bot node src/cli.js resolve EVENT_ID retry
```

`delivered` means you confirmed it exists. `retry` means you confirmed it is absent. Retrying an already-posted message can create a duplicate.

For an unconfirmed initial live list, inspect Discord for an orphan before using:

```bash
sudo docker compose run --rm bot node src/cli.js reset-dashboard
sudo docker compose up -d bot
```

This resets the live-list tracking, not watcher rules or counting history.

## Startup says another process is running

Stop the container and confirm that no other bot/container/systemd service is using these same data files. Do not clear a lock while another instance is active.

If all owners are definitely stopped and the lock is stale, preserve it by moving **only** `data/state.json.lock` to a unique backup filename in that folder. Use the actual configured state-file path if yours differs. Then start the bot again.

Never delete `data/state.json` or `data/watcher-settings.json` to clear a lock. If unsure, ask the maintainer instead of removing files.

## Helpful diagnostics

- If Ignored players reports an error, copy the detailed **Watcher interface error** line from the host log. The ID-only fallback should still allow Add/Remove/Clear operations.
- Compare player IDs, battle IDs and Alert references before reporting duplicate watcher cards; different game players can trigger the same rule.
- A plain `restart` will not fix an old image after a code update: rebuild it.
- If the bot cannot write state/session files, check UID/GID and folder ownership.
- Redact tokens/cookies before sharing logs. Never upload HAR/session files publicly.
