# Matchkeeper — Changelog (English)

English mirror of `CHANGELOG.md`, written for the in-app "Version Updates" screen (Platform Admin only — see the 📋 item in the top-right ⚙️ menu). `CHANGELOG.md` stays the master record in Arabic; this file only needs a new entry from here on, for versions that actually ship — it doesn't need to (and currently doesn't) cover the project's full history.

---

## V0.12.04 — "I'm In" now waits for real confirmation before saying "Registered"

- **Real bug fixed:** the registration button used to show "Registered ✓" instantly, without waiting for genuine server confirmation — if the write actually failed afterward (heavy contention), the user would be looking at a false success message with no idea anything was wrong. The button now shows "Registering…" and disables itself until the registration is actually confirmed saved, then shows "Registered ✓" or "You're #N on the waitlist" — and if it genuinely fails, says so plainly and asks to try again.
- **Verified the underlying write path is sound:** 50 truly simultaneous registrations against an event capped at 15 — zero lost, and the active/waitlist split came out exactly right (15 / 35).

---

## V0.12.03 — Better sorting on the Events tab, plus a "Remove Photo" option

- **New: "🗑 Remove Photo"** — completes the photo-management set alongside "Reset to Google Photo": anyone can now clear their profile photo entirely (falls back to initials) with no admin help, logged in the Audit Trail like any other photo change.
- **The "Coming" tab on the Events screen now sorts ascending** — the soonest event is on top, the furthest out is at the bottom (was reversed before).
- **The "Past" tab now opens smartly:** if there are past events that never got closed (Incomplete), those stay expanded and Completed stays collapsed, same as before. But if everything in the past is already completed (no Incomplete events at all), Completed now opens automatically instead of staying needlessly collapsed.

---

## V0.12.02 — Wider Audit Trail coverage: profile photos and likes

- **Changing or resetting a profile photo** (uploading a new one, or "↺ Reset to Google Photo") is now logged in the Audit Trail — even when someone edits their own photo — and says exactly what happened (uploaded a new photo vs. reset to their Google photo).
- **Likes on event photos are now logged in the Audit Trail too** (liking or unliking).
- **The Android update gate is now actually enforced:** any old Android install is fully locked out until it updates to V0.12.00 or newer — this includes devices that were working fine before.

---

## V0.12.01 — Anyone can now reset their profile photo back to Google's, plus event photo improvements

- **New: "↺ Reset to Google Photo"** — if someone uploaded a custom profile photo and wants it back to their real Google account picture, there's now a button on the profile edit screen that does it instantly, no admin help needed. Only shows on your own profile, and only when signed in with an actual Google account (not email/password).
- **Event photos now show who uploaded them directly on the photo** (previously only visible when trying to delete one).
- **New: likes on event photos** — any player can ❤️ a photo in the Photos tab, with the count shown next to it.
- **Removing an event photo is now logged in the Audit Trail** (uploading one already was).

---

## V0.12.00 — Major release: every community and event now has its own Firestore document

