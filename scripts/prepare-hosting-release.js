// Populates dist/releases/ from the permanent release-archive/ folder — run this ONLY as the
// very last step before `firebase deploy --only hosting`, after `npm run build`, `npx cap sync`,
// and `gradlew assembleDebug` have all already finished.
//
// Why this exists: dist/releases/ must NEVER be present during `npm run build` or `npx cap
// sync`, because `cap sync` copies the entire dist/ folder into the Android assets — if a
// shipped APK is sitting in dist/releases/ at that point, it gets bundled INSIDE the next APK
// build (a real bug that happened twice: V0.06.02, and again when an earlier fix for a
// different problem — dist/releases getting wiped by a plain rebuild — accidentally
// reintroduced it by keeping dist/releases populated across every build). The permanent fix is
// to never let dist/releases persist across a build at all — release-archive/ (outside dist/,
// never touched by Vite or cap sync) is the real source of truth, and this script is the only
// thing allowed to write into dist/releases/, at the one moment it's actually needed.
import { existsSync, mkdirSync, readdirSync, cpSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const archiveDir = path.join(root, "release-archive");
const releasesDir = path.join(root, "dist", "releases");

if (!existsSync(archiveDir)) {
  console.log("No release-archive/ found — nothing to prepare.");
  process.exit(0);
}

mkdirSync(releasesDir, { recursive: true });
const files = readdirSync(archiveDir).filter(f => f.endsWith(".apk"));
for (const f of files) {
  cpSync(path.join(archiveDir, f), path.join(releasesDir, f));
  console.log(`Prepared for hosting: ${f}`);
}
