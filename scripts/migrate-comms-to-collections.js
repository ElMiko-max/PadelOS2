// One-shot migration (comms-split, see PLAN): reads the old padelos/comms blob and writes out
// padelos_communities/{id} + padelos_events/{id} documents, split per community/event. NEVER
// touches or deletes the original padelos/comms document — that document staying exactly as it
// was is the rollback path (see reverse-migrate-collections-to-comms.js for restoring it if a
// rollback is ever needed after some period of live cutover).
//
// Defaults to a DRY RUN (prints exactly what it would do, writes nothing) — pass --write to
// actually commit. Always prints which Firestore project the key belongs to before doing
// anything, so it's never ambiguous whether a run is about to touch padelos-dev or production.
//
// Usage:
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\key.json" node scripts/migrate-comms-to-collections.js
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\key.json" node scripts/migrate-comms-to-collections.js --write

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
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const write = process.argv.includes("--write");
if (!write) console.log("DRY RUN — pass --write to actually commit changes.\n");

async function main() {
  const commsSnap = await db.collection("padelos").doc("comms").get();
  if (!commsSnap.exists) { console.error("padelos/comms does not exist — nothing to migrate."); process.exit(1); }
  const raw = commsSnap.data().value;
  const comms = typeof raw === "string" ? JSON.parse(raw) : raw;

  const communities = comms.map(({ events, ...c }) => c);
  const events = comms.flatMap(c => (c.events || []).map(ev => ({ ...ev, communityId: c.id })));

  console.log(`Found ${communities.length} communities, ${events.length} events in padelos/comms.`);

  // Always upserts by id, so re-running is technically idempotent — but a mismatched pre-existing
  // count is worth surfacing before committing, in case this is being run a second time by
  // accident against a collection that already has real (possibly newer) data in it.
  const [existingCommsSnap, existingEventsSnap] = await Promise.all([
    db.collection("padelos_communities").get(),
    db.collection("padelos_events").get(),
  ]);
  if (existingCommsSnap.size > 0 || existingEventsSnap.size > 0) {
    console.log(`\u26a0\ufe0f  padelos_communities already has ${existingCommsSnap.size} doc(s), padelos_events already has ${existingEventsSnap.size} doc(s) — this run will overwrite matching ids and leave any others as they are.`);
  }

  if (!write) {
    console.log("\nWould write:");
    communities.forEach(c => console.log(`  padelos_communities/${c.id} — "${c.name}"`));
    events.forEach(e => console.log(`  padelos_events/${e.id} — "${e.name}" (community ${e.communityId})`));
    console.log(`\n${communities.length + events.length} total document(s). Re-run with --write to commit.`);
    return;
  }

  // Firestore documents can't hold a bare array-of-arrays (no wrapping object) — ev.plan.breakPlan
  // is exactly that shape (one array of user ids per round). Stored as an opaque JSON string on
  // the event document instead; src/App.jsx's packEventForFirestore/unpackEventFromFirestore do
  // the same pack/unpack at every read and write, so this must match exactly.
  const packEvent = (e) => JSON.parse(JSON.stringify({ ...e, plan: e.plan ? JSON.stringify(e.plan) : e.plan }));
  const all = [
    ...communities.map(c => ({ col: "padelos_communities", id: c.id, data: c })),
    ...events.map(e => ({ col: "padelos_events", id: e.id, data: packEvent(e) })),
  ];
  for (let i = 0; i < all.length; i += 450) {
    const chunk = all.slice(i, i + 450);
    const batch = db.batch();
    chunk.forEach(u => batch.set(db.collection(u.col).doc(String(u.id)), JSON.parse(JSON.stringify(u.data))));
    await batch.commit();
    console.log(`Committed ${Math.min(i + 450, all.length)}/${all.length}...`);
  }
  console.log(`\n\u2713 Migration complete. padelos/comms was NOT modified — it's still there as the rollback source.`);
}

main().catch(e => { console.error(e); process.exit(1); });