- **The project started in V0.11.51 is complete.** Instead of all community and event data living in one giant document (the root cause of every race-condition incident this app has had, including last week's), every community and every event now has its own document. Any action — registering, archiving, closing an event — only ever touches its own document, so it can never again collide with something happening on a different event or community, even during a rush.
- **Genuinely tested before this touched production:** a full copy of real production data was moved into the DEV environment and put through the exact scenario that caused the original incident (a burst of simultaneous registrations while unrelated events got archived at the same moment) — passed cleanly, zero registrations lost.
- **The admin-account lock and the real Firestore-level security rule from V0.11.49/50 now apply meaningfully to the new split data** (before, the rule could only say "anyone may write here"; now there are real per-document conditions).
- **Zero visible change for regular users** — same screens, same buttons — but the foundation everything sits on changed completely underneath.
- **The old data (the single giant document) was left completely untouched** — that's the rollback point if it's ever needed, kept for several days until everything's confirmed solid.

- **Start of a longer-term project** (discussed with the admin after the V0.11.49/50 incident): the real root cause behind every race-condition bug this app has had, including this week's incident, is that all community and event data lives in one giant Firestore document — so anything happening anywhere in the app can collide with anything else happening at the same moment. The real fix is splitting that into separate documents (one per community, one per event) — a genuine project that will take time and ship in stages without taking the app down.
- **Only the first step today (zero visible change for users):** three spots in the code that change a community's data and one specific event's data together in the same moment (closing an event, joining via an invite link, adding a guest) now go through their own dedicated channel instead of being buried in the general one — preparation for the next stage, which actually separates the data. Also removed old code that could, in theory, have blindly overwritten all community data unsafely if a future bug ever triggered it.

- **Follow-up to V0.11.49:** seven other spots in the code were still using the old risky pattern (take a local copy that might be stale, and write it over ALL of the comms data with no check against the server's real latest state first) instead of the safe transaction-based pattern regular registration has used for a while.
- **The most important of the seven:** starting Match Mode — this happens routinely, not rarely — now uses the same safe pattern.
- **The rest (all admin-only, all rare):** Bulk Archive and Bulk Delete for events (the exact action from the V0.11.49 incident), deleting a user, restoring a backup, the duplicate-ID repair tool, the old guest-membership repair tool, and creating a new community.
- **No visible change for regular users** — same screens, same buttons — but now none of these can ever silently erase someone else's registration happening elsewhere in the app at the same moment.

---

## V0.11.49 — 🚨 Serious security bug fixed: a new sign-in could silently take over the main admin account

- **Confirmed live in production:** over about two weeks, five different real people, on their very first sign-in, were silently and automatically linked to the platform owner/admin account (User #1) instead of getting their own new profile — no confirmation screen, no audit trail entry at the moment it happened. One of them renamed the shared profile to their own name and bulk-archived 9 events, while effectively holding full Platform Admin rights.
- **Root cause:** an old "bootstrap" exception in the sign-in code said, in effect, "if the owner account (#1) has no linked account at all yet, silently link whoever is signing in to it, no confirmation needed" — meant only for the very first-ever setup, before any real admin existed. The check relied on this client's own local, possibly-not-yet-loaded copy of the link table, which reads as empty on a cold start — exactly the normal case for anyone's very first sign-in — even though the real owner was already linked on the server. That handed full admin access to a stranger every time the race was hit.
- **Fix:** that silent exception is gone for good. Every sign-in with no valid link now goes through the same safe path everyone else already used — a server-side transaction that matches by the real stored email and always requires an explicit "Is this you?" confirmation before linking to any existing profile. There is no automatic/silent way left for anyone to end up in someone else's account, admin or not.
- **A second, non-bypassable lock on top of that:** the main admin account (User #1) is now hard-locked in the Cloud Function itself to one specific email — no other address can ever be matched or linked to it, even if a future bug reopened some other path. **Plus a new Firestore security rule** that rejects any direct write (even someone opening browser dev tools and writing straight to the database, skipping the app entirely) that tries to link any account to User #1 — the protection now lives at the database level, not just in the app's own code.
- **The stray accounts that had been wrongly linked to the admin profile were found and removed directly from the Firebase Console (outside the app).**

---

## V0.11.48 — Second root-cause fix: the podium could never permanently agree with the Standings tab

- **The admin noticed the podium and Standings tab were still showing two different numbers for the same player, same event (63 (+5) on the podium, 63 (+3) in Standings) — even after V0.11.46/47.** Real cause: the podium was reading from `plan.sorted` — a snapshot frozen the moment "Start CI" ran, that never updates again. Any event that closed while a player had leftover USR debt (like the case that surfaced this whole investigation) would show that debt-polluted number on its podium **forever**, even after the debt itself got fixed — because the snapshot itself is permanently frozen and never gets refreshed.
- **Root-cause fix:** the podium now runs the exact same calculation the Standings tab does (player's history with this event's own entry removed, recomputed fresh) instead of relying on the frozen snapshot — so the two numbers can never disagree again, for any player or event, past or future.

---

## V0.11.47 — Automatic one-time cleanup for any leftover USR "debt" from before V0.11.46

- **A one-time automatic cleanup** finds any player still carrying old debt from USR-window-size changes made before V0.11.46 (like Hashim in the case that surfaced this) — detected by comparing their stored number against a fresh calculation under today's settings; a mismatch is the sign of leftover debt.
- **Important:** the cleanup doesn't change anyone's number right now — it just freezes their old history and anchors their current number as the starting point, exactly the same philosophy as V0.11.46 itself. Anyone whose number already matches current calculations (no debt) is left completely untouched — even their USR History screen stays exactly as it was.

---

## V0.11.46 — Root-cause fix: changing the "USR window" size was silently moving players' numbers before they did anything

- **Found the actual bug behind the podium-vs-USR-History mismatch — not a display issue, a real calculation one.** When the admin changes how many recent events USR averages over (e.g. last 5 → last 9), the old code left anyone with fewer events than the old size completely unprotected — the next time such a player closed any event, their number shifted from the setting change itself (not from that event), blended silently into the same number as the event's own real effect, with no way to tell the two apart.
- **Real example confirmed:** a player's USR was 63 before the admin changed the setting from 5 to 9. It stayed 63 (no immediate change, that part was already intentional). Then they played a new event and their number jumped to 68 — but only +3 of that was really their performance that day; the other +2 was a delayed "correction" from the old setting change, bundled invisibly into the same number.
- **Fix:** changing the setting now **cannot move anyone's number by itself, at all** — it freezes everyone's existing history and anchors their current number as a fresh starting point, so the next event they close shows purely its own effect, nothing blended in.
- **Note:** this prevents it going forward — some players still carry old "debt" from before this fix (like the example above) until they next close an event. A separate, optional one-time cleanup can settle that for everyone right now if wanted.

---

## V0.11.45 — Real bug fixed: wrong "USR 0" in the PES tab when the value matched what actually closed the event

- **Real bug caught live (admin screenshot):** the "PES (Court-Based)" tab showed "USR 0" for every player — even ones the podium itself showed a real USR change for! Cause: V0.11.44's calculation compared the candidate value against today's history as-is — so if the event really was closed with that same scoring method (Court-Based), the comparison trivially found "no difference," since the candidate already matched what was recorded.
- **Fix:** the calculation now compares against one fixed baseline (the player's history with this event's entry removed entirely) instead of comparing against current history — so when the candidate matches what actually closed the event, the result now reproduces the real, already-recorded impact (verified against the player's actual USR History), and for the other method it's a genuine, correct counterfactual.
- **Note:** a completely separate bug was found while investigating this (an old mismatch between the podium's number and the player's real USR) — that gets its own investigation later, not part of this fix.

---

## V0.11.44 — USR effect now works after an event closes too (not just live)

- **Per admin feedback — it was wrong that this only showed while the event was still open.** The calculation changed completely: `previewUsrDelta` now tells whether the event already has a real USR history entry — if so, it swaps that entry's PES value (at its exact position in history, not tacked onto the end) and recomputes, instead of appending a hypothetical entry on top of one that already happened for real.
- **This gives the right answer even in a tricky case:** if the event has since aged out of the rolling USR window (enough later events happened), changing its value now correctly shows **zero** effect — not a wrong guess — because the calculation runs through the exact same windowing logic the real close does.
- Both PES tabs (Court-Based and Performance Based) now answer "if we'd used the other method, how would it affect current USR?" even for events closed a while ago.

---

## V0.11.43 — Reworked the PES tabs per admin feedback + clarified the Output PES formula

- **"PES (Court-Based)" tab:** reordered — match points (pts) now sit on the left, PES% moved to the far right with its USR effect right next to it in brackets, e.g. "100% (USR +5)".
- **"PES (Performance Based)" tab — full redesign:**
  - Entry USR now sits in brackets next to the player's name, matching the Court-Based tab exactly, instead of its own separate column.
  - The Delta (Δ) column now comes right before PES.
  - "Performance" is renamed to **"PES"** (it was confusing that the label didn't match what the value actually was).
  - The PES number now shows its USR effect right next to it in brackets: "(USR +4)".
  - **Real bug clarified:** the number next to Δ (e.g. "+13%") doesn't add directly onto Entry USR — the actual formula is `Entry + (Δ × 80%)`, not `Entry + Δ`. That's why something that looked like "63 + 13" was showing "73.5", not "76". A clear explanation was added under the table spelling this out exactly.
  - **Comparison (when the toggle is on):** now shows the Court-Based PES **with its own USR effect** too, plus **that player's rank in the Court-Based tab** (e.g. #3), so the two standings are directly comparable side by side.

---

## V0.11.42 — Hardened addMember/approveEventJoin + Standings tab improvements

- **Additional hardening:** `addMemberToEvent` and `approveEventJoinRequest` (new Cloud Functions) — same idea as `registerForEvent`, applied to the two admin-only paths (manually adding a player, approving a join request). They re-check event status (closed/cancelled) against live server data, not just client code. `registrationOpen` (the pause) is deliberately **not** checked here — pausing is meant to stop random public self-service, not the admin's own direct action, matching existing behavior exactly.
- **New in the Standings tab (Padel, Closed Individual):**
  - **In both tabs literally labeled "PES"** (Court-Based and Performance Based): each player now shows what this PES would do to their real USR if the event were closed with that number right now — e.g. "USR +5". Only shown while the event is still open (before it's actually closed), so it never sits next to a number that already happened for real.
  - **In the "PES (Performance Based)" tab specifically:** a new "⚖️ Compare with Court-Based" toggle — when on, shows each player's traditional court-based PES (and its own USR effect) right next to the performance-based one, for an easy side-by-side comparison.

---

## V0.11.41 — The real fix: a server-side Cloud Function for registration

- New: **`registerForEvent`**, a Cloud Function (`functions/index.js`) that checks event status and `registrationOpen` against the **live server data at the moment of the write itself**, not whatever the calling client believes. That means no device — no matter how old — can register through an active pause anymore, because the check now lives entirely outside client code.
- **How the call works:** the app tries this function first; if it's unavailable (dev — `padelos-dev` has no Cloud Functions deployed at all — a network issue, or a timeout) it automatically falls back to the same direct write path already fixed in V0.11.39. So a function problem can never fully block registration — but if the function explicitly rejects it (event genuinely closed), that decision is respected and there's no fallback around it.
- **Full picture now:** V0.11.39 (client-side check) + V0.11.40 (forces old Android installs to update) + V0.11.41 (real server-side check nothing can bypass) — together these close this class of problem from every angle.

---

## V0.11.40 — Hard Android update gate

- New: real protection against an old Android install silently missing a critical fix like V0.11.39's. Until now there was only a soft "new version available" banner — easy to ignore, and evidently was. Now, when we set a required minimum version (`minSupported` in `releases/latest.json`), any **signed-in** Android install below it sees a full-screen "Update Required" screen instead of the normal app, with a direct download button — not just a notice, an actual block until they update.
- **Deliberately fails open by default.** If the check hasn't finished yet, the network is down, or the field is missing from `latest.json`, the app just continues normally — no blocking. It only blocks once it's actually confirmed the running version is below `minSupported`.
- **Web is untouched** — every page load already pulls the latest code, so there's no equivalent "stuck on an old install" risk to guard against there.
- **Bootstrapping note:** this is the first version that has the check itself — so `minSupported` has no effect on anything installed **before** this version (like the V0.10.24 build that caused the original incident), since it has no code to check with. Going forward, any new critical fix raises `minSupported`, and anyone on V0.11.40 or later gets forced to update automatically.
- The deeper fix (a real server-side Cloud Function for registration, instead of relying entirely on client code) is agreed as a separate next phase.

---

## V0.11.39 — Critical real bug fixed: registration was still possible while paused

- **Real bug caught live on a real event during a registration rush:** the "pause registration" toggle (`registrationOpen`) only ever hid the "I'm In" button on screen — the functions that actually write a registration (`registerEv`, `registerViaInvite`) never checked that flag at all, only whether the event itself was closed/cancelled. Anyone with the page already loaded (or an old Android APK, e.g. V0.10.24) could still register while the pause was genuinely active.
- **Real proof from the live event:** two players registered 35 seconds and 15 seconds **before** the admin reopened registration — i.e. registration went through while it was still actually paused.
- **Fix:** the `registrationOpen` check now lives inside the actual registration-writing functions, not just the button — so even a stale client's write gets rejected.
- **⚠️ Limit of this fix:** this closes the gap immediately for anyone on web (always runs the latest code), but **Android users on an old APK are still exposed** until they actually update — there's no auto-update. A real root-cause fix (a hard minimum supported app version, or moving registration to a server-side Cloud Function) is being discussed as a separate next step.

---

## V0.11.38 — Third fix: "Regenerate Future" returned the same stale schedule once the needed breaks hit zero

- **Real bug found through a detailed live test on dev (14 players, one No-Show, one Retired):** `regenerateBreakPlan` had an early-exit that had been there since the function was first written — "if zero breaks are needed (bpr=0), just return the schedule unchanged, nothing to compute" — correct when bpr was already 0 to begin with (nobody ever needed a break), but wrong the moment bpr **drops** to 0 after starting above 0 (i.e. after a Retire/No-Show brings the count down to exactly fit the courts) — it kept returning the old schedule with real names still holding break slots from before, instead of clearing anything. That's exactly why "🔄 Regenerate Future" looked like it was doing nothing no matter how many times it was tapped.
- **Fix:** that case now clears every not-yet-played round's break list down to empty instead of returning the old one unchanged. Rounds that already have a result are still left exactly as they were.

---

## V0.11.37 — More serious bug found and fixed: a pending round could lock in a duplicate player after Retire/No-Show

- **A more serious real bug, found while testing V0.11.36 on dev:** if a player got marked Retired/No-Show **after** a new round (Pending — no result recorded yet) had already been generated, that round was left as-is with its old (pre-retirement) break assignment — the result was the scheduling algorithm trying to fit fewer real players onto courts than it had slots for, and in practice **the same player ended up listed twice in the same round** (a real data error, not just a display one).
- **Fix:** marking someone Retired/No-Show now automatically drops any round that hasn't been played yet (Pending) — rounds that actually have a result are completely unaffected. The admin just taps "▶ Generate Next Round" again and it regenerates correctly, with no duplicate, against the corrected break schedule.
- Manual cleanup was applied to the dev test event (event #54) to bring it back to a clean state for testing.

---

## V0.11.36 — Fixed: the Breaks tab kept using the old headcount after Retire/No-Show

- **Real bug found while testing V0.11.35 on dev:** when a player got marked Retired or Didn't Show Up **after** Start CI had already run, the Breaks tab kept computing "needs N breaks" from the original registration count, never excluding the player who left — and even the "🔄 Regenerate Future" button didn't fix it, because the same math was built on `plan.sorted` (the team-formation snapshot), which also never excluded them afterward.
- **Fix:**
  - The Breaks tab's "needs N" calculation now excludes anyone actually Retired/No-Show, not just raw registrations.
  - `regenerateBreakPlan` (what "Regenerate Future" runs) now accounts for who's actually left too.
  - **Most importantly:** marking someone Retired/No-Show now **automatically** recomputes the break schedule for any not-yet-generated (Open) rounds in the same action — no need to remember to tap Regenerate Future separately.
  - Rounds already generated (Pending or Frozen) are left exactly as they were — that's locked history by design — the fix only applies going forward, to Open rounds that don't have a final schedule yet.

---

## V0.11.35 — New "Didn't Show Up" action in the Players list, works before and after match start

- New: a "🙈 Didn't Show Up" button in the Players list (⋮) — does exactly what "🚑 Retire" already does (stops the player being scheduled into any future round/match, same automatic finance-exemption logic based on where the event's midpoint falls), just with a visibly different "shame mark": "🙈 NO-SHOW" instead of "🚑 RETIRED".
- Key difference from Retire: "Didn't Show Up" is visible **before match start too** (before Start CI / Form Teams has even run), not just after round 1 is locked in like regular Retire. Marking someone no-show before teams/round 1 are formed now excludes them from that formation entirely, instead of having no effect until later.
- Closed Teams: marking one player as a no-show marks their whole team, exactly like Retire ("the team drops together").
- One combined Undo button per player, regardless of whether they were marked Retired or No-Show.

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
