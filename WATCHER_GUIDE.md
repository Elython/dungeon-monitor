# Damage Watcher — Discord user guide

Use this guide to set damage limits for dungeon monsters. The bot reads the game's Attackers Leaderboard; it does not join battles, attack or loot.

You only need Discord access. No server login, game cookies or bot token should be shared with operators. General dungeon-announcement commands are covered in [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md).

## Open the panel

Type **/watcher** and choose the command from Discord's suggestions.

The panel is posted in the channel for everyone to see. Only a configured bot operator or someone with Manage Server can change it. Forms open for the person clicking; errors and evidence replies stay private.

Settings save automatically. There is no Save button. The panel is shared, so another operator's navigation changes what everyone sees. If old controls report “outdated”, open a new `/watcher` panel.

The bot needs **Embed Links** in the panel channel. Your own server-owner/Admin privileges do not grant permissions to the bot.

## 1. Create a rule in one popup

1. Press **Add rule**.
2. In that popup, choose **Dungeon** and **Monster**.
3. Enter **X**, **Y** and optional **H** in the same popup.
4. Submit. The rule is created **paused**.

| Field | What it means |
| --- | --- |
| Dungeon | The discovered active dungeon to watch |
| Monster | A monster belonging to that dungeon |
| X | A player's cumulative damage must **exceed** this total for the monster to count |
| Y | Number of different qualifying monsters that triggers the occurrence alert |
| H, optional | A higher damage total that triggers an alert on one monster without waiting for Y |

Use whole numbers: `10000000` or `10,000,000`, not `10M`. Y must be at least 1. Leave H empty to disable it; when supplied, it must be greater than X.

Each monster shows its dungeon underneath. Select a matching pair. The dropdowns do not dynamically filter each other while the popup is open; a mismatch is rejected without saving.

If no monsters have been discovered, use **Refresh discovery**, then **Add rule** again. Larger dungeons are collected in batches. If there are more than 25 choices, use **Other monster pages** to open another page of the same five-field popup.

Nothing is saved until submission. Cancelling does not leave an incomplete rule. The rule gets an automatic dungeon/monster name; rename it later with **Edit limits**.

## 2. Understand the dungeon selection

The dropdown only lists dungeons represented by discovered monsters on the current choice page. A missing dungeon may not have been scanned yet, may be inaccessible, or may be on another page. It is not restricted to Shadowbridge.

**“Dungeon instance #…” identifies the currently scanned instance, not a permanent restriction.** The saved rule follows the matching dungeon and monster names when a new instance opens. Each new instance starts fresh counters automatically.

Your chosen targets remain selected after saving. To change an existing rule's targets, choose another dungeon, refresh its choices and choose the monster. A real target change pauses the rule until enabled again; selecting the same saved target does not pause it.

## 3. Choose the alert channel and ping

1. Press **Channel / ping**.
2. Select the alert channel, for example **#damage-alerts**.
3. Optionally select one role to ping.
4. Press **Back**.

The saved channel and role remain selected when the screen redraws. Use **Disable ping** to remove the role ping.

The bot needs View Channel, Send Messages, Read Message History and Embed Links in that channel. A role must be mentionable, or the bot needs permission to mention non-mentionable roles there.

Watcher channels/pings are independent of `/channel` and `/mentions`, which control dungeon announcements. The watcher currently offers one optional role ping per rule, not an Everyone dropdown.

Start with a quiet channel and no ping for your first test.

## 4. Preview, then enable

While paused, press **Preview / counts** to sample visible leaderboard totals without enabling that rule's notifications. The result uses collected observations; a large scan can take several cycles.

While enabled, this button shows cached counts. A preview does not mean the entire dungeon has been freshly scanned.

Press **Back**, then **Enable**, read the warning, and **Confirm enable**.

**Existing visible damage counts.** Enabling does not mean “only attacks made after this moment.” Players already meeting the limits can trigger alerts on the next scan.

## How counting works

Example: **X = 10,000,000**, **Y = 3**, **H = 30,000,000**.

A player deals 11 million to one Gribble: that is **one** qualifying monster. They later increase the total on that same monster to 20 million: it still counts as **one**, not two. Successive cumulative totals are never added together.

Exceeding 10 million on three different monster IDs triggers the occurrence alert. Exactly 10 million does not qualify: X must be exceeded.

Reaching 30 million or more on one watched monster triggers H without waiting for three. Both reasons are combined into one card if they trigger together.

