// Burst test for Phase 2 (registrations split — see PLAN). Fires N truly concurrent registration
// writes against one freshly-created, capacity-limited throwaway event, using the exact
// lightweight-transaction shape both the client's registerInEvent and the registerForEvent Cloud
// Function share: read the event doc (status/pause guard) + this user's own registration doc
// (existence check), write only that one new registration doc. This is the direct re-run of the
// concurrency test that originally motivated this migration — the pre-Phase-2 array-based design
// measured a ~39s worst-case latency under this exact 50-concurrent/15-cap scenario (zero data
// loss, but that latency was the actual problem).
//
// Confirms: (1) latency stays low under real concurrency, (2) zero registrations lost, (3) the
// capacity/waitlist split computed from the result is exactly correct.
//
// Creates its own throwaway test event (never touches any real event/community) and deletes it +
// its registrations when done — pass --keep to leave it in place for inspection.
//
// Refuses to run against production — this creates and deletes real documents, meant for
// padelos-dev only.
//
// Usage:
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\dev-key.json" node scripts/burst-test-registrations.js
//   PADELOS_MIGRATE_ADMIN_KEY="...\dev-key.json" node scripts/burst-test-registrations.js --n 50 --cap 15
//   PADELOS_MIGRATE_ADMIN_KEY="...\dev-key.json" node scripts/burst-test-registrations.js --keep

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const keyPath = process.env.PADELOS_MIGRATE_ADMIN_KEY;
if (!keyPath) {
  console.error("Set PADELOS_MIGRATE_ADMIN_KEY to the absolute path of a service account key JSON file with Firestore write access.");
  process.exit(1);
}
const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
console.log(`Target project: ${serviceAccount.project_id}`);
if (serviceAccount.project_id !== "padelos-dev") {
  console.error(`Refusing to run — this key belongs to project "${serviceAccount.project_id}". This test creates/deletes real documents and only ever runs against padelos-dev.`);
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const args = process.argv.slice(2);
const flagValue = (name, fallback) => { const i = args.indexOf(name); return i !== -1 ? parseInt(args[i + 1], 10) : fallback; };
const n = flagValue("--n", 50);
const cap = flagValue("--cap", 15);
const keep = args.includes("--keep");

// Deliberate line-for-line match with splitRegsByCapacity's non-priority-window branch
// (src/App.jsx ~line 492) — this test event has no regularUntil, so that's the only branch that
// applies.
const splitRegsByCapacity = (registrations, maxPlayers) => ({
  active: registrations.slice(0, maxPlayers),
  waitlisted: registrations.slice(maxPlayers),
});

async function main() {
  const testEventId = 900000 + Math.floor(Math.random() * 99999);
  const evRef = db.collection("padelos_events").doc(String(testEventId));
  console.log(`Creating throwaway test event ${testEventId} (maxPlayers=${cap})...`);
  await evRef.set({
    id: testEventId, communityId: 999999, name: "BURST TEST — safe to delete", sport: "Padel",
    status: "registration_open", registrationOpen: true, maxPlayers: cap,
    date: new Date().toISOString().slice(0, 10), time: "20:00",
    createdBy: 1, plan: null, checkedIn: [], regularUntil: null,
  });

  // Clearly out-of-range fake user ids — can't collide with any real user in this project.
  const userIds = Array.from({ length: n }, (_, i) => 9000000 + i);
  console.log(`Firing ${n} truly concurrent registrations against it...`);

  const results = await Promise.all(userIds.map(async (userId) => {
    const t0 = Date.now();
    const regRef = evRef.collection("registrations").doc(String(userId));
    try {
      await db.runTransaction(async (tx) => {
        const evSnap = await tx.get(evRef);
        const ev = evSnap.data();
        if (ev.status === "completed" || ev.status === "cancelled") throw new Error("closed");
        if (ev.registrationOpen === false) throw new Error("paused");
        const regSnap = await tx.get(regRef);
        if (regSnap.exists) return;
        tx.set(regRef, { userId, eventId: testEventId, registeredAt: new Date().toISOString(), status: "registered", addedBy: null, isGuest: false });
      }, { maxAttempts: 30 });
      return { userId, ms: Date.now() - t0, ok: true };
    } catch (e) {
      return { userId, ms: Date.now() - t0, ok: false, error: e.message };
    }
  }));

  const failed = results.filter(r => !r.ok);
  const latencies = results.map(r => r.ms).sort((a, b) => a - b);
  const worst = latencies[latencies.length - 1];
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  console.log(`\nResults: ${results.length - failed.length}/${n} transactions succeeded, ${failed.length} failed.`);
  console.log(`Latency — best: ${latencies[0]}ms, p50: ${p50}ms, worst: ${worst}ms`);
  if (failed.length) console.log("Failures:", failed);

  const regsSnap = await evRef.collection("registrations").get();
  console.log(`\nRegistration documents actually present: ${regsSnap.size} (expected ${n})`);
  const registrations = regsSnap.docs.map(d => d.data()).sort((a, b) => a.registeredAt !== b.registeredAt ? (a.registeredAt < b.registeredAt ? -1 : 1) : String(a.userId).localeCompare(String(b.userId)));
  const { active, waitlisted } = splitRegsByCapacity(registrations, cap);
  const expectedActive = Math.min(n, cap), expectedWaitlisted = Math.max(0, n - cap);
  console.log(`Capacity split: ${active.length} active / ${waitlisted.length} waitlisted (expected ${expectedActive} / ${expectedWaitlisted})`);

  const noLoss = regsSnap.size === n;
  const splitCorrect = active.length === expectedActive && waitlisted.length === expectedWaitlisted;
  const zeroFailures = failed.length === 0;
  console.log(`\n${noLoss && splitCorrect && zeroFailures ? "\u2713 PASS" : "\u2717 FAIL"} — zero loss: ${noLoss}, correct split: ${splitCorrect}, zero transaction failures: ${zeroFailures}`);

  if (!keep) {
    console.log("\nCleaning up test event and its registrations...");
    const delBatch = db.batch();
    regsSnap.docs.forEach(d => delBatch.delete(d.ref));
    delBatch.delete(evRef);
    await delBatch.commit();
    console.log("\u2713 Cleaned up.");
  } else {
    console.log(`\n--keep passed — test event ${testEventId} left in place for inspection.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
