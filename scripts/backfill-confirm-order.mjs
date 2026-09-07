// One-off backfill for the confirmOrder feature (BUGS.md #18 follow-up, 2026-09-06): stamps a
// permanent, dense, per-event seat number onto every registration doc that's currently
// CONFIRMED (active per splitRegsByCapacity) but doesn't have one yet. Idempotent — skips
// anything already numbered, so it's safe to re-run. Completed/archived/soft-deleted events are
// skipped entirely (requested 2026-09-07) — nothing left to confirm on a closed event.
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
// --reorder-fifo (2026-09-07): tier-based priority was retired — clears confirmOrder on every
// still-open event that has any assigned, then reassigns fresh via the now tier-free
// splitRegsByCapacity, producing pure chronological (first-come-first-served) order. Can change
// who's currently confirmed vs. waitlisted, not just reorder the same people — see the comment
// above the reorderFifo() function for why that's intended.
//
// Usage:
//   node scripts/backfill-confirm-order.mjs --project dev
//   node scripts/backfill-confirm-order.mjs --project prod
//   node scripts/backfill-confirm-order.mjs --repair --project dev
//   node scripts/backfill-confirm-order.mjs --reorder-fifo --project dev
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
const reorderFifoMode = args.includes("--reorder-fifo");

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

// ── Exact copy of App.jsx's splitRegsByCapacity (App.jsx:485) — reinstated 2026-09-07 in
// corrected form: a genuine Regular community member gets first claim on active seats during
// the event's first 24h (ev.regularUntil); nothing else (addedBy/invite/admin/approved) grants
// any bypass. Everyone/everything else fills remaining slots in pure chronological order. ──
const getMaxPlayers = ev => (ev?.maxPlayers>0 ? ev.maxPlayers : null);
const splitRegsByCapacity = (ev, comm) => {
  const max = getMaxPlayers(ev);
  if (!max) return { active: ev.registrations, waitlisted: [] };
  const confirmed = ev.registrations.filter(r => r.confirmOrder != null);
  const rest = ev.registrations.filter(r => r.confirmOrder == null);
  const remainingMax = Math.max(0, max - confirmed.length);
  const windowActive = ev?.regularUntil && Date.now() < new Date(ev.regularUntil).getTime();
  if (windowActive && comm) {
    const active = [...confirmed], waitlisted = [];
    rest.forEach(r => {
      const isRegular = comm.members?.find(m=>m.userId===r.userId)?.status==="regular";
      if (isRegular && active.length<max) active.push(r); else waitlisted.push(r);
    });
    return { active, waitlisted };
  }
  return { active: [...confirmed, ...rest.slice(0, remainingMax)], waitlisted: rest.slice(remainingMax) };
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

// Skip completed/archived/soft-deleted events (requested 2026-09-07) — nothing left to confirm
// on a closed event, and it keeps the blast radius of a production run scoped to events that
// are actually still live/relevant.
const isClosedEvent = (ev) => ev.status==="completed" || ev.archived===true || ev.deleted===true;

async function backfill() {
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });

  const allEventsSnap = await db.collection("padelos_events").get();
  const eventsSnap = { docs: allEventsSnap.docs.filter(d => !isClosedEvent(d.data())) };
  console.log(`Scanning ${eventsSnap.docs.length} event(s) in ${expectedProjectId} (skipped ${allEventsSnap.size - eventsSnap.docs.length} completed/archived/deleted)...`);

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

  const allEventsSnap = await db.collection("padelos_events").get();
  const eventsSnap = { docs: allEventsSnap.docs.filter(d => !isClosedEvent(d.data())) };
  console.log(`Scanning ${eventsSnap.docs.length} event(s) in ${expectedProjectId} for over-capacity confirmations (skipped ${allEventsSnap.size - eventsSnap.docs.length} completed/archived/deleted)...`);

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

