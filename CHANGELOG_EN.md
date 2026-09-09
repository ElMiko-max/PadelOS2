# Matchkeeper — Changelog (English)

English mirror of `CHANGELOG.md`, written for the in-app "Version Updates" screen (Platform Admin only — see the 📋 item in the top-right ⚙️ menu). `CHANGELOG.md` stays the master record in Arabic; this file only needs a new entry from here on, for versions that actually ship — it doesn't need to (and currently doesn't) cover the project's full history.

---

## V0.15.21 (current, needs Firestore rules deploy) — Persistent full-lifecycle registration log per player

- **Registration history now records everything that happens to a player in an event, not just seat-number changes:** registered (and how — self, invite link, added by an admin, guest, an approved join request), which seat/waitlist spot they landed on, every real position change and why, **removed from the event (and by whom)**, **re-registered** if that happens, **checked in**, **marked no-show / retired**, **marked as paid**.
- **Now fully persistent — even through removal and re-registration, the old entries stay.** The log now lives in its own separate place from the player's actual registration (which really does get deleted if they're removed) — before this, the log was stored ON the registration itself, so removing someone would have wiped their whole history along with it.
- **⚠️ Needs one extra deployment step before it actually works in production:** the Firestore security rules (`firestore.rules`) need deploying (`firebase deploy --only firestore:rules`) to allow writes to the new location — without that, every registration action will silently fail to log (everything else about registering still works normally).

---

## V0.15.20 — Harden against the event #78 waitlist-ordering bug ever recurring

