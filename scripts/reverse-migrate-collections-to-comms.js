// Rollback safety net for the comms-split migration (see PLAN's rollback section). Reads
// padelos_communities + padelos_events and reconstructs the old padelos/comms blob shape,
// writing it back over the (untouched-until-now) original document. Run this BEFORE redeploying
// old app code if a rollback is ever needed after some period of live cutover — otherwise
// anything written only to the new collections during that window would be invisible to the old
// code once it's back.
//
// Defaults to a DRY RUN (prints exactly what it would do, writes nothing) — pass --write to
// actually commit. Always prints which Firestore project the key belongs to before doing
// anything.
//
// Usage:
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\key.json" node scripts/reverse-migrate-collections-to-comms.js
//   PADELOS_MIGRATE_ADMIN_KEY="C:\path\to\key.json" node scripts/reverse-migrate-collections-to-comms.js --write

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
  const [communitiesSnap, eventsSnap] = await Promise.all([
    db.collection("padelos_communities").get(),
    db.collection("padelos_events").get(),
  ]);
  const communities = communitiesSnap.docs.map(d => d.data());
  // `plan` is stored as an opaque JSON string on padelos_events documents (Firestore can't hold
  // the bare array-of-arrays in ev.plan.breakPlan directly) — unpack it back to a real object,
  // matching src/App.jsx's unpackEventFromFirestore exactly, since the old blob shape always had
  // `plan` as an object.
  const events = eventsSnap.docs.map(d => {
    const data = d.data();
    return { ...data, plan: typeof data.plan === "string" ? JSON.parse(data.plan) : data.plan };
  });
  console.log(`Found ${communities.length} communities, ${events.length} events in the split collections.`);

  // Events already carry `communityId` in both the old and new shapes (createEvent always set it,
  // even before this migration) — no field stripping needed, just re-nesting.
  const comms = communities.map(c => ({
    ...c,
    events: events.filter(e => e.communityId === c.id),
  }));

  if (!write) {
    console.log(`\nWould overwrite padelos/comms with ${comms.length} communit${comms.length===1?"y":"ies"} (${events.length} event(s) total). Re-run with --write to commit.`);
    return;
  }
  await db.collection("padelos").doc("comms").set({ value: JSON.stringify(comms) });
  console.log(`\n\u2713 padelos/comms reconstructed from the split collections. Old app code will now see everything, including anything written only to the new collections during cutover.`);
}

main().catch(e => { console.error(e); process.exit(1); });