Occurrence alerts fire once per game player, rule and dungeon instance. H alerts fire once per game player, monster, rule and dungeon instance. Further damage and repeated scans do not repeat the same alert.

All visible game players are checked unless ignored. Being alone in your Discord server does not limit the watcher to your own game character.

## Ignore game players

Press **Ignored players**.

- Select captured players in the dropdown. Selected players are ignored; unselecting removes an exclusion.
- **Add game IDs:** enter IDs separated by spaces or commas. Existing exclusions are kept.
- **Remove game IDs:** enter only the IDs to remove.
- **Clear all:** requires confirmation before removing every exclusion.

Blank Add/Remove submissions do not clear anything. Use **Previous** and **Next** for additional pages. If Discord rejects the dropdown, the screen falls back to the ID buttons; exclusions are preserved.

**Exclusions apply to every watcher rule and match only game player IDs.** Names are display labels. Renaming a player does not remove their exclusion, and identical names remain separate players.

Use the Game ID printed on an alert, or the number after `pid=` in a game-profile link. For `player.php?pid=12345`, enter only `12345`—not the whole URL, a username, a Discord mention or a Discord user ID.

## Read an alert

Cards show the game player ID, dungeon instance, battle ID, trigger reason and a stable **Alert** reference.

- **View evidence** shows the recorded damage and monster IDs in a private reply.
- **Open monster** opens the relevant battle page.

Evidence is a snapshot from when the alert triggered, not a live damage total. Old Discord cards remain as history; evidence buttons work while the corresponding records are retained.

Evidence display is capped at 100 monsters per alert; the qualifying count can be higher. The card's private evidence view reports that limit when relevant.

Different players can trigger the same rule in one scan, and queued cards can arrive over later scans. Compare IDs and the Alert reference before reporting a duplicate. Different rules can also legitimately alert separately.

## Pause, edit, delete and restart

- **Pause** stops notifications but keeps observations/history.
- **Edit limits** changes the name, X, Y or H.
- **Delete** removes the rule only after confirmation; it does not delete old Discord cards.

Editing limits or targets preserves observations and already-triggered alert records. Create a separate new rule if you need an independent fresh rule in the current dungeon. Deleting/recreating creates a new identity and can alert again on already-visible damage.

Up to 25 rules are supported. Each can have its own monster, limits, channel and optional role.

Settings, ignored IDs, counters and delivery records survive normal restarts. A new dungeon instance starts fresh counters; you do not have to recreate its matching rule.

## Collection and posting speed

The host controls automatic timing. The default wait is 120 seconds; 30 seconds is allowed. The wait begins after a scan finishes, with up to five seconds of jitter. Network delays/errors add time.

`/refresh` or the watcher Refresh control starts a scan now, but processes a batch. Manual refresh controls keep a one-minute cooldown, even when automatic polling is 30 seconds.

At most ten watcher cards are attempted per publishing cycle, and Discord rate limits can defer more. There is currently no separate button that guarantees a full-dungeon scan and drains the entire queue immediately.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `/watcher` is missing | Ask the host to update/register command definitions and restart. |
| You cannot edit | Check your operator role or Manage Server permission and integration restrictions. |
| Embed Links is missing | Ask an administrator to grant it to the bot in this channel. |
| Dungeon/monster choices are missing | Use Refresh discovery, wait for batches, and check Other monster pages. Ask the host about guild/access or read errors. |
| The menu shows an instance ID | That is the current discovery; the rule follows future matching instances. |
| Refresh says to wait | Wait one minute before another manual refresh. |
| A control is outdated | Open a new `/watcher` panel. |
| Ignored players reports an error | Use the ID-button fallback. Ask the host for the detailed Watcher interface error line; a generic error is not proof that your Admin privileges were rejected. |
| Counts seem unchanged | A monster counts only once. Check Watcher health and wait for another successful scan. |
| No alert arrives | Check Enabled, limits, ignored IDs and the destination. Ask the host about pending/failed/uncertain delivery records. |
| Cards seem repeated | Compare player IDs, battle IDs, rule names and Alert references. Different players/rules/new H violations can legitimately create more cards. |
| Evidence is unavailable | The backing record may no longer be retained; the Discord card itself remains. |

The bot can observe only accessible pages and leaderboard rows exposed by the game. It cannot detect hidden/server-truncated rows or changes wholly between scans. Failed reads retain previous observations rather than erasing damage or inventing fresh counts.

Do not delete account data to troubleshoot alerts. Send redacted error text to the host; never share tokens, cookies or HAR files.
