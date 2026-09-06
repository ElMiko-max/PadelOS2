// One-off backfill for the confirmOrder feature (BUGS.md #18 follow-up, 2026-09-06): stamps a
// permanent, dense, per-event seat number onto every registration doc that's currently
// CONFIRMED (active per splitRegsByCapacity) but doesn't have one yet. Idempotent — skips
// anything already numbered, so it's safe to re-run.
//
// Writes a full pre-write backup of every registration doc it's about to touch to backups/
// BEFORE making any changes — that file is the rollback point. Restore with --restore.
//
// --repair fixes an over-capacity confirmation (BUGS.md #18, found live 2026-09-06 hours after
// this shipped): a short-lived gap in splitRegsByCapacity let an admin-added registrant get
// confirmed even when an event was already at maxPlayers. For any event where confirmed count >
// maxPlayers, clears confirmOrder on the excess (highest confirmOrder values, kept dense for
// the rest) so they fall back to waitlisted — same pre-write backup/rollback convention.
//
// Usage:
//   node scripts/backfill-confirm-order.mjs --project dev
//   node scripts/backfill-confirm-order.mjs --project prod
//   node scripts/backfill-confirm-order.mjs --repair --project dev
//   node scripts/backfill-confirm-order.mjs --restore backups/confirm-order-backfill-dev-2026-09-06T12-00-00-000Z.json --project dev
//
// Safety: hard-refuses to run if the loaded service-account key's project_id doesn't exactly
// match the --project you asked for, same convention as scripts/dev-admin.js.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const secretsDir = join(__dirname, "..", "secrets");
const backupsDir = join(__dirname, "..", "backups");

const args = process.argv.slice(2);
const projectArg = args[args.indexOf("--project")+1];
const restoreArg = args.includes("--restore") ? args[args.indexOf("--restore")+1] : null;
const repairMode = args.includes("--repair");

if (!projectArg || !["dev","prod"].includes(projectArg)) {
  console.error("Usage: node scripts/backfill-confirm-order.mjs --project dev|prod [--restore <backup-file>]");
  process.exit(1);
}
const expectedProjectId = projectArg==="prod" ? "padelos-6f999" : "padelos-dev";

