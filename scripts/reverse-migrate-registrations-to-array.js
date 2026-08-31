// Rollback safety net for the Phase 2 registrations-split migration (see PLAN's rollback
// section). Reads every padelos_events/{eventId}/registrations/{userId} document (via a
// collectionGroup query) and writes them back into each event doc's `.registrations` array
// field, overwriting whatever is currently there. Run this BEFORE redeploying old (pre-Phase-2)
// app code if a rollback is ever needed after some period of live cutover — otherwise anything
// registered only via the subcollection during that window would be invisible to the old code
// once it's back.
//
// Defaults to a DRY RUN (prints exactly what it would do, writes nothing) — pass --write to
// actually commit. Always prints which Firestore project the key belongs to before doing
// anything.
//
// Usage:
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\key.json" node scripts/reverse-migrate-registrations-to-array.js
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\key.json" node scripts/reverse-migrate-registrations-to-array.js --write

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
  const [eventsSnap, regsSnap] = await Promise.all([
    db.collection("padelos_events").get(),
    db.collectionGroup("registrations").get(),
  ]);
  console.log(`Found ${eventsSnap.size} events, ${regsSnap.size} registration documents in the subcollection.`);

  const regsByEvent = {};
  regsSnap.docs.forEach(d => {
    const eventId = d.ref.parent.parent.id;
    const { eventId: _drop, ...reg } = d.data(); // eventId is redundant with the path — don't put it back on the array entry, the old shape never had it
    (regsByEvent[eventId] = regsByEvent[eventId] || []).push(reg);
  });
  Object.values(regsByEvent).forEach(regs => regs.sort((a, b) => {
    if (a.registeredAt !== b.registeredAt) return a.registeredAt < b.registeredAt ? -1 : 1;
    return String(a.userId).localeCompare(String(b.userId));
  }));

  const updates = eventsSnap.docs.map(d => ({ id: d.id, registrations: regsByEvent[d.id] || [] }));

  if (!write) {
    console.log("\nWould overwrite `.registrations` on:");
    updates.forEach(u => console.log(`  padelos_events/${u.id} — ${u.registrations.length} registration(s)`));
    console.log(`\n${updates.length} event document(s). Re-run with --write to commit.`);
    return;
  }

  for (let i = 0; i < updates.length; i += 450) {
    const chunk = updates.slice(i, i + 450);
    const batch = db.batch();
    chunk.forEach(u => batch.update(db.collection("padelos_events").doc(String(u.id)), { registrations: u.registrations }));
    await batch.commit();
    console.log(`Committed ${Math.min(i + 450, updates.length)}/${updates.length}...`);
  }
  console.log(`\n\u2713 Every event's \`.registrations\` array field reconstructed from the subcollection. Old (pre-Phase-2) app code will now see everything, including anything registered only via the subcollection during cutover.`);
}

main().catch(e => { console.error(e); process.exit(1); });