// --reorder-fifo (2026-09-07): tier-based priority was retired from splitRegsByCapacity — a
// registration should behave like a cinema seat or a doctor's queue, first come first served,
// permanently. Every already-assigned confirmOrder on a still-open event was computed under the
// OLD tier-aware rule, so it can be wrong (e.g. a Regular member who registered late still
// landing ahead of an earlier Casual/Guest self-registrant — the real incident that prompted
// this). Since the fixed splitRegsByCapacity already produces pure chronological order for any
// registration with no confirmOrder yet, the fix is just: clear every confirmOrder on the
// event, then reassign fresh — no bespoke reordering math needed. This can change who's
// currently confirmed vs. waitlisted on a live event, not just reorder the same people —
// that's the intended correction, not a side effect.
async function reorderFifo() {
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });

  const allEventsSnap = await db.collection("padelos_events").get();
  const eventsSnap = { docs: allEventsSnap.docs.filter(d => !isClosedEvent(d.data())) };
  console.log(`Scanning ${eventsSnap.docs.length} event(s) in ${expectedProjectId} for FIFO reorder (skipped ${allEventsSnap.size - eventsSnap.docs.length} completed/archived/deleted)...`);

  const backupEntries = [];
  const plannedWrites = []; // {eventId, userId, data}
  const commsCache = new Map();
  const getComm = async (cid) => {
    if (commsCache.has(cid)) return commsCache.get(cid);
    const snap = await db.collection("padelos_communities").doc(String(cid)).get();
    const c = snap.exists ? snap.data() : null;
    commsCache.set(cid, c);
    return c;
  };

  for (const evDoc of eventsSnap.docs) {
    const ev = evDoc.data();
    const eid = evDoc.id;
    const regsSnap = await db.collection("padelos_events").doc(eid).collection("registrations").get();
    if (regsSnap.empty) continue;
    const regs = regsSnap.docs.map(d => d.data());
    if (!regs.some(r => r.confirmOrder != null)) continue; // nothing assigned yet — nothing to reorder
    regs.sort((a,b) => (a.registeredAt < b.registeredAt ? -1 : a.registeredAt > b.registeredAt ? 1 : String(a.userId).localeCompare(String(b.userId))));

    regs.forEach(r => backupEntries.push({ eventId: eid, userId: r.userId, data: r }));

    const comm = ev.communityId != null ? await getComm(ev.communityId) : null;
    const cleared = regs.map(r => { const { confirmOrder, ...rest } = r; return rest; });
    const { active } = splitRegsByCapacity({ ...ev, registrations: cleared }, comm);
    const finalById = new Map(cleared.map(r => [String(r.userId), r]));
    let n = 0;
    active.forEach(r => { finalById.set(String(r.userId), { ...r, confirmOrder: ++n }); });
    console.log(`event ${eid} "${ev.name}": ${n} confirmed in true chronological order (${regs.length - n} waitlisted)`);
    for (const r of cleared) plannedWrites.push({ eventId: eid, userId: r.userId, data: finalById.get(String(r.userId)) });
  }

  if (plannedWrites.length === 0) {
    console.log("Nothing to reorder — no open event has any confirmOrder assigned yet.");
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g,"-");
  const backupPath = join(backupsDir, `confirm-order-reorder-fifo-${projectArg}-${ts}.json`);
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), purpose: "confirmOrder FIFO reorder pre-write snapshot (tier-based priority retired 2026-09-07)", project: expectedProjectId, registrations: backupEntries }, null, 2));
  console.log(`Backup written (rollback point): ${backupPath}`);
  console.log(`Rewriting ${plannedWrites.length} registration(s) across ${new Set(plannedWrites.map(w=>w.eventId)).size} event(s)...`);

  let batch = db.batch(), n = 0;
  for (const { eventId, userId, data } of plannedWrites) {
    batch.set(db.collection("padelos_events").doc(String(eventId)).collection("registrations").doc(String(userId)), data);
    n++;
    if (n % 450 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();
  console.log(`Done — ${n} registration(s) rewritten in pure chronological order ✓`);
}

if (restoreArg) await restore(restoreArg);
else if (repairMode) await repair();
else if (reorderFifoMode) await reorderFifo();
else await backfill();
process.exit(0);
