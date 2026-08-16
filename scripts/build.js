// Wraps `vite build` to protect dist/releases/ (shipped APK downloads) from Vite's default
// emptyOutDir behavior, which wipes the entire dist/ folder before writing — including files
// Vite doesn't know about, like previously-shipped APKs. This silently deleted a shipped APK
// from the working tree (and, if a `firebase deploy` followed without noticing, from the live
// download link) every time a routine rebuild ran after an APK ship — a real bug that happened
// more than once. Stash dist/releases/ before the build, restore it after.
import { existsSync, rmSync, cpSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releasesDir = path.join(root, "dist", "releases");
const stashDir = path.join(root, ".releases-stash");

if (existsSync(releasesDir)) {
  rmSync(stashDir, { recursive: true, force: true });
  cpSync(releasesDir, stashDir, { recursive: true });
}

execSync("vite build", { stdio: "inherit", cwd: root });

if (existsSync(stashDir)) {
  mkdirSync(releasesDir, { recursive: true });
  cpSync(stashDir, releasesDir, { recursive: true });
  rmSync(stashDir, { recursive: true, force: true });
}
