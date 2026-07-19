const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
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

  const commsSnap = await db.collection("padelos").doc("comms").get();
  const comms = commsSnap.exists ? JSON.parse(commsSnap.data().value || "[]") : [];

  const notifRef = db.collection("padelos").doc("notifications");
  const notifSnap = await notifRef.get();
  const notifications = notifSnap.exists ? JSON.parse(notifSnap.data().value || "[]") : [];

  const labelMap = {"24h": "tomorrow", "3h": "in 3 hours", "1h": "in 1 hour"};
  const newNotifs = [];
  const stillValid = []; // reminders we could actually process (event found) — used to mark sent

  for (const s of due) {
    const comm = comms.find(c => c.id === s.communityId);
    const ev = comm?.events?.find(e => e.id === s.eventId);
    if (!ev || ev.status === "cancelled") {
      console.log(`[eventReminder] skipping ${s.id}: event not found or cancelled`);
      stillValid.push(s);
      continue;
    }
    const userIds = (ev.registrations || []).map(r => r.userId);
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
