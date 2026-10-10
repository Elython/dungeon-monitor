# Dungeon Watch — Discord operator guide

This guide is for people managing the bot inside Discord. You do not need server access, a bot token or game cookies.

For damage limits, use the separate [WATCHER_GUIDE.md](WATCHER_GUIDE.md). The host's instructions are in [HOSTING_GUIDE.md](HOSTING_GUIDE.md).

## Who can use the controls?

Anyone with access to the commands can use `/ping` and `/status`.

To refresh, change settings or manage watchers, you need a **bot operator role** configured by the host, or **Manage Server** permission. Ask the server owner if access is missing. The bot's own channel permissions are separate from your permissions—even a server owner cannot grant the bot access just by pressing a button.

Type `/` and choose the command and options from Discord's suggestions. Examples below show what to select; do not send them as ordinary chat messages.

## Check that it is working

| Command | What it does |
| --- | --- |
| `/ping` | Replies privately with “Pong”. |
| `/status` | Shows the last known dungeon state and pending/unconfirmed announcement counts privately. |
| `/refresh` | Runs a scan now, then attempts to post eligible queued alerts. |
| `/test type:boss_opened` | Sends a labelled example to your DMs, without pings. |
| `/watcher` | Posts the shared damage-watcher control panel in the channel. |

Manual refreshes have a one-minute cooldown. Refresh processes a batch and does not guarantee every monster will be scanned or every queued card sent in one click.

Automatic timing is controlled by the host. The default wait is two minutes; the host can set it as low as 30 seconds. Scan duration, errors and rate limits add time.

## Message types

These four types are available in dungeon announcement commands:

| Select this | Command value |
| --- | --- |
| Dungeon opens | `opened` |
| Dungeon closes | `closed` |
| Boss room opens | `boss_opened` |
| Live dungeon list | `dashboard` |

The first scan establishes a baseline. It does not announce every already-open dungeon as new. Open/closed/boss announcements stay as history; the live dungeon list is one edited message.

## Choose the dungeon announcement channel

```text
/channel show
/channel set channel:#dungeon-alerts
```

The bot needs View Channel, Send Messages and Read Message History there. Its saved selection survives restarts and takes precedence over the initial channel in the host's config.

Moving channels creates a live-list message in the new channel. The old live list and announcements are not automatically deleted; an administrator can remove the old list manually.

This does not change watcher-rule channels. Configure those with **Channel / ping** inside `/watcher`.

## Ping a role or everyone

To ping **@Member** when a dungeon opens:

1. Choose `/mentions set`.
2. Set **type** to **Dungeon opens**.
3. Set **target** to **Role**.
4. Add the optional **role** field and select **@Member**.
5. Submit.

For several roles, use **roles** and enter role mentions or role IDs separated by spaces or commas. Up to 25 roles are supported. Saving again replaces the roles for that message type.

For everyone, set **target** to **Everyone**. Leave role fields empty. To turn pings off, use `/mentions reset` and choose the type.

```text
/mentions show
/mentions reset type:opened
```

The selected role must be mentionable, or the bot needs **Mention @everyone, @here and All Roles** permission in the destination channel. Everyone pings always need that permission.

Each message type has its own ping rule. Use Dungeon opens or Boss room opens for event pings. Editing an existing live-list message does not repeatedly ping people.

Watcher pings are separate: choose one optional role in the watcher rule's **Channel / ping** screen.

## Test without disturbing people

`/test` sends its example to your DMs by default. It does not ping anyone, change game history or create a real dungeon event.

If DMs are blocked, enable DMs from this server or use `/messages preview` for a private reply.

To post a public test, select **destination: Announcement channel**. Keep **ping: False** for a silent test. Set **ping: True** only when you deliberately want to test the configured ping—it will notify recipients.

Test commands cover dungeon message types, not watcher cards. Test a watcher using a paused preview first, then a quiet channel with no role ping.

## Change dungeon message wording

```text
/messages show type:boss_opened
/messages preview type:boss_opened
/messages set type:boss_opened text:**Boss room open: {name}**\nRoom: {room}\n{url}
```

Enter your template in the **text** field. `\n` creates a new line. Templates can contain up to 1,500 characters.

| Placeholder | Shows |
| --- | --- |
| `{name}` | Dungeon name |
| `{instanceId}` | Dungeon instance ID |
| `{room}` | Boss-room name, when available |
| `{roomSuffix}` | Room name with its separator, or nothing |
| `{detail}` | Additional event information |
| `{detailSuffix}` | Detail with its separator, or nothing |
| `{url}` | Relevant game link |
| `{time}` | Detection time |

The live-list template instead accepts `{health}`, `{dungeons}` and `{lastScan}`:

```text
/messages set type:dashboard text:**Active dungeons**\n{health}\n{dungeons}\n{lastScan}
/messages reset type:boss_opened
```

Changes affect future announcements, not old messages. The live-list template updates its existing message. Use `/mentions` for pings, not typed role text inside a template.

These template commands do not change watcher cards.

## Damage watcher

Use `/watcher` to create rules, set their channels/pings, preview damage, enable/pause rules and manage ignored game player IDs.

The panel is shared publicly, but only authorized operators can change it. Forms open for the person clicking; errors and evidence replies are private. Start with the [watcher walkthrough](WATCHER_GUIDE.md).

## If something fails

- **A command is missing:** ask the host to update the bot, register its command definitions and restart. Registration is not needed for every UI fix or restart.
- **You cannot edit:** check your operator role or Manage Server permission, plus any restrictions in Server Settings → Integrations.
- **A message/ping fails:** check `/mentions show`, then ask an administrator to check the bot's permissions in that channel.
- **The game login/challenge fails:** contact the host. Browser challenges must be completed manually.
- **An alert seems duplicated:** compare game player IDs, battle IDs and the card's Alert reference. Different game players can trigger the same rule on separate scans.

Do not keep retrying an unconfirmed send. Ask the host to inspect its delivery record first. Share error text only after removing tokens, cookies and other private information.
