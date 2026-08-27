# Matchkeeper — Changelog (English)

English mirror of `CHANGELOG.md`, written for the in-app "Version Updates" screen (Platform Admin only — see the 📋 item in the top-right ⚙️ menu). `CHANGELOG.md` stays the master record in Arabic; this file only needs a new entry from here on, for versions that actually ship — it doesn't need to (and currently doesn't) cover the project's full history.

---

## V0.11.34 — Admin alerts as registrations approach/hit/drop below the minimum

- New: when a player leaves an event (self-cancel or admin-removed) and the registration count nears the event's minimum viable size (courts × 4), the event's admin(s) and creator now get notified at 3 moments:
  - **⚠️ Approaching:** registrations = minimum + 1 (one more drop-out and it's exactly at the line).
  - **🔶 At minimum:** registrations = exactly the minimum.
  - **🚨 Below minimum:** registrations are now under the minimum.
- Each alert fires once, exactly at the moment that threshold is crossed (not repeatedly for every further drop-out while already below) — and can fire again later if the event fills back up and then drains a second time.
- Same recipients as the existing last-minute-cancellation alert (event admins + creator) — same "this event needs your attention" reasoning.

---

## V0.11.33 — Scorers is now a modal instead of expanding inline

- Admin's idea: instead of the "⚽ Scorers" button expanding/collapsing a panel inside the match card (which stretched the card and occasionally threw off its alignment), it now opens a single modal covering both teams at once.
- New: explicit Save / Cancel. Taps (+/−) only update a local draft inside the modal — hit Cancel and nothing gets written at all (reverts to whatever was there before the modal opened). Hit Save and both teams commit together in one go (same score-floor behavior as before: the score gets raised if the tagged total is higher).
- The "⚽ Scorers" button now shows the tagged goal count next to it (e.g. "⚽ Scorers (3)") so you can tell at a glance which matches still need tagging, without opening anything.

---

## V0.11.32 — New "Version Updates" admin menu item

- New: a "📋 Version Updates" item in the top-right (⚙️) menu — visible to the Platform Admin only — opens a modal showing the latest changelog entry, with a "Load more" button revealing the rest of the history.
- Content is pulled from this file so it stays readable inside an otherwise fully-English app — going forward, every real ship gets an entry here in addition to the usual Arabic entry in `CHANGELOG.md`.
- Menu reordered per admin request: "Version Updates" and "Open DEV Environment/Production" (moved out of Platform Admin) now sit directly above Sign Out, both admin-only.

---

## V0.11.31 — Settlement status: replaced the cycling button with an explicit menu

- After two attempts to fix a "tap to advance to the next status" button that kept misbehaving under fast repeated taps, replaced it entirely: a "⋮" button now opens a small menu with all 4 statuses named directly (Not Paid / Paid / Direct / Exempt) — tap the one you want.
- This closes the bug for good: each menu choice is a fixed value (not "whatever's next based on current state"), so there's nothing left that can race under rapid taps.

---

## V0.11.30 — Fixed: the 4-state Settlement button had the same race bug as an earlier poll issue

- Real bug: the single Settlement status button (Not Paid → Paid → Direct → Exempt) computed "the next status" from what was on screen at tap time — tapping fast, before the screen updated, meant every tap computed the same "next status" from the same stale snapshot, so it could get stuck or bounce back instead of advancing correctly.
- Same bug family as an earlier multi-select poll issue, just showing up in the Settlement button this time.
- Fix: "next status" is now computed inside the database transaction itself (not in the button), so it's always based on the latest real data — two fast taps in a row now build correctly on top of each other instead of repeating the same status.

---

## V0.11.29 — Invite links (event or community) now ask before auto-registering

- Before: opening an invite link to an event or community registered/joined you automatically, no question asked — even if you were just checking out a link someone shared in a group chat.
- Now: opening the link takes you to the actual event/community page as before, with a confirmation prompt on top ("Register for this event?" / "Join this community?"). Say yes and it registers/joins exactly as before. Say "Not now" and the prompt just closes — you stay signed in and can browse anything your profile allows, without being registered or joined.
- The prompt only appears when there's an actual decision to make (i.e. not already a member/registered, and the event/community is still open) — otherwise it skips straight through with no extra prompt.

---

## V0.11.28 — USR History now shows which events actually count toward your current rating

- New: USR History rows are now color-coded by whether they still affect your current rating. Events still inside the rolling calculation window (the most recent ones, usually the last 5) get a highlighted background; older events that have "aged out" of the window (no longer affecting your current number) appear dimmed.
- The logic matches the actual USR calculation exactly (skips retired events, stops once the window's "budget" runs out) — no guessing, the color reflects reality.
- A short caption was added under the table explaining what the two colors mean.

---

## V0.11.27 — Automatic cleanup for old USR contamination caused by football events

- V0.11.24 stopped the problem going forward, but didn't clean up data that was already corrupted before the fix. A football match (#53) was still visibly showing up in a player's padel USR History even after the fix shipped, because that record had been written to the database before the fix existed.
- Fix: added a one-time automatic cleanup (same pattern as the existing check-in USR-history backfill) that finds any USR History entry tied to a football event, removes it, and recalculates that player's USR from what's left. Runs automatically for any affected player, without touching anyone else.

---

## V0.11.26 — Football's "Reports" tab is now completely different from Padel's

- The Reports tab on a player's profile now has dedicated football content, instead of reusing Padel's "partnership/rivalry" logic (which is built around concepts that don't exist in football):
  - 🏆 Team Success Rate — overall win/loss rate across all played football matches.
  - ⚽ Goals — total goals, plus goals per event (averaged over events actually played).

---

## V0.11.25 — Profile screen now filters its content by sport

- New: the profile screen now "knows" which sport(s) a player actually plays — instead of always showing a Padel card and a Football card side by side (even for a player with zero activity in one of them), it now only shows the sport(s) they actually participate in.
- If a player plays both sports, a small switcher (🎾 Padel / ⚽ Football) appears at the top controlling everything below it.
- If they only play one sport, there's no switcher at all — they just see that sport directly, with no empty cards or meaningless tabs.
- Activity tabs are now sport-specific: Padel keeps "USR History", "Teams" and "Reports" exactly as before. Football gets a new "Match History" (a simple list of matches played, with none of Padel's USR/PES/TR concepts) plus its own filtered "Reports", so a padel partner never wrongly shows up under a football report.

---

## V0.11.24 — Real bug fixed: closing a football event was corrupting players' padel USR rating

- Real bug: when a "Closed Teams" football event was closed, the app was adding that match's result to every player's `usrHistory` and changing their USR number — even though USR is a Padel-only rating (football uses a completely separate system, Skill Level A–E, set manually by the admin). This was contaminating players' real padel rating with football results that had nothing to do with padel.
- Real example this fixed: football event #53 incorrectly changed a player's USR from 50 to 51.
- Fix: closing a Closed Teams football event no longer touches `usr`/`usrHistory` at all (as it should have from the start) — it still records the team's rating (Team Rating) in `teamsHistory` as normal.
