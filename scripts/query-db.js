// Read-only Firestore inspector for Matchkeeper's `padelos` collection.
// Every doc in that collection stores its payload as a JSON string under a `value` field
// (see the sync pattern used throughout src/App.jsx) — this script fetches a doc and parses
// that string back into an object automatically.
//
// Setup (one-time):
//   1. Generate a READ-ONLY service account key (Cloud Datastore Viewer role only — see
//      project memory/instructions for the exact steps), save it OUTSIDE this repo.
//   2. Set PADELOS_ADMIN_KEY to that file's absolute path before running.
//
// Usage:
//   PADELOS_ADMIN_KEY="C:\path\to\key.json" node scripts/query-db.js get comms
//   PADELOS_ADMIN_KEY="C:\path\to\key.json" node scripts/query-db.js get users --save out.json
//   PADELOS_ADMIN_KEY="C:\path\to\key.json" node scripts/query-db.js list
//
// This script only ever calls .get() — never .set()/.update()/.delete() — as a code-level
// backstop on top of the IAM role actually enforcing read-only access.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync } from "fs";

const keyPath = process.env.PADELOS_ADMIN_KEY;
if (!keyPath) {
  console.error("Set PADELOS_ADMIN_KEY to the absolute path of your service account key JSON file first.");
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const [, , cmd, arg, ...rest] = process.argv;
const saveIdx = rest.indexOf("--save");
const savePath = saveIdx !== -1 ? rest[saveIdx + 1] : null;

async function main() {
  if (cmd === "list") {
    const snap = await db.collection("padelos").listDocuments();
    console.log(snap.map(d => d.id).join("\n"));
    return;
  }
  if (cmd === "get") {
    if (!arg) { console.error("Usage: node scripts/query-db.js get <docId> [--save file.json]"); process.exit(1); }
    const snap = await db.collection("padelos").doc(arg).get();
    if (!snap.exists) { console.error(`padelos/${arg} does not exist.`); process.exit(1); }
    const raw = snap.data();
    const parsed = typeof raw.value === "string" ? JSON.parse(raw.value) : raw;
    const json = JSON.stringify(parsed, null, 2);
    if (savePath) { writeFileSync(savePath, json); console.log(`Saved ${json.length} bytes to ${savePath}`); }
    else console.log(json);
    return;
  }
  console.error("Commands: list | get <docId> [--save file.json]");
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
