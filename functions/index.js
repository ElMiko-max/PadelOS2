const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getMessaging} = require("firebase-admin/messaging");
const {getFirestore} = require("firebase-admin/firestore");
initializeApp();

exports.sendPushOnNotification = onDocumentWritten("padelos/notifications", async (event) => {
  const beforeRaw = event.data.before.exists ? event.data.before.data().value : "[]";
  const afterRaw = event.data.after.exists ? event.data.after.data().value : "[]";
  const before = JSON.parse(beforeRaw || "[]");
  const after = JSON.parse(afterRaw || "[]");
  const beforeIds = new Set(before.map(n => n.id));
  const newOnes = after.filter(n => !beforeIds.has(n.id));
  console.log(`[push] trigger fired. before=${before.length} after=${after.length} newOnes=${newOnes.length}`);
  if (newOnes.length === 0) {
    console.log("[push] no new notifications, exiting.");
    return;
  }
  const db = getFirestore();
  for (const notif of newOnes) {
    console.log(`[push] processing notif id=${notif.id} userId=${notif.userId} title="${notif.title}"`);
    if (!notif.userId) {
      console.log("[push] skipped: no userId on notif");
      continue;
    }
    const tokenDoc = await db.collection("fcmTokens").doc(String(notif.userId)).get();
    if (!tokenDoc.exists) {
      console.log(`[push] skipped: no fcmTokens doc for userId=${notif.userId} — this device/user never completed "Enable Push"`);
      continue;
    }
    const token = tokenDoc.data().token;
    if (!token) {
      console.log(`[push] skipped: fcmTokens doc exists for userId=${notif.userId} but has no token field`);
      continue;
    }
    console.log(`[push] found token for userId=${notif.userId}, attempting send... token starts with: ${token.slice(0,20)}...`);
    try {
      const result = await getMessaging().send({
        token,
        notification: { title: notif.title || "Matchkeeper", body: notif.body || "" },
        webpush: { fcmOptions: { link: "https://matchkeeper.app" } },
      });
      console.log(`[push] SUCCESS sending to userId=${notif.userId}. messageId=${result}`);
    } catch (e) {
      console.error(`[push] SEND FAILED for userId=${notif.userId}:`, e.code || e.message || e);
    }
  }
});

// Cutover tripwire (comms-split migration) — padelos/comms is abandoned once the app is fully
// cut over to padelos_communities/padelos_events. This has nothing left that's supposed to write
// to it; if anything ever does (a stale client that predates the migration, a forgotten code
// path), this fires within a minute and logs loudly, turning what would otherwise be an
// undetectable stale-write into something caught immediately. Never removes/reverts the write
// itself — just alarms.
exports.warnOnLegacyCommsWrite = onDocumentWritten("padelos/comms", async (event) => {
  console.error(`[legacy-comms-tripwire] padelos/comms was written to after the comms-split migration cutover — this document should be completely abandoned. before.exists=${event.data.before.exists} after.exists=${event.data.after.exists}. Investigate which client/code path did this.`);
});

// Runs every minute. Checks padelos/matchModeSchedule for any round whose end time
// has passed and hasn't been notified yet, then appends entries to padelos/notifications
// (which sendPushOnNotification above already watches and sends pushes for — no duplicate
// send logic needed here).
exports.dispatchMatchModeAlarms = onSchedule("every 1 minutes", async () => {
  const db = getFirestore();
  const scheduleRef = db.collection("padelos").doc("matchModeSchedule");
  const scheduleSnap = await scheduleRef.get();
  if (!scheduleSnap.exists) return;

  const schedule = JSON.parse(scheduleSnap.data().value || "[]");
  const now = Date.now();
  const due = schedule.filter(s => !s.sent && new Date(s.endsAt).getTime() <= now);

  if (due.length === 0) {
    console.log("[matchMode] nothing due");
    return;
  }
  console.log(`[matchMode] ${due.length} round(s) due, dispatching...`);

  const notifRef = db.collection("padelos").doc("notifications");
  const notifSnap = await notifRef.get();
  const notifications = notifSnap.exists ? JSON.parse(notifSnap.data().value || "[]") : [];

  const newNotifs = [];
  for (const s of due) {
    for (const userId of (s.userIds || [])) {
      newNotifs.push({
        id: `mm-${s.id}-${userId}`,
        userId,
        title: "⏱ Round ended",
        body: `${s.label} — Round ${s.round} is done, swap courts!`,
        createdAt: new Date().toISOString(),
      });
    }
  }

  await notifRef.set({value: JSON.stringify([...notifications, ...newNotifs])});

  const updatedSchedule = schedule.map(s => due.includes(s) ? {...s, sent: true} : s);
  await scheduleRef.set({value: JSON.stringify(updatedSchedule)});

  console.log(`[matchMode] sent ${newNotifs.length} notification(s)`);
});

