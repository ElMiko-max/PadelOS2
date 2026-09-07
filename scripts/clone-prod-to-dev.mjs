// One-off: clones real PRODUCTION data onto padelos-dev so the confirmOrder backfill (and its
// fix, V0.15.06/07) can be validated against real events/registrations/communities/players in
// the live DEV app, with zero risk to production — production is only ever read here, never
// written. This intentionally goes further than the in-app "Clone Data to DEV" Platform Admin
// button (App.jsx cloneToDev, ~line 5332), which only pushes the legacy padelos/{comms,users,...}
// singleton docs and doesn't touch padelos_events/padelos_communities at all (pre-dates the
// Phase 2 split) — this script clones the real, current data model.
//
// DEV's padelos_events (+ their registrations subcollections) and padelos_communities are fully
// WIPED and replaced with production's, so DEV ends up an exact mirror, not a merge with
// whatever test events were there before (2026-09-06: event #207 and other same-session test
// events). The padelos/* singleton docs (users, venues, etc.) are overwritten but not deleted
// beyond what already matches production's own doc list.
//
// Usage: node scripts/clone-prod-to-dev.mjs

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const secretsDir = join(process.cwd(), "secrets");
function loadApp(name, projectSubstr) {
  const keyFile = readdirSync(secretsDir).find(f => f.includes(projectSubstr) && f.includes("firebase-adminsdk") && f.endsWith(".json"));
  if (!keyFile) { console.error(`No ${projectSubstr} key found in ${secretsDir}`); process.exit(1); }
  const serviceAccount = JSON.parse(readFileSync(join(secretsDir, keyFile), "utf8"));
  const app = initializeApp({ credential: cert(serviceAccount) }, name);
  return { app, db: getFirestore(app), projectId: serviceAccount.project_id };
}

const prod = loadApp("prod", "padelos-6f999");
const dev = loadApp("dev", "padelos-dev");
if (prod.projectId !== "padelos-6f999") { console.error(`prod key resolved to "${prod.projectId}", refusing.`); process.exit(1); }
if (dev.projectId !== "padelos-dev") { console.error(`dev key resolved to "${dev.projectId}", refusing.`); process.exit(1); }

async function deleteCollectionDeep(db, colRef) {
  const snap = await colRef.get();
  for (const d of snap.docs) {
    const subcols = await d.ref.listCollections();
    for (const sub of subcols) await deleteCollectionDeep(db, sub);
  }
  let batch = db.batch(), n = 0;
  for (const d of snap.docs) { batch.delete(d.ref); n++; if (n % 450 === 0) { await batch.commit(); batch = db.batch(); } }
  if (n % 450 !== 0 || n === 0) await batch.commit();
  return snap.size;
}

async function main() {
  console.log("Reading production...");
  const [padelosSnap, eventsSnap, commsSnap] = await Promise.all([
    prod.db.collection("padelos").get(),
    prod.db.collection("padelos_events").get(),
    prod.db.collection("padelos_communities").get(),
  ]);
  const eventsWithRegs = [];
  for (const evDoc of eventsSnap.docs) {
    const regsSnap = await evDoc.ref.collection("registrations").get();
    eventsWithRegs.push({ id: evDoc.id, data: evDoc.data(), regs: regsSnap.docs.map(r => ({ id: r.id, data: r.data() })) });
  }
  console.log(`Read: ${padelosSnap.size} padelos/* doc(s), ${eventsWithRegs.length} event(s) (${eventsWithRegs.reduce((s,e)=>s+e.regs.length,0)} registration(s) total), ${commsSnap.size} communit(y/ies).`);

  console.log("Wiping DEV's padelos_events (+ registrations) and padelos_communities...");
  const deletedEvents = await deleteCollectionDeep(dev.db, dev.db.collection("padelos_events"));
  const deletedComms = await deleteCollectionDeep(dev.db, dev.db.collection("padelos_communities"));
  console.log(`Deleted ${deletedEvents} old DEV event doc(s), ${deletedComms} old DEV community doc(s).`);

  console.log("Writing production data to DEV...");
  let batch = dev.db.batch(), n = 0;
  const flush = async () => { await batch.commit(); batch = dev.db.batch(); n = 0; };

  for (const d of padelosSnap.docs) { batch.set(dev.db.collection("padelos").doc(d.id), d.data()); n++; if (n>=450) await flush(); }
  for (const c of commsSnap.docs) { batch.set(dev.db.collection("padelos_communities").doc(c.id), c.data()); n++; if (n>=450) await flush(); }
  for (const ev of eventsWithRegs) {
    batch.set(dev.db.collection("padelos_events").doc(ev.id), ev.data); n++; if (n>=450) await flush();
    for (const r of ev.regs) { batch.set(dev.db.collection("padelos_events").doc(ev.id).collection("registrations").doc(r.id), r.data); n++; if (n>=450) await flush(); }
  }
  if (n>0) await flush();

  console.log(`Done — DEV now mirrors production: ${padelosSnap.size} padelos/* doc(s), ${commsSnap.size} communit(y/ies), ${eventsWithRegs.length} event(s), ${eventsWithRegs.reduce((s,e)=>s+e.regs.length,0)} registration(s).`);
}

main().then(()=>process.exit(0)).catch(e=>{ console.error(e); process.exit(1); });
