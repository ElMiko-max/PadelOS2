// Read/write Firestore access to the padelos-dev sandbox ONLY — used to seed and shape test
// data directly (players, communities, events, etc.) without going through the app's UI.
// This is deliberately separate from scripts/query-db.js (which is read-only and typically
// points at production for inspection) — this script can write, so it hard-refuses to run
// against any service account whose project_id isn't exactly "padelos-dev", regardless of
// which key file it's pointed at. That check is the real safety net here, not convention.
//
// Key file: auto-detected as the single *firebase-adminsdk*.json under secrets/ (gitignored).
// Override with PADELOS_DEV_ADMIN_KEY=<path> if you ever keep more than one there.
//
// Every padelos/{docId} doc stores its payload as a JSON string under a `value` field (see
// the sync pattern in src/App.jsx) — get/set here transparently stringify/parse that for you.
//
// Usage:
//   node scripts/dev-admin.js list
//   node scripts/dev-admin.js get users
//   node scripts/dev-admin.js get comms --save comms.json
//   node scripts/dev-admin.js set users ./my-edited-users.json

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const secretsDir = join(__dirname, "..", "secrets");

function resolveKeyPath() {
  if (process.env.PADELOS_DEV_ADMIN_KEY) return process.env.PADELOS_DEV_ADMIN_KEY;
  const candidates = readdirSync(secretsDir).filter(f => f.includes("firebase-adminsdk") && f.endsWith(".json"));
  if (candidates.length === 0) { console.error(`No *firebase-adminsdk*.json key found in ${secretsDir}`); process.exit(1); }
  if (candidates.length > 1) { console.error(`Multiple key files in ${secretsDir} — set PADELOS_DEV_ADMIN_KEY explicitly:\n${candidates.join("\n")}`); process.exit(1); }
  return join(secretsDir, candidates[0]);
}

const serviceAccount = JSON.parse(readFileSync(resolveKeyPath(), "utf8"));
if (serviceAccount.project_id !== "padelos-dev") {
  console.error(`Refusing to run — this key belongs to project "${serviceAccount.project_id}", not "padelos-dev". This script only ever writes to the dev sandbox.`);
  process.exit(1);
}
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
    if (!arg) { console.error("Usage: node scripts/dev-admin.js get <docId> [--save file.json]"); process.exit(1); }
    const snap = await db.collection("padelos").doc(arg).get();
    if (!snap.exists) { console.error(`padelos/${arg} does not exist.`); process.exit(1); }
    const raw = snap.data();
    const parsed = typeof raw.value === "string" ? JSON.parse(raw.value) : raw;
    const json = JSON.stringify(parsed, null, 2);
    if (savePath) { writeFileSync(savePath, json); console.log(`Saved ${json.length} bytes to ${savePath}`); }
    else console.log(json);
    return;
  }
  if (cmd === "set") {
    if (!arg || !rest[0]) { console.error("Usage: node scripts/dev-admin.js set <docId> <file.json>"); process.exit(1); }
    const content = JSON.parse(readFileSync(rest[0], "utf8"));
    await db.collection("padelos").doc(arg).set({ value: JSON.stringify(content) });
    console.log(`Wrote padelos/${arg} from ${rest[0]} (project: ${serviceAccount.project_id}) ✓`);
    return;
  }
  console.error("Commands: list | get <docId> [--save file.json] | set <docId> <file.json>");
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