// Runs every minute. Checks padelos/eventReminderSchedule for any 24h/3h/1h reminder
// whose time has arrived, looks up who is CURRENTLY registered for that event (so
// late registrations and cancellations are respected even though the reminder was
// scheduled earlier), and appends entries to padelos/notifications.
exports.dispatchEventReminders = onSchedule("every 1 minutes", async () => {
  const db = getFirestore();
  const scheduleRef = db.collection("padelos").doc("eventReminderSchedule");
  const scheduleSnap = await scheduleRef.get();
  if (!scheduleSnap.exists) return;

  const schedule = JSON.parse(scheduleSnap.data().value || "[]");
  const now = Date.now();
  const due = schedule.filter(s => !s.sent && new Date(s.firesAt).getTime() <= now);

  if (due.length === 0) {
    console.log("[eventReminder] nothing due");
    return;
  }
  console.log(`[eventReminder] ${due.length} reminder(s) due, dispatching...`);

  const notifRef = db.collection("padelos").doc("notifications");
  const notifSnap = await notifRef.get();
  const notifications = notifSnap.exists ? JSON.parse(notifSnap.data().value || "[]") : [];

  const labelMap = {"24h": "tomorrow", "3h": "in 3 hours", "1h": "in 1 hour"};
  const newNotifs = [];
  const stillValid = []; // reminders we could actually process (event found) — used to mark sent

  for (const s of due) {
    // comms-split migration: each event is its own document now, looked up directly by id
    // instead of scanning a whole-platform blob — communityId on the schedule entry isn't even
    // needed for this lookup anymore.
    const evSnap = await db.collection("padelos_events").doc(String(s.eventId)).get();
    const ev = evSnap.exists ? evSnap.data() : null;
    if (!ev || ev.status === "cancelled") {
      console.log(`[eventReminder] skipping ${s.id}: event not found or cancelled`);
      stillValid.push(s);
      continue;
    }
    // Phase 2: registrations live in their own subcollection, not the `.registrations` array
    // field — same "who's currently registered" semantics (respects late registrations and
    // cancellations even though the reminder was scheduled earlier), just a query instead of a
    // field read.
    const regsSnap = await evSnap.ref.collection("registrations").get();
    const userIds = regsSnap.docs.map(d => d.data().userId);
    for (const userId of userIds) {
      newNotifs.push({
        id: `evr-${s.id}-${userId}`,
        userId,
        title: "📅 Event reminder",
        body: `${ev.name} is ${labelMap[s.reminderType] || "coming up"}${ev.time ? " — " + ev.time : ""}`,
        createdAt: new Date().toISOString(),
      });
    }
    stillValid.push(s);
  }

  await notifRef.set({value: JSON.stringify([...notifications, ...newNotifs])});

  const updatedSchedule = schedule.map(s => stillValid.includes(s) ? {...s, sent: true} : s);
  await scheduleRef.set({value: JSON.stringify(updatedSchedule)});

  console.log(`[eventReminder] sent ${newNotifs.length} notification(s)`);
});

