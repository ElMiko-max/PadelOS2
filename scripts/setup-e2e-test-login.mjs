// One-time setup for a scriptable UI-testing login against padelos-dev ONLY. Fixes a recurring
// problem: Claude Code sessions in this repo could drive a real headless browser (Playwright is
// already available here) but had no way to actually get PAST the login screen, since the app's
// primary sign-in is a real interactive Google OAuth popup that shouldn't be automated. This
// script creates a normal Firebase Auth email/password account (the app's LoginScreen already
// supports this path natively — no app code changes needed at all) and links it to an existing
// real dev profile via padelos_links, so an automated browser session can sign in through the
// completely standard email/password form and see real data.
//
// Same hard safety net as scripts/dev-admin.js: refuses to run against any service account
// whose project_id isn't exactly "padelos-dev".
//
// Usage: node scripts/setup-e2e-test-login.mjs [--link-user-id 1]
// Prints (and saves to secrets/e2e-test-login.json, gitignored) the email/password to use.

import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const secretsDir = join(__dirname, "..", "secrets");
const outPath = join(secretsDir, "e2e-test-login.json");

function resolveKeyPath() {
  if (process.env.PADELOS_DEV_ADMIN_KEY) return process.env.PADELOS_DEV_ADMIN_KEY;
  const candidates = readdirSync(secretsDir).filter(f => f.includes("padelos-dev") && f.includes("firebase-adminsdk") && f.endsWith(".json"));
  if (candidates.length !== 1) { console.error(`Expected exactly one padelos-dev key in ${secretsDir}, found ${candidates.length}. Set PADELOS_DEV_ADMIN_KEY explicitly.`); process.exit(1); }
  return join(secretsDir, candidates[0]);
}

const serviceAccount = JSON.parse(readFileSync(resolveKeyPath(), "utf8"));
if (serviceAccount.project_id !== "padelos-dev") {
  console.error(`Refusing to run — this key belongs to project "${serviceAccount.project_id}", not "padelos-dev".`);
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

const linkArgIdx = process.argv.indexOf("--link-user-id");
const linkUserId = linkArgIdx !== -1 ? parseInt(process.argv[linkArgIdx + 1], 10) : 1; // default: dev's Amka (id 1)

const EMAIL = "e2e-test-bot@padelos-dev.local";

async function main() {
  let uid, password;
  if (existsSync(outPath)) {
    const existing = JSON.parse(readFileSync(outPath, "utf8"));
    password = existing.password;
    try {
      const u = await auth.getUserByEmail(EMAIL);
      uid = u.uid;
      console.log(`Reusing existing auth user ${EMAIL} (uid ${uid}).`);
    } catch {
      // Credentials file existed but the auth user doesn't (e.g. a fresh dev project) — recreate with the same saved password.
    }
  }
  if (!uid) {
    password = password || randomBytes(12).toString("base64url");
    const created = await auth.createUser({ email: EMAIL, password, displayName: "E2E Test Bot", emailVerified: true });
    uid = created.uid;
    console.log(`Created new auth user ${EMAIL} (uid ${uid}).`);
  }

  await db.collection("padelos_links").doc(uid).set({ userId: linkUserId });
  console.log(`Linked ${EMAIL} (uid ${uid}) → app userId ${linkUserId} via padelos_links ✓`);

  writeFileSync(outPath, JSON.stringify({ email: EMAIL, password, uid, linkedUserId: linkUserId }, null, 2));
  console.log(`Saved credentials to ${outPath} (gitignored).`);
}

main().catch(e => { console.error(e); process.exit(1); });
