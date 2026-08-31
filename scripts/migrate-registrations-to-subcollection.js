// One-shot migration (Phase 2, registrations split — see PLAN): reads each padelos_events
// document's `.registrations` array field and writes out
// padelos_events/{eventId}/registrations/{userId} documents, one per registration. NEVER deletes
// or modifies the `.registrations` array field on the event doc — that field staying exactly as
// it was is the rollback path (see reverse-migrate-registrations-to-array.js for restoring it
// from the subcollection if a rollback is ever needed after some period of live cutover).
//
// Defaults to a DRY RUN (prints exactly what it would do, writes nothing) — pass --write to
// actually commit. Always prints which Firestore project the key belongs to before doing
// anything, so it's never ambiguous whether a run is about to touch padelos-dev or production.
//
// Usage:
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\key.json" node scripts/migrate-registrations-to-subcollection.js
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\key.json" node scripts/migrate-registrations-to-subcollection.js --write

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
  const eventsSnap = await db.collection("padelos_events").get();
  if (eventsSnap.empty) { console.error("padelos_events is empty — nothing to migrate (has the comms-split migration run yet?)."); process.exit(1); }

  const registrations = [];
  eventsSnap.docs.forEach(d => {
    const ev = d.data();
    (ev.registrations || []).forEach(r => registrations.push({ eventId: ev.id, userId: r.userId, data: { ...r, eventId: ev.id } }));
  });

  console.log(`Found ${eventsSnap.size} events, ${registrations.length} registrations total across them.`);

  // Always upserts by (eventId,userId), so re-running is technically idempotent — but a
  // mismatched pre-existing count is worth surfacing before committing, same reasoning as the
  // comms-split migration script.
  const existingRegsSnap = await db.collectionGroup("registrations").get();
  if (existingRegsSnap.size > 0) {
    console.log(`\u26a0\ufe0f  The registrations subcollection already has ${existingRegsSnap.size} doc(s) — this run will overwrite matching (eventId,userId) pairs and leave any others as they are.`);
  }

  if (!write) {
    console.log("\nWould write:");
    registrations.forEach(r => console.log(`  padelos_events/${r.eventId}/registrations/${r.userId}`));
    console.log(`\n${registrations.length} total document(s). Re-run with --write to commit.`);
    console.log("\nNote: the `.registrations` array field on each event doc is left untouched — it stays as the rollback source until this migration is confirmed stable in production.");
    return;
  }

  for (let i = 0; i < registrations.length; i += 450) {
    const chunk = registrations.slice(i, i + 450);
    const batch = db.batch();
    chunk.forEach(r => batch.set(db.collection("padelos_events").doc(String(r.eventId)).collection("registrations").doc(String(r.userId)), JSON.parse(JSON.stringify(r.data))));
    await batch.commit();
    console.log(`Committed ${Math.min(i + 450, registrations.length)}/${registrations.length}...`);
  }
  console.log(`\n\u2713 Migration complete. Each event's \`.registrations\` array field was NOT modified — it's still there as the rollback source.`);
}

main().catch(e => { console.error(e); process.exit(1); });