// ── Email-uniqueness enforcement (server-side) ─────────
// The old client-side check (findEmailMatchUser in App.jsx) re-scans the in-memory `users`
// array at the moment of sign-in using whatever JS bundle that specific device happens to be
// running — a stale client (an old cached browser tab, an old installed DEV APK never
// rebuilt) simply doesn't have the check at all and can create a duplicate profile no matter
// how correct the check itself is. Moving enforcement here closes that gap: every client, new
// or stale, ultimately calls this same always-current server function to resolve "who am I."
//
// emailIndex/{normalizedEmail} -> {userId} is the source of truth going forward. It starts
// empty (no bulk migration needed) and self-heals: the first time ANY existing user's email is
// looked up here and the index doesn't have it yet, this function falls back to scanning
// padelos/users (the exact same scan the old client check did) and backfills the index with
// whatever it finds — so coverage grows automatically as real people sign in, with no separate
// migration step required, and it's never worse than the old behavior even on a cold index.
//
// Two calls, matching the existing "Is this you?" UX (never auto-merge into an existing
// profile without the signed-in person explicitly confirming — see BUGS.md #17):
//   claimOrCreateProfile() — call on every sign-in with no existing link. Returns either
//     {status:"created", userId} (nothing more to do) or {status:"matched", userId, nickname,
//     avatar} (client shows the "Is this you?" prompt) or {status:"already-linked", userId}.
//   confirmEmailMatch({userId}) — call only after the user confirms "yes, that's me".
const normEmail = e => (e || "").toLowerCase().trim();

// Hard lock on the platform-owner/admin profile (userId 1) — see V0.11.49's CHANGELOG entry for
// the real incident this closes. Even with the silent auto-claim fallback removed from the
// client, the normal email-match path below is still a path that COULD in theory offer/link
// userId 1 to the wrong person if user 1's stored email were ever wrong (corrupted data, a
// future bug, a direct Firestore write bypassing the app). This is the actual, non-bypassable
// backstop: no matter what the stored email says, userId 1 can only ever be matched to or linked
// with THIS exact address. Update it here (and only here) if the real owner's email changes.
const PLATFORM_OWNER_USER_ID = 1;
const PLATFORM_OWNER_EMAIL = "ahmadkamalhammad@gmail.com";

exports.claimOrCreateProfile = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const email = normEmail(auth.token.email);
  if (!email) throw new HttpsError("failed-precondition", "This account has no email.");
  const uid = auth.uid;
  const displayName = auth.token.name || email.split("@")[0] || "Player";
  const photoURL = auth.token.picture || "";
  // Set only when the person already saw a match and explicitly said "that's not me" — skips
  // matching entirely so it can't just re-offer the same match again. Deliberately leaves
  // emailIndex untouched in that case (still pointing at whoever the real match was, if any),
  // so a genuine future sign-in by that person still resolves correctly.
  const forceNew = request.data?.forceNew === true;

  const db = getFirestore();
  const linkRef = db.collection("padelos_links").doc(uid);
  const emailIndexRef = db.collection("emailIndex").doc(email);
  const usersRef = db.collection("padelos").doc("users");

  return db.runTransaction(async (tx) => {
    const linkSnap = await tx.get(linkRef);
    if (linkSnap.exists) return {status: "already-linked", userId: linkSnap.data().userId};

    const usersSnap = await tx.get(usersRef);
    const users = JSON.parse(usersSnap.data()?.value || "[]");

    if (!forceNew) {
      const emailIdxSnap = await tx.get(emailIndexRef);
      let targetUserId = emailIdxSnap.exists ? emailIdxSnap.data().userId : null;
      if (targetUserId == null) {
        // Cold index for this email — fall back to a direct scan (self-healing backfill below).
        const linksSnap = await tx.get(db.collection("padelos_links"));
        const claimedIds = new Set(linksSnap.docs.map(d => d.data().userId));
        const match = users.find(u => normEmail(u.email) === email && !claimedIds.has(u.id));
        if (match) targetUserId = match.id;
      }

      // Hard lock: never even offer userId 1 as a match unless this really is the owner's own
      // email — see PLATFORM_OWNER_EMAIL above.
      if (targetUserId === PLATFORM_OWNER_USER_ID && email !== PLATFORM_OWNER_EMAIL) targetUserId = null;

      if (targetUserId != null) {
        const target = users.find(u => u.id === targetUserId);
        if (target) {
          tx.set(emailIndexRef, {userId: targetUserId}); // backfill, doesn't link yet
          return {status: "matched", userId: targetUserId, nickname: target.nickname || null, avatar: target.avatar || null, area: target.area || null};
        }
      }
    }

    // Genuinely new identity (or forceNew) — allocate the next id and create atomically.
    const newId = Math.max(0, ...users.map(u => u.id)) + 1;
    const newUser = {id: newId, email, photoURL, nickname: displayName, name: displayName, avatar: (displayName.slice(0, 2) || "PL").toUpperCase(), usr: 50, joined: new Date().toISOString().slice(0, 10), isGuest: false};
    tx.set(usersRef, {value: JSON.stringify([...users, newUser])});
    if (!forceNew) tx.set(emailIndexRef, {userId: newId});
    tx.set(linkRef, {userId: newId});
    return {status: "created", userId: newId};
  });
});

