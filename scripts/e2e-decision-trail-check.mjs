// One-off manual verification script for the Decision Trail feature (V0.16.57) — NOT a
// permanent test suite, just using the new e2e login (see setup-e2e-test-login.mjs) to actually
// click through the real UI against a local dev server (padelos-dev config) instead of only
// trusting the Node engine simulation. Screenshots are written to the scratchpad dir passed as
// argv[2].
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { join } from "path";

const BASE_URL = process.argv[2] || "http://localhost:5176/";
const OUT_DIR = process.argv[3] || ".";
const creds = JSON.parse(readFileSync(join(process.cwd(), "secrets", "e2e-test-login.json"), "utf8"));

const shot = async (page, name) => { await page.screenshot({ path: join(OUT_DIR, name), fullPage: true }); console.log("saved", name); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on("console", msg => { if (msg.type()==="error") console.log("[console.error]", msg.text()); });
  page.on("pageerror", err => console.log("[pageerror]", err.message));

  await page.goto(BASE_URL, { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await shot(page, "01-login.png");

  await page.fill('input[placeholder="Email"]', creds.email);
  await page.fill('input[placeholder="Password"]', creds.password);
  await page.click('button:has-text("Sign in")');
  await page.waitForTimeout(3000);
  await shot(page, "02-after-login.png");

  await page.getByText("Communities", { exact: true }).last().click();
  await page.waitForTimeout(1000);
  await shot(page, "03-communities.png");

  await page.getByText("Trimachine Padel", { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await shot(page, "04-community.png");

  await page.getByText("Events", { exact: true }).nth(1).click();
  await page.waitForTimeout(1000);
  await shot(page, "05-community-events.png");

  await page.getByText(/Completed \(\d+\)/).click();
  await page.waitForTimeout(500);
  await shot(page, "05b-completed-expanded.png");
  await page.getByText("Monday Padel Rally — Galleria Moon Valley", { exact: true }).click();
  await page.waitForTimeout(1500);
  await shot(page, "06-event-80.png");

  await page.getByText(/Start/).first().click();
  await page.waitForTimeout(1000);
  await shot(page, "07-sim-started.png");

  await page.getByText("Rounds", { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await shot(page, "08-rounds-tab.png");

  await page.getByText(/Dynamic v2/).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /Generate Round 1/ }).click();
  await page.waitForTimeout(1500);
  await shot(page, "09-round1-generated.png");

  const infoButtons = await page.getByRole("button", { name: "ℹ️" }).all();
  console.log("ℹ️ buttons found on page (round 1, break-only expected):", infoButtons.length);
  if (infoButtons.length) {
    await infoButtons[0].scrollIntoViewIfNeeded();
    await infoButtons[0].click();
    await page.waitForTimeout(500);
    await shot(page, "10-reason-modal-break.png");
    await page.getByText("Close", { exact: true }).click();
    await page.waitForTimeout(300);
  }

  // Confirm all 4 Round 1 matches (Team A wins each, arbitrarily) so Round 2 can generate.
  // Score buttons start at 0-0 so "Confirm Team A" is disabled until A's score > B's — bump
  // Team A's "+" (left column of each match's two-column score grid) twice per court first.
  const plusButtons = await page.getByRole("button", { name: "+", exact: true }).all();
  const leftHalf = [];
  for (const btn of plusButtons) {
    const box = await btn.boundingBox();
    if (box && box.x < 210) leftHalf.push(btn);
  }
  console.log("Team A '+' buttons found:", leftHalf.length);
  for (const btn of leftHalf) { await btn.click(); await btn.click(); await page.waitForTimeout(150); }
  await shot(page, "10b-scores-bumped.png");

  // Re-query each time (not .all() up front) — confirming a match removes its "Confirm Team A"
  // element entirely, which shifts every later nth-index in a stale collected list.
  let guard = 0;
  while (await page.getByText(/Confirm Team A/).count() > 0 && guard++ < 8) {
    await page.getByText(/Confirm Team A/).first().click();
    await page.waitForTimeout(400);
  }
  await shot(page, "11-round1-confirmed.png");

  await page.getByRole("button", { name: /Generate Round 2/ }).click();
  await page.waitForTimeout(1500);
  await shot(page, "12-round2-generated.png");

  const infoButtons2 = await page.getByRole("button", { name: "ℹ️" }).all();
  console.log("ℹ️ buttons found on page (round 2, break+return expected):", infoButtons2.length);
  for (let i = 0; i < infoButtons2.length; i++) {
    await infoButtons2[i].scrollIntoViewIfNeeded();
    await infoButtons2[i].click();
    await page.waitForTimeout(400);
    await shot(page, `13-round2-reason-${i}.png`);
    await page.getByText("Close", { exact: true }).click();
    await page.waitForTimeout(300);
  }

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