function resolveKeyPath() {
  const candidates = readdirSync(secretsDir).filter(f => f.includes(expectedProjectId) && f.includes("firebase-adminsdk") && f.endsWith(".json"));
  if (candidates.length !== 1) { console.error(`Expected exactly one ${expectedProjectId} firebase-adminsdk key in ${secretsDir}:`, candidates); process.exit(1); }
  return join(secretsDir, candidates[0]);
}
const serviceAccount = JSON.parse(readFileSync(resolveKeyPath(), "utf8"));
if (serviceAccount.project_id !== expectedProjectId) {
  console.error(`Refusing — key belongs to "${serviceAccount.project_id}", not "${expectedProjectId}" (--project ${projectArg}).`);
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Exact copies of App.jsx's isPriorityReg / splitRegsByCapacity (App.jsx:482-528) ──
const getMaxPlayers = ev => (ev?.maxPlayers>0 ? ev.maxPlayers : null);
const isPriorityReg = (r, comm) => {
  if (r.addedBy != null && r.addedBy !== "approved") return true;
  return comm?.members?.find(m=>m.userId===r.userId)?.status==="regular";
};
const splitRegsByCapacity = (ev, comm) => {
  const max = getMaxPlayers(ev);
  if (!max) return { active: ev.registrations, waitlisted: [] };
  if (!comm) return { active: ev.registrations.slice(0, max), waitlisted: ev.registrations.slice(max) };
  const windowActive = ev?.regularUntil && Date.now() < new Date(ev.regularUntil).getTime();
  if (windowActive) {
    const active=[], waitlisted=[];
    ev.registrations.forEach(r=>{
      if (isPriorityReg(r,comm) && active.length<max) active.push(r);
      else waitlisted.push(r);
    });
    return { active, waitlisted };
  }
  const grandfathered = new Set();
  { let n=0; ev.registrations.forEach(r => { if (isPriorityReg(r,comm) && n<max) { grandfathered.add(r.userId); n++; } }); }
  let slotsLeft = max - grandfathered.size;
  const active=[], waitlisted=[];
  ev.registrations.forEach(r=>{
    if (grandfathered.has(r.userId)) { active.push(r); return; }
    if (slotsLeft>0) { active.push(r); slotsLeft--; }
    else waitlisted.push(r);
  });
  return { active, waitlisted };
};

async function restore(backupFile) {
  const backup = JSON.parse(readFileSync(backupFile, "utf8"));
  if (backup.project !== expectedProjectId) {
    console.error(`Backup file is for project "${backup.project}", not "${expectedProjectId}" (--project ${projectArg}). Refusing.`);
    process.exit(1);
  }
  console.log(`Restoring ${backup.registrations.length} registration doc(s) from ${backupFile} (project: ${expectedProjectId})...`);
  let batch = db.batch(), n = 0;
  for (const {eventId, userId, data} of backup.registrations) {
    batch.set(db.collection("padelos_events").doc(String(eventId)).collection("registrations").doc(String(userId)), data);
    n++;
    if (n % 450 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  console.log(`Restored ${n} registration doc(s) ✓`);
}

async function backfill() {
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });

  const eventsSnap = await db.collection("padelos_events").get();
  console.log(`Scanning ${eventsSnap.size} event(s) in ${expectedProjectId}...`);

  const commsCache = new Map();
  const getComm = async (cid) => {
    if (commsCache.has(cid)) return commsCache.get(cid);
    const snap = await db.collection("padelos_communities").doc(String(cid)).get();
    const c = snap.exists ? snap.data() : null;
    commsCache.set(cid, c);
    return c;
  };

  // Pass 1: figure out exactly which registration docs need a NEW confirmOrder, without writing
  // anything yet — this both builds the pre-write backup and the list of planned writes.
  const backupEntries = [];
  const plannedWrites = []; // {eventId, userId, data} — data is the FULL new doc content

  for (const evDoc of eventsSnap.docs) {
    const ev = evDoc.data();
    const eid = evDoc.id;
    const regsSnap = await db.collection("padelos_events").doc(eid).collection("registrations").get();
    if (regsSnap.empty) continue;
    const regs = regsSnap.docs.map(d => d.data());
    regs.sort((a,b) => (a.registeredAt < b.registeredAt ? -1 : a.registeredAt > b.registeredAt ? 1 : String(a.userId).localeCompare(String(b.userId))));

    const comm = ev.communityId != null ? await getComm(ev.communityId) : null;
    const { active } = splitRegsByCapacity({ ...ev, registrations: regs }, comm);

    let maxExisting = regs.reduce((m,r) => Math.max(m, r.confirmOrder||0), 0);
    active.forEach(r => {
      if (r.confirmOrder != null) return;
      const newData = { ...r, confirmOrder: ++maxExisting };
      backupEntries.push({ eventId: eid, userId: r.userId, data: r }); // pre-write (old) content
      plannedWrites.push({ eventId: eid, userId: r.userId, data: newData });
    });
  }

  if (plannedWrites.length === 0) {
    console.log("Nothing to backfill — every currently-confirmed registration already has a confirmOrder.");
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g,"-");
  const backupPath = join(backupsDir, `confirm-order-backfill-${projectArg}-${ts}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), purpose: "confirmOrder backfill pre-write snapshot", project: expectedProjectId, registrations: backupEntries }, null, 2));
  console.log(`Backup written (rollback point): ${backupPath}`);
  console.log(`Assigning confirmOrder to ${plannedWrites.length} registration(s) across ${new Set(plannedWrites.map(w=>w.eventId)).size} event(s)...`);

  let batch = db.batch(), n = 0;
  for (const { eventId, userId, data } of plannedWrites) {
    batch.set(db.collection("padelos_events").doc(String(eventId)).collection("registrations").doc(String(userId)), data);
    n++;
    if (n % 450 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  console.log(`Done — ${n} registration(s) numbered ✓`);
}

async function repair() {
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });

  const eventsSnap = await db.collection("padelos_events").get();
  console.log(`Scanning ${eventsSnap.size} event(s) in ${expectedProjectId} for over-capacity confirmations...`);

  const backupEntries = [];
  const plannedWrites = []; // {eventId, userId, data} — data is the full doc with confirmOrder cleared

  for (const evDoc of eventsSnap.docs) {
    const ev = evDoc.data();
    const eid = evDoc.id;
    const maxPlayers = getMaxPlayers(ev);
    if (maxPlayers == null) continue;
    const regsSnap = await db.collection("padelos_events").doc(eid).collection("registrations").get();
    const confirmed = regsSnap.docs.map(d => d.data()).filter(r => r.confirmOrder != null).sort((a,b)=>a.confirmOrder-b.confirmOrder);
    if (confirmed.length <= maxPlayers) continue;
    const excess = confirmed.slice(maxPlayers); // highest confirmOrder values beyond the cap
    console.log(`event ${eid}: ${confirmed.length} confirmed, max ${maxPlayers} — clearing confirmOrder on ${excess.length}: ${excess.map(r=>`userId=${r.userId} #${r.confirmOrder}`).join(", ")}`);
    excess.forEach(r => {
      backupEntries.push({ eventId: eid, userId: r.userId, data: r });
      const { confirmOrder, ...rest } = r;
      plannedWrites.push({ eventId: eid, userId: r.userId, data: rest });
    });
  }

  if (plannedWrites.length === 0) {
    console.log("Nothing to repair — no event has more confirmed registrations than its maxPlayers.");
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g,"-");
  const backupPath = join(backupsDir, `confirm-order-repair-${projectArg}-${ts}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), purpose: "confirmOrder over-capacity repair pre-write snapshot", project: expectedProjectId, registrations: backupEntries }, null, 2));
  console.log(`Backup written (rollback point): ${backupPath}`);

  let batch = db.batch(), n = 0;
  for (const { eventId, userId, data } of plannedWrites) {
    // Full overwrite (not update) so the confirmOrder field is actually removed, not left as
    // undefined-and-ignored — Firestore's admin SDK `set` drops keys that aren't present.
    batch.set(db.collection("padelos_events").doc(String(eventId)).collection("registrations").doc(String(userId)), data);
    n++;
    if (n % 450 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  console.log(`Done — cleared confirmOrder on ${n} over-capacity registration(s) ✓`);
}

if (restoreArg) await restore(restoreArg);
else if (repairMode) await repair();
else await backfill();
process.exit(0);