exports.confirmEmailMatch = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const userId = request.data?.userId;
  if (userId == null) throw new HttpsError("invalid-argument", "userId is required.");
  const uid = auth.uid;
  const email = normEmail(auth.token.email);
  const photoURL = auth.token.picture || "";

  const db = getFirestore();
  const linkRef = db.collection("padelos_links").doc(uid);
  const usersRef = db.collection("padelos").doc("users");
  const emailIndexRef = email ? db.collection("emailIndex").doc(email) : null;

  return db.runTransaction(async (tx) => {
    const linkSnap = await tx.get(linkRef);
    if (linkSnap.exists) return {status: "already-linked", userId: linkSnap.data().userId};
    // Hard lock: no matter what the client asked to confirm, userId 1 can never be linked to
    // anyone but the real owner's exact email. See PLATFORM_OWNER_EMAIL above.
    if (userId === PLATFORM_OWNER_USER_ID && email !== PLATFORM_OWNER_EMAIL) {
      throw new HttpsError("permission-denied", "This profile can't be claimed.");
    }
    const usersSnap = await tx.get(usersRef);
    const users = JSON.parse(usersSnap.data()?.value || "[]");
    const target = users.find(u => u.id === userId);
    if (!target) throw new HttpsError("not-found", "Target profile no longer exists.");
    const updated = users.map(u => u.id === userId ? {...u, email: email || u.email, photoURL: u.photoURL || photoURL} : u);
    tx.set(usersRef, {value: JSON.stringify(updated)});
    tx.set(linkRef, {userId});
    if (emailIndexRef) tx.set(emailIndexRef, {userId});
    return {status: "linked", userId};
  });
});

// Shared by registerForEvent/addMemberToEvent/approveEventJoinRequest below — a deliberate
// line-for-line port of getMaxPlayers/isPriorityReg/splitRegsByCapacity from src/App.jsx. Keep
// them in sync if that logic ever changes there. Duplicated rather than shared because this
// runs in a separate Node/CommonJS runtime from the client's Vite/JSX bundle; a real
// shared-module setup is more invasive than these fixes warranted.
const getMaxPlayers = e => (e?.maxPlayers > 0 ? e.maxPlayers : null);
const isPriorityReg = (r, c) => {
  if (r.addedBy != null && r.addedBy !== "approved") return true;
  return c?.members?.find(m => m.userId === r.userId)?.status === "regular";
};
const splitRegsByCapacity = (e, c) => {
  const max = getMaxPlayers(e);
  if (!max) return {active: e.registrations, waitlisted: []};
  const windowActive = e?.regularUntil && Date.now() < new Date(e.regularUntil).getTime();
  if (!windowActive || !c) return {active: e.registrations.slice(0, max), waitlisted: e.registrations.slice(max)};
  const active = [], waitlisted = [];
  e.registrations.forEach(r => {
    if (isPriorityReg(r, c) && active.length < max) active.push(r);
    else waitlisted.push(r);
  });
  return {active, waitlisted};
};
// Phase 2 (registrations split): each registration is its own document at
// padelos_events/{eventId}/registrations/{userId} instead of an array entry on the event doc —
// see PLAN. Active-vs-waitlisted is never decided or stored here (splitRegsByCapacity above
// always recomputes it live), so the write side below only ever needs to durably record "this
// person registered" inside a LIGHTWEIGHT transaction that reads just the event doc (status/
// pause guard) + this user's own registration doc — never any sibling registration. Concurrent
// registrants to the same event read the same event doc (never write it) and each write only
// their own distinct registration doc, so they never contend with each other; only a genuinely
// concurrent WRITE to the event doc itself (an admin closing/pausing it) can invalidate one of
// these transactions — exactly the case that should be rejected. This is what actually removes
// the contention this function used to serialize on (it used to tx.set() the whole event doc on
// every single registration).
//
// Waitlist position for the response (used only for the confirmation toast) is computed by a
// SEPARATE, plain, non-transactional read done AFTER the write commits — informational only,
// never enforced, so a race here only affects what number is displayed, never who's actually
// active vs waitlisted (that's still purely derived, recomputed correctly everywhere, always).
const computeWaitlistInfo = async (db, communityId, eventId, userId) => {
  const [commSnap, evSnap, regsSnap] = await Promise.all([
    db.collection("padelos_communities").doc(String(communityId)).get(),
    db.collection("padelos_events").doc(String(eventId)).get(),
    db.collection("padelos_events").doc(String(eventId)).collection("registrations").get(),
  ]);
  const comm = commSnap.exists ? commSnap.data() : null;
  const ev = evSnap.exists ? evSnap.data() : {};
  const registrations = regsSnap.docs.map(d => d.data()).sort((a, b) => {
    if (a.registeredAt !== b.registeredAt) return a.registeredAt < b.registeredAt ? -1 : 1;
    return String(a.userId).localeCompare(String(b.userId));
  });
  const {waitlisted: waitlistArr} = splitRegsByCapacity({...ev, registrations}, comm);
  const onIt = waitlistArr.some(r => r.userId === userId);
  return {waitlisted: onIt, pos: onIt ? waitlistArr.length : 0};
};