- **Internal safeguard only — nothing user-visible changes.** The V0.15.16 fix for the random-order bug (event #78) was correct, but it relied on whoever called that code remembering to sort the data first. The sort is now guaranteed **inside the shared function itself** (`computeOrderingUpdates`), not something a future caller has to remember. So even a future code change that forgets to pre-sort can no longer reintroduce this exact bug.
- Note: the already-wrong numbers from before V0.15.16 (e.g. #13/#14/#15 on event #78) are left untouched — the admin explicitly asked not to fix the existing data right now.

---

## V0.15.19 — Tweaks to the registration history arrow (V0.15.18)

- **Fixed arrow direction:** now points down (▼) when collapsed and up when expanded — was backwards before.
- **Multiple players' history can now stay expanded at once** — opening a new one no longer collapses whichever was already open; each toggles independently.

---

## V0.15.18 — Full per-player registration position history

- **A small arrow (▶) next to each player in the event's Players tab** (both the Registered list and the Waitlist) expands into a full history of their position in this event's registration: the **first line is the exact moment they registered** (down to the second), and every line after is a real change to their position and why — moved down the waitlist because someone above them cancelled, promoted from the waitlist into an active seat, or any other genuine change.
- Especially important for football right now — "why am I not in the active list" or "why did they get in before me" now has an exact, recorded answer instead of a guess.
- Recorded automatically from the one single place player positions actually change (`syncOrdering`), so a real position change can never happen without being logged.
- Registrations from before this update will just show a "Registered" line until their next real position change.

---

## V0.15.17 — Exclude a specific event from promotion/demotion attendance

- **Real problem:** after some Padel communities added a second weekly event, members who normally only ever came to the original day started naturally skipping the new one — and that counted as a "miss," delaying their Casual→Regular promotion (or even risking demotion) despite being perfectly regular on their actual day.
- **Fix: a "Don't count for promotion/demotion" toggle on any event** — new option in the create/edit event screen. A marked event is left out of everyone's attendance calculation entirely: attending it doesn't help, missing it doesn't hurt, as if it never happened for tier purposes (everything else about the event — registration, results, etc. — is unaffected).
- Uses the same shared `computeMemberStreak` function that drives both the real promote/demote at event close and the progress indicator on Profile/member list, so the exclusion applies consistently in both places automatically.

---

## V0.15.16 — Audit trail for tier changes/waitlist promotion + real waitlist-ordering bug fix

- **The Audit Trail (Platform Admin) now logs every automatic member promotion/demotion** (Casual↔Regular) that happens when an event closes, **and every time someone moves off the waitlist into an active seat** because someone else cancelled.
- **🐛 Real bug fixed, found on production event #78:** when an active (confirmed) player unregistered, the code responsible for reordering the waitlist read registrations back from the database in an arbitrary order (not actual registration-time order) in one specific path — which could let the wrong person get pulled off the waitlist instead of whoever was genuinely next in line. Fixed by sorting the data correctly before that decision is made.
- **🐛 Related fix:** the "🎉 You're in!" notification sent to the promoted player was computed with an old, pre-confirmOrder/waitlistOrder method (raw array position) that could name the wrong person. It now uses the same real calculation (splitRegsByCapacity + waitlistOrder) that actually decides who gets promoted.

---

## V0.15.15 — Home is now its own screen, separate from Events, and sport-aware

- **Correction to V0.15.13:** the new dashboard (greeting + next-event hero card + stat row) has been pulled out of the "Events" screen and now lives on its own separate "Home" screen — opened via the **Matchkeeper logo itself** (top-left, now clickable). The **"Events"** button goes back to being exactly what it was before V0.15.13 — the plain Coming/Past list, nothing added on top.
- **The app now opens on "Home" by default** instead of "Events", since it's the actual landing page.
- **The dashboard is now aware of players who play more than one sport:** if a player is active in both Padel and Football, a switcher (🎾 Padel / ⚽ Football) appears — the same one already used on the Profile screen — and each sport gets its own next-event card and its own stat numbers (USR for Padel; FSR for Football instead of USR, since it's a different concept entirely — a letter grade, not a number). A single-sport player never sees the switcher and just sees their own sport's numbers directly.

---

## V0.15.14 — Member tier progress indicator (Casual↔Regular) on Profile and member list

- **A new indicator shows how close a member is to being promoted or demoted**, using the exact same live rule that already governs this whenever an event actually closes (consecutive attendance/misses vs. the community's "Promote after"/"Demote after" settings):
  - **Casual, currently on an attending streak:** "2/3 to Regular" with a green progress bar.
  - **Regular, currently on a missing streak:** "2/4 missed" with an amber warning showing how many more misses would trigger demotion.
  - **Guest:** no indicator shown — there's no automatic rule for Guest promotion at all (confirmed by reading the code before building this), so it stays a manual admin decision only.
- **Shown in two places:** the community's member-management screen (admin view), and the Profile screen (a member sees it themselves next to each community they're in).
- Internal cleanup: the calculation now lives in one shared function (`computeMemberStreak`) used by both the new indicator **and** the real code that actually promotes/demotes — so the indicator can never drift out of sync with what will really happen.

---

## V0.15.13 — Redesigned home ("Events") screen — more informative, more polished

- **The home screen has a new top section** — a personalized time-of-day greeting, a spotlighted card for your soonest upcoming event (name, venue, time, day countdown, registration bar, and a direct link into it), and a quick row of four real stats: upcoming events, your USR, how many communities you're in, and matches played.
- **Everything animates in gently on load** — the greeting, hero card, and stat numbers cascade in with a count-up effect, and the "next up" card carries a soft breathing glow. Previewed live as an Artifact before building it, with the admin picking this direction.
- The existing Coming/Past tabs and every action (New/Select/Archive/Delete) are unchanged underneath the new section.
- **⚠️ Shipped to DEV only so far** — not yet pushed to GitHub or built into an APK.

---

## V0.15.12 — New animated boot/loading screen, replacing the plain black "Loading…" screen

- **The screen shown while the app is starting up (waiting on sign-in/data) has been redesigned** — instead of a blank black screen with plain "Loading…" text, it now shows the app's own logo animated (the color ring spinning around the court icon), with "Matchkeeper" and "Getting things ready" underneath.
- **The version number and environment (Web / DEV / Android) now show in small text at the bottom of the loading screen** — explicit admin request, so every screenshot taken carries that information automatically.

---

## V0.15.11 — Regular-member priority window is back, correctly scoped this time, and the waitlist now has permanent numbering

- **After a detailed discussion with the admin, it turned out the "Regular members get first dibs for the first 24h" idea was genuinely intended — the problem was never that the priority existed, it was how it was implemented.** The window is back, precisely respecified:
  - **Regular** registering within the first 24h → immediate active seat, permanent number, forever. If capacity is already full even for Regular, falls to the waitlist instead.
  - **Casual** registering within the same 24h → always goes straight to the waitlist (even with room), gets a permanent waitlist position.
  - **Once the 24h window closes:** no tier distinction at all — every new registration, and everyone already on the waitlist, competes purely by arrival order, and gets pulled into the active list automatically as seats open.
  - **Guests:** unchanged from V0.15.10 — always need admin approval. The moment of approval now decides whether they land on the waitlist (window still open) or try for an active seat directly (window closed).
- **The waitlist now has its own permanent position number**, same as the active list — no longer a freshly-recomputed index every render. Fixed once assigned, only shifts down when someone above them leaves the waitlist (cancels, or gets promoted to active).
- Verified end-to-end with a full simulation before shipping (registering during the window, after it closes, cancellations, waitlist-to-active promotion) — every case checked out.

---

## V0.15.10 — Registration order is now pure first-come-first-served — no tier ever jumps the queue

- **Removed the "priority window" entirely** (it used to let Regular members, and anyone admin-added/invited/approved, skip ahead of earlier-registered Casual members during the first 24h). This is exactly why Khalid showed up as #3 on event #72 despite registering late — a real bug, confirmed by the admin, described as "a very serious concern."
- **Registration order is now purely chronological (FIFO) — like a cinema seat or a doctor's waiting room:** the moment you register and take your spot, your number is permanent, and only changes if someone ahead of you cancels (the existing shift-down rule already handles that).
- **A related bug fixed at the same time:** a Guest (no membership, or "Guest"-tier) clicking an event's invite link used to register immediately with no admin approval — while the normal "I'm In" button already blocks guests behind a join request. Invite links now follow the same rule: a Guest is automatically converted into a join request requiring admin approval, and only receives their number the moment the admin actually approves it — not when they clicked the link.
- **A one-time renumbering ran on every currently-open event** so today's numbers immediately reflect true registration order (this can change who's actually confirmed vs. waitlisted on a live event, not just reorder the same people — that's the intended correction, not a side effect).
- **⚠️ This change touches Cloud Functions (`functions/index.js`) for the first time — needs a separate deploy (`firebase deploy --only functions`) before it reaches production.**

---

## V0.15.09 — Dynamic engine now auto-refreshes future-round predictions after every round

- **Direct request:** the admin had to manually tap "Regenerate" every time to refresh the break prediction for not-yet-generated rounds after each Dynamic-engine round completed. This now happens automatically the moment a round is generated — no extra button tap needed.
- The round that was just actually generated (the real Dynamic pick) is untouched — only the still-ungenerated rounds' predictions get refreshed.
- Same change applied to CT Ladder.

---

## V0.15.08 — Returning-from-break placement now follows court order

- **Direct request after testing the Dynamic engine:** a player returning from break used to be offered whichever court currently had the most open seats, not necessarily their own or the next one down. Now returning players are processed one court group at a time (all Court-1 returners first, then Court-2, then Court-3...), and each one tries to reclaim their own court first, cascading down to the next court in order if it's full — never to an unrelated court.
- Same fix applied to CT Ladder (teams returning from break).
- **Clarification, not a bug:** the "C4" tag shown next to a Round-1 break player is a USR-rank preview (where they'd sit if there were one more court), not a real court number — it's meant to show how close someone was to playing, not an actual assignment.

---

## V0.15.07 — Another quick fix: the waitlist got merged into the active list on a test event

- **Another bug caught by direct DEV testing**, from the same short window V0.15.05 was live before V0.15.06's fix: the old "who's active" calculation didn't correctly count already-confirmed non-priority (Casual/Guest) members against the event's capacity ceiling — so 3 extra players got a permanent confirm number on a test event (#207) even though it was already full (18 instead of 15), which showed up as "the waitlist merged into the active list."
- **Fix:** added a completely independent hard capacity ceiling directly inside the number-assignment step itself — no matter what any other calculation says, it will never hand out more confirmed seats than an event's max allows. A repair pass has already run (came back empty — that one test event was the only one affected anywhere in DEV).
- **Production remains completely untouched** — this feature hasn't shipped there yet.

---

## V0.15.06 — Quick fix: confirmed players could vanish from the list even though their number was still saved

- **Caught by direct testing on DEV, hours after V0.15.05 shipped:** some confirmed players (with a real saved number) were disappearing from the "Registered" list, leaving gaps in the sequence (e.g. 6, 8, 9 with 7 missing) — even though their number was still sitting in the database. Root cause: the number was only ever used to sort who's shown, not to decide who's shown — that decision was still recomputed fresh every time from current membership status and the priority window, so anyone whose status changed (e.g. Regular → Casual) after being confirmed could vanish again despite already having a number.
- **Fix:** a registration with a permanent confirm number is now unconditionally, permanently confirmed — it can never be re-evaluated back out. The priority/window rules now only govern who still needs a number in the first place.

---

## V0.15.05 — Permanent seat number for every confirmed player in the Players tab

- **A small number now shows to the left of each name in the Players tab** — a player's actual confirmed seat (e.g. "player #13").
- **That number is now genuinely permanent, not recomputed from registration timestamps every render.** Once a player is confirmed (enters the active roster), they get a fixed number that never changes. If someone above them cancels, everyone below shifts down by exactly one (closing the gap) — relative order is preserved, and nobody takes over the cancelled person's old number. A brand-new confirmation always gets the next number at the end, never backfilled into a freed slot.
- **Every existing event was backfilled in one pass** so nobody is left unnumbered until something changes for them.
- Waitlisted players still show no number (only confirmed players get one, same as today's split).

---

## V0.15.04 — Real production bug: a confirmed active player could be silently evicted from the roster (event #76)

- **Real bug, confirmed on live production** (event #76, "Sunday 6 September" — see BUGS.md #18 for the full writeup): an event's "priority window" (`regularUntil`, which gives Regular members first claim on active slots over Casual ones) is set to a fixed 24 hours from event creation, with no relation to the actual event date — so it can close days before the event while registration is still actively filling up. Once it closed, the roster fell back to pure chronological order with no regard for who already held an active spot during the window — silently evicting a Regular member who'd secured an active slot, to make room for an earlier-registered Casual member, with no notice to anyone.
- **Fix:** anyone who was genuinely active during the priority window is now grandfathered in once the window closes — they can no longer be bumped back out. Only genuinely open slots get filled from the rest, in registration order.

---

## V0.15.03 — Real bug: the Breaks tab table didn't update after the Dynamic engine's actual pick

- **Real bug, confirmed by direct testing:** the admin tried the "⚡ Dynamic" engine going from Round 2 to Round 3, and the engine correctly picked who took a break (based on who lost) — but **the Breaks tab table kept showing the old prediction** (what Classic would have picked) instead of reflecting what actually happened.
- **Root cause:** the real round (matches, who's actually on break) was recorded correctly, but the separate prediction array (`breakPlan`) that the Breaks tab table — and its Total column — reads for every column, including already-generated ones, was never updated to match the Dynamic engine's real pick.
- **Fix:** whenever a round is generated under the Dynamic engine, the prediction array is now synced immediately with the real pick, so the Breaks tab table and Total column always reflect reality.

---

## V0.15.02 — Real bug: Start CI / Form Teams & Start could permanently drop a registered player from the roster

- **Real bug, confirmed with an actual case on DEV (event #207):** "Dodo" was registered and confirmed as a "Regular" community member, but disappeared entirely from the break schedule after Start CI ran (13 players shown instead of 15), and the next rounds showed odd "breaks (needs N)" warnings. Root cause: `startCI` (and CT's "Form Teams & Start") computed who counted as active and built the entire plan *before* the actual database write — if a registration landed right around the moment the button was tapped and hadn't fully reached this screen's local state yet, that stale snapshot got baked in permanently, with no later correction pass (unlike rounds after the first, where `syncCIPlanRoster` catches and fixes this automatically).
- **Fix:** the roster is now computed fresh at the exact moment of the write, from the latest registration data — the same protection already in place for every round after the first.
- Note: event #207 on DEV has been reset again so Start CI can be retried cleanly with the fix in place.

---

## V0.15.01 — Real bugs: 5 people shown on break in a 3-court event, and the notification banner covering the event name

- **Real bug: more players marked "on break" than the event should ever have.** Confirmed via a direct database query that `plan.sorted` had picked up extra players who briefly registered and then got bumped back to the waiting list right around the moment "Next Round" was tapped — and were still wrongly counted as "real" roster members (`everAppeared`) because the check treated any generated round, even one that hadn't been played yet, as proof someone belonged. The check now only counts rounds that have actually been *played* (every match has a recorded winner) as real history, which stops a burst of near-simultaneous registrations from inflating who's owed a break.
- **The "new version" / "notifications are off" banner now collapses into a small floating icon on the left edge once you scroll**, instead of staying pinned over the event name and page content below it. Tapping the icon still does exactly what it did before (refresh the app / open Settings) — it just no longer blocks the view.

---

## V0.15.00 — Big new feature: the "Dynamic Break" system for CI and CT Ladder

- **A brand-new, opt-in break engine called "⚡ Dynamic"** — an alternative to today's system (now called "Classic"), available in the Breaks tab for any CI or CT Ladder event.
- **The idea:** builds the initial schedule exactly like today (time preferences, locks, everything) — but from Round 2 onward, decides who actually takes a break based on who just lost, starting from the top court. If none of that court's losers still qualify for another break (already used their quota, or just came off a break last round), it moves to the next court down, and so on. If literally no eligible losers remain anywhere, it falls back to winners, again starting from the top court.
- **Core rules confirmed with the admin:** locked (🔐 Firm) breaks always win in both engines. "No break two rounds in a row" is an absolute rule with no exception. Overall fairness (max breaks minus min breaks never more than 1) stays exactly as strict as the Classic engine. "Concentrate" now means systematically choosing who gets the "extra" break instead of it being arbitrary — both in the base allocation and in any tie within the dynamic engine.
- **The engine can be switched at any time during play** — not a one-time choice made only at the start — via the "⚡ Engine" button in the Breaks tab, including as a safety fallback if needed.
- **"Regenerate Future" keeps working exactly as before** for both engines — it still computes a full prediction for every round not yet generated; Dynamic only overrides who actually takes the break the moment the next round is really generated (unless that round is locked).
- Cells showing a prediction that could still change (not locked) now carry a small ⚡ marker in the grid.
- **The algorithm was verified with an actual simulation** before shipping — overall fairness and the no-consecutive-break rule both held correctly across a full test scenario.

---

## V0.14.17 — Real bug: deleted events still counted toward "played before" (head-to-head)

- **Real bug fixed (confirmed directly against real production data):** deleting an event in the app doesn't actually remove it from the database — it just sets a `deleted` flag and keeps its full history (rounds, matches) intact. Every other place in the app explicitly excludes deleted events except the "played before" (head-to-head) calculation — that one ignored the flag entirely. Found a real case on production: a deleted test event had the exact same match results as a real, active event, which could have shown an incorrect "played before" badge sourced from data that was supposed to be gone.
- **The fix:** a deleted event no longer counts toward head-to-head history at all — for both CI and CT.
- **Checked real production data after the fix:** out of 168 decided matches across all real completed events, no genuine repeat has happened yet — so it's not that the badge doesn't work, it just hasn't had a real case to show yet.

---

## V0.14.16 — Real bug: Match Mode's whistle was playing on the wrong volume stream (not Alarm)

- **Real bug fixed (confirmed via a live logcat capture during an actual test):** the whistle alarm was firing exactly on schedule (the alarm itself, the notification, and the vibration all worked correctly) — but this line showed up in the log at the exact firing moment: `trying to set audio attributes called in state 8`. Cause: the code used `MediaPlayer.create()` (which prepares the sound file to play immediately as part of creating it), then tried to mark it as "Alarm" audio afterward — by then it was too late, and Android silently rejected the request, so the sound played at the app's regular (Media) volume instead of the Alarm volume. If media volume was low or muted, the whistle wouldn't be heard even though the vibration fired normally.
- **The fix:** the sound is now set up in the correct order (marked as "Alarm" before it's prepared to play), so it actually plays at alarm volume now — should be noticeably louder and clearer.
- **Also checked the sound file itself** (`mm_whistle.wav`) — it's already mastered close to the maximum possible level (no real headroom left to gain), so the volume issue was entirely about which stream it played on, not the file itself.

---

## V0.14.15 — Breaks tab now computes the correct roster live, no button tap required first

- **Change per admin report ("still not solved"):** V0.14.14's fix only corrected `plan.sorted` when the admin tapped "Next Round" or "Regenerate Future" — so if nobody had tapped that yet since the update, the screen would still show the old data. Confirmed against event #203's real data that this was exactly what happened.
- **The fix:** the CI Breaks tab now computes who's actually "in the game" **live, every time the screen renders** — straight from current registrations and capacity — instead of relying on whenever `plan.sorted` was last saved. The count will now be correct immediately, no button tap needed.
- **⚠️ Important note:** this fixes **who shows up** only — the actual stored break numbers (computed earlier while the roster kept changing) still need **one real tap of "🔄 Regenerate Future"** to get recomputed against the correct 15 players and restore balance (max−min ≤ 1).

---

## V0.14.14 — Real bug: a player could get "stuck" in the active roster after being bumped to the waiting list

- **Real bug fixed (confirmed by directly inspecting event #203's data, after the admin reported the previous fix wasn't enough):** V0.14.11/12 added anyone active to the real player roster, but nothing ever removed someone in the reverse case — added while briefly active, then moments later bumped to the waiting list by a higher-priority registration taking the last open slot. That player stayed "stuck" in the match/break math forever, even though they showed as waitlisted everywhere else in the app — which is exactly why the roster showed 16 instead of 15, and break counts looked unbalanced.
- **The fix:** every time "Next Round" or "Regenerate Future" runs, anyone previously added who is now on the waiting list **and has zero real history** (never actually played a match or took a break) gets automatically removed. Anyone who did play before being bumped keeps their history.
- **Verified directly against event #203's real data** before shipping — the result came out to exactly 15 players.

---

## V0.14.13 — Bug: waitlisted registrations were showing up in the Breaks tab

- **Real bug fixed:** the CI Breaks tab table listed every registration for the event, including anyone still over capacity on the waiting list — showing them as a full row with 0 breaks, which looked like a bug even though they were never part of the play rotation at all.
- **The fix:** the table now only shows who's actually in `plan.sorted` (the real roster match/break generation runs against) — this automatically excludes the waiting list, while still showing anyone who retired mid-event (they did play before retiring, so their history is worth keeping visible).

---

## V0.14.12 — Real bug: the V0.14.11 fix itself broke "Regenerate Future"/"Next Round" entirely

- **Real bug fixed (reported by the admin: the button became completely unresponsive):** V0.14.11's fix tried to read an event's registrations off `ev.registrations` — but inside the save transaction (`updEvent`), the event object doesn't have that field at all (since registrations moved to their own subcollection, `.registrations` only exists on the merged display version, not the raw write-path object). That threw an error immediately, before any toast could show — which is exactly why the button looked completely dead.
- **The fix:** registrations are now passed in explicitly from the correct source instead of being read off the wrong object.
- **Clarification:** the two players you removed genuinely were on the waiting list (over capacity) — not a bug, they were correctly excluded from the play rotation.

---

## V0.14.11 — Real bug: registering after Start CI made you vanish from the whole event, not just breaks

- **Real bug fixed (found by inspecting event #203's actual data on DEV):** what looked like "2 breaks vs 0" wasn't a break-fairness bug at all — inspecting the data showed `plan.sorted` (the player pool matches/breaks are computed against) had only 15 players, while the event actually had 17 registrations. Two of them ("Abdo Alaa" and "A Hassan") registered at 7:21 AM, hours after everyone else (3:13 AM) — after "Start CI" had already run. Nothing in the code folded a post-Start-CI registration into `plan.sorted`, so those two players were **never in a single match or break for the rest of the event** — Regenerate could run a hundred times and it wouldn't matter, with nothing in the UI explaining why.
- **The fix:** every time an admin taps "Next Round" or "Regenerate Future" on a CI event, the app first checks that every currently-active registration (within capacity, not retired) is present in `plan.sorted`, adding anyone missing before computing. The next generated round places them in the nearest open court (same as anyone returning from a break), and any Regenerate after that correctly folds them into the break-fairness math.
- Note: already-generated rounds (locked or pending) aren't rewritten retroactively — this only affects anything not yet generated.

---

## V0.14.10 — "Mid" on even-round events now accepts both straddling rounds

- **Change per direct clarification:** V0.14.08's fix rounded "Mid" to a single round (e.g. R4 on a 6-round event). Now it accepts **both rounds straddling the true midpoint** as an equally valid match — a 6-round event's Mid matches R3 or R4, an 8-round event's matches R4 or R5 — whenever the exact midpoint isn't a whole number (i.e. the round count is even).
- **Odd-round-count events** (e.g. 7 rounds) are unchanged — there's exactly one true middle round, no ambiguity.

---

## V0.14.09 — 3-letter weekday now shown on every date

- **Improvement per direct request:** every date shown in the app (event dates, and the absolute dates now shown for old messages since V0.14.07) now includes a short weekday abbreviation — e.g. "Fri, 15 Aug 2026" instead of "15 Aug 2026".

---

## V0.14.08 — Real bug: "Mid" break preference didn't work at all on even-round events

- **Real bug fixed (spotted via the new "M" tag on the grid):** anyone with "Mid" break preference — the internal math was looking for an exact middle round like 2.5 out of 6, which isn't a whole number, so no round ever matched it. That silently made "Mid" behave like "no preference" on any event with an even number of rounds (the common case). "Early" and "Late" never had this problem since the first/last round is always a whole number.
- **The fix:** the midpoint now rounds to the nearest real round — "Mid" now has exactly one target round it anchors to, same as Early and Late.
- Note: even after this fix, a match still isn't 100% guaranteed — if several people share the same preference and there aren't enough slots for all of them in that round, whoever the overall fairness balance favors gets it, not everyone with that preference.

---

## V0.14.07 — Real bug: Concentrate broke the break-balance rule + old timestamps are now clear

- **Real bug fixed (reported by the admin on event #203 in DEV):** the V0.14.04 version of "Concentrate" removed the cap on how many breaks a concentrated player/team could take — letting them end up with 2 while everyone else had 1, silently breaking a rule that already existed in this app (max breaks minus min breaks must never exceed 1 — the same check the Breaks tab's own "Unequal breaks" warning enforces). **Fix:** Concentrate is back inside the same fair budget — it only decides who gets priority when more than one person is equally due for a break, never a bigger total share than anyone else. **If you have an event with unbalanced breaks from this, tap "Regenerate Breaks" again after this update and it'll settle correctly.**
- **Old message timestamps are now clear:** it used to just keep counting up ("12d ago") past the point of being genuinely readable. Now, past 24 hours, it switches to a real date and time — "Yesterday, 2:30 PM" → "15 Aug, 2:30 PM" (this year) → "15 Aug 2025, 2:30 PM" (older years) — the same convention WhatsApp/iMessage use. Today still shows "5m ago"/"3h ago" as before.

---

## V0.14.06 — Bug: collapsed old announcements couldn't be reopened + Add Guest is now a modal

- **Real bug fixed:** the collapsed old-announcement row (V0.14.05) didn't respond to taps at all — the click handler was placed on the `Card` component, which doesn't accept/forward an `onClick` prop (silently dropped). Moved the handler onto an element inside the card instead.
- **"+ Add Guest" in the Players tab is now a modal box** instead of a long inline section, same treatment as "+ Add Member" in V0.14.04.

---

## V0.14.05 — Old Community Announcements now auto-collapse with a small preview

- **New feature:** in the Community's Announcements tab, only the 3 most recent messages/polls stay open like today — anything older now **auto-collapses** into a single-row hint: author name, date, the start of the text, and either a reply count (plain message) or a voter count (poll).
- **Tap the collapsed row to open it** and see the full content, same as before — a "▲ Collapse" link next to the date collapses it again.
- **Order is unchanged** — newest still on top, oldest still on the bottom — it's just collapsed now instead of taking up a lot of page space.

---

## V0.14.04 — Clarified "Concentrate", break-preference tags in the grid, Add Member is now a modal

- **Corrected the "Concentrate" idea** (per direct clarification): it used to only give selected players/teams one leftover "extra" break if one existed. Now: a concentrated player/team is **always the first pick for a break, every round** (still respecting the no-two-rounds-in-a-row rule) — so they visibly end up with more breaks than everyone else across the event, not just a single extra one.
- **New tags in the Breaks tab (CI and CT):** next to any player/team with a break-time preference (Early/Mid/Late), a small tag (E/M/L) now shows it, so you can visually confirm break generation is respecting it. Next to any player/team set to Concentrate, a small "C" tag shows too.
- **"+ Add Member" in the Players tab is now a modal box** instead of expanding a long section in the page — opens a compact popup, search and add, tap "✓ Done" to close, same as every other modal in the app.

---

## V0.14.03 — New feature: concentrate extra breaks on selected players per event

- **New feature (item 2 of the break-engine rework request):** when the break count doesn't split evenly across players/teams, the leftover "extra" breaks used to go to whoever happened to be next in the default order (fewest breaks so far, then lowest USR). The Breaks tab (both CI and CT) now has a "🎯 Concentrate" button — the admin picks specific players, and any extra break (if there is one) goes to them first instead of the default order.
- **This is a per-event setting** (not global) — it stays off (unset) until an admin actually picks someone.
- **Same rule as every other Breaks tab edit:** it only affects rounds not yet generated — tap Regenerate after saving to apply it.

---

## V0.14.02 — Break Matrix: from an unstable toggle/swap to a modal with 3 clear choices

- **Real UX change:** after the underlying technical bug was fixed (V0.14.00/V0.14.01), it turned out the interaction itself — not just the bug — was the real complaint. The manual tap-to-swap (CT) and tap-to-cycle (CI) interactions felt unstable. Replaced entirely, in **both CI (Closed Individuals) and CT (Closed Teams) Ladder**: tapping any open (not-yet-generated) cell now opens a clear modal with 3 choices — ▶️ Playing (no break) · 🪑 On Break (suggested) · 🔐 On Break — Firm (locked, survives Regenerate) — pick one and you're done.
- **CT specifically:** the "tap a team, tap another team to swap" interaction and the separate tiny lock icon are both gone — replaced by the same single modal.
- **"Regenerate Breaks/Future" is unchanged.**

---

## V0.14.01 — Same flicker bug existed in CI (Ladder) too, not just CT

- **Real bug fixed:** after fixing V0.14.00 for the Closed Teams Ladder Breaks tab, the natural question was "what about CI?" — confirmed the exact same bug was live in CI's manual break editing (`editBreakCI`) and its "Regenerate" button (`regenerateBreaksCI`). Never reported because CI's break UI is one-cell-at-a-time rather than CT's swap/lock interactions, but the same root cause.
- **The fix:** identical fix — always saves against the actual current plan.

---

## V0.14.00 — Real bug (round 2): break swap/regenerate in Closed Teams Ladder were still flickering

- **Real bug fixed:** the V0.13.04 fix only covered the Firm-lock toggle button — the exact same bug was still live in three other spots on the Closed Teams Ladder Breaks tab: the manual break swap between two teams, the "Regenerate Breaks" button, and team break preference. All three were saving based on a stale copy of the plan instead of the live one at save-time — the same root cause that shows up as "flickering."
- **The fix:** all three now always save against the actual current plan, the same way the Firm-lock toggle was fixed in V0.13.04.

---

## V0.13.05 — Real bug: sharing event results to WhatsApp was failing on Android

- **Real bug fixed:** the "Share Results" button after closing an event was failing specifically on WhatsApp, and specifically on the Android app (web worked fine) — WhatsApp showed its own "Can't send empty message" toast even though Matchkeeper's own toast said "Shared ✓" (the app's own share genuinely succeeded). Cause: the app deliberately sent an empty caption (to stop WhatsApp from duplicating the same caption under every image) — but an empty string is still a real, present value, not a missing one, and WhatsApp treats that as "trying to send a blank message" and refuses it.
- **The fix:** an empty caption is now genuinely omitted instead of sent as empty — WhatsApp receives just the images with nothing to reject.

---

## V0.13.04 — Fixed the "flickering" break lock toggle in Closed Teams Ladder

- **Real bug fixed:** the lock/unlock-as-Firm toggle (Breaks tab, Closed Teams Ladder) saved its change based on a stale copy of the plan captured earlier — so if anything else touched the plan around the same time (a break swap, a regenerate, another lock toggle), this save could silently undo it, which showed up as the state "flickering" back on its own.
- **The fix:** the save now always applies to whatever the plan actually is at the moment of saving, not a stale snapshot from before.
- **Also improved:** the tiny icon that used to lock/unlock instantly on tap now opens a clear small menu (naming the team + round) with one explicit button — easier to hit and to confirm what's about to happen before it happens.

---

## V0.13.03 — One unified modal for editing a player's info

- **Real bug fixed:** in Platform Admin, tapping "✏️ Edit" on any player always opened the edit form at the very top of the list — not next to the row you tapped. On a long list, nothing visibly happened where you clicked, making it look broken, until you scrolled up and found the form there. There were also two genuinely different edit forms for the same player — one in Platform Admin, one on the profile screen itself — with different fields (the profile-screen one was missing Full Name, USR, and Football Skill; Platform Admin's was missing the InstaPay link and photo management).
- **The fix:** one shared modal that always appears right where you triggered it, with the same fields in both places — only permissions differ (Full Name/USR/Football Skill are Platform-Admin-only; resetting to your Google photo is self-only).

---

## V0.13.02 — Self-diagnosing any future sign-in hang

- **Follow-up to V0.13.01:** that fix is confirmed working (other users are signing in normally), but one user was still stuck — resolved in practice with a direct invite link to his profile. Checked the Cloud Function logs directly: `claimOrCreateProfile`/`confirmEmailMatch` were never invoked at all today, for anyone — meaning whatever went wrong for him happened before the request ever reached the server, somewhere in the client itself.
- **The interim fix:** the app now automatically logs the full state of any sign-in attempt that's still stuck after 10 seconds (email, every relevant variable's state, how much data loaded) to Firestore — so if this happens again, there's real data to look at instead of more guessing.

---

## V0.13.01 — Real bug: some users were stuck on "Setting up your profile…" forever

- **Real bug fixed:** a real user reported being completely unable to sign in — stuck on "Setting up your profile…" with no way out, on both the APK and web. Cause: if a device had a locally-saved invite code that had gone stale (expired, deleted, or already claimed by someone else), that code never got cleared — and it silently blocked the OTHER sign-in path (creating a fresh profile or matching by email) from ever running at all, since it was waiting for the invite path to finish first.
- **The fix:** every one of those dead-end cases (invite not found, target profile deleted, invite already claimed) now clears the stale code and falls through to the normal sign-in flow instead of hanging.
- **Extra safety net:** if sign-in ever gets stuck for any other reason, the screen now shows a "🔄 Try Again" / "Sign out" option after 10 seconds instead of hanging with no way out at all.

---

## V0.13.00 — Another architectural release: every registration is now its own Firestore document

- **The problem:** even after V0.12.00 split every event into its own document, every registration for that event still lived together as one array field on the event document — so 50 people registering at the exact same moment were still all contending for that one document. A real test confirmed it: worst case took ~39 seconds (zero lost, but painfully slow under a genuine rush).
- **The fix:** each registration is now its own independent document (`padelos_events/{eventId}/registrations/{userId}`) — concurrent registrants to the same event no longer contend with each other at all. The same test (50 simultaneous registrations against a 15-person cap) now finishes in under 2 seconds instead of ~39 — zero lost, exact correct split every time.
- **Thorough DEV testing before shipping** found and fixed 3 real bugs: (1) closing an event showed a "didn't save" error even though it actually closed (a query needed a Firestore index that didn't exist), (2) every screen was silently showing zero registrations for every event (a string-vs-number id mismatch), and (3) most importantly — Firestore permissions were blocking reads across all events' registrations at once, a bug only catchable by testing with a real signed-in user, not admin tooling.
- **Extra fix while in there:** promoting a member (casual → regular) after closing events that happen to share the exact same date is now guaranteed to give the same answer every time (it could previously depend on Firestore's arbitrary fetch order).
- The old array-based data is kept as a rollback source for now and will be cleaned up once this is confirmed stable for a few days.

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