// registerForEvent — same "close the stale-client gap" reasoning as claimOrCreateProfile above,
// applied to event registration instead of profile identity. Real incident that motivated this
// (2026-08-27, event #55 "Thursday trial"): the admin's "pause registration" toggle only ever
// hid the client's "I'm In" button — the actual write functions had no server-side awareness of
// it, so an already-loaded tab or an old Android APK (confirmed live: V0.10.24, several minor
// versions behind) could still write a registration straight through a pause. A client-side fix
// closes it for anyone running current code, but a client that predates the fix has no way to
// know to apply it. This function is the actual backstop: it re-validates event status AND the
// pause flag itself, from the live server data, inside the same transaction as the write, so
// the result is correct regardless of what the calling client's own code thinks is true.
//
// Client usage (see src/App.jsx's registerEv/registerViaInvite): call this first; on ANY
// failure (including plain unavailability — padelos-dev has no functions deployed, matching
// claimOrCreateProfile's own fallback story) fall back to the existing direct client-side write.
// That fallback path is NOT a regression — it already carries the same registrationOpen check
// client-side (see registerEv's own guard) — this function is a strictly-additional layer for
// clients recent enough to know to call it, not a replacement for that check.
//
exports.registerForEvent = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const {communityId, eventId, via} = request.data || {};
  if (communityId == null || eventId == null) {
    throw new HttpsError("invalid-argument", "communityId and eventId are required.");
  }

  const db = getFirestore();
  const linkRef = db.collection("padelos_links").doc(auth.uid);
  const linkSnap = await linkRef.get();
  if (!linkSnap.exists) throw new HttpsError("failed-precondition", "No linked player profile for this account yet.");
  const userId = linkSnap.data().userId;

  const evRef = db.collection("padelos_events").doc(String(eventId));
  const commRef = db.collection("padelos_communities").doc(String(communityId));
  const regRef = evRef.collection("registrations").doc(String(userId));

  const {alreadyRegistered, eventName} = await db.runTransaction(async (tx) => {
    const evSnap = await tx.get(evRef);
    if (!evSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const ev = evSnap.data();
    if (ev.status === "completed" || ev.status === "cancelled") {
      throw new HttpsError("failed-precondition", via === "invite"
        ? "This event has already ended — the invite link is no longer valid."
        : "This event is closed — registration is no longer open.");
    }
    if (ev.registrationOpen === false) {
      throw new HttpsError("failed-precondition", "Registration is currently paused for this event — check back later.");
    }
    const regSnap = await tx.get(regRef);
    if (regSnap.exists) return {alreadyRegistered: true, eventName: ev.name};

    // Matches registerViaInvite's own side effect: an invite link also grants guest-tier
    // community membership, not just the event registration, if they aren't a member yet — read
    // + written in this same transaction so a crash between the two can never leave a
    // registration without its matching membership (same reasoning as the client's
    // registerWithMembership).
    let comm = null;
    if (via === "invite") {
      const commSnap = await tx.get(commRef);
      if (!commSnap.exists) throw new HttpsError("not-found", "Community not found.");
      comm = commSnap.data();
    }

    const addedBy = via === "invite" ? "invite" : null;
    const newReg = {userId, eventId, registeredAt: new Date().toISOString(), status: "registered", addedBy, isGuest: false};
    tx.set(regRef, newReg);
    if (via === "invite" && !comm.members.some(m => m.userId === userId)) {
      tx.set(commRef, {...comm, members: [...comm.members, {userId, role: "member", status: "guest", since: new Date().toISOString().slice(0, 10)}]});
    }

    return {alreadyRegistered: false, eventName: ev.name};
  });

  if (alreadyRegistered) return {status: "already-registered", waitlisted: false, eventName};
  const {waitlisted, pos} = await computeWaitlistInfo(db, communityId, eventId, userId);
  return {status: "ok", waitlisted, pos, eventName};
});

// addMemberToEvent / approveEventJoinRequest — same server-side backstop as registerForEvent,
// applied to the two admin-initiated registration paths (src/App.jsx's addMember and
// approveEventJoin). These don't check registrationOpen — pausing registration is meant to stop
// random public self-service, not the admin's own deliberate management, so an admin adding or
// approving someone specific stays allowed while paused, matching existing behavior exactly.
// What this DOES re-validate server-side is event status (completed/cancelled), same as
// registerForEvent — a stale client could otherwise silently add someone to a book-closed event.
// Note: like every other write in this app, these don't verify the CALLER is actually an admin
// of this community/event — that trust boundary is enforced client-side only today (the button
// itself is hidden for non-admins), same as it already was before this function existed. Adding
// real server-side role verification is a separate, larger piece of work (would need to extend
// to every other write in the app to be meaningful) — out of scope for what these two close.
exports.addMemberToEvent = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const {communityId, eventId, targetUserId} = request.data || {};
  if (communityId == null || eventId == null || targetUserId == null) {
    throw new HttpsError("invalid-argument", "communityId, eventId and targetUserId are required.");
  }

  const db = getFirestore();
  const evRef = db.collection("padelos_events").doc(String(eventId));
  const regRef = evRef.collection("registrations").doc(String(targetUserId));

  const {alreadyRegistered, eventName} = await db.runTransaction(async (tx) => {
    const evSnap = await tx.get(evRef);
    if (!evSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const ev = evSnap.data();
    if (ev.status === "completed" || ev.status === "cancelled") {
      throw new HttpsError("failed-precondition", "This event is closed — can't add players anymore.");
    }
    const regSnap = await tx.get(regRef);
    if (regSnap.exists) return {alreadyRegistered: true, eventName: ev.name};

    const newReg = {userId: targetUserId, eventId, registeredAt: new Date().toISOString(), status: "registered", addedBy: "admin", isGuest: false};
    tx.set(regRef, newReg);
    return {alreadyRegistered: false, eventName: ev.name};
  });

  if (alreadyRegistered) return {status: "already-registered", waitlisted: false, eventName};
  const {waitlisted} = await computeWaitlistInfo(db, communityId, eventId, targetUserId);
  return {status: "ok", waitlisted, eventName};
});
exports.approveEventJoinRequest = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Must be signed in.");
  const {communityId, eventId, targetUserId} = request.data || {};
  if (communityId == null || eventId == null || targetUserId == null) {
    throw new HttpsError("invalid-argument", "communityId, eventId and targetUserId are required.");
  }

  const db = getFirestore();
  const evRef = db.collection("padelos_events").doc(String(eventId));
  const regRef = evRef.collection("registrations").doc(String(targetUserId));

  const {eventName} = await db.runTransaction(async (tx) => {
    const evSnap = await tx.get(evRef);
    if (!evSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const ev = evSnap.data();
    if (ev.status === "completed" || ev.status === "cancelled") {
      throw new HttpsError("failed-precondition", "This event is closed — the request can't be approved anymore.");
    }
    const regSnap = await tx.get(regRef);
    const newJoinRequests = (ev.joinRequests || []).filter(r => r.userId !== targetUserId);
    tx.set(evRef, {...ev, joinRequests: newJoinRequests});
    if (!regSnap.exists) {
      const newReg = {userId: targetUserId, eventId, registeredAt: new Date().toISOString(), status: "registered", addedBy: "approved", isGuest: false};
      tx.set(regRef, newReg);
    }
    return {eventName: ev.name};
  });

  const {waitlisted} = await computeWaitlistInfo(db, communityId, eventId, targetUserId);
  return {status: "ok", waitlisted, eventName};
});
