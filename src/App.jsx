import React, { useState, useEffect, useRef } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { App as CapApp } from "@capacitor/app";
import { PushNotifications } from "@capacitor/push-notifications";
import { GoogleSignIn } from "@capawesome/capacitor-google-sign-in";
import { NativeSettings, AndroidSettings, IOSSettings } from "capacitor-native-settings";

// Native Android plugin (see /android/.../MatchModePlugin.kt) — persistent Match Mode
// notification: shows live courts/teams for the current round, lets the organizer tap a
// winner per court, and Generate Next Round once every court is done. No-op on web/non-native.
const MatchMode = registerPlugin("MatchMode");
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  updateProfile,
} from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, onSnapshot, collection, getDocs, deleteDoc, addDoc, query, orderBy, limit, startAfter } from "firebase/firestore";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { getMessaging, getToken } from "firebase/messaging";
import { getFunctions, httpsCallable } from "firebase/functions";

// ── Firebase (Phase 1: auth. Phase 2: Firestore replaces localStorage as the
// shared source of truth, so every device sees the same data in real time) ──
// Config comes from Vite env files (.env.production / .env.development, both
// gitignored) so `npm run build` (mode=production, unchanged) keeps targeting
// the live padelos-6f999 project, while a dev build (`--mode development`)
// targets the separate padelos-dev project. Hardcoded values below are just a
// safety-net fallback to today's production config if an env var is missing.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyAldFg5ofZgXfgn_JSORc_uqkWuq5sGnIY",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "padelos-6f999.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "padelos-6f999",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "padelos-6f999.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "807847071392",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:807847071392:web:b104417c7af0f5967f43c5",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-H6DLLT7Q7C",
};
const IS_DEV_ENV = import.meta.env.VITE_ENV_LABEL === "development";
// Only ever used by the "Clone Data to DEV" Platform Admin tool (production build
// only — see IS_DEV_ENV gating at its call site) to open a second, independent
// Firestore connection aimed at padelos-dev so real prod data already loaded in
// this session can be pushed there for testing. Never used to read from — write
// direction only, always prod (this app's own state) → dev (this constant).
const DEV_CLONE_TARGET_CONFIG = {
  apiKey: "AIzaSyDTgCGOAguu3X0pnWv_umaycSjqz3wbqHo",
  authDomain: "padelos-dev.firebaseapp.com",
  projectId: "padelos-dev",
  storageBucket: "padelos-dev.firebasestorage.app",
  messagingSenderId: "993368973916",
  appId: "1:993368973916:web:a2696733d7de63748b7c99",
};
const firebaseApp = initializeApp(firebaseConfig);
const VAPID_KEY = "BDjCxodsXfmCwv1dPsSgssbLFMh-K9vW4JRJb-zoOweEy6cxpXtPoHVDtkydh56tnDOdSJfa5FrY7cMLirnHXyw";
// iOS Safari has no push support at all in a plain browser tab — Notification/Push only
// become available once the site is added to the Home Screen and running standalone. There
// is also no API to trigger that "Add to Home Screen" step from code (unlike Android Chrome's
// beforeinstallprompt) — it's a fully manual, Apple-enforced action. So on iOS we skip the
// auto-prompt entirely (it would be a silent no-op in a plain tab) and show install guidance
// instead (see the banner near dataDegraded).
function isIosNonStandalone(){
  try {
    const ua = navigator.userAgent || "";
    const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    return isIos && !isStandalone;
  } catch(e) { return false; }
}
// Requests notification permission, registers the service worker, and saves this
// device's push token to Firestore so the Cloud Function knows where to send pushes.
async function enablePushNotifications(userId){
  try{
    if (Capacitor.isNativePlatform()) {
      await PushNotifications.createChannel({
        id: "matchkeeper_alerts",
        name: "Matchkeeper Alerts",
        description: "Match reminders, round-end alarms, and event updates",
        importance: 5, // max — shows as heads-up + lock screen
        visibility: 1,
        vibration: true,
      }).catch(e=>console.log("createChannel failed", e));
      // Always attempt the request (mirrors Geolocation.requestPermissions() below, which
      // has no gate at all) instead of only when status is exactly "prompt" — Android also
      // reports "prompt-with-rationale" after a first dismissal, which the old strict
      // equality check silently treated as a dead end even though Android was still willing
      // to show the dialog. Calling requestPermissions() when truly denied is a harmless
      // no-op, so there's no downside to just always trying.
      let permStatus = await PushNotifications.checkPermissions();
      if (permStatus.receive !== "granted") permStatus = await PushNotifications.requestPermissions();
      if (permStatus.receive !== "granted") return {ok:false, reason:"denied", permState:permStatus.receive};
      return await new Promise((resolve) => {
        PushNotifications.addListener("registration", async (token) => {
          try {
            await setDoc(doc(db,"fcmTokens", String(userId)), {token: token.value, updatedAt:new Date().toISOString()});
            resolve({ok:true});
          } catch(e) { resolve({ok:false, reason:"error", detail: e?.message||String(e)}); }
        });
        PushNotifications.addListener("registrationError", (err) => {
          resolve({ok:false, reason:"no-token", detail: JSON.stringify(err)});
        });
        PushNotifications.register();
      });
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return {ok:false, reason:"unsupported"};
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return {ok:false, reason:"denied"};
    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    await navigator.serviceWorker.ready; // wait until a service worker is actually active — registering alone doesn't guarantee it's ready yet, which was causing "no active Service Worker" failures
    const messaging = getMessaging(firebaseApp);
    const token = await getToken(messaging, {vapidKey: VAPID_KEY, serviceWorkerRegistration: reg});
    if (!token) return {ok:false, reason:"no-token"};
    await setDoc(doc(db,"fcmTokens", String(userId)), {token, updatedAt:new Date().toISOString()});
    return {ok:true};
  }catch(e){ console.log("Push enable error", e); return {ok:false, reason:"error", detail: e?.message||String(e)}; }
}
const fbAuth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);
// Lazy on purpose — never call getFunctions() at module load. padelos-dev has no Cloud
// Functions deployed at all (free Spark plan), and initializing this eagerly for every visitor
// regardless of whether it's ever used is unnecessary risk for zero benefit; created only the
// first time something on production actually needs it, inside a try/catch at the call site.
let _functionsInstance = null;
const getFunctionsLazy = () => _functionsInstance || (_functionsInstance = getFunctions(firebaseApp));
// Uploads a profile photo file/blob and returns its public download URL
async function uploadProfilePhoto(userId, file){
  const r = storageRef(storage, `profile-photos/${userId}`);
  await uploadBytes(r, file);
  return await getDownloadURL(r);
}
// Uploads a custom community banner photo and returns its public download URL — same one-file-
// per-community-id path shape as profile photos, so a re-upload just overwrites in place.
async function uploadCommunityBanner(commId, file){
  const r = storageRef(storage, `community-banners/${commId}`);
  await uploadBytes(r, file);
  return await getDownloadURL(r);
}
// Uploads an event photo and returns {id, url} — each photo gets its own storage path so multiple can coexist
async function uploadEventPhoto(eventId, file){
  const id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const r = storageRef(storage, `event-photos/${eventId}/${id}`);
  await uploadBytes(r, file);
  const url = await getDownloadURL(r);
  return {id, url};
}
const googleProvider = new GoogleAuthProvider();
if (Capacitor.isNativePlatform()) {
  GoogleSignIn.initialize({
    clientId: "807847071392-ta5u29ad02r6c7ae9aelei6hq40lr5sd.apps.googleusercontent.com",
  });
}


// ══════════════════════════════════════════════════════
//  Matchkeeper v7 – Clean rebuild with Closed Teams + Score Steppers
// ══════════════════════════════════════════════════════

// Bug #10 — this used to be a hardcoded constant with no admin-facing way to maintain it
// (add/remove governorates or areas required editing code directly). Now a Firestore-synced
// seed, editable from Platform Admin → Areas. Shape is Country → Governorate → Area (added
// later — see the migration in the "egypt" onSnapshot handler for the old flat-shape upgrade).
const INIT_EGYPT = {
  "مصر": {
    "القاهرة": ["المعادي","مدينة نصر","الزمالك","مصر الجديدة","التجمع الخامس","القاهرة الجديدة","مدينتي","المقطم","شبرا","عين شمس"],
    "الجيزة":  ["الشيخ زايد","6 أكتوبر","المهندسين","العجوزة","الدقي","إمبابة"],
    "الإسكندرية": ["سموحة","لوران","المنتزه","سيدي جابر","محرم بك"],
    "القليوبية": ["شبرا الخيمة","بنها","قليوب","الخانكة"],
  },
};
// ── Subscriptions (Enhancement #17 — profitable model) ──────────────
// Platform-wide switch, off by default — flipping `enabled` is the one moment every user
// without an active subscription (or comped status) starts seeing read-only enforcement, so
// this stays false until real payment collection (manual transfers, then Paymob) is actually
// ready. Per-user status lives on each user's own `subscription` field, not here.
const INIT_SUBSCRIPTION_SETTINGS = { enabled:false, monthlyPriceEGP:100, annualPriceEGP:1000, enabledAt:null };
// A user with no `subscription` field at all (the default for every existing/new account) is
// simply not active — same as expired. Only "comped" (admin-granted, no expiry) and an
// unexpired `expiresAt` count as active.
const isSubscriptionActive = u => {
  if (!u?.subscription) return false;
  if (u.subscription.status==="comped") return true;
  return !!u.subscription.expiresAt && new Date(u.subscription.expiresAt) > new Date();
};
// Grace period (2026-08-23): expiry doesn't lock a user out immediately — they keep full access
// for 1 day past expiresAt, only going read-only once that grace window also passes. A user who
// never had a subscription at all (no expiresAt to grace from) locks immediately — grace is
// specifically a buffer for a LAPSED subscription, not a trial for someone who never started one.
const SUBSCRIPTION_GRACE_MS = 24*60*60*1000;
const isSubscriptionLocked = (u, subscriptionSettings) => {
  if (!subscriptionSettings?.enabled || !u || u.id===1) return false;
  if (isSubscriptionActive(u)) return false;
  const exp = u.subscription?.expiresAt;
  if (!exp) return true;
  return Date.now() > new Date(exp).getTime() + SUBSCRIPTION_GRACE_MS;
};
const isSubscriptionInGrace = (u, subscriptionSettings) => {
  if (!subscriptionSettings?.enabled || !u || u.id===1) return false;
  if (isSubscriptionActive(u)) return false;
  const exp = u.subscription?.expiresAt;
  return !!exp && Date.now() <= new Date(exp).getTime() + SUBSCRIPTION_GRACE_MS;
};
// ── App Version ──────────────────────────────────────
// Format: MAJOR.SESSION.PATCH
//   MAJOR   — stays 0 until v1.0 is formally declared launch-ready, then becomes 1
//   SESSION — increments once per work session (each time we sit down to make changes)
//   PATCH   — increments on every upload/push within that session, resets to 0 on a new session
const APP_VERSION = "V0.10.53";
// Fallback only, used until TopBar's fetch of releases/latest.json resolves (or if it fails,
// e.g. offline). The real source of truth is that JSON file, written alongside the APK itself
// at delivery time — see CLAUDE.md §5 and §7 — so this constant can go stale without breaking
// the "Download Android App" link; it just means the very first paint may briefly show an old
// number before the fetch lands.
const LATEST_APK_VERSION_FALLBACK = "V0.10.00";
const INVITE_BASE_URL = "https://www.matchkeeper.app"; // custom domain (Vercel, auto-deploys on git push to main) — the real user-facing web app; padelos-6f999.web.app is Firebase's own URL for the same backend, not what real users see
// localStorage persists across sign-out/sign-in on the same device, so a pending invite code
// that never resolved (e.g. the person closed the tab mid-flow) can otherwise sit there
// indefinitely and silently get applied to a COMPLETELY DIFFERENT person who later signs in
// on that same device — a real bug found in testing (a stale invite from one account's test
// auto-registered a second, unrelated account for the same event). Bounding the age it's
// still honored, and clearing it explicitly on sign-out (see the effect further down), closes
// that off while still surviving the few-second Firestore-propagation race this exists for.
// Was 5 minutes — too tight for a brand-new invitee's actual first-time flow (picking/creating
// a Google account, consent screens, a cold app load) to reliably finish inside; when it
// expired mid-flow, the person fell through to the generic "which one is you?" screen and had
// to self-claim through the manual admin-approval queue instead of the intended zero-approval
// targeted-invite path (see claimViaInvite below) — exactly the bug this was mistaken for.
// The actual staleness risk it guards against (a leftover code on a device that keeps the
// SAME account signed in for days without ever using it) is a day-scale risk, not a minute-
// scale one, so a generous 60 minutes still closes that off comfortably.
const PENDING_INVITE_TTL_MS = 60*60*1000; // 60 minutes
function readPendingInvite(){
  try{
    const raw = localStorage.getItem("mk_pending_invite");
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed?.code || !parsed?.capturedAt || Date.now()-parsed.capturedAt>PENDING_INVITE_TTL_MS){
      localStorage.removeItem("mk_pending_invite");
      return null;
    }
    return parsed.code;
  }catch(e){ try{ localStorage.removeItem("mk_pending_invite"); }catch(e2){} return null; }
}
function clearPendingInvite(){ try{ localStorage.removeItem("mk_pending_invite"); }catch(e){} }

// Sport field (Enhancement #13) — communities/venues can support several sports (multi-select),
// each event picks exactly one. Anything created before this field existed has no stored
// value at all; every read site falls back to "Padel Tennis" rather than writing a one-time
// migration over live Firestore data.
const SPORTS = ["Padel Tennis", "Football"];
const DEFAULT_SPORT = "Padel Tennis";
const SPORT_EMOJI = {"Padel Tennis":"🎾", "Football":"⚽"};
const sportLabel = s => `${SPORT_EMOJI[s]||"🏅"} ${s}`;
// Same colors already used for these sports' pricing badges in Venues (padel courts / football
// pitches) — reused here so the sport coin on EventLevelBadge stays consistent, not a new hue.
const SPORT_COLOR = {"Padel Tennis":"#38BDF8", "Football":"#34D399"};
// Community screen cover-banner gradient, keyed by the community's primary sport — deliberately
// separate from SPORT_COLOR (a single flat accent) since the banner needs two stops.
const SPORT_GRADIENT = {"Padel Tennis":["#6366F1","#38BDF8"], "Football":["#059669","#34D399"]};
// A community configured with an immediate promote threshold (0 consecutive attends needed to
// go casual->regular) skips the casual waiting period entirely — new members land as regular
// from day one instead of joining casual and waiting for the next event-close to catch up to a
// threshold that's already met.
const initialMemberStatus = c => c.promoteAfter===0 ? "regular" : "casual";
// Community-ledger expense categories — platform-admin-maintainable list (padelos/expenseCategories),
// same singleton-doc pattern as egypt. "Misc" always stays as the catch-all (#3/#4).
const INIT_EXPENSE_CATEGORIES = ["Court Rental","Equipment & Balls","Staff & Tips","Refreshments","Misc"];
// Football pitches and padel courts at the same venue can cost different hourly rates — falls
// back to the general (padel) price if a venue added Football without setting its own price yet.
const getVenuePricing = (venue, sport) => {
  if (!venue) return { pricePerHour: 0, extraFee: 0 };
  if (sport === "Football") return { pricePerHour: venue.pricePerHourFootball ?? venue.pricePerHour ?? 0, extraFee: venue.extraFeeFootball ?? venue.extraFee ?? 0 };
  return { pricePerHour: venue.pricePerHour ?? 0, extraFee: venue.extraFee ?? 0 };
};

const EVENT_TYPES = [
  { key:"open",         label:"Open Day",           desc:"Social · all levels · check-in" },
  { key:"closed_ind",   label:"Closed Individuals",  desc:"Competitive · rotating partners · ranked" },
  { key:"closed_teams", label:"Closed Teams",        desc:"Fixed teams · compete throughout" },
];
// Football's on-pitch model is fixed teams for the whole session, not padel's rotating-doubles-
// partner format — so Closed Individuals (built entirely around that rotation) doesn't apply.
// Same underlying type keys/behavior as padel (nothing downstream changes), just sport-
// appropriate labels, reordered with the team-based format first per the owner's call.
// "League" vs "Ladder" is a Format choice made at team-formation time (plan.format — see
// the Form Teams screen), not an Event Type — so the type itself is just "Teams" (fixed
// squads for the session) vs "Open" (pickup), matching how football admins actually think
// about it, not padel's League/Ladder-as-a-top-level-choice framing.
const FOOTBALL_EVENT_TYPES = [
  { key:"closed_teams", label:"Teams",         desc:"Fixed teams · compete throughout · standings" },
  { key:"open",         label:"Open / Pickup", desc:"Social · check-in · teams picked on the day" },
];
const getEventTypesForSport = sport => sport==="Football" ? FOOTBALL_EVENT_TYPES : EVENT_TYPES;
// Football has no computed USR-equivalent — team formation (Multi-Pool Snake) needs *some*
// numeric rating to sort/balance players by, so footballSkill's A–E tier maps onto the same
// 0–100 scale the algorithm already expects. Unrated players fall back to the midpoint (50)
// rather than being silently underweighted as if they were footballSkill "E". Padel's per-event
// USR override (r.eventUsr) has no football equivalent, so it's simply never consulted here.
const FOOTBALL_SKILL_RATING = {A:90, B:70, C:50, D:30, E:10};
const teamFormationRating = (u, ev) => ev?.sport==="Football" ? (FOOTBALL_SKILL_RATING[u.footballSkill] ?? 50) : u.usr;
// Reverse of FOOTBALL_SKILL_RATING, for team AVERAGES (which land between the 5 raw letter
// anchors once mixed-skill players are combined) — 15-grade scale (E- through A+) so a team's
// blended rating still reads as a football skill, not a padel-looking USR number.
const FOOTBALL_GRADE_LETTERS = ["E-","E","E+","D-","D","D+","C-","C","C+","B-","B","B+","A-","A","A+"];
const footballGradeLabel = avg => FOOTBALL_GRADE_LETTERS[Math.min(14,Math.max(0,Math.round((Math.max(0,Math.min(100,avg))/100)*14)))];

// ── AI Event Name Suggester (IDEA-022) ────────────────────────────
// Client-side template + randomizer. No network call, no API cost — deliberately kept
// simple/offline per Product Bible's "Operational Simplicity" principle.
const EVNAME_MOTIVATIONAL = ["Smash","Rally","Ace","Grind","Showdown","Clash","Hustle","Sprint","Battle","Fiesta","Warriors","Legends","Frenzy","Thunder","Blitz"];
const EVNAME_DAYPARTS = { morning:"Morning", afternoon:"Afternoon", evening:"Evening", night:"Night" };
const evNameDaypart = (time) => {
  const h = parseInt((time||"18:00").split(":")[0],10);
  if(isNaN(h)) return "Evening";
  if(h<12) return EVNAME_DAYPARTS.morning;
  if(h<17) return EVNAME_DAYPARTS.afternoon;
  if(h<21) return EVNAME_DAYPARTS.evening;
  return EVNAME_DAYPARTS.night;
};
const evNameWeekday = (date) => { const d=new Date(date); return isNaN(d.getTime())?"":d.toLocaleDateString("en-GB",{weekday:"long"}); };
function suggestEventName({date,time,venueName,commName,sport}){
  const day = evNameWeekday(date);
  const part = evNameDaypart(time);
  const word = EVNAME_MOTIVATIONAL[Math.floor(Math.random()*EVNAME_MOTIVATIONAL.length)];
  const sportWord = sport==="Football" ? "Football" : sport ? "Padel" : "";
  const templates = [
    () => `${day} ${part} ${sportWord} ${word}`.trim(),
    () => venueName ? `${sportWord} ${word} at ${venueName}`.trim() : `${day} ${sportWord} ${word}`.trim(),
    () => commName ? `${commName} ${sportWord} ${word}`.trim() : `${part} ${sportWord} ${word}`.trim(),
    () => `${day} ${sportWord} ${word}${venueName?` — ${venueName}`:""}`.trim(),
    () => `${part} ${sportWord} ${word} ${day?`· ${day}`:""}`.trim(),
  ];
  const pick = templates[Math.floor(Math.random()*templates.length)];
  return pick().replace(/\s+/g," ").trim();
}

// ── Match Mode Persistent Notification bridge (native Android only) ─────────
// Builds the payload the MatchMode plugin needs to render the notification: one
// row per court, each with the two team names and whether it already has a winner.
const mmTeamLabel = (team) => (team||[]).map(p=>p.nickname).join(" & ");
const mmBreakLabel = (round) => (round?.onBreak||[]).map(p=>p.nickname).join(", ");
// CT Ladder's onBreak holds whole TEAM objects ({name, players:[...]}), not flat player
// objects like CI's — mmBreakLabel would read p.nickname off a team and get undefined.
const mmCTBreakLabel = (round) => (round?.onBreak||[]).map(t=>{
  const names = (t.players||[]).map(p=>p.nickname).join(" & ");
  return t.name ? `${t.name}: ${names}` : names;
}).join(" | ");
// Per-player Dream/Funny badge baked directly into the team label string — the native
// side only ever renders teamA/teamB as plain text, so no native change is needed for
// this part; only the separate balance/meeting line below needs a genuinely new field.
function mmTeamLabelWithBadges(team, comms, oppTeamIds){
  const myIds = (team||[]).map(p=>p.userId);
  return (team||[]).map(p=>{
    const badge = personalMatchBadge(comms||[], p.userId, myIds, oppTeamIds);
    return p.nickname + (badge.isDream?" 🔥":"") + (badge.isFunny?" 😂":"");
  }).join(" & ");
}
// Same power-balance logic as the live Rounds/Matches screens: history-based (📊) once
// there's real head-to-head data, USR-based (⚖️) fallback otherwise. Compact for notification width.
function mmBalanceLabel(comms, teamA, teamB, excludeEventId){
  const idsA=(teamA||[]).map(p=>p.userId), idsB=(teamB||[]).map(p=>p.userId);
  const h2h = calcExactHeadToHead(comms||[], idsA, idsB, {excludeEventId});
  if(h2h.meetings>0) return `📊 ${Math.round(h2h.sideAWinRate*100)}%:${Math.round(h2h.sideBWinRate*100)}% (${h2h.meetings}n)`;
  const avgA=(teamA||[]).reduce((s,p)=>s+p.usr,0)/((teamA||[]).length||1);
  const avgB=(teamB||[]).reduce((s,p)=>s+p.usr,0)/((teamB||[]).length||1);
  if(avgA===avgB) return "";
  const gap=Math.abs(avgA-avgB);
  return `⚖️ ${avgA>avgB?"A":"B"} +${Math.round((gap/((avgA+avgB)/2))*100)}%`;
}
function mmBuildRoundPayload(round, comms, excludeEventId){
  return (round?.matches||[]).map(m=>({
    court: m.court,
    teamA: mmTeamLabelWithBadges(m.teamA, comms, (m.teamB||[]).map(p=>p.userId)),
    teamB: mmTeamLabelWithBadges(m.teamB, comms, (m.teamA||[]).map(p=>p.userId)),
    balance: mmBalanceLabel(comms, m.teamA, m.teamB, excludeEventId),
    winner: m.winner || null, // "A" | "B" | null
  }));
}
// CT Ladder equivalent — same payload shape, one match per court, but reading team.players
// (fixed CT teams) instead of CI's per-round player arrays. League isn't built here — it
// gets its own display-only "currently live" payload builder separately, since League can
// schedule multiple matches per court per round with no single "the current match" concept.
function mmBuildCTLadderPayload(round, comms, excludeEventId){
  return (round?.matchesA||[]).map(m=>{
    const pA=m.teamA?.players||[], pB=m.teamB?.players||[];
    return {
      court: m.court,
      teamA: (m.teamA?.name?m.teamA.name+": ":"") + mmTeamLabelWithBadges(pA, comms, pB.map(p=>p.userId)),
      teamB: (m.teamB?.name?m.teamB.name+": ":"") + mmTeamLabelWithBadges(pB, comms, pA.map(p=>p.userId)),
      balance: mmBalanceLabel(comms, pA, pB, excludeEventId),
      winner: m.winner || null,
    };
  });
}
// League's widget payload — same rich shape as mmBuildCTLadderPayload (team name +
// per-player 🔥/😂 badges + ⚖️/📊 balance), just filtered down to matches the admin has
// flagged live (m.live) AND that don't have a winner yet — a match drops off automatically
// the moment its result gets entered in-app, no need to remember to un-flag it. Display-only
// on the native side (no tap-to-record wired up there): League can have several matches per
// court per round, so there's no single "current match" the widget's tap/court-index
// resolution could target.
function mmBuildCTLeaguePayload(round, comms, excludeEventId){
  const pick = (matches, group) => (matches||[]).filter(m=>m.live && m.winner==null).map(m=>{
    const pA=m.teamA?.players||[], pB=m.teamB?.players||[];
    return {
      court: m.court,
      group,
      teamA: (m.teamA?.name?m.teamA.name+": ":"") + mmTeamLabelWithBadges(pA, comms, pB.map(p=>p.userId)),
      teamB: (m.teamB?.name?m.teamB.name+": ":"") + mmTeamLabelWithBadges(pB, comms, pA.map(p=>p.userId)),
      balance: mmBalanceLabel(comms, pA, pB, excludeEventId),
      winner: null,
    };
  });
  return [...pick(round?.matchesA, "A"), ...pick(round?.matchesB, "B")];
}

// ── Registration capacity + waitlist ───────────────────
// ev.maxPlayers is an independent, optional admin-set cap — deliberately NOT derived from
// courts (courts*4/5/6 is a padel-specific proxy that doesn't generalize, e.g. a 5-a-side
// football session run on one shared pitch with a hard cap of 15 has no clean "courts" value).
// No new data structure for the waitlist itself — active vs. waitlisted is purely a computed
// split of ev.registrations by array position (registration order) against maxPlayers, so
// "promotion" when someone cancels falls out of the math for free rather than needing its own
// state transition. Not to be confused with plan.waitlisted, an unrelated pre-existing concept
// (the single leftover player when Closed Teams has an odd headcount for pairing purposes).
const getMaxPlayers = ev => (ev?.maxPlayers>0 ? ev.maxPlayers : null);
// Registration priority window (2026-08-18): for the first 24h after an event opens
// (ev.regularUntil), only "priority" registrations — Regular members, or anyone the admin
// added/invited/approved directly — can hold an active (non-waitlisted) spot. Casual members
// and guests who self-register during the window go straight onto the waitlist regardless of
// capacity/position (no admin approval needed to register at all, just held back from an active
// spot). Once the window passes, everyone reverts to plain chronological order (registration
// position vs maxPlayers), so anyone waitlisted purely for tier reasons is automatically swept
// into the active list in their original order — no separate "promotion" step needed.
const isPriorityReg = (r, comm) => {
  // addedBy is null for genuine self-service registration (registerEv/sim). "approved" is a
  // guest's join-request being let through by an admin — that only grants them a spot in the
  // QUEUE (guests can't self-register at all, see canReg), it's deliberately NOT priority: they
  // still land on the waitlist during the window and sweep to active after it passes, same as a
  // self-registering Casual member — admin approval isn't the same thing as an admin directly
  // placing someone (Add Member/Add Guest/Invite accept), which DOES bypass the window entirely.
  if (r.addedBy != null && r.addedBy !== "approved") return true;
  return comm?.members?.find(m=>m.userId===r.userId)?.status==="regular";
};
const splitRegsByCapacity = (ev, comm) => {
  const max = getMaxPlayers(ev);
  if (!max) return { active: ev.registrations, waitlisted: [] };
  const windowActive = ev?.regularUntil && Date.now() < new Date(ev.regularUntil).getTime();
  if (!windowActive || !comm) return { active: ev.registrations.slice(0, max), waitlisted: ev.registrations.slice(max) };
  const active=[], waitlisted=[];
  ev.registrations.forEach(r=>{
    if (isPriorityReg(r,comm) && active.length<max) active.push(r);
    else waitlisted.push(r);
  });
  return { active, waitlisted };
};
const isRegWaitlisted = (ev, uid, comm) => splitRegsByCapacity(ev, comm).waitlisted.some(r=>r.userId===uid);
// Subscription suspension on top of the capacity split (Enhancement #17, item 2): a locked
// user's EXISTING registration doesn't get deleted or mutated — it's demoted purely for this
// computed view, same "no new state transition needed" philosophy as the capacity split itself.
// If the event has no capacity cap there's no waitlist to demote into, so locked registrants
// just keep their spot with a Suspended badge (badge-only, no reshuffle) — moving them to a
// waitlist that doesn't structurally exist would need to invent one just for this.
const applySubscriptionSuspension = (split, ev, users, subscriptionSettings) => {
  const suspendedIds = new Set();
  if (!subscriptionSettings?.enabled) return { ...split, suspendedIds };
  const max = getMaxPlayers(ev);
  const ordered = [...split.active, ...split.waitlisted];
  const active=[], waitlisted=[];
  ordered.forEach(r=>{
    const u = users.find(u=>u.id===r.userId);
    const locked = isSubscriptionLocked(u, subscriptionSettings);
    if (locked) suspendedIds.add(r.userId);
    if (locked && max) waitlisted.push(r);
    else if (!max || active.length<max) active.push(r);
    else waitlisted.push(r);
  });
  return { active, waitlisted, suspendedIds };
};

// ── CI scoring ────────────────────────────────────────
const courtPts = (court, tc) => tc - court + 1;
const BREAK_PREF_LABELS = {none:"No Preference", early:"Early", mid:"Mid", late:"Late"};
const breakPts = (tc) => {
  const base = Math.floor((tc + 1) / 2);
  const topCourtWin = courtPts(1, tc); // always equals tc
  return base === topCourtWin ? base - 1 : base; // e.g. 1 court: base=1=topCourtWin=1 → break=0
};

// ── X-System: alternate scoring computed from match details (score margin, opponent USR,
// head-to-head) instead of court position. Pure/read-only — never persisted on its own;
// only used for the Platform-Admin XStandings preview and (optionally, at close time) as the
// source value for the real pes/tes. See PLAN: parallel scoring system.
const USR_XPTS_DIVISOR = 12; // logistic-curve steepness for the expected-outcome calc — lower = sharper (wider spread), higher = flatter (results hug 50)
// Output PES = Entry USR + OUTPUT_PES_K * (that event's average delta) — the "Performance
// Based" view. Flat/linear scale (owner's explicit call — a day that bad deserves the full
// swing, not a dampened one): calibrated so the most extreme real per-event avgDelta on record
// (~0.5, a genuinely outstanding or disastrous day) lands at roughly a ±40-point swing from
// Entry USR. A typical day (median |avgDelta| ~0.09) still only nudges ~±7 points since the
// scale is linear throughout — no curve, no damping near zero.
const OUTPUT_PES_K = 80;
function xMatchValue({myScore, oppScore, won, mySideUsr, oppSideUsr, h2h}) {
  const usrGap = (mySideUsr ?? 50) - (oppSideUsr ?? 50);
  const E = 1 / (1 + Math.pow(10, -usrGap / USR_XPTS_DIVISOR));
  const hasRealScore = !(myScore === 0 && oppScore === 0);
  const marginRatio = hasRealScore ? Math.abs(myScore - oppScore) / (myScore + oppScore) : 0.5;
  const S = won ? 0.5 + 0.5 * marginRatio : 0.5 - 0.5 * marginRatio;
  const delta = S - E;
  let h2hFactor = 1;
  if (h2h && h2h.meetings >= 2) {
    const dominance = h2h.sideAWinRate;
    const surprise = delta > 0 ? (1 - dominance) : dominance;
    h2hFactor = 0.85 + 0.3 * surprise;
  }
  const xPts = Math.max(0, Math.min(100, 50 + 50 * (delta * h2hFactor)));
  return {E: Math.round(E * 1000) / 1000, S: Math.round(S * 1000) / 1000, delta: Math.round(delta * 1000) / 1000, h2hFactor: Math.round(h2hFactor * 1000) / 1000, xPts: Math.round(xPts * 10) / 10, hasRealScore};
}
// Distance from a player's preferred break window to round r — lower is more preferred.
// Soft signal only: used as the last tiebreaker, after fairness/urgency/spacing are already equal.
function prefDist(pref, r, totalRounds) {
  if (pref==="early") return r;
  if (pref==="late") return (totalRounds-1-r);
  if (pref==="mid") return Math.abs(r-(totalRounds-1)/2);
  return 0;
}

// ── CI Break Plan ─────────────────────────────────────
function buildBreakPlan(players, courts, totalRounds) {
  const N = players.length, bpr = N - courts * 4;
  if (bpr <= 0) return Array.from({ length: totalRounds }, () => []);
  const totalSlots = bpr * totalRounds, base = Math.floor(totalSlots / N), extras = totalSlots % N;
  // Priority: most historical breaks = lower priority; equal history = lowest USR first
  const sorted = [...players].sort((a, b) => {
    const hDiff = (b.histBreaks||0) - (a.histBreaks||0);
    if (hDiff !== 0) return hDiff;
    return a.usr - b.usr; // lower USR gets break first
  });
  const ent = {}; sorted.forEach((p, i) => { ent[p.userId] = base + (i < extras ? 1 : 0); });
  const assigned = {}, lastB = {}; players.forEach(p => { assigned[p.userId] = 0; lastB[p.userId] = -99; });
  const plan = [];
  for (let r = 0; r < totalRounds; r++) {
    const eligible = players.filter(p => assigned[p.userId] < ent[p.userId]);
    const isAnchor = p => p.breakPref && p.breakPref!=="none" && prefDist(p.breakPref,r,totalRounds)===0;
    eligible.sort((a, b) => {
      const anchA = isAnchor(a)?1:0, anchB = isAnchor(b)?1:0;
      if (anchA!==anchB) return anchB-anchA; // anchor match at this exact round wins first, regardless of entitlement
      const rd = (ent[b.userId]-assigned[b.userId])-(ent[a.userId]-assigned[a.userId]); if (rd!==0) return rd;
      const pd = prefDist(a.breakPref,r,totalRounds)-prefDist(b.breakPref,r,totalRounds); if (pd!==0) return pd; // among non-anchor-matches, closer preference still wins ties
      const spacing = (r-lastB[b.userId])-(r-lastB[a.userId]); if (spacing!==0) return spacing;
      return 0;
    });
    const noC = eligible.filter(p => r - lastB[p.userId] > 1);
    const pool = noC.length >= bpr ? noC : eligible;
    const chosen = pool.slice(0, bpr).map(p => p.userId);
    chosen.forEach(uid => { assigned[uid]++; lastB[uid] = r; });
    plan.push(chosen);
  }
  return plan;
}
function snakePairCI(cp) { return { teamA:[cp[0],cp[3]], teamB:[cp[1],cp[2]] }; }
const pairKey = (a,b) => a<b ? `${a}_${b}` : `${b}_${a}`;
function diversePair(cp, ph, lastRoundPairs) {
  const opts = [[[0,1],[2,3]],[[0,2],[1,3]],[[0,3],[1,2]]];
  const scored = opts.map(([a,b]) => {
    const keyA = pairKey(cp[a[0]].userId, cp[a[1]].userId);
    const keyB = pairKey(cp[b[0]].userId, cp[b[1]].userId);
    const repeatsLastRound = !!(lastRoundPairs && (lastRoundPairs.has(keyA) || lastRoundPairs.has(keyB)));
    const repeatScore = (ph[cp[a[0]].userId]?.[cp[a[1]].userId]||0) + (ph[cp[b[0]].userId]?.[cp[b[1]].userId]||0);
    const balanceGap = Math.abs((cp[a[0]].usr+cp[a[1]].usr) - (cp[b[0]].usr+cp[b[1]].usr));
    return {a,b,repeatsLastRound,repeatScore,balanceGap};
  });
  // Hard rule: never repeat the immediately-previous round's partnership if a valid
  // alternative exists (with 4 players there are always 2 alternatives that split them).
  const nonRepeat = scored.filter(s=>!s.repeatsLastRound);
  const pool = nonRepeat.length>0 ? nonRepeat : scored;
  // Minimize event-long partner repetition first; Balance Gap is the explicit tiebreaker
  // when repetition scores are equal, per the Match Generation Engine spec.
  pool.sort((x,y) => x.repeatScore-y.repeatScore || x.balanceGap-y.balanceGap);
  const best = pool[0];
  return { teamA:[cp[best.a[0]],cp[best.a[1]]], teamB:[cp[best.b[0]],cp[best.b[1]]] };
}
function genRound1(players, courts, totalRounds) {
  const sorted = [...players].sort((a,b)=>b.usr-a.usr), breakPlan = buildBreakPlan(sorted,courts,totalRounds), onBreakIds=breakPlan[0]||[];
  const playing=sorted.filter(p=>!onBreakIds.includes(p.userId));
  const onBreak=sorted.filter(p=>onBreakIds.includes(p.userId)).map(p=>({...p, wouldBeCourt: Math.floor(sorted.findIndex(x=>x.userId===p.userId)/4)+1}));
  const matches=[]; for(let c=0;c<courts;c++){const cp=playing.slice(c*4,(c+1)*4);if(cp.length<4)break;const pair=snakePairCI(cp);matches.push({court:c+1,teamA:pair.teamA,teamB:pair.teamB,winner:null});}
  return {rounds:[{round:1,matches,onBreak,onBreakIds}],courts,totalRounds,breakPlan,partnerHistory:{},sorted};
}
// retiredIds: players marked retired mid-event (Enhancement #24) — dropped from every future
// round's matches AND break list from here on (they stop accruing anything, matches or break
// points, the instant they retire). If dropping one from a court's win/loss bucket leaves it
// short, backfill from this round's own break pool (fewest breaks-so-far called up first, same
// priority order buildBreakPlan itself uses) rather than leaving a court empty.
function genNextRoundCI(plan, retiredIds=[]) {
  const {rounds,courts,breakPlan,sorted}=plan, ri=rounds.length, lastRound=rounds[ri-1];
  const ph=JSON.parse(JSON.stringify(plan.partnerHistory||{}));
  const lastRoundPairs=new Set();
  lastRound.matches.forEach(m=>{[m.teamA,m.teamB].forEach(team=>{const[a,b]=team;if(!a||!b)return;if(!ph[a.userId])ph[a.userId]={};if(!ph[b.userId])ph[b.userId]={};ph[a.userId][b.userId]=(ph[a.userId][b.userId]||0)+1;ph[b.userId][a.userId]=(ph[b.userId][a.userId]||0)+1;lastRoundPairs.add(pairKey(a.userId,b.userId));});});
  const newBreakIds=breakPlan[ri]||[], buckets={};
  for(let c=1;c<=courts;c++) buckets[c]=[];
  lastRound.matches.forEach(m=>{if(!m.winner)return;const W=m.winner==="A"?m.teamA:m.teamB,L=m.winner==="A"?m.teamB:m.teamA;W.forEach(p=>buckets[Math.max(1,m.court-1)].push(p));L.forEach(p=>buckets[Math.min(courts,m.court+1)].push(p));});
  for(let c=1;c<=courts;c++) buckets[c]=buckets[c].filter(p=>!newBreakIds.includes(p.userId)&&!retiredIds.includes(p.userId));
  // Where a player belongs (whether returning from break, or newly going on break this round)
  // is not "the court they last sat on" — it's the court their last ACTUAL result would have
  // earned them (win promotes, loss relegates), applying the same movement rule as everyone
  // else. Scans backward since they may have broken for more than one round in a row.
  const findExpectedReturnCourt=(uid)=>{
    for(let i=rounds.length-1;i>=0;i--){
      for(const m of rounds[i].matches){
        const inA=m.teamA.some(p=>p.userId===uid), inB=m.teamB.some(p=>p.userId===uid);
        if(inA||inB){
          if(!m.winner) return m.court; // no recorded result yet — fall back to their last court
          const won=(inA&&m.winner==="A")||(inB&&m.winner==="B");
          return won ? Math.max(1,m.court-1) : Math.min(courts,m.court+1);
        }
      }
    }
    return null;
  };
  const onBreak=sorted.filter(p=>newBreakIds.includes(p.userId)&&!retiredIds.includes(p.userId)).map(p=>({...p, wouldBeCourt: findExpectedReturnCourt(p.userId)}));
  const returning=sorted.filter(p=>(lastRound.onBreakIds||[]).includes(p.userId)&&!newBreakIds.includes(p.userId)&&!retiredIds.includes(p.userId));
  returning.forEach(rp=>{
    const targetCourt=findExpectedReturnCourt(rp.userId);
    const sameCourtHasRoom=targetCourt&&buckets[targetCourt]&&buckets[targetCourt].length<4;
    if(sameCourtHasRoom){ buckets[targetCourt].push(rp); return; }
    const needy=Object.entries(buckets).filter(([,ps])=>ps.length<4).sort((a,b)=>a[1].length-b[1].length)[0];
    if(needy)buckets[parseInt(needy[0])].push(rp);
  });
  if(retiredIds.length){
    const breakCountSoFar={};
    rounds.forEach(r=>(r.onBreakIds||[]).forEach(uid=>{breakCountSoFar[uid]=(breakCountSoFar[uid]||0)+1;}));
    const callUpPool=[...onBreak].sort((a,b)=>(breakCountSoFar[a.userId]||0)-(breakCountSoFar[b.userId]||0));
    for(let c=1;c<=courts;c++){
      while(buckets[c].length>0&&buckets[c].length<4&&callUpPool.length){
        const p=callUpPool.shift();
        buckets[c].push(p);
        const oi=onBreak.findIndex(x=>x.userId===p.userId); if(oi>=0) onBreak.splice(oi,1);
      }
    }
  }
  const matches=[]; for(let c=1;c<=courts;c++){const cp=buckets[c].slice(0,4);if(cp.length<4)continue;const pair=diversePair(cp,ph,lastRoundPairs);matches.push({court:c,teamA:pair.teamA,teamB:pair.teamB,winner:null});}
  return {...plan,rounds:[...rounds,{round:ri+1,matches,onBreak,onBreakIds:newBreakIds.filter(id=>!retiredIds.includes(id))}],partnerHistory:ph};
}
function regenerateBreakPlan(plan, playedRounds) {
  // Keep breaks for played rounds as-is
  // Recompute breaks for future rounds respecting rules
  const players = plan.sorted;
  const courts = plan.courts;
  const totalRounds = plan.totalRounds;
  const bpr = Math.max(0, players.length - courts*4);
  if (bpr === 0) return plan.breakPlan;
  const firmBreaks = plan.firmBreaks || {}; // {roundIndex: [userId,...]} — admin-locked breaks that must survive regeneration untouched

  // Count breaks already assigned in played rounds
  const breakCounts = {};
  players.forEach(p => { breakCounts[p.userId] = 0; });
  const fixedPlan = plan.breakPlan.slice(0, playedRounds);
  fixedPlan.forEach(round => {
    round.forEach(uid => { if(breakCounts[uid]!==undefined) breakCounts[uid]++; });
  });
  // Firm breaks in the recomputable range are mandatory — count them toward fairness too,
  // same as any other break, before distributing the remaining slots.
  for (let r = playedRounds; r < totalRounds; r++) {
    (firmBreaks[r]||[]).forEach(uid => { if(breakCounts[uid]!==undefined) breakCounts[uid]++; });
  }

  // Total breaks needed across all rounds
  const totalSlots = bpr * totalRounds;
  const base = Math.floor(totalSlots / players.length);
  const extras = totalSlots % players.length;

  // Sort by who has fewest breaks so far (then by lowest USR)
  const sortedByNeed = [...players].sort((a,b) => {
    const needDiff = (breakCounts[b.userId]||0) - (breakCounts[a.userId]||0);
    if (needDiff !== 0) return needDiff; // more breaks = lower priority
    return a.usr - b.usr; // lower USR = higher priority for break
  });

  // Target entitlement for each player
  const ent = {};
  sortedByNeed.forEach((p,i) => { ent[p.userId] = base + (i<extras?1:0); });

  // Remaining breaks needed per player (firm breaks already subtracted via breakCounts above)
  const remaining = {};
  players.forEach(p => {
    remaining[p.userId] = Math.max(0, ent[p.userId] - (breakCounts[p.userId]||0));
  });

  // Generate future rounds
  const futurePlan = [];
  const lastBreak = {};
  players.forEach(p => { lastBreak[p.userId] = -99; });

  // Find last break in fixed plan
  fixedPlan.forEach((round, ri) => {
    round.forEach(uid => { lastBreak[uid] = ri; });
  });

  for (let r = playedRounds; r < totalRounds; r++) {
    const firmHere = firmBreaks[r] || [];
    firmHere.forEach(uid => { lastBreak[uid] = r; }); // firm players occupy this round's break slot(s), fixed
    const slotsLeft = Math.max(0, bpr - firmHere.length);

    const eligible = players.filter(p => remaining[p.userId] > 0 && !firmHere.includes(p.userId));
    eligible.sort((a,b) => {
      const isAnchor = p => p.breakPref && p.breakPref!=="none" && prefDist(p.breakPref,r,totalRounds)===0;
      const anchA = isAnchor(a)?1:0, anchB = isAnchor(b)?1:0;
      if (anchA!==anchB) return anchB-anchA; // anchor match at this exact round wins first
      const remDiff = remaining[b.userId] - remaining[a.userId];
      if (remDiff !== 0) return remDiff;
      const pd = prefDist(a.breakPref,r,totalRounds)-prefDist(b.breakPref,r,totalRounds); if (pd!==0) return pd;
      const consecA = r - lastBreak[a.userId] <= 1 ? 1 : 0;
      const consecB = r - lastBreak[b.userId] <= 1 ? 1 : 0;
      if (consecA !== consecB) return consecA - consecB; // avoid consecutive
      return a.usr - b.usr; // lower USR priority
    });
    const noConsec = eligible.filter(p => r - lastBreak[p.userId] > 1);
    const pool = noConsec.length >= slotsLeft ? noConsec : eligible;
    const chosenExtra = pool.slice(0, slotsLeft).map(p => p.userId);
    chosenExtra.forEach(uid => { remaining[uid]--; lastBreak[uid] = r; });
    futurePlan.push([...firmHere, ...chosenExtra]);
  }

  return [...fixedPlan, ...futurePlan];
}

function calcCIStandings(plan, users) {
  if(!plan)return[]; const tc=plan.courts, pts={};
  plan.rounds.forEach(r=>{(r.onBreak||[]).forEach(p=>{if(!pts[p.userId])pts[p.userId]={pts:0,wins:0,breaks:0,played:0,courtWinSum:0};pts[p.userId].pts+=breakPts(tc);pts[p.userId].breaks++;});r.matches.forEach(m=>{if(!m.winner)return;const wp=courtPts(m.court,tc),W=m.winner==="A"?m.teamA:m.teamB,L=m.winner==="A"?m.teamB:m.teamA;
    // courtWinSum: higher-level courts (lower court number = stronger) contribute more — use (tc - court + 1) as weight
    const courtWeight = tc - m.court + 1;
    W.forEach(p=>{if(!pts[p.userId])pts[p.userId]={pts:0,wins:0,breaks:0,played:0,courtWinSum:0};pts[p.userId].pts+=wp;pts[p.userId].wins++;pts[p.userId].played++;pts[p.userId].courtWinSum+=courtWeight;});
    L.forEach(p=>{if(!pts[p.userId])pts[p.userId]={pts:0,wins:0,breaks:0,played:0,courtWinSum:0};pts[p.userId].played++;});});});
  return Object.entries(pts).map(([uid,s])=>({...s,user:users.find(u=>u.id===parseInt(uid))})).filter(s=>s.user).sort((a,b)=>
    b.pts-a.pts ||           // 1. Points
    b.wins-a.wins ||         // 2. Total wins (absolute)
    b.courtWinSum-a.courtWinSum   // 3. Court-weighted wins (wins on stronger courts count more)
    // 4. Still tied after all of the above = genuine tie
  );
}
function maxPossibleCI(plan){
  // One unified max for every player (not per-player) — uses the average number of
  // breaks any player would get across the rounds played so far, so a scheduled break
  // still lowers everyone's theoretical ceiling equally rather than each player having
  // their own personal denominator. Same approach as ctEventMaxPts for consistency.
  if(!plan)return 0;
  const tc=plan.courts;
  const generatedRounds=plan.rounds.length;
  const numPlayers=plan.sorted?.length||0;
  if(generatedRounds===0||numPlayers===0) return generatedRounds*courtPts(1,tc);
  const totalBreakSlots=plan.breakPlan.slice(0,generatedRounds).reduce((n,r)=>n+(r?.length||0),0);
  const avgBreaks=Math.round(totalBreakSlots/numPlayers);
  return (generatedRounds-avgBreaks)*courtPts(1,tc) + avgBreaks*breakPts(tc);
}
// Personal (per-player) theoretical max — uses that specific player's ACTUAL break
// count in the event rather than an event-wide average, so PES% reflects what that
// player individually could have achieved. Replaces maxPossibleCI wherever a real
// per-player PES/USR figure is needed.
function personalMaxCI(breaks, generatedRounds, tc){
  return (generatedRounds-breaks)*courtPts(1,tc) + breaks*breakPts(tc);
}
// How many rounds should count toward a player's theoretical max — normally the whole event
// (plan.rounds.length), but a retired player (Enhancement #24) stops being generated into any
// round after they retire, so counting the full event length against them would understate
// their PES. Capped at the round of their last real appearance (played or on break) instead.
function personalRoundsCI(uid, plan){
  for(let i=plan.rounds.length-1;i>=0;i--){
    const r=plan.rounds[i];
    const played=r.matches.some(m=>m.teamA.some(p=>p.userId===uid)||m.teamB.some(p=>p.userId===uid));
    const onBreak=(r.onBreakIds||[]).includes(uid);
    if(played||onBreak) return i+1;
  }
  return plan.rounds.length;
}
// Historical padel USR "as of that event" — captured once when the event's plan/rounds were
// generated (plan.sorted for Closed Individuals, plan.teams[].players for Closed Teams), not
// the player's current live USR, which drifts over time via later events. Anywhere a player's
// name is shown in the context of a specific (padel) event should use this, not u.usr, per
// explicit admin request 2026-08-18 — falls back to liveUsr when no snapshot exists yet (no
// plan generated, e.g. Open Day, or Closed events before Round 1 / team formation).
function historicUsr(uid, plan, liveUsr){
  if(!plan) return liveUsr;
  if(plan.sorted){
    const p=plan.sorted.find(p=>p.userId===uid);
    if(p) return p.usr;
  }
  if(plan.teams){
    for(const t of plan.teams){
      const p=t.players?.find(p=>p.userId===uid);
      if(p) return p.usr;
    }
  }
  return liveUsr;
}

// X-System preview for Closed Individuals — per-player xPES computed from match details
// (score margin, opponent USR, head-to-head) instead of court position. Pure/read-only,
// nothing persisted. See PLAN: parallel scoring system.
function calcXCIPreview(plan, users, comms, ev) {
  if (!plan) return [];
  const perPlayer = {};
  const nameOf = uid => users.find(u=>u.id===uid)?.nickname ?? "—";
  // USR comes from the match's OWN snapshot (the same p.usr baked in at round-generation time
  // that the live match card displays as "TEAM A (NN)"), not a fresh lookup against the
  // current users array — for an old event, current USR has drifted since, and using it here
  // would silently disagree with the balance the live card showed for this exact match.
  const teamUsr = team => team.length ? team.reduce((s,p)=>s+(p.usr??50),0)/team.length : 50;
  plan.rounds.forEach((r, ri) => {
    r.matches.forEach(m => {
      if (!m.winner) return;
      const idsA = m.teamA.map(p=>p.userId), idsB = m.teamB.map(p=>p.userId);
      const usrA = teamUsr(m.teamA), usrB = teamUsr(m.teamB);
      const scoreA = m.scoreA||0, scoreB = m.scoreB||0;
      const h2h = calcExactHeadToHead(comms||[], idsA, idsB, {excludeEventId: ev?.id, beforeRound: ri});
      const h2hFlipped = {...h2h, sideAWinRate: h2h.sideBWinRate, sideBWinRate: h2h.sideAWinRate};
      // mySideUsr (teamUsr, blended with the round's partner) drives the Expected-outcome (E)
      // calc — that's correctly the actual on-court balance for this match. entryUsr for the
      // Output PES anchor is different on purpose: each player's OWN individual snapshot usr
      // from this side's roster, not blended with whoever they happened to be paired with —
      // otherwise a strong player's baseline would silently shift depending on which random
      // partner they got in their first round, undermining Output PES's whole point of
      // crediting individual performance instead of a team/court proxy.
      const process = (ids, oppIds, mySideUsr, oppSideUsr, myScore, oppScore, won, sideH2h, mySideTeam) => {
        ids.forEach(uid => {
          const u = users.find(x=>x.id===uid); if (!u) return;
          const partnerId = ids.find(id=>id!==uid) ?? null;
          const res = xMatchValue({myScore, oppScore, won, mySideUsr, oppSideUsr, h2h: sideH2h});
          const ownUsr = mySideTeam.find(p=>p.userId===uid)?.usr ?? mySideUsr;
          if (!perPlayer[uid]) perPlayer[uid] = {userId: uid, user: u, entryUsr: ownUsr, matches: []};
          perPlayer[uid].matches.push({round: ri+1, court: m.court, won, partnerId, partnerName: partnerId!=null?nameOf(partnerId):null, oppIds, oppNames: oppIds.map(nameOf), scoreA: myScore, scoreB: oppScore, hasRealScore: res.hasRealScore, E: res.E, S: res.S, delta: res.delta, h2hFactor: res.h2hFactor, xPts: res.xPts});
        });
      };
      process(idsA, idsB, usrA, usrB, scoreA, scoreB, m.winner==="A", h2h, m.teamA);
      process(idsB, idsA, usrB, usrA, scoreB, scoreA, m.winner==="B", h2hFlipped, m.teamB);
    });
  });
  return Object.values(perPlayer)
    .map(p => {
      const avgDelta = p.matches.reduce((s,x)=>s+x.delta*x.h2hFactor,0)/p.matches.length;
      return {
        ...p,
        avgDelta,
        xPES: Math.round((p.matches.reduce((s,x)=>s+x.xPts,0)/p.matches.length) * 10) / 10,
        outputPES: Math.round(Math.max(0,Math.min(100, p.entryUsr + OUTPUT_PES_K*avgDelta)) * 10) / 10,
      };
    })
    .sort((a,b)=>b.xPES-a.xPES);
}

// ════════════════════════════════════════════════════
//  PARTNER / OPPONENT REPORTS — unified across Closed Individuals AND
//  Closed Teams. "Partner" means whoever was on your side of the net for
//  a given match, regardless of whether that pairing rotated every round
//  (CI) or was fixed for the whole event (CT) — same relationship, same
//  counter. Live-computed from official (closed) event history already
//  held in memory — nothing here is persisted. Same official-results-only
//  rule as the USR engine: only ev.status==="completed" counts.
// ════════════════════════════════════════════════════
const REPORT_MIN_MATCHES = 3;
const REPORT_RECENT_DAYS = 183; // ~6 months
function calcPartnerOpponentStats(comms, userId, opts){
  const recentOnly = opts && opts.recentOnly;
  const cutoffTime = recentOnly ? Date.now()-REPORT_RECENT_DAYS*24*60*60*1000 : null;
  const partners = {}, opponents = {};
  const recordPartner=(partner,ev,won,oppPlayers,score,type)=>{
    if(!partners[partner.userId]) partners[partner.userId]={userId:partner.userId,nickname:partner.nickname,matches:0,wins:0,history:[]};
    const rec=partners[partner.userId];
    rec.matches++; if(won) rec.wins++;
    rec.history.push({eventId:ev.id,eventName:ev.name,date:ev.date,type,won,against:oppPlayers.map(p=>({userId:p.userId,nickname:p.nickname})),score});
  };
  const recordOpponent=(opp,ev,won,partner,oppPartner,score,type)=>{
    if(!opponents[opp.userId]) opponents[opp.userId]={userId:opp.userId,nickname:opp.nickname,matches:0,losses:0,history:[]};
    const rec=opponents[opp.userId];
    rec.matches++; if(!won) rec.losses++;
    rec.history.push({eventId:ev.id,eventName:ev.name,date:ev.date,type,won,
      partner:partner?{userId:partner.userId,nickname:partner.nickname}:null,
      oppPartner:oppPartner?{userId:oppPartner.userId,nickname:oppPartner.nickname}:null,
      score});
  };
  comms.forEach(c=>(c.events||[]).forEach(ev=>{
    if(ev.status!=="completed"||!ev.plan) return;
    if(cutoffTime && new Date(ev.date).getTime()<cutoffTime) return;
    if(ev.type==="closed_ind"){
      ev.plan.rounds.forEach(r=>r.matches.forEach(m=>{
        if(!m.winner) return;
        const inA=m.teamA.some(p=>p.userId===userId), inB=m.teamB.some(p=>p.userId===userId);
        if(!inA&&!inB) return;
        const myTeam=inA?m.teamA:m.teamB, oppTeam=inA?m.teamB:m.teamA;
        const won=(inA&&m.winner==="A")||(inB&&m.winner==="B");
        const partner=myTeam.find(p=>p.userId!==userId);
        const score=(m.scoreA!=null&&m.scoreB!=null)?{for:inA?m.scoreA:m.scoreB, against:inA?m.scoreB:m.scoreA}:null;
        if(partner) recordPartner(partner,ev,won,oppTeam,score,"ci");
        oppTeam.forEach(opp=>{
          const oppPartner=oppTeam.find(p=>p.userId!==opp.userId);
          recordOpponent(opp,ev,won,partner,oppPartner,score,"ci");
        });
      }));
    }else if(ev.type==="closed_teams"){
      ev.plan.rounds.forEach(r=>{
        [...(r.matchesA||[]),...(r.matchesB||[])].forEach(m=>{
          if(!m.winner||!m.teamA?.players||!m.teamB?.players) return;
          const inA=m.teamA.players.some(p=>p.userId===userId), inB=m.teamB.players.some(p=>p.userId===userId);
          if(!inA&&!inB) return;
          const myPlayers=inA?m.teamA.players:m.teamB.players, oppPlayers=inA?m.teamB.players:m.teamA.players;
          const won=(inA&&m.winner==="A")||(inB&&m.winner==="B");
          const partner=myPlayers.find(p=>p.userId!==userId);
          const score=(m.scoreA!=null&&m.scoreB!=null)?{for:inA?m.scoreA:m.scoreB, against:inA?m.scoreB:m.scoreA}:null;
          if(partner) recordPartner(partner,ev,won,oppPlayers,score,"ct");
          oppPlayers.forEach(opp=>{
            const oppPartner=oppPlayers.find(p=>p.userId!==opp.userId);
            recordOpponent(opp,ev,won,partner,oppPartner,score,"ct");
          });
        });
      });
    }
  }));
  const sortHist=h=>[...h].sort((a,b)=>b.date.localeCompare(a.date));
  const partnersArr = Object.values(partners).map(p=>({...p, winRate: p.matches?p.wins/p.matches:0, history:sortHist(p.history)}));
  const opponentsArr = Object.values(opponents).map(o=>({...o, loseRate: o.matches?o.losses/o.matches:0, history:sortHist(o.history)}));
  return {
    partnersRanked: partnersArr.filter(p=>p.matches>=REPORT_MIN_MATCHES).sort((a,b)=>b.winRate-a.winRate||b.matches-a.matches),
    partnersInsufficient: partnersArr.filter(p=>p.matches<REPORT_MIN_MATCHES).sort((a,b)=>b.matches-a.matches),
    opponentsRanked: opponentsArr.filter(o=>o.matches>=REPORT_MIN_MATCHES).sort((a,b)=>b.loseRate-a.loseRate||b.matches-a.matches),
    opponentsInsufficient: opponentsArr.filter(o=>o.matches<REPORT_MIN_MATCHES).sort((a,b)=>b.matches-a.matches),
  };
}
// Dream Match: player + #1 partner vs #1+#2 opponents. Funny Match: player + weakest
// partner vs weakest 2 opponents. Both hide entirely (return null) if any slot lacks a
// ranked (>=3 match) entry — per spec, no placeholder message, just absent.
// A player can independently rank as both a top partner and a tough/easy opponent — those
// come from different match subsets (played together vs played against) — but they can't
// stand on both sides of the same hypothetical match. Once the partner is fixed, they're
// excluded from the opponent pool and the next-best candidate takes their place instead.
function calcDreamOrFunnyMatch(stats, kind){
  const {partnersRanked, opponentsRanked} = stats;
  if(partnersRanked.length<1||opponentsRanked.length<2) return null;
  const partner = kind==="dream" ? partnersRanked[0] : partnersRanked[partnersRanked.length-1];
  const eligibleOpponents = opponentsRanked.filter(o=>o.userId!==partner.userId);
  if(eligibleOpponents.length<2) return null;
  const opps = kind==="dream" ? [eligibleOpponents[0],eligibleOpponents[1]] : [eligibleOpponents[eligibleOpponents.length-1],eligibleOpponents[eligibleOpponents.length-2]];
  return {partner, opponents:opps};
}
// Dream/Funny Match is one player's personal view of a matchup, not a court-wide fact — two
// different players on the very same court can each have their own (or no) reason this
// specific composition matters to them. Checked independently per player: does THIS exact
// pairing (their teammate + the two people across the net) match what calcDreamOrFunnyMatch
// already picked out as their #1 partner vs toughest/easiest two opponents?
function personalMatchBadge(comms, playerId, myTeamIds, oppTeamIds){
  const partnerId = myTeamIds.find(id=>id!==playerId);
  if(partnerId==null) return {isDream:false, isFunny:false};
  const oppSet = new Set(oppTeamIds);
  const sameOpp = arr => arr.length===oppSet.size && arr.every(id=>oppSet.has(id));
  const stats = calcPartnerOpponentStats(comms, playerId);
  const dream = calcDreamOrFunnyMatch(stats,"dream");
  const funny = calcDreamOrFunnyMatch(stats,"funny");
  return {
    isDream: !!(dream && dream.partner.userId===partnerId && sameOpp(dream.opponents.map(o=>o.userId))),
    isFunny: !!(funny && funny.partner.userId===partnerId && sameOpp(funny.opponents.map(o=>o.userId))),
  };
}
// Surfaces a recorded CT team name (see setComboName) when the same two players happen to
// land on the same side of a CI match — "accidental" reunions of a named combo get labeled
// even though CI has no persistent team entity of its own.
function ctComboLabel(team){
  if(!team||team.length!==2)return null;
  const [a,b]=team;
  const ck=[a.userId,b.userId].sort().join("_");
  return a.comboNames?.[ck] || b.comboNames?.[ck] || null;
}
// Head-to-head record between two exact sides (Closed Individuals: 2-player sets; Closed
// Teams: single team's player-id set), regardless of which side was historically "teamA" vs
// "teamB" — matches purely by identity, not by A/B label. Exact-foursome only (the two teams
// must match completely, not just overlap): every consumer of this — the live 📊/⚖️ balance
// badge on Rounds/Matches, the Match Mode notification widget, the X-System H2H modifier,
// and the Dream/Funny Match "this exact matchup happened N times" line — wants the same
// precise question answered: have these specific people, in this specific split, met before.
// A looser "has anyone from side A ever faced anyone from side B, with any partner" variant
// existed briefly (Bug #15's first pass) but was replaced everywhere per explicit admin
// direction: a blended number across different partnerships isn't what any of these consumers
// should show, even though it means CI matches (which rotate partners every round) will
// usually report zero prior meetings — that's the accurate answer, not a bug.
// opts.excludeEventId marks "the event currently being evaluated" — if opts.beforeRound is
// also given, that event's own rounds strictly before it still count (so a rematch earlier
// in the same, still-open event is a real "previous meeting"); otherwise that event is
// skipped entirely, for callers that don't have a round index handy.
function calcExactHeadToHeadCI(comms, sideAIds, sideBIds, opts){
  const excludeEventId = opts && opts.excludeEventId;
  const beforeRound = opts && opts.beforeRound;
  const setA = new Set(sideAIds), setB = new Set(sideBIds);
  const sameSet = (arr, set) => arr.length===set.size && arr.every(id=>set.has(id));
  let meetings=0, sideAWins=0, sideBWins=0, last=null;
  comms.forEach(c=>(c.events||[]).forEach(ev=>{
    if(ev.type!=="closed_ind"||!ev.plan) return;
    const isCurrent = excludeEventId!=null && ev.id===excludeEventId;
    if(isCurrent){ if(beforeRound==null) return; } else if(ev.status!=="completed") return;
    ev.plan.rounds.forEach((r,ri)=>{
      if(isCurrent && ri>=beforeRound) return;
      r.matches.forEach(m=>{
        if(!m.winner) return;
        const idsA=m.teamA.map(p=>p.userId), idsB=m.teamB.map(p=>p.userId);
        let sideAIsMatchTeamA;
        if(sameSet(idsA,setA)&&sameSet(idsB,setB)) sideAIsMatchTeamA=true;
        else if(sameSet(idsA,setB)&&sameSet(idsB,setA)) sideAIsMatchTeamA=false;
        else return;
        meetings++;
        const matchTeamAWon = m.winner==="A";
        const sideAWon = sideAIsMatchTeamA ? matchTeamAWon : !matchTeamAWon;
        if(sideAWon) sideAWins++; else sideBWins++;
        if(!last||ev.date>last.date) last={date:ev.date, eventId:ev.id, eventName:ev.name, sideAWon};
      });
    });
  }));
  return {meetings, sideAWins, sideBWins, sideAWinRate: meetings?sideAWins/meetings:0, sideBWinRate: meetings?sideBWins/meetings:0, last};
}
function calcExactHeadToHeadCT(comms, sideAPlayerIds, sideBPlayerIds, opts){
  const excludeEventId = opts && opts.excludeEventId;
  const beforeRound = opts && opts.beforeRound;
  const setA = new Set(sideAPlayerIds), setB = new Set(sideBPlayerIds);
  const sameSet = (arr, set) => arr.length===set.size && arr.every(id=>set.has(id));
  let meetings=0, sideAWins=0, sideBWins=0, last=null;
  comms.forEach(c=>(c.events||[]).forEach(ev=>{
    if(ev.type!=="closed_teams"||!ev.plan) return;
    const isCurrent = excludeEventId!=null && ev.id===excludeEventId;
    if(isCurrent){ if(beforeRound==null) return; } else if(ev.status!=="completed") return;
    ev.plan.rounds.forEach((r,ri)=>{
      if(isCurrent && ri>=beforeRound) return;
      [...(r.matchesA||[]),...(r.matchesB||[])].forEach(m=>{
        if(!m.winner||!m.teamA?.players||!m.teamB?.players) return;
        const idsA=m.teamA.players.map(p=>p.userId), idsB=m.teamB.players.map(p=>p.userId);
        let sideAIsMatchTeamA;
        if(sameSet(idsA,setA)&&sameSet(idsB,setB)) sideAIsMatchTeamA=true;
        else if(sameSet(idsA,setB)&&sameSet(idsB,setA)) sideAIsMatchTeamA=false;
        else return;
        meetings++;
        const matchTeamAWon = m.winner==="A";
        const sideAWon = sideAIsMatchTeamA ? matchTeamAWon : !matchTeamAWon;
        if(sideAWon) sideAWins++; else sideBWins++;
        if(!last||ev.date>last.date) last={date:ev.date, eventId:ev.id, eventName:ev.name, sideAWon};
      });
    });
  }));
  return {meetings, sideAWins, sideBWins, sideAWinRate: meetings?sideAWins/meetings:0, sideBWinRate: meetings?sideBWins/meetings:0, last};
}
function calcExactHeadToHead(comms, sideAIds, sideBIds, opts){
  const ci = calcExactHeadToHeadCI(comms, sideAIds, sideBIds, opts);
  const ct = calcExactHeadToHeadCT(comms, sideAIds, sideBIds, opts);
  const meetings = ci.meetings+ct.meetings;
  const sideAWins = ci.sideAWins+ct.sideAWins, sideBWins = ci.sideBWins+ct.sideBWins;
  const last = !ci.last ? ct.last : !ct.last ? ci.last : (ci.last.date>=ct.last.date ? ci.last : ct.last);
  return {meetings, sideAWins, sideBWins, sideAWinRate: meetings?sideAWins/meetings:0, sideBWinRate: meetings?sideBWins/meetings:0, last};
}

// ════════════════════════════════════════════════════
//  CT ENGINE — FIXED
// ════════════════════════════════════════════════════

function calcCTCourts(playerCount, reservedCourts) {
  let min = Math.ceil(playerCount / 6);
  if (min * 4 > playerCount) min--;
  if (min < 1) min = 1;
  let max = min + 1;
  if (max * 4 > playerCount) max = min;
  const cappedMin = Math.min(min, reservedCourts);
  const cappedMax = Math.min(max, reservedCourts);
  return { min:cappedMin, max:cappedMax, warning:max>reservedCourts?`Ideal: ${max} courts but only ${reservedCourts} reserved`:null };
}

function segmentPools(players, topPoolSizeOverride) {
  const sorted = [...players].sort((a,b) => b.usr - a.usr);
  const N = sorted.length;
  // Manual override: only meaningful for a clean 2-pool split (the common ambiguous case,
  // e.g. 14 players = 8+6 — should the top 8 or the top 6 be the elite group?). Both sizes
  // must be even (teams need pairs) and must sum to N.
  if (topPoolSizeOverride && topPoolSizeOverride%2===0 && topPoolSizeOverride<N && (N-topPoolSizeOverride)%2===0) {
    return [sorted.slice(0,topPoolSizeOverride), sorted.slice(topPoolSizeOverride)];
  }
  const numPools = Math.max(1, Math.floor(N/6));
  const base = Math.floor(N/numPools), extra = N - base*numPools;
  const pools = []; let idx = 0;
  for (let i = 0; i < numPools; i++) {
    let size = base + (i < extra ? 1 : 0);
    if (size % 2 !== 0) size += (idx+size <= N ? 1 : -1);
    size = Math.min(size, N-idx);
    if (size <= 0) break;
    pools.push(sorted.slice(idx, idx+size)); idx += size;
  }
  return pools;
}

// For a 2-pool split, returns the alternative top-pool size (e.g. auto gives [8,6] → the
// admin can also choose 6 as the top/elite pool size instead). Returns null when there's
// no meaningful alternative (equal pools, or more than 2 pools).
function altTopPoolSize(players) {
  const pools = segmentPools(players);
  if (pools.length !== 2 || pools[0].length === pools[1].length) return null;
  return pools[1].length;
}

function snakeTeams(poolPlayers, poolIdx, startId) {
  const sorted = [...poolPlayers].sort((a,b) => b.usr - a.usr);
  const teams = [], half = Math.floor(sorted.length/2);
  for (let i = 0; i < half; i++) {
    const p1=sorted[i], p2=sorted[sorted.length-1-i];
    // Team's default break preference: only inherited when both players happen to agree;
    // otherwise neutral (No Preference) rather than arbitrarily picking one player's choice.
    // Admins can always set an explicit team-level override afterward.
    const teamBreakPref = (p1.breakPref && p1.breakPref===p2.breakPref) ? p1.breakPref : "none";
    // If this exact pair has already had a custom team name recorded (from a previous CT
    // event), reuse it instead of the generic default — see renameCTTeam/setComboName.
    const comboKey=[p1.userId||p1.id, p2.userId||p2.id].sort().join("_");
    const recordedName = p1.comboNames?.[comboKey] || p2.comboNames?.[comboKey];
    teams.push({ id:startId+i, name:recordedName||`Team ${startId+i}`, players:[p1,p2], avgUsr:Math.round((p1.usr+p2.usr)/2), poolIdx, breakPref:teamBreakPref });
  }
  return teams;
}

function formCTTeams(players, topPoolSizeOverride) {
  const pools = segmentPools(players, topPoolSizeOverride); const teams = []; let teamId = 1;
  pools.forEach((pool,pi) => { const pt=snakeTeams(pool,pi,teamId); teams.push(...pt); teamId+=pt.length; });
  return { teams, pools, numPools:pools.length };
}

// Football: fixed team count and size (set at event creation, ev.numTeams/ev.teamSize), one
// pool for every player — no padel-style elite/lower tiering, since a 5-a-side/7-a-side squad
// isn't a doubles pair the way segmentPools/snakeTeams assume. Balances teams via a standard
// serpentine (snake) draft — highest-rated players spread one per team first, direction
// reverses each row — instead of padel's pair-up-highest-with-lowest pattern, since that only
// makes sense for 2-player teams.
function formFootballTeams(players, numTeams, teamSize) {
  const sorted = [...players].sort((a,b) => b.usr - a.usr);
  const n = Math.max(1, numTeams||3);
  const teams = Array.from({length:n}, (_,i) => ({ id:i+1, name:`Team ${i+1}`, players:[], poolIdx:0, breakPref:"none" }));
  sorted.forEach((p,i) => {
    const round = Math.floor(i/n), posInRound = i%n;
    const t = round%2===0 ? posInRound : (n-1-posInRound);
    teams[t].players.push(p);
  });
  teams.forEach(team => { team.avgUsr = team.players.length ? Math.round(team.players.reduce((s,p)=>s+p.usr,0)/team.players.length) : 0; });
  return { teams, pools:[sorted], numPools:1 };
}

function rrSchedule(teams) {
  const matches = [];
  for (let i = 0; i < teams.length; i++)
    for (let j = i+1; j < teams.length; j++)
      matches.push({ teamA:teams[i], teamB:teams[j], winner:null, scoreA:0, scoreB:0 });
  return matches;
}

function rankGroupCT(group, rounds) {
  const stats = {};
  group.forEach(t => { stats[t.id] = { wins:0, losses:0, scoreDiff:0, goalsFor:0, goalsAgainst:0, played:0, team:t }; });
  rounds.forEach(round => {
    const allMatches = [...(round.matchesA||[]), ...(round.matchesB||[])];
    allMatches.forEach(m => {
      if (!m.winner) return;
      const W = m.winner==="A" ? m.teamA : m.teamB;
      const L = m.winner==="A" ? m.teamB : m.teamA;
      const wScore = m.winner==="A" ? (m.scoreA||0) : (m.scoreB||0);
      const lScore = m.winner==="A" ? (m.scoreB||0) : (m.scoreA||0);
      if (stats[W.id]) { stats[W.id].wins++; stats[W.id].played++; stats[W.id].goalsFor+=wScore; stats[W.id].goalsAgainst+=lScore; stats[W.id].scoreDiff+=(wScore-lScore); }
      if (stats[L.id]) { stats[L.id].losses++; stats[L.id].played++; stats[L.id].goalsFor+=lScore; stats[L.id].goalsAgainst+=wScore; stats[L.id].scoreDiff-=(wScore-lScore); }
    });
  });
  return Object.values(stats).sort((a,b) => b.wins-a.wins || b.scoreDiff-a.scoreDiff || b.goalsFor-a.goalsFor).map(s=>s.team);
}

function calcEventMinutes(ev) {
  if (!ev.time || !ev.timeTo) return 120; // default 2 hours
  const [sh,sm]=ev.time.split(":").map(Number);
  const [eh,em]=ev.timeTo.split(":").map(Number);
  let mins=(eh*60+em)-(sh*60+sm);
  if (mins<=0) mins+=24*60; // booking crosses midnight (e.g. 11 PM -> 12 AM), not invalid
  return mins;
}

function calcMaxRounds(ev, format, groupA, groupB, courts, matchDuration=20) {
  const totalMins = calcEventMinutes(ev);
  if (format==="ladder") {
    // Each ladder round = 1 match per court simultaneously = matchDuration mins
    return Math.max(1, Math.floor(totalMins / matchDuration));
  }
  // League: one league round = all matches in group A + group B played in series on their courts
  // Group A matches per league round = nA*(nA-1)/2
  // Group B matches per league round = nB*(nB-1)/2
  // Courts A and B run in parallel, so time = max(matchesA,matchesB) * matchDuration / courtsA or courtsB
  const courtsA = Math.max(1, Math.round(courts*groupA.length/(groupA.length+groupB.length)));
  const courtsB = Math.max(1, courts-courtsA);
  const matchesA = (groupA.length*(groupA.length-1))/2;
  const matchesB = (groupB.length*(groupB.length-1))/2;
  // Time for one league round = series matches on each court
  const roundMinsA = Math.ceil(matchesA/courtsA)*matchDuration;
  const roundMinsB = Math.ceil(matchesB/courtsB)*matchDuration;
  const leagueRoundMins = Math.max(roundMinsA, roundMinsB);
  return Math.max(1, Math.floor(totalMins / leagueRoundMins));
}

function generateCTPlan(players, courts, format, ev=null, matchDuration=20, topPoolSizeOverride) {
  const { teams, pools } = ev?.sport==="Football" ? formFootballTeams(players, ev.numTeams, ev.teamSize) : formCTTeams(players, topPoolSizeOverride);
  const groupA = teams.filter(t => t.poolIdx === 0);
  const groupB = teams.filter(t => t.poolIdx > 0);
  const courtsA = Math.max(1, Math.round(courts * groupA.length / teams.length));
  const courtsB = Math.max(1, courts - courtsA);

  if (format === "ladder") {
    // Ladder: build break plan like CI, court points + break points
    const bpr = Math.max(0, teams.length - courts*2);
    const ladderBreakPlan = buildCTBreakPlan(teams, courts, 999); // pre-compute
    const sorted = [...teams].sort((a,b) => b.avgUsr - a.avgUsr);
    const onBreakIds = ladderBreakPlan[0] || [];
    const playing = sorted.filter(t => !onBreakIds.includes(t.id));
    const onBreak  = sorted.filter(t =>  onBreakIds.includes(t.id));
    const matches = [];
    for (let c = 0; c < courts; c++) {
      const tA=playing[c*2], tB=playing[c*2+1];
      if (tA&&tB) matches.push({ court:c+1, teamA:tA, teamB:tB, winner:null, scoreA:0, scoreB:0 });
    }
    const maxR = ev ? calcMaxRounds(ev, "ladder", groupA, groupB, courts, matchDuration) : 99;
    return { format:"ladder", teams, groupA, groupB, courts, courtsA, courtsB, leagueRound:1, maxRounds:maxR, roundDuration:matchDuration, matchDuration,
      breakPlan: ladderBreakPlan, sorted,
      rounds:[{ roundNum:1, type:"ladder", matchesA:matches, matchesB:[], onBreak, onBreakIds }] };
  }

  // League: full RR per group = 1 League Round
  const allMatchesA = rrSchedule(groupA).map((m,i) => ({...m, court:(i%courtsA)+1}));
  const allMatchesB = rrSchedule(groupB).map((m,i) => ({...m, court:courtsA+(i%courtsB)+1}));
  const maxLeagueR = ev ? calcMaxRounds(ev, "league", groupA, groupB, courts, matchDuration) : 99;
  // One league round bundles a mini round-robin per court, so its own duration is longer
  // than a single match — same calc as inside calcMaxRounds, needed here for Match Mode.
  // matchDuration (the raw per-match minutes, e.g. 20) is kept separately from roundDuration
  // (the derived per-league-round minutes) so regenerating teams doesn't compound the value.
  const matchesA2 = (groupA.length*(groupA.length-1))/2, matchesB2 = (groupB.length*(groupB.length-1))/2;
  const leagueRoundMins = Math.max(Math.ceil(matchesA2/courtsA)*matchDuration, Math.ceil(matchesB2/courtsB)*matchDuration);
  return { format:"league", teams, groupA, groupB, courts, courtsA, courtsB, leagueRound:1, maxRounds:maxLeagueR, roundDuration:leagueRoundMins, matchDuration,
    rounds:[{ roundNum:1, type:"league", matchesA:allMatchesA, matchesB:allMatchesB, onBreak:[] }] };
}

// CT Ladder Break Plan (same logic as CI but for teams)
function buildCTBreakPlan(teams, courts, totalRounds, lockedRounds=[], firmBreaks={}) {
  const N = teams.length, bpr = Math.max(0, N - courts*2);
  if (bpr <= 0) return Array.from({length:totalRounds}, ()=>[]);
  const totalSlots = bpr * totalRounds, base = Math.floor(totalSlots/N), extras = totalSlots % N;
  const sorted = [...teams].sort((a,b) => (b.histBreaks||0) - (a.histBreaks||0));
  const ent = {}; sorted.forEach((t,i) => { ent[t.id] = base + (i<extras?1:0); });
  const assigned={}, lastB={}; teams.forEach(t => { assigned[t.id]=0; lastB[t.id]=-99; });

  // Seed assigned counts from locked rounds (already happened), and from any Firm-locked
  // teams within the still-recomputable range — both count toward fairness the same way.
  lockedRounds.forEach((ids,ri)=>{
    (ids||[]).forEach(id=>{ if(assigned[id]!==undefined){assigned[id]++;lastB[id]=ri;} });
  });
  for (let r=lockedRounds.length; r<totalRounds; r++) {
    (firmBreaks[r]||[]).forEach(id=>{ if(assigned[id]!==undefined) assigned[id]++; });
  }

  const plan = [...lockedRounds]; // start with locked rounds
  for (let r = lockedRounds.length; r < totalRounds; r++) {
    const firmHere = firmBreaks[r] || [];
    firmHere.forEach(id=>{ lastB[id]=r; });
    const slotsLeft = Math.max(0, bpr - firmHere.length);
    const eligible = teams.filter(t => assigned[t.id] < ent[t.id] && !firmHere.includes(t.id));
    eligible.sort((a,b) => {
      const rd=(ent[b.id]-assigned[b.id])-(ent[a.id]-assigned[a.id]); if(rd!==0)return rd;
      const spacing=(r-lastB[b.id])-(r-lastB[a.id]); if(spacing!==0)return spacing;
      return prefDist(a.breakPref,r,totalRounds)-prefDist(b.breakPref,r,totalRounds); // team break preference: last-resort tiebreak
    });
    const noC = eligible.filter(t => r-lastB[t.id]>1);
    const pool = noC.length>=slotsLeft ? noC : eligible;
    const chosenExtra = pool.slice(0,slotsLeft).map(t=>t.id);
    chosenExtra.forEach(id => { assigned[id]++; lastB[id]=r; });
    plan.push([...firmHere, ...chosenExtra]);
  }
  return plan;
}

// CT Ladder: generate next match. retiredIds: PLAYER ids marked retired (Enhancement #24) —
// retiring one player retires their whole team (fixed doubles, no "continue short-handed"
// mode), so the whole team is dropped from every future round, with a break-pool backfill if a
// court runs short — same approach as genNextRoundCI's individual-player version.
function genNextCTLadder(plan, retiredIds=[]) {
  const { rounds, courts, sorted, breakPlan, teams } = plan;
  const retiredTeamIds = retiredIds.length ? (teams||[]).filter(t=>t.players?.some(p=>retiredIds.includes(p.userId))).map(t=>t.id) : [];
  const ri = rounds.length;
  const lastRound = rounds[ri-1];
  const newBreakIds = breakPlan[ri] || [];
  const onBreak = sorted.filter(t => newBreakIds.includes(t.id) && !retiredTeamIds.includes(t.id));

  // Court ladder: winners up, losers down
  const buckets = {}; for(let c=1;c<=courts;c++) buckets[c]=[];
  lastRound.matchesA.forEach(m => {
    if (!m.winner) return;
    const W = m.winner==="A"?m.teamA:m.teamB, L = m.winner==="A"?m.teamB:m.teamA;
    buckets[Math.max(1,m.court-1)].push(W);
    buckets[Math.min(courts,m.court+1)].push(L);
  });
  // Remove teams on break or retired
  for(let c=1;c<=courts;c++) buckets[c]=buckets[c].filter(t=>!newBreakIds.includes(t.id)&&!retiredTeamIds.includes(t.id));
  // Add returning teams — prefer sending each team back to the court they last competed
  // on (before their break), falling back to the neediest court if that one's still full.
  const returning = sorted.filter(t=>(lastRound.onBreakIds||[]).includes(t.id)&&!newBreakIds.includes(t.id)&&!retiredTeamIds.includes(t.id));
  const findLastCourtCT=(tid)=>{
    for(let i=rounds.length-1;i>=0;i--){
      for(const m of rounds[i].matchesA||[]){
        if(m.teamA?.id===tid||m.teamB?.id===tid) return m.court;
      }
    }
    return null;
  };
  returning.forEach(t => {
    const lastCourt=findLastCourtCT(t.id);
    const sameCourtHasRoom=lastCourt&&buckets[lastCourt]&&buckets[lastCourt].length<2;
    if(sameCourtHasRoom){ buckets[lastCourt].push(t); return; }
    const needy=Object.entries(buckets).filter(([,ts])=>ts.length<2).sort((a,b)=>a[1].length-b[1].length)[0];
    if(needy)buckets[parseInt(needy[0])].push(t);
  });

  if(retiredTeamIds.length){
    const breakCountSoFar={};
    rounds.forEach(r=>(r.onBreakIds||[]).forEach(id=>{breakCountSoFar[id]=(breakCountSoFar[id]||0)+1;}));
    const callUpPool=[...onBreak].sort((a,b)=>(breakCountSoFar[a.id]||0)-(breakCountSoFar[b.id]||0));
    for(let c=1;c<=courts;c++){
      while(buckets[c].length>0&&buckets[c].length<2&&callUpPool.length){
        const t=callUpPool.shift();
        buckets[c].push(t);
        const oi=onBreak.findIndex(x=>x.id===t.id); if(oi>=0) onBreak.splice(oi,1);
      }
    }
  }

  const matches=[];
  for(let c=1;c<=courts;c++) {
    const cp=buckets[c].slice(0,2);
    if(cp.length>=2) matches.push({court:c,teamA:cp[0],teamB:cp[1],winner:null,scoreA:0,scoreB:0});
  }
  return {...plan, rounds:[...rounds,{roundNum:ri+1,type:"ladder",matchesA:matches,matchesB:[],onBreak,onBreakIds:newBreakIds.filter(id=>!retiredTeamIds.includes(id))}]};
}

// CT Ladder scoring
const ctLadderCourtPts = (court, tc) => tc - court + 1;
const ctLadderBreakPts = (tc) => Math.floor((tc+1)/2);

// Weighted USR calculation: CI events weight=1.0, CT events weight=0.5
// Rolling window = last entries until sum(weights) >= 5.0
// Seed entries (from initial USR) always weight=1.0
function calcWeightedUSR(usrHistory, seedUsr, windowSize=5){
  if(!usrHistory||usrHistory.length===0) return seedUsr;
  // Build the working list newest-first
  const hist=[...usrHistory].reverse();
  let weightedSum=0, totalWeight=0;
  for(const h of hist){
    // Retired events (Enhancement #24) stay visible in the player's history but never move
    // their USR — skip entirely rather than `break`, so it doesn't consume any of the
    // rolling-window budget either (the next real event behind it still counts normally).
    if(h.retired) continue;
    // Frozen by a past window-size change (see setUsrWindowSize) — an event that already fell
    // outside someone's active window never re-enters it, even if the window later grows.
    if(h.excludedFromWindow) continue;
    if(totalWeight>=windowSize) break;
    const w = h.type==="ct" ? 0.5 : 1.0;
    const remaining = windowSize - totalWeight;
    const actualW = Math.min(w, remaining);
    weightedSum += h.pes * actualW;
    totalWeight += actualW;
  }
  // Fill remaining weight with seed
  if(totalWeight < windowSize){
    weightedSum += seedUsr * (windowSize - totalWeight);
    totalWeight = windowSize;
  }
  return Math.round(weightedSum / totalWeight);
}

// Max possible pts for a specific team across all played rounds
// Each round: if that team is on break → breakPts, else → court1 win pts
// Max possible pts for a team in CT Ladder (used for per-team TES)
function ctTeamMaxPts(teamId, plan){
  const tc = plan.courts;
  const c1 = ctLadderCourtPts(1, tc);
  const bp = ctLadderBreakPts(tc);
  // Same fix as personalRoundsCI, team-flavored: a retired team (Enhancement #24) stops
  // appearing in any round — matches or break list — after retiring, so counting the event's
  // full round count against them would understate their TES. Cap at their last appearance.
  const rounds = plan.rounds||[];
  let totalRounds = rounds.length;
  for(let i=rounds.length-1;i>=0;i--){
    const r=rounds[i];
    const played=(r.matchesA||[]).some(m=>m.teamA?.id===teamId||m.teamB?.id===teamId);
    const onBreak=(r.onBreak||[]).some(t=>(t.id||t.teamId)===teamId)||(r.onBreakIds||[]).includes(teamId);
    if(played||onBreak){ totalRounds=i+1; break; }
  }
  const breakCount = rounds.slice(0,totalRounds).filter(r=>
    (r.onBreak||[]).some(t=>(t.id||t.teamId)===teamId) ||
    (r.onBreakIds||[]).includes(teamId)
  ).length;
  return (totalRounds - breakCount) * c1 + breakCount * bp;
}
// Event-level max (shown in UI header):
// Base = rounds × court1Pts
// Adjust: replace each "typical" break a team would have with breakPts
// Typical breaks = total break slots ÷ number of teams (rounded)
function ctEventMaxPts(plan){
  // Unified max for every team (not per-team) — same approach as maxPossibleCI for CI:
  // average breaks across all teams (rounded to a whole number), applied equally to everyone.
  if(!plan?.rounds?.length) return 0;
  const tc = plan.courts;
  const c1 = ctLadderCourtPts(1, tc);
  const bp = ctLadderBreakPts(tc);
  const totalRounds = plan.rounds.length;
  const numTeams = plan.teams?.length || 1;
  const totalBreakSlots = plan.rounds.reduce((sum,r)=>{
    return sum + ((r.onBreak||[]).length || (r.onBreakIds||[]).length || 0);
  }, 0);
  const avgBreaks = Math.round(totalBreakSlots / numTeams);
  return (totalRounds-avgBreaks)*c1 + avgBreaks*bp;
}

// retiredIds: PLAYER ids marked retired (Enhancement #24) — retiring one player retires their
// whole team, so retired teams are dropped from both groups before ranking/promotion math runs,
// and simply never reappear in any future league round.
function applyPromoRelegation(plan, retiredIds=[]) {
  const { groupA: rawGroupA, groupB: rawGroupB, courts, rounds, leagueRound, teams } = plan;
  const retiredTeamIds = retiredIds.length ? (teams||[]).filter(t=>t.players?.some(p=>retiredIds.includes(p.userId))).map(t=>t.id) : [];
  const groupA = retiredTeamIds.length ? rawGroupA.filter(t=>!retiredTeamIds.includes(t.id)) : rawGroupA;
  const groupB = retiredTeamIds.length ? rawGroupB.filter(t=>!retiredTeamIds.includes(t.id)) : rawGroupB;
  const rankedA = rankGroupCT(groupA, rounds);
  const rankedB = rankGroupCT(groupB, rounds);
  const sA = groupA.length, sB = groupB.length;

  // Groups swap sizes: if A>B then A loses 2 gains 1, if A=B then 1 each, if A<B then A gains 2 loses 1
  let upCount, downCount;
  if (sA > sB)       { upCount=1; downCount=2; }
  else if (sA < sB)  { upCount=2; downCount=1; }
  else                { upCount=1; downCount=1; }
  upCount = Math.min(upCount, rankedB.length);
  downCount = Math.min(downCount, rankedA.length);

  const promoted  = rankedB.slice(0, upCount);
  const relegated = rankedA.slice(rankedA.length-downCount).filter(Boolean);
  const newGroupA = [...rankedA.filter(t=>!relegated.find(r=>r&&r.id===t.id)), ...promoted].filter(Boolean);
  const newGroupB = [...rankedB.filter(t=>!promoted.find(p=>p&&p.id===t.id)), ...relegated].filter(Boolean);

  const newCourtsA = Math.max(1, Math.round(courts*newGroupA.length/plan.teams.length));
  const newCourtsB = Math.max(1, courts-newCourtsA);
  const allNewA = rrSchedule(newGroupA).map((m,i) => ({...m, court:(i%newCourtsA)+1}));
  const allNewB = rrSchedule(newGroupB).map((m,i) => ({...m, court:newCourtsA+(i%newCourtsB)+1}));
  const base = rounds.length;

  return { ...plan, groupA:newGroupA, groupB:newGroupB, courtsA:newCourtsA, courtsB:newCourtsB,
    leagueRound: leagueRound+1,
    rounds: [...rounds, {roundNum:base+1, type:"league", matchesA:allNewA, matchesB:allNewB, onBreak:[]}],
    lastPromo: { promoted, relegated } };
}

// Football League's "next round" — unlike padel, there's only ever one pool (groupB is always
// empty), so promotion/relegation between groups doesn't apply. Just play the same full
// round-robin again among the same complete team set. Using applyPromoRelegation here was the
// actual bug (found live on padelos-dev): with groupB empty it still tried to relegate 2 teams
// out of group A into it, silently corrupting the team split (1 team left in A, 2 in a B that
// shouldn't exist).
function nextFootballLeagueRound(plan) {
  const { courts, rounds, leagueRound, teams } = plan;
  const allMatches = rrSchedule(teams).map((m,i) => ({...m, court:(i%courts)+1}));
  const base = rounds.length;
  return { ...plan, leagueRound: leagueRound+1,
    rounds: [...rounds, {roundNum:base+1, type:"league", matchesA:allMatches, matchesB:[], onBreak:[]}] };
}

// CT Standings — cumulative all rounds
function calcCTStandings(plan) {
  if (!plan) return [];
  const stats = {};
  plan.teams.forEach(t => { stats[t.id] = { wins:0, losses:0, scoreDiff:0, goalsFor:0, goalsAgainst:0, played:0, breaks:0, pts:0, team:t }; });

  if (plan.format === "ladder") {
    const tc = plan.courts;
    plan.rounds.forEach(r => {
      (r.onBreak||[]).forEach(t => { if(stats[t.id]){stats[t.id].pts+=ctLadderBreakPts(tc);stats[t.id].breaks++;} });
      r.matchesA.forEach(m => {
        if (!m.winner) return;
        const W=m.winner==="A"?m.teamA:m.teamB, L=m.winner==="A"?m.teamB:m.teamA;
        const wp=ctLadderCourtPts(m.court,tc);
        if(stats[W.id]){stats[W.id].wins++;stats[W.id].pts+=wp;stats[W.id].played++;}
        if(stats[L.id]){stats[L.id].losses++;stats[L.id].played++;}
      });
    });
    // Ladder: no groups — all teams merged by points
    return Object.values(stats).filter(s=>s.team).sort((a,b)=>b.pts-a.pts||b.wins-a.wins).map((s,i)=>({...s,finalRank:i+1,group:null}));
  }

  // League: cumulative wins + score diff across ALL rounds
  plan.rounds.forEach(round => {
    const allM = [...(round.matchesA||[]), ...(round.matchesB||[])];
    allM.forEach(m => {
      if (!m.winner) return;
      const W=m.winner==="A"?m.teamA:m.teamB, L=m.winner==="A"?m.teamB:m.teamA;
      const wScore=m.winner==="A"?(m.scoreA||0):(m.scoreB||0), lScore=m.winner==="A"?(m.scoreB||0):(m.scoreA||0);
      if(stats[W.id]){stats[W.id].wins++;stats[W.id].played++;stats[W.id].goalsFor+=wScore;stats[W.id].goalsAgainst+=lScore;stats[W.id].scoreDiff+=(wScore-lScore);}
      if(stats[L.id]){stats[L.id].losses++;stats[L.id].played++;stats[L.id].goalsFor+=lScore;stats[L.id].goalsAgainst+=wScore;stats[L.id].scoreDiff-=(wScore-lScore);}
    });
  });

  // Group A first, then Group B
  // All teams merged and sorted by wins → score diff → goals for
  const allStats = Object.values(stats).filter(s=>s.team).sort((a,b)=>b.wins-a.wins||b.scoreDiff-a.scoreDiff||b.goalsFor-a.goalsFor);
  return allStats.map((s,i)=>({...s,group:plan.groupA.find(t=>t.id===s.team.id)?"A":"B",finalRank:i+1}));
}
// Football-only Top Scorers — sums m.scorersA/m.scorersB (kept separate per team, see
// setCTScorers) across every match in the plan. Player identity (nickname/avatar) is resolved
// from whichever team roster the scorer's userId shows up on, since scorers aren't stored as
// full user objects, just {userId,goals}.
function calcTopScorers(plan) {
  if (!plan) return [];
  const tally = {}; // userId -> {userId, goals, player}
  plan.rounds.forEach(round => {
    [...(round.matchesA||[]), ...(round.matchesB||[])].forEach(m => {
      [...(m.scorersA||[]), ...(m.scorersB||[])].forEach(s => {
        if (!s.goals) return;
        if (!tally[s.userId]) {
          const player = (m.teamA?.players||[]).find(p=>(p.userId||p.id)===s.userId) || (m.teamB?.players||[]).find(p=>(p.userId||p.id)===s.userId);
          tally[s.userId] = { userId: s.userId, goals: 0, player };
        }
        tally[s.userId].goals += s.goals;
      });
    });
  });
  return Object.values(tally).filter(t=>t.goals>0).sort((a,b)=>b.goals-a.goals);
}
// Total real matches played in an event (winner actually set, i.e. not a pending/unplayed
// fixture) — used by community-wide reports, not per-player standings.
const countMatchesPlayed = ev => {
  if (!ev.plan) return 0;
  if (ev.type==="closed_ind") return ev.plan.rounds.reduce((n,r)=>n+(r.matches||[]).filter(m=>m.winner).length,0);
  if (ev.type==="closed_teams") {
    if (ev.plan.format==="ladder") return ev.plan.rounds.reduce((n,r)=>n+(r.matchesA||[]).filter(m=>m.winner).length,0);
    return ev.plan.rounds.reduce((n,r)=>n+[...(r.matchesA||[]),...(r.matchesB||[])].filter(m=>m.winner).length,0);
  }
  return 0;
};

// X-System preview for Closed Teams — Ladder format only (League has no court/margin
// concept to move away from, left untouched). Per-team xTES computed from match details
// (score margin, opponent USR, head-to-head) instead of court position. Pure/read-only,
// nothing persisted. See PLAN: parallel scoring system.
function calcXCTLadderPreview(plan, users, comms, ev) {
  if (!plan || plan.format!=="ladder") return [];
  const perTeam = {};
  // Team USR comes from the team's OWN avgUsr snapshot (the same value the live CT Matches
  // card displays as "TEAM A (NN)"), not re-derived from current live player ratings — see
  // the matching note in calcXCIPreview.
  const teamUsr = t => t.avgUsr ?? (t.players?.length ? t.players.reduce((s,p)=>s+(p.usr??50),0)/t.players.length : 50);
  plan.rounds.forEach((r, ri) => {
    (r.matchesA||[]).forEach(m => {
      if (!m.winner) return;
      const A = m.teamA, B = m.teamB;
      const usrA = teamUsr(A), usrB = teamUsr(B);
      const scoreA = m.scoreA||0, scoreB = m.scoreB||0;
      const idsA = (A.players||[]).map(p=>p.userId), idsB = (B.players||[]).map(p=>p.userId);
      const h2h = calcExactHeadToHead(comms||[], idsA, idsB, {excludeEventId: ev?.id, beforeRound: ri});
      const h2hFlipped = {...h2h, sideAWinRate: h2h.sideBWinRate, sideBWinRate: h2h.sideAWinRate};
      const process = (team, oppTeam, mySideUsr, oppSideUsr, myScore, oppScore, won, sideH2h) => {
        const res = xMatchValue({myScore, oppScore, won, mySideUsr, oppSideUsr, h2h: sideH2h});
        if (!perTeam[team.id]) perTeam[team.id] = {teamId: team.id, team, entryUsr: mySideUsr, matches: []};
        perTeam[team.id].matches.push({round: ri+1, court: m.court, won, oppTeamId: oppTeam.id, oppTeamName: oppTeam.name, oppNames: (oppTeam.players||[]).map(p=>p.nickname), scoreA: myScore, scoreB: oppScore, hasRealScore: res.hasRealScore, E: res.E, S: res.S, delta: res.delta, h2hFactor: res.h2hFactor, xPts: res.xPts});
      };
      process(A, B, usrA, usrB, scoreA, scoreB, m.winner==="A", h2h);
      process(B, A, usrB, usrA, scoreB, scoreA, m.winner==="B", h2hFlipped);
    });
  });
  return Object.values(perTeam)
    .map(t => {
      const avgDelta = t.matches.reduce((s,x)=>s+x.delta*x.h2hFactor,0)/t.matches.length;
      return {
        ...t,
        avgDelta,
        xTES: Math.round((t.matches.reduce((s,x)=>s+x.xPts,0)/t.matches.length) * 10) / 10,
        outputTES: Math.round(Math.max(0,Math.min(100, t.entryUsr + OUTPUT_PES_K*avgDelta)) * 10) / 10,
      };
    })
    .sort((a,b)=>b.xTES-a.xTES);
}

// ── Seed Data ─────────────────────────────────────────
const today    = new Date().toISOString().split("T")[0];
const tomorrow = new Date(Date.now()+86400000).toISOString().split("T")[0];

const INIT_USERS = [
  {id:1,  nickname:"Amka",       name:"Ahmed",       gov:"القاهرة", area:"القاهرة الجديدة", usr:55,  joined:"2026-06-28", avatar:"AM", isGuest:false},
  {id:2,  nickname:"Hashim",     name:"Hashim",      gov:"القاهرة", area:"القاهرة الجديدة", usr:67,  joined:"2026-06-28", avatar:"HA", isGuest:false},
  {id:3,  nickname:"Zizo",       name:"Zizo",        gov:"القاهرة", area:"القاهرة الجديدة", usr:70,  joined:"2026-06-28", avatar:"ZI", isGuest:false},
  {id:4,  nickname:"Leithy",     name:"Leithy",      gov:"القاهرة", area:"القاهرة الجديدة", usr:60,  joined:"2026-06-28", avatar:"LE", isGuest:false},
  {id:5,  nickname:"Essam",      name:"Essam",       gov:"القاهرة", area:"القاهرة الجديدة", usr:40,  joined:"2026-06-28", avatar:"ES", isGuest:false},
  {id:6,  nickname:"M Hany",     name:"M Hany",      gov:"القاهرة", area:"القاهرة الجديدة", usr:63,  joined:"2026-06-28", avatar:"MH", isGuest:false},
  {id:7,  nickname:"Mizo",       name:"Mizo",        gov:"القاهرة", area:"القاهرة الجديدة", usr:44,  joined:"2026-06-28", avatar:"MI", isGuest:false},
  {id:8,  nickname:"Jimmy",      name:"Jimmy",       gov:"القاهرة", area:"القاهرة الجديدة", usr:63,  joined:"2026-06-28", avatar:"JI", isGuest:false},
  {id:9,  nickname:"Dodo",       name:"Dodo",        gov:"القاهرة", area:"القاهرة الجديدة", usr:50,  joined:"2026-06-28", avatar:"DO", isGuest:false},
  {id:10, nickname:"Ashraf",     name:"Ashraf",      gov:"القاهرة", area:"القاهرة الجديدة", usr:47,  joined:"2026-06-28", avatar:"AS", isGuest:false},
  {id:11, nickname:"Doaa Helal", name:"Doaa Helal",  gov:"القاهرة", area:"القاهرة الجديدة", usr:37,  joined:"2026-06-28", avatar:"DH", isGuest:false},
  {id:12, nickname:"Rehab",      name:"Rehab",       gov:"القاهرة", area:"القاهرة الجديدة", usr:34,  joined:"2026-06-28", avatar:"RE", isGuest:false},
];

const INIT_VENUES = [
  {id:1, name:"Galleria Moon Valley", gov:"القاهرة", area:"القاهرة الجديدة", courts:[{name:"C01"},{name:"C02"},{name:"C03"},{name:"C04"}], pricePerHour:500, extraFee:30, mapsUrl:"https://maps.app.goo.gl/TJECquDpbD8wTXHj6?g_st=ac", lat:30.018262, lng:31.5379309, status:"approved"},
];

function mkReg(ids,adminIds=[]){return ids.map(uid=>({userId:uid,registeredAt:new Date().toISOString(),status:"registered",addedBy:adminIds.includes(uid)?"admin":null,isGuest:false}));}

const INIT_COMMS = [
  {
    id:1, name:"Trimachine Padel", description:"Cairo New City padel community.",
    country:"مصر", gov:"القاهرة", area:"القاهرة الجديدة", type:"public", founded:"2026-06-28",
    members:[
      {userId:1,  role:"owner",  status:"regular", since:"2026-06-28"},
      {userId:2,  role:"member", status:"regular", since:"2026-06-28"},
      {userId:3,  role:"member", status:"regular", since:"2026-06-28"},
      {userId:4,  role:"member", status:"regular", since:"2026-06-28"},
      {userId:5,  role:"member", status:"regular", since:"2026-06-28"},
      {userId:6,  role:"member", status:"regular", since:"2026-06-28"},
      {userId:7,  role:"member", status:"regular", since:"2026-06-28"},
      {userId:8,  role:"member", status:"regular", since:"2026-06-28"},
      {userId:9,  role:"member", status:"regular", since:"2026-06-28"},
      {userId:10, role:"member", status:"regular", since:"2026-06-28"},
      {userId:11, role:"member", status:"regular", since:"2026-06-28"},
      {userId:12, role:"member", status:"regular", since:"2026-06-28"},
    ],
    joinRequests:[],
    events:[{
      id:1,
      name:"Monday at Galleria",
      type:"closed_ind",
      venueId:1,
      venueName:"Galleria Moon Valley",
      venueArea:"القاهرة الجديدة",
      date:"2026-06-29",
      time:"21:00",
      timeTo:"23:00",
      courts:3,
      createdBy:1,
      status:"completed",
      closedAt:"2026-06-29T23:00:00.000Z",
      regOpenAt:"2026-06-29T18:00:00.000Z",
      regularUntil:"2026-06-29T19:00:00.000Z",
      checkedIn:[1,2,3,4,5,6,7,8,9,10,11,12],
      rotationMin:20,
      reservedCourts:3,
      costPerCourt:500,
      extraFee:30,
      registrations:[
        {userId:1, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:2, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:3, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:4, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:5, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:6, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:7, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:8, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:9, registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:10,registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:11,registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:12,registeredAt:"2026-06-29T20:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
      ],
      poll:null,
      plan:{
        courts:3,
        totalRounds:6,
        roundDuration:20,
        sorted:[
          {id:3,userId:3,nickname:"Zizo",usr:70},
          {id:2,userId:2,nickname:"Hashim",usr:67},
          {id:6,userId:6,nickname:"M Hany",usr:63},
          {id:8,userId:8,nickname:"Jimmy",usr:63},
          {id:4,userId:4,nickname:"Leithy",usr:60},
          {id:9,userId:9,nickname:"Dodo",usr:50},
          {id:1,userId:1,nickname:"Amka",usr:55},
          {id:10,userId:10,nickname:"Ashraf",usr:47},
          {id:7,userId:7,nickname:"Mizo",usr:44},
          {id:5,userId:5,nickname:"Essam",usr:40},
          {id:11,userId:11,nickname:"Doaa Helal",usr:37},
          {id:12,userId:12,nickname:"Rehab",usr:34},
        ],
        breakPlan:[[],[],[],[],[],[]],
        partnerHistory:{},
        rounds:[
          {round:1, onBreak:[], onBreakIds:[], matches:[
            {court:1, teamA:[{userId:3,nickname:"Zizo",usr:70},{userId:6,nickname:"M Hany",usr:63}],   teamB:[{userId:2,nickname:"Hashim",usr:67},{userId:8,nickname:"Jimmy",usr:63}],   winner:"A"},
            {court:2, teamA:[{userId:4,nickname:"Leithy",usr:60},{userId:10,nickname:"Ashraf",usr:47}], teamB:[{userId:1,nickname:"Amka",usr:55},{userId:9,nickname:"Dodo",usr:50}],     winner:"A"},
            {court:3, teamA:[{userId:7,nickname:"Mizo",usr:44},{userId:12,nickname:"Rehab",usr:34}],   teamB:[{userId:5,nickname:"Essam",usr:40},{userId:11,nickname:"Doaa Helal",usr:37}], winner:"B"},
          ]},
          {round:2, onBreak:[], onBreakIds:[], matches:[
            {court:1, teamA:[{userId:3,nickname:"Zizo",usr:70},{userId:4,nickname:"Leithy",usr:60}],   teamB:[{userId:6,nickname:"M Hany",usr:63},{userId:10,nickname:"Ashraf",usr:47}],  winner:"A"},
            {court:2, teamA:[{userId:2,nickname:"Hashim",usr:67},{userId:5,nickname:"Essam",usr:40}],  teamB:[{userId:8,nickname:"Jimmy",usr:63},{userId:11,nickname:"Doaa Helal",usr:37}], winner:"A"},
            {court:3, teamA:[{userId:1,nickname:"Amka",usr:55},{userId:12,nickname:"Rehab",usr:34}],   teamB:[{userId:9,nickname:"Dodo",usr:50},{userId:7,nickname:"Mizo",usr:44}],       winner:"B"},
          ]},
          {round:3, onBreak:[], onBreakIds:[], matches:[
            {court:1, teamA:[{userId:3,nickname:"Zizo",usr:70},{userId:2,nickname:"Hashim",usr:67}],   teamB:[{userId:4,nickname:"Leithy",usr:60},{userId:5,nickname:"Essam",usr:40}],   winner:"A"},
            {court:2, teamA:[{userId:6,nickname:"M Hany",usr:63},{userId:9,nickname:"Dodo",usr:50}],   teamB:[{userId:10,nickname:"Ashraf",usr:47},{userId:7,nickname:"Mizo",usr:44}],   winner:"A"},
            {court:3, teamA:[{userId:8,nickname:"Jimmy",usr:63},{userId:12,nickname:"Rehab",usr:34}],  teamB:[{userId:11,nickname:"Doaa Helal",usr:37},{userId:1,nickname:"Amka",usr:55}], winner:"A"},
          ]},
          {round:4, onBreak:[], onBreakIds:[], matches:[
            {court:1, teamA:[{userId:3,nickname:"Zizo",usr:70},{userId:9,nickname:"Dodo",usr:50}],     teamB:[{userId:2,nickname:"Hashim",usr:67},{userId:6,nickname:"M Hany",usr:63}],   winner:"B"},
            {court:2, teamA:[{userId:4,nickname:"Leithy",usr:60},{userId:12,nickname:"Rehab",usr:34}], teamB:[{userId:5,nickname:"Essam",usr:40},{userId:8,nickname:"Jimmy",usr:63}],    winner:"B"},
            {court:3, teamA:[{userId:10,nickname:"Ashraf",usr:47},{userId:11,nickname:"Doaa Helal",usr:37}], teamB:[{userId:7,nickname:"Mizo",usr:44},{userId:1,nickname:"Amka",usr:55}], winner:"B"},
          ]},
          {round:5, onBreak:[], onBreakIds:[], matches:[
            {court:1, teamA:[{userId:2,nickname:"Hashim",usr:67},{userId:5,nickname:"Essam",usr:40}],  teamB:[{userId:6,nickname:"M Hany",usr:63},{userId:8,nickname:"Jimmy",usr:63}],   winner:"A"},
            {court:2, teamA:[{userId:3,nickname:"Zizo",usr:70},{userId:7,nickname:"Mizo",usr:44}],     teamB:[{userId:9,nickname:"Dodo",usr:50},{userId:1,nickname:"Amka",usr:55}],      winner:"A"},
            {court:3, teamA:[{userId:4,nickname:"Leithy",usr:60},{userId:11,nickname:"Doaa Helal",usr:37}], teamB:[{userId:12,nickname:"Rehab",usr:34},{userId:10,nickname:"Ashraf",usr:47}], winner:"A"},
          ]},
          {round:6, onBreak:[], onBreakIds:[], matches:[
            {court:1, teamA:[{userId:2,nickname:"Hashim",usr:67},{userId:7,nickname:"Mizo",usr:44}],   teamB:[{userId:5,nickname:"Essam",usr:40},{userId:3,nickname:"Zizo",usr:70}],     winner:"A"},
            {court:2, teamA:[{userId:6,nickname:"M Hany",usr:63},{userId:11,nickname:"Doaa Helal",usr:37}], teamB:[{userId:8,nickname:"Jimmy",usr:63},{userId:4,nickname:"Leithy",usr:60}], winner:"B"},
            {court:3, teamA:[{userId:9,nickname:"Dodo",usr:50},{userId:12,nickname:"Rehab",usr:34}],   teamB:[{userId:1,nickname:"Amka",usr:55},{userId:10,nickname:"Ashraf",usr:47}],   winner:"B"},
          ]},
        ]
      }
    },{
      id:2,
      isDemo:true, // seed/demo data — only visible to the platform owner
      name:"Friday League Night",
      description:"Closed Teams — League format, 2 pools",
      type:"closed_teams",
      venueId:1,
      venueName:"Galleria Moon Valley",
      venueArea:"القاهرة الجديدة",
      date:"2026-07-11",
      time:"19:00",
      timeTo:"21:30",
      courts:3,
      createdBy:1,
      status:"registration_open",
      closedAt:null,
      regOpenAt:"2026-07-09T10:00:00.000Z",
      regularUntil:"2026-07-10T10:00:00.000Z",
      checkedIn:[],
      rotationMin:20,
      reservedCourts:3,
      costPerCourt:500,
      extraFee:30,
      registrations:[
        {userId:1, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:2, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:3, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:4, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:5, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:6, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:7, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:8, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:9, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:10,registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:11,registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:12,registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
      ],
      poll:null,
      plan:{
        format:"league",
        courts:3, courtsA:2, courtsB:1, leagueRound:1, maxRounds:1, roundDuration:60, matchDuration:20,
        teams:[
          {id:1, name:"Team 1", poolIdx:0, avgUsr:63, players:[{userId:3,nickname:"Zizo",usr:70},{userId:1,nickname:"Amka",usr:55}]},
          {id:2, name:"Team 2", poolIdx:0, avgUsr:64, players:[{userId:2,nickname:"Hashim",usr:67},{userId:4,nickname:"Leithy",usr:60}]},
          {id:3, name:"Team 3", poolIdx:0, avgUsr:63, players:[{userId:6,nickname:"M Hany",usr:63},{userId:8,nickname:"Jimmy",usr:63}]},
          {id:4, name:"Team 4", poolIdx:1, avgUsr:42, players:[{userId:9,nickname:"Dodo",usr:50},{userId:12,nickname:"Rehab",usr:34}]},
          {id:5, name:"Team 5", poolIdx:1, avgUsr:42, players:[{userId:10,nickname:"Ashraf",usr:47},{userId:11,nickname:"Doaa Helal",usr:37}]},
          {id:6, name:"Team 6", poolIdx:1, avgUsr:42, players:[{userId:7,nickname:"Mizo",usr:44},{userId:5,nickname:"Essam",usr:40}]},
        ],
        groupA:[
          {id:1, name:"Team 1", poolIdx:0, avgUsr:63, players:[{userId:3,nickname:"Zizo",usr:70},{userId:1,nickname:"Amka",usr:55}]},
          {id:2, name:"Team 2", poolIdx:0, avgUsr:64, players:[{userId:2,nickname:"Hashim",usr:67},{userId:4,nickname:"Leithy",usr:60}]},
          {id:3, name:"Team 3", poolIdx:0, avgUsr:63, players:[{userId:6,nickname:"M Hany",usr:63},{userId:8,nickname:"Jimmy",usr:63}]},
        ],
        groupB:[
          {id:4, name:"Team 4", poolIdx:1, avgUsr:42, players:[{userId:9,nickname:"Dodo",usr:50},{userId:12,nickname:"Rehab",usr:34}]},
          {id:5, name:"Team 5", poolIdx:1, avgUsr:42, players:[{userId:10,nickname:"Ashraf",usr:47},{userId:11,nickname:"Doaa Helal",usr:37}]},
          {id:6, name:"Team 6", poolIdx:1, avgUsr:42, players:[{userId:7,nickname:"Mizo",usr:44},{userId:5,nickname:"Essam",usr:40}]},
        ],
        rounds:[{
          roundNum:1, type:"league",
          matchesA:[
            {court:1, teamA:{id:1,name:"Team 1"}, teamB:{id:2,name:"Team 2"}, winner:"A", scoreA:6, scoreB:3},
            {court:2, teamA:{id:1,name:"Team 1"}, teamB:{id:3,name:"Team 3"}, winner:"A", scoreA:6, scoreB:4},
            {court:1, teamA:{id:2,name:"Team 2"}, teamB:{id:3,name:"Team 3"}, winner:"B", scoreA:4, scoreB:6},
          ],
          matchesB:[
            {court:3, teamA:{id:4,name:"Team 4"}, teamB:{id:5,name:"Team 5"}, winner:"B", scoreA:3, scoreB:6},
            {court:3, teamA:{id:4,name:"Team 4"}, teamB:{id:6,name:"Team 6"}, winner:"A", scoreA:6, scoreB:2},
            {court:3, teamA:{id:5,name:"Team 5"}, teamB:{id:6,name:"Team 6"}, winner:"A", scoreA:6, scoreB:5},
          ],
          onBreak:[]
        }]
      }
    },{
      id:3,
      isDemo:true, // seed/demo data — only visible to the platform owner
      name:"Saturday Ladder",
      description:"Closed Teams — Ladder format",
      type:"closed_teams",
      venueId:1,
      venueName:"Galleria Moon Valley",
      venueArea:"القاهرة الجديدة",
      date:"2026-07-11",
      time:"18:00",
      timeTo:"20:00",
      courts:3,
      createdBy:1,
      status:"registration_open",
      closedAt:null,
      regOpenAt:"2026-07-09T10:00:00.000Z",
      regularUntil:"2026-07-10T10:00:00.000Z",
      checkedIn:[],
      rotationMin:20,
      reservedCourts:3,
      costPerCourt:500,
      extraFee:30,
      registrations:[
        {userId:1, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:2, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:3, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:4, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:5, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:6, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:7, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:8, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:9, registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:10,registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:11,registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
        {userId:12,registeredAt:"2026-07-09T11:00:00.000Z", status:"registered", addedBy:null, isGuest:false},
      ],
      poll:null,
      plan:{
        format:"ladder",
        courts:3, courtsA:3, courtsB:0, leagueRound:1, maxRounds:6, roundDuration:20, matchDuration:20,
        teams:[
          {id:1, name:"Team 1", poolIdx:0, avgUsr:63, players:[{userId:3,nickname:"Zizo",usr:70},{userId:1,nickname:"Amka",usr:55}]},
          {id:2, name:"Team 2", poolIdx:0, avgUsr:64, players:[{userId:2,nickname:"Hashim",usr:67},{userId:4,nickname:"Leithy",usr:60}]},
          {id:3, name:"Team 3", poolIdx:0, avgUsr:63, players:[{userId:6,nickname:"M Hany",usr:63},{userId:8,nickname:"Jimmy",usr:63}]},
          {id:4, name:"Team 4", poolIdx:1, avgUsr:42, players:[{userId:9,nickname:"Dodo",usr:50},{userId:12,nickname:"Rehab",usr:34}]},
          {id:5, name:"Team 5", poolIdx:1, avgUsr:42, players:[{userId:10,nickname:"Ashraf",usr:47},{userId:11,nickname:"Doaa Helal",usr:37}]},
          {id:6, name:"Team 6", poolIdx:1, avgUsr:42, players:[{userId:7,nickname:"Mizo",usr:44},{userId:5,nickname:"Essam",usr:40}]},
        ],
        groupA:[
          {id:1, name:"Team 1", poolIdx:0, avgUsr:63, players:[{userId:3,nickname:"Zizo",usr:70},{userId:1,nickname:"Amka",usr:55}]},
          {id:2, name:"Team 2", poolIdx:0, avgUsr:64, players:[{userId:2,nickname:"Hashim",usr:67},{userId:4,nickname:"Leithy",usr:60}]},
          {id:3, name:"Team 3", poolIdx:0, avgUsr:63, players:[{userId:6,nickname:"M Hany",usr:63},{userId:8,nickname:"Jimmy",usr:63}]},
          {id:4, name:"Team 4", poolIdx:1, avgUsr:42, players:[{userId:9,nickname:"Dodo",usr:50},{userId:12,nickname:"Rehab",usr:34}]},
          {id:5, name:"Team 5", poolIdx:1, avgUsr:42, players:[{userId:10,nickname:"Ashraf",usr:47},{userId:11,nickname:"Doaa Helal",usr:37}]},
          {id:6, name:"Team 6", poolIdx:1, avgUsr:42, players:[{userId:7,nickname:"Mizo",usr:44},{userId:5,nickname:"Essam",usr:40}]},
        ],
        groupB:[],
        sorted:[
          {id:2, name:"Team 2", avgUsr:64},
          {id:1, name:"Team 1", avgUsr:63},
          {id:3, name:"Team 3", avgUsr:63},
          {id:4, name:"Team 4", avgUsr:42},
          {id:5, name:"Team 5", avgUsr:42},
          {id:6, name:"Team 6", avgUsr:42},
        ],
        breakPlan:[[],[],[],[],[],[]],
        rounds:[{
          roundNum:1, type:"ladder",
          matchesA:[
            {court:1, teamA:{id:2,name:"Team 2",players:[{userId:2,nickname:"Hashim",usr:67},{userId:4,nickname:"Leithy",usr:60}]}, teamB:{id:1,name:"Team 1",players:[{userId:3,nickname:"Zizo",usr:70},{userId:1,nickname:"Amka",usr:55}]}, winner:null, scoreA:0, scoreB:0},
            {court:2, teamA:{id:3,name:"Team 3",players:[{userId:6,nickname:"M Hany",usr:63},{userId:8,nickname:"Jimmy",usr:63}]}, teamB:{id:4,name:"Team 4",players:[{userId:9,nickname:"Dodo",usr:50},{userId:12,nickname:"Rehab",usr:34}]}, winner:null, scoreA:0, scoreB:0},
            {court:3, teamA:{id:5,name:"Team 5",players:[{userId:10,nickname:"Ashraf",usr:47},{userId:11,nickname:"Doaa Helal",usr:37}]}, teamB:{id:6,name:"Team 6",players:[{userId:7,nickname:"Mizo",usr:44},{userId:5,nickname:"Essam",usr:40}]}, winner:null, scoreA:0, scoreB:0},
          ],
          matchesB:[], onBreak:[], onBreakIds:[]
        }]
      }
    }]
  },
];

let _uid=13,_cid=2,_eid=4,_vid=2,_nid=1,_invid=1;

// ── Helpers ───────────────────────────────────────────
const usrLv  = u => u>=80?{l:"A",c:"#C084FC"}:u>=65?{l:"B",c:"#38BDF8"}:u>=50?{l:"C",c:"#34D399"}:u>=35?{l:"D",c:"#FBBF24"}:{l:"E",c:"#F87171"};
// "Level of the event" — average rating across active (non-waitlisted) registrants only,
// since that's who's actually going to play. Uses teamFormationRating so football events
// average football skill (mapped to the same 0-100 scale) instead of a meaningless padel USR.
// null when nobody's registered yet — nothing to average.
const calcEventAvgUsr = (ev, users, comm) => {
  const active = splitRegsByCapacity(ev, comm).active;
  const ratings = active.map(r => { const u = users.find(uu=>uu.id===r.userId); return u ? teamFormationRating(u, ev) : null; }).filter(v => v != null);
  return ratings.length ? Math.round(ratings.reduce((s,v)=>s+v,0) / ratings.length) : null;
};
const ini2   = s => s.substring(0,2).toUpperCase();
const fmtD   = d => new Date(d).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
const fmtT   = t => { if(!t) return t; const [h,m]=t.split(":").map(Number); if(isNaN(h)) return t; const ap=h>=12?"PM":"AM"; const h12=h%12||12; return `${h12}:${String(m).padStart(2,"0")} ${ap}`; };
const timeAgo = (iso) => {
  const s = Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if (s<60) return "now";
  if (s<3600) return `${Math.floor(s/60)}m ago`;
  if (s<86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
};
const fmtBytes = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
const addMinutesToTime = (t,mins) => {
  if (!t) return "";
  const [h,m] = t.split(":").map(Number);
  const total = (((h*60+m+mins)%1440)+1440)%1440;
  return `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;
};
// Minutes from t1 to t2 (same-day, non-negative — clamps to 0 if t2 is not after t1).
const minutesBetween = (t1,t2) => {
  if (!t1||!t2) return 0;
  const [h1,m1]=t1.split(":").map(Number), [h2,m2]=t2.split(":").map(Number);
  return Math.max(0, (h2*60+m2)-(h1*60+m1));
};
// Best-effort lat/lng extraction from common Google Maps URL shapes
// (…/@lat,lng,zoom…, ?q=lat,lng, …). Shortened links (goo.gl/maps/…) or
// place-name-only links have no coordinates in the URL and return null.
const parseLatLngFromUrl = (url) => {
  if (!url) return null;
  const m = url.match(/(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat=parseFloat(m[1]), lng=parseFloat(m[2]);
  if (Math.abs(lat)>90||Math.abs(lng)>180) return null;
  return {lat,lng};
};
const haversineKm = (lat1,lng1,lat2,lng2) => {
  const R=6371, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
};
// Explicit lat/lng on the venue (if the admin entered them) always wins — it's reliable
// regardless of what kind of link was pasted. Falls back to parsing the Maps URL, which
// only works for "full" links with visible coordinates — shortened share links
// (maps.app.goo.gl/…) and plain place-name links have no coordinates in the URL text at
// all, so they can't be parsed client-side.
const getVenueCoords = (venue) => {
  if (!venue) return null;
  if (typeof venue.lat==="number" && typeof venue.lng==="number" && !isNaN(venue.lat) && !isNaN(venue.lng)) return {lat:venue.lat, lng:venue.lng};
  return parseLatLngFromUrl(venue.mapsUrl);
};
// Synthesized referee-style whistle (trill) — no audio asset needed.
function playWhistle(){
  try{
    const Ctx = window.AudioContext||window.webkitAudioContext;
    if(!Ctx) return;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const burstStart = ctx.currentTime;
    const burstDur = 0.9;   // one trill burst
    const gapDur = 0.35;    // silence between bursts
    const bursts = 3;       // repeat so it's hard to miss
    for(let b=0; b<bursts; b++){
      const t0 = burstStart + b*(burstDur+gapDur);
      const osc = ctx.createOscillator();
      osc.type = "square";
      for(let i=0;i<8;i++) osc.frequency.setValueAtTime(i%2===0?2600:2200, t0+i*0.09);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.55, t0+0.02);
      gain.gain.setValueAtTime(0.55, t0+0.62);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0+burstDur);
      osc.connect(gain);
      osc.start(t0); osc.stop(t0+burstDur);
      if(b===bursts-1) osc.onended = ()=>ctx.close();
    }
  }catch(e){ console.log("whistle sound failed", e); }
}
const isFut  = d => d >= today;
const isPst  = d => d <  today;
const avgUsr = players => players.length ? Math.round(players.reduce((s,p)=>s+p.usr,0)/players.length) : 0;

// ── Share Card Generation (Canvas) ──────────────────────
// ── Share Card Design System ────────────────────────
// Mobile-portrait width (matches a phone screen ~ story/post format), light branded theme.
const CARD_W = 380; // narrow mobile-card width — matches a phone screen closely, denser text, less empty space
const COLORS = {
  bg: "#F4F4FF",
  headerFrom: "#4F46E5",
  headerTo: "#7C6FF0",
  card: "#FFFFFF",
  cardAlt: "#F0EFFF",
  border: "#E0DFFA",
  text: "#1E1B4B",
  sub: "#5B5891",
  dim: "#8784B5",
  accent: "#4F46E5",
  green: "#16A34A",
  amber: "#D97706",
  red: "#DC2626",
};

function wrapText(ctx, text, x, y, maxWidth, lineHeight){
  const words = String(text).split(" ");
  let line = "", yy = y;
  for(const w of words){
    const test = line ? line+" "+w : w;
    if(ctx.measureText(test).width > maxWidth && line){
      ctx.fillText(line, x, yy);
      line = w; yy += lineHeight;
    } else line = test;
  }
  if(line) ctx.fillText(line, x, yy);
  return yy + lineHeight;
}

function fitText(ctx, text, x, y, maxWidth){
  // Shrinks the current font size (down to a floor) until the text fits on one line, then draws it.
  const m = ctx.font.match(/(\d+)px/);
  let size = m ? parseInt(m[1]) : 14;
  const weight = ctx.font.replace(/\d+px.*/, "").trim() || "400";
  const floor = Math.max(10, size - 8);
  while(size > floor && ctx.measureText(text).width > maxWidth){
    size -= 1;
    ctx.font = `${weight} ${size}px Arial`;
  }
  if(ctx.measureText(text).width > maxWidth){
    // still too long even at floor size — truncate with ellipsis
    let t = text;
    while(t.length > 1 && ctx.measureText(t+"…").width > maxWidth) t = t.slice(0,-1);
    text = t + "…";
  }
  ctx.fillText(text, x, y);
}

// Preload the app logo once, as soon as this module loads, so every share-card header
// can draw the real logo image synchronously instead of an emoji placeholder. If it hasn't
// finished loading yet (or fails) by the time a card is drawn, the emoji is used as fallback.
let _appLogoImg = null;
(function preloadAppLogoOnce(){
  const img = new Image();
  img.onload = () => { _appLogoImg = img; };
  img.src = "/logo-icon-192.png";
})();

function drawHeader(ctx, w, title, subtitle, communityName){
  const headerH = 108;
  const grad = ctx.createLinearGradient(0,0,w,headerH);
  grad.addColorStop(0, COLORS.headerFrom);
  grad.addColorStop(1, COLORS.headerTo);
  ctx.fillStyle = grad; ctx.fillRect(0,0,w,headerH);
  ctx.fillStyle = "#fff"; ctx.textBaseline = "alphabetic";
  if (_appLogoImg) {
    ctx.save();
    roundRect(ctx, 16, 8, 20, 20, 5); ctx.clip();
    ctx.drawImage(_appLogoImg, 16, 8, 20, 20);
    ctx.restore();
    ctx.font = "700 15px Arial"; ctx.fillText("Matchkeeper", 42, 24);
  } else {
    ctx.font = "700 15px Arial"; ctx.fillText("🎾 Matchkeeper", 16, 26);
  }
  if(communityName){ ctx.font="600 10px Arial"; ctx.fillStyle="#E0E7FF"; ctx.textAlign="right"; ctx.fillText(communityName, w-16, 26); ctx.textAlign="left"; }
  ctx.fillStyle = "#fff"; ctx.font = "700 19px Arial";
  fitText(ctx, title, 16, 56, w-32);
  if(subtitle){ ctx.font="500 11px Arial"; ctx.fillStyle="#E0E7FF"; ctx.fillText(subtitle, 16, 78); }
  return headerH;
}

function drawFooter(ctx, w, h){
  ctx.fillStyle = COLORS.dim; ctx.font="9px Arial"; ctx.textAlign="center";
  ctx.fillText("Generated by Matchkeeper", w/2, h-12);
  ctx.textAlign="left";
}

// Standalone, square podium share card — separate from the full standings list.
// Design approved via a tested PNG mockup — sizes/spacing below are taken directly from
// that working version (no header overlap, player names are the biggest/most prominent
// element, medals included).
function buildPodiumCard(ev, venue, top3, communityName, title){
  const w = 800, h = 800;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, title||"🏆 Champions", ev.name, communityName);
  y += 20;
  y = drawEventStrip(ctx, w, y, ev, venue);

  if(!top3||top3.length===0){ drawFooter(ctx,w,h); return c; }
  const medals=["🥇","🥈","🥉"], colors=["#FBBF24","#94A3B8","#CD7C2F"];
  const barHByRank=[190,125,85];
  // Player names (or the person's own name for CI) are the headline — biggest font of all.
  // Team name (CT only) is secondary/smaller. Every size steps down by rank.
  const medalFontByRank=[56,40,34], headlineFontByRank=[30,22,18], teamFontByRank=[17,14,12],
        usrFontByRank=[14,12,10], valueFontByRank=[22,17,14], rankNumFontByRank=[34,26,20];
  const order=[1,0,2].filter(i=>top3[i]);
  const colW=(w-96)/3, baseY=760; // fixed — matches the tested mockup, safely clears the header/strip

  order.forEach((rank,pos)=>{
    const e=top3[rank]; if(!e) return;
    const barH=barHByRank[rank];
    const cx = 48 + colW*pos + colW/2;
    const hasTeam = e.players && e.players.length>0;
    const headline = hasTeam ? e.players.map(p=>p.nickname).join(" & ") : e.name;
    let ty = baseY - barH - 20;
    ctx.font = `${medalFontByRank[rank]}px Arial`; ctx.textAlign="center";
    ctx.fillText(medals[rank], cx, ty);
    ty -= medalFontByRank[rank] + 14;
    ctx.fillStyle = COLORS.text; ctx.font=`800 ${headlineFontByRank[rank]}px Arial`;
    const headlineLines = fitTextWrapCentered(ctx, headline, cx, ty, colW-16, headlineFontByRank[rank]*1.05);
    ty -= headlineFontByRank[rank]*1.45 + (headlineLines>1 ? headlineFontByRank[rank]*1.05 : 0);
    if(hasTeam){
      ctx.fillStyle = COLORS.dim; ctx.font=`${teamFontByRank[rank]}px Arial`;
      fitTextCentered(ctx, e.name, cx, ty, colW-16);
      ty -= teamFontByRank[rank]*1.55;
    }
    if(e.usrLine){ ctx.fillStyle = COLORS.dim; ctx.font=`${usrFontByRank[rank]}px Arial`; fitTextCentered(ctx, e.usrLine, cx, ty, colW-16); ty -= usrFontByRank[rank]*1.7; }
    ctx.fillStyle = colors[rank]; ctx.font=`800 ${valueFontByRank[rank]}px Arial`;
    ctx.fillText(`${e.value}${e.valueLabel?" "+e.valueLabel:""}`, cx, ty);

    ctx.fillStyle = `${colors[rank]}33`;
    roundRect(ctx, 48+colW*pos+8, baseY-barH, colW-16, barH, 8); ctx.fill();
    ctx.strokeStyle = `${colors[rank]}88`; ctx.lineWidth=2;
    roundRect(ctx, 48+colW*pos+8, baseY-barH, colW-16, barH, 8); ctx.stroke();
    ctx.fillStyle = colors[rank]; ctx.font=`800 ${rankNumFontByRank[rank]}px Arial`;
    ctx.fillText(`${rank+1}`, cx, baseY-barH/2+8);
    ctx.textAlign="left";
  });
  drawFooter(ctx, w, h);
  return c;
}

function drawCardBase(ctx,w,h,title,subtitle){
  // Legacy signature kept for compatibility; delegates to the new light theme.
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  return drawHeader(ctx, w, title, subtitle, null);
}
function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}

const CARD_SCALE = 3; // render at 3x resolution for crisp output on high-DPI phone screens; layout math stays in CSS-pixel units
function makeCard(w, h){
  const c = document.createElement("canvas");
  c.width = w * CARD_SCALE;
  c.height = h * CARD_SCALE;
  c.style.width = w + "px";   // CSS size stays the same — aspect ratio and on-screen size unchanged
  c.style.height = h + "px";
  const ctx = c.getContext("2d");
  ctx.scale(CARD_SCALE, CARD_SCALE); // all subsequent drawing calls use the original w/h coordinate system
  return {c, ctx};
}


function canvasToBlob(canvas){return new Promise(res=>canvas.toBlob(res,"image/png"));}
// Preloads a set of player photo URLs into an id->Image map for synchronous canvas drawing.
// Missing/failed photos are simply left out of the map (falls back to initials).
async function preloadPlayerPhotos(players){
  const map = new Map();
  await Promise.all(players.filter(p=>p.photoURL).map(p => new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { map.set(p.id, img); resolve(); };
    img.onerror = () => resolve(); // no photo drawn for this player, initials fallback still works
    img.src = p.photoURL;
  })));
  return map;
}
function canvasToFileSync(canvas, name){
  // Synchronous conversion — keeps us in the user gesture context for navigator.share
  const dataUrl = canvas.toDataURL("image/png");
  const arr = dataUrl.split(","), mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  const u8arr = new Uint8Array(bstr.length);
  for(let i=0;i<bstr.length;i++) u8arr[i]=bstr.charCodeAt(i);
  return new File([u8arr], name, {type:mime});
}

async function shareImages(canvases, baseName, text){
  const diag=[];
  const files = canvases.map((c,i)=>canvasToFileSync(c,`${baseName}_${i+1}.png`));
  diag.push(`files ready: ${files.length}`);

  if (Capacitor.isNativePlatform()) {
    try {
      const savedUris = [];
      for (const f of files) {
        const base64 = await new Promise((resolve,reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
        const result = await Filesystem.writeFile({path:f.name, data:base64, directory:Directory.Cache});
        savedUris.push(result.uri);
      }
      await Share.share({title:baseName, text, files:savedUris});
      return {status:"shared", diag:["shared natively"]};
    } catch(e) {
      if (e && (e.message||"").toLowerCase().includes("cancel")) return {status:"shared", diag:["user cancelled"]};
      diag.push(`native share failed: ${e.message||e}`);
      // fall through to browser fallback below, which will just trigger a download on native too
    }
  }

  diag.push(`navigator.share: ${typeof navigator.share}`);
  diag.push(`navigator.canShare: ${typeof navigator.canShare}`);

  if(navigator.share && navigator.canShare){
    let canMulti=false;
    try{ canMulti = navigator.canShare({files}); }catch(e){ diag.push(`canShare(multi) threw: ${e.message}`); }
    diag.push(`canShare(multi files): ${canMulti}`);
    if(canMulti){
      try{
        await navigator.share({files, title:baseName, text});
        return {status:"shared", diag};
      }catch(e){
        if(e && e.name==="AbortError") return {status:"shared", diag:["user cancelled"]};
        diag.push(`share(multi) threw: ${e.name}: ${e.message}`);
      }
    }
    // Try single files one at a time
    let anyShared=false;
    for(const f of files){
      let canOne=false;
      try{ canOne=navigator.canShare({files:[f]}); }catch(e){ diag.push(`canShare(1) threw: ${e.message}`); }
      if(canOne){
        try{
          await navigator.share({files:[f], title:baseName, text});
          anyShared=true;
        }catch(e){
          if(e && e.name==="AbortError"){ anyShared=true; continue; }
          diag.push(`share(${f.name}) threw: ${e.name}: ${e.message}`);
        }
      } else {
        diag.push(`canShare=false for ${f.name}`);
      }
    }
    if(anyShared) return {status:"shared", diag};
  } else {
    diag.push("Web Share API not available");
  }
  // Fallback: download all files
  files.forEach(f=>{
    const url=URL.createObjectURL(f);
    const a=document.createElement("a");a.href=url;a.download=f.name;document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),4000);
  });
  return {status:"downloaded", diag};
}

function durationLabel(time, timeTo){
  if(!time||!timeTo) return "—";
  const [sh,sm]=time.split(":").map(Number), [eh,em]=timeTo.split(":").map(Number);
  let m=(eh*60+em)-(sh*60+sm); if(m<=0) m+=24*60; // crosses midnight, not invalid
  const h=Math.floor(m/60), rm=m%60;
  return h>0?(rm>0?`${h}h ${rm}min`:`${h}h`):`${rm}min`;
}
const EVENT_TYPE_LABELS = {open:"Open Day",closed_ind:"Closed Individuals",closed_teams:"Closed Teams"};

function buildEventInfoCard(ev, venue, players, communityName, ctPlan=null, photoMap=null){
  const w = CARD_W;
  const poolColors = ["#6366F1","#06B6D4","#F472B6","#34D399","#F59E0B"];

  let bottomH;
  if(ctPlan && ctPlan.format==="league"){
    const groupDefs = [
      ctPlan.groupA||ctPlan.teams.filter(t=>t.poolIdx===0),
      ctPlan.groupB||ctPlan.teams.filter(t=>t.poolIdx===1),
    ].filter(g=>g.length>0);
    bottomH = 18 + groupDefs.reduce((sum,g)=>sum + 20 + g.length*36 + 4, 0);
  } else if(ctPlan){
    const pools = [...new Set(ctPlan.teams.map(t=>t.poolIdx))].sort();
    bottomH = pools.reduce((sum,pi)=>{
      const n = ctPlan.teams.filter(t=>t.poolIdx===pi).length;
      return sum + 24 + n*36;
    }, 28);
  } else {
    const rows = Math.ceil(players.length/2);
    bottomH = 26 + rows*32;
  }
  const headerH = 108;
  const h = headerH + 16 + 150 + 56 + bottomH + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, ev.name, `${fmtD(ev.date)} · ${fmtT(ev.time)}${ev.timeTo?" → "+fmtT(ev.timeTo):""}`, communityName);
  y += 16;

  // Info card
  ctx.fillStyle = COLORS.card; roundRect(ctx, 14, y, w-28, 150, 12); ctx.fill();
  ctx.strokeStyle = COLORS.border; ctx.lineWidth=1; roundRect(ctx, 14, y, w-28, 150, 12); ctx.stroke();
  y += 14;
  const totalCount = ctPlan ? ctPlan.teams.length*2 : players.length;
  const infoRows = [
    ["🏅 Sport", sportLabel(ev.sport||DEFAULT_SPORT)],
    ["📍 Location", venue ? venue.name : "TBD"],
    ["⏱ Duration", durationLabel(ev.time, ev.timeTo)],
    ev.pitches?.length ? ["⚽ Pitches", ev.pitches.join(", ")] : ["🎾 Courts", `${ev.courts} courts`],
    ["🏷 Format", getEventTypesForSport(ev.sport).find(t=>t.key===ev.type)?.label || EVENT_TYPE_LABELS[ev.type] || "Open"],
    ["👥 Players", `${totalCount} registered`],
  ];
  infoRows.forEach(([label,val])=>{
    ctx.font = "11px Arial"; ctx.fillStyle = COLORS.dim; ctx.fillText(label, 26, y+10);
    ctx.fillStyle = COLORS.text; ctx.font="700 11px Arial"; ctx.textAlign="right";
    fitText(ctx, val, w-26, y+10, 170); ctx.textAlign="left";
    y += 27;
  });
  y += 16;

  // Late-arrival warning
  ctx.fillStyle = "#FEF3C7"; roundRect(ctx, 14, y, w-28, 36, 9); ctx.fill();
  ctx.strokeStyle = "#FDE68A"; roundRect(ctx, 14, y, w-28, 36, 9); ctx.stroke();
  ctx.fillStyle = COLORS.amber; ctx.font="600 10px Arial";
  wrapText(ctx, "⏰ Please arrive on time — late arrivals disrupt the schedule.", 24, y+15, w-60, 13);
  y += 50;

  if(ctPlan && ctPlan.format==="league"){
    // CT League: show teams by Group A/B
    const groupDefs = [
      {label:"Group A", gc:"#6366F1", teams: ctPlan.groupA||ctPlan.teams.filter(t=>t.poolIdx===0), courts:ctPlan.courtsA},
      {label:"Group B", gc:"#06B6D4", teams: ctPlan.groupB||ctPlan.teams.filter(t=>t.poolIdx===1), courts:ctPlan.courtsB},
    ].filter(g=>g.teams.length>0);
    ctx.fillStyle = COLORS.text; ctx.font="700 13px Arial";
    ctx.fillText(`Teams (${ctPlan.teams.length}) · ${groupDefs.length} groups`, 14, y); y += 18;
    groupDefs.forEach(g=>{
      const {gc} = g;
      ctx.fillStyle = gc; ctx.font="700 10px Arial";
      ctx.fillText(`${g.label}  ·  Courts ${1+(g.label==="A"?0:ctPlan.courtsA)}${g.courts>1?"–"+(g.label==="A"?ctPlan.courtsA:ctPlan.courts):""}`, 14, y+11);
      ctx.strokeStyle = gc+"55"; ctx.lineWidth=0.5;
      ctx.beginPath(); ctx.moveTo(160, y+7); ctx.lineTo(w-14, y+7); ctx.stroke();
      y += 20;
      g.teams.forEach((t,i)=>{
        ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
        roundRect(ctx, 14, y, w-28, 30, 8); ctx.fill();
        ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 30, 8); ctx.stroke();
        ctx.fillStyle = gc; ctx.font="700 10px Arial";
        ctx.fillText(t.name, 24, y+13);
        ctx.fillStyle = COLORS.sub; ctx.font="10px Arial";
        fitText(ctx, teamLabel(t), 24, y+26, w-28-80);
        ctx.fillStyle = COLORS.dim; ctx.font="9px Arial"; ctx.textAlign="right";
        ctx.fillText(`avg ${t.avgUsr}`, w-20, y+20); ctx.textAlign="left";
        y += 36;
      });
      y += 4;
    });
  } else if(ctPlan){
    // CT Ladder: show teams grouped by Pool
    const pools = [...new Set(ctPlan.teams.map(t=>t.poolIdx))].sort();
    ctx.fillStyle = COLORS.text; ctx.font="700 13px Arial";
    ctx.fillText(`Teams (${ctPlan.teams.length}) · ${pools.length} pools`, 14, y); y += 14;
    ctx.fillStyle = COLORS.dim; ctx.font="10px Arial";
    ctx.fillText("Pools are for team formation only — no group stage in Ladder", 14, y); y += 14;
    pools.forEach(pi=>{
      const gc = poolColors[pi % poolColors.length];
      const poolTeams = ctPlan.teams.filter(t=>t.poolIdx===pi);
      ctx.fillStyle = gc; ctx.font="700 10px Arial";
      ctx.fillText(`Pool ${pi+1}`, 14, y+11);
      ctx.strokeStyle = gc+"66"; ctx.lineWidth=0.5;
      ctx.beginPath(); ctx.moveTo(56, y+7); ctx.lineTo(w-14, y+7); ctx.stroke();
      y += 20;
      poolTeams.forEach((t,i)=>{
        ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
        roundRect(ctx, 14, y, w-28, 30, 8); ctx.fill();
        ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 30, 8); ctx.stroke();
        ctx.fillStyle = gc; ctx.font="700 10px Arial";
        ctx.fillText(t.name, 24, y+13);
        ctx.fillStyle = COLORS.sub; ctx.font="10px Arial";
        fitText(ctx, teamLabel(t), 24, y+26, w-28-80);
        ctx.fillStyle = COLORS.dim; ctx.font="9px Arial"; ctx.textAlign="right";
        ctx.fillText(`avg ${t.avgUsr}`, w-20, y+20); ctx.textAlign="left";
        y += 36;
      });
      y += 4;
    });
  } else {
    // CI / Open: show individual players
    ctx.fillStyle = COLORS.text; ctx.font="700 13px Arial";
    ctx.fillText(`Registered players (${players.length})`, 14, y); y += 10;
    const sorted = [...players].sort((a,b)=>b.usr-a.usr);
    const gap = 6, colW = (w-28-gap)/2;
    sorted.forEach((p,i)=>{
      const col=i%2, row=Math.floor(i/2);
      const x = 14 + col*(colW+gap), yy = y + row*32;
      ctx.fillStyle = COLORS.card; roundRect(ctx, x, yy, colW, 26, 8); ctx.fill();
      ctx.strokeStyle = COLORS.border; roundRect(ctx, x, yy, colW, 26, 8); ctx.stroke();
      const lv = usrLv(p.usr);
      const photoImg = photoMap && photoMap.get(p.id);
      if (photoImg){
        ctx.save();
        ctx.beginPath(); ctx.arc(x+15, yy+13, 9, 0, Math.PI*2); ctx.clip();
        ctx.drawImage(photoImg, x+6, yy+4, 18, 18);
        ctx.restore();
      } else {
        ctx.fillStyle = lv.c+"33"; ctx.beginPath(); ctx.arc(x+15, yy+13, 9, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = lv.c; ctx.font="700 8px Arial"; ctx.textAlign="center";
        ctx.fillText((p.avatar||ini2(p.nickname)), x+15, yy+16); ctx.textAlign="left";
      }
      ctx.fillStyle = COLORS.text; ctx.font="600 11px Arial";
      fitText(ctx, p.nickname, x+28, yy+17, colW-58);
      ctx.fillStyle = COLORS.dim; ctx.font="9px Arial"; ctx.textAlign="right";
      ctx.fillText(`${p.usr}`, x+colW-8, yy+17); ctx.textAlign="left";
    });
  }

  drawFooter(ctx, w, h);
  return c;
}

function buildFullBreakTableCard(ev, venue, plan, tc, communityName){
  const players = plan.sorted; // ordered player list, same as the in-app Breaks tab
  const totalRounds = plan.totalRounds;
  const breakPlan = plan.breakPlan; // pre-computed for the WHOLE event, independent of how many rounds are generated yet
  const generatedCount = plan.rounds.length;
  const nameW = 80, colW = 34, rowH = 28;
  const tableX = 14;
  const minW = 320; // narrower floor than the standard CARD_W — table shrinks to fit when few rounds, widens only if needed
  const w = Math.max(minW, nameW + totalRounds*colW + 28);
  const h = 108 + 16 + 48 + 26 + players.length*rowH + 50;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Break schedule", `${totalRounds} rounds · ${tc} courts`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  const tableW = nameW + totalRounds*colW;
  const colHeaderH = 26;

  // Header row background
  ctx.fillStyle = COLORS.accent; roundRect(ctx, tableX, y, tableW, colHeaderH, 7); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font="700 9px Arial"; ctx.textAlign="left";
  ctx.fillText("PLAYER", tableX+8, y+17);
  ctx.textAlign = "center";
  for(let ri=0; ri<totalRounds; ri++){
    ctx.fillText(`R${ri+1}`, tableX+nameW+ri*colW+colW/2, y+17);
  }
  ctx.textAlign = "left";
  y += colHeaderH;

  const tableTop = y;
  players.forEach((p,i)=>{
    ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
    ctx.fillRect(tableX, y, tableW, rowH);
    ctx.fillStyle = COLORS.text; ctx.font="600 10px Arial";
    fitText(ctx, p.nickname, tableX+8, y+18, nameW-12);
    for(let ri=0; ri<totalRounds; ri++){
      const onBreak = (breakPlan[ri]||[]).includes(p.userId);
      const isPlanned = ri >= generatedCount; // not yet generated — still the planned allocation
      const cx = tableX+nameW+ri*colW+colW/2;
      if(onBreak){
        if(isPlanned){
          ctx.strokeStyle = COLORS.amber; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(cx, y+rowH/2, 9, 0, Math.PI*2); ctx.stroke();
        } else {
          ctx.fillStyle = COLORS.amber;
          ctx.beginPath(); ctx.arc(cx, y+rowH/2, 9, 0, Math.PI*2); ctx.fill();
        }
      } else {
        ctx.fillStyle = "#CBD5E1"; ctx.font="11px Arial"; ctx.textAlign="center";
        ctx.fillText("·", cx, y+rowH/2+3);
      }
      ctx.textAlign = "left";
    }
    y += rowH;
  });
  const tableBottom = y;

  // Grid lines: outer border + column separators + row separators
  ctx.strokeStyle = COLORS.border; ctx.lineWidth = 1;
  ctx.strokeRect(tableX, tableTop, tableW, tableBottom-tableTop);
  ctx.beginPath();
  ctx.moveTo(tableX+nameW, tableTop); ctx.lineTo(tableX+nameW, tableBottom);
  for(let ri=1; ri<totalRounds; ri++){
    const lx = tableX+nameW+ri*colW;
    ctx.moveTo(lx, tableTop); ctx.lineTo(lx, tableBottom);
  }
  for(let i=1; i<players.length; i++){
    const ly = tableTop + i*rowH;
    ctx.moveTo(tableX, ly); ctx.lineTo(tableX+tableW, ly);
  }
  ctx.stroke();

  y = tableBottom + 16;
  if(generatedCount < totalRounds){
    ctx.fillStyle = COLORS.dim; ctx.font="9px Arial";
    ctx.fillText(`● filled = confirmed   ○ outline = planned (rounds ${generatedCount+1}–${totalRounds})`, tableX, y);
  }

  drawFooter(ctx, w, h);
  return c;

}

function buildRound1Card(ev,venue,plan,tc,communityName){
  const w = 340; // narrower than the standard CARD_W — taller, more mobile-friendly proportions
  const r1 = plan.rounds[0];
  const hasBreak = (r1.onBreak||[]).length>0;
  const h = 108 + 16 + 48 + (hasBreak?52:0) + r1.matches.length*70 + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Round 1 matches", `${plan.totalRounds} rounds total · ${tc} courts`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  if(hasBreak){
    ctx.fillStyle = "#FEF3C7"; roundRect(ctx, 14, y, w-28, 40, 9); ctx.fill();
    ctx.strokeStyle = "#FDE68A"; roundRect(ctx, 14, y, w-28, 40, 9); ctx.stroke();
    ctx.fillStyle = COLORS.amber; ctx.font="700 10px Arial";
    ctx.fillText("☕ On break this round", 24, y+16);
    ctx.fillStyle = COLORS.text; ctx.font="600 11px Arial";
    fitText(ctx, r1.onBreak.map(p=>p.nickname).join(", "), 24, y+32, w-48);
    y += 52;
  }

  r1.matches.forEach(m=>{
    ctx.fillStyle = COLORS.card; roundRect(ctx, 14, y, w-28, 64, 12); ctx.fill();
    ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 64, 12); ctx.stroke();
    ctx.fillStyle = COLORS.accent; ctx.font="700 9px Arial"; ctx.textAlign="left";
    ctx.fillText(`COURT ${m.court}`, 24, y+16);

    const teamA = m.teamA.map(p=>p.nickname).join(" & ");
    const teamB = m.teamB.map(p=>p.nickname).join(" & ");
    const maxTextW = w - 28 - 20;

    ctx.fillStyle = COLORS.text; ctx.font="700 13px Arial";
    fitText(ctx, teamA, 24, y+32, maxTextW);

    ctx.fillStyle = COLORS.dim; ctx.font="600 9px Arial";
    ctx.fillText("VS", 24, y+44);

    ctx.fillStyle = COLORS.text; ctx.font="700 13px Arial";
    fitText(ctx, teamB, 24, y+58, maxTextW);

    y += 70;
  });

  drawFooter(ctx, w, h);
  return c;
}

function drawEventStrip(ctx, w, y, ev, venue){
  const text = `${sportLabel(ev.sport||DEFAULT_SPORT)}  ·  ${fmtD(ev.date)} · ${fmtT(ev.time)}${ev.timeTo?" → "+fmtT(ev.timeTo):""}${venue?"  ·  📍 "+venue.name:""}`;
  ctx.fillStyle = COLORS.card; roundRect(ctx, 16, y, w-32, 38, 10); ctx.fill();
  ctx.strokeStyle = COLORS.border; roundRect(ctx, 16, y, w-32, 38, 10); ctx.stroke();
  ctx.fillStyle = COLORS.text; ctx.font="700 12px Arial";
  fitText(ctx, ev.name, 26, y+16, w-52);
  ctx.fillStyle = COLORS.sub; ctx.font="10px Arial";
  fitText(ctx, text, 26, y+31, w-52);
  return y + 48;
}

// Draws a 1-2-3 podium strip (top3 in RANK order) for the share-image standings cards.
// Returns the podium's total height so callers can size the card correctly up front.
const PODIUM_H = 192;
function drawPodium(ctx, w, y, top3){
  if(!top3||top3.length===0) return y;
  const medals=["🥇","🥈","🥉"], colors=["#FBBF24","#94A3B8","#CD7C2F"];
  const barHByRank=[92,62,44]; // indexed by RANK (0=1st=tallest), not visual position
  const order=[1,0,2].filter(i=>top3[i]); // visual: 2nd, 1st, 3rd
  const colW=(w-32)/3, baseY=y+PODIUM_H-14;
  order.forEach((rank,pos)=>{
    const e=top3[rank]; if(!e) return;
    const barH=barHByRank[rank];
    const cx = 16 + colW*pos + colW/2;
    let ty = baseY-barH-34;
    ctx.font = "24px Arial"; ctx.textAlign="center";
    ctx.fillText(medals[rank], cx, ty);
    ty -= 20;
    ctx.fillStyle = COLORS.text; ctx.font="700 12px Arial";
    fitTextCentered(ctx, e.name, cx, ty, colW-10);
    if(e.players&&e.players.length>0){
      ty -= 13; ctx.fillStyle = COLORS.dim; ctx.font="8px Arial";
      fitTextCentered(ctx, e.players.map(p=>p.nickname).join(" & "), cx, ty, colW-10);
    }
    if(e.usrLine){ ty -= 13; ctx.fillStyle = COLORS.dim; ctx.font="8px Arial"; fitTextCentered(ctx, e.usrLine, cx, ty, colW-10); }
    ctx.fillStyle = colors[rank]; ctx.font="700 11px Arial";
    ctx.fillText(`${e.value}${e.valueLabel?" "+e.valueLabel:""}`, cx, baseY-barH+2);
    ctx.fillStyle = `${colors[rank]}33`;
    roundRect(ctx, 16+colW*pos+8, baseY-barH, colW-16, barH, 6); ctx.fill();
    ctx.strokeStyle = `${colors[rank]}77`;
    roundRect(ctx, 16+colW*pos+8, baseY-barH, colW-16, barH, 6); ctx.stroke();
    ctx.fillStyle = colors[rank]; ctx.font="800 18px Arial";
    ctx.fillText(`${rank+1}`, cx, baseY-barH/2+6);
    ctx.textAlign="left";
  });
  return y + PODIUM_H;
}
function fitTextCentered(ctx,text,cx,y,maxW){
  ctx.textAlign="center";
  let t=text||""; while(ctx.measureText(t).width>maxW && t.length>1) t=t.slice(0,-2)+"…";
  ctx.fillText(t,cx,y);
}

// Wraps to a 2nd line instead of truncating — used for names, since cutting someone's
// name off with "…" reads badly. yBottom is the baseline of the LOWER line (closest to
// whatever sits below it); returns the number of lines actually drawn (1 or 2) so the
// caller can reserve extra vertical space when it wraps.
function fitTextWrapCentered(ctx,text,cx,yBottom,maxW,lineH){
  ctx.textAlign="center";
  const t=text||"";
  if(ctx.measureText(t).width<=maxW){ ctx.fillText(t,cx,yBottom); return 1; }
  let top,bottom;
  if(t.includes(" & ")){
    const i=t.indexOf(" & ");
    top=t.slice(0,i).trim(); bottom=("& "+t.slice(i+3)).trim();
  } else {
    const words=t.split(" "); const mid=Math.ceil(words.length/2);
    top=words.slice(0,mid).join(" "); bottom=words.slice(mid).join(" ")||top;
    if(!words.slice(mid).length){ top=t; bottom=""; }
  }
  while(ctx.measureText(top).width>maxW && top.length>1) top=top.slice(0,-2)+"…";
  while(ctx.measureText(bottom).width>maxW && bottom.length>1) bottom=bottom.slice(0,-2)+"…";
  ctx.fillText(bottom,cx,yBottom);
  if(top) ctx.fillText(top,cx,yBottom-lineH);
  return top?2:1;
}

function buildStandingsCard(ev,venue,ciStands,tc,plan,communityName){
  const w = CARD_W;
  const h = 108 + 16 + 48 + ciStands.length*52 + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Final standings", `${plan.rounds.length} rounds`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  ciStands.forEach((s,i)=>{
    const maxPts = personalMaxCI(s.breaks, personalRoundsCI(s.user.id, plan), tc);
    const pes = maxPts>0 ? Math.round((s.pts/maxPts)*100*10)/10 : 0;
    const isTop = i===0;
    ctx.fillStyle = isTop ? "#FEF3C7" : COLORS.card;
    roundRect(ctx, 14, y, w-28, 44, 11); ctx.fill();
    ctx.strokeStyle = isTop ? "#FDE68A" : COLORS.border;
    roundRect(ctx, 14, y, w-28, 44, 11); ctx.stroke();

    ctx.fillStyle = isTop ? COLORS.amber : i===1?"#64748B":i===2?"#B45309":COLORS.text;
    ctx.font = "700 14px Arial";
    fitText(ctx, `${isTop?"🏆":i+1+"."} ${s.user.nickname}`, 24, y+19, w-130);
    ctx.fillStyle = COLORS.dim; ctx.font="10px Arial";
    fitText(ctx, `${s.wins}W · ${s.breaks} breaks · PES ${pes}%`, 24, y+34, w-130);

    ctx.fillStyle = COLORS.accent; ctx.font="700 19px Arial"; ctx.textAlign="right";
    ctx.fillText(`${s.pts}`, w-24, y+25);
    ctx.fillStyle = COLORS.dim; ctx.font="9px Arial";
    ctx.fillText("pts", w-24, y+37); ctx.textAlign="left";
    y += 52;
  });

  drawFooter(ctx, w, h);
  return c;
}

function buildResultsTableCard(ev,venue,plan,ciStands,tc,communityName){
  const colW=42, nameW=110, pesW=40, ptsW=38;
  const tableX = 14;
  const w = Math.max(CARD_W, nameW+plan.rounds.length*colW+pesW+ptsW+28);
  const h = 108 + 16 + 48 + 24 + ciStands.length*30 + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Match results", `${plan.rounds.length} rounds`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  const tableW = nameW + plan.rounds.length*colW + pesW + ptsW;
  const headerH = 24;
  ctx.fillStyle = COLORS.accent; roundRect(ctx, tableX, y, tableW, headerH, 7); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font="700 9px Arial"; ctx.textAlign="left";
  ctx.fillText("PLAYER", tableX+8, y+16);
  ctx.textAlign = "center";
  plan.rounds.forEach((r,ri)=>ctx.fillText(`M${ri+1}`, tableX+nameW+ri*colW+colW/2, y+16));
  ctx.fillText("PES", tableX+nameW+plan.rounds.length*colW+pesW/2, y+16);
  ctx.fillText("PTS", tableX+nameW+plan.rounds.length*colW+pesW+ptsW/2, y+16);
  ctx.textAlign = "left";
  y += headerH;
  const tableTop = y;

  const cellFor=(uid,round)=>{
    const onBreak=(round.onBreak||[]).some(p=>p.userId===uid);
    if(onBreak) return {text:"Brk",win:false};
    for(const m of round.matches){
      const inA=m.teamA.some(p=>p.userId===uid), inB=m.teamB.some(p=>p.userId===uid);
      if(inA||inB){const won=(inA&&m.winner==="A")||(inB&&m.winner==="B");return {text:`C${m.court}${won?"W":""}`,win:won};}
    }
    return {text:"—",win:false};
  };
  const rowH = 30;
  ciStands.forEach((s,i)=>{
    const maxPts = personalMaxCI(s.breaks, personalRoundsCI(s.user.id, plan), tc);
    const pes = maxPts>0 ? Math.round((s.pts/maxPts)*100*10)/10 : 0;
    ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
    ctx.fillRect(tableX, y, tableW, rowH);
    ctx.fillStyle = COLORS.text; ctx.font="700 9px Arial";
    fitText(ctx, `${i+1}. ${s.user.nickname}`, tableX+8, y+18, nameW-12);
    plan.rounds.forEach((r,ri)=>{
      const cell = cellFor(s.user.id,r);
      ctx.fillStyle = cell.win ? COLORS.green : cell.text==="Brk" ? COLORS.dim : COLORS.sub;
      ctx.font = cell.win ? "700 9px Arial" : "9px Arial";
      ctx.textAlign = "center";
      ctx.fillText(cell.text, tableX+nameW+ri*colW+colW/2, y+18);
      ctx.textAlign = "left";
    });
    ctx.fillStyle = COLORS.sub; ctx.font="700 9px Arial"; ctx.textAlign="center";
    ctx.fillText(`${pes}%`, tableX+nameW+plan.rounds.length*colW+pesW/2, y+18);
    ctx.fillStyle = COLORS.accent; ctx.font="700 10px Arial";
    ctx.fillText(`${s.pts}`, tableX+nameW+plan.rounds.length*colW+pesW+ptsW/2, y+18);
    ctx.textAlign = "left";
    y += rowH;
  });
  const tableBottom = y;

  ctx.strokeStyle = COLORS.border; ctx.lineWidth = 1;
  ctx.strokeRect(tableX, tableTop, tableW, tableBottom-tableTop);
  ctx.beginPath();
  ctx.moveTo(tableX+nameW, tableTop); ctx.lineTo(tableX+nameW, tableBottom);
  for(let ri=1; ri<plan.rounds.length; ri++){
    const lx = tableX+nameW+ri*colW;
    ctx.moveTo(lx, tableTop); ctx.lineTo(lx, tableBottom);
  }
  ctx.moveTo(tableX+nameW+plan.rounds.length*colW, tableTop); ctx.lineTo(tableX+nameW+plan.rounds.length*colW, tableBottom);
  ctx.moveTo(tableX+nameW+plan.rounds.length*colW+pesW, tableTop); ctx.lineTo(tableX+nameW+plan.rounds.length*colW+pesW, tableBottom);
  for(let i=1; i<ciStands.length; i++){
    const ly = tableTop + i*rowH;
    ctx.moveTo(tableX, ly); ctx.lineTo(tableX+tableW, ly);
  }
  ctx.stroke();

  drawFooter(ctx, w, h);
  return c;
}

function buildRoundResultsCard(ev,venue,plan,communityName){
  const w = CARD_W;
  let estH = 108 + 16 + 48;
  plan.rounds.forEach(r=>{ estH += 22 + r.matches.length*58; });
  const h = estH + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Round-by-round results", `${plan.rounds.length} rounds played`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);
  plan.rounds.forEach((r,ri)=>{
    ctx.fillStyle = COLORS.text; ctx.font="700 13px Arial";
    ctx.fillText(`Round ${ri+1}`, 14, y); y += 18;
    r.matches.forEach(m=>{
      const teamA = m.teamA.map(p=>p.nickname).join(" & ");
      const teamB = m.teamB.map(p=>p.nickname).join(" & ");
      const winner = m.winner==="A"?"A":m.winner==="B"?"B":null;
      const maxTextW = w - 28 - 20;
      ctx.fillStyle = COLORS.card; roundRect(ctx, 14, y, w-28, 50, 11); ctx.fill();
      ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 50, 11); ctx.stroke();
      ctx.fillStyle = COLORS.dim; ctx.font="700 8px Arial";
      ctx.fillText(`COURT ${m.court}`, 24, y+14);
      ctx.fillStyle = winner==="A" ? COLORS.green : COLORS.text; ctx.font="700 11px Arial";
      fitText(ctx, (winner==="A"?"✓ ":"")+teamA, 24, y+28, maxTextW);
      ctx.fillStyle = winner==="B" ? COLORS.green : COLORS.text; ctx.font="700 11px Arial";
      fitText(ctx, (winner==="B"?"✓ ":"")+teamB, 24, y+42, maxTextW);
      y += 58;
    });
    y += 4;
  });

  drawFooter(ctx, w, h);
  return c;
}

function teamLabel(t){ return (t.players||[]).map(p=>p.nickname).join(" & "); }

function buildLeaguePoolsCard(ev, venue, plan, communityName){
  const w = CARD_W;
  const groupColors = ["#6366F1","#06B6D4"];
  const groups = [
    {label:"Group A", courts:plan.courtsA, courtStart:1,            teams:plan.groupA||plan.teams.filter(t=>t.poolIdx===0), matches:(plan.rounds[0]?.matchesA||[])},
    {label:"Group B", courts:plan.courtsB, courtStart:plan.courtsA+1, teams:plan.groupB||plan.teams.filter(t=>t.poolIdx===1), matches:(plan.rounds[0]?.matchesB||[])},
  ].filter(g=>g.teams.length>0);

  let estH = 108 + 16 + 48;
  groups.forEach(g=>{ estH += 32 + g.matches.length*50; });
  const h = estH + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "League schedule", `${groups.length} groups · ${plan.courts} courts`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  groups.forEach((g, gi)=>{
    const gc = groupColors[gi % groupColors.length];

    // Group header
    ctx.fillStyle = gc; roundRect(ctx, 14, y, w-28, 24, 8); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font="700 11px Arial"; ctx.textAlign="left";
    ctx.fillText(`${g.label} — ${g.teams.length} teams`, 22, y+17);
    ctx.font="600 10px Arial"; ctx.textAlign="right";
    ctx.fillText(`Courts ${g.courtStart}${g.courts>1?"–"+(g.courtStart+g.courts-1):""}`, w-22, y+17);
    ctx.textAlign="left";
    y += 32;

    // Matches
    g.matches.forEach((m,i)=>{
      ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
      roundRect(ctx, 14, y, w-28, 44, 10); ctx.fill();
      ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 44, 10); ctx.stroke();

      // Court badge
      ctx.fillStyle = gc+"22"; roundRect(ctx, 20, y+10, 28, 24, 6); ctx.fill();
      ctx.fillStyle = gc; ctx.font="700 12px Arial"; ctx.textAlign="center";
      ctx.fillText("C"+m.court, 34, y+26);
      ctx.textAlign="left";

      // Team names
      ctx.fillStyle = COLORS.text; ctx.font="700 12px Arial";
      fitText(ctx, m.teamA?.name||"?", 60, y+19, w-80);
      ctx.fillStyle = COLORS.dim; ctx.font="600 9px Arial";
      ctx.fillText("vs", 60, y+32);
      ctx.fillStyle = COLORS.sub; ctx.font="600 11px Arial";
      fitText(ctx, m.teamB?.name||"?", 74, y+32, w-90);

      y += 50;
    });
    y += 6;
  });

  drawFooter(ctx, w, h);
  return c;
}

function buildLadderPoolsCard(ev, venue, plan, communityName){
  const w = CARD_W;
  const poolNums = [...new Set((plan.teams||[]).map(t=>t.poolIdx))].sort();
  const poolColors = ["#6366F1","#06B6D4","#F472B6","#34D399","#F59E0B"];
  let estH = 108 + 16 + 48 + 16;
  poolNums.forEach(pi=>{ const n=(plan.teams||[]).filter(t=>t.poolIdx===pi).length; estH += 24 + n*42; });
  const h = estH + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Team formation", `${plan.teams.length} teams formed from ${poolNums.length} pools`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);
  ctx.fillStyle = COLORS.sub; ctx.font="10px Arial";
  ctx.fillText("Pools are used for team formation only — Ladder has no group stage.", 14, y);
  y += 20;

  poolNums.forEach(pi=>{
    const gc = poolColors[pi % poolColors.length];
    const poolTeams = (plan.teams||[]).filter(t=>t.poolIdx===pi);
    ctx.fillStyle = gc; roundRect(ctx, 14, y, w-28, 22, 7); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font="700 10px Arial";
    ctx.fillText(`Pool ${pi+1} — ${poolTeams.length} teams`, 22, y+15);
    y += 30;
    poolTeams.forEach((t,i)=>{
      ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
      roundRect(ctx, 14, y, w-28, 36, 10); ctx.fill();
      ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 36, 10); ctx.stroke();
      ctx.fillStyle = gc; ctx.font="700 11px Arial";
      fitText(ctx, t.name, 24, y+14, 70);
      ctx.fillStyle = COLORS.sub; ctx.font="11px Arial";
      fitText(ctx, teamLabel(t), 24, y+28, w-28-110);
      ctx.fillStyle = COLORS.dim; ctx.font="10px Arial"; ctx.textAlign="right";
      ctx.fillText(`avg ${t.avgUsr}`, w-24, y+21); ctx.textAlign="left";
      y += 42;
    });
    y += 6;
  });

  drawFooter(ctx, w, h);
  return c;
}

function buildLadderRound1Card(ev,venue,plan,tc,communityName){
  const w = 340;
  const r1 = plan.rounds[0];
  const hasBreak = (r1.onBreak||[]).length>0;
  const h = 108 + 16 + 48 + (hasBreak?52:0) + r1.matchesA.length*70 + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Round 1 matches", `Ladder · ${plan.maxRounds||"?"} rounds total · ${tc} courts`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  if(hasBreak){
    ctx.fillStyle = "#FEF3C7"; roundRect(ctx, 14, y, w-28, 40, 9); ctx.fill();
    ctx.strokeStyle = "#FDE68A"; roundRect(ctx, 14, y, w-28, 40, 9); ctx.stroke();
    ctx.fillStyle = COLORS.amber; ctx.font="700 10px Arial";
    ctx.fillText("☕ On break this round", 24, y+16);
    ctx.fillStyle = COLORS.text; ctx.font="600 11px Arial";
    fitText(ctx, r1.onBreak.map(t=>t.name).join(", "), 24, y+32, w-48);
    y += 52;
  }

  r1.matchesA.forEach(m=>{
    ctx.fillStyle = COLORS.card; roundRect(ctx, 14, y, w-28, 64, 12); ctx.fill();
    ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 64, 12); ctx.stroke();
    ctx.fillStyle = COLORS.accent; ctx.font="700 9px Arial"; ctx.textAlign="left";
    ctx.fillText(`COURT ${m.court}`, 24, y+16);

    const maxTextW = w - 28 - 20;
    ctx.fillStyle = COLORS.text; ctx.font="700 12px Arial";
    fitText(ctx, `${m.teamA.name} — ${teamLabel(m.teamA)}`, 24, y+32, maxTextW);
    ctx.fillStyle = COLORS.dim; ctx.font="600 9px Arial";
    ctx.fillText("VS", 24, y+44);
    ctx.fillStyle = COLORS.text; ctx.font="700 12px Arial";
    fitText(ctx, `${m.teamB.name} — ${teamLabel(m.teamB)}`, 24, y+58, maxTextW);

    y += 70;
  });

  drawFooter(ctx, w, h);
  return c;
}

function buildLadderBreakTableCard(ev, venue, plan, tc, communityName){
  const teams = plan.sorted;
  const totalRounds = plan.maxRounds || plan.rounds.length;
  const breakPlan = plan.breakPlan || [];
  const generatedCount = plan.rounds.length;
  const nameW = 130, colW = 34, rowH = 34; // taller rows to fit 2 lines (team name + members)
  const tableX = 14;
  const minW = 320;
  const w = Math.max(minW, nameW + totalRounds*colW + 28);
  const h = 108 + 16 + 48 + 26 + teams.length*rowH + 50;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Break schedule", `Ladder · ${totalRounds} rounds · ${tc} courts`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  const tableW = nameW + totalRounds*colW;
  const colHeaderH = 26;
  ctx.fillStyle = COLORS.accent; roundRect(ctx, tableX, y, tableW, colHeaderH, 7); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font="700 9px Arial"; ctx.textAlign="left";
  ctx.fillText("TEAM", tableX+8, y+17);
  ctx.textAlign = "center";
  for(let ri=0; ri<totalRounds; ri++) ctx.fillText(`R${ri+1}`, tableX+nameW+ri*colW+colW/2, y+17);
  ctx.textAlign = "left";
  y += colHeaderH;

  const tableTop = y;
  teams.forEach((t,i)=>{
    ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
    ctx.fillRect(tableX, y, tableW, rowH);
    // Team name (bold) + members (dim, smaller)
    ctx.fillStyle = COLORS.text; ctx.font="700 10px Arial";
    fitText(ctx, t.name, tableX+8, y+13, nameW-12);
    ctx.fillStyle = COLORS.dim; ctx.font="9px Arial";
    fitText(ctx, (t.players||[]).map(p=>p.nickname).join(" & "), tableX+8, y+25, nameW-12);
    for(let ri=0; ri<totalRounds; ri++){
      const onBreak = (breakPlan[ri]||[]).includes(t.id);
      const isPlanned = ri >= generatedCount;
      const cx = tableX+nameW+ri*colW+colW/2;
      if(onBreak){
        if(isPlanned){
          ctx.strokeStyle = COLORS.amber; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(cx, y+rowH/2, 9, 0, Math.PI*2); ctx.stroke();
        } else {
          ctx.fillStyle = COLORS.amber;
          ctx.beginPath(); ctx.arc(cx, y+rowH/2, 9, 0, Math.PI*2); ctx.fill();
        }
      } else {
        ctx.fillStyle = "#CBD5E1"; ctx.font="11px Arial"; ctx.textAlign="center";
        ctx.fillText("·", cx, y+rowH/2+3);
      }
      ctx.textAlign = "left";
    }
    y += rowH;
  });
  const tableBottom = y;

  ctx.strokeStyle = COLORS.border; ctx.lineWidth = 1;
  ctx.strokeRect(tableX, tableTop, tableW, tableBottom-tableTop);
  ctx.beginPath();
  ctx.moveTo(tableX+nameW, tableTop); ctx.lineTo(tableX+nameW, tableBottom);
  for(let ri=1; ri<totalRounds; ri++){
    const lx = tableX+nameW+ri*colW;
    ctx.moveTo(lx, tableTop); ctx.lineTo(lx, tableBottom);
  }
  for(let i=1; i<teams.length; i++){
    const ly = tableTop + i*rowH;
    ctx.moveTo(tableX, ly); ctx.lineTo(tableX+tableW, ly);
  }
  ctx.stroke();

  y = tableBottom + 16;
  if(generatedCount < totalRounds){
    ctx.fillStyle = COLORS.dim; ctx.font="9px Arial";
    ctx.fillText(`● filled = confirmed   ○ outline = planned (rounds ${generatedCount+1}–${totalRounds})`, tableX, y);
  }

  drawFooter(ctx, w, h);
  return c;
}

function buildLeagueMatchResultsCard(ev, venue, plan, communityName){
  const w = CARD_W;
  const groupColors = {A:"#6366F1",B:"#06B6D4"};
  const rounds = (plan.rounds||[]).map(r=>({
    roundNum: r.roundNum,
    matches: [...(r.matchesA||[]).map(m=>({...m,side:"A"})), ...(r.matchesB||[]).map(m=>({...m,side:"B"}))]
      .sort((a,b)=>a.court-b.court||(a.winner?1:0)-(b.winner?1:0)),
  })).filter(r=>r.matches.length>0);
  const hasBothGroups = (plan.groupB?.length||0) > 0;

  let estH = 108 + 16 + 48;
  rounds.forEach(r=>{ estH += 28 + r.matches.length*64; });
  const h = estH + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Match results", "League", communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  rounds.forEach((r)=>{
    ctx.fillStyle = COLORS.accent; roundRect(ctx, 14, y, w-28, 22, 7); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font="700 10px Arial";
    ctx.fillText(`League Round ${r.roundNum} — ${r.matches.length} matches`, 22, y+15);
    y += 28;

    r.matches.forEach((m,i)=>{
      const gc = groupColors[m.side]||COLORS.accent;
      const won_A = m.winner==="A", won_B = m.winner==="B";
      ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
      roundRect(ctx, 14, y, w-28, 58, 9); ctx.fill();
      ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 58, 9); ctx.stroke();

      // Court badge (+ small group tag underneath, only if both groups exist this event)
      ctx.fillStyle = gc+"22"; roundRect(ctx, 20, y+15, 28, 28, 6); ctx.fill();
      ctx.fillStyle = gc; ctx.font="700 12px Arial"; ctx.textAlign="center";
      ctx.fillText("C"+m.court, 34, hasBothGroups?y+28:y+33);
      if(hasBothGroups){ ctx.font="700 7px Arial"; ctx.fillText("GRP "+m.side, 34, y+38); }
      ctx.textAlign="left";

      // Team A
      const nameW = w-28-80;
      const playersA = (m.teamA?.players||[]).map(p=>p.nickname).join(" & ");
      ctx.fillStyle = won_A ? COLORS.green : COLORS.text;
      ctx.font = won_A ? "700 11px Arial" : "600 11px Arial";
      fitText(ctx, (won_A?"✓ ":"")+m.teamA?.name, 58, y+16, nameW);
      ctx.fillStyle = COLORS.dim; ctx.font="8px Arial";
      fitText(ctx, playersA, 58, y+27, nameW);

      // Score
      if(m.winner){
        const score = `${m.scoreA??0}–${m.scoreB??0}`;
        ctx.fillStyle = COLORS.dim; ctx.font="700 10px Arial"; ctx.textAlign="right";
        ctx.fillText(score, w-22, y+30); ctx.textAlign="left";
      }

      // Team B
      const playersB = (m.teamB?.players||[]).map(p=>p.nickname).join(" & ");
      ctx.fillStyle = won_B ? COLORS.green : COLORS.sub;
      ctx.font = won_B ? "700 11px Arial" : "11px Arial";
      fitText(ctx, (won_B?"✓ ":"")+m.teamB?.name, 58, y+44, nameW);
      ctx.fillStyle = COLORS.dim; ctx.font="8px Arial";
      fitText(ctx, playersB, 58, y+55, nameW);

      if(!m.winner){
        ctx.fillStyle = COLORS.dim; ctx.font="9px Arial"; ctx.textAlign="right";
        ctx.fillText("pending", w-22, y+30); ctx.textAlign="left";
      }

      y += 64;
    });
    y += 6;
  });

  drawFooter(ctx, w, h);
  return c;
}

function buildCTStandingsCard(ev, venue, ctStands, format, communityName, users){
  const w = CARD_W;
  const h = 108 + 16 + 48 + ctStands.length*52 + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Final standings", format==="ladder"?"Ladder":"League", communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  ctStands.forEach((s,i)=>{
    const isTop = i===0;
    ctx.fillStyle = isTop ? "#FEF3C7" : COLORS.card;
    roundRect(ctx, 14, y, w-28, 44, 11); ctx.fill();
    ctx.strokeStyle = isTop ? "#FDE68A" : COLORS.border;
    roundRect(ctx, 14, y, w-28, 44, 11); ctx.stroke();

    ctx.fillStyle = isTop ? COLORS.amber : i===1?"#64748B":i===2?"#B45309":COLORS.text;
    ctx.font = "700 13px Arial";
    fitText(ctx, `${isTop?"🏆":i+1+"."} ${s.team.name}`, 24, y+17, w-130);
    ctx.fillStyle = COLORS.dim; ctx.font="9px Arial";
    fitText(ctx, teamLabel(s.team), 24, y+30, w-130);

    if(format==="ladder"){
      ctx.fillStyle = COLORS.accent; ctx.font="700 18px Arial"; ctx.textAlign="right";
      ctx.fillText(`${s.pts}`, w-24, y+25);
      ctx.fillStyle = COLORS.dim; ctx.font="9px Arial";
      ctx.fillText("pts", w-24, y+37); ctx.textAlign="left";
    } else {
      ctx.fillStyle = COLORS.accent; ctx.font="700 15px Arial"; ctx.textAlign="right";
      ctx.fillText(`${s.wins}W-${s.losses}L`, w-24, y+22);
      ctx.fillStyle = COLORS.dim; ctx.font="9px Arial";
      ctx.fillText(`diff ${s.scoreDiff>=0?"+":""}${s.scoreDiff}`, w-24, y+36); ctx.textAlign="left";
    }
    y += 52;
  });

  drawFooter(ctx, w, h);
  return c;
}

function buildCTResultsTableCard(ev, venue, plan, ctStands, tc, communityName){
  const colW=46, nameW=126, tesW=42, ptsW=38;
  const tableX=14;
  const rounds=plan.rounds||[];
  const w=Math.max(CARD_W, nameW+rounds.length*colW+tesW+ptsW+28);
  const h=108+16+48+24+ctStands.length*40+30;
  const {c,ctx}=makeCard(w,h);
  ctx.fillStyle=COLORS.bg; ctx.fillRect(0,0,w,h);
  let y=drawHeader(ctx,w,"Match results",`Ladder · ${rounds.length} rounds · ${tc} courts`,communityName);
  y+=16;
  y=drawEventStrip(ctx,w,y,ev,venue);

  const tableW=nameW+rounds.length*colW+tesW+ptsW;
  const headerH=24;
  ctx.fillStyle=COLORS.accent; roundRect(ctx,tableX,y,tableW,headerH,7); ctx.fill();
  ctx.fillStyle="#fff"; ctx.font="700 9px Arial"; ctx.textAlign="left";
  ctx.fillText("TEAM",tableX+8,y+16);
  ctx.textAlign="center";
  rounds.forEach((_,ri)=>ctx.fillText(`R${ri+1}`,tableX+nameW+ri*colW+colW/2,y+16));
  ctx.fillText("TES",tableX+nameW+rounds.length*colW+tesW/2,y+16);
  ctx.fillText("PTS",tableX+nameW+rounds.length*colW+tesW+ptsW/2,y+16);
  ctx.textAlign="left";
  y+=headerH;
  const tableTop=y;

  ctStands.forEach((s,si)=>{
    const maxPts=ctTeamMaxPts(s.team?.id,plan);
    const tes=maxPts>0?Math.round((s.pts/maxPts)*100*10)/10:0;
    ctx.fillStyle=si%2===0?COLORS.card:COLORS.cardAlt;
    ctx.fillRect(tableX,y,tableW,40);
    ctx.fillStyle=COLORS.text; ctx.font="700 10px Arial";
    fitText(ctx,s.team?.name,tableX+8,y+14,nameW-12);
    ctx.fillStyle=COLORS.dim; ctx.font="9px Arial";
    fitText(ctx,(s.team?.players||[]).map(p=>p.nickname.split(" ")[0]).join(" & "),tableX+8,y+28,nameW-12);

    rounds.forEach((r,ri)=>{
      const onBreak=(r.onBreak||[]).some(t=>t.id===s.team?.id);
      if(onBreak){
        ctx.fillStyle=COLORS.amber; ctx.font="11px Arial"; ctx.textAlign="center";
        ctx.fillText("☕",tableX+nameW+ri*colW+colW/2,y+16);
        ctx.fillStyle=COLORS.dim; ctx.font="8px Arial";
        ctx.fillText(`+${ctLadderBreakPts(tc)}`,tableX+nameW+ri*colW+colW/2,y+28);
      } else {
        const m=(r.matchesA||[]).find(m=>m.teamA?.id===s.team?.id||m.teamB?.id===s.team?.id);
        if(m){
          const isA=m.teamA?.id===s.team?.id;
          const won=(isA&&m.winner==="A")||(!isA&&m.winner==="B");
          const pts=won?ctLadderCourtPts(m.court,tc):0;
          ctx.fillStyle=m.winner?(won?COLORS.green:"#EF4444"):"var(--po-dim)";
          ctx.font=won?"700 10px Arial":"10px Arial"; ctx.textAlign="center";
          ctx.fillText(m.winner?(won?"W":"L"):"·",tableX+nameW+ri*colW+colW/2,y+16);
          if(m.winner){ctx.fillStyle=COLORS.dim; ctx.font="8px Arial"; ctx.fillText(`C${m.court}${won?` +${pts}`:""}`,tableX+nameW+ri*colW+colW/2,y+28);}
        } else {
          ctx.fillStyle=COLORS.dim; ctx.font="10px Arial"; ctx.textAlign="center";
          ctx.fillText("—",tableX+nameW+ri*colW+colW/2,y+20);
        }
      }
      ctx.textAlign="left";
    });

    ctx.fillStyle=COLORS.sub; ctx.font="700 10px Arial"; ctx.textAlign="center";
    ctx.fillText(`${tes}%`,tableX+nameW+rounds.length*colW+tesW/2,y+21);
    ctx.fillStyle=COLORS.accent; ctx.font="700 11px Arial";
    ctx.fillText(`${s.pts}`,tableX+nameW+rounds.length*colW+tesW+ptsW/2,y+21);
    ctx.textAlign="left";
    y+=40;
  });
  const tableBottom=y;

  ctx.strokeStyle=COLORS.border; ctx.lineWidth=1;
  ctx.strokeRect(tableX,tableTop,tableW,tableBottom-tableTop);
  ctx.beginPath();
  ctx.moveTo(tableX+nameW,tableTop); ctx.lineTo(tableX+nameW,tableBottom);
  for(let ri=1;ri<rounds.length;ri++){const lx=tableX+nameW+ri*colW;ctx.moveTo(lx,tableTop);ctx.lineTo(lx,tableBottom);}
  ctx.moveTo(tableX+nameW+rounds.length*colW,tableTop);ctx.lineTo(tableX+nameW+rounds.length*colW,tableBottom);
  ctx.moveTo(tableX+nameW+rounds.length*colW+tesW,tableTop);ctx.lineTo(tableX+nameW+rounds.length*colW+tesW,tableBottom);
  for(let i=1;i<ctStands.length;i++){const ly=tableTop+i*40;ctx.moveTo(tableX,ly);ctx.lineTo(tableX+tableW,ly);}
  ctx.stroke();

  drawFooter(ctx,w,h);
  return c;
}

// ── Shared UI ─────────────────────────────────────────
function Av({u,size=36}){
  const lv=usrLv(u.usr);
  const [broken,setBroken] = useState(false);
  if (u.photoURL && !broken) return <img src={u.photoURL} alt={u.nickname} referrerPolicy="no-referrer" onError={()=>setBroken(true)} style={{width:size,height:size,borderRadius:"50%",flexShrink:0,objectFit:"cover",border:`1.5px solid ${lv.c}55`}}/>;
  return <div style={{width:size,height:size,borderRadius:"50%",flexShrink:0,background:`${lv.c}22`,border:`1.5px solid ${lv.c}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.36,fontWeight:600,color:lv.c}}>{u.avatar||ini2(u.nickname)}</div>;
}
function Bdg({label,color}){return <span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:20,background:`${color}22`,color,border:`0.5px solid ${color}44`,whiteSpace:"nowrap"}}>{label}</span>;}
// Solid, not the soft `color22`-on-transparent pastel style every other badge on the card
// uses — those all look alike at a glance, and LIVE needs to be the one thing that doesn't.
function LiveBdg({label}){return <span style={{fontSize:11,fontWeight:800,padding:"3px 10px 3px 7px",borderRadius:20,background:"#EF4444",color:"#fff",whiteSpace:"nowrap",display:"inline-flex",alignItems:"center",gap:5,letterSpacing:0.3,boxShadow:"0 1px 4px #EF444466"}}><span style={{width:6,height:6,borderRadius:"50%",background:"#fff",animation:"liveDotPulse 1.4s ease-in-out infinite"}}/>{label}</span>;}
// "Level of the event" badge — a glowing colored ring around the average rating (see
// calcEventAvgUsr), reusing usrLv's own A-E bands/colors so it reads the same intensity scale
// as everywhere else in the app. size="lg" for the event header, default (sm) for cards.
// Padel's rating (USR) is natively a 0-100 number, so the circle shows just the number.
// Football's (FSR) is natively an A-E letter grade — showing a synthetic blended number next to
// it read as a fake USR (see BUGS.md history), so the circle shows just the letter instead. The
// small coin in the corner carries the sport itself, so neither reading needs a text label.
function EventLevelBadge({avg,size="sm",sport}){
  if(avg==null) return null;
  const lv=usrLv(avg);
  const big=size==="lg";
  const d=big?68:44;
  const isFootball=sport==="Football";
  const coinD=Math.round(d*0.42);
  const sc=SPORT_COLOR[sport];
  return <div title={`Event level — avg ${isFootball?"FSR":"USR"} ${isFootball?lv.l:avg}`} style={{position:"relative",width:d,height:d,flexShrink:0}}>
    <div style={{width:d,height:d,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background:`radial-gradient(circle, ${lv.c}33 0%, ${lv.c}11 70%)`,border:`${big?2.5:2}px solid ${lv.c}`,boxShadow:`0 0 ${big?18:9}px ${lv.c}66`}}>
      <div style={{fontSize:isFootball?(big?28:19):(big?24:15),fontWeight:800,color:lv.c,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{isFootball?lv.l:avg}</div>
    </div>
    {sc&&<div style={{position:"absolute",bottom:-2,right:-2,width:coinD,height:coinD,borderRadius:"50%",background:sc,border:"2px solid var(--po-card)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:Math.round(coinD*0.55),lineHeight:1}}>{SPORT_EMOJI[sport]}</div>}
  </div>;
}

// top3: array of up to 3 {name, avatarUser, players, value, valueLabel, usrLine} in RANK order (1st, 2nd, 3rd).
// avatarUser: single user (CI). players: array of users (CT, shows each member's avatar+name).
// usrLine: pre-formatted string like "USR 62 (+3)" or "Avg USR 58 (+2)".
function Podium({top3,title}){
  if(!top3||top3.length===0) return null;
  const order=[1,0,2].filter(i=>top3[i]); // visual order: 2nd left, 1st center, 3rd right
  const heights=[96,130,76], medals=["🥇","🥈","🥉"], colors=["#FBBF24","#94A3B8","#CD7C2F"];
  return <Card style={{marginBottom:12,background:"linear-gradient(180deg,#6366F111,transparent)"}}>
    <div style={{textAlign:"center",fontSize:13,fontWeight:700,color:"var(--po-text)",marginBottom:14}}>🏆 {title||"Final Standings"}</div>
    <div style={{display:"flex",alignItems:"flex-end",justifyContent:"center",gap:8}}>
      {order.map((rank,pos)=>{const e=top3[rank]; if(!e) return null; return <div key={rank} style={{display:"flex",flexDirection:"column",alignItems:"center",width:100}}>
        <div style={{fontSize:22,marginBottom:4}}>{medals[rank]}</div>
        {e.players&&e.players.length>0
          ? <div style={{display:"flex",gap:-6}}>{e.players.map((p,pi)=><div key={p.id||pi} style={{marginLeft:pi>0?-8:0,border:"2px solid var(--po-bg)",borderRadius:"50%"}}><Av u={p} size={rank===0?38:32}/></div>)}</div>
          : e.avatarUser?<Av u={e.avatarUser} size={rank===0?48:38}/>:null}
        <div style={{fontSize:12,fontWeight:700,color:"var(--po-text)",marginTop:6,textAlign:"center",lineHeight:1.2}}>{e.name}</div>
        {e.players&&e.players.length>0&&<div style={{fontSize:9,color:"var(--po-dim)",textAlign:"center",lineHeight:1.2}}>{e.players.map(p=>p.nickname).join(" & ")}</div>}
        {e.usrLine&&<div style={{fontSize:9,color:"var(--po-dim)",marginTop:1}}>{e.usrLine}</div>}
        <div style={{fontSize:11,color:colors[rank],fontWeight:700,marginTop:2}}>{e.value}{e.valueLabel?` ${e.valueLabel}`:""}</div>
        <div style={{width:"100%",height:heights[pos],background:`${colors[rank]}22`,border:`0.5px solid ${colors[rank]}55`,borderRadius:"8px 8px 0 0",marginTop:8,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:8}}>
          <span style={{fontSize:20,fontWeight:800,color:colors[rank]}}>{rank+1}</span>
        </div>
      </div>;})}
    </div>
  </Card>;
}
function Btn({label,onClick,primary,danger,disabled,style={}}){
  const bg=primary?"#6366F1":danger?"#EF444422":"transparent", bc=primary?"#6366F1":danger?"#EF4444":"var(--po-bdr)", cl=primary?"#fff":danger?"#EF4444":"var(--po-sub)";
  return <button onClick={onClick} disabled={disabled} style={{padding:"9px 16px",borderRadius:8,border:`0.5px solid ${bc}`,background:disabled?"var(--po-bdr)":bg,color:disabled?"var(--po-dim)":cl,fontSize:13,fontWeight:500,cursor:disabled?"default":"pointer",opacity:disabled?0.6:1,...style}}>{label}</button>;
}
function SmBtn({label,onClick,color="#6366F1",active,style={}}){return <button onClick={onClick} style={{padding:"5px 12px",borderRadius:6,fontSize:12,fontWeight:500,cursor:"pointer",whiteSpace:"nowrap",border:`0.5px solid ${active?"#6366F1":color+"44"}`,background:active?"#6366F133":`${color}11`,color:active?"#A5B4FC":color,...style}}>{label}</button>;}
function Card({children,style={}}){return <div className="po-card" style={{background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:12,padding:"14px 16px",marginBottom:10,...style}}>{children}</div>;}
// A single link using the geo: URI scheme — on a phone with no default maps app set,
// the OS itself pops up its native "Open with…" chooser (Google Maps, Waze, whatever's
// installed). No custom in-app menu; falls back to the plain Maps link when we don't
// have coordinates to build a geo: URI from.
function MapOpenPicker({venue,mapsUrl,label="📍 Open Location"}){
  const url = mapsUrl ?? venue?.mapsUrl;
  const coords = getVenueCoords(venue) || parseLatLngFromUrl(url);
  if (!url && !coords) return null;
  const href = coords ? `geo:${coords.lat},${coords.lng}?q=${coords.lat},${coords.lng}` : url;
  return <a href={href} {...(coords?{}:{target:"_blank",rel:"noopener noreferrer"})} style={{textDecoration:"none"}}>
    <SmBtn label={label} color="#6366F1"/>
  </a>;
}
// Location card: app-picker link + a distance/ETA check from the player's current location.
// Uses OSRM (a free, open-source, OpenStreetMap-based routing service — no API key) for a real
// road-based estimate; if that request fails for any reason, falls back to a straight-line estimate.
function VenueMapCard({venue}){
  const [status,setStatus] = useState("idle"); // idle | loading | done | error
  const [result,setResult] = useState(null);
  if (!venue?.mapsUrl && !(typeof venue?.lat==="number"&&typeof venue?.lng==="number")) return null;
  const coords = getVenueCoords(venue);
  const checkDistance = () => {
    if (!coords || !navigator.geolocation) { setStatus("error"); return; }
    setStatus("loading");
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const {latitude, longitude} = pos.coords;
        try {
          const url = `https://router.project-osrm.org/route/v1/driving/${longitude},${latitude};${coords.lng},${coords.lat}?overview=false`;
          const res = await fetch(url);
          const data = await res.json();
          const route = data?.routes?.[0];
          if (data.code==="Ok" && route) {
            setResult({km:route.distance/1000, mins:Math.round(route.duration/60), real:true});
          } else {
            const km = haversineKm(latitude, longitude, coords.lat, coords.lng);
            setResult({km, mins:Math.round((km/25)*60), real:false});
          }
        } catch(e) {
          const km = haversineKm(latitude, longitude, coords.lat, coords.lng);
          setResult({km, mins:Math.round((km/25)*60), real:false});
        }
        setStatus("done");
      },
      () => setStatus("error"),
      {timeout:10000}
    );
  };
  return <Card style={{marginBottom:10}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
      <MapOpenPicker venue={venue}/>
      {coords&&status!=="loading"&&<SmBtn label={status==="done"?"↻ Recheck":"📏 How far is it?"} onClick={checkDistance} color="#34D399"/>}
      {status==="loading"&&<span style={{fontSize:12,color:"var(--po-dim)"}}>Checking…</span>}
    </div>
    {status==="done"&&result&&<div style={{fontSize:12,color:"var(--po-sub)",marginTop:8}}>~{result.mins} min away (~{result.km.toFixed(1)} km{result.real?" driving, via OpenStreetMap routing":", straight line — routing service unavailable, rough estimate"})</div>}
    {status==="error"&&<div style={{fontSize:12,color:"#F59E0B",marginTop:8}}>Couldn't get your location — check location permission is allowed for this site.</div>}
  </Card>;
}
function CollapsibleSection({label,children,defaultOpen=true}){
  const [open,setOpen]=useState(defaultOpen);
  return <><div onClick={()=>setOpen(o=>!o)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 4px",cursor:"pointer",userSelect:"none"}}>
    <span style={{fontSize:13,fontWeight:700,color:"var(--po-text)"}}>{label}</span>
    <span style={{fontSize:16,color:"var(--po-dim)",transition:"transform 0.2s",display:"inline-block",transform:open?"rotate(0deg)":"rotate(-90deg)"}}>⌄</span>
  </div>
  {open&&<>{children}</>}</>;
}
function ST({children}){return <div className="po-dim" style={{fontSize:11,fontWeight:600,color:"var(--po-dim)",textTransform:"uppercase",letterSpacing:1,marginBottom:8,marginTop:16}}>{children}</div>;}
function BBtn({onBack,label="Back",sticky=false,subLabel,eventLabel}){
  const bracket = eventLabel ? `${eventLabel}${subLabel?" → "+subLabel:""}` : subLabel;
  const content = <button onClick={onBack} className="po-dim" style={{display:"flex",alignItems:"center",gap:4,background:"none",border:"none",color:"var(--po-dim)",fontSize:14,fontWeight:500,cursor:"pointer",padding:"10px 0",minHeight:40}}>← {label}{bracket?<span style={{color:"var(--po-sub)"}}>&nbsp;({bracket})</span>:null}</button>;
  if(!sticky) return <div style={{marginBottom:8}}>{content}</div>;
  return <div style={{position:"sticky",top:"calc(60px + var(--po-sticky-extra, 0px))",zIndex:40,background:"var(--po-bg)",marginLeft:-12,marginRight:-12,paddingLeft:12,paddingRight:12,marginBottom:8,borderBottom:"0.5px solid var(--po-bdr)"}}>{content}</div>;
}
function Inp({label,value,onChange,placeholder="",type="text",multiline}){const s={width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13,resize:"vertical",boxSizing:"border-box"};return <div style={{marginBottom:12}}><div className="po-dim" style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>{label}</div>{multiline?<textarea className="po-inp" value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={3} style={s}/>:<input className="po-inp" type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={s}/>}</div>;}
function Drp({label,value,onChange,options}){return <div style={{marginBottom:12}}><div className="po-dim" style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>{label}</div><select className="po-inp" value={value} onChange={e=>onChange(e.target.value)} style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}><option value="">اختر...</option>{options.map(o=><option key={o.v||o} value={o.v||o}>{o.l||o.v||o}</option>)}</select></div>;}
function Tabs({tabs,active,onChange}){return <div className="po-inp" style={{display:"flex",gap:4,background:"var(--po-inp)",borderRadius:8,padding:4,marginBottom:14}}>{tabs.map(([k,l])=><button key={k} onClick={()=>onChange(k)} style={{flex:1,padding:"8px 0",borderRadius:6,border:active===k?"2px solid #6366F1":"2px solid transparent",fontSize:12,fontWeight:active===k?700:500,cursor:"pointer",background:active===k?"#6366F1":"transparent",color:active===k?"#FFFFFF":"var(--po-dim)",transition:"all 0.15s"}}>{l}</button>)}</div>;}
// Same look as Tabs, split across two stacked rows — for screens with too many tabs for one row
// (Platform Admin) to stay comfortable on a phone width without squeezing labels unreadable.
function TwoRowTabs({tabs,active,onChange}){
  const mid=Math.ceil(tabs.length/2);
  const rows=[tabs.slice(0,mid),tabs.slice(mid)];
  return <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:14}}>
    {rows.map((row,ri)=><div key={ri} className="po-inp" style={{display:"flex",gap:4,background:"var(--po-inp)",borderRadius:8,padding:4}}>
      {row.map(([k,l])=><button key={k} onClick={()=>onChange(k)} style={{flex:1,padding:"8px 0",borderRadius:6,border:active===k?"2px solid #6366F1":"2px solid transparent",fontSize:12,fontWeight:active===k?700:500,cursor:"pointer",background:active===k?"#6366F1":"transparent",color:active===k?"#FFFFFF":"var(--po-dim)",transition:"all 0.15s"}}>{l}</button>)}
    </div>)}
  </div>;
}
function rBdg(r){const m={owner:["#C084FC","Owner"],admin:["#38BDF8","Admin"],member:["#64748B","Member"]};const[c,l]=m[r]||["#64748B",r];return <Bdg label={l} color={c}/>;}
function sBdg(s){const m={regular:["#34D399","Regular"],casual:["#FBBF24","Casual"],inactive:["#94A3B8","Inactive"],guest:["#F59E0B","Guest"]};const[c,l]=m[s]||["#94A3B8",s];return <Bdg label={l} color={c}/>;}
function AreaSel({country,gov,area,onChange,egypt}){
  const countries=Object.keys(egypt||{});
  const govs=country?Object.keys((egypt||{})[country]||{}):[];
  const areas=(country&&gov)?((egypt||{})[country]||{})[gov]||[]:[];
  return <div style={{marginBottom:12}}>
    <Drp label="الدولة" value={country} onChange={v=>{onChange("country",v);onChange("gov","");onChange("area","");}} options={countries.map(c=>({v:c,l:c}))}/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
      <Drp label="المحافظة" value={gov} onChange={v=>{onChange("gov",v);onChange("area","");}} options={govs.map(g=>({v:g,l:g}))}/>
      <Drp label="المنطقة" value={area} onChange={v=>onChange("area",v)} options={areas.map(a=>({v:a,l:a}))}/>
    </div>
  </div>;
}

// Horizontal [−] value [+] stepper. flip=true (the right-hand stepper of a pair) mirrors the
// button order to [+] value [−] — the two "+" buttons of a side-by-side pair sit facing each
// other next to the divider, and the two "−" buttons sit outward at the far edges.
// (Reverted from a retro "tuner roller" concept after four rebuilds — drag, velocity-momentum,
// width-relative, and press-and-hold — none behaved reliably on the actual device.)
function ScoreStepper({value,onChange,label,flip}){
  const minusBtn=<button key="minus"
    onMouseDown={e=>{e.preventDefault();onChange(Math.max(0,value-1));}}
    style={{width:26,height:26,borderRadius:6,border:"0.5px solid #EF444444",background:"#EF444411",color:"#EF4444",fontSize:15,fontWeight:700,cursor:"pointer",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center",touchAction:"none"}}>−</button>;
  const plusBtn=<button key="plus"
    onMouseDown={e=>{e.preventDefault();onChange(value+1);}}
    style={{width:26,height:26,borderRadius:6,border:"0.5px solid #6366F144",background:"#6366F111",color:"#A5B4FC",fontSize:15,fontWeight:700,cursor:"pointer",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center",touchAction:"none"}}>+</button>;
  const valEl=<div key="val" style={{fontSize:18,fontWeight:700,color:"var(--po-text)",minWidth:20,textAlign:"center",lineHeight:1}}>{value}</div>;
  return <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
    <div style={{fontSize:9,color:"var(--po-dim)",fontWeight:600,textAlign:"center",maxWidth:84,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      {flip?[plusBtn,valEl,minusBtn]:[minusBtn,valEl,plusBtn]}
    </div>
  </div>;
}

// ══════════════════════════════════════════════════════
//  MAIN APP
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
//  LOGIN — Firebase Authentication (email/password + Google)
// ══════════════════════════════════════════════════════
function LoginScreen(){
  const [mode,setMode] = useState("signin"); // signin | signup
  const [email,setEmail] = useState("");
  const [password,setPassword] = useState("");
  const [name,setName] = useState("");
  const [busy,setBusy] = useState(false);
  const [err,setErr] = useState("");
  const [msg,setMsg] = useState("");

  const friendlyError = (e) => {
    const code = e?.code || "";
    if (code.includes("wrong-password") || code.includes("invalid-credential")) return "Wrong email or password.";
    if (code.includes("user-not-found")) return "No account found with that email.";
    if (code.includes("email-already-in-use")) return "An account already exists with that email — try signing in instead.";
    if (code.includes("weak-password")) return "Password should be at least 6 characters.";
    if (code.includes("invalid-email")) return "That doesn't look like a valid email address.";
    if (code.includes("popup-closed-by-user")) return "";
    return "Something went wrong. Please try again.";
  };

  const submit = async () => {
    setErr(""); setMsg(""); setBusy(true);
    try{
      if (mode==="signup"){
        const cred = await createUserWithEmailAndPassword(fbAuth, email.trim(), password);
        if (name.trim()) await updateProfile(cred.user, {displayName:name.trim()});
      } else {
        await signInWithEmailAndPassword(fbAuth, email.trim(), password);
      }
    }catch(e){ setErr(friendlyError(e)); }
    setBusy(false);
  };

  const googleSignIn = async () => {
    setErr(""); setMsg(""); setBusy(true);
    try{
      if (Capacitor.isNativePlatform()) {
        const result = await GoogleSignIn.signIn();
        const credential = GoogleAuthProvider.credential(result.idToken);
        await signInWithCredential(fbAuth, credential);
      } else {
        await signInWithPopup(fbAuth, googleProvider);
      }
    }
    catch(e){ setErr(friendlyError(e)); }
    setBusy(false);
  };

  const forgotPassword = async () => {
    if (!email.trim()) { setErr("Type your email above first, then tap this again."); return; }
    setErr(""); setMsg(""); setBusy(true);
    try{ await sendPasswordResetEmail(fbAuth, email.trim()); setMsg("Password reset email sent — check your inbox."); }
    catch(e){ setErr(friendlyError(e)); }
    setBusy(false);
  };

  return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
    <div style={{width:"100%",maxWidth:380}}>
      <div style={{textAlign:"center",marginBottom:24}}>
        <img src="/logo-icon-192.png" width={56} height={56} style={{borderRadius:16,margin:"0 auto 12px",display:"block"}} alt="Matchkeeper"/>
        <div style={{fontSize:20,fontWeight:700,color:"#F1F5F9"}}>Matchkeeper</div>
        <div style={{fontSize:11,color:"#475569",marginTop:1}}>{APP_VERSION}{IS_DEV_ENV?" · DEV":!Capacitor.isNativePlatform()?" · Web":""}</div>
        <div style={{fontSize:13,color:"#64748B",marginTop:2}}>{mode==="signup"?"Create your account":"Sign in to continue"}</div>
      </div>

      <div style={{background:"#161B22",border:"0.5px solid #30363D",borderRadius:14,padding:20}}>
        {mode==="signup"&&<input placeholder="Your name" value={name} onChange={e=>setName(e.target.value)}
          style={{width:"100%",background:"#0E1117",border:"0.5px solid #30363D",borderRadius:8,padding:"11px 12px",color:"#F1F5F9",fontSize:14,marginBottom:10,boxSizing:"border-box"}}/>}
        <input placeholder="Email" type="email" value={email} onChange={e=>setEmail(e.target.value)} autoCapitalize="none"
          style={{width:"100%",background:"#0E1117",border:"0.5px solid #30363D",borderRadius:8,padding:"11px 12px",color:"#F1F5F9",fontSize:14,marginBottom:10,boxSizing:"border-box"}}/>
        <input placeholder="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!busy&&submit()}
          style={{width:"100%",background:"#0E1117",border:"0.5px solid #30363D",borderRadius:8,padding:"11px 12px",color:"#F1F5F9",fontSize:14,marginBottom:6,boxSizing:"border-box"}}/>

        {mode==="signin"&&<div onClick={forgotPassword} style={{fontSize:12,color:"#818CF8",textAlign:"right",marginBottom:12,cursor:"pointer"}}>Forgot password?</div>}
        {err&&<div style={{fontSize:12,color:"#F87171",background:"#F8717122",border:"0.5px solid #F8717144",borderRadius:8,padding:"8px 10px",marginBottom:12}}>{err}</div>}
        {msg&&<div style={{fontSize:12,color:"#34D399",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,padding:"8px 10px",marginBottom:12}}>{msg}</div>}

        <button onClick={submit} disabled={busy||!email||!password} style={{width:"100%",padding:"12px",borderRadius:8,border:"none",background:busy||!email||!password?"#6366F166":"#6366F1",color:"#fff",fontSize:14,fontWeight:600,cursor:busy?"default":"pointer",marginTop:mode==="signup"?0:6}}>
          {busy?"Please wait…":mode==="signup"?"Create account":"Sign in"}
        </button>

        <div style={{display:"flex",alignItems:"center",gap:10,margin:"16px 0"}}>
          <div style={{flex:1,height:1,background:"#30363D"}}/><span style={{fontSize:11,color:"#64748B"}}>or</span><div style={{flex:1,height:1,background:"#30363D"}}/>
        </div>

        <button onClick={googleSignIn} disabled={busy} style={{width:"100%",padding:"11px",borderRadius:8,border:"0.5px solid #30363D",background:"#0E1117",color:"#F1F5F9",fontSize:14,fontWeight:600,cursor:busy?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
          <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.8 2.73v2.27h2.92c1.7-1.57 2.68-3.88 2.68-6.64z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.27c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.34C2.44 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.97 10.7c-.18-.54-.28-1.11-.28-1.7s.1-1.16.28-1.7V4.96H.96C.35 6.17 0 7.55 0 9s.35 2.83.96 4.04l3.01-2.34z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.59-2.59C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
          Continue with Google
        </button>
      </div>

      <div style={{textAlign:"center",marginTop:16,fontSize:13,color:"#64748B"}}>
        {mode==="signup"?"Already have an account? ":"New here? "}
        <span onClick={()=>{setMode(mode==="signup"?"signin":"signup");setErr("");setMsg("");}} style={{color:"#818CF8",fontWeight:600,cursor:"pointer"}}>
          {mode==="signup"?"Sign in":"Create an account"}
        </span>
      </div>
    </div>
  </div>;
}

// The old generic "Which one is you?" self-service claim screen (search + pick from every
// unclaimed profile) was removed — see BUGS.md #17. It carried the exact same identity risk as
// the invite-link bug (a stranger self-selecting someone else's existing profile), just via a
// list instead of a URL, and doesn't scale as the player base grows. Existing pre-created
// profiles are now claimed ONLY through a targeted invite link with its "Is this you?"
// confirmation (see pendingInviteConfirm below); anyone signing in with no such invite pending
// just gets a brand-new profile automatically (see the auto-fresh-profile effect below).

export default function Matchkeeper() {
  useEffect(() => { document.title = `Matchkeeper ${APP_VERSION}${IS_DEV_ENV?" (DEV)":""}`; }, []);
  const [users,  setUsers]  = useState(INIT_USERS);
  const [venues, setVenues] = useState(INIT_VENUES);
  const [egypt, setEgypt] = useState(INIT_EGYPT);
  const [subscriptionSettings, setSubscriptionSettings] = useState(INIT_SUBSCRIPTION_SETTINGS);
  const [subscriptionTransactions, setSubscriptionTransactions] = useState([]);
  const [expenseCategories, setExpenseCategories] = useState(INIT_EXPENSE_CATEGORIES);
  const [usrWindowSize, setUsrWindowSizeRaw] = useState(5);
  const [comms,  setComms]  = useState(INIT_COMMS);
  const [notifications, setNotifications] = useState([]);
  const [uidLinks, setUidLinks] = useState({}); // {firebaseUid: userId} — one Firestore doc per entry, see sync below
  const [invites, setInvites] = useState([]); // {id, code, createdBy, createdAt, label, communityId, eventId}
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [nav,    setNav]    = useState("events");
  const [view,   setView]   = useState({screen:"list"});
  const [navHistory, setNavHistory] = useState([]); // stack of {nav, view} for back navigation

  // Firebase Authentication — Phase 1: real login, data still lives in localStorage.
  useEffect(() => {
    const unsub = onAuthStateChanged(fbAuth, (u) => { setAuthUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  // Invite links (Enhancement #1) — capture ?invite=CODE from a cold-start URL once, stash it
  // in localStorage so it survives the login/claim screens (which today carry no routing
  // state at all), and strip it from the address bar so a refresh doesn't re-trigger it.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("invite");
      if (code) {
        localStorage.setItem("mk_pending_invite", JSON.stringify({code, capturedAt:Date.now()}));
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState(null, "", url.toString());
      }
    } catch(e) { console.log("Invite param capture error", e); }
  }, []);

  // Which local Matchkeeper profile belongs to the signed-in Firebase account, if any.
  // Existing profiles can only ever be linked through a targeted invite (with its "Is this
  // you?" confirmation — see pendingInviteConfirm below), never by self-picking a name off a
  // list. The actual firebaseUid→userId link lives in its own per-document collection
  // (uidLinks, synced above) — never in the users blob — so it can't be silently reverted by
  // an unrelated users-array write from another device.
  const linkedUserId = authUser ? uidLinks[authUser.uid] : null;
  const linkedMe = linkedUserId!=null ? (users.find(u => u.id===linkedUserId) || null) : null;
  const me = linkedMe || users[0];
  // Platform Admin's "God Mode" — full admin authority on whatever community/event screen
  // they're currently looking at, regardless of their real membership/role there. Deliberately
  // session-only (not persisted to localStorage) so it never silently carries over to a new
  // session — has to be re-flagged on purpose every time. See godMode usage in CommDetail's and
  // EvDetail's isAdmin, and the extra confirm gate in updC below.
  const [godMode, setGodMode] = useState(false);
  const [eventCommFilter, setEventCommFilter] = useState("all");
  useEffect(() => { if (me?.id) { const saved = localStorage.getItem(`mk_ev_filter_${me.id}`); if (saved) setEventCommFilter(saved); } }, [me?.id]);
  useEffect(() => { if (me?.id) localStorage.setItem(`mk_ev_filter_${me.id}`, eventCommFilter); }, [eventCommFilter, me?.id]);
  // iOS can never get push notifications from a plain browser tab (see isIosNonStandalone) —
  // this nudges the user through the one manual step that unlocks it (Add to Home Screen).
  // Full-screen the first time (can't miss it), then collapses to a small floating 🍎 icon
  // (same close-to-icon pattern as God Mode) instead of dismissing forever — the instructions
  // stay one tap away for as long as they're still on a plain iOS Safari tab.
  const [showIosOverlay, setShowIosOverlay] = useState(() => {
    try { return isIosNonStandalone() && localStorage.getItem("mk_ios_overlay_collapsed")!=="1"; } catch(e) { return false; }
  });
  const collapseIosOverlay = () => { try { localStorage.setItem("mk_ios_overlay_collapsed","1"); } catch(e) {} setShowIosOverlay(false); };
  const expandIosOverlay = () => setShowIosOverlay(true);
  const autoPushTriedRef = useRef(false);
  useEffect(() => {
    if (!linkedMe || autoPushTriedRef.current) return;
    if (Capacitor.isNativePlatform()) {
      autoPushTriedRef.current = true;
      // Sequenced, not fired concurrently: Android can only show one runtime-permission
      // dialog at a time, and a second request arriving while one is already in flight gets
      // silently dropped rather than queued — which was starving the Notifications prompt
      // (it starts a beat later than Location's, since it awaits createChannel() first).
      (async () => {
        await enablePushNotifications(linkedMe.id).catch(e=>console.log("Push enable failed", e));
        await Geolocation.requestPermissions().catch(e=>console.log("Location permission request failed", e));
        await MatchMode.ensureExactAlarmPermission().catch(e=>console.log("Exact alarm permission request failed", e));
      })();
    } else if (!isIosNonStandalone()) {
      // Android/desktop web — the Notification/Push API works directly in a plain browser
      // tab, no install step needed, so this can auto-prompt exactly like native does. iOS
      // is excluded on purpose (see isIosNonStandalone) — it gets the install banner instead.
      autoPushTriedRef.current = true;
      enablePushNotifications(linkedMe.id).catch(e=>console.log("Push enable failed", e));
    }
  }, [linkedMe]);
  // Links a signed-in Firebase account straight to an existing profile — safe ONLY when driven
  // by an admin-generated targeted invite (see pendingInviteConfirm below), since it's gated on
  // the signed-in person explicitly confirming "yes, that's me" before this ever runs.
  const claimViaInvite = (userId, inv) => {
    linkUidToUser(authUser.uid, userId);
    setUsers(us => us.map(u => u.id===userId ? {...u, email:authUser.email||u.email, photoURL:u.photoURL||authUser.photoURL||""} : u));
    const target = users.find(u => u.id===userId);
    const who = authUser.displayName || authUser.email || "Someone";
    notify([inv?.createdBy].filter(Boolean), "inviteClaimed", {profileUserId:userId}, "🔗 Invite connected", `${who} just signed in and got linked as ${target?.nickname||"their profile"} — they're in.`);
  };
  // Read by the loginLogged effect below (once `linkedMe`/`me` actually catches up to the new
  // profile) to log a distinct "user.create" audit entry instead of the usual "auth.signin" —
  // logAudit here directly would misattribute the actor, since `me` is still the pre-link
  // fallback (users[0]) at the moment this function runs, one render before linkedMe updates.
  const justCreatedRef = useRef(null);
  // Original client-side duplicate check (pre-V0.10.29) — kept as the permanent DEV path (no
  // Cloud Functions exist on padelos-dev, free Spark plan) AND as the production fallback if
  // the server call errors or is slow. Only matches an UNLINKED existing profile — never offers
  // to merge into someone whose account is already claimed.
  const findEmailMatchUserLocal = () => {
    if (!authUser?.email) return null;
    const claimed = new Set(Object.values(uidLinks));
    return users.find(u => u.email && u.email.toLowerCase()===authUser.email.toLowerCase() && !claimed.has(u.id)) || null;
  };
  const createFreshProfileLocal = () => {
    const newId = _uid++;
    const displayName = authUser.displayName || authUser.email?.split("@")[0] || "Player";
    setUsers(us => [...us, {id:newId, email:authUser.email, photoURL:authUser.photoURL||"", nickname:displayName, name:displayName, avatar:ini2(displayName), usr:50, joined:today, isGuest:false}]);
    linkUidToUser(authUser.uid, newId);
    justCreatedRef.current = newId;
    // Platform Admin (#1) gets pinged for every genuinely brand-new signup — this is the one
    // spot both the untargeted-invite and fully organic sign-in paths funnel through.
    notify([1], "newPlatformUser", {profileUserId:newId}, "🆕 New platform user", `${displayName} just joined Matchkeeper`);
  };
  const claimViaEmailMatchLocal = (userId) => {
    linkUidToUser(authUser.uid, userId);
    setUsers(us => us.map(u => u.id===userId ? {...u, email:authUser.email||u.email, photoURL:u.photoURL||authUser.photoURL||""} : u));
  };
  // Rejects after ms — races against the server call so a slow/unreachable Cloud Function can
  // never leave sign-in stuck. This is the direct fix for the V0.10.29 incident: whatever the
  // exact cause of the hang was, this guarantees the exact same behavior as before (the local
  // fallback below) kicks in within 8s no matter what, instead of hanging indefinitely.
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
  // Resolves "who am I" on sign-in. DEV (IS_DEV_ENV) always uses the local client-side check —
  // padelos-dev has no Cloud Functions deployed at all, calling one there would just be a
  // guaranteed failure. Production tries the server-side check first (closes the stale-client
  // gap the local check can't — see functions/index.js), but ALWAYS falls back to the exact
  // same local check on any error or timeout, so this can never regress to hanging forever
  // again even if the server call breaks in some new way.
  const createFreshProfileOrMatch = async (forceNew=false) => {
    if (!IS_DEV_ENV) {
      try {
        const fn = httpsCallable(getFunctionsLazy(), "claimOrCreateProfile");
        const res = await withTimeout(fn({forceNew}), 8000);
        const {status, userId, nickname, avatar, area} = res.data || {};
        if (status === "matched") { setPendingEmailMatchConfirm({target:{id:userId, nickname, avatar, area}}); return; }
        if (status === "created") {
          justCreatedRef.current = userId;
          const displayName = authUser.displayName || authUser.email?.split("@")[0] || "Player";
          notify([1], "newPlatformUser", {profileUserId:userId}, "🆕 New platform user", `${displayName} just joined Matchkeeper`);
        }
        return; // "already-linked" or handled above — nothing left to do
      } catch (e) {
        console.log("claimOrCreateProfile unavailable, falling back to local check", e);
      }
    }
    if (forceNew) { createFreshProfileLocal(); return; }
    const match = findEmailMatchUserLocal();
    if (match) { setPendingEmailMatchConfirm({target:match}); return; }
    createFreshProfileLocal();
  };
  const claimViaEmailMatch = async (userId) => {
    if (!IS_DEV_ENV) {
      try {
        const fn = httpsCallable(getFunctionsLazy(), "confirmEmailMatch");
        await withTimeout(fn({userId}), 8000);
        return;
      } catch (e) {
        console.log("confirmEmailMatch unavailable, falling back to local link", e);
      }
    }
    claimViaEmailMatchLocal(userId);
  };
  // Manual merge for the duplicate-email audit tool (Platform Admin → Data & Backup) — a
  // detective, after-the-fact backstop regardless of how a duplicate happened. Only offered
  // when `loserId` has zero footprint anywhere (enforced by the caller, which hides the button
  // otherwise) — moves the auth link if the loser had one, then removes the empty duplicate.
  // Never touches keepId's own data.
  const mergeDuplicateUser = (keepId, loserId) => {
    const keep = users.find(u=>u.id===keepId), loser = users.find(u=>u.id===loserId);
    if (!keep || !loser) return;
    const linkEntry = Object.entries(uidLinks).find(([,uid])=>uid===loserId);
    if (linkEntry) linkUidToUser(linkEntry[0], keepId);
    setUsers(us => us.filter(u=>u.id!==loserId));
    toast2(`Merged ${loser.nickname} into ${keep.nickname} ✓`);
    logAudit("user.mergeDuplicate", `${me.nickname} merged duplicate account "${loser.nickname}" (#${loserId}) into "${keep.nickname}" (#${keepId}) — same email, ${loser.nickname} had no event/community history`, "user", keepId);
  };
  const go = (screen, extra={}) => {
    setNavHistory(h=>[...h, {nav, view}]); // push current state before navigating
    setView({screen,...extra});
  };
  const goComm = (cid) => { setNavHistory(h=>[...h, {nav, view}]); setNav("communities"); setView({screen:"comm",cid}); };
  const goEvent = (cid,eid) => { setNavHistory(h=>[...h, {nav, view}]); setNav("communities"); setView({screen:"event",cid,eid}); };
  const goCommList = () => { setNavHistory(h=>[...h, {nav, view}]); setNav("communities"); setView({screen:"list"}); };
  const goBack = () => {
    setNavHistory(h=>{
      if(h.length===0) return h;
      const prev = h[h.length-1];
      setNav(prev.nav);
      setView(prev.view);
      return h.slice(0,-1);
    });
  };

  // Android hardware back button — intercept via History API popstate
  // Push a dummy state so Android back press triggers popstate instead of exiting the app
  useEffect(()=>{
    // Push a state so we always have something to pop back to
    window.history.pushState({padelos:true}, '');
    const onPop = (e)=>{
      // Intercept the back press
      if(navHistory.length>0){
        goBack();
        // Re-push so next back press is also intercepted
        window.history.pushState({padelos:true}, '');
      } else {
        // At root — re-push so a second press would exit (browser decides)
        window.history.pushState({padelos:true}, '');
      }
    };
    window.addEventListener('popstate', onPop);
    return ()=>window.removeEventListener('popstate', onPop);
  }, [navHistory]); // re-run when history changes so goBack sees current state
  const goRoot = (newNav) => {
    setNavHistory([]); // clear history when going to a root tab
    setNav(newNav);
    setView({screen:"list"});
  };
  const [toast,  setToast]  = useState(null);
  const [menu,   setMenu]   = useState(false);
  const [notifMenu, setNotifMenu] = useState(false);
  const [dark,   setDark]   = useState(false);
  // Theme colors
  const TH = dark ? {
    bg:"#0F0F23", card:"#1A1A35", border:"#2D2D55", text:"#F1F5F9",
    sub:"#CBD5E1", dim:"#94A3B8", input:"#1E1E40", nav:"#1A1A35",
    cardShadow:"0 2px 8px #00000044", accent:"#6366F1", accentLight:"#6366F133",
  } : {
    bg:"#EEF2FF", card:"#FFFFFF", border:"#C7D2FE", text:"#1E1B4B",
    sub:"#3730A3", dim:"#374151", input:"#FFFFFF", nav:"#4F46E5",
    cardShadow:"0 2px 8px #6366F118", accent:"#4F46E5", accentLight:"#EEF2FF",
  };

  // ── Firestore sync (Phase 2) — comms/users/venues/notifications are
  // shared cloud data now; every signed-in device sees the same thing in real time.
  // `dark` stays a local device preference in localStorage.
  // syncedRef tracks, per key, the JSON of whatever we last received FROM Firestore or
  // sent TO it — this is what stops the listen-effect and write-effect from echoing
  // back and forth into an infinite loop.
  const syncedRef = useRef({comms:null, users:null, venues:null, notifications:null, egypt:null, expenseCategories:null, usrWindowSize:null});
  // Tracks whether each collection has EVER returned real data this session. Firestore's
  // onSnapshot can occasionally misfire "not found" on a transient network blip even when
  // the document genuinely exists — this flag is what stops that from being mistaken for
  // "first-time setup" and destructively overwriting live data with empty seed defaults.
  const everRealRef = useRef({comms:false, users:false, venues:false, notifications:false, egypt:false, expenseCategories:false, usrWindowSize:false});
  const [loadedKeys, setLoadedKeys] = useState([]);
  const markLoaded = (k) => setLoadedKeys(ks => ks.includes(k) ? ks : [...ks, k]);
  const dataLoaded = ["comms","users","venues","notifications","uidLinks","invites","egypt","subscriptionSettings","subscriptionTransactions"].every(k => loadedKeys.includes(k));
  // Captures the real Firestore error (code + message) whenever a collection fails to load,
  // so it can be shown directly on-screen — no laptop or DevTools needed to diagnose it.
  const [loadDiag, setLoadDiag] = useState({});
  const recordDiag = (k, info) => setLoadDiag(d => ({...d, [k]: info}));

  // One-time migration: earlier deploys wrote seed events to Firestore before the
  // isDemo flag existed in code. Patch events #2/#3 in the seed community so the
  // Demo badge actually shows, without needing a manual Firestore edit.
  useEffect(() => {
    if (!dataLoaded) return;
    const needsPatch = comms.some(c => c.events.some(ev => (ev.id===2||ev.id===3) && !ev.isDemo));
    if (!needsPatch) return;
    setComms(cs => cs.map(c => ({...c, events: c.events.map(ev => (ev.id===2||ev.id===3) ? {...ev, isDemo:true} : ev)})));
  }, [dataLoaded]);

  useEffect(() => { try { const d = localStorage.getItem('padelos_dark'); if (d!==null) setDark(d==='1'); } catch(e){} }, []);
  useEffect(() => { try { localStorage.setItem('padelos_dark', dark?'1':'0'); } catch(e){} }, [dark]);

  // comms
  useEffect(() => {
    if (!authUser) return; // don't attach Firestore listeners before auth has settled — avoids a permission-denied race on cold start
    const unsub = onSnapshot(doc(db,"padelos","comms"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.comms) { syncedRef.current.comms = json; setComms(remote);
          _cid = Math.max(_cid, ...remote.map(c=>c.id), 0) + 1;
          _eid = Math.max(_eid, ...remote.flatMap(c=>c.events.map(e=>e.id)), 0) + 1;
        }
        everRealRef.current.comms = true;
      } else if (!everRealRef.current.comms) { syncedRef.current.comms = JSON.stringify(INIT_COMMS); setComms(INIT_COMMS); recordDiag("comms","document not found — showing local seed fallback"); } // local fallback only — NEVER auto-write seed data to Firestore; a transient "not found" on a fresh session must not overwrite real production data. Use the manual Factory Reset button for genuine first-time setup.
      markLoaded("comms");
    }, e => { console.log("Firestore comms error", e); recordDiag("comms", `${e.code||"error"}: ${e.message||e}`); markLoaded("comms"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!everRealRef.current.comms) { console.log("Blocked write: haven't confirmed real comms data this session yet — refusing to write, to avoid overwriting real data with seed-derived edits"); return; }
    const json = JSON.stringify(comms);
    if (json === syncedRef.current.comms) return;
    syncedRef.current.comms = json;
    setDoc(doc(db,"padelos","comms"), {value:JSON.stringify(comms)}).catch(e=>console.log("Firestore write error (comms)", e));
  }, [comms, dataLoaded]);

  // users
  useEffect(() => {
    if (!authUser) return; // don't attach Firestore listeners before auth has settled — avoids a permission-denied race on cold start
    const unsub = onSnapshot(doc(db,"padelos","users"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.users) { syncedRef.current.users = json; setUsers(remote);
          _uid = Math.max(_uid, ...remote.map(u=>u.id), 0) + 1;
        }
        everRealRef.current.users = true;
      } else if (!everRealRef.current.users) { syncedRef.current.users = JSON.stringify(INIT_USERS); setUsers(INIT_USERS); recordDiag("users","document not found — showing local seed fallback (12 users)"); } // local fallback only — NEVER auto-write seed data to Firestore (this exact line caused a real production data loss: a fresh session misread a transient "not found" as an empty database and overwrote 18 real users with 12 seed ones)
      markLoaded("users");
    }, e => { console.log("Firestore users error", e); recordDiag("users", `${e.code||"error"}: ${e.message||e}`); markLoaded("users"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!everRealRef.current.users) { console.log("Blocked write: haven't confirmed real users data this session yet — refusing to write, to avoid overwriting real data with seed-derived edits"); return; }
    const json = JSON.stringify(users);
    if (json === syncedRef.current.users) return;
    syncedRef.current.users = json;
    setDoc(doc(db,"padelos","users"), {value:JSON.stringify(users)}).catch(e=>console.log("Firestore write error (users)", e));
  }, [users, dataLoaded]);

  // venues
  useEffect(() => {
    if (!authUser) return; // don't attach Firestore listeners before auth has settled — avoids a permission-denied race on cold start
    const unsub = onSnapshot(doc(db,"padelos","venues"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.venues) { syncedRef.current.venues = json; setVenues(remote);
          _vid = Math.max(_vid, ...remote.map(v=>v.id), 0) + 1;
        }
        everRealRef.current.venues = true;
      } else if (!everRealRef.current.venues) { syncedRef.current.venues = JSON.stringify(INIT_VENUES); setVenues(INIT_VENUES); } // local fallback only — never auto-write seed data to Firestore
      markLoaded("venues");
    }, e => { console.log("Firestore venues error", e); recordDiag("venues", `${e.code||"error"}: ${e.message||e}`); markLoaded("venues"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!everRealRef.current.venues) { console.log("Blocked write: haven't confirmed real venues data this session yet"); return; }
    const json = JSON.stringify(venues);
    if (json === syncedRef.current.venues) return;
    syncedRef.current.venues = json;
    setDoc(doc(db,"padelos","venues"), {value:JSON.stringify(venues)}).catch(e=>console.log("Firestore write error (venues)", e));
  }, [venues, dataLoaded]);

  // egypt (governorate/area list — Bug #10)
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(doc(db,"padelos","egypt"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; let remote = typeof raw==="string" ? JSON.parse(raw) : raw;
        // One-time migration: the old shape was flat {gov:[areas]}, no country level. Detect it
        // by checking if any top-level value is an array (old) rather than an object (new), and
        // wrap the whole thing under "مصر" — every existing gov/area everywhere was Egypt-only
        // anyway. Deliberately skip updating syncedRef here so the write-back effect below
        // notices the state changed and persists the migrated shape once.
        const isOldShape = remote && Object.values(remote).some(v=>Array.isArray(v));
        if (isOldShape) remote = { "مصر": remote };
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.egypt) { setEgypt(remote); if (!isOldShape) syncedRef.current.egypt = json; }
        everRealRef.current.egypt = true;
      } else if (!everRealRef.current.egypt) { syncedRef.current.egypt = JSON.stringify(INIT_EGYPT); setEgypt(INIT_EGYPT); } // local fallback only — never auto-write seed data to Firestore
      markLoaded("egypt");
    }, e => { console.log("Firestore egypt error", e); recordDiag("egypt", `${e.code||"error"}: ${e.message||e}`); markLoaded("egypt"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!everRealRef.current.egypt) { console.log("Blocked write: haven't confirmed real egypt data this session yet"); return; }
    const json = JSON.stringify(egypt);
    if (json === syncedRef.current.egypt) return;
    syncedRef.current.egypt = json;
    setDoc(doc(db,"padelos","egypt"), {value:JSON.stringify(egypt)}).catch(e=>console.log("Firestore write error (egypt)", e));
  }, [egypt, dataLoaded]);

  // subscriptionSettings (Enhancement #17 — platform-wide enable switch + pricing)
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(doc(db,"padelos","subscriptionSettings"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw;
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.subscriptionSettings) { syncedRef.current.subscriptionSettings = json; setSubscriptionSettings(remote); }
        everRealRef.current.subscriptionSettings = true;
      } else if (!everRealRef.current.subscriptionSettings) { syncedRef.current.subscriptionSettings = JSON.stringify(INIT_SUBSCRIPTION_SETTINGS); setSubscriptionSettings(INIT_SUBSCRIPTION_SETTINGS); everRealRef.current.subscriptionSettings = true; } // same "no seed data to protect" fix as invites/usrWindowSize — this default is a legitimate confirmed-real state, don't block writes forever
      markLoaded("subscriptionSettings");
    }, e => { console.log("Firestore subscriptionSettings error", e); recordDiag("subscriptionSettings", `${e.code||"error"}: ${e.message||e}`); markLoaded("subscriptionSettings"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!everRealRef.current.subscriptionSettings) { console.log("Blocked write: haven't confirmed real subscriptionSettings data this session yet"); return; }
    const json = JSON.stringify(subscriptionSettings);
    if (json === syncedRef.current.subscriptionSettings) return;
    syncedRef.current.subscriptionSettings = json;
    setDoc(doc(db,"padelos","subscriptionSettings"), {value:JSON.stringify(subscriptionSettings)}).catch(e=>console.log("Firestore write error (subscriptionSettings)", e));
  }, [subscriptionSettings, dataLoaded]);

  // subscriptionTransactions (Enhancement #17 — confirmed manual-payment log, feeds the Statement view)
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(doc(db,"padelos","subscriptionTransactions"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw;
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.subscriptionTransactions) { syncedRef.current.subscriptionTransactions = json; setSubscriptionTransactions(remote); }
        everRealRef.current.subscriptionTransactions = true;
      } else if (!everRealRef.current.subscriptionTransactions) { syncedRef.current.subscriptionTransactions = JSON.stringify([]); setSubscriptionTransactions([]); everRealRef.current.subscriptionTransactions = true; } // same "no seed data to protect" fix as invites/usrWindowSize — an empty array is a legitimate confirmed-real state, don't block writes forever
      markLoaded("subscriptionTransactions");
    }, e => { console.log("Firestore subscriptionTransactions error", e); recordDiag("subscriptionTransactions", `${e.code||"error"}: ${e.message||e}`); markLoaded("subscriptionTransactions"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!everRealRef.current.subscriptionTransactions) { console.log("Blocked write: haven't confirmed real subscriptionTransactions data this session yet"); return; }
    const json = JSON.stringify(subscriptionTransactions);
    if (json === syncedRef.current.subscriptionTransactions) return;
    syncedRef.current.subscriptionTransactions = json;
    setDoc(doc(db,"padelos","subscriptionTransactions"), {value:JSON.stringify(subscriptionTransactions)}).catch(e=>console.log("Firestore write error (subscriptionTransactions)", e));
  }, [subscriptionTransactions, dataLoaded]);

  // expenseCategories (community-ledger expense categories, platform-admin-maintainable)
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(doc(db,"padelos","expenseCategories"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw;
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.expenseCategories) { syncedRef.current.expenseCategories = json; setExpenseCategories(remote); }
        everRealRef.current.expenseCategories = true;
      } else if (!everRealRef.current.expenseCategories) { syncedRef.current.expenseCategories = JSON.stringify(INIT_EXPENSE_CATEGORIES); setExpenseCategories(INIT_EXPENSE_CATEGORIES); everRealRef.current.expenseCategories = true; } // same "no seed data to protect" fix as invites/usrWindowSize/subscriptionSettings — these 5 defaults are a legitimate confirmed-real state, don't block writes forever
      markLoaded("expenseCategories");
    }, e => { console.log("Firestore expenseCategories error", e); markLoaded("expenseCategories"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!everRealRef.current.expenseCategories) { console.log("Blocked write: haven't confirmed real expenseCategories data this session yet"); return; }
    const json = JSON.stringify(expenseCategories);
    if (json === syncedRef.current.expenseCategories) return;
    syncedRef.current.expenseCategories = json;
    setDoc(doc(db,"padelos","expenseCategories"), {value:JSON.stringify(expenseCategories)}).catch(e=>console.log("Firestore write error (expenseCategories)", e));
  }, [expenseCategories]);

  // usrWindowSize (rolling-average window for calcWeightedUSR, platform-admin-maintainable)
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(doc(db,"padelos","usrWindowSize"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw;
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.usrWindowSize) { syncedRef.current.usrWindowSize = json; setUsrWindowSizeRaw(remote); }
        everRealRef.current.usrWindowSize = true;
      } else if (!everRealRef.current.usrWindowSize) { syncedRef.current.usrWindowSize = JSON.stringify(5); setUsrWindowSizeRaw(5); everRealRef.current.usrWindowSize = true; } // unlike comms/users/venues, no seed data to protect — "document not found" IS the confirmed-real default state, so writes must not stay blocked forever (this is exactly what was silently stuck: every admin save appeared to succeed locally but the doc had never actually been created, so it reset to 5 on every fresh session)
      markLoaded("usrWindowSize");
    }, e => { console.log("Firestore usrWindowSize error", e); markLoaded("usrWindowSize"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!everRealRef.current.usrWindowSize) { console.log("Blocked write: haven't confirmed real usrWindowSize data this session yet"); return; }
    const json = JSON.stringify(usrWindowSize);
    if (json === syncedRef.current.usrWindowSize) return;
    syncedRef.current.usrWindowSize = json;
    setDoc(doc(db,"padelos","usrWindowSize"), {value:JSON.stringify(usrWindowSize)}).catch(e=>console.log("Firestore write error (usrWindowSize)", e));
  }, [usrWindowSize]);

  // notifications
  useEffect(() => {
    if (!authUser) return; // don't attach Firestore listeners before auth has settled — avoids a permission-denied race on cold start
    const unsub = onSnapshot(doc(db,"padelos","notifications"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.notifications) { syncedRef.current.notifications = json; setNotifications(remote);
          _nid = Math.max(_nid, ...remote.map(n=>n.id), 0) + 1;
        }
        everRealRef.current.notifications = true;
      } else if (!everRealRef.current.notifications) { syncedRef.current.notifications = JSON.stringify([]); setNotifications([]); } // local fallback only — never auto-write seed data to Firestore
      markLoaded("notifications");
    }, e => { console.log("Firestore notifications error", e); recordDiag("notifications", `${e.code||"error"}: ${e.message||e}`); markLoaded("notifications"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!everRealRef.current.notifications) { console.log("Blocked write: haven't confirmed real notifications data this session yet"); return; }
    const json = JSON.stringify(notifications);
    if (json === syncedRef.current.notifications) return;
    syncedRef.current.notifications = json;
    setDoc(doc(db,"padelos","notifications"), {value:JSON.stringify(notifications)}).catch(e=>console.log("Firestore write error (notifications)", e));
  }, [notifications, dataLoaded]);

  // uidLinks — one Firestore document PER identity link (padelos_links/{firebaseUid} = {userId}).
  // Deliberately NOT part of the users blob: this is the exact data that was getting lost
  // (a claim approval silently reverted) when a stale device overwrote the whole users
  // array. A per-document write here can never be clobbered by an unrelated write elsewhere.
  useEffect(() => {
    if (!authUser) return; // don't attach Firestore listeners before auth has settled — avoids a permission-denied race on cold start
    const unsub = onSnapshot(collection(db,"padelos_links"), snap => {
      const map = {};
      snap.forEach(d => { map[d.id] = d.data().userId; });
      setUidLinks(map);
      markLoaded("uidLinks");
    }, e => { console.log("Firestore uidLinks error", e); recordDiag("uidLinks", `${e.code||"error"}: ${e.message||e}`); markLoaded("uidLinks"); });
    return unsub;
  }, [authUser]);
  const linkUidToUser = (firebaseUid, userId) => setDoc(doc(db,"padelos_links",firebaseUid), {userId}).catch(e=>console.log("Firestore write error (uidLinks)", e));
  // Reverses an incorrect claim/link (see BUGS.md — targeted invite links used to auto-link
  // WHOEVER opened them with zero identity verification; if a link got forwarded or opened by
  // the wrong person, they were silently and permanently merged into that profile). Deletes the
  // padelos_links/{firebaseUid} doc, restoring the profile to unclaimed, and clears the
  // email/photoURL the wrongful claim overwrote so the admin can hand-correct the real owner.
  const unlinkUser = (userId) => {
    const entry = Object.entries(uidLinks).find(([,uid])=>uid===userId);
    if (!entry) { toast2("This user isn't linked to any account","err"); return; }
    const [firebaseUid] = entry;
    deleteDoc(doc(db,"padelos_links",firebaseUid)).catch(e=>console.log("Firestore delete error (uidLinks)", e));
    setUidLinks(links => { const n={...links}; delete n[firebaseUid]; return n; });
    setUsers(us => us.map(u => u.id===userId ? {...u, email:"", photoURL:""} : u));
    toast2("Unlinked ✓ — profile is unclaimed again");
    const u=users.find(u=>u.id===userId);
    logAudit("user.unlink", `${me.nickname} unlinked ${u?.nickname||userId}'s account`, "user", userId);
  };
  // Sweeps padelos_links entries whose target user no longer exists — the residue left behind
  // by the old deleteUser path (fixed above) that never cleaned up the link when a user was
  // deleted. Without this, a deleted test account's email/Google login stays permanently
  // "claimed" by nothing, with no user row left in the Users list to click "🔓 Unlink" on.
  const cleanOrphanedLinks = () => {
    const orphaned = Object.entries(uidLinks).filter(([,uid])=>!users.find(u=>u.id===uid));
    if (!orphaned.length) { toast2("No orphaned links found ✓"); return; }
    orphaned.forEach(([firebaseUid])=>{ deleteDoc(doc(db,"padelos_links",firebaseUid)).catch(e=>console.log("Firestore delete error (uidLinks)", e)); });
    setUidLinks(links => { const n={...links}; orphaned.forEach(([fbUid])=>delete n[fbUid]); return n; });
    toast2(`Cleaned ${orphaned.length} orphaned link${orphaned.length>1?"s":""} ✓`);
    logAudit("admin.cleanOrphanedLinks", `${me.nickname} cleaned ${orphaned.length} orphaned account link(s)`, null, null);
  };

  // invites — admin-generated shareable links (Enhancement #1). Same one-blob-doc pattern as
  // notifications; codes are short random tokens resolved client-side.
  useEffect(() => {
    if (!authUser) return; // don't attach Firestore listeners before auth has settled — avoids a permission-denied race on cold start
    const unsub = onSnapshot(doc(db,"padelos","invites"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw;
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.invites) { syncedRef.current.invites = json; setInvites(remote);
          _invid = Math.max(_invid, ...remote.map(i=>i.id), 0) + 1;
        }
        everRealRef.current.invites = true;
      } else if (!everRealRef.current.invites) { syncedRef.current.invites = JSON.stringify([]); setInvites([]); everRealRef.current.invites = true; } // unlike comms/users/venues, invites has no seed data to protect — "document not found" IS the confirmed-real empty state, so writes must not stay blocked forever
      markLoaded("invites");
    }, e => { console.log("Firestore invites error", e); recordDiag("invites", `${e.code||"error"}: ${e.message||e}`); markLoaded("invites"); });
    return unsub;
  }, [authUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!everRealRef.current.invites) { console.log("Blocked write: haven't confirmed real invites data this session yet"); return; }
    const json = JSON.stringify(invites);
    if (json === syncedRef.current.invites) return;
    syncedRef.current.invites = json;
    setDoc(doc(db,"padelos","invites"), {value:JSON.stringify(invites)}).catch(e=>console.log("Firestore write error (invites)", e));
  }, [invites, dataLoaded]);
  const inviteCodeChars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I/L
  const genInviteCode = () => Array.from({length:7}, () => inviteCodeChars[Math.floor(Math.random()*inviteCodeChars.length)]).join("");
  const createInvite = ({targetUserId,communityId,eventId,label}) => {
    const id = _invid++;
    const code = genInviteCode();
    setInvites(inv => [...inv, {id, code, createdBy:me.id, createdAt:new Date().toISOString(), targetUserId:targetUserId??null, communityId:communityId??null, eventId:eventId??null, label:label||""}]);
    return code;
  };
  // An invite link skips the generic "which one is you?" search screen for a targeted invite —
  // but it does NOT skip verifying identity. A targeted invite used to call claimViaInvite
  // straight from this effect, linking whoever was signed in with zero confirmation — if the
  // link got forwarded, shared in the wrong chat, or opened by someone other than the intended
  // person, they were silently and permanently merged into that profile (see BUGS.md). Now this
  // effect only ever stages a confirmation (pendingInviteConfirm, rendered below) — the actual
  // claimViaInvite call happens only after the signed-in person explicitly says "yes, that's
  // me". An invite with no target (pure signup/community/event) still goes straight to a fresh
  // profile, since there's no existing identity to misattribute.
  const autoInviteClaimRef = useRef(null);
  const [pendingInviteConfirm, setPendingInviteConfirm] = useState(null); // {inv, target} | null
  const [pendingEmailMatchConfirm, setPendingEmailMatchConfirm] = useState(null); // {target} | null
  // Firebase keeps a signed-in browser session alive until an explicit Sign Out, same as any
  // web app — opening a link (invite or otherwise) never forces a fresh login on its own. That
  // used to mean a stale/deleted account's session would silently mint a brand-new profile the
  // instant any link was opened, with zero prompt — surprising if you'd deleted that identity
  // and expected a truly fresh visit. Now both auto-create paths below stage this confirmation
  // instead of creating anything immediately, so it's always an explicit choice.
  const [pendingFreshProfileConfirm, setPendingFreshProfileConfirm] = useState(false);
  useEffect(() => {
    if (!authUser || linkedMe || !dataLoaded || pendingEmailMatchConfirm || pendingFreshProfileConfirm) return;
    const code = readPendingInvite();
    if (!code || autoInviteClaimRef.current===code) return;
    const inv = invites.find(i=>i.code===code);
    if (!inv) return;
    const alreadyClaimed = Object.values(uidLinks).includes(inv.targetUserId);
    if (inv.targetUserId!=null && !alreadyClaimed) {
      const target = users.find(u=>u.id===inv.targetUserId);
      if (target) setPendingInviteConfirm({inv, target});
    } else if (inv.targetUserId==null) {
      autoInviteClaimRef.current = code;
      setPendingFreshProfileConfirm(true);
    }
  }, [authUser, linkedMe, dataLoaded, invites, uidLinks, users, pendingEmailMatchConfirm, pendingFreshProfileConfirm]);
  // No generic "which one is you?" self-service claim screen anymore (see BUGS.md #17) —
  // anyone signing in with no pending targeted invite just gets a brand-new profile (after the
  // confirmation above), same as an untargeted invite already did. One bootstrap exception: if
  // the platform-owner seed profile (#1) has no linked account at all yet (first-ever setup, or
  // the owner's own device/session got wiped), link straight to it instead of creating a
  // duplicate — there's nobody else who could send #1 an invite link, so #1 can't rely on the
  // normal targeted-invite path itself. That one case stays silent/automatic on purpose.
  const autoFreshProfileRef = useRef(false);
  useEffect(() => {
    if (!authUser || linkedMe || !dataLoaded || pendingInviteConfirm || pendingEmailMatchConfirm || pendingFreshProfileConfirm) return;
    if (readPendingInvite()) return; // the invite-claim effect above owns this case
    if (autoFreshProfileRef.current) return;
    autoFreshProfileRef.current = true;
    if (!Object.values(uidLinks).includes(1)) {
      linkUidToUser(authUser.uid, 1);
      setUsers(us => us.map(u => u.id===1 ? {...u, email:authUser.email||u.email, photoURL:u.photoURL||authUser.photoURL||""} : u));
    } else {
      setPendingFreshProfileConfirm(true);
    }
  }, [authUser, linkedMe, dataLoaded, pendingInviteConfirm, pendingEmailMatchConfirm, pendingFreshProfileConfirm, uidLinks]);
  // Once the person opening an invite link is actually linked to a profile — instantly, for
  // both a brand-new profile and a confirmed targeted claim of an existing one — join them to
  // the invited community/event. Deliberately re-checked on every render where these
  // deps change (not just right after auth) so this still applies the
  // next time the app is open, since the invite code just sits in localStorage until consumed.
  const appliedInviteRef = useRef(null);
  useEffect(() => {
    if (!linkedMe || !dataLoaded) return;
    const code = readPendingInvite();
    if (!code || appliedInviteRef.current===code) return;
    const inv = invites.find(i=>i.code===code);
    // Don't give up on a not-yet-found code — if this invite was just generated on another
    // device/session moments ago, the write to Firestore can still be in flight when this
    // effect first runs. Clearing the pending code here would lose it permanently even
    // though `invites` (a dependency of this effect) will re-fire once the real data
    // arrives — only clear it once actually applied, below.
    if (!inv) return;
    appliedInviteRef.current = code;
    if (inv.eventId && inv.communityId) {
      // Registers immediately, bypassing the regular-member priority window entirely (see
      // registerViaInvite) — and leaves a community guest-tier footprint too if they weren't
      // already a member of any status.
      registerViaInvite(inv.communityId, inv.eventId, linkedMe.id);
      goEvent(inv.communityId, inv.eventId);
    } else if (inv.communityId) {
      const c = comms.find(c=>c.id===inv.communityId);
      const isMember = c?.members.some(m=>m.userId===linkedMe.id);
      if (c && !isMember) {
        if (inv.targetUserId!=null) joinCommunityViaInvite(inv.communityId, linkedMe.id);
        else {
          const hasPending = c.joinRequests.some(r=>r.userId===linkedMe.id);
          if (!hasPending) requestJoin(inv.communityId);
        }
      }
      goComm(inv.communityId);
    }
    clearPendingInvite();
  }, [linkedMe, dataLoaded, invites, comms]);
  // Defense in depth for the same bug: explicitly wipe any pending invite on a genuine
  // sign-out transition (not the initial pre-login "no authUser yet" state), so switching
  // accounts on one device can never carry a leftover invite into the next person's session.
  const wasAuthedRef = useRef(false);
  useEffect(() => {
    if (authUser) { wasAuthedRef.current = true; }
    else if (wasAuthedRef.current) { clearPendingInvite(); setPendingInviteConfirm(null); autoFreshProfileRef.current = false; wasAuthedRef.current = false; }
  }, [authUser]);

  useEffect(() => {
    if (!dataLoaded) return;
    // Backfill USR history for completed CI events where it was never calculated
    // (happens for seeded/imported events that were pre-set to "completed" without going through closeEvent).
    // Only runs if at least one completed CI event has a player with no usrHistory entry for that event yet.
    const completedCI = comms.flatMap(c => c.events.filter(ev =>
      ev.status === "completed" && ev.type === "closed_ind" && ev.plan
    ));
    if (completedCI.length === 0) return;

    let anyUpdate = false;
    const standingsCache = {}; // event.id -> stands, computed once per event instead of once per user-per-event
    completedCI.forEach(ev => { standingsCache[ev.id] = calcCIStandings(ev.plan, users); });
    const updatedUsers = users.map(u => {
      let updatedUser = {...u, usrHistory: [...(u.usrHistory||[])]};
      completedCI.forEach(ev => {
        // Skip if this event already has a history entry for this user
        if (updatedUser.usrHistory.some(h => h.eventId === ev.id)) return;
        const plan = ev.plan;
        const stands = standingsCache[ev.id];
        const s = stands.find(s => s.user.id === u.id);
        if (!s) return;
        const maxPts = personalMaxCI(s.breaks, personalRoundsCI(u.id, plan), plan.courts);
        if (maxPts <= 0) return;
        const pes = Math.round((s.pts / maxPts) * 100 * 10) / 10;
        updatedUser.usrHistory.push({eventId: ev.id, eventName: ev.name, date: ev.date, pes, type:"ci", retired:(ev.retiredIds||[]).includes(u.id)});
        anyUpdate = true;
      });
      if (!anyUpdate && updatedUser.usrHistory === u.usrHistory) return u;
      const hist = updatedUser.usrHistory;
      if (hist.length === 0) return u;
      const seedUsr = u.seedUsr ?? u.usr;
      const newUsr = calcWeightedUSR(hist, seedUsr, usrWindowSize);
      return {...updatedUser, usr: newUsr, seedUsr: u.seedUsr ?? u.usr};
    });

    if (anyUpdate) setUsers(updatedUsers);
  }, [dataLoaded]); // re-runs once the restore completes; only meaningful after that


  // Nickname (the name everyone sees) and phone must be unique across every local profile —
  // guests included, since a guest today can become a real linked member tomorrow.
  const nicknameTaken = (nickname, excludeId=null) => users.some(u => u.id!==excludeId && u.nickname && u.nickname.trim().toLowerCase()===(nickname||"").trim().toLowerCase());
  const phoneTaken = (phone, excludeId=null) => !!(phone||"").trim() && users.some(u => u.id!==excludeId && u.phone && u.phone.trim()===phone.trim());
  const editUser = (id, data) => {
    if (nicknameTaken(data.nickname, id)) { toast2(`Nickname "${data.nickname}" is already used by another player`, "err"); return false; }
    if (phoneTaken(data.phone, id)) { toast2(`Phone ${data.phone} is already used by another player`, "err"); return false; }
    setUsers(us => us.map(u => u.id===id ? {...u, nickname:data.nickname, name:data.name, country:data.country??u.country, gov:data.gov, area:data.area, usr:data.usr, phone:data.phone, photoURL:data.photoURL??u.photoURL, avatar:ini2(data.nickname), breakPref:data.breakPref??u.breakPref, instapayLink:data.instapayLink!==undefined?data.instapayLink:u.instapayLink} : u));
    toast2("Player updated ✓");
    if (id!==me.id) { const u=users.find(u=>u.id===id); logAudit("user.edit", `${me.nickname} edited ${u?.nickname||id}'s profile`, "user", id); }
    return true;
  };
  // A player who has actually played (usrHistory.length>0) can never be fully deleted — their
  // history line is permanent, per the admin's explicit rule. Suspend is the alternative:
  // reversible, blocks the account from signing in/using the app, but touches nothing else —
  // every historical roster/standing they're part of stays exactly as-is. id 1 (platform
  // owner) is hard-exempted to avoid a self-lockout.
  const suspendUser = (id) => {
    if (id===1) { toast2("Can't suspend the platform owner account", "err"); return; }
    const u = users.find(u=>u.id===id);
    const next = !u?.suspended;
    setUsers(us => us.map(u => u.id===id ? {...u, suspended:next} : u));
    toast2(next?"Suspended":"Unsuspended ✓");
    logAudit(next?"user.suspend":"user.unsuspend", `${me.nickname} ${next?"suspended":"unsuspended"} ${u?.nickname||id}`, "user", id);
  };
  // Manual activation bridge (Enhancement #17, Phase 1) — until Paymob is live, this is how a
  // real payment actually gets applied: someone sends an InstaPay/Vodafone Cash/bank transfer
  // directly, the admin confirms it arrived, and sets their access here. `status:"comped"` never
  // expires (for founding members/testers); `status:"active"` needs an expiresAt date.
  const setUserSubscription = (id, {status, expiresAt}) => {
    const u = users.find(u=>u.id===id);
    setUsers(us => us.map(u => u.id===id ? {...u, subscription: status==="none" ? null : {status, expiresAt: status==="comped" ? null : expiresAt}} : u));
    toast2("Subscription updated ✓");
    const label = status==="none" ? "cleared" : status==="comped" ? "comped (no expiry)" : `active until ${expiresAt}`;
    logAudit("user.subscriptionChange", `${me.nickname} set ${u?.nickname||id}'s subscription: ${label}`, "user", id);
  };
  // Confirms a manual InstaPay/Vodafone Cash/bank transfer and logs it as a transaction (feeds
  // the Statement view's totals). Extends from the CURRENT expiry if the user is still active or
  // in grace (so paying early never shortens what they already have), otherwise starts fresh
  // from today. Amount is snapshotted from current pricing at confirmation time, so a later price
  // change never rewrites past transaction history.
  const confirmSubscriptionPayment = (id, {plan, amount, method}) => {
    const u = users.find(u=>u.id===id);
    const now = new Date();
    const currentExp = u?.subscription?.expiresAt ? new Date(u.subscription.expiresAt) : null;
    const stillGood = currentExp && currentExp.getTime()+SUBSCRIPTION_GRACE_MS > now.getTime();
    const newExp = new Date(stillGood ? currentExp : now);
    if (plan==="annual") newExp.setFullYear(newExp.getFullYear()+1); else newExp.setMonth(newExp.getMonth()+1);
    setUsers(us => us.map(u => u.id===id ? {...u, subscription:{status:"active", expiresAt:newExp.toISOString()}} : u));
    const txn = {id:`${Date.now()}_${id}`, userId:id, userNickname:u?.nickname, plan, amount, method, confirmedAt:new Date().toISOString(), confirmedBy:me.nickname};
    setSubscriptionTransactions(ts => [...ts, txn]);
    toast2(`Payment confirmed — ${u?.nickname||"user"} extended to ${fmtD(newExp.toISOString())} ✓`);
    logAudit("user.subscriptionPayment", `${me.nickname} confirmed a ${plan} payment (${amount} EGP via ${method}) from ${u?.nickname||id} — extended to ${fmtD(newExp.toISOString())}`, "user", id);
  };
  // Changing the USR rolling-average window (calcWeightedUSR's windowSize) must never
  // retroactively pull an already-dropped event back into anyone's average. Before applying the
  // new size, freeze every usrHistory entry that's currently OUTSIDE the *old* window (per user,
  // walking newest-first exactly like calcWeightedUSR does) — those get excludedFromWindow:true
  // permanently, regardless of which direction the size changes later. Nothing about anyone's
  // live .usr changes at this moment; the new size only affects what gets counted starting with
  // the next event they complete (a growing window just has less-than-full budget to fill until
  // enough new events accrue, which is exactly the "grow forward, don't refill from history" ask).
  const setUsrWindowSize = (newSize) => {
    const oldSize = usrWindowSize;
    if (newSize===oldSize) return;
    setUsers(us => us.map(u => {
      const hist = u.usrHistory||[];
      if (!hist.length) return u;
      const chron = [...hist].reverse();
      let totalWeight = 0;
      const activeEventIds = new Set();
      for (const h of chron) {
        if (h.retired || h.excludedFromWindow) continue;
        if (totalWeight>=oldSize) break;
        const w = h.type==="ct" ? 0.5 : 1.0;
        totalWeight += Math.min(w, oldSize-totalWeight);
        activeEventIds.add(h.eventId);
      }
      let changed = false;
      const newHist = hist.map(h => {
        if (h.retired || h.excludedFromWindow || activeEventIds.has(h.eventId)) return h;
        changed = true;
        return {...h, excludedFromWindow:true};
      });
      return changed ? {...u, usrHistory:newHist} : u;
    }));
    setUsrWindowSizeRaw(newSize);
    logAudit("admin.usrWindowSize", `${me.nickname} changed the USR rolling-average window from ${oldSize} to ${newSize} events`, null, null);
    toast2(`USR window set to ${newSize} — takes effect from each player's next completed event ✓`);
  };
  const deleteUser = (id) => {
    const u = users.find(u=>u.id===id);
    setUsers(us => us.filter(u => u.id!==id));
    // Clean up stale references across all communities/events so counts stay accurate
    setComms(cs => cs.map(c => ({
      ...c,
      members: c.members.filter(m => m.userId !== id),
      events: c.events.map(ev => ({
        ...ev,
        registrations: ev.registrations.filter(r => r.userId !== id),
        checkedIn: (ev.checkedIn||[]).filter(uid => uid !== id),
      })),
    })));
    // Also release any identity link to this user so their email/Google account is free to
    // sign in fresh again, instead of staying permanently claimed by a deleted profile — this
    // was previously left dangling (the exact "the system still remembers a deleted test user"
    // symptom), since the delete path used to only touch the `users` array.
    const entry = Object.entries(uidLinks).find(([,uid])=>uid===id);
    if (entry) {
      const [firebaseUid] = entry;
      deleteDoc(doc(db,"padelos_links",firebaseUid)).catch(e=>console.log("Firestore delete error (uidLinks)", e));
      setUidLinks(links => { const n={...links}; delete n[firebaseUid]; return n; });
    }
    toast2("Player removed");
    logAudit("user.delete", `${me.nickname} deleted user ${u?.nickname||id}`, "user", id);
  };

  const exportData = () => {
    try {
      const data = JSON.stringify({users, venues, comms, exportedAt: new Date().toISOString(), version:APP_VERSION}, null, 2);
      const blob = new Blob([data], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "padelos_backup.json"; a.click();
      URL.revokeObjectURL(url);
      toast2("Data exported ✓");
    } catch(e) { toast2("Export failed","err"); }
  };
  // Audit Trail (Enhancement #26) — Platform-Admin-only oversight log of who did what. One
  // document per entry (padelos_audit/<autoId>), same "many small docs" pattern as backups and
  // uidLinks, not the single-blob pattern the rest of the app uses — a blob can't sensibly hold
  // an append-only, ever-growing log. Only admin-level/sensitive actions are logged (not every
  // click — routine reads and simple navigation stay out); the console shows the most recent
  // 200, no automatic deletion for now.
  const [auditLog, setAuditLog] = useState([]);
  useEffect(() => {
    if (!authUser) return;
    const q = query(collection(db,"padelos_audit"), orderBy("ts","desc"), limit(200));
    const unsub = onSnapshot(q, snap => {
      setAuditLog(snap.docs.map(d => ({id:d.id, ...d.data()})));
    }, e => console.log("Firestore audit error", e));
    return unsub;
  }, [authUser]);
  // Returns the write promise (most callers ignore it — fire-and-forget) so the handful of
  // callers that reload/navigate away immediately after (factoryReset) can await it first,
  // since window.location.reload() would otherwise kill the in-flight write.
  const logAudit = (action, summary, targetType, targetId) => {
    return addDoc(collection(db,"padelos_audit"), {
      ts: new Date().toISOString(),
      actorId: me?.id ?? null,
      actorName: me?.nickname || "Unknown",
      action, summary,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      appVersion: APP_VERSION,
      platform: Capacitor.isNativePlatform() ? "Android" : "Web",
    }).catch(e => console.log("Firestore write error (audit)", e));
  };
  // Manual refresh — onSnapshot already keeps auditLog live, but a one-off server read (bypassing
  // any stale local cache) gives the console a visible "did something happen" affordance on tap.
  const [auditRefreshing, setAuditRefreshing] = useState(false);
  const refreshAudit = async () => {
    setAuditRefreshing(true);
    try {
      const q = query(collection(db,"padelos_audit"), orderBy("ts","desc"), limit(200));
      const snap = await getDocs(q);
      setAuditLog(snap.docs.map(d => ({id:d.id, ...d.data()})));
      setAuditOlder([]); setAuditHasMore(true); // refresh resets pagination too
    } catch(e) { console.log("Firestore audit refresh error", e); }
    finally { setAuditRefreshing(false); }
  };
  // Pagination beyond the live 200 — a one-off read per page (not live), fetched only on
  // request, since the console shows the most recent 200 by default and older activity is
  // viewed far less often than it'd cost to keep live-subscribed forever.
  const [auditOlder, setAuditOlder] = useState([]);
  const [auditHasMore, setAuditHasMore] = useState(true);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const loadMoreAudit = async () => {
    setAuditLoadingMore(true);
    try {
      const combined = [...auditLog, ...auditOlder];
      const cursorTs = combined.length ? combined[combined.length-1].ts : null;
      if (!cursorTs) { setAuditHasMore(false); return; }
      const q = query(collection(db,"padelos_audit"), orderBy("ts","desc"), startAfter(cursorTs), limit(200));
      const snap = await getDocs(q);
      const more = snap.docs.map(d => ({id:d.id, ...d.data()}));
      setAuditOlder(prev => [...prev, ...more]);
      setAuditHasMore(more.length === 200);
    } catch(e) { console.log("Firestore audit load-more error", e); }
    finally { setAuditLoadingMore(false); }
  };
  // Sign-in logging deliberately watches `linkedMe` becoming set, not the raw
  // onAuthStateChanged callback — that callback's closure is created on first mount, before
  // uidLinks has even loaded, so `me` inside it would stay stuck at the users[0] fallback
  // instead of the real signed-in person. Ref-guarded so it only logs once per fresh sign-in
  // (this app session), not on every re-render while linkedMe stays truthy.
  const loginLoggedRef = useRef(false);
  useEffect(() => {
    if (!linkedMe) { loginLoggedRef.current = false; return; }
    if (loginLoggedRef.current) return;
    loginLoggedRef.current = true;
    if (justCreatedRef.current===linkedMe.id) {
      justCreatedRef.current = null;
      logAudit("user.create", `${linkedMe.nickname} created a new account and signed in for the first time`, "user", linkedMe.id);
    } else {
      logAudit("auth.signin", `${linkedMe.nickname} signed in`, "user", linkedMe.id);
    }
  }, [linkedMe]);
  // Manual backup — Platform Admin only. Writes a full snapshot to its own document
  // (padelos_backups/<timestamp>) so a bad edit or bug can be rolled back without
  // relying on someone remembering to export a JSON file beforehand.
  const [backups, setBackups] = useState([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const refreshBackups = async () => {
    setBackupsLoading(true);
    try {
      const snap = await getDocs(collection(db,"padelos_backups"));
      const list = snap.docs.map(d=>({id:d.id, ...d.data()})).sort((a,b)=>b.id.localeCompare(a.id));
      setBackups(list);
    } catch(e) { console.log("Fetch backups error", e); toast2("Couldn't load backups","err"); }
    setBackupsLoading(false);
  };
  const createBackup = async () => {
    try {
      const id = new Date().toISOString();
      await setDoc(doc(db,"padelos_backups",id), {
        value: JSON.stringify({users, venues, comms}),
        createdAt: id,
        createdBy: me?.nickname || "unknown",
        version: APP_VERSION,
      });
      toast2("Backup created ✓");
      refreshBackups();
    } catch(e) { console.log("Create backup error", e); toast2("Backup failed","err"); }
  };
  const restoreBackup = async (backupId) => {
    const b = backups.find(x=>x.id===backupId);
    if (!b) return;
    try {
      const snap = JSON.parse(b.value);
      setUsers(snap.users||[]);
      setVenues(snap.venues||[]);
      setComms(snap.comms||[]);
      toast2(`Restored backup from ${timeAgo(b.createdAt)} ✓`);
      logAudit("admin.restoreBackup", `${me.nickname} restored a backup from ${timeAgo(b.createdAt)}`, "backup", backupId);
    } catch(e) { console.log("Restore backup error", e); toast2("Restore failed — backup data unreadable","err"); }
  };
  const deleteBackup = async (backupId) => {
    try { await deleteDoc(doc(db,"padelos_backups",backupId)); setBackups(bs=>bs.filter(b=>b.id!==backupId)); }
    catch(e) { console.log("Delete backup error", e); toast2("Delete failed","err"); }
  };
  const repairDuplicateIds = () => {
    let fixed = 0;
    const seenEventIds = new Set();
    const newComms = comms.map(c => ({
      ...c,
      events: c.events.map(ev => {
        if (seenEventIds.has(ev.id)) {
          fixed++;
          const newId = _eid++;
          seenEventIds.add(newId);
          return {...ev, id: newId};
        }
        seenEventIds.add(ev.id);
        return ev;
      }),
    }));
    setComms(newComms);

    let venuesFixed = 0;
    const newVenues = venues.map(v => {
      if (!v || !Array.isArray(v.courts)) {
        venuesFixed++;
        const n = typeof v?.courts === "number" ? v.courts : 2;
        return {...v, courts: Array.from({length:n}, (_,i)=>({name:`Court ${i+1}`}))};
      }
      return v;
    });
    if (venuesFixed > 0) setVenues(newVenues);

    const total = fixed + venuesFixed;
    if (total > 0) toast2(`Repaired ${fixed} event ID(s) and ${venuesFixed} venue(s) ✓`);
    else toast2("No issues found — data is clean ✓");
  };
  const factoryReset = async () => {
    try {
      await logAudit("admin.factoryReset", `${me.nickname} performed a Factory Reset — all data wiped to seed defaults`, null, null);
      localStorage.removeItem('padelos_v10');
      localStorage.removeItem('padelos_v09');
      // Must await these — window.location.reload() right after tears down the JS
      // context, aborting any writes still in flight, so an un-awaited call here
      // silently loses the reset (found via padelos-dev: reset "succeeded" but the
      // seed docs were never actually written).
      await Promise.all([
        setDoc(doc(db,"padelos","comms"), {value:JSON.stringify(INIT_COMMS)}),
        setDoc(doc(db,"padelos","users"), {value:JSON.stringify(INIT_USERS)}),
        setDoc(doc(db,"padelos","venues"), {value:JSON.stringify(INIT_VENUES)}),
        setDoc(doc(db,"padelos","notifications"), {value:JSON.stringify([])}),
      ]);
    } catch(e) {}
    window.location.reload();
  };
  // One-way push of the current session's already-loaded prod data into padelos-dev, via a
  // second named Firebase app instance so this connection is fully independent from `db`
  // (which stays pointed at whatever project this build actually targets). Production-build
  // only — never rendered/callable from a dev build, see IS_DEV_ENV gating on the button.
  const [cloningToDev, setCloningToDev] = useState(false);
  const cloneToDev = async () => {
    if (IS_DEV_ENV) return;
    setCloningToDev(true);
    try {
      const devApp = getApps().find(a=>a.name==="devClone") || initializeApp(DEV_CLONE_TARGET_CONFIG, "devClone");
      const devAuth = getAuth(devApp);
      const devDb = getFirestore(devApp);
      if (!devAuth.currentUser) await signInWithPopup(devAuth, new GoogleAuthProvider());
      await Promise.all([
        setDoc(doc(devDb,"padelos","comms"), {value:JSON.stringify(comms)}),
        setDoc(doc(devDb,"padelos","users"), {value:JSON.stringify(users)}),
        setDoc(doc(devDb,"padelos","venues"), {value:JSON.stringify(venues)}),
        setDoc(doc(devDb,"padelos","egypt"), {value:JSON.stringify(egypt)}),
        setDoc(doc(devDb,"padelos","expenseCategories"), {value:JSON.stringify(expenseCategories)}),
        setDoc(doc(devDb,"padelos","usrWindowSize"), {value:JSON.stringify(usrWindowSize)}),
      ]);
      logAudit("admin.cloneToDev", `${me.nickname} cloned production data to the DEV environment`, null, null);
      toast2(`Cloned to DEV ✓ (${users.length} users, ${comms.length} communities)`);
    } catch(e) { console.log("Clone to DEV failed", e); window.alert(`Clone to DEV failed:\n\n${e.code||""} ${e.message||e}`); }
    setCloningToDev(false);
  };
  // ────────────────────────────────────────────────────

  const toast2 = (msg,t="ok") => { setToast({msg,t}); setTimeout(()=>setToast(null),2600); };
  const backPressRef = useRef(0);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handler = CapApp.addListener("backButton", () => {
      const now = Date.now();
      if (now - backPressRef.current < 2000) {
        CapApp.exitApp();
      } else {
        backPressRef.current = now;
        toast2("Press back again to exit");
      }
    });
    return () => { handler.then(h=>h.remove()); };
  }, []);
  // go() defined above with history tracking
  // Second (interactive) God Mode warning — the first is the persistent banner rendered
  // whenever godMode is on. This one only fires for a write to a community/event the Platform
  // Admin isn't actually a real owner/admin of — i.e. exactly the writes God Mode alone made
  // possible. A real admin's own communities behave normally, no extra prompt.
  const updC = (id,fn,opts={}) => {
    // Read-only enforcement (Enhancement #17) — this single funnel already covers essentially
    // every community/event write in the app (members, events, ledger, announcements,
    // registrations...), same reason God Mode's second-confirm gate lives here too. Platform
    // Admin is exempt so they can always manage the system regardless of their own subscription.
    // A 1-day grace period after expiry (isSubscriptionLocked) delays the actual lockout — see
    // isSubscriptionLocked. opts.bypassSubscriptionLock is the one carve-out: a locked user can
    // still unregister themselves from events (removeFromEvent passes it for self-cancel only).
    if (!opts.bypassSubscriptionLock && isSubscriptionLocked(me, subscriptionSettings)) {
      toast2("Your subscription has expired — you can still view everything and unregister from events, but renewing is needed for anything else.", "err");
      return;
    }
    if (godMode && me.id===1) {
      const c = comms.find(cc=>cc.id===id);
      const realRole = c?.members.find(m=>m.userId===1)?.role;
      if (realRole!=="owner" && realRole!=="admin" && !window.confirm(`⚡ God Mode — you're not actually a member/admin of "${c?.name||"this community"}".\n\nApply this change anyway?`)) return;
    }
    setComms(cs=>cs.map(c=>c.id===id?fn(c):c));
  };
  const getEv = (cid,eid) => comms.find(c=>c.id===cid)?.events.find(e=>e.id===eid);

  // ── Notifications ──────────────────────────────────────
  // Event-scoped notifications only (registration, reminders, changes) — see Ch09.
  // Direct messaging / broadcasts / other categories are deferred.
  const notify = (userIds, type, ev, title, body) => {
    const uniq = [...new Set((userIds||[]).filter(Boolean))];
    if (uniq.length===0) return;
    const now = new Date().toISOString();
    setNotifications(ns => [
      ...uniq.map(uid => ({id:_nid++, userId:uid, type, eventId:ev?.id, communityId:ev?.communityId, eventName:ev?.name, profileUserId:ev?.profileUserId, title, body, createdAt:now, read:false})),
      ...ns,
    ]);
  };
  const markNotifRead = (id) => setNotifications(ns => ns.map(n => n.id===id?{...n,read:true}:n));
  const markAllNotifRead = () => setNotifications(ns => ns.map(n => n.userId===me.id?{...n,read:true}:n));
  // Enhancement #19 — a tapped notification takes you to whatever it's actually about,
  // instead of leaving you wherever you happened to be. Covers every notify() call site:
  // event+community context (most types) already carries both ids; community-only context
  // (new_community) carries just communityId; profileUserId (newPlatformUser, inviteClaimed)
  // carries neither, so it's checked first — a bare {profileUserId} shim passed as the `ev`
  // arg to notify() is what gets it onto the notification, same trick {communityId} already uses.
  const openNotif = (n) => {
    markNotifRead(n.id);
    if (n.profileUserId) { setNavHistory(h=>[...h,{nav,view}]); setNav("profile"); setView({screen:"profile", uid:n.profileUserId}); return; }
    if (n.communityId && n.eventId) { goEvent(n.communityId, n.eventId); return; }
    if (n.communityId) { goComm(n.communityId); return; }
  };

  // Reminder engine — checks upcoming events every minute and fires a one-time
  // notification per threshold (24h/3h/1h before start) to all registered players.
  // Fired flags are stored on the event itself so reminders never repeat, even across reloads.
  // Reads comms via a ref (kept fresh below) rather than depending on `comms` directly —
  // this effect writes to comms itself (via updC), so depending on comms here would tear
  // down and rebuild this effect every time it fires a reminder, re-running checkReminders()
  // immediately each time and risking a runaway update loop when an event is near a threshold.
  const commsRef = useRef(comms);
  useEffect(() => { commsRef.current = comms; }, [comms]);
  useEffect(() => {
    const checkReminders = () => {
      const now = Date.now();
      commsRef.current.forEach(c => {
        c.events.forEach(ev => {
          if (!ev.date || !ev.time || ev.status==="completed" || ev.status==="cancelled") return;
          const start = new Date(`${ev.date}T${ev.time}`).getTime();
          if (isNaN(start)) return;
          const hoursLeft = (start-now)/3600000;
          const fired = ev.remindersFired || {};
          [[24,"h24","~24h"],[3,"h3","~3h"],[1,"h1","~1h"]].forEach(([h,key,label])=>{
            if (hoursLeft<=h && hoursLeft>0 && !fired[key]) {
              const recipients = ev.registrations.map(r=>r.userId);
              notify(recipients, `reminder_${key}`, ev, `⏰ ${ev.name} starts in ${label}`, `${fmtD(ev.date)} · ${fmtT(ev.time)}`);
              updC(ev.communityId, c2=>({...c2,events:c2.events.map(e=>e.id!==ev.id?e:{...e,remindersFired:{...(e.remindersFired||{}),[key]:true}})}));
            }
          });
        });
      });
    };
    checkReminders();
    const iv = setInterval(checkReminders, 60000);
    return () => clearInterval(iv);
  }, []);

  // Community
  const createComm=(d)=>{const id=_cid++;setComms(cs=>[...cs,{id,...d,founded:today,members:[{userId:me.id,role:"owner",status:"regular",since:today}],joinRequests:[],events:[]}]);toast2(`${d.name} created!`);go("comm",{cid:id});
    if (me.id!==1) notify([1], "new_community", {communityId:id}, "🌱 New community created", `${me.nickname} created "${d.name}"`);
    logAudit("community.create", `${me.nickname} created community "${d.name}"`, "community", id);
  };
  const saveComm=(id,d)=>{updC(id,c=>({...c,...d}));toast2("Saved ✓");goBack();};
  // ── Centralized bookkeeping (opt-in, per community) ──────────────────
  // Deliberately runs ALONGSIDE per-event cost-splitting, not instead of it — some
  // communities self-settle per event (today's default, untouched), others additionally
  // collect a recurring due into a shared fund for tips/balls/equipment. One flat ledger of
  // dated entries is the whole model: type:"due" entries are member-linked payments (partial
  // payments are just their own line item — "how much has X paid this month" is a sum, not a
  // flag, so partial payments fall out for free without a separate paid/unpaid boolean),
  // type:"expense" entries are free-text admin-recorded spending (with a category, from the
  // platform-admin-maintained expenseCategories list), type:"charge" is a non-cash liability
  // assessed to a member (the monthly due itself, auto-accrued every month — see LedgerTab's
  // backfill effect), type:"income_misc" is cash income NOT from a member's monthly due (e.g.
  // sponsorship, event surplus). Cash Balance = due + income_misc - expense (charge has no cash
  // effect). A member's Liability = their charges - their dues (negative = credit/overpaid).
  const setBookkeeping=(cid,fields)=>{updC(cid,c=>({...c,bookkeeping:{...(c.bookkeeping||{enabled:false,monthlyDue:100,entries:[]}),...fields,...(fields.enabled&&!c.bookkeeping?.enabled?{enabledAt:new Date().toISOString()}:{})}}));toast2("Saved ✓");};
  const addLedgerEntry=(cid,entry)=>{
    // Timestamp+random rather than a global counter — entries live nested inside each
    // community's own blob, so a counter would need scanning every community's entries on
    // load just to stay collision-free; this doesn't.
    const id=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    updC(cid,c=>({...c,bookkeeping:{...(c.bookkeeping||{enabled:false,monthlyDue:100,entries:[]}),entries:[...((c.bookkeeping||{}).entries||[]),{id,recordedBy:me.id,date:new Date().toISOString(),...entry}]}}));
    toast2(entry.type==="due"?"Payment recorded ✓":entry.type==="income_misc"?"Income added ✓":entry.type==="charge"?"Charge added ✓":"Expense added ✓");
  };
  // Bulk variant for the monthly-charge backfill (LedgerTab) — one Firestore write for
  // potentially dozens of missing charge entries instead of one round-trip per entry.
  const addLedgerEntries=(cid,entriesArr)=>{
    if(!entriesArr||!entriesArr.length) return;
    updC(cid,c=>({...c,bookkeeping:{...(c.bookkeeping||{enabled:false,monthlyDue:100,entries:[]}),entries:[...((c.bookkeeping||{}).entries||[]),...entriesArr.map((entry,i)=>({id:`${Date.now()}-${i}-${Math.random().toString(36).slice(2,6)}`,recordedBy:me.id,date:new Date().toISOString(),...entry}))]}}));
  };
  const deleteLedgerEntry=(cid,entryId)=>{updC(cid,c=>({...c,bookkeeping:{...c.bookkeeping,entries:(c.bookkeeping?.entries||[]).filter(e=>e.id!==entryId)}}));toast2("Removed");};
  const approveReq=(cid,uid)=>{updC(cid,c=>({...c,joinRequests:c.joinRequests.filter(r=>r.userId!==uid),members:[...c.members,{userId:uid,role:"member",status:initialMemberStatus(c),since:today}]}));toast2("Approved ✓");
    const c=comms.find(c=>c.id===cid),u=users.find(u=>u.id===uid);
    logAudit("member.join", `${me.nickname} approved ${u?.nickname||uid}'s request to join "${c?.name||cid}"`, "community", cid);
  };
  const rejectReq=(cid,uid)=>{updC(cid,c=>({...c,joinRequests:c.joinRequests.filter(r=>r.userId!==uid)}));toast2("Rejected");};
  const requestJoin=(cid)=>{
    updC(cid,c=>c.joinRequests.some(r=>r.userId===me.id)?c:({...c,joinRequests:[...c.joinRequests,{userId:me.id,requestedAt:today}]}));
    toast2("Request sent ✓");
    const c=comms.find(c=>c.id===cid);
    logAudit("member.requestJoin", `${me.nickname} requested to join "${c?.name||cid}"`, "community", cid);
  };
  const promoteM=(cid,uid)=>{updC(cid,c=>({...c,members:c.members.map(m=>m.userId===uid?{...m,role:"admin"}:m)}));toast2("Promoted ✓");
    const c=comms.find(c=>c.id===cid),u=users.find(u=>u.id===uid);
    logAudit("member.promote", `${me.nickname} promoted ${u?.nickname||uid} to admin in ${c?.name||cid}`, "community", cid);
  };
  // The missing counterpart to promoteM — an admin could be promoted to admin, but there was
  // no way back to a regular member short of removing them from the community outright. Keeps
  // their existing status (regular/casual/etc) untouched, same as promoteM never touches it.
  const demoteM=(cid,uid)=>{updC(cid,c=>({...c,members:c.members.map(m=>m.userId===uid?{...m,role:"member"}:m)}));toast2("Demoted to member ✓");
    const c=comms.find(c=>c.id===cid),u=users.find(u=>u.id===uid);
    logAudit("member.demote", `${me.nickname} demoted ${u?.nickname||uid} from admin in ${c?.name||cid}`, "community", cid);
  };
  const kickM=(cid,uid)=>{updC(cid,c=>({...c,members:c.members.filter(m=>m.userId!==uid)}));toast2("Removed");
    const c=comms.find(c=>c.id===cid),u=users.find(u=>u.id===uid);
    logAudit("member.remove", `${me.nickname} removed ${u?.nickname||uid} from ${c?.name||cid}`, "community", cid);
  };
  // Covers the "original owner disappeared/quit/is gone" case — either the owner steps down
  // themselves, or (if they truly can't be reached) the Platform Admin does it for them.
  // Single-owner model: the previous owner becomes a regular admin, never removed outright.
  const transferOwnership=(cid,newOwnerId)=>{
    updC(cid,c=>({...c,members:c.members.map(m=>
      m.userId===newOwnerId?{...m,role:"owner"}:
      m.role==="owner"?{...m,role:"admin"}:m
    )}));
    toast2("Ownership transferred ✓");
    const c=comms.find(c=>c.id===cid),u=users.find(u=>u.id===newOwnerId);
    logAudit("member.transferOwnership", `${me.nickname} made ${u?.nickname||newOwnerId} owner of ${c?.name||cid}`, "community", cid);
  };
  const toggleMemberStatus=(cid,uid)=>{
    let newStatus=null;
    updC(cid,c=>({...c,members:c.members.map(m=>{if(m.userId!==uid)return m;newStatus=m.status==="regular"?"casual":"regular";return{...m,status:newStatus};})}));
    toast2("Status updated ✓");
    const c=comms.find(c=>c.id===cid),u=users.find(u=>u.id===uid);
    logAudit("member.statusChange", `${me.nickname} set ${u?.nickname||uid} to ${newStatus} in ${c?.name||cid}`, "community", cid);
  };
  const inviteUser=(cid,uid)=>{const u=users.find(u=>u.id===uid);updC(cid,c=>({...c,members:[...c.members,{userId:uid,role:"member",status:initialMemberStatus(c),since:today}]}));toast2(`${u?.nickname} added ✓`);
    const c=comms.find(c=>c.id===cid);
    logAudit("member.join", `${me.nickname} added ${u?.nickname||uid} to "${c?.name||cid}"`, "community", cid);
  };
  // A community invite targeted at a specific person joins them immediately, no approval
  // queue — same reasoning as claimViaInvite: the admin picking exactly this person to send
  // the link to already is the approval. An un-targeted community link (shared publicly)
  // still goes through the normal requestJoin/approve flow, see Effect B.
  const joinCommunityViaInvite=(cid,uid)=>{
    const alreadyMember = comms.find(c=>c.id===cid)?.members.some(m=>m.userId===uid);
    updC(cid,c=>c.members.some(m=>m.userId===uid)?c:({...c,members:[...c.members,{userId:uid,role:"member",status:initialMemberStatus(c),since:today}]}));
    if (!alreadyMember) {
      const c=comms.find(c=>c.id===cid),u=users.find(u=>u.id===uid);
      logAudit("member.join", `${u?.nickname||uid} joined "${c?.name||cid}" via invite link`, "community", cid);
    }
  };
  // Custom community banner photo — replaces the default sport-gradient watermark banner with
  // an admin-uploaded photo. Just a single field on the community record; removing it (setting
  // back to null) is what restores the default gradient look, no separate "reset" state needed.
  const setCommunityBanner = (cid, url) => {
    updC(cid, c=>({...c, bannerURL:url}));
    toast2("Banner updated ✓");
    logAudit("community.setBanner", `${me.nickname} set a custom banner photo for "${comms.find(c=>c.id===cid)?.name||cid}"`, "community", cid);
  };
  const removeCommunityBanner = (cid) => {
    updC(cid, c=>({...c, bannerURL:null}));
    toast2("Banner reset to default ✓");
    logAudit("community.setBanner", `${me.nickname} removed the custom banner photo for "${comms.find(c=>c.id===cid)?.name||cid}" — back to default`, "community", cid);
  };
  // Community-wide broadcast (Enhancement #18, part 1) — a persistent, scrollable list per
  // community (not just a fire-and-forget push), so it can stand in for a WhatsApp group's
  // message history. Every member gets a push + inbox notification when one is posted.
  const postAnnouncement = (cid, message) => {
    const trimmed = (message||"").trim();
    if (!trimmed) return;
    const c = comms.find(c=>c.id===cid);
    const entry = {id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`, authorId:me.id, authorName:me.nickname, message:trimmed, createdAt:new Date().toISOString()};
    updC(cid, c=>({...c, announcements:[...(c.announcements||[]), entry]}));
    toast2("Announcement posted ✓");
    const recipientIds = (c?.members||[]).map(m=>m.userId).filter(uid=>uid!==me.id);
    if (recipientIds.length) notify(recipientIds, "announcement", {communityId:cid}, `📢 ${c?.name||"Community"}`, trimmed);
    logAudit("community.announce", `${me.nickname} posted an announcement in "${c?.name||cid}"`, "community", cid);
  };
  const deleteAnnouncement = (cid, aid) => {
    updC(cid, c=>({...c, announcements:(c.announcements||[]).filter(a=>a.id!==aid)}));
    toast2("Removed");
  };
  // Open to anyone who can see the announcement, not just admins — closest to a real thread.
  // Notifies whoever's already IN the thread (the original poster + everyone who's replied so
  // far), never the replier themselves.
  const postAnnouncementReply = (cid, aid, message) => {
    const trimmed = (message||"").trim();
    if (!trimmed) return;
    const c = comms.find(c=>c.id===cid);
    const ann = c?.announcements?.find(a=>a.id===aid);
    if (!ann) return;
    const reply = {id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`, authorId:me.id, authorName:me.nickname, message:trimmed, createdAt:new Date().toISOString()};
    updC(cid, c=>({...c, announcements:(c.announcements||[]).map(a=>a.id!==aid?a:{...a, replies:[...(a.replies||[]), reply]})}));
    const threadIds = new Set([ann.authorId, ...(ann.replies||[]).map(r=>r.authorId)]);
    threadIds.delete(me.id);
    if (threadIds.size) notify([...threadIds], "announcementReply", {communityId:cid}, `💬 ${c?.name||"Community"}`, `${me.nickname}: ${trimmed}`);
    logAudit("community.announce", `${me.nickname} replied to an announcement in "${c?.name||cid}"`, "community", cid);
  };
  const deleteAnnouncementReply = (cid, aid, rid) => {
    updC(cid, c=>({...c, announcements:(c.announcements||[]).map(a=>a.id!==aid?a:{...a, replies:(a.replies||[]).filter(r=>r.id!==rid)})}));
    toast2("Removed");
  };
  // Event-scoped broadcast — same idea, but only reaches that event's registered players
  // (whoever can admin the event, including an event-scoped admin, not just community admins).
  const postEventAnnouncement = (cid, eid, message) => {
    const trimmed = (message||"").trim();
    if (!trimmed) return;
    const ev = getEv(cid,eid);
    const entry = {id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`, authorId:me.id, authorName:me.nickname, message:trimmed, createdAt:new Date().toISOString()};
    updC(cid, c=>({...c, events:c.events.map(e=>e.id!==eid?e:{...e, announcements:[...(e.announcements||[]), entry]})}));
    toast2("Announcement posted ✓");
    const recipientIds = (ev?.registrations||[]).map(r=>r.userId).filter(uid=>uid!==me.id);
    if (recipientIds.length) notify(recipientIds, "eventAnnouncement", ev, `📢 ${ev?.name||"Event"}`, trimmed);
    logAudit("event.announce", `${me.nickname} posted an announcement in "${ev?.name||eid}"`, "event", eid);
  };
  const deleteEventAnnouncement = (cid, eid, aid) => {
    updC(cid, c=>({...c, events:c.events.map(e=>e.id!==eid?e:{...e, announcements:(e.announcements||[]).filter(a=>a.id!==aid)})}));
    toast2("Removed");
  };
  const postEventAnnouncementReply = (cid, eid, aid, message) => {
    const trimmed = (message||"").trim();
    if (!trimmed) return;
    const ev = getEv(cid,eid);
    const ann = ev?.announcements?.find(a=>a.id===aid);
    if (!ann) return;
    const reply = {id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`, authorId:me.id, authorName:me.nickname, message:trimmed, createdAt:new Date().toISOString()};
    updC(cid, c=>({...c, events:c.events.map(e=>e.id!==eid?e:{...e, announcements:(e.announcements||[]).map(a=>a.id!==aid?a:{...a, replies:[...(a.replies||[]), reply]})})}));
    const threadIds = new Set([ann.authorId, ...(ann.replies||[]).map(r=>r.authorId)]);
    threadIds.delete(me.id);
    if (threadIds.size) notify([...threadIds], "eventAnnouncementReply", ev, `💬 ${ev?.name||"Event"}`, `${me.nickname}: ${trimmed}`);
    logAudit("event.announce", `${me.nickname} replied to an announcement in "${ev?.name||eid}"`, "event", eid);
  };
  const deleteEventAnnouncementReply = (cid, eid, aid, rid) => {
    updC(cid, c=>({...c, events:c.events.map(e=>e.id!==eid?e:{...e, announcements:(e.announcements||[]).map(a=>a.id!==aid?a:{...a, replies:(a.replies||[]).filter(r=>r.id!==rid)})})}));
    toast2("Removed");
  };

  // Venue
  // pricePerHour/extraFee (and their football counterparts) come in as strings from the form's
  // number inputs (Inp always passes e.target.value) — parse them here so downstream cost math
  // (which uses +, not just *) doesn't silently concatenate instead of adding.
  const saveVenue=(d,editId=null)=>{
    const courts=d.courtNames.filter(Boolean).map(n=>({name:n}));
    const pitches=d.pitchNames.filter(Boolean).map(n=>({name:n}));
    const numericD={...d,pricePerHour:parseFloat(d.pricePerHour)||0,extraFee:parseFloat(d.extraFee)||0,pricePerHourFootball:d.pricePerHourFootball?parseFloat(d.pricePerHourFootball)||0:null,extraFeeFootball:d.extraFeeFootball?parseFloat(d.extraFeeFootball)||0:null};
    if(editId){setVenues(vs=>vs.map(v=>v.id===editId?{...v,...numericD,courts,pitches,status:"pending_edit"}:v));toast2("Saved · Pending review");}else{const id=_vid++;setVenues(vs=>[...vs,{id,...numericD,courts,pitches,status:"pending"}]);toast2("Added · Pending review");}go("list");};

  // Event
  const scheduleEventReminders = async (cid, eid, date, time) => {
    if (!date || !time) return;
    const startMs = new Date(`${date}T${time}`).getTime();
    if (isNaN(startMs)) return;
    const now = Date.now();
    const offsets = [{type:"24h", ms:24*3600000}, {type:"3h", ms:3*3600000}, {type:"1h", ms:1*3600000}, {type:"2m", ms:2*60000, audience:"admins"}];
    const entries = offsets
      .map(o => ({id:`${eid}-${o.type}`, eventId:eid, communityId:cid, reminderType:o.type, audience:o.audience||"registrants", firesAt:new Date(startMs-o.ms).toISOString(), sent:false}))
      .filter(e => new Date(e.firesAt).getTime() > now); // skip reminders whose moment has already passed
    if (entries.length === 0) return;
    try {
      const ref = doc(db,"padelos","eventReminderSchedule");
      const snap = await getDoc(ref);
      const existing = snap.exists() ? JSON.parse(snap.data().value||"[]") : [];
      const filtered = existing.filter(x=>x.eventId!==eid); // drop this event's old schedule (re-edit replaces it)
      await setDoc(ref, {value: JSON.stringify([...filtered, ...entries])});
    } catch(e) { console.log("eventReminderSchedule write failed", e); }
  };
  const createEvent=(cid,d)=>{
    const id=_eid++;const v=venues.find(x=>x.id===parseInt(d.venueId));
    const isFootballEv=d.sport==="Football";
    // Football has no "courts" picker — courts is derived from how many pitches were selected,
    // so every existing courts-count-based calc (cost, min/max fallback, CT court math)
    // keeps working unchanged for football too, without needing its own parallel code path.
    const courtsCount=isFootballEv?Math.max(1,(d.pitchNames||[]).length):(parseInt(d.courts)||2);
    const footballTeamSize=isFootballEv?(parseInt(d.teamSize)||5):undefined;
    const footballNumTeams=isFootballEv?(parseInt(d.numTeams)||3):undefined;
    // Football's cap is derived (team size × number of teams), not typed in directly — see
    // EventForm/EventEditForm, which hide the manual Max Players field for football entirely.
    // Padel's cap is also derived, not typed in — courts×5 is the real default max (courts×6
    // is only an exception ceiling for unusual manual cases, not the standard cap — changed
    // 2026-08-18 per admin direction), applied uniformly across Open Day/Closed
    // Individuals/Closed Teams. If this lands on an odd number for Closed Teams, the existing
    // single-leftover-waitlist mechanism (plan.waitlisted) already handles the odd player out.
    const derivedMaxPlayers=isFootballEv?(footballTeamSize*footballNumTeams||null):(courtsCount*5||null);
    // rotationMin isn't a form field anymore — round/match duration belongs to the actual
    // round/team generator (its own picker, e.g. CI's "Round duration" or CT's "Match duration"
    // at generation time), not the event create/edit form. This is just the seed default those
    // pickers start from before the admin generates anything.
    const ev={id,communityId:cid,name:d.name,description:d.description||"",sport:d.sport||DEFAULT_SPORT,createdBy:me.id,date:d.date,time:d.time,timeTo:d.timeTo||"",venueId:parseInt(d.venueId),courts:courtsCount,type:d.pollMode?null:d.eventType,visibility:d.visibility||"public",status:"registration_open",regOpenAt:new Date().toISOString(),regularUntil:new Date(Date.now()+24*3600000).toISOString(),poll:d.pollMode?{votes:{},resolved:false}:null,registrations:[],checkedIn:[],rotationMin:20,costPerCourt:getVenuePricing(v,d.sport).pricePerHour,extraFee:getVenuePricing(v,d.sport).extraFee,plan:null,reservedCourts:isFootballEv?courtsCount:(v?.courts.length||2),maxPlayers:derivedMaxPlayers,pitches:isFootballEv?(d.pitchNames||[]):undefined,teamSize:footballTeamSize,numTeams:footballNumTeams};
    updC(cid,c=>({...c,events:[...c.events,ev]}));toast2("Event created ✓");go("event",{cid,eid:id});
    scheduleEventReminders(cid, id, ev.date, ev.time);
    const comm = comms.find(c=>c.id===cid);
    if (me.id!==1) notify([1], "new_event_platform", ev, "🎾 New event created", `${me.nickname} created "${ev.name}" in ${comm?.name||"a community"}`);
    logAudit("event.create", `${me.nickname} created event "${ev.name}" in ${comm?.name||cid}`, "event", id);
    if (!d.pollMode && ev.type && ev.visibility!=="private") {
      const recipients = (comm?.members||[]).filter(m=>m.userId!==me.id).map(m=>m.userId);
      notify(recipients, "reg_open", ev, `🎾 New event: ${ev.name}`, `Registration is open — ${fmtD(ev.date)}`);
    }
  };
  const editEvent=(cid,eid,d)=>{
    const before = getEv(cid,eid);
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,...d})}));toast2("Event updated ✓");goBack();
    logAudit("event.edit", `${me.nickname} edited event "${before?.name||eid}"`, "event", eid);
    if (before) {
      const changed = [];
      if (d.date!==undefined && d.date!==before.date) changed.push("date");
      if (d.time!==undefined && d.time!==before.time) changed.push("time");
      if (d.timeTo!==undefined && d.timeTo!==before.timeTo) changed.push("time");
      if (d.venueId!==undefined && parseInt(d.venueId)!==before.venueId) changed.push("venue");
      if (d.courts!==undefined && parseInt(d.courts)!==before.courts) changed.push("courts");
      if (changed.includes("date")||changed.includes("time")) {
        scheduleEventReminders(cid, eid, d.date??before.date, d.time??before.time);
      }
      if (changed.length>0) {
        const uniqChanged = [...new Set(changed)];
        const recipients = before.registrations.map(r=>r.userId).filter(uid=>uid!==me.id);
        notify(recipients, "event_updated", before, `✏️ ${before.name} updated`, `Changed: ${uniqChanged.join(", ")} — check the event for details.`);
      }
    }
  };
  const duplicateEvent=(cid,eid,newDate,keepPlayers,newTime,newTimeTo,newName)=>{
    const ev=getEv(cid,eid);if(!ev){toast2("Event not found","err");return;}
    const id=_eid++;
    const v=venues.find(x=>x.id===ev.venueId);
    const validUserIds = new Set(users.map(u=>u.id));
    const liveRegs = ev.registrations.filter(r=>validUserIds.has(r.userId));
    const droppedCount = ev.registrations.length - liveRegs.length;
    const dupNote = `Duplicated from #${eid} "${ev.name}"`;
    const copy={
      // ── Header — carried over from the original event ──
      id, communityId:cid,
      name:newName&&newName.trim()?newName.trim():ev.name,
      description: ev.description ? `${ev.description}\n${dupNote}` : dupNote,
      createdBy:ev.createdBy,
      date:newDate,
      time:newTime||ev.time,
      timeTo:newTimeTo||ev.timeTo,
      venueId:ev.venueId,
      sport:ev.sport,
      courts:ev.courts,
      type:ev.type,
      rotationMin:ev.rotationMin,
      reservedCourts:ev.reservedCourts,
      costPerCourt:getVenuePricing(v,ev.sport).pricePerHour, // re-derived from the venue, not copied from the old event
      extraFee:getVenuePricing(v,ev.sport).extraFee,
      maxPlayers:ev.maxPlayers??null,
      pitches:ev.pitches,
      teamSize:ev.teamSize,
      numTeams:ev.numTeams,
      // ── Everything else — every other tab starts completely fresh ──
      status:"registration_open",
      closedAt:null,
      regOpenAt:new Date().toISOString(),
      regularUntil:new Date(Date.now()+24*3600000).toISOString(),
      poll:ev.poll?{votes:{},resolved:false}:null,
      registrations: keepPlayers
        ? liveRegs.map(r=>({...r, registeredAt:new Date().toISOString(), eventUsr:null}))
        : [],
      checkedIn: keepPlayers ? liveRegs.map(r=>r.userId) : [],
      plan:null,
      exempted:[],
      paidIds:[],
      settlementPayerId:null,
      extraExpenses:0,
    };
    updC(cid,c=>({...c,events:[...c.events,copy]}));
    if(keepPlayers&&droppedCount>0){
      toast2(`Event duplicated — ${droppedCount} stale player(s) skipped`,"err");
    }else{
      toast2(keepPlayers?"Event duplicated with players ✓":"Event duplicated ✓");
    }
    go("event",{cid,eid:id});
  };
  // Soft-delete only (BUGS.md incident: an event vanished with zero audit trail, no way to tell
  // who did it or recover it). "Deleted" now means: stays in the database forever, invisible to
  // everyone except Platform Admin (Platform Admin -> Deleted Events), and every deletion is
  // always audit-logged with who did it. This is deliberately NOT the same thing as Archive —
  // archived events are still visible to the community (Archived section); deleted ones are not,
  // for anyone but the platform owner.
  const deleteEvent=(cid,eid)=>{
    const ev=getEv(cid,eid);
    if(!ev){toast2("Event not found (id "+eid+")","err");return;}
    if(!(ev.createdBy===me.id||(me.id===1&&godMode))){toast2("Only this event's creator (or the platform admin) can delete it","err");return;}
    if(ev.status==="completed"){toast2("Cannot delete a completed event — use Archive instead","err");return;}
    updC(cid,c=>({...c,events:c.events.map(e=>e.id!==eid?e:{...e,deleted:true,deletedAt:new Date().toISOString(),deletedBy:me.id,deletedByName:me.nickname})}));
    toast2("Event deleted (id "+eid+")");
    logAudit("event.delete", `${me.nickname} deleted event "${ev.name}"`, "event", eid);
    goBack();
  };
  const restoreDeletedEvent=(cid,eid)=>{
    const ev=getEv(cid,eid);
    updC(cid,c=>({...c,events:c.events.map(e=>e.id!==eid?e:{...e,deleted:false,deletedAt:null,deletedBy:null,deletedByName:null})}));
    toast2("Event restored ✓");
    logAudit("event.restore", `${me.nickname} restored deleted event "${ev?.name||eid}"`, "event", eid);
  };
  const archiveEvent=(cid,eid)=>{
    console.log("[archiveEvent] called with", {cid, eid});
    const ev=getEv(cid,eid);
    console.log("[archiveEvent] found event:", ev);
    if(!ev){toast2("Event not found (id "+eid+")","err");return;}
    if(!(ev.createdBy===me.id||(me.id===1&&godMode))){toast2("Only this event's creator (or the platform admin) can archive it","err");return;}
    updC(cid,c=>{
      const updated={...c,events:c.events.map(e=>e.id!==eid?e:{...e,archived:true,archivedAt:new Date().toISOString()})};
      console.log("[archiveEvent] updated events:", updated.events.find(e=>e.id===eid));
      return updated;
    });
    toast2("Event archived (id "+eid+")");
    logAudit("event.archive", `${me.nickname} archived event "${ev.name}"`, "event", eid);
    goBack();
  };
  const unarchiveEvent=(cid,eid)=>{
    console.log("[unarchiveEvent] called with", {cid, eid});
    updC(cid,c=>({...c,events:c.events.map(e=>e.id!==eid?e:{...e,archived:false,archivedAt:null})}));
    toast2("Event restored");
    const ev=getEv(cid,eid);
    logAudit("event.unarchive", `${me.nickname} unarchived event "${ev?.name||eid}"`, "event", eid);
  };
  // Bulk versions for the Events list "Select" mode — unlike the single-event
  // archiveEvent/deleteEvent above, these don't navigate away (the caller stays
  // on the list) and can span multiple communities in one selection.
  const bulkArchiveEvents=(items)=>{ // items: [{cid,eid}]
    const byCid={}; items.forEach(({cid,eid})=>{(byCid[cid]=byCid[cid]||new Set()).add(eid);});
    const names=items.map(({cid,eid})=>getEv(cid,eid)?.name).filter(Boolean);
    setComms(cs=>cs.map(c=>{
      const eids=byCid[c.id]; if(!eids) return c;
      return {...c,events:c.events.map(e=>eids.has(e.id)?{...e,archived:true,archivedAt:new Date().toISOString()}:e)};
    }));
    toast2(`${items.length} event(s) archived ✓`);
    logAudit("event.bulkArchive", `${me.nickname} archived ${items.length} event(s): ${names.slice(0,5).join(", ")}${names.length>5?` and ${names.length-5} more`:""}`, null, null);
  };
  // Soft-delete only — same reasoning as deleteEvent above. Bulk actions previously logged
  // NOTHING to the audit trail at all (a real incident: an event vanished with zero record of
  // who did it), unlike the single-event action which always has.
  const bulkDeleteEvents=(items)=>{ // items: [{cid,eid}] — completed events are skipped, same rule as single deleteEvent
    if(me.id!==1){toast2("Only the platform admin can bulk-delete events","err");return;}
    const byCid={}; items.forEach(({cid,eid})=>{(byCid[cid]=byCid[cid]||new Set()).add(eid);});
    let deletedCount=0, skippedCount=0; const deletedNames=[];
    setComms(cs=>cs.map(c=>{
      const eids=byCid[c.id]; if(!eids) return c;
      return {...c,events:c.events.map(e=>{
        if(!eids.has(e.id)) return e;
        if(e.status==="completed"){ skippedCount++; return e; }
        deletedCount++; deletedNames.push(e.name);
        return {...e,deleted:true,deletedAt:new Date().toISOString(),deletedBy:me.id,deletedByName:me.nickname};
      })};
    }));
    toast2(skippedCount>0?`${deletedCount} event(s) deleted · ${skippedCount} completed event(s) skipped (use Archive instead)`:`${deletedCount} event(s) deleted ✓`);
    if(deletedCount>0) logAudit("event.bulkDelete", `${me.nickname} deleted ${deletedCount} event(s): ${deletedNames.slice(0,5).join(", ")}${deletedNames.length>5?` and ${deletedNames.length-5} more`:""}`, null, null);
  };
  const closeEvent=(cid,eid,scoringMethod="standard")=>{
    const ev=getEv(cid,eid);
    if(!ev){toast2("Event not found","err");return;}

    // ── CI: Calculate PES → update USR ───────────────
    if(ev.type==="closed_ind"&&ev.plan){
      const plan=ev.plan;
      const stands=calcCIStandings(plan,users);
      // X-System: Platform-Admin-only choice at close time (see PLAN). Standard path below is
      // untouched — only the final `pes` value picked is affected.
      const xPreview = scoringMethod==="new" ? calcXCIPreview(plan, users, comms, ev) : null;
      setUsers(us=>us.map(u=>{
        const s=stands.find(s=>s.user.id===u.id);
        if(!s)return u;
        const maxPts=personalMaxCI(s.breaks,personalRoundsCI(u.id,plan),plan.courts);
        if(maxPts<=0)return u;
        const standardPes=Math.round((s.pts/maxPts)*100*10)/10;
        const xEntry=xPreview?.find(x=>x.userId===u.id);
        const pes=xEntry?xEntry.outputPES:standardPes;
        const hist=[...(u.usrHistory||[]), {eventId:eid, eventName:ev.name, date:ev.date, pes, type:"ci", retired:(ev.retiredIds||[]).includes(u.id)}];
        const seedUsr = u.seedUsr ?? u.usr;
        const newUsr = calcWeightedUSR(hist, seedUsr, usrWindowSize);
        return {...u, usr:newUsr, usrHistory:hist, seedUsr: u.seedUsr ?? u.usr};
      }));
    }

    // ── CT: Calculate TES → update TR per combination ─
    if(ev.type==="closed_teams"&&ev.plan){
      const plan=ev.plan;
      const stands=calcCTStandings(plan);
      const format=plan.format;
      // X-System: Platform-Admin-only choice at close time, Ladder only (League never eligible —
      // see PLAN). Standard path below is untouched — only the final teamTES[...] value is affected.
      const xPreview = (scoringMethod==="new"&&format==="ladder") ? calcXCTLadderPreview(plan, users, comms, ev) : null;

      // Calculate TES for each team
      const teamTES = {};
      stands.forEach(s=>{
        let tes=0;
        if(format==="ladder"){
          // Use per-team max pts (team-specific, accounts for which rounds they were on break)
          const maxPts=ctTeamMaxPts(s.team?.id,plan);
          tes=maxPts>0?Math.round((s.pts/maxPts)*100*10)/10:0;
        } else {
          // League: wins ÷ total matches played × 100
          const totalMatches=(s.wins||0)+(s.losses||0);
          tes=totalMatches>0?Math.round(((s.wins||0)/totalMatches)*100*10)/10:0;
        }
        const xEntry=xPreview?.find(x=>x.teamId===s.team?.id);
        teamTES[s.team?.id]=xEntry?xEntry.outputTES:tes;
      });

      // Update teamsHistory for each player in each team
      setUsers(us=>us.map(u=>{
        const team=plan.teams?.find(t=>t.players?.some(p=>p.userId===u.id));
        if(!team)return u;
        const tes=teamTES[team.id]??0;
        const partners=team.players.filter(p=>p.userId!==u.id);
        if(partners.length===0)return u;
        const partner=partners[0]; // CT always has exactly 2 players per team

        // Combination key = sorted pair of userIds (order-independent)
        const comboKey=[u.id,partner.userId].sort().join("_");
        const prevHistory=(u.teamsHistory||[]);
        const comboHistory=prevHistory.filter(h=>h.comboKey===comboKey);

        // Seed TR = average of both players' current USR
        const partnerUser=us.find(pu=>pu.id===partner.userId);
        const seedTr=Math.round(((u.usr||50)+(partnerUser?.usr||50))/2);

        // Calculate new TR using same seed-padded rolling average as USR
        const newEntry={comboKey,partnerId:partner.userId,partnerName:partner.nickname,
          eventId:eid,eventName:ev.name,date:ev.date,format,tes,retired:(ev.retiredIds||[]).includes(u.id)};
        const comboHist=[...comboHistory,newEntry];
        // Retired events stay in teamsHistory (below) for visibility but never move TR — same
        // rule as calcWeightedUSR, just filtered locally since TR's rolling average isn't
        // computed through that shared function.
        const ratedHist=comboHist.filter(h=>!h.retired);
        const padded=ratedHist.length<5
          ?[...Array(5-ratedHist.length).fill({tes:seedTr}),...ratedHist]
          :ratedHist.slice(-5);
        const newTr=Math.round(padded.reduce((sum,h)=>sum+h.tes,0)/padded.length);
        newEntry.tr=newTr;

        // Also add TES to usrHistory with weight 0.5 → affects USR
        const seedUsr = u.seedUsr ?? u.usr;
        const usrHist=[...(u.usrHistory||[]), {eventId:eid, eventName:ev.name, date:ev.date, pes:tes, type:"ct", retired:(ev.retiredIds||[]).includes(u.id)}];
        const newUsr = calcWeightedUSR(usrHist, seedUsr, usrWindowSize);

        const otherHistory=prevHistory.filter(h=>h.comboKey!==comboKey);
        return {...u, usr:newUsr, usrHistory:usrHist, seedUsr, teamsHistory:[...otherHistory,...comboHist]};
      }));
    }

    updC(cid,c=>{
      const updatedEvents = c.events.map(e=>e.id!==eid?e:{...e,status:"completed",closedAt:new Date().toISOString()});
      const promoteAfter = c.promoteAfter||3, demoteAfter = c.demoteAfter||4;
      const completedEvs = updatedEvents.filter(e=>e.status==="completed").sort((a,b)=>new Date(a.date)-new Date(b.date));
      const updatedMembers = c.members.map(m=>{
        if(m.role!=="member") return m; // owners/admins aren't auto-managed this way
        // A private event this member was never invited to (not registered in it) shouldn't
        // count as a "miss" for them — they had no way to attend. Public events always count;
        // private events only count when the member actually has a registration in them.
        const eligibleEvs = completedEvs.filter(e=>e.visibility!=="private"||e.registrations.some(r=>r.userId===m.userId));
        if(eligibleEvs.length===0) return m;
        const latestAttended = eligibleEvs[eligibleEvs.length-1].registrations.some(r=>r.userId===m.userId);
        let streak=0;
        for(let i=eligibleEvs.length-1;i>=0;i--){
          const wasReg = eligibleEvs[i].registrations.some(r=>r.userId===m.userId);
          if(wasReg===latestAttended) streak++; else break;
        }
        if(latestAttended && streak>=promoteAfter && m.status==="casual") return {...m,status:"regular"};
        if(!latestAttended && streak>=demoteAfter && m.status==="regular") return {...m,status:"casual"};
        return m;
      });
      return {...c, events:updatedEvents, members:updatedMembers};
    });
    toast2("Event closed ✓ — ratings updated");
    logAudit("event.close", `${me.nickname} closed event "${ev.name}"${scoringMethod==="new"?" (Output PES scoring)":""}`, "event", eid);
  };
  // willLandWaitlisted: computed BEFORE the mutation, by simulating the new registration
  // appended and running it through the same tier-aware splitRegsByCapacity real registrations
  // use — so someone who'd be waitlisted purely for being non-priority during the registration
  // window (see splitRegsByCapacity) predicts correctly too, not just plain capacity overflow.
  const willLandWaitlisted = (ev, uid, comm, addedBy=null) => {
    const max = getMaxPlayers(ev);
    if (!ev || max==null || ev.registrations.some(r=>r.userId===uid)) return {waitlisted:false, pos:0};
    const simEv = {...ev, registrations:[...ev.registrations, {userId:uid, addedBy, registeredAt:new Date().toISOString()}]};
    const {waitlisted} = splitRegsByCapacity(simEv, comm);
    const onIt = waitlisted.some(r=>r.userId===uid);
    return {waitlisted:onIt, pos:onIt?waitlisted.length:0};
  };
  const registerEv=(cid,eid)=>{
    const ev=getEv(cid,eid);
    // The "I'm In" button already hides itself once an event is completed/cancelled, but that's
    // UI-only — nothing at the write layer stopped a registration from landing on an already-
    // closed event through any OTHER path (an invite link doesn't go through this button at
    // all). Guard it here too, not just at every call site.
    if(!ev||ev.status==="completed"||ev.status==="cancelled"){toast2("This event is closed — registration is no longer open","err");return;}
    const comm = comms.find(c=>c.id===cid);
    const {waitlisted, pos:waitPos} = willLandWaitlisted(ev, me.id, comm, null);
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.registrations.find(r=>r.userId===me.id)?ev:{...ev,registrations:[...ev.registrations,{userId:me.id,registeredAt:new Date().toISOString(),status:"registered",addedBy:null,isGuest:false}]})}));
    if (waitlisted) {
      toast2(`You're #${waitPos} on the waitlist`);
      if (ev) notify([me.id], "waitlisted", ev, `⏳ You're #${waitPos} on the waitlist for ${ev.name}`, "We'll notify you if a spot opens up.");
    } else {
      toast2("Registered ✓");
      if (ev) notify([me.id], "registered", ev, `✓ You're in for ${ev.name}`, `${fmtD(ev.date)}${ev.time?` · ${fmtT(ev.time)}`:""}`);
    }
    // Let the event's creator + community admins know someone registered themselves — the
    // admin-driven paths (addMember, registerViaInvite, approveEventJoin) don't need this,
    // since the admin already knows because they're the one who took the action.
    if (ev) {
      const adminIds = (comm?.members||[]).filter(m=>(m.role==="owner"||m.role==="admin")&&m.userId!==me.id).map(m=>m.userId);
      const recipients = [...adminIds, ev.createdBy].filter(uid=>uid!=null&&uid!==me.id);
      notify(recipients, "eventRegistration", ev, waitlisted?"⏳ New waitlist signup":"🎾 New registration", `${me.nickname} ${waitlisted?"joined the waitlist for":"just registered for"} ${ev.name}`);
    }
    logAudit("event.register", `${me.nickname} registered for "${ev?.name||eid}"${waitlisted?" (waitlisted)":""}`, "event", eid);
  };
  const addMember=(cid,eid,uid)=>{
    const ev=getEv(cid,eid);
    if(!ev||ev.status==="completed"||ev.status==="cancelled"){toast2("This event is closed — can't add players anymore","err");return;}
    const comm = comms.find(c=>c.id===cid);
    const u=users.find(u=>u.id===uid);
    const {waitlisted} = willLandWaitlisted(ev, uid, comm, "admin");
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.registrations.find(r=>r.userId===uid)?ev:{...ev,registrations:[...ev.registrations,{userId:uid,registeredAt:new Date().toISOString(),status:"registered",addedBy:"admin",isGuest:false}]})}));
    toast2(`${u?.nickname} added${waitlisted?" — waitlisted (event full)":""} ✓`);
    if (ev) notify([uid], waitlisted?"waitlisted":"registered", ev, waitlisted?`⏳ You're on the waitlist for ${ev.name}`:`✓ You're in for ${ev.name}`, waitlisted?"We'll notify you if a spot opens up.":`${fmtD(ev.date)}${ev.time?` · ${fmtT(ev.time)}`:""} — added by an admin`);
    logAudit("event.register", `${me.nickname} added ${u?.nickname||uid} to "${ev?.name||eid}"${waitlisted?" (waitlisted)":""}`, "event", eid);
  };
  // An invite link is deliberate access granted by an admin — it skips the regular-member
  // priority window entirely (that gate exists to stop random public sign-ups from queue-
  // jumping, not someone the admin specifically invited). It also leaves a guest-tier
  // footprint at the community level if the invitee wasn't already a member of any status —
  // a name that exists for reference with no extra visibility, upgradeable later via the
  // existing "Make Member" action, rather than a total stranger with zero community trace.
  const registerViaInvite=(cid,eid,uid)=>{
    const ev=getEv(cid,eid);
    // Confirmed live: someone opened a stale invite link the day AFTER the event had already
    // been closed (event #50) — this path had no status check at all, so it silently added a
    // registration to a completed event with no round/match to ever put them in. The link
    // itself has no way to know it's stale, so the check has to live here.
    if(!ev||ev.status==="completed"||ev.status==="cancelled"){toast2("This event has already ended — the invite link is no longer valid","err");return;}
    const comm = comms.find(c=>c.id===cid);
    const u=users.find(u=>u.id===uid);
    const {waitlisted} = willLandWaitlisted(ev, uid, comm, "invite");
    updC(cid,c=>({...c,
      members:c.members.some(m=>m.userId===uid)?c.members:[...c.members,{userId:uid,role:"member",status:"guest",since:today}],
      events:c.events.map(ev=>ev.id!==eid||ev.registrations.find(r=>r.userId===uid)?ev:{...ev,registrations:[...ev.registrations,{userId:uid,registeredAt:new Date().toISOString(),status:"registered",addedBy:"invite",isGuest:false}]})}));
    if (ev) notify([uid], waitlisted?"waitlisted":"registered", ev, waitlisted?`⏳ You're on the waitlist for ${ev.name}`:`✓ You're in for ${ev.name}`, waitlisted?"We'll notify you if a spot opens up.":`${fmtD(ev.date)}${ev.time?` · ${fmtT(ev.time)}`:""} — via invite link`);
    logAudit("event.register", `${u?.nickname||uid} joined "${ev?.name||eid}" via invite link${waitlisted?" (waitlisted)":""}`, "event", eid);
  };
  // Event-level join requests — same shape as community joinRequests, but scoped to one
  // event: anyone who finds the event (not just invited, not just regular members) can ask
  // to be let in even while the priority window is active; an admin has to approve it rather
  // than the button just being hidden with no way to ask at all.
  const requestEventJoin=(cid,eid)=>{
    const ev=getEv(cid,eid);
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:(ev.joinRequests||[]).some(r=>r.userId===me.id)?ev:{...ev,joinRequests:[...(ev.joinRequests||[]),{userId:me.id,requestedAt:new Date().toISOString()}]})}));
    toast2("Request sent ✓");
    if (ev) notify([ev.createdBy].filter(Boolean), "eventJoinRequest", ev, "🙋 New request to join", `${me.nickname} wants to join ${ev.name} — review in Players.`);
    logAudit("event.requestJoin", `${me.nickname} requested to join "${ev?.name||eid}"`, "event", eid);
  };
  const approveEventJoin=(cid,eid,uid)=>{
    const ev=getEv(cid,eid);
    if(!ev||ev.status==="completed"||ev.status==="cancelled"){toast2("This event is closed — the request can't be approved anymore","err");return;}
    const comm = comms.find(c=>c.id===cid);
    const u=users.find(u=>u.id===uid);
    const {waitlisted} = willLandWaitlisted(ev, uid, comm, "approved");
    const updateOne=e=>{
      if(e.id!==eid) return e;
      const newJoinRequests=(e.joinRequests||[]).filter(r=>r.userId!==uid);
      const alreadyReg=e.registrations.find(r=>r.userId===uid);
      const newRegs=alreadyReg?e.registrations:[...e.registrations,{userId:uid,registeredAt:new Date().toISOString(),status:"registered",addedBy:"approved",isGuest:false}];
      return {...e,joinRequests:newJoinRequests,registrations:newRegs};
    };
    updC(cid,c=>({...c,events:c.events.map(updateOne)}));
    toast2(waitlisted?"Approved — waitlisted (event full)":"Approved ✓");
    if (ev) notify([uid], waitlisted?"waitlisted":"registered", ev, waitlisted?`⏳ You're on the waitlist for ${ev.name}`:`✓ You're in for ${ev.name}`, waitlisted?"We'll notify you if a spot opens up.":`${fmtD(ev.date)}${ev.time?` · ${fmtT(ev.time)}`:""} — request approved`);
    logAudit("event.register", `${me.nickname} approved ${u?.nickname||uid}'s request to join "${ev?.name||eid}"${waitlisted?" (waitlisted)":""}`, "event", eid);
  };
  const rejectEventJoin=(cid,eid,uid)=>{
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,joinRequests:(ev.joinRequests||[]).filter(r=>r.userId!==uid)})}));
    toast2("Rejected");
  };
  const addGuest=(cid,eid,g)=>{
    const ev=getEv(cid,eid);
    if(!ev||ev.status==="completed"||ev.status==="cancelled"){toast2("This event is closed — can't add guests anymore","err");return false;}
    if (nicknameTaken(g.n)) { toast2(`Nickname "${g.n}" is already used by another player`, "err"); return false; }
    if (phoneTaken(g.p)) { toast2(`Phone ${g.p} is already used by another player`, "err"); return false; }
    const id=_uid++;
    const newUser={id,nickname:g.n,name:g.name||g.n,phone:g.p,country:"—",gov:"—",area:"—",usr:parseInt(g.usr)||0,joined:today,avatar:ini2(g.n),isGuest:true};
    setUsers(us=>[...us,newUser]);
    updC(cid,c=>({...c,
      members:[...c.members,{userId:id,role:"member",status:"guest",since:today}],
      events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:[...ev.registrations,{userId:id,registeredAt:new Date().toISOString(),status:"registered",addedBy:me.nickname,isGuest:true}]})}));
    toast2(`${g.n} added ✓`);
    logAudit("event.register", `${me.nickname} added guest ${g.n} to "${ev.name}"`, "event", eid);
    return true;
  };
  // Promotes a community guest to a full (casual) member — same person, same history,
  // just no longer flagged as a guest anywhere in the app.
  const convertGuestToMember=(cid,uid)=>{
    updC(cid,c=>({...c,members:c.members.map(m=>m.userId===uid?{...m,status:initialMemberStatus(c)}:m)}));
    setUsers(us=>us.map(u=>u.id===uid?{...u,isGuest:false}:u));
    toast2("Converted to member ✓");
  };
  // One-time repair for guests added before community membership tracking existed:
  // scans every event's registrations for isGuest players and adds any missing ones
  // to their community's member list (status: guest), without touching anyone already there.
  const backfillGuestMemberships = () => {
    let added = 0;
    const newComms = comms.map(c => {
      const existingIds = new Set(c.members.map(m=>m.userId));
      const guestIdsInEvents = new Set();
      c.events.forEach(ev => ev.registrations.forEach(r => {
        if (r.isGuest || users.find(u=>u.id===r.userId)?.isGuest) guestIdsInEvents.add(r.userId);
      }));
      const toAdd = [...guestIdsInEvents].filter(uid => !existingIds.has(uid));
      if (toAdd.length===0) return c;
      added += toAdd.length;
      return {...c, members:[...c.members, ...toAdd.map(uid=>({userId:uid, role:"member", status:"guest", since:today}))]};
    });
    if (added>0) { setComms(newComms); toast2(`Added ${added} guest(s) to their communities ✓`); }
    else toast2("No missing guest memberships found — all clean ✓");
  };
  const checkIn=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.checkedIn.includes(uid)?ev:{...ev,checkedIn:[...ev.checkedIn,uid]})}));toast2("Checked in ✓");};
  const votePoll=(cid,eid,key)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid||!ev.poll)return ev;const v={...ev.poll.votes};const my=v[me.id]||[];v[me.id]=my.includes(key)?my.filter(k=>k!==key):[...my,key];return{...ev,poll:{...ev.poll,votes:v}};})}));};
  const resolveT=(cid,eid,key)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,type:key,poll:ev.poll?{...ev.poll,resolved:true,result:key}:null})}));toast2("Type set ✓");};
  const setPlan=(cid,eid,plan)=>updC(cid,c=>({...c,events:c.events.map(ev=>ev.id===eid?{...ev,plan}:ev)}));
  const removeFromEvent=(cid,eid,uid)=>{
    const ev=getEv(cid,eid);
    // If the person leaving held an active (non-waitlisted) spot and someone's waiting,
    // whoever is first in line is about to be pulled into the active range purely by the
    // array shifting — no separate "promote" transaction, just notify the specific person
    // this affects, since notify() lists don't reflect who newly crossed the threshold.
    const max = getMaxPlayers(ev);
    let promoted = null;
    if (ev && max!=null) {
      const idx = ev.registrations.findIndex(r=>r.userId===uid);
      if (idx>=0 && idx<max && ev.registrations.length>max) promoted = ev.registrations[max];
    }
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:ev.registrations.filter(r=>r.userId!==uid),checkedIn:ev.checkedIn.filter(id=>id!==uid)})}),{bypassSubscriptionLock:uid===me.id});
    toast2("Removed from event");
    if (promoted && ev) notify([promoted.userId], "waitlistPromoted", ev, `🎉 You're in for ${ev.name}!`, "A spot opened up — you've been moved off the waitlist.");
    const u=users.find(u=>u.id===uid);
    // Last-minute cancellation alert — the creator/event admins should hear about a dropout
    // close to start time, not just find out when the roster comes up short. Fires regardless
    // of who removed the player (self-cancel or admin-removed), excluding the leaving player
    // and whoever just performed the removal from the recipient list.
    if (ev) {
      const startMs = new Date(`${ev.date}T${ev.time||"00:00"}`).getTime();
      const hoursUntil = (startMs-Date.now())/3600000;
      if (!isNaN(startMs) && hoursUntil>0 && hoursUntil<=3) {
        const recipients = [...new Set([ev.createdBy, ...(ev.eventAdmins||[])])].filter(id=>id!==uid&&id!==me.id);
        if (recipients.length) notify(recipients, "lastMinuteCancel", ev, `⚠️ Last-minute cancellation — ${ev.name}`, `${u?.nickname||"A player"} dropped out ${hoursUntil<1?"less than an hour":`~${Math.round(hoursUntil)}h`} before start.`);
      }
    }
    logAudit("event.unregister", `${me.nickname} ${uid===me.id?"unregistered themselves":`removed ${u?.nickname||uid}`} from "${ev?.name||eid}"`, "event", eid);
  };
  const addEventPhoto=(cid,eid,photo)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,photos:[...(ev.photos||[]),{...photo,uploadedBy:me.id,uploadedAt:new Date().toISOString()}]})}));toast2("Photo added 📸");
    const ev=getEv(cid,eid);
    logAudit("event.photo", `${me.nickname} uploaded a photo to "${ev?.name||eid}"`, "event", eid);
  };
  const removeEventPhoto=(cid,eid,photoId)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,photos:(ev.photos||[]).filter(p=>p.id!==photoId)})}));toast2("Photo removed");};
  const toggleExempt=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid)return ev;const ex=new Set(ev.exempted||[]);ex.has(uid)?ex.delete(uid):ex.add(uid);return{...ev,exempted:[...ex]};})}));};
  // Retiring mid-event: from here on the player is skipped when future rounds/matches are
  // generated (genNextRoundCI / genNextCTLadder / applyPromoRelegation all filter
  // ev.retiredIds — past rounds/results are untouched). Closed Teams is fixed doubles with no
  // "continue short-handed" mode, so retiring one player retires their whole team together.
  // Finance default: retiring before the event's scheduled midpoint exempts them from the rest
  // of the cost split, retiring after it they still owe their share — either way it just seeds
  // the existing `exempted` set, so the admin can override it same as any other exemption from
  // the Finance tab. Un-retiring never touches the exempt flag — only retiring sets a default.
  const retirePlayer=(cid,eid,uid)=>{
    const ev=getEv(cid,eid);
    if(!ev) return;
    const isRetiring=!(ev.retiredIds||[]).includes(uid);
    const teamMateIds = ev.type==="closed_teams"&&ev.plan
      ? (ev.plan.teams?.find(t=>t.players?.some(p=>p.userId===uid))?.players||[]).map(p=>p.userId)
      : [uid];
    const ids = teamMateIds.length ? teamMateIds : [uid];
    updC(cid,c=>({...c,events:c.events.map(e=>{
      if(e.id!==eid) return e;
      const ret=new Set(e.retiredIds||[]);
      ids.forEach(id=>{ isRetiring?ret.add(id):ret.delete(id); });
      let exempted=e.exempted||[];
      if(isRetiring){
        const start=e.date&&e.time?new Date(`${e.date}T${e.time}`).getTime():null;
        const end=e.date&&e.timeTo?new Date(`${e.date}T${e.timeTo}`).getTime():null;
        const mid=(start&&end)?(start+end)/2:null;
        const beforeMid=mid!=null?Date.now()<mid:true;
        const exSet=new Set(exempted);
        ids.forEach(id=>{ beforeMid?exSet.add(id):exSet.delete(id); });
        exempted=[...exSet];
      }
      return {...e,retiredIds:[...ret],exempted};
    })}));
    toast2(isRetiring?(ids.length>1?"Team marked retired 🚑":"Player marked retired 🚑"):"Retirement undone");
    const names=ids.map(id=>users.find(u=>u.id===id)?.nickname||id).join(", ");
    logAudit(isRetiring?"player.retire":"player.unretire", `${me.nickname} ${isRetiring?"retired":"un-retired"} ${names} from "${ev.name}"`, "event", eid);
  };
  const togglePaid=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid)return ev;const p=new Set(ev.paidIds||[]);p.has(uid)?p.delete(uid):p.add(uid);return{...ev,paidIds:[...p]};})}));};
  // Event-scoped admin — promoted/demoted per event, not community-wide (EvDetail's own
  // isAdmin check ORs this in, nowhere else in the app reads it).
  const toggleEventAdmin=(cid,eid,uid)=>{
    const ev=getEv(cid,eid);
    let promoting=null;
    updC(cid,c=>({...c,events:c.events.map(e=>{if(e.id!==eid)return e;const a=new Set(e.eventAdmins||[]);promoting=!a.has(uid);promoting?a.add(uid):a.delete(uid);return{...e,eventAdmins:[...a]};})}));
    toast2("Event admin updated ✓");
    const u=users.find(u=>u.id===uid);
    logAudit(promoting?"eventAdmin.promote":"eventAdmin.demote", `${me.nickname} ${promoting?"made":"removed"} ${u?.nickname||uid} ${promoting?"an admin for":"as admin for"} "${ev?.name||eid}"`, "event", eid);
  };
  // An admin's phone can only meaningfully show one event's Match Mode widget at a time —
  // starting a new one clears matchModeStartAt on any OTHER event that still has it set
  // (across every community, not just this one), so at most one event is ever "live"
  // app-wide. This is what the Events-list LIVE badge relies on to never have to
  // disambiguate between two "current" events.
  const setMatchModeStart=(cid,eid,startAt,delayMin,roundEndTimes)=>{
    setComms(cs=>cs.map(c=>({...c,events:c.events.map(ev=>{
      if (c.id===cid && ev.id===eid) return !ev.plan ? ev : {...ev,plan:{...ev.plan,matchModeStartAt:startAt,matchModeDelayMin:delayMin}};
      if (ev.plan?.matchModeStartAt) return {...ev,plan:{...ev.plan,matchModeStartAt:null,matchModeDelayMin:null}};
      return ev;
    })})));
    if (!roundEndTimes || !roundEndTimes.length) return;
    const comm = comms.find(c=>c.id===cid);
    const ev = comm?.events.find(e=>e.id===eid);
    if (!ev) return;
    const waitlistedIds = new Set((ev.plan?.waitlisted||[]).map(w=>w.userId));
    const userIds = ev.registrations.filter(r=>!waitlistedIds.has(r.userId)).map(r=>r.userId);
    const entries = roundEndTimes.map(rt=>({id:`${eid}-r${rt.round}`, eventId:eid, communityId:cid, round:rt.round, endsAt:rt.endsAt, userIds, label:ev.name||"Event", sent:false}));
    (async () => {
      try {
        const ref = doc(db,"padelos","matchModeSchedule");
        const snap = await getDoc(ref);
        const existing = snap.exists() ? JSON.parse(snap.data().value||"[]") : [];
        const filtered = existing.filter(x=>x.eventId!==eid); // drop this event's old schedule (re-Start replaces it)
        await setDoc(ref, {value: JSON.stringify([...filtered, ...entries])});
      } catch (e) { console.log("matchModeSchedule write failed", e); }
    })();
  };
  // Manually ends a Match Mode session — clears matchModeStartAt, which the native sync
  // effect picks up as a real stop signal (cancels the notification + all scheduled
  // whistles). Useful for cutting a test run short without closing the whole event.
  const stopMatchMode=(cid,eid)=>{
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||!ev.plan?ev:{...ev,plan:{...ev.plan,matchModeStartAt:null,matchModeDelayMin:null}})}));
    toast2("Match Mode stopped");
  };
  // Records "whistles are already scheduled for this exact Match Mode start time" durably
  // in Firestore — this is what lets us schedule the native alarms exactly ONCE per real
  // session, regardless of how many times the app is closed/reopened in between. A plain
  // component ref resets on every remount (every time the event screen is reopened),
  // which was causing a full re-schedule (and, worse, cancellation of still-pending
  // alarms) on every single app reopen.
  const markWhistlesScheduled=(cid,eid,startAt)=>{
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||!ev.plan?ev:{...ev,plan:{...ev.plan,mmScheduledFor:startAt}})}));
  };
  const updateEventFinance=(cid,eid,fields)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,...fields})}));toast2("Updated ✓");};
  const editGuestUsr=(uid,usr)=>{setUsers(us=>us.map(u=>u.id===uid?{...u,usr:parseInt(usr)||0}:u));toast2("USR updated ✓");
    const u=users.find(u=>u.id===uid);
    logAudit("usr.editGuest", `${me.nickname} set ${u?.nickname||uid}'s guest USR to ${usr}`, "user", uid);
  };
  // Community-admin-editable (not just Platform Admin) — a manually-set tier, not a computed
  // rating, so there's no seed/recalculate machinery like padel's USR to protect here.
  const setFootballSkill=(uid,skill)=>{setUsers(us=>us.map(u=>u.id===uid?{...u,footballSkill:skill||null}:u));toast2("Football skill updated ✓");};
  const editEventUsr=(cid,eid,uid,usr)=>{
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:ev.registrations.map(r=>r.userId!==uid?r:{...r,eventUsr:usr===""?null:parseInt(usr)||0})})}));
    const ev=getEv(cid,eid),u=users.find(u=>u.id===uid);
    logAudit("usr.editEventOverride", `${me.nickname} set ${u?.nickname||uid}'s USR to ${usr===""?"(cleared)":usr} for "${ev?.name||eid}" only`, "event", eid);
  };
  const setBreakPrefOverride=(cid,eid,uid,pref)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:ev.registrations.map(r=>r.userId!==uid?r:{...r,breakPrefOverride:pref})})}));};

  // CI
  const startCI=(cid,eid,n,dur)=>{
    const ev=getEv(cid,eid);if(!ev)return;
    const active=splitRegsByCapacity(ev,comms.find(c=>c.id===cid)).active;
    const players=active.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return{...u,usr:r.eventUsr??u.usr,userId:r.userId,histBreaks:0,breakPref:r.breakPrefOverride||u.breakPref||"none"};}).filter(Boolean);
    // A registered player whose user record couldn't be resolved used to just silently vanish
    // from the plan (filter(Boolean) above swallowing it) — no toast, no error, nothing to tell
    // the admin someone registered actually didn't make it into round 1 (found live: a player
    // was in the Players list but never appeared in any round/match/standing). Most likely a
    // stale-state race — team formation fired before a just-added registration's user lookup
    // had caught up in this session's React state — so warn loudly instead of proceeding quiet.
    if(players.length<active.length){
      const missing=active.filter(r=>!players.some(p=>p.userId===r.userId)).map(r=>users.find(u=>u.id===r.userId)?.nickname||`user #${r.userId}`);
      toast2(`⚠️ ${missing.join(", ")} registered but couldn't be included — try closing and reopening the app, then Start again`,"err");
      return;
    }
    setPlan(cid,eid,{...genRound1(players,ev.courts,n),roundDuration:dur});
  };
  const nextRoundCI=(cid,eid,silent)=>{const ev=getEv(cid,eid);if(!ev?.plan)return false;const lastRound=ev.plan.rounds[ev.plan.rounds.length-1];if(!lastRound?.matches?.every(m=>m.winner!=null)){if(!silent)toast2("⚠️ Can't generate — some courts don't have a result yet");return false;}setPlan(cid,eid,genNextRoundCI(ev.plan,ev.retiredIds||[]));toast2("Next round generated ✓");return true;};
  // sA/sB default to an implied 1-0/0-1 when omitted (native widget taps, which only ever
  // declare a winner, no real score) — same pattern CT Ladder's widget already uses.
  const setWinCI=(cid,eid,ri,mi,w,sA,sB)=>{
    const scoreA = w ? (sA ?? (w==="A"?1:0)) : 0;
    const scoreB = w ? (sB ?? (w==="B"?1:0)) : 0;
    updC(cid,c=>({...c,events:c.events.map(ev=>{
      if(ev.id!==eid||!ev.plan)return ev;
      const rounds=ev.plan.rounds.map((r,rr)=>rr!==ri?r:{...r,matches:r.matches.map((m,mm)=>mm!==mi?m:{...m,winner:w,scoreA,scoreB})});
      return{...ev,plan:{...ev.plan,rounds}};
    })}));
  };
  const rebalanceCourtCI=(cid,eid,ri,mi)=>{
    updC(cid,c=>({...c,events:c.events.map(ev=>{
      if(ev.id!==eid||!ev.plan)return ev;
      const rounds=ev.plan.rounds.map((r,rr)=>{
        if(rr!==ri)return r;
        return {...r,matches:r.matches.map((m,mm)=>{
          if(mm!==mi||m.winner)return m;
          const four=[...m.teamA,...m.teamB].sort((a,b)=>b.usr-a.usr);
          let pair;
          if(ri===0){
            pair=snakePairCI(four);
          }else{
            // Rounds after the first must stay partner-diversity-aware, same as normal
            // generation — a naive USR re-snake here could recreate the exact pairing the
            // player just came from, undermining the "avoid repeat partners" rule.
            const ph=ev.plan.partnerHistory||{};
            const lastRoundPairs=new Set();
            const prevRound=ev.plan.rounds[ri-1];
            if(prevRound)prevRound.matches.forEach(pm=>{[pm.teamA,pm.teamB].forEach(team=>{const[a,b]=team;if(a&&b)lastRoundPairs.add(pairKey(a.userId,b.userId));});});
            pair=diversePair(four,ph,lastRoundPairs);
          }
          return {...m,teamA:pair.teamA,teamB:pair.teamB};
        })};
      });
      return {...ev,plan:{...ev.plan,rounds}};
    })}));
    toast2("Court re-balanced by USR ✓");
  };
  const swapCI=(cid,eid,ri,uidA,uidB)=>{
    updC(cid,c=>({...c,events:c.events.map(ev=>{
      if(ev.id!==eid||!ev.plan)return ev;
      const rounds=JSON.parse(JSON.stringify(ev.plan.rounds));const r=rounds[ri];
      function loc(uid){for(let mi=0;mi<r.matches.length;mi++)for(const t of["teamA","teamB"]){const pi=r.matches[mi][t].findIndex(p=>p.userId===uid);if(pi!==-1)return{w:"court",mi,t,pi};}const bi=r.onBreak.findIndex(p=>p.userId===uid);if(bi!==-1)return{w:"break",bi};return null;}
      function get(l){return l.w==="court"?r.matches[l.mi][l.t][l.pi]:r.onBreak[l.bi];}
      function set(l,p){if(l.w==="court")r.matches[l.mi][l.t][l.pi]=p;else r.onBreak[l.bi]=p;}
      const lA=loc(uidA),lB=loc(uidB);if(!lA||!lB)return ev;const pA=get(lA),pB=get(lB);set(lA,pB);set(lB,pA);
      r.onBreakIds=r.onBreak.map(p=>p.userId);
      // Sync breakPlan[ri] with the updated onBreakIds
      const newBreakPlan=ev.plan.breakPlan.map((bp,bri)=>bri===ri?[...r.onBreakIds]:bp);
      return{...ev,plan:{...ev.plan,rounds,breakPlan:newBreakPlan}};
    })}));toast2("Swapped ✓ — tap Regenerate in Breaks tab to update future rounds");
  };
  const editBreakCI=(cid,eid,ri,uid)=>{
    const ev=getEv(cid,eid);if(!ev?.plan)return;
    const bpr=Math.max(0,splitRegsByCapacity(ev,comms.find(c=>c.id===cid)).active.length-ev.courts*4);
    const firmBreaks=ev.plan.firmBreaks||{};
    const isFirm=(firmBreaks[ri]||[]).includes(uid);
    const isSuggested=(ev.plan.breakPlan[ri]||[]).includes(uid)&&!isFirm;

    if(!isFirm&&!isSuggested){
      // none -> suggested: same lenient toggle as before, just a proposal
      const breakPlan=ev.plan.breakPlan.map((round,i)=>i!==ri?round:[...round,uid]);
      const newCount=breakPlan[ri].length;
      if(newCount!==bpr)toast2(`Warning: R${ri+1} has ${newCount} breaks (needs ${bpr})`,"err");
      else toast2("Break suggested — tap again to lock it Firm");
      const rounds=ev.plan.rounds.map((r,rr)=>rr!==ri?r:{...r,onBreak:ev.plan.sorted.filter(p=>breakPlan[ri].includes(p.userId)),onBreakIds:breakPlan[ri]});
      setPlan(cid,eid,{...ev.plan,breakPlan,rounds});
    }else if(isSuggested){
      // suggested -> firm: hard validation, only as many Firm slots as the round has break slots
      const currentFirmCount=(firmBreaks[ri]||[]).length;
      if(currentFirmCount+1>bpr){toast2(`Can't lock — R${ri+1} only has ${bpr} break slot(s) total`,"err");return;}
      const newFirmBreaks={...firmBreaks,[ri]:[...(firmBreaks[ri]||[]),uid]};
      setPlan(cid,eid,{...ev.plan,firmBreaks:newFirmBreaks});
      toast2("Break locked as Firm 🔐 — Regenerate will keep it ✓");
    }else{
      // firm -> none: clear from both breakPlan and firmBreaks
      const newFirmBreaks={...firmBreaks,[ri]:(firmBreaks[ri]||[]).filter(id=>id!==uid)};
      const breakPlan=ev.plan.breakPlan.map((round,i)=>i!==ri?round:round.filter(id=>id!==uid));
      const rounds=ev.plan.rounds.map((r,rr)=>rr!==ri?r:{...r,onBreak:ev.plan.sorted.filter(p=>breakPlan[ri].includes(p.userId)),onBreakIds:breakPlan[ri]});
      setPlan(cid,eid,{...ev.plan,breakPlan,firmBreaks:newFirmBreaks,rounds});
      toast2("Break cleared");
    }
  };
  const regenerateBreaksCI=(cid,eid)=>{
    const ev=getEv(cid,eid);if(!ev?.plan)return;
    // generatedRounds = how many rounds exist (including pending ones not played yet)
    // We lock all generated rounds (their breaks are fixed) and only recompute open ones
    const generatedRounds=ev.plan.rounds.length;
    const newBreakPlan=regenerateBreakPlan(ev.plan,generatedRounds);
    setPlan(cid,eid,{...ev.plan,breakPlan:newBreakPlan});
    toast2("Break plan regenerated ✓");
  };

  // CT
  const swapCTBreak=(cid,eid,ri,tidA,tidB)=>{
    // Swap break assignment between two teams in an ungenerated round
    const ev=getEv(cid,eid);if(!ev?.plan)return;
    const firmHere=(ev.plan.firmBreaks||{})[ri]||[];
    if(firmHere.includes(tidA)||firmHere.includes(tidB)){toast2("That team's break is Firm-locked — unlock it first","err");return;}
    const breakPlan=ev.plan.breakPlan.map((round,i)=>{
      if(i!==ri)return round;
      const hasA=round.includes(tidA), hasB=round.includes(tidB);
      let next=[...round];
      if(hasA&&!hasB){next=next.filter(id=>id!==tidA);next.push(tidB);}
      else if(hasB&&!hasA){next=next.filter(id=>id!==tidB);next.push(tidA);}
      return next;
    });
    setPlan(cid,eid,{...ev.plan,breakPlan});
    toast2("Break swapped ✓");
  };
  const toggleCTBreakFirm=(cid,eid,ri,tid)=>{
    const ev=getEv(cid,eid);if(!ev?.plan)return;
    const firmBreaks=ev.plan.firmBreaks||{};
    const isFirm=(firmBreaks[ri]||[]).includes(tid);
    const onBreakNow=(ev.plan.breakPlan[ri]||[]).includes(tid);
    if(!isFirm&&!onBreakNow){toast2("Team isn't on break this round","err");return;}
    const newList=isFirm?(firmBreaks[ri]||[]).filter(id=>id!==tid):[...(firmBreaks[ri]||[]),tid];
    setPlan(cid,eid,{...ev.plan,firmBreaks:{...firmBreaks,[ri]:newList}});
    toast2(isFirm?"Break unlocked":"Break locked as Firm 🔐 — Regenerate will keep it ✓");
  };
  const setTeamBreakPref=(cid,eid,tid,pref)=>{
    const ev=getEv(cid,eid);if(!ev?.plan)return;
    const bump=t=>t.id===tid?{...t,breakPref:pref}:t;
    setPlan(cid,eid,{...ev.plan,teams:(ev.plan.teams||[]).map(bump),sorted:(ev.plan.sorted||[]).map(bump),groupA:(ev.plan.groupA||[]).map(bump),groupB:(ev.plan.groupB||[]).map(bump)});
    toast2("Team break preference updated ✓");
  };
  // Recorded per player-combo (not per-event) so the same two players get their chosen
  // team name back automatically next time they're paired in a CT event — written onto
  // both players' own user records, keyed the same way as teamsHistory's comboKey.
  const setComboName=(uidA,uidB,name)=>{
    const comboKey=[uidA,uidB].sort().join("_");
    setUsers(us=>us.map(u=>(u.id===uidA||u.id===uidB)?{...u,comboNames:{...(u.comboNames||{}),[comboKey]:name}}:u));
  };
  // Rename a CT team (Closed Teams). Teams are embedded by value inside plan.teams,
  // groupA/groupB, sorted, and every already-generated round's matches — same fan-out
  // as swapCTTeamPlayers above, so every one of those needs the renamed team object.
  const renameCTTeam=(cid,eid,tid,newName)=>{
    const curEv=getEv(cid,eid);
    const curTeam=curEv?.plan?.teams?.find(t=>t.id===tid);
    if(curTeam?.players?.length===2){
      const [pA,pB]=curTeam.players;
      setComboName(pA.userId||pA.id, pB.userId||pB.id, newName);
    }
    updC(cid,c=>({...c,events:c.events.map(ev=>{
      if(ev.id!==eid||!ev.plan)return ev;
      const plan=ev.plan;
      const replaceTeam=t=>t?.id===tid?{...t,name:newName}:t;
      const newRounds=plan.rounds.map(r=>({...r,
        matchesA:(r.matchesA||[]).map(m=>({...m,teamA:replaceTeam(m.teamA),teamB:replaceTeam(m.teamB)})),
        matchesB:(r.matchesB||[]).map(m=>({...m,teamA:replaceTeam(m.teamA),teamB:replaceTeam(m.teamB)})),
        onBreak:(r.onBreak||[]).map(replaceTeam),
      }));
      return {...ev,plan:{...plan,teams:(plan.teams||[]).map(replaceTeam),
        groupA:plan.groupA?.map(replaceTeam),groupB:plan.groupB?.map(replaceTeam),sorted:plan.sorted?.map(replaceTeam),
        rounds:newRounds}};
    })}));
    toast2("Team renamed ✓");
  };
  // Manual admin swap of two players between two teams (Teams tab, before Round 1 locks)
  // — mirrors the tap-a-player-to-swap pattern already used for CI. Teams are embedded by
  // value inside plan.teams, groupA/groupB, sorted, and every already-generated round's
  // matches, so every one of those needs the updated team object, not just plan.teams.
  const swapCTTeamPlayers=(cid,eid,teamIdA,userIdA,teamIdB,userIdB)=>{
    updC(cid,c=>({...c,events:c.events.map(ev=>{
      if(ev.id!==eid||!ev.plan)return ev;
      const plan=ev.plan;
      const teamA=plan.teams.find(t=>t.id===teamIdA), teamB=plan.teams.find(t=>t.id===teamIdB);
      if(!teamA||!teamB||teamA.id===teamB.id)return ev;
      const pA=teamA.players.find(p=>(p.userId||p.id)===userIdA);
      const pB=teamB.players.find(p=>(p.userId||p.id)===userIdB);
      if(!pA||!pB)return ev;
      const newTeamA={...teamA,players:teamA.players.map(p=>(p.userId||p.id)===userIdA?pB:p)};
      const newTeamB={...teamB,players:teamB.players.map(p=>(p.userId||p.id)===userIdB?pA:p)};
      // Was hardcoded to players[0]/players[1] — averaged only the first 2 players and silently
      // ignored the rest of a football team (found live on padelos-dev: avg went visibly wrong
      // after a swap on a 5-player team). Averaging over every player works for both padel's
      // fixed pairs and football's larger squads.
      const teamAvg=t=>t.players.length?Math.round(t.players.reduce((s,p)=>s+p.usr,0)/t.players.length):0;
      newTeamA.avgUsr=teamAvg(newTeamA);
      newTeamB.avgUsr=teamAvg(newTeamB);
      // A swap changes who's actually on the team, so re-check for a recorded combo name —
      // snakeTeams only gets to do this at initial auto-formation, a manual swap needs the
      // same lookup or a pair reunited by swap silently keeps the generic "Team N" name.
      // Combo names are a padel-doubles concept (one recorded name per exact 2-player pair) —
      // meaningless for a football team of 5+, so only look this up for real 2-player teams.
      const comboLookup=(p1,p2)=>{
        const uid1=p1.userId||p1.id, uid2=p2.userId||p2.id;
        const u1=users.find(u=>u.id===uid1), u2=users.find(u=>u.id===uid2);
        const ck=[uid1,uid2].sort().join("_");
        return u1?.comboNames?.[ck] || u2?.comboNames?.[ck] || null;
      };
      if(newTeamA.players.length===2){const nameA=comboLookup(newTeamA.players[0],newTeamA.players[1]);if(nameA)newTeamA.name=nameA;}
      if(newTeamB.players.length===2){const nameB=comboLookup(newTeamB.players[0],newTeamB.players[1]);if(nameB)newTeamB.name=nameB;}
      const replaceTeam=t=>t?.id===teamIdA?newTeamA:t?.id===teamIdB?newTeamB:t;
      const newTeams=plan.teams.map(replaceTeam);
      const newRounds=plan.rounds.map(r=>({...r,
        matchesA:(r.matchesA||[]).map(m=>({...m,teamA:replaceTeam(m.teamA),teamB:replaceTeam(m.teamB)})),
        matchesB:(r.matchesB||[]).map(m=>({...m,teamA:replaceTeam(m.teamA),teamB:replaceTeam(m.teamB)})),
        onBreak:(r.onBreak||[]).map(replaceTeam),
      }));
      return {...ev,plan:{...plan,teams:newTeams,
        groupA:plan.groupA?.map(replaceTeam),groupB:plan.groupB?.map(replaceTeam),sorted:plan.sorted?.map(replaceTeam),
        rounds:newRounds}};
    })}));
    toast2("Teams updated ✓");
  };
  const regenCTBreaks=(cid,eid)=>{
    const ev=getEv(cid,eid);if(!ev?.plan)return;
    const plan=ev.plan;
    const generatedRounds=plan.rounds.length;
    const teams=plan.sorted||plan.teams;
    const tc=plan.courts;
    const total=plan.maxRounds||plan.breakPlan.length;
    const newBreakPlan=[...plan.breakPlan];

    // Preserve manually-set breaks from already-generated rounds
    // (the last generated round's onBreak may have been manually swapped from Matches tab)
    for(let i=0;i<generatedRounds;i++){
      const r=plan.rounds[i];
      if(r.onBreak&&r.onBreak.length>0){
        newBreakPlan[i]=(r.onBreakIds||r.onBreak.map(t=>t.id||t.teamId));
      }
    }

    // Regenerate only the ungenerated rounds, starting fresh from where we left off
    // Pass the current state (including manually-set breaks) as the seed for fair distribution
    const fresh=buildCTBreakPlan(teams,tc,total,newBreakPlan.slice(0,generatedRounds),plan.firmBreaks||{});
    for(let i=generatedRounds;i<total;i++) newBreakPlan[i]=fresh[i];
    setPlan(cid,eid,{...plan,breakPlan:newBreakPlan});
    toast2("Break schedule regenerated ✓");
  };

  const startCT=(cid,eid,courts,fmt,dur,topPoolSizeOverride)=>{
    const ev=getEv(cid,eid);if(!ev)return;
    const comm=comms.find(c=>c.id===cid);
    const isFootballEv=ev.sport==="Football";
    const active=splitRegsByCapacity(ev,comm).active;
    let players=active.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return{...u,usr:teamFormationRating(u,ev),userId:r.userId,breakPref:u.breakPref||"none"};}).filter(Boolean);
    // Same silent-drop risk as startCI — a registered player whose user record didn't resolve
    // (most likely a stale-state race right after they registered) used to just vanish with no
    // warning, and could even slip past the odd/even waitlist check below since it operates on
    // the already-shrunk count. Catch it here, before that check, so it's never silent.
    if(players.length<active.length){
      const missing=active.filter(r=>!players.some(p=>(p.userId||p.id)===r.userId)).map(r=>users.find(u=>u.id===r.userId)?.nickname||`user #${r.userId}`);
      toast2(`⚠️ ${missing.join(", ")} registered but couldn't be included — try closing and reopening the app, then Form Teams again`,"err");
      return;
    }
    let waitlisted=null;
    // Football teams don't need to pair off 2-by-2 — team size comes from ev.teamSize/numTeams,
    // set at event creation, not derived from player count parity the way padel's doubles are.
    if(!isFootballEv && players.length%2!==0){
      // Odd count — last player in registrations array goes to waiting list
      const regs=splitRegsByCapacity(ev,comm).active;
      const lastReg=regs[regs.length-1];
      const lastPlayer=players.find(p=>(p.userId||p.id)===lastReg?.userId);
      waitlisted=lastPlayer||players[players.length-1];
      players=players.filter(p=>(p.userId||p.id)!==(waitlisted.userId||waitlisted.id));
      toast2(`${waitlisted.nickname} moved to waiting list — need even number for team formation`,"err");
    }
    // Football's pitches are fixed at event creation (ev.pitchNames), not admin-selectable at
    // formation time the way padel's court count is — ignore whatever `courts` the caller passed.
    const effCourts=isFootballEv?Math.max(1,ev.pitchNames?.length||ev.courts||1):courts;
    const newPlan={...generateCTPlan(players,effCourts,fmt,ev,dur||20,topPoolSizeOverride),waitlisted:waitlisted?[{userId:waitlisted.userId,nickname:waitlisted.nickname,usr:waitlisted.usr}]:[]};
    setPlan(cid,eid,newPlan);
    toast2(isFootballEv?`Teams formed ✓ — ${ev.numTeams||newPlan.teams.length} teams`:`Teams formed ✓ — ${Math.floor(players.length/2)} teams`);
  };
  // Clears the League "live" flag the moment a winner gets recorded — otherwise a
  // completed match can go on carrying a stale live:true from before it was decided,
  // which (among other things) confuses the "is this team live elsewhere" conflict check
  // on every other match involving that team, since it looks like the match matching
  // itself. Undo (w===null) leaves live untouched — it wasn't this action that set it.
  const setWinCT=(cid,eid,ri,mi,side,w,sA,sB)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid||!ev.plan)return ev;const rounds=ev.plan.rounds.map((r,rr)=>{if(rr!==ri)return r;const up=arr=>arr.map((m,mm)=>mm!==mi?m:{...m,winner:w,scoreA:sA,scoreB:sB,live:w?false:m.live});return{...r,matchesA:side==="A"?up(r.matchesA):r.matchesA,matchesB:side==="B"?up(r.matchesB):r.matchesB};});return{...ev,plan:{...ev.plan,rounds}};})}));};
  // Football-only, optional — who scored, tallied per match. scorers: [{userId,goals}], only
  // entries with goals>0 kept. Deliberately separate from setWinCT (its own explicit save) so
  // tagging scorers never has to happen in the same tap as recording the winner.
  // scorersA/scorersB kept separate per team (not one flat list) so each side's tally can only
  // ever be checked against that team's own score — mixing both teams into one list was the
  // actual bug (found live: a team-2 player showing more tagged goals than team 2 even scored,
  // with no way to catch it since the check summed both teams together).
  const setCTScorers=(cid,eid,ri,mi,side,scorersA,scorersB)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid||!ev.plan)return ev;const rounds=ev.plan.rounds.map((r,rr)=>{if(rr!==ri)return r;const up=arr=>arr.map((m,mm)=>mm!==mi?m:{...m,scorersA,scorersB});return{...r,matchesA:side==="A"?up(r.matchesA):r.matchesA,matchesB:side==="B"?up(r.matchesB):r.matchesB};});return{...ev,plan:{...ev.plan,rounds}};})}));};
  // Toggles whether a League match shows on the Match Mode widget — display-only there
  // (no tap-to-record), so this doesn't touch winner/score at all, just the "live" flag.
  const toggleCTLeagueLive=(cid,eid,ri,mi,side)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid||!ev.plan)return ev;const rounds=ev.plan.rounds.map((r,rr)=>{if(rr!==ri)return r;const up=arr=>arr.map((m,mm)=>mm!==mi?m:{...m,live:!m.live});return{...r,matchesA:side==="A"?up(r.matchesA):r.matchesA,matchesB:side==="B"?up(r.matchesB):r.matchesB};});return{...ev,plan:{...ev.plan,rounds}};})}));};
  const applyPromo=(cid,eid)=>{const ev=getEv(cid,eid);if(!ev?.plan)return;setPlan(cid,eid,applyPromoRelegation(ev.plan,ev.retiredIds||[]));toast2("Groups reshuffled ✓");};
  const nextFootballRound=(cid,eid)=>{const ev=getEv(cid,eid);if(!ev?.plan)return;setPlan(cid,eid,nextFootballLeagueRound(ev.plan));toast2("Next round generated ✓");};
  const nextCTLadder=(cid,eid,silent)=>{const ev=getEv(cid,eid);if(!ev?.plan)return false;const lastRound=ev.plan.rounds[ev.plan.rounds.length-1];if(!lastRound?.matchesA?.every(m=>m.winner!=null)){if(!silent)toast2("⚠️ Can't generate — some courts don't have a result yet");return false;}setPlan(cid,eid,genNextCTLadder(ev.plan,ev.retiredIds||[]));toast2("Next match generated ✓");return true;};
  const swapCTLadder=(cid,eid,ri,tidA,tidB)=>{
    updC(cid,c=>({...c,events:c.events.map(ev=>{
      if(ev.id!==eid||!ev.plan)return ev;
      const rounds=JSON.parse(JSON.stringify(ev.plan.rounds));
      const r=rounds[ri];
      // Find teams in matches or onBreak
      function locT(tid){
        for(let mi=0;mi<r.matchesA.length;mi++){
          if(r.matchesA[mi].teamA?.id===tid)return{w:"match",mi,side:"teamA"};
          if(r.matchesA[mi].teamB?.id===tid)return{w:"match",mi,side:"teamB"};
        }
        const bi=r.onBreak.findIndex(t=>t.id===tid);
        if(bi!==-1)return{w:"break",bi};
        return null;
      }
      function getT(l){return l.w==="match"?r.matchesA[l.mi][l.side]:r.onBreak[l.bi];}
      function setT(l,t){if(l.w==="match")r.matchesA[l.mi][l.side]=t;else r.onBreak[l.bi]=t;}
      const lA=locT(tidA),lB=locT(tidB);
      if(!lA||!lB)return ev;
      const tA=getT(lA),tB=getT(lB);setT(lA,tB);setT(lB,tA);
      r.onBreakIds=r.onBreak.map(t=>t.id);
      return{...ev,plan:{...ev.plan,rounds}};
    })}));
    toast2("Teams swapped ✓");
  };

  const comm=view.cid?comms.find(c=>c.id===view.cid):null;
  // Deleted events are invisible to everyone except the platform owner (id 1) — see deleteEvent.
  const event=comm&&view.eid?comm.events.find(e=>e.id===view.eid&&(!e.deleted||me.id===1)):null;
  const allEvents=comms.flatMap(c=>{
    const amAdmin=c.members.some(m=>m.userId===me.id&&(m.role==="owner"||m.role==="admin"));
    return c.events.filter(ev=>!ev.deleted&&(ev.visibility!=="private"||amAdmin||ev.registrations.some(r=>r.userId===me.id))).map(ev=>({...ev,commName:c.name,communityId:c.id}));
  });

  const dataDegraded = dataLoaded && ["comms","users","venues"].some(k=>!everRealRef.current[k]);
  const diagText = Object.entries(loadDiag).map(([k,v])=>`${k}: ${v}`).join(" · ");
  // Persistent "notifications are off" banner — checks the REAL OS/browser permission state
  // (not a one-time "seen it" flag), so it disappears on its own the moment the user actually
  // enables notifications, from wherever they do it. Skipped when the Notification API doesn't
  // exist at all (iOS Safari not installed as a PWA yet) — that case already has its own
  // dedicated nag (the "Add to Home Screen" overlay below), no need to double up.
  const [notifDisabled, setNotifDisabled] = useState(false);
  useEffect(() => {
    const check = () => {
      if (Capacitor.isNativePlatform()) {
        PushNotifications.checkPermissions().then(res => setNotifDisabled(res.receive !== "granted")).catch(()=>{});
      } else if ("Notification" in window) {
        setNotifDisabled(Notification.permission !== "granted");
      }
    };
    check();
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(check, 5 * 60 * 1000);
    return () => { document.removeEventListener("visibilitychange", onVisible); clearInterval(interval); };
  }, []);
  // "New version available" banner — dist/version.json is written fresh on every build (see
  // vite.config.js) from the same APP_VERSION baked into that build, so polling it tells an
  // already-open tab a newer deploy exists without needing any server-side broadcast. Native
  // (installed APK) has no such auto-update path, so this only runs on web.
  const [newVersion, setNewVersion] = useState(null);
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    let cancelled = false;
    const check = () => {
      fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" })
        .then(r => r.json())
        .then(d => { if (!cancelled && d.version && d.version !== APP_VERSION) setNewVersion(d.version); })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  // Every per-screen sticky "Back" header (BBtn, sticky=true) also pins at top:60, right under
  // the TopBar — same slot this banner stack uses. Without this, when both are present the Back
  // header (later in DOM) paints over the banner(s) once both are stuck, making them look like
  // they "disappeared" on scroll even though they're just hidden underneath. Measuring the real
  // combined height of whichever top banners are actually showing (new-version, notifications-
  // off — either, both, or neither) and publishing it as a CSS var lets BBtn push itself down
  // below them instead of colliding.
  const stickyBannerRef = useRef(null);
  useEffect(() => {
    if (!newVersion && !notifDisabled) { document.documentElement.style.setProperty("--po-sticky-extra", "0px"); return; }
    const el = stickyBannerRef.current;
    if (!el) return;
    const update = () => document.documentElement.style.setProperty("--po-sticky-extra", el.offsetHeight + "px");
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [newVersion, notifDisabled]);

  if (authLoading || (authUser && !dataLoaded)) {
    return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#64748B",fontSize:14}}>Loading…</div>
    </div>;
  }
  if (!authUser) {
    return <LoginScreen/>;
  }
  if (linkedMe?.suspended) {
    return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{maxWidth:340,textAlign:"center"}}>
        <div style={{fontSize:32,marginBottom:12}}>🚫</div>
        <div style={{fontSize:17,fontWeight:700,color:"#F1F5F9",marginBottom:8}}>Account Suspended</div>
        <div style={{fontSize:13,color:"#64748B",marginBottom:20}}>A platform admin has suspended your account. Your match history and stats are untouched, but you can't sign in or use the app right now — contact the admin if you think this is a mistake.</div>
        <div onClick={()=>signOut(fbAuth)} style={{fontSize:12,color:"#818CF8",cursor:"pointer"}}>Sign out</div>
      </div>
    </div>;
  }
  if (!linkedMe) {
    if (pendingInviteConfirm) {
      const {inv, target} = pendingInviteConfirm;
      return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
        <div style={{maxWidth:360,textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>🔗</div>
          <div style={{fontSize:17,fontWeight:700,color:"#F1F5F9",marginBottom:8}}>Is this you?</div>
          <div style={{fontSize:13,color:"#64748B",marginBottom:20}}>This invite link will connect your account to <b style={{color:"#F1F5F9"}}>{target.nickname}</b>'s profile{target.area&&target.area!=="—"?` (${target.area})`:""}. Only confirm if that's really you — if this link was forwarded to you by mistake, don't claim someone else's profile.</div>
          <button onClick={()=>{autoInviteClaimRef.current=inv.code;claimViaInvite(inv.targetUserId,inv);setPendingInviteConfirm(null);}} style={{width:"100%",padding:"12px",borderRadius:10,border:"none",background:"#6366F1",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Yes, that's me</button>
          <div onClick={()=>{clearPendingInvite();autoInviteClaimRef.current=inv.code;setPendingInviteConfirm(null);}} style={{fontSize:12,color:"#818CF8",cursor:"pointer",marginTop:14}}>That's not me — create my own profile instead</div>
          <div onClick={()=>signOut(fbAuth)} style={{fontSize:11,color:"#475569",cursor:"pointer",marginTop:10}}>Sign out</div>
        </div>
      </div>;
    }
    if (pendingEmailMatchConfirm) {
      const {target} = pendingEmailMatchConfirm;
      return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
        <div style={{maxWidth:360,textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>🔗</div>
          <div style={{fontSize:17,fontWeight:700,color:"#F1F5F9",marginBottom:8}}>Is this you?</div>
          <div style={{fontSize:13,color:"#64748B",marginBottom:20}}>A profile already exists for this email — <b style={{color:"#F1F5F9"}}>{target.nickname}</b>{target.area&&target.area!=="—"?` (${target.area})`:""}. Confirm only if that's really you, so we don't create a duplicate profile.</div>
          <button onClick={()=>{claimViaEmailMatch(target.id);setPendingEmailMatchConfirm(null);}} style={{width:"100%",padding:"12px",borderRadius:10,border:"none",background:"#6366F1",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Yes, that's me</button>
          <div onClick={()=>{setPendingEmailMatchConfirm(null);createFreshProfileOrMatch(true);}} style={{fontSize:12,color:"#818CF8",cursor:"pointer",marginTop:14}}>That's not me — create my own profile instead</div>
          <div onClick={()=>signOut(fbAuth)} style={{fontSize:11,color:"#475569",cursor:"pointer",marginTop:10}}>Sign out</div>
        </div>
      </div>;
    }
    if (pendingFreshProfileConfirm) {
      return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
        <div style={{maxWidth:360,textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>👋</div>
          <div style={{fontSize:17,fontWeight:700,color:"#F1F5F9",marginBottom:8}}>New here?</div>
          <div style={{fontSize:13,color:"#64748B",marginBottom:20}}>You're signed in as <b style={{color:"#F1F5F9"}}>{authUser.displayName||authUser.email}</b>, but there's no Matchkeeper profile for this account (yet, or anymore). Continue to set one up, or sign out if this isn't the account you meant to use.</div>
          <button onClick={()=>{createFreshProfileOrMatch();setPendingFreshProfileConfirm(false);}} style={{width:"100%",padding:"12px",borderRadius:10,border:"none",background:"#6366F1",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Continue — create my profile</button>
          <div onClick={()=>{setPendingFreshProfileConfirm(false);signOut(fbAuth);}} style={{fontSize:12,color:"#818CF8",cursor:"pointer",marginTop:14}}>Sign out</div>
        </div>
      </div>;
    }
    // No pending invite to confirm — the auto-fresh-profile effect above (or the id===1
    // bootstrap it falls back to) handles this case within a render or two, nothing to show
    // here beyond a brief loading state for that gap.
    return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#64748B",fontSize:14}}>Setting up your profile…</div>
    </div>;
  }

  return (
    <div onClick={()=>{menu&&setMenu(false);notifMenu&&setNotifMenu(false);}}
      style={{
        "--po-bg":   TH.bg,
        "--po-card": TH.card,
        "--po-bdr":  TH.border,
        "--po-text": TH.text,
        "--po-sub":  TH.sub,
        "--po-dim":  TH.dim,
        "--po-inp":  TH.input,
        "--po-shadow": TH.cardShadow||"none",
        minHeight:"100vh", background:"var(--po-bg)", color:"var(--po-text)",
        fontFamily:"'Inter',system-ui,sans-serif", display:"flex", flexDirection:"column", transition:"all 0.25s"
      }}>
      <style>{`
        .po-card{background:var(--po-card)!important;border-color:var(--po-bdr)!important;box-shadow:var(--po-shadow)!important;}
        .po-inp{background:var(--po-inp)!important;border-color:var(--po-bdr)!important;color:var(--po-text)!important;}
        .po-inp::placeholder{color:var(--po-dim)!important;}
        .po-text{color:var(--po-text)!important;}
        .po-sub{color:var(--po-sub)!important;}
        .po-dim{color:var(--po-dim)!important;}
        select.po-inp option{background:var(--po-card);color:var(--po-text);}
        textarea.po-inp{color:var(--po-text)!important;background:var(--po-inp)!important;}
      `}</style>
      <TopBar me={me} nav={nav} menu={menu} setMenu={setMenu} TH={TH} dark={dark} onNav={n=>{goRoot(n);}} onProfile={()=>{setNavHistory(h=>[...h,{nav,view}]);setNav("profile");setView({screen:"profile",uid:me.id});setMenu(false);}} onMyCommunities={()=>{goCommList();setMenu(false);}} onVenues={()=>{goRoot("venues");setMenu(false);}} onSettings={()=>{goRoot("settings");setMenu(false);}} onPlatformAdmin={()=>{setNavHistory(h=>[...h,{nav,view}]);setNav("platform");setView({screen:"admin"});setMenu(false);}} onSignOut={async()=>{await logAudit("auth.signout", `${me.nickname} signed out`, "user", me.id);signOut(fbAuth);}}
        comms={comms} eventCommFilter={eventCommFilter} onSetEventCommFilter={setEventCommFilter}
        notifications={notifications} notifMenu={notifMenu} setNotifMenu={setNotifMenu}
        onMarkNotifRead={markNotifRead} onMarkAllNotifRead={markAllNotifRead}
        onOpenNotif={n=>{setNotifMenu(false);openNotif(n);}}
        onSeeAllNotifs={()=>{setNotifMenu(false);setNavHistory(h=>[...h,{nav,view}]);setNav("notifications");setView({screen:"list"});}}
      />
      {/* God Mode — Platform Admin only. Fixed position so it floats over every screen
          regardless of scroll/nav. Toggling on requires its own confirm (arming warning);
          any actual write it enables triggers a second, separate confirm in updC. */}
      {me.id===1&&<div onClick={()=>{
        if(godMode){setGodMode(false);toast2("God Mode off");}
        else if(window.confirm("⚡ Enable God Mode?\n\nYou'll get full admin authority on any community or event screen, regardless of your real membership there. Any actual change you make while flagged will ask for confirmation again first — use carefully."))
          {setGodMode(true);toast2("⚡ God Mode ON — full authority everywhere until you turn it off");}
      }} title={godMode?"God Mode ON — tap to turn off":"Tap to enable God Mode"} style={{position:"fixed",bottom:20,right:16,zIndex:200,width:52,height:52,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,cursor:"pointer",background:godMode?"#EF4444":"var(--po-card)",border:`2px solid ${godMode?"#EF4444":"var(--po-bdr)"}`,boxShadow:godMode?"0 0 16px #EF444488":"0 2px 8px #00000044",color:godMode?"#fff":"var(--po-dim)",transition:"all 0.2s"}}>⚡</div>}
      {/* iOS "Add to Home Screen" walkthrough — full-screen the first time (can't be missed),
          then collapses to a small floating icon on close instead of dismissing forever, same
          interaction shape as the God Mode button above. Left corner so the two never collide. */}
      {isIosNonStandalone()&&!showIosOverlay&&<div onClick={expandIosOverlay} title="Add Matchkeeper to your Home Screen" style={{position:"fixed",bottom:20,left:16,zIndex:200,width:52,height:52,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,cursor:"pointer",background:"var(--po-card)",border:"2px solid #6366F1",boxShadow:"0 2px 8px #00000044",color:"#6366F1"}}>🍎</div>}
      {isIosNonStandalone()&&showIosOverlay&&<div style={{position:"fixed",inset:0,zIndex:300,background:"linear-gradient(160deg,#1E1B4B 0%,#0E1117 60%)",overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
        <div style={{minHeight:"100%",display:"flex",flexDirection:"column",alignItems:"center",padding:"28px 20px 40px",boxSizing:"border-box"}}>
          <div onClick={collapseIosOverlay} title="Minimize" style={{position:"absolute",top:16,right:16,width:36,height:36,borderRadius:"50%",background:"#FFFFFF18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:"#fff",cursor:"pointer"}}>✕</div>
          <div style={{fontSize:56,marginTop:24,marginBottom:6}}>📲</div>
          <div style={{fontSize:24,fontWeight:800,color:"#fff",textAlign:"center",marginBottom:6,letterSpacing:-0.4}}>Install Matchkeeper</div>
          <div style={{fontSize:14,color:"#C7D2FE",textAlign:"center",marginBottom:30,maxWidth:340,lineHeight:1.55}}>Add it to your Home Screen for the full app — instant launch, no browser bar, and match/round alerts that only work once it's installed.</div>
          {[
            {n:1,icon:"⬆️",title:"Tap the Share icon",desc:"In Safari's toolbar — usually at the bottom of the screen."},
            {n:2,icon:"➕",title:'Scroll and tap "Add to Home Screen"',desc:"You may need to scroll down the share sheet to find it."},
            {n:3,icon:"✅",title:'Tap "Add" (top right)',desc:"Matchkeeper's icon will appear on your Home Screen."},
            {n:4,icon:"🚀",title:"Open it from your Home Screen",desc:"Not Safari — the new icon. That's the real app from now on."},
          ].map(s=><div key={s.n} style={{display:"flex",gap:14,alignItems:"flex-start",width:"100%",maxWidth:380,marginBottom:18}}>
            <div style={{width:44,height:44,borderRadius:12,background:"#FFFFFF14",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{s.icon}</div>
            <div>
              <div style={{fontSize:15,fontWeight:700,color:"#fff",marginBottom:2}}>{s.n}. {s.title}</div>
              <div style={{fontSize:12.5,color:"#94A3B8",lineHeight:1.45}}>{s.desc}</div>
            </div>
          </div>)}
          <div style={{marginTop:8,width:"100%",maxWidth:380,background:"#34D39918",border:"0.5px solid #34D39944",borderRadius:14,padding:"14px 16px",display:"flex",gap:12,alignItems:"flex-start",boxSizing:"border-box"}}>
            <div style={{fontSize:22,flexShrink:0}}>🔔</div>
            <div style={{fontSize:12.5,color:"#A7F3D0",lineHeight:1.5}}><b>One more thing</b> — once it's open from the Home Screen, it'll ask for notification permission. Tap <b>Allow</b>. That's how you get match reminders and round-end alerts.</div>
          </div>
          <div onClick={collapseIosOverlay} style={{marginTop:26,fontSize:13,fontWeight:600,color:"#818CF8",cursor:"pointer",textDecoration:"underline"}}>Got it, I'll do this later</div>
        </div>
      </div>}
      <div style={{flex:1,maxWidth:680,width:"100%",margin:"0 auto",padding:"16px 12px 80px"}}>
        {godMode&&<div style={{fontSize:12,fontWeight:700,color:"#fff",background:"#EF4444",borderRadius:8,padding:"10px 12px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
          <span>⚡ GOD MODE ACTIVE — full admin authority here, not your real role</span>
          <span onClick={()=>{setGodMode(false);toast2("God Mode off");}} style={{cursor:"pointer",textDecoration:"underline",flexShrink:0,whiteSpace:"nowrap"}}>Turn off</span>
        </div>}
        {isSubscriptionInGrace(me,subscriptionSettings)&&<div style={{fontSize:12,fontWeight:600,color:"#F59E0B",background:"#F59E0B18",border:"0.5px solid #F59E0B44",borderRadius:8,padding:"10px 12px",marginBottom:12}}>
          ⏳ Your subscription expired — you have a 1-day grace period before the app goes read-only. Renew now to avoid any interruption.
        </div>}
        {isSubscriptionLocked(me,subscriptionSettings)&&<div style={{fontSize:12,fontWeight:600,color:"#F59E0B",background:"#F59E0B18",border:"0.5px solid #F59E0B44",borderRadius:8,padding:"10px 12px",marginBottom:12}}>
          🚫 Your subscription has expired — you're in read-only mode. You can still view your own events and unregister from them, but creating, registering, and admin actions are paused until it's renewed. Contact your community admin or the platform to renew.
        </div>}
        {/* Sticky — same top:60/zIndex:40/negative-margin-bleed pattern BBtn's sticky mode
            already uses, so it pins directly under the (also sticky) TopBar instead of
            scrolling away with the rest of the content. An opaque background is load-bearing
            here: without it, whatever scrolls underneath would show through the translucent
            green while pinned. */}
        {(newVersion||notifDisabled)&&<div ref={stickyBannerRef} style={{position:"sticky",top:60,zIndex:41,background:"var(--po-bg)",marginLeft:-12,marginRight:-12,paddingLeft:12,paddingRight:12,paddingTop:12,marginBottom:0}}>
          {newVersion&&<div onClick={()=>window.location.reload()} style={{fontSize:12,color:"#34D399",background:"#34D399DD",border:"0.5px solid #34D39944",borderRadius:8,padding:"10px 12px",marginBottom:12,display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
            <span style={{fontSize:16}}>🆕</span>
            <span style={{flex:1,color:"#0E1117",fontWeight:600}}>New version {newVersion} is available — tap to refresh.</span>
            <span style={{fontWeight:700,color:"#0E1117"}}>↻</span>
          </div>}
          {/* Persistent until the OS/browser permission is actually granted — see the
              notifDisabled effect above. Tapping it goes straight to Settings, where the
              existing Enable-notifications flow already lives. */}
          {notifDisabled&&<div onClick={()=>{setNav("settings");setNotifMenu(false);}} style={{fontSize:12,color:"#78350F",background:"#FBBF24DD",border:"0.5px solid #F59E0B44",borderRadius:8,padding:"10px 12px",marginBottom:12,display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
            <span style={{fontSize:16}}>🔔</span>
            <span style={{flex:1,fontWeight:600}}>Notifications are off — tap to enable them in Settings.</span>
            <span style={{fontWeight:700}}>›</span>
          </div>}
        </div>}
        {dataDegraded&&<div style={{fontSize:12,color:"#FBBF24",background:"#FBBF2422",border:"0.5px solid #FBBF2444",borderRadius:8,padding:"10px 12px",marginBottom:12}}>⚠️ Some data didn't load fully this session (connection issue). Please close and reopen the app before adding or editing anything — changes made now may not be saved.{diagText&&<div style={{marginTop:6,fontSize:10,fontFamily:"monospace",color:"#FDE68A",wordBreak:"break-word"}}>{diagText}</div>}</div>}
        {nav==="communities"&&view.screen==="list"&&<CommList comms={comms} me={me} dark={dark} TH={TH} onOpen={id=>go("comm",{cid:id})} onCreate={()=>go("createComm")}/>}
        {nav==="communities"&&view.screen==="createComm"&&<CommForm onBack={goBack} onSave={createComm} egypt={egypt}/>}
        {nav==="communities"&&view.screen==="editComm"&&comm&&<CommForm comm={comm} onBack={goBack} onSave={d=>saveComm(comm.id,d)} egypt={egypt}/>}
        {nav==="communities"&&view.screen==="comm"&&comm&&<CommDetail comm={comm} users={users} venues={venues} me={me} uidLinks={uidLinks} onBack={goBack} onEdit={()=>go("editComm",{cid:comm.id})} onApprove={uid=>approveReq(comm.id,uid)} onReject={uid=>rejectReq(comm.id,uid)} onRequestJoin={()=>requestJoin(comm.id)} onPromote={uid=>promoteM(comm.id,uid)} onDemote={uid=>demoteM(comm.id,uid)} onKick={uid=>kickM(comm.id,uid)} onTransferOwnership={uid=>transferOwnership(comm.id,uid)} onToggleStatus={uid=>toggleMemberStatus(comm.id,uid)} onConvertGuest={uid=>convertGuestToMember(comm.id,uid)} onInvite={uid=>inviteUser(comm.id,uid)} onOpenEv={eid=>go("event",{cid:comm.id,eid})} onCreateEv={()=>go("createEvent",{cid:comm.id})} onViewProfile={uid=>{setNav("profile");setNavHistory(h=>[...h,{nav,view}]);setView({screen:"profile",uid,backCid:comm.id});}} onCreateInvite={createInvite} initialTab={view.tab} onTabChange={t=>setView(v=>v.tab===t?v:{...v,tab:t})} onSetBookkeeping={fields=>setBookkeeping(comm.id,fields)} onAddLedgerEntry={entry=>addLedgerEntry(comm.id,entry)} onAddLedgerEntries={entriesArr=>addLedgerEntries(comm.id,entriesArr)} onDeleteLedgerEntry={eid=>deleteLedgerEntry(comm.id,eid)} onSetFootballSkill={setFootballSkill} expenseCategories={expenseCategories} onPostAnnouncement={message=>postAnnouncement(comm.id,message)} onDeleteAnnouncement={aid=>deleteAnnouncement(comm.id,aid)} onReplyAnnouncement={(aid,message)=>postAnnouncementReply(comm.id,aid,message)} onDeleteAnnouncementReply={(aid,rid)=>deleteAnnouncementReply(comm.id,aid,rid)} onSetBanner={url=>setCommunityBanner(comm.id,url)} onRemoveBanner={()=>removeCommunityBanner(comm.id)} godMode={godMode}/>}
        {nav==="communities"&&view.screen==="createEvent"&&comm&&<EventForm venues={venues} commName={comm.name} commSports={comm.sports?.length?comm.sports:[DEFAULT_SPORT]} onBack={goBack} onCreate={d=>createEvent(comm.id,d)}/>}
        {nav==="communities"&&view.screen==="editEvent"&&comm&&event&&<EventEditForm ev={event} venues={venues} commSports={comm.sports?.length?comm.sports:[DEFAULT_SPORT]} onBack={goBack} onSave={d=>editEvent(comm.id,event.id,d)}/>}
        {nav==="communities"&&view.screen==="event"&&comm&&event&&
          <EvDetail key={event.id} ev={event} comm={comm} comms={comms} users={users} venues={venues} me={me} uidLinks={uidLinks} godMode={godMode} subscriptionSettings={subscriptionSettings} onToast={msg=>toast2(msg)} onOpenCommunity={()=>goComm(comm.id)}
            onDuplicate={(newDate,keepPlayers,newTime,newTimeTo,newName)=>duplicateEvent(comm.id,event.id,newDate,keepPlayers,newTime,newTimeTo,newName)}
            onDelete={()=>deleteEvent(comm.id,event.id)}
            onArchive={()=>archiveEvent(comm.id,event.id)}
            onUnarchive={()=>unarchiveEvent(comm.id,event.id)}
            onViewProfile={uid=>{setNav("profile");setNavHistory(h=>[...h,{nav,view}]);setView({screen:"profile",uid,backCid:comm.id});}}
            onToggleExempt={uid=>toggleExempt(comm.id,event.id,uid)}
            onTogglePaid={uid=>togglePaid(comm.id,event.id,uid)}
            onSetBreakPrefOverride={(uid,pref)=>setBreakPrefOverride(comm.id,event.id,uid,pref)}
            onSetMatchModeStart={(startAt,delayMin,roundEndTimes)=>setMatchModeStart(comm.id,event.id,startAt,delayMin,roundEndTimes)}
            onStopMatchMode={()=>stopMatchMode(comm.id,event.id)}
            onMarkWhistlesScheduled={(startAt)=>markWhistlesScheduled(comm.id,event.id,startAt)}
            onSwapCTTeamPlayers={(teamIdA,userIdA,teamIdB,userIdB)=>swapCTTeamPlayers(comm.id,event.id,teamIdA,userIdA,teamIdB,userIdB)}
            onRenameTeam={(tid,newName)=>renameCTTeam(comm.id,event.id,tid,newName)}
            onCreateInvite={createInvite}
            onRequestEventJoin={()=>requestEventJoin(comm.id,event.id)}
            onApproveEventJoin={uid=>approveEventJoin(comm.id,event.id,uid)}
            onRejectEventJoin={uid=>rejectEventJoin(comm.id,event.id,uid)}
            onSetFootballSkill={setFootballSkill}
            onRetirePlayer={uid=>retirePlayer(comm.id,event.id,uid)}
            onToggleEventAdmin={uid=>toggleEventAdmin(comm.id,event.id,uid)}
            onUpdateEventFinance={fields=>updateEventFinance(comm.id,event.id,fields)}
            onAddLedgerEntry={entry=>addLedgerEntry(comm.id,entry)}
            expenseCategories={expenseCategories}
            onPostEventAnnouncement={message=>postEventAnnouncement(comm.id,event.id,message)}
            onDeleteEventAnnouncement={aid=>deleteEventAnnouncement(comm.id,event.id,aid)}
            onReplyEventAnnouncement={(aid,message)=>postEventAnnouncementReply(comm.id,event.id,aid,message)}
            onDeleteEventAnnouncementReply={(aid,rid)=>deleteEventAnnouncementReply(comm.id,event.id,aid,rid)}
            onSwapCTBreak={(ri,tA,tB)=>swapCTBreak(comm.id,event.id,ri,tA,tB)}
            onToggleCTBreakFirm={(ri,tid)=>toggleCTBreakFirm(comm.id,event.id,ri,tid)}
            onSetTeamBreakPref={(tid,pref)=>setTeamBreakPref(comm.id,event.id,tid,pref)}
            onRegenCTBreaks={()=>regenCTBreaks(comm.id,event.id)}
            onBack={goBack}
            onCloseEvent={(scoringMethod)=>closeEvent(comm.id,event.id,scoringMethod)}
            onEditEvent={()=>go("editEvent",{cid:comm.id,eid:event.id})}
            onRegister={()=>registerEv(comm.id,event.id)}
            onCheckIn={uid=>checkIn(comm.id,event.id,uid)}
            onAddMember={uid=>addMember(comm.id,event.id,uid)}
            onAddGuest={g=>addGuest(comm.id,event.id,g)}
            onVote={k=>votePoll(comm.id,event.id,k)}
            onResolveType={k=>resolveT(comm.id,event.id,k)}
            onStartCI={(n,dur)=>startCI(comm.id,event.id,n,dur)}
            onSetWinCI={(ri,mi,w,sA,sB)=>setWinCI(comm.id,event.id,ri,mi,w,sA,sB)}
            onNextRound={(silent)=>nextRoundCI(comm.id,event.id,silent)}
            onSwap={(ri,a,b)=>swapCI(comm.id,event.id,ri,a,b)}
            onRebalanceCourt={(ri,mi)=>rebalanceCourtCI(comm.id,event.id,ri,mi)}
            onEditBreak={(ri,uid,v)=>editBreakCI(comm.id,event.id,ri,uid,v)}
            onRegenerateBreaks={()=>regenerateBreaksCI(comm.id,event.id)}
            onRemoveFromEvent={uid=>removeFromEvent(comm.id,event.id,uid)}
            onAddEventPhoto={photo=>addEventPhoto(comm.id,event.id,photo)}
            onRemoveEventPhoto={photoId=>removeEventPhoto(comm.id,event.id,photoId)}
            onEditGuestUsr={(uid,usr)=>editGuestUsr(uid,usr)}
            onEditEventUsr={(uid,usr)=>editEventUsr(comm.id,event.id,uid,usr)}
            onStartCT={(c,f,dur,topPoolSizeOverride)=>startCT(comm.id,event.id,c,f,dur,topPoolSizeOverride)}
            onSetWinCT={(ri,mi,side,w,sA,sB)=>setWinCT(comm.id,event.id,ri,mi,side,w,sA,sB)}
            onSetCTScorers={(ri,mi,side,scorersA,scorersB)=>setCTScorers(comm.id,event.id,ri,mi,side,scorersA,scorersB)}
            onToggleCTLeagueLive={(ri,mi,side)=>toggleCTLeagueLive(comm.id,event.id,ri,mi,side)}
            onApplyPromo={()=>applyPromo(comm.id,event.id)}
            onNextFootballRound={()=>nextFootballRound(comm.id,event.id)}
            onNextCTLadder={(silent)=>nextCTLadder(comm.id,event.id,silent)}
            onSwapCTLadder={(ri,a,b)=>swapCTLadder(comm.id,event.id,ri,a,b)}
            initialTab={view.tab}
            onTabChange={t=>setView(v=>v.tab===t?v:{...v,tab:t})}
          />
        }
        {nav==="events"&&view.screen==="list"&&<EvList events={allEvents} me={me} users={users} comms={comms} venues={venues} eventCommFilter={eventCommFilter} onOpen={(cid,eid)=>{setNav("communities");go("event",{cid,eid});}} onCreateEv={(cid)=>{setNav("communities");go("createEvent",{cid});}} onBulkArchive={bulkArchiveEvents} onBulkDelete={bulkDeleteEvents}/>}
        {nav==="venues"&&view.screen==="list"&&<VenueList venues={venues} onAdd={()=>go("addVenue")} onEdit={id=>go("editVenue",{vid:id})} onBack={goBack}/>}
        {nav==="venues"&&view.screen==="addVenue"&&<VenueForm onBack={goBack} onSave={saveVenue} egypt={egypt}/>}
        {nav==="venues"&&view.screen==="editVenue"&&<VenueForm editV={venues.find(v=>v.id===view.vid)} onBack={goBack} onSave={saveVenue} egypt={egypt}/>}
        {nav==="profile"&&(()=>{const pUser=users.find(u=>u.id===(view.uid??me.id))||me;return <ProfileSc user={pUser} me={me} viewedByAdmin={!!view.uid&&view.uid!==me.id} comms={comms} onBack={goBack} onEditUser={editUser} onOpenCommunity={goComm} onOpenEvent={goEvent} onViewProfile={uid=>{setNavHistory(h=>[...h,{nav,view}]);setNav("profile");setView({screen:"profile",uid});}} onSetComboName={(partnerId,name)=>setComboName(pUser.id,partnerId,name)} usrWindowSize={usrWindowSize} egypt={egypt}/>;})()}
        {nav==="me"&&<ProfileSc user={me} me={me} comms={comms} isMeTab onOpenCommunity={goComm} onOpenEvent={goEvent} onExploreCommunities={goCommList} onEditUser={editUser} onViewProfile={uid=>{setNavHistory(h=>[...h,{nav,view}]);setNav("profile");setView({screen:"profile",uid});}} onSetComboName={(partnerId,name)=>setComboName(me.id,partnerId,name)} usrWindowSize={usrWindowSize} egypt={egypt}/>}
        {nav==="settings"&&<SettingsSc user={me} users={users} comms={comms} eventCommFilter={eventCommFilter} onSetEventCommFilter={setEventCommFilter} dark={dark} onToggleDark={()=>setDark(d=>!d)} onSendTestNotif={()=>{notify([me.id],"test",null,"🔔 Test notification",`Hey ${me.nickname}, if you see this on your lock screen, push is working!`);toast2("Sent — check your lock screen ✓");}} onBack={goBack}/>}
        {nav==="notifications"&&<NotificationsSc notifications={notifications} me={me}
          onBack={goBack} onMarkAllRead={markAllNotifRead}
          onOpen={openNotif}/>}
        {nav==="platform"&&<PlatformAdminSc onToast={msg=>toast2(msg)} users={users} comms={comms} venues={venues} uidLinks={uidLinks} onCreateInvite={createInvite} onUnlinkUser={unlinkUser} initialTab={view.tab} onTabChange={t=>setView(v=>v.tab===t?v:{...v,tab:t})} onBack={goBack} egypt={egypt} onSaveEgypt={setEgypt} expenseCategories={expenseCategories} onSaveExpenseCategories={setExpenseCategories}
          subscriptionSettings={subscriptionSettings} onSaveSubscriptionSettings={setSubscriptionSettings} onSetUserSubscription={setUserSubscription} subscriptionTransactions={subscriptionTransactions} onConfirmPayment={confirmSubscriptionPayment} onLogAudit={logAudit} onRestoreDeletedEvent={restoreDeletedEvent}
          onAddUser={u=>{
            if (nicknameTaken(u.nickname)) { toast2(`Nickname "${u.nickname}" is already used by another player`, "err"); return false; }
            if (phoneTaken(u.phone)) { toast2(`Phone ${u.phone} is already used by another player`, "err"); return false; }
            const id=_uid++;setUsers(us=>[...us,{id,...u,joined:today,avatar:ini2(u.nickname),isGuest:false,seedUsr:parseInt(u.usr)||50}]);toast2(`${u.nickname} added ✓`);return true;
          }}
          onEditUser={(id,updates)=>{
            if (nicknameTaken(updates.nickname,id)) { toast2(`Nickname "${updates.nickname}" is already used by another player`, "err"); return false; }
            if (phoneTaken(updates.phone,id)) { toast2(`Phone ${updates.phone} is already used by another player`, "err"); return false; }
            // The form's "Initial/Seed USR" field edits the seed baseline, never the live
            // .usr directly — otherwise the next event closure silently overwrites the edit
            // (closeEvent-type functions always recompute .usr from usrHistory+seedUsr, so a
            // stale seed just re-clobbers whatever was manually typed here). Recalculating the
            // live .usr from the new seed is a separate, explicitly-confirmed step — see
            // onRecalcUsr below.
            const {usr:newSeed, ...rest} = updates;
            setUsers(us=>us.map(u=>u.id===id?{...u,...rest,seedUsr:newSeed}:u));toast2("Updated ✓");return true;
          }}
          onRecalcUsr={id=>{
            setUsers(us=>us.map(u=>u.id===id?{...u,usr:calcWeightedUSR(u.usrHistory||[],u.seedUsr??u.usr,usrWindowSize)}:u));
            toast2("USR recalculated from seed ✓");
          }}
          onDeleteUser={uid=>deleteUser(uid)}
          onViewProfile={uid=>{setNavHistory(h=>[...h,{nav,view}]);setNav("profile");setView({screen:"profile",uid});}}
          onOpenCommunity={goComm} onOpenEvent={goEvent}
          onExport={exportData} onRepairIds={repairDuplicateIds} onFactoryReset={factoryReset} onBackfillGuests={backfillGuestMemberships} onCleanOrphanedLinks={cleanOrphanedLinks} onMergeDuplicateUser={mergeDuplicateUser} onSuspendUser={suspendUser} usrWindowSize={usrWindowSize} onSetUsrWindowSize={setUsrWindowSize} auditLog={[...auditLog,...auditOlder]} onRefreshAudit={refreshAudit} auditRefreshing={auditRefreshing} auditHasMore={auditHasMore} auditLoadingMore={auditLoadingMore} onLoadMoreAudit={loadMoreAudit}
          onCloneToDev={cloneToDev} cloningToDev={cloningToDev}
          backups={backups} backupsLoading={backupsLoading} onRefreshBackups={refreshBackups}
          onCreateBackup={createBackup} onRestoreBackup={restoreBackup} onDeleteBackup={deleteBackup}
        />}
      </div>
      {toast&&<div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:toast.t==="err"?"#EF4444":"#10B981",color:"#fff",padding:"10px 20px",borderRadius:8,fontSize:13,fontWeight:500,zIndex:999,whiteSpace:"nowrap",boxShadow:"0 4px 20px #00000055"}}>{toast.msg}</div>}
    </div>
  );
}

function TopBar({me,nav,menu,setMenu,onNav,onProfile,onMyCommunities,onVenues,onSettings,onPlatformAdmin,onSignOut,TH,dark,
  comms,eventCommFilter,onSetEventCommFilter,
  notifications=[],notifMenu,setNotifMenu,onMarkNotifRead,onMarkAllNotifRead,onOpenNotif,onSeeAllNotifs}){
  const myNotifs = notifications.filter(n=>n.userId===me.id);
  const unreadCount = myNotifs.filter(n=>!n.read).length;
  // Android *browser* visitor — always offer the download, they may not have the app at all.
  const isAndroidWeb = !Capacitor.isNativePlatform() && /Android/i.test(navigator.userAgent||"");
  // Native (installed APK) — this app only ships for Android, so isNativePlatform() here always
  // means "already-installed Android app". No auto-update path exists (unlike a PWA reload), so
  // it needs its own in-app download link — only surfaced once a genuinely newer build exists.
  const isNativeAndroid = Capacitor.isNativePlatform();
  // releases/latest.json is written fresh next to the APK itself at delivery time (never by
  // `npm run build`), so polling it — same pattern as the dist/version.json web-update check —
  // means this link can never point at a stale/missing file the way a hardcoded constant could.
  const [apkVersion, setApkVersion] = useState(LATEST_APK_VERSION_FALLBACK);
  const [apkVersionFetched, setApkVersionFetched] = useState(false);
  // Re-checks periodically and whenever the app comes back to the foreground — not just once at
  // cold launch (same pattern as the web new-version banner below). A native app can stay open
  // in the background for days; checking only on mount meant a real update could sit deployed
  // for a long time before the red dot ever appeared, since nothing ever re-fetched.
  useEffect(() => {
    if (!isAndroidWeb && !isNativeAndroid) return;
    let cancelled = false;
    const check = () => {
      fetch(`https://padelos-6f999.web.app/releases/latest.json?t=${Date.now()}`, { cache: "no-store" })
        .then(r => r.json())
        .then(d => { if (!cancelled) { if (d.version) setApkVersion(d.version); setApkVersionFetched(true); } })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [isAndroidWeb, isNativeAndroid]);
  const apkUrl = `https://padelos-6f999.web.app/releases/Matchkeeper-${apkVersion}-debug.apk`;
  // "Different from what's running" is the same simple signal the web new-version banner already
  // uses (dist/version.json vs APP_VERSION) — latest.json only ever holds the single current
  // release, so any mismatch (once the fetch has actually resolved) means this installed build is behind.
  const nativeUpdateAvailable = isNativeAndroid && apkVersionFetched && apkVersion !== APP_VERSION;
  const tabs = [
    {k:"events", l:"Events", chip:"#F472B6", iconColor:"#7A1042", rot:4, icon:(
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="3.5" width="18" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="2.4"/>
        <path d="M12 3.5v17" stroke="currentColor" strokeWidth="1.8" strokeDasharray="0.5 3.2" strokeLinecap="round"/>
        <circle cx="7.3" cy="14.5" r="2.1" fill="currentColor"/><circle cx="16.7" cy="8.5" r="2.1" fill="currentColor"/>
      </svg>
    )},
    {k:"me", l:"Me", chip:"#FBBF24", iconColor:"#7C4A03", rot:-4, avatar:true},
  ];
  return <div style={{background:TH?.nav||"#0E1117",borderBottom:`0.5px solid ${TH?.border||"var(--po-bdr)"}`,padding:"0 8px",display:"flex",alignItems:"center",justifyContent:"space-between",height:60,position:"sticky",top:0,left:0,right:0,width:"100%",zIndex:50,transition:"all 0.2s",boxSizing:"border-box",gap:4}}>
    <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
      <img src="/logo-icon-192.png" width={36} height={36} style={{borderRadius:9,flexShrink:0}} alt="Matchkeeper"/>
      <div style={{display:"flex",flexDirection:"column",lineHeight:1.05}}>
        <span style={{fontSize:11,fontWeight:600,color:dark?"#F1F5F9":"#FFFFFF"}}>Matchkeeper</span>
        <span style={{fontSize:8,fontWeight:400,color:dark?"#F1F5F9":"#FFFFFF",opacity:0.6}}>{APP_VERSION}{IS_DEV_ENV?" · DEV":!isNativeAndroid?" · Web":""}</span>
      </div>
    </div>
    <div style={{display:"flex",gap:6,flex:1,justifyContent:"center",minWidth:0}}>{tabs.map(t=>{
      const active = nav===t.k;
      return <button key={t.k} onClick={()=>onNav(t.k)} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px 6px 6px",borderRadius:11,border:"none",fontSize:12,fontWeight:700,cursor:"pointer",minHeight:38,background:active?"rgba(255,255,255,0.97)":"rgba(255,255,255,0.16)",transition:"all 0.15s",flexShrink:1,overflow:"hidden"}}>
        <div style={{width:26,height:26,borderRadius:t.avatar?"50%":8,background:t.avatar?"transparent":t.chip,color:t.iconColor,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transform:t.avatar?"none":`rotate(${t.rot}deg)`,overflow:"hidden"}}>
          {t.avatar ? <Av u={me} size={26}/> : React.cloneElement(t.icon,{width:17,height:17})}
        </div>
        <span style={{color:active?"#4F46E5":"rgba(255,255,255,0.92)",whiteSpace:"nowrap"}}>{t.l}</span>
      </button>;
    })}</div>
    <div style={{position:"relative",flexShrink:0}} onClick={e=>e.stopPropagation()}>
      <div onClick={()=>setNotifMenu&&setNotifMenu(o=>!o)} style={{cursor:"pointer",padding:6,position:"relative",display:"flex"}}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9a6 6 0 0 1 12 0c0 4 1.4 5.6 2 6.4H4c0.6-0.8 2-2.4 2-6.4Z" stroke={dark?"#F1F5F9":"#FFFFFF"} strokeWidth="1.8" strokeLinejoin="round" fill="none"/>
          <path d="M9.5 18a2.6 2.6 0 0 0 5 0" stroke={dark?"#F1F5F9":"#FFFFFF"} strokeWidth="1.8" strokeLinecap="round" fill="none"/>
        </svg>
        {unreadCount>0&&<div style={{position:"absolute",top:2,right:2,minWidth:15,height:15,padding:"0 3px",borderRadius:8,background:"#EF4444",color:"#fff",fontSize:9,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",border:"1.5px solid var(--po-nav,#0E1117)"}}>{unreadCount>9?"9+":unreadCount}</div>}
      </div>
      {notifMenu&&<div style={{position:"absolute",right:0,top:42,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,width:300,maxWidth:"85vw",zIndex:100,boxShadow:"0 8px 32px #00000066",overflow:"hidden"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",borderBottom:"0.5px solid var(--po-bdr)"}}>
          <span style={{fontWeight:700,fontSize:13,color:"var(--po-text)"}}>🔔 Notifications</span>
          {unreadCount>0&&<span onClick={onMarkAllNotifRead} style={{fontSize:11,color:"#6366F1",cursor:"pointer",fontWeight:600}}>Mark all read</span>}
        </div>
        <div style={{maxHeight:340,overflowY:"auto"}}>
          {myNotifs.length===0
            ? <div style={{padding:"24px 12px",textAlign:"center",fontSize:12,color:"var(--po-dim)"}}>No notifications yet</div>
            : myNotifs.slice(0,8).map(n=>
              <div key={n.id} onClick={()=>onOpenNotif&&onOpenNotif(n)} style={{padding:"10px 12px",borderBottom:"0.5px solid var(--po-bdr)",cursor:"pointer",background:n.read?"transparent":"#6366F111",display:"flex",gap:8,alignItems:"flex-start"}}>
                {!n.read&&<div style={{width:7,height:7,borderRadius:"50%",background:"#6366F1",marginTop:5,flexShrink:0}}/>}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--po-text)"}}>{n.title}</div>
                  {n.body&&<div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>{n.body}</div>}
                  <div style={{fontSize:9,color:"var(--po-dim)",marginTop:3}}>{timeAgo(n.createdAt)}</div>
                </div>
              </div>)
          }
        </div>
        {myNotifs.length>0&&<div onClick={onSeeAllNotifs} style={{padding:"9px",textAlign:"center",fontSize:12,fontWeight:600,color:"#6366F1",cursor:"pointer",borderTop:"0.5px solid var(--po-bdr)"}}>See all</div>}
      </div>}
    </div>
    <div style={{position:"relative",flexShrink:0}} onClick={e=>e.stopPropagation()}>
      <div onClick={()=>setMenu(o=>!o)} style={{cursor:"pointer",padding:6,display:"flex",position:"relative"}}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke={dark?"#F1F5F9":"#FFFFFF"} strokeWidth="1.7"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82A1.65 1.65 0 003 13.09H3a2 2 0 010-4h0a1.65 1.65 0 001.51-1A1.65 1.65 0 004.18 6.2l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 014 0v0a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V8a1.65 1.65 0 001.51 1H21a2 2 0 010 4h0a1.65 1.65 0 00-1.6 1z" stroke={dark?"#F1F5F9":"#FFFFFF"} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {nativeUpdateAvailable&&<span style={{position:"absolute",top:4,right:4,width:9,height:9,borderRadius:"50%",background:"#EF4444",border:"1.5px solid "+(TH?.nav||"#0E1117")}}/>}
      </div>
      {menu&&<div style={{position:"absolute",right:0,top:42,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:6,minWidth:190,zIndex:100,boxShadow:"0 8px 32px #00000066"}}>
        <div style={{padding:"8px 10px 10px",borderBottom:"0.5px solid var(--po-bdr)",marginBottom:4}}><div className="po-text" style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{me.nickname}</div><div className="po-dim" style={{fontSize:11,color:"var(--po-dim)"}}>USR {me.usr} · {usrLv(me.usr).l}</div></div>
        {comms&&<div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"0.5px solid var(--po-bdr)",marginBottom:4}}>
          <span style={{fontSize:12,color:"var(--po-sub)",flexShrink:0}}>👥 Events from</span>
          <select value={eventCommFilter||"all"} onChange={e=>{onSetEventCommFilter&&onSetEventCommFilter(e.target.value);}}
            style={{flex:1,background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:6,padding:"4px 6px",color:"var(--po-text)",fontSize:12,minWidth:0}}>
            <option value="all">All Communities</option>
            {comms.filter(c=>c.members.some(m=>m.userId===me.id)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>}
        {[...(me.id===1?[{i:"🛡",l:"Platform Admin",fn:onPlatformAdmin}]:[]),{i:"👥",l:"My Communities",fn:onMyCommunities},{i:"🏟",l:"Venues",fn:onVenues},{i:"⚙️",l:"Settings",fn:onSettings},...(isAndroidWeb?[{i:"📥",l:`Android App ${apkVersion}`,fn:()=>{setMenu(false);window.open(apkUrl,"_blank");}}]:[]),...(isNativeAndroid&&apkVersionFetched?[nativeUpdateAvailable?{i:"📥",l:`Update available — ${apkVersion}`,fn:()=>{setMenu(false);window.open(apkUrl,"_blank");}}:{i:"✓",l:`Up to date (${APP_VERSION})`,fn:()=>{},muted:true}]:[]),{i:"🚪",l:"Sign Out",fn:()=>{setMenu(false);onSignOut&&onSignOut();},d:true}].map(x=><button key={x.l} onClick={x.fn} style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"10px 10px",minHeight:40,borderRadius:7,border:"none",background:"transparent",color:x.d?"#EF4444":x.muted?"var(--po-dim)":"var(--po-sub)",fontSize:13,cursor:x.muted?"default":"pointer",opacity:x.muted?0.7:1,textAlign:"left"}}>{x.i} {x.l}</button>)}
      </div>}
    </div>
  </div>;
}

// ── Communities ───────────────────────────────────────
function CommList({comms,me,onOpen,onCreate}){
  const [sub,setSub]=useState("mine"),[q,setQ]=useState("");
  const mine=comms.filter(c=>c.members.some(m=>m.userId===me.id));
  const shown=comms.filter(c=>c.type==="public"&&!c.members.some(m=>m.userId===me.id)).filter(c=>!q?c.gov===me.gov||c.area===me.area:c.name.toLowerCase().includes(q.toLowerCase())||c.area.includes(q));
  function CR({c}){const act=c.members.filter(m=>m.status!=="inactive").length,my=c.members.find(m=>m.userId===me.id);return <Card style={{cursor:"pointer"}}><div onClick={()=>onOpen(c.id)} style={{display:"flex",gap:12,alignItems:"flex-start"}}><div style={{width:44,height:44,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>👥</div><div style={{flex:1,minWidth:0}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:15,color:"var(--po-text)"}}>{c.name}</span>{SEEDED_COMM_IDS.has(c.id)&&<SeedBadge/>}<Bdg label={c.type==="public"?"Public":"Private"} color={c.type==="public"?"#34D399":"var(--po-sub)"}/>{(c.sports?.length?c.sports:[DEFAULT_SPORT]).map(s=><Bdg key={s} label={sportLabel(s)} color="#A78BFA"/>)}{my&&rBdg(my.role)}</div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:2}}>📍 {c.area} · {c.gov}</div><div className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>{act} members · {c.events.length} events</div></div></div></Card>;}
  return <><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)"}}>Communities</div><Btn label="+ New" onClick={onCreate} primary/></div>
    <Tabs tabs={[["mine",`Mine (${mine.length})`],["explore","Explore"]]} active={sub} onChange={setSub}/>
    {sub==="mine"&&(mine.length===0?<Card><div style={{textAlign:"center",padding:"24px 0",color:"var(--po-dim)",fontSize:13}}><div style={{fontSize:28,marginBottom:8}}>👥</div>No communities. <span style={{color:"#6366F1",cursor:"pointer"}} onClick={()=>setSub("explore")}>Explore →</span></div></Card>:mine.map(c=><CR key={c.id} c={c}/>))}
    {sub==="explore"&&<><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search by name or area..." className="po-inp" style={{width:"100%",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box",marginBottom:8}}/>{!q&&<div style={{fontSize:11,color:"var(--po-dim)",marginBottom:10}}>📍 Near {me.area}</div>}{shown.length===0?<Card><div style={{textAlign:"center",padding:"20px 0",color:"var(--po-dim)",fontSize:13}}>No communities found.</div></Card>:shown.map(c=><CR key={c.id} c={c}/>)}</>}
  </>;
}

function SportPicker({selected,onChange,multi=true}){
  const toggle=s=>{
    if(!multi){onChange([s]);return;}
    onChange(selected.includes(s)?selected.filter(x=>x!==s):[...selected,s]);
  };
  return <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
    {SPORTS.map(s=><div key={s} onClick={()=>toggle(s)} className="po-inp" style={{padding:"8px 14px",borderRadius:20,cursor:"pointer",border:`0.5px solid ${selected.includes(s)?"#6366F1":"var(--po-bdr)"}`,background:selected.includes(s)?"#6366F122":"var(--po-inp)",color:selected.includes(s)?"#A5B4FC":"var(--po-dim)",fontSize:12,fontWeight:600}}>{selected.includes(s)?"✓ ":""}{sportLabel(s)}</div>)}
  </div>;
}
function CommForm({comm,onBack,onSave,egypt}){
  const ie=!!comm;const [f,setF]=useState({name:comm?.name||"",description:comm?.description||"",country:comm?.country||"مصر",gov:comm?.gov||"",area:comm?.area||"",type:comm?.type||"public",sports:comm?.sports?.length?comm.sports:[DEFAULT_SPORT],promoteAfter:String(comm?.promoteAfter||3),demoteAfter:String(comm?.demoteAfter||4)});const set=(k,v)=>setF(p=>({...p,[k]:v}));
  // Once a community has real events, its sport can't be changed — event-scoped data (which
  // event types were offered, footballSkill vs. usr, venue pricing per sport) is only coherent
  // for the sport the community had at the time, so switching later would strand that history.
  const sportLocked=ie&&(comm.events?.length>0);
  return <><BBtn onBack={onBack} label={ie?comm.name:"Communities"}/><div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>{ie?"Edit Community":"New Community"}</div><Card><Inp label="Name" value={f.name} onChange={v=>set("name",v)} placeholder="e.g. Maadi Padel Club"/><Inp label="Description" value={f.description} onChange={v=>set("description",v)} multiline/><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Location</div><AreaSel country={f.country} gov={f.gov} area={f.area} onChange={set} egypt={egypt}/><div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:6}}>Sport</div>
      {sportLocked
        ? <>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{f.sports.map(s=><div key={s} className="po-inp" style={{padding:"8px 14px",borderRadius:20,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-dim)",fontSize:12,fontWeight:600}}>{sportLabel(s)}</div>)}</div>
            <div style={{fontSize:11,color:"#F59E0B",marginTop:4}}>🔒 Locked — this community already has events, so changing its sport now would strand that playing history.</div>
          </>
        : <>
            <SportPicker selected={f.sports} onChange={v=>set("sports",v)} multi={false}/>
            <div style={{fontSize:11,color:"var(--po-dim)",marginTop:4}}>Each community is built around one sport — its members, events, and ledger all live under it. Changeable until the first event is created.</div>
          </>
      }
    </div><div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:6}}>Visibility</div>{["public","private"].map(t=><div key={t} onClick={()=>set("type",t)} className="po-inp" style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:"pointer",border:`0.5px solid ${f.type===t?"#6366F1":"var(--po-bdr)"}`,background:f.type===t?"#6366F122":"var(--po-inp)"}}><div style={{fontWeight:600,fontSize:13,color:f.type===t?"#A5B4FC":"var(--po-text)",marginBottom:2,textTransform:"capitalize"}}>{t}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{t==="public"?"Discoverable · anyone can request · Admin approves":"Hidden · invitation only"}</div></div>)}</div>
    <div style={{marginBottom:14}}>
      <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:6}}>Casual ↔ Regular thresholds</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <Inp label="Promote after (consecutive attends)" value={f.promoteAfter} onChange={v=>set("promoteAfter",v)} type="number"/>
        <Inp label="Demote after (consecutive misses)" value={f.demoteAfter} onChange={v=>set("demoteAfter",v)} type="number"/>
      </div>
      <div style={{fontSize:11,color:"var(--po-dim)",marginTop:4}}>Applied automatically whenever an event is closed. Admins can also override any member's status manually from the Members tab. Set "Promote after" to <b>0</b> to skip the casual stage entirely — new members join straight in as Regular.</div>
    </div>
    <Btn label={ie?"Save Changes":"Create Community"} primary onClick={()=>{if(f.name&&f.country&&f.gov&&f.area&&f.sports.length){const pa=parseInt(f.promoteAfter),da=parseInt(f.demoteAfter);onSave({...f,promoteAfter:isNaN(pa)?3:Math.max(0,pa),demoteAfter:isNaN(da)?4:Math.max(0,da)});}}} style={{width:"100%"}}/></Card></>;
}

// Community-wide report — aggregate numbers (events/matches/venues/attendance), separate from
// CommStatsTab's per-member leaderboard below it. Pure/read-only, computed on demand.
function CommOverview({comm, venues}){
  const now = new Date();
  const visibleEvents = comm.events.filter(ev=>!ev.archived && !ev.deleted && ev.status!=="cancelled");
  if (visibleEvents.length===0) return <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No events yet — reports will appear once this community starts running events.</div></Card>;
  const completedEvents = visibleEvents.filter(ev=>ev.status==="completed");
  const totalMatches = completedEvents.reduce((n,ev)=>n+countMatchesPlayed(ev),0);

  const venueCounts = {};
  visibleEvents.forEach(ev=>{ if(ev.venueId!=null) venueCounts[ev.venueId]=(venueCounts[ev.venueId]||0)+1; });
  const venueRows = Object.entries(venueCounts)
    .map(([vid,count])=>({venue:venues.find(v=>v.id===parseInt(vid)), count}))
    .filter(r=>r.venue)
    .sort((a,b)=>b.count-a.count);
  const maxVenueCount = venueRows[0]?.count||1;

  const founded = comm.founded ? new Date(comm.founded) : null;
  const ageMonths = founded ? Math.max(1, Math.round((now-founded)/(1000*60*60*24*30))) : 1;
  const eventsPerMonth = (visibleEvents.length/ageMonths).toFixed(1);

  const withCap = visibleEvents.filter(ev=>getMaxPlayers(ev));
  const avgFillRate = withCap.length ? Math.round(withCap.reduce((s,ev)=>s+Math.min(1,ev.registrations.length/getMaxPlayers(ev)),0)/withCap.length*100) : null;
  const withWaitlist = visibleEvents.filter(ev=>splitRegsByCapacity(ev,comm).waitlisted.length>0).length;
  const waitlistRate = visibleEvents.length ? Math.round(withWaitlist/visibleEvents.length*100) : 0;
  const completedWithRegs = completedEvents.filter(ev=>ev.registrations.length>0);
  const noShowRate = completedWithRegs.length ? Math.round(completedWithRegs.reduce((s,ev)=>{
    const noShows = ev.registrations.filter(r=>!ev.checkedIn.includes(r.userId)).length;
    return s + noShows/ev.registrations.length;
  },0)/completedWithRegs.length*100) : null;

  const months = Array.from({length:6},(_,i)=>{
    const d=new Date(now.getFullYear(), now.getMonth()-5+i, 1);
    return {key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`, label:d.toLocaleDateString("en",{month:"short"})};
  });
  const monthCounts = months.map(m=>({...m, count: visibleEvents.filter(ev=>ev.date&&ev.date.startsWith(m.key)).length}));
  const maxMonthCount = Math.max(1,...monthCounts.map(m=>m.count));

  return <>
    <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>📊 Overview</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:12}}>
      {[["Events",visibleEvents.length],["Matches",totalMatches],["Venues",venueRows.length],["Events/mo",eventsPerMonth]].map(([l,v])=>
        <div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 4px",textAlign:"center"}}>
          <div style={{fontSize:15,fontWeight:700,color:"var(--po-text)"}}>{v}</div>
          <div style={{fontSize:9,color:"var(--po-dim)",marginTop:1}}>{l}</div>
        </div>
      )}
    </div>

    <Card style={{marginBottom:12}}>
      <div style={{fontSize:12,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Activity — last 6 months</div>
      <div style={{display:"flex",alignItems:"flex-end",gap:6,height:60}}>
        {monthCounts.map(m=>
          <div key={m.key} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            <div style={{width:"100%",background:"#6366F1",borderRadius:"4px 4px 0 0",height:`${Math.max(4,(m.count/maxMonthCount)*44)}px`,opacity:m.count?1:0.15}}/>
            <div style={{fontSize:9,color:"var(--po-dim)"}}>{m.label}</div>
          </div>
        )}
      </div>
    </Card>

    {venueRows.length>0&&<Card style={{marginBottom:12}}>
      <div style={{fontSize:12,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Venues Used</div>
      {venueRows.slice(0,5).map(r=>
        <div key={r.venue.id} style={{marginBottom:8}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--po-text)",marginBottom:3}}>
            <span>{r.venue.name}</span><span style={{color:"var(--po-dim)"}}>{r.count} event{r.count!==1?"s":""}</span>
          </div>
          <div style={{height:5,background:"var(--po-bdr)",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${(r.count/maxVenueCount)*100}%`,background:"#34D399",borderRadius:3}}/>
          </div>
        </div>
      )}
      {venueRows.length>5&&<div style={{fontSize:11,color:"var(--po-dim)"}}>+{venueRows.length-5} more</div>}
    </Card>}

    <Card style={{marginBottom:12}}>
      <div style={{fontSize:12,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Attendance Health</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
        {[["Avg. Fill", avgFillRate!=null?`${avgFillRate}%`:"—"],["No-Show", noShowRate!=null?`${noShowRate}%`:"—"],["Waitlisted", `${waitlistRate}%`]].map(([l,v])=>
          <div key={l} style={{textAlign:"center"}}>
            <div style={{fontSize:15,fontWeight:700,color:"var(--po-text)"}}>{v}</div>
            <div style={{fontSize:9,color:"var(--po-dim)",marginTop:1}}>{l}</div>
          </div>
        )}
      </div>
      <div style={{fontSize:10,color:"var(--po-dim)",marginTop:8}}>Fill = registered ÷ capacity, averaged across events with a set capacity. No-show = registered but never checked in, averaged across completed events. Waitlisted = share of events that filled up and had at least one person on the waitlist.</div>
    </Card>
  </>;
}
function CommStatsTab({comm, users, onViewProfile}){
  const [view, setView] = useState("usr");
  const [perEvent, setPerEvent] = useState(false); // false=Total, true=Per Event — only relevant for additive stats (wins, pts)
  const members = comm.members.map(m=>users.find(u=>u.id===m.userId)).filter(Boolean);
  const completedEvents = comm.events.filter(ev=>ev.status==="completed"&&ev.plan);

  // Build stats per member
  const ciCache = {}, ctCache = {};
  completedEvents.forEach(ev=>{
    if(ev.type==="closed_ind"&&ev.plan) ciCache[ev.id]=calcCIStandings(ev.plan,users);
    if(ev.type==="closed_teams"&&ev.plan) ctCache[ev.id]=calcCTStandings(ev.plan);
  });
  const stats = members.map(u=>{
    let participations=0, wins=0, totalPts=0, totalMaxPts=0;
    completedEvents.forEach(ev=>{
      const reg=ev.registrations?.find(r=>r.userId===u.id);
      if(!reg) return;
      participations++;
      if(ev.type==="closed_ind"&&ev.plan){
        const stands=ciCache[ev.id];
        const s=stands.find(s=>s.user.id===u.id);
        if(s){wins+=s.wins; totalPts+=s.pts; totalMaxPts+=personalMaxCI(s.breaks,personalRoundsCI(u.id,ev.plan),ev.plan.courts);}
      }
      if(ev.type==="closed_teams"&&ev.plan){
        const stands=ctCache[ev.id];
        const team=ev.plan.teams?.find(t=>t.players?.some(p=>p.userId===u.id));
        const s=stands.find(s=>s.team?.id===team?.id);
        if(s){wins+=s.wins; totalPts+=s.pts;}
        if(ev.plan.format==="ladder") totalMaxPts+=ctTeamMaxPts(team?.id,ev.plan);
      }
    });
    return {user:u, participations, wins, totalPts, totalMaxPts};
  });

  const perEv=(n,s)=>s.participations>0?(n/s.participations):0;
  const views={
    usr:{label:"🏆 USR Rank", sort:(a,b)=>b.user.usr-a.user.usr, val:s=>`USR ${s.user.usr}`, sub:s=>usrLv(s.user.usr).l, hasPerEvent:false},
    events:{label:"📅 Participations", sort:(a,b)=>b.participations-a.participations, val:s=>`${s.participations} events`, sub:()=>"", hasPerEvent:false},
    wins:{label:"⚡ Most Wins", sort:(a,b)=>perEvent?perEv(b.wins,b)-perEv(a.wins,a):b.wins-a.wins, val:s=>perEvent?`${perEv(s.wins,s).toFixed(1)} wins/ev`:`${s.wins} wins`, sub:s=>perEvent?`${s.wins} total over ${s.participations} events`:"", hasPerEvent:true},
    pts:{label:"💯 Most Points", sort:(a,b)=>perEvent?perEv(b.totalPts,b)-perEv(a.totalPts,a):b.totalPts-a.totalPts, val:s=>perEvent?`${perEv(s.totalPts,s).toFixed(1)} pts/ev`:`${s.totalPts} pts`, sub:s=>perEvent?`${s.totalPts} total over ${s.participations} events`:"", hasPerEvent:true},
  };

  const sorted=[...stats].sort(views[view].sort);

  return <>
    <select value={view} onChange={e=>setView(e.target.value)} className="po-inp"
      style={{width:"100%",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"10px 12px",fontSize:13,fontWeight:600,color:"var(--po-text)",marginBottom:10}}>
      {Object.entries(views).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
    </select>
    {views[view].hasPerEvent&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:"8px 12px",marginBottom:12}}>
      <span style={{fontSize:12,color:"var(--po-text)"}}>View</span>
      <div style={{display:"flex",background:"var(--po-inp)",borderRadius:8,padding:2}}>
        <div onClick={()=>setPerEvent(false)} style={{padding:"5px 12px",fontSize:11,fontWeight:600,borderRadius:6,cursor:"pointer",background:!perEvent?"#6366F1":"transparent",color:!perEvent?"#fff":"var(--po-dim)"}}>Total</div>
        <div onClick={()=>setPerEvent(true)} style={{padding:"5px 12px",fontSize:11,fontWeight:600,borderRadius:6,cursor:"pointer",background:perEvent?"#6366F1":"transparent",color:perEvent?"#fff":"var(--po-dim)"}}>Per Event</div>
      </div>
    </div>}
    {sorted.map((s,i)=>{
      const lv=usrLv(s.user.usr);
      const medal=i===0?"🥇":i===1?"🥈":i===2?"🥉":`${i+1}.`;
      return <Card key={s.user.id} style={{marginBottom:6}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontSize:18,width:28,textAlign:"center",flexShrink:0}}>{medal}</div>
          <div style={{cursor:onViewProfile?"pointer":"default"}} onClick={()=>onViewProfile&&onViewProfile(s.user.id)}><Av u={s.user} size={34}/></div>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{s.user.nickname}</div>
            <div style={{fontSize:11,color:"var(--po-dim)"}}>{views[view].sub(s)}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:16,fontWeight:700,color:lv.c}}>{views[view].val(s)}</div>
          </div>
        </div>
      </Card>;
    })}
  </>;
}

// Shared "here's your link" popup for any invite (community or event) — copy or hand off to
// the native share sheet (WhatsApp etc). Works for a brand-new recipient or an existing one;
// the app resolves what to do with it on open (see the invite-handling effects up top).
// Enhancement #31 — the invite message was one generic line ("Join me on Matchkeeper — tap to
// open:") regardless of what the invite was actually for. Every invite already carries a
// `label` describing exactly that (createInvite's label — "Join {event}", "Join {community}",
// "Join Matchkeeper as {nickname}") but it was only ever stored, never shown to the sender or
// put in the shared message. Now it drives both the on-screen heading and the share text.
function InviteModal({url,label,onClose}){
  const [copied,setCopied]=useState(false);
  const copy=async()=>{
    try{ await navigator.clipboard.writeText(url); setCopied(true); setTimeout(()=>setCopied(false),1500); }
    catch(e){ console.log("Clipboard copy failed", e); }
  };
  const shareTitle = label ? `${label} on Matchkeeper` : "Join me on Matchkeeper";
  const shareText = label
    ? `${label} on Matchkeeper — tap the link to jump straight in, no account hassle if you don't have one yet:`
    : "Join me on Matchkeeper — tap to open:";
  const share=async()=>{
    try{ await Share.share({title:shareTitle,text:shareText,url}); }
    catch(e){ console.log("Share failed", e); }
  };
  return <div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:"var(--po-card)",borderRadius:14,padding:20,maxWidth:360,width:"100%",boxShadow:"0 12px 32px rgba(0,0,0,0.4)"}}>
      <div style={{fontSize:16,fontWeight:700,color:"var(--po-text)",marginBottom:4}}>🔗 {label||"Invite Link"}</div>
      <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:14}}>Share this with anyone — works whether they already have Matchkeeper or not.</div>
      <div style={{background:"var(--po-inp)",borderRadius:8,padding:"10px 12px",fontSize:12,color:"var(--po-text)",wordBreak:"break-all",marginBottom:14,fontFamily:"monospace"}}>{url}</div>
      <div style={{display:"flex",gap:8}}>
        <Btn label={copied?"✓ Copied":"📋 Copy"} onClick={copy} style={{flex:1}}/>
        <Btn label="📤 Share" primary onClick={share} style={{flex:1}}/>
      </div>
      <div onClick={onClose} style={{textAlign:"center",fontSize:12,color:"var(--po-dim)",cursor:"pointer",marginTop:14}}>Close</div>
    </div>
  </div>;
}

function CommDetail({comm,users,venues,me,uidLinks,onBack,onEdit,onApprove,onReject,onRequestJoin,onPromote,onDemote,onKick,onToggleStatus,onConvertGuest,onInvite,onOpenEv,onCreateEv,onViewProfile,onCreateInvite,onTransferOwnership,initialTab,onTabChange,onSetBookkeeping,onAddLedgerEntry,onAddLedgerEntries,onDeleteLedgerEntry,onSetFootballSkill,expenseCategories,onPostAnnouncement,onDeleteAnnouncement,onReplyAnnouncement,onDeleteAnnouncementReply,onSetBanner,onRemoveBanner,godMode}){
  const [tab,setTab]=useState(initialTab||"members");
  useEffect(()=>{ onTabChange&&onTabChange(tab); }, [tab]);
  const [showInvite,setShowInvite]=useState(false);
  const [inviteUrl,setInviteUrl]=useState(null);
  const [openMemberMenu,setOpenMemberMenu]=useState(null); // userId whose kebab menu is currently open
  const [memberSearch,setMemberSearch]=useState("");
  const [announcementText,setAnnouncementText]=useState("");
  const [bannerUploading,setBannerUploading]=useState(false);
  // Measured client-side from the actual image (not stored anywhere) — so this works
  // retroactively for banners already uploaded before this existed, no data migration needed.
  // Resets whenever the photo itself changes so a re-upload gets re-measured, not stuck on the
  // previous photo's aspect ratio.
  const [bannerAspect,setBannerAspect]=useState(null);
  useEffect(()=>{ setBannerAspect(null); }, [comm.bannerURL]);
  // A square/portrait photo (most logos) letterboxed into the normal 110px landscape slot reads
  // tiny — grow the slot toward a friendlier aspect ratio instead, capped at 3x height (per the
  // owner's explicit call: "not more than triple") so an extreme portrait can't take over the
  // whole screen. A wide/landscape photo close to the default slot's own ratio needs no help.
  const bannerHeight = !comm.bannerURL || bannerAspect==null ? 110 : bannerAspect>=3 ? 110 : bannerAspect>=1.5 ? 220 : 330;
  const [bannerError,setBannerError]=useState("");
  const [showBannerMenu,setShowBannerMenu]=useState(false);
  // A misconfigured/unprovisioned Storage bucket (found live on padelos-dev — Storage was never
  // set up there at all) can leave the underlying upload promise neither resolving nor rejecting
  // for a long time instead of failing fast, which left the pencil stuck on ⏳ forever with no
  // feedback. The 20s timeout guarantees this always resolves one way or the other, and the
  // error message actually tells the admin something went wrong instead of just spinning.
  const handleBannerSelect = async (e) => {
    const file = e.target.files[0]; e.target.value="";
    if (!file) return;
    setShowBannerMenu(false);
    setBannerUploading(true);
    setBannerError("");
    try{
      const url = await Promise.race([
        uploadCommunityBanner(comm.id, file),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error("timeout")), 20000)),
      ]);
      onSetBanner&&onSetBanner(url);
    } catch(err){
      console.log("Banner upload error", err);
      setBannerError("Couldn't upload the banner — check your connection and try again.");
    }
    setBannerUploading(false);
  };
  const [replyingTo,setReplyingTo]=useState(null); // announcement id whose reply box is open
  const [replyText,setReplyText]=useState("");
  const myMember=comm.members.find(m=>m.userId===me.id);
  const myRole=myMember?.role;
  const meIsPlatformAdmin=me?.id===1;
  // God Mode: Platform Admin gets full admin authority here regardless of real membership —
  // see the App-level godMode state and the matching second-confirm gate in updC.
  const isAdmin=myRole==="owner"||myRole==="admin"||(meIsPlatformAdmin&&godMode);
  const isMember=!!myRole;
  // "Private" was previously cosmetic — a non-member could see the full roster, stats, and
  // events regardless. Platform Admin can always see through it for oversight. A guest-tier
  // member (e.g. auto-added via an event invite) is deliberately NOT a "real" member for this
  // purpose — the whole point of the guest tier is minimal visibility until promoted.
  const canViewPrivate=comm.type!=="private"||(isMember&&myMember.status!=="guest")||meIsPlatformAdmin;
  const hasPendingJoin=comm.joinRequests.some(r=>r.userId===me.id);
  const regs=comm.members.filter(m=>m.status!=="inactive");
  const regularCount=regs.filter(m=>m.status==="regular").length;
  const casualCount=regs.filter(m=>m.status==="casual").length;
  const guestCount=regs.filter(m=>m.status==="guest").length;
  const avgU=regs.length?Math.round(regs.reduce((s,m)=>s+(users.find(u=>u.id===m.userId)?.usr||0),0)/regs.length):0;
  // Football communities have no meaningful USR (that's padel-specific) — Avg FSR (Football
  // Skill Rating) is the equivalent, blended from footballSkill letter grades via the same
  // 0-100 scale team formation already uses, then read back as a letter via footballGradeLabel.
  const isFootballComm=comm.sports?.includes("Football");
  const avgFsr=regs.length?regs.reduce((s,m)=>{const u=users.find(u=>u.id===m.userId);return s+(u?(FOOTBALL_SKILL_RATING[u.footballSkill]??50):0);},0)/regs.length:0;
  const tdefs=[["members","Members"],["events","Events"],["announcements","📢"],["stats","Reports"],...((comm.bookkeeping?.enabled||isAdmin)?[["ledger","💰 Ledger"]]:[]),...(isAdmin?[["requests",`Requests${comm.joinRequests.length>0?` (${comm.joinRequests.length})`:""}`]]:[])];
  const statusOrder={regular:0,casual:1,inactive:2,guest:3},roleOrder={owner:0,admin:1,member:2};
  const sortedMembersAll=[...comm.members].sort((a,b)=>{if(roleOrder[a.role]!==roleOrder[b.role])return roleOrder[a.role]-roleOrder[b.role];return(statusOrder[a.status]||0)-(statusOrder[b.status]||0);});
  const memberQ=memberSearch.trim().toLowerCase();
  const sortedMembers=memberQ?sortedMembersAll.filter(m=>users.find(u=>u.id===m.userId)?.nickname?.toLowerCase().includes(memberQ)):sortedMembersAll;
  const nonMembers=users.filter(u=>!comm.members.some(m=>m.userId===u.id));

  const commSports=comm.sports?.length?comm.sports:[DEFAULT_SPORT];
  const primarySport=commSports[0];
  const [gradFrom,gradTo]=SPORT_GRADIENT[primarySport]||SPORT_GRADIENT[DEFAULT_SPORT];
  // Deliberately its own inline pill row rather than the shared <Tabs> component — <Tabs> is
  // also EvDetail's tab bar (and My Communities/Events list's sub-toggles), so reusing it here
  // would just recreate the "looks the same as the event screen" problem this redesign exists
  // to fix. See CLAUDE.md-adjacent history: admin flagged Community vs Event as visually
  // confusable despite different content — this screen's whole shape (cover banner + watermark
  // + overlapping avatar + scrollable pill tabs) is intentionally unlike EvDetail's compact card.
  return <><BBtn onBack={onBack} label="Communities" sticky subLabel={tab==="members"?"Members":tab==="events"?"Events":"Requests"}/>
    {/* position:relative here is load-bearing: without it, the absolutely-positioned watermark
        below has no containing block of its own, escapes all the way up to the viewport, and
        renders as a giant emoji floating across the whole page (seen in the top bar and past
        the card) instead of staying clipped inside this banner. */}
    <div style={{height:bannerHeight,borderRadius:"16px 16px 0 0",overflow:"hidden",position:"relative",padding:"0 16px",display:"flex",alignItems:"flex-end",background:comm.bannerURL?"#000":`linear-gradient(135deg, ${gradFrom}, ${gradTo})`,transition:"height 0.2s"}}>
      {/* Custom photo (admin-uploaded) replaces the sport gradient + watermark entirely. A square
          or portrait photo (a logo, most commonly) into this landscape slot used to get cropped
          via cover — chopping off logo text/edges. Same "letterbox" trick Instagram/Spotify use
          for a square-into-landscape mismatch instead: a blurred, darkened, oversized copy of
          the SAME photo fills the backdrop (never a flat/mismatched color), while the real photo
          sits on top at its full, uncropped aspect ratio — and the slot itself grows toward a
          friendlier height (bannerHeight above) instead of just shrinking the photo down small.
          No custom photo → unchanged default gradient + watermark. */}
      {comm.bannerURL
        ? <>
            <div style={{position:"absolute",inset:-14,backgroundImage:`url(${comm.bannerURL})`,backgroundSize:"cover",backgroundPosition:"center",filter:"blur(16px) brightness(0.55)",transform:"scale(1.15)"}}/>
            <img src={comm.bannerURL} alt="" onLoad={e=>setBannerAspect(e.target.naturalWidth/e.target.naturalHeight)} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain"}}/>
            <div style={{position:"absolute",inset:0,background:"linear-gradient(180deg,rgba(0,0,0,0.05) 40%,rgba(0,0,0,0.55) 100%)"}}/>
          </>
        : <div style={{position:"absolute",fontSize:88,opacity:0.20,right:10,top:6,lineHeight:1,transform:"rotate(-10deg)",filter:"brightness(1.4)",pointerEvents:"none"}}>{SPORT_EMOJI[primarySport]||"🏅"}</div>}
      <div style={{position:"relative",zIndex:1,fontSize:10,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#fff",opacity:0.85,marginBottom:14}}>Community · {commSports.join(" + ")}</div>
      {/* Available to every community owner/admin, same isAdmin gate as the rest of this screen's
          admin controls — God Mode grants full authority everywhere by design, banners included. */}
      {isAdmin&&<div style={{position:"absolute",top:10,right:10,zIndex:2}} onClick={e=>e.stopPropagation()}>
        <div onClick={()=>!bannerUploading&&setShowBannerMenu(o=>!o)} title="Community Banner" style={{width:32,height:32,borderRadius:"50%",background:"rgba(0,0,0,0.45)",backdropFilter:"blur(4px)",border:"1px solid rgba(255,255,255,0.25)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,cursor:bannerUploading?"default":"pointer",color:"#fff"}}>{bannerUploading?"⏳":"✏️"}</div>
        {showBannerMenu&&<div style={{position:"absolute",top:38,right:0,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:6,display:"flex",flexDirection:"column",gap:4,minWidth:190,boxShadow:"0 4px 16px rgba(0,0,0,0.3)"}}>
          <label style={{display:"flex",alignItems:"center",gap:8,padding:"9px 10px",borderRadius:7,cursor:"pointer",fontSize:13,color:"var(--po-sub)"}}>
            <input type="file" accept="image/*" style={{display:"none"}} onChange={handleBannerSelect}/>
            📷 {comm.bannerURL?"Change Photo":"Upload Photo"}
          </label>
          {comm.bannerURL&&<div onClick={()=>{setShowBannerMenu(false);if(window.confirm("Remove the custom banner and go back to the default sport gradient?"))onRemoveBanner&&onRemoveBanner();}} style={{padding:"9px 10px",borderRadius:7,cursor:"pointer",fontSize:13,color:"#EF4444"}}>↩️ Remove — use default</div>}
        </div>}
      </div>}
    </div>
    {bannerError&&<div style={{fontSize:11,color:"#EF4444",background:"#EF444411",borderRadius:8,padding:"7px 10px",marginTop:8}}>⚠️ {bannerError}</div>}
    {/* position:relative + zIndex here is a pure stacking-order fix, doesn't move anything —
        without an explicit z-index, Card has none applied (z-index needs a non-static position
        to take effect at all), so exactly where it lands in the paint order versus the banner's
        watermark was up to chance. This guarantees the avatar (inside Card) always paints above
        the ball, not the other way around. */}
    <Card style={{borderRadius:"0 0 16px 16px",marginTop:0,paddingTop:0,position:"relative",zIndex:2}}>
      {/* Avatar is a normal-flow child of Card itself (pulled up with a negative margin), not a
          separately-positioned overlay — it used to sit in its own absolutely-positioned wrapper
          outside Card, and while the math looked right on paper, it rendered visibly off from
          the "Public" badge below it. Being an actual sibling inside Card's own padding removes
          any room for that drift: both rows now share literally the same padding-right. */}
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:-32,marginBottom:10}}>
        <div style={{width:64,height:64,borderRadius:18,background:"var(--po-card)",border:"3px solid var(--po-card)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,boxShadow:"0 6px 14px #00000044",flexShrink:0}}>👥</div>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:4}}>
        <div style={{fontSize:22,fontWeight:800,lineHeight:1.1,letterSpacing:-0.4,color:"var(--po-text)"}}>{comm.name}{SEEDED_COMM_IDS.has(comm.id)&&<> <SeedBadge/></>}</div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}><Bdg label={comm.type==="public"?"Public":"Private"} color={comm.type==="public"?"#34D399":"var(--po-sub)"}/>{myRole==="owner"&&<SmBtn label="✏️" onClick={onEdit} color="#6366F1"/>}</div>
      </div>
      <div style={{fontSize:12,color:"var(--po-dim)"}}>📍 {comm.area} · {comm.gov} · {comm.country||"مصر"} · Founded {fmtD(comm.founded)}</div>
      <div style={{fontSize:13,color:"var(--po-sub)",marginTop:10}}>{comm.description}</div>
      {!isMember&&<div style={{marginTop:14}}>
        {hasPendingJoin
          ? <div style={{textAlign:"center",fontSize:13,fontWeight:600,color:"var(--po-dim)",background:"var(--po-inp)",borderRadius:8,padding:"10px 0"}}>⏳ Request pending approval</div>
          : <Btn label="+ Request to Join" primary onClick={onRequestJoin} style={{width:"100%"}}/>}
      </div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginTop:14}}>{[["Members",regs.length],["Events",comm.events.length],isFootballComm?["Avg FSR",footballGradeLabel(avgFsr)]:["Avg USR",avgU||"—"],["Requests",comm.joinRequests.length]].map(([l,v])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 0",textAlign:"center"}}><div style={{fontSize:16,fontWeight:700,color:"var(--po-text)"}}>{v}</div><div style={{fontSize:10,color:"var(--po-dim)",marginTop:1}}>{l}</div>{l==="Members"&&<div style={{display:"flex",justifyContent:"center",gap:5,marginTop:3,flexWrap:"wrap"}}>{[["#34D399",regularCount],["#FBBF24",casualCount],["#F59E0B",guestCount]].filter(([,n])=>n>0).map(([c,n])=><span key={c} style={{fontSize:9,color:"var(--po-dim)",display:"flex",alignItems:"center",gap:2}}><span style={{width:5,height:5,borderRadius:"50%",background:c,display:"inline-block"}}/>{n}</span>)}</div>}</div>)}</div>
    </Card>
    {/* Own layout (not the shared TwoRowTabs component) so it keeps this screen's pill look —
        TwoRowTabs is the boxed/indigo style shared with EvDetail; reusing it here would make
        Community and Event tabs identical again, undoing the whole point of this redesign.
        Real CSS flex-wrap rather than a manual even split: row 1 fills with as many pills as
        actually fit its width, only the overflow wraps to row 2 — an even split (ceil(n/2) each)
        left row 1 with empty space while row 2 crowded, which looked wrong for pills whose
        widths vary by label length (unlike TwoRowTabs' equal-stretch boxes, where an even split
        is correct since every row always fills exactly). */}
    <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:18}}>
      {tdefs.map(([k,l])=><div key={k} onClick={()=>setTab(k)} style={{padding:"7px 14px",borderRadius:20,fontSize:11.5,fontWeight:700,whiteSpace:"nowrap",cursor:"pointer",background:tab===k?"var(--po-text)":"var(--po-inp)",color:tab===k?"var(--po-bg)":"var(--po-dim)",transition:"all 0.15s"}}>{l}</div>)}
    </div>

    {tab==="members"&&<>
      {!canViewPrivate?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>🔒 This is a private community — request to join to see the member list.</div></Card>:<>
      {regs.length>6&&<input value={memberSearch} onChange={e=>setMemberSearch(e.target.value)} placeholder="🔍 Search members..." className="po-inp" style={{width:"100%",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box",marginBottom:12}}/>}
      {isAdmin&&<>
        <div style={{display:"flex",gap:6,marginBottom:12}}>
          <SmBtn label={showInvite?"▲ Hide":"+ Invite Platform User"} onClick={()=>setShowInvite(o=>!o)} color="#6366F1" style={{flex:1}}/>
          {onCreateInvite&&<SmBtn label="🔗 Invite Link" onClick={()=>{const label=`Join ${comm.name}`;setInviteUrl({url:`${INVITE_BASE_URL}/?invite=${onCreateInvite({communityId:comm.id,label})}`,label});}} color="#34D399" style={{flex:1}}/>}
        </div>
        {inviteUrl&&<InviteModal url={inviteUrl.url} label={inviteUrl.label} onClose={()=>setInviteUrl(null)}/>}
        {showInvite&&nonMembers.length>0&&<Card style={{marginBottom:12}}>
          {nonMembers.map(u=><div key={u.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
            <Av u={u} size={28}/><div style={{flex:1}}><span style={{fontSize:12,fontWeight:500,color:"var(--po-text)"}}>{u.nickname}</span><span style={{fontSize:11,color:"var(--po-dim)",marginLeft:6}}>{isFootballComm?`FSR ${u.footballSkill||"Not Rated"}`:`USR ${u.usr}`} · {u.area}</span></div>
            <SmBtn label="+ Add" onClick={()=>{onInvite(u.id);setShowInvite(false);}} color="#6366F1"/>
          </div>)}
        </Card>}
      </>}
      {memberQ&&sortedMembers.length===0&&<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No members match "{memberSearch}"</div></Card>}
      {["owner","admin","member"].map(rf=>{
        const list=sortedMembers.filter(m=>m.role===rf);if(!list.length)return null;
        return <div key={rf}><ST>{rf==="owner"?"Owner":rf==="admin"?"Admins":"Members"}</ST>
          {list.map(m=>{const u=users.find(u=>u.id===m.userId);if(!u)return null;const isMe=u.id===me.id;return(
            <Card key={m.userId} style={{cursor:"pointer"}}><div onClick={()=>onViewProfile(u.id)} style={{display:"flex",alignItems:"center",gap:10}}>
              <Av u={u} size={38}/>
              <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{u.nickname}</span>{sBdg(m.status)}{isMe&&<Bdg label="You" color="#6366F1"/>}</div>
                {/* USR is padel-specific — football communities show FSR (footballSkill) instead,
                    never both. Community admins can set FSR directly (not Platform-Admin-only,
                    unlike padel's USR) — it's manually-assigned player data the community's own
                    admin owns, not a computed rating needing the same protection. */}
                {isFootballComm
                  ? (isAdmin
                      ? <div onClick={e=>e.stopPropagation()} style={{marginTop:2,display:"flex",alignItems:"center",gap:6}}>
                          <span style={{fontSize:11,color:"var(--po-dim)"}}>⚽ FSR:</span>
                          <select value={u.footballSkill||""} onChange={e=>onSetFootballSkill(u.id,e.target.value)} className="po-inp" style={{fontSize:11,padding:"2px 6px",borderRadius:5,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)"}}>
                            <option value="">Not Rated</option>
                            {["A","B","C","D","E"].map(g=><option key={g} value={g}>{g}</option>)}
                          </select>
                        </div>
                      : <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>⚽ FSR {u.footballSkill||"Not Rated"} · {u.area}</div>)
                  : <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>🎾 USR {u.usr} · {u.area}</div>}
                {isAdmin&&<div style={{fontSize:11,color:"var(--po-dim)",marginTop:1}}>✉️ {u.email||"—"} · 📱 {u.phone||"—"}</div>}</div>
              {(isAdmin||(meIsPlatformAdmin&&m.role==="admin"))&&!isMe&&m.role!=="owner"&&<div style={{position:"relative",flexShrink:0}} onClick={e=>e.stopPropagation()}>
                <div onClick={()=>setOpenMemberMenu(o=>o===u.id?null:u.id)} style={{width:32,height:32,borderRadius:"50%",background:"var(--po-inp)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:"var(--po-dim)",cursor:"pointer"}}>⋮</div>
                {openMemberMenu===u.id&&<div style={{position:"absolute",top:38,right:0,zIndex:10,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:6,display:"flex",flexDirection:"column",gap:4,minWidth:130,boxShadow:"0 4px 16px rgba(0,0,0,0.3)"}}>
                  {onCreateInvite&&!Object.values(uidLinks||{}).includes(u.id)&&<SmBtn label="🔗 Invite" onClick={()=>{const label=`Join ${comm.name} as ${u.nickname}`;setInviteUrl({url:`${INVITE_BASE_URL}/?invite=${onCreateInvite({targetUserId:u.id,communityId:comm.id,label})}`,label});setOpenMemberMenu(null);}} color="#34D399" style={{width:"100%"}}/>}
                  {m.status==="guest"&&<SmBtn label="✓ Make Member" onClick={()=>{onConvertGuest(u.id);setOpenMemberMenu(null);}} color="#34D399" style={{width:"100%"}}/>}
                  {m.role==="member"&&m.status!=="guest"&&<SmBtn label={m.status==="regular"?"↓ Casual":"↑ Regular"} onClick={()=>{onToggleStatus(u.id);setOpenMemberMenu(null);}} color="#34D399" style={{width:"100%"}}/>}
                  {m.role==="member"&&m.status!=="guest"&&<SmBtn label="↑ Admin" onClick={()=>{onPromote(u.id);setOpenMemberMenu(null);}} color="#6366F1" style={{width:"100%"}}/>}
                  {m.role==="admin"&&onDemote&&<SmBtn label="↓ Demote to Member" onClick={()=>{if(window.confirm(`Demote ${u.nickname} to a regular member?\n\nThey'll lose admin access to this community, but keep their membership.`)){onDemote(u.id);setOpenMemberMenu(null);}}} color="#F59E0B" style={{width:"100%"}}/>}
                  {m.role==="admin"&&(myRole==="owner"||meIsPlatformAdmin)&&onTransferOwnership&&<SmBtn label="👑 Make Owner" onClick={()=>{if(window.confirm(`Make ${u.nickname} the new owner of ${comm.name}?\n\n${myRole==="owner"?"You'll":"The current owner will"} become a regular admin instead.`)){onTransferOwnership(u.id);setOpenMemberMenu(null);}}} color="#FBBF24" style={{width:"100%"}}/>}
                  <SmBtn label="Remove" onClick={()=>{if(window.confirm(`Remove ${u.nickname} from ${comm.name}?\n\nThey'll need to re-apply to join again. Their event history stays intact.`)){onKick(u.id);setOpenMemberMenu(null);}}} color="#EF4444" style={{width:"100%"}}/>
                </div>}
              </div>}
            </div></Card>
          );})}
        </div>;
      })}
      </>}
    </>}

    {tab==="events"&&<>{!canViewPrivate?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>🔒 This is a private community — request to join to see events.</div></Card>:<>{isAdmin&&<Btn label="+ New Event" primary onClick={onCreateEv} style={{width:"100%",marginBottom:12}}/>}
      {(() => { const visEvents = comm.events.filter(ev=>!ev.deleted&&(ev.visibility!=="private"||isAdmin||ev.registrations.some(r=>r.userId===me.id)));
      return visEvents.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No events yet</div></Card>:<>
        {(() => {
          const now=Date.now();
          const isFutureEv=ev=>{ if(!ev.date) return true; const t=new Date(`${ev.date}T23:59:59`).getTime(); return isNaN(t)||t>=now; };
          const evTime=ev=>{ const t=new Date(`${ev.date}T${ev.time||"00:00"}`).getTime(); return isNaN(t)?0:t; };
          const byNewestFirst=(a,b)=>evTime(b)-evTime(a);
          const upcoming=visEvents.filter(ev=>ev.status!=="cancelled"&&isFutureEv(ev)&&!ev.archived).sort(byNewestFirst);
          const pastAll=visEvents.filter(ev=>ev.status!=="cancelled"&&!isFutureEv(ev)&&!ev.archived).sort(byNewestFirst);
          const pastCompleted=pastAll.filter(ev=>ev.status==="completed");
          const pastIncomplete=pastAll.filter(ev=>ev.status!=="completed");
          const archived=visEvents.filter(ev=>ev.archived||ev.status==="cancelled").sort(byNewestFirst);
          return <>
            {upcoming.length>0?<>{upcoming.map(ev=><EvCard key={ev.id} ev={ev} me={me} users={users} onClick={()=>onOpenEv(ev.id)}/>)}</>
              :<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No upcoming events</div></Card>}
            {pastIncomplete.length>0&&<CollapsibleSection label={`⏳ Incomplete (${pastIncomplete.length})`} defaultOpen={false}>
              {pastIncomplete.map(ev=><EvCard key={ev.id} ev={ev} me={me} users={users} onClick={()=>onOpenEv(ev.id)}/>)}
            </CollapsibleSection>}
            {pastCompleted.length>0&&<CollapsibleSection label={`✅ Completed (${pastCompleted.length})`} defaultOpen={false}>
              {pastCompleted.map(ev=><EvCard key={ev.id} ev={ev} me={me} users={users} onClick={()=>onOpenEv(ev.id)}/>)}
            </CollapsibleSection>}
            {isAdmin&&archived.length>0&&<CollapsibleSection label={`📦 Archived (${archived.length})`} defaultOpen={false}>
              {archived.map(ev=><EvCard key={ev.id} ev={ev} me={me} users={users} onClick={()=>onOpenEv(ev.id)}/>)}
            </CollapsibleSection>}
          </>;
        })()}
      </>; })()}
      </>}
    </>}
    {tab==="announcements"&&<>
      {isAdmin&&<Card style={{marginBottom:12}}>
        <Inp label="Post an announcement" value={announcementText} onChange={setAnnouncementText} placeholder="e.g. Court change this week, new pricing, event reminder..." multiline/>
        <Btn label="📢 Post to everyone" primary onClick={()=>{if(announcementText.trim()){onPostAnnouncement&&onPostAnnouncement(announcementText);setAnnouncementText("");}}} style={{width:"100%"}}/>
      </Card>}
      {(comm.announcements?.length||0)===0
        ? <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No announcements yet.</div></Card>
        : [...comm.announcements].reverse().map(a=>
            <Card key={a.id} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,color:"var(--po-text)",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{a.message}</div>
                  <div style={{fontSize:10,color:"var(--po-dim)",marginTop:6}}>{a.authorName} · {timeAgo(a.createdAt)}</div>
                </div>
                {isAdmin&&<SmBtn label="✕" onClick={()=>{if(window.confirm("Remove this announcement?"))onDeleteAnnouncement&&onDeleteAnnouncement(a.id);}} color="#EF4444" style={{padding:"4px 8px",fontSize:11,flexShrink:0}}/>}
              </div>
              {(a.replies?.length||0)>0&&<div style={{marginTop:10,paddingTop:8,borderTop:"0.5px solid var(--po-bdr)",display:"flex",flexDirection:"column",gap:8}}>
                {a.replies.map(r=>
                  <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:6,paddingLeft:10}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,color:"var(--po-text)",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{r.message}</div>
                      <div style={{fontSize:9,color:"var(--po-dim)",marginTop:3}}>{r.authorName} · {timeAgo(r.createdAt)}</div>
                    </div>
                    {isAdmin&&<SmBtn label="✕" onClick={()=>{if(window.confirm("Remove this reply?"))onDeleteAnnouncementReply&&onDeleteAnnouncementReply(a.id,r.id);}} color="#EF4444" style={{padding:"3px 6px",fontSize:10,flexShrink:0}}/>}
                  </div>
                )}
              </div>}
              <div style={{marginTop:8,paddingTop:8,borderTop:(a.replies?.length||0)>0?"none":"0.5px solid var(--po-bdr)"}}>
                {replyingTo===a.id
                  ? <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <input autoFocus value={replyText} onChange={e=>setReplyText(e.target.value)} placeholder="Reply..." className="po-inp" style={{flex:1,padding:"6px 8px",borderRadius:6,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",fontSize:12}} onKeyDown={e=>{if(e.key==="Enter"&&replyText.trim()){onReplyAnnouncement&&onReplyAnnouncement(a.id,replyText);setReplyText("");setReplyingTo(null);}}}/>
                      <SmBtn label="Send" onClick={()=>{if(replyText.trim()){onReplyAnnouncement&&onReplyAnnouncement(a.id,replyText);setReplyText("");setReplyingTo(null);}}} color="#6366F1"/>
                      <SmBtn label="✕" onClick={()=>{setReplyingTo(null);setReplyText("");}} color="#94A3B8"/>
                    </div>
                  : <div onClick={()=>{setReplyingTo(a.id);setReplyText("");}} style={{fontSize:11,color:"#6366F1",cursor:"pointer"}}>💬 Reply</div>}
              </div>
            </Card>
          )}
    </>}
    {tab==="stats"&&(canViewPrivate?<><CommOverview comm={comm} venues={venues}/><CommStatsTab comm={comm} users={users} onViewProfile={onViewProfile}/></>:<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>🔒 This is a private community — request to join to see reports.</div></Card>)}
    {tab==="ledger"&&<LedgerTab comm={comm} users={users} me={me} isAdmin={isAdmin} regs={regs} onViewProfile={onViewProfile} onOpenEvent={onOpenEv} onSetBookkeeping={onSetBookkeeping} onAddLedgerEntry={onAddLedgerEntry} onAddLedgerEntries={onAddLedgerEntries} onDeleteLedgerEntry={onDeleteLedgerEntry} expenseCategories={expenseCategories}/>}
    {tab==="requests"&&isAdmin&&(comm.joinRequests.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No pending requests</div></Card>:comm.joinRequests.map(req=>{const u=users.find(u=>u.id===req.userId);if(!u)return null;return(<Card key={req.userId}><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}><Av u={u} size={38}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{isFootballComm?`FSR ${u.footballSkill||"Not Rated"}`:`USR ${u.usr}`} · {u.area}</div></div></div>{req.message&&<div style={{fontSize:12,color:"var(--po-sub)",background:"var(--po-inp)",borderRadius:6,padding:"7px 10px",marginBottom:10}}>{req.message}</div>}<div style={{display:"flex",gap:6}}><Btn label="Approve" primary onClick={()=>onApprove(req.userId)} style={{flex:1}}/><Btn label="Reject" danger onClick={()=>onReject(req.userId)} style={{flex:1}}/></div></Card>);}))}</>;
}

// ── Centralized Bookkeeping (opt-in, per-community ledger) ───────────
// Four entry types share one flat list: "charge" (non-cash liability assessed to a member —
// the monthly due itself, auto-accrued every month by the backfill effect below), "due" (a
// member's cash payment reducing their liability — partial payments are their own line item,
// summed rather than a paid/unpaid flag), "expense" (categorized cash outflow), "income_misc"
// (cash inflow NOT from a member's due, e.g. sponsorship). Cash Balance = due + income_misc -
// expense (a charge has no cash effect by itself). A member's Liability = their charges minus
// their dues — negative means credit/overpaid. Entries may optionally carry eventId/eventName
// (recorded from an event's Financial tab). Runs alongside per-event cost-splitting, doesn't
// replace it.
function monthsFromInclusive(startISO, throughMonth) {
  const start = new Date(startISO); let y = start.getFullYear(), m = start.getMonth();
  const [ey, em] = throughMonth.split("-").map(Number);
  const out = [];
  while (y < ey || (y === ey && m + 1 <= em)) { out.push(`${y}-${String(m + 1).padStart(2, "0")}`); m++; if (m > 11) { m = 0; y++; } }
  return out;
}
const monthLabel = m => new Date(m+"-01").toLocaleDateString("en-GB",{month:"short",year:"numeric"});
// Which specific charges (monthly dues + a positive opening balance) are still unpaid, oldest
// first — payments apply FIFO across them so "2 unpaid months" shows as 2 distinct lines
// instead of one lumped total.
function outstandingChargesFor(memberEntries) {
  const charges = memberEntries
    .filter(e=>e.type==="charge"||(e.type==="opening"&&e.amount>0))
    .sort((a,b)=> a.type==="opening"?-1 : b.type==="opening"?1 : (a.month||"").localeCompare(b.month||""));
  let pool = memberEntries.filter(e=>e.type==="due").reduce((s,e)=>s+e.amount,0);
  const out = [];
  for (const c of charges) {
    if (pool >= c.amount) { pool -= c.amount; continue; }
    out.push({...c, remaining: c.amount-pool, paidSoFar: pool});
    pool = 0;
  }
  return out;
}
function LedgerTab({comm,users,me,isAdmin,regs,onViewProfile,onOpenEvent,onSetBookkeeping,onAddLedgerEntry,onAddLedgerEntries,onDeleteLedgerEntry,expenseCategories}){
  const bk = comm.bookkeeping||{enabled:false,monthlyDue:100,entries:[]};
  const entries = bk.entries||[];
  const [monthlyDueInput,setMonthlyDueInput] = useState(String(bk.monthlyDue||100));
  const [payingId,setPayingId] = useState(null);
  const [payAmount,setPayAmount] = useState("");
  const todayStr = new Date().toISOString().slice(0,10);
  const [payDate,setPayDate] = useState(todayStr);
  const [showExpense,setShowExpense] = useState(false);
  const [expDesc,setExpDesc] = useState("");
  const [expAmount,setExpAmount] = useState("");
  const [expCategory,setExpCategory] = useState("");
  const [expDate,setExpDate] = useState(todayStr);
  const [showIncome,setShowIncome] = useState(false);
  const [incDesc,setIncDesc] = useState("");
  const [incAmount,setIncAmount] = useState("");
  const [incDate,setIncDate] = useState(todayStr);
  const [showHistory,setShowHistory] = useState(false);
  const [openStatementUid,setOpenStatementUid] = useState(null);
  const curMonth = new Date().toISOString().slice(0,7);
  // Noon avoids the display-side .slice(0,10) landing on the wrong day from a UTC rollover.
  const dateInputToISO = d => new Date((d||todayStr)+"T12:00:00").toISOString();
  // includeCasual defaults false — being Casual (whether set manually by an admin or landed on
  // by missing events) means NOT liable for the monthly due unless an admin explicitly opts
  // casuals back in. Only an explicit true includes them.
  const includeCasual = bk.includeCasual===true;
  const payingMembers = regs.filter(m=>m.status!=="guest"&&(includeCasual||m.status!=="casual"));
  const [includeCasualInput,setIncludeCasualInput] = useState(includeCasual);

  // Auto-accrue the monthly due for every active member (#7) — admin-only, fires whenever a
  // month is missing a charge for someone; one bulk write covers however many are missing.
  useEffect(()=>{
    if (!isAdmin || !bk.enabled) return;
    const startISO = bk.enabledAt || entries[0]?.date || new Date().toISOString();
    const existing = new Set(entries.filter(e=>e.type==="charge").map(e=>`${e.memberId}:${e.month}`));
    const toAdd = [];
    payingMembers.forEach(m=>{
      const memberStart = m.since && new Date(m.since) > new Date(startISO) ? m.since : startISO;
      monthsFromInclusive(memberStart, curMonth).forEach(month=>{
        const key = `${m.userId}:${month}`;
        if (!existing.has(key)) { toAdd.push({type:"charge",memberId:m.userId,amount:bk.monthlyDue,month,description:`Monthly due — ${month}`}); existing.add(key); }
      });
    });
    if (toAdd.length) onAddLedgerEntries&&onAddLedgerEntries(toAdd);
  }, [isAdmin, bk.enabled, bk.monthlyDue, bk.enabledAt, bk.includeCasual, entries.length, comm.members?.length]);

  if (!bk.enabled) {
    if (!isAdmin) return <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No shared ledger for this community yet.</div></Card>;
    return <Card>
      <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>💰 Enable Centralized Bookkeeping</div>
      <div style={{fontSize:12,color:"var(--po-sub)",marginBottom:14}}>Collect a recurring monthly due from members into a shared fund (court tips, balls, equipment...) — tracked separately from, and alongside, per-event cost-splitting.</div>
      <Inp label="Monthly due per member (EGP)" value={monthlyDueInput} onChange={setMonthlyDueInput} type="number"/>
      <label style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,cursor:"pointer"}}>
        <input type="checkbox" checked={includeCasualInput} onChange={e=>setIncludeCasualInput(e.target.checked)} style={{width:16,height:16,flexShrink:0}}/>
        <span style={{fontSize:12,color:"var(--po-sub)"}}>Include casual members in the monthly due (unchecked = only Regular members are charged)</span>
      </label>
      <Btn label="Enable" primary onClick={()=>{if(window.confirm(`Enable centralized bookkeeping for ${comm.name}?\n\nEvery ${includeCasualInput?"active":"Regular"} member will start accruing a ${parseFloat(monthlyDueInput)||100} EGP monthly due automatically. You can change the amount anytime, but the ledger itself can't be un-enabled once it's tracking real entries.`))onSetBookkeeping({enabled:true,monthlyDue:parseFloat(monthlyDueInput)||100,includeCasual:includeCasualInput});}} style={{width:"100%"}}/>
    </Card>;
  }

  const cashBalance = (bk.openingBalance||0) + entries.reduce((s,e)=>s+(e.type==="due"||e.type==="income_misc"?e.amount:e.type==="expense"?-e.amount:0),0);
  // "opening" = a one-time starting liability/credit per player, set once to represent a
  // balance that existed before this ledger started tracking them (can be negative = credit).
  const liabilityOf = uid => entries.filter(e=>e.memberId===uid).reduce((s,e)=>s+(e.type==="charge"||e.type==="opening"?e.amount:e.type==="due"?-e.amount:0),0);
  const sortedEntries = [...entries].sort((a,b)=>new Date(b.date)-new Date(a.date));
  const personalEntryTypes = new Set(["charge","due","opening"]);

  // ── Member (non-admin) view: fund balance + their own statement only — no other member's
  // numbers, no expense line items (#9's "limited scope") ──
  if (!isAdmin) {
    const myMember = payingMembers.find(m=>m.userId===me.id);
    const myLiability = myMember ? liabilityOf(me.id) : null;
    const myEntries = sortedEntries.filter(e=>e.memberId===me.id&&personalEntryTypes.has(e.type));
    const myOutstanding = myMember ? outstandingChargesFor(entries.filter(e=>e.memberId===me.id)) : [];
    return <>
      <Card style={{marginBottom:12,textAlign:"center"}}>
        <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:4}}>Fund Balance</div>
        <div style={{fontSize:32,fontWeight:700,color:cashBalance>=0?"#34D399":"#EF4444"}}>{cashBalance.toLocaleString()} EGP</div>
      </Card>
      {myMember&&<>
        <Card style={{marginBottom:12,textAlign:"center"}}>
          <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:4}}>Your Balance</div>
          <div style={{fontSize:24,fontWeight:700,color:myLiability<=0?"#34D399":"#F59E0B"}}>{myLiability<=0?`${Math.abs(myLiability).toLocaleString()} EGP credit`:`${myLiability.toLocaleString()} EGP owed`}</div>
          {myOutstanding.length>0&&<div style={{marginTop:8,paddingTop:8,borderTop:"0.5px solid var(--po-bdr)",textAlign:"left"}}>
            {myOutstanding.map(o=><div key={o.id} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0"}}>
              <span style={{color:"var(--po-dim)"}}>{o.type==="opening"?"Opening Balance":monthLabel(o.month)}</span>
              <span style={{fontWeight:600,color:"#F59E0B"}}>{o.remaining.toLocaleString()} EGP{o.paidSoFar>0?` (${o.paidSoFar} paid)`:""}</span>
            </div>)}
          </div>}
        </Card>
        <ST>Your Statement</ST>
        {myEntries.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No activity yet.</div></Card>:myEntries.map(e=>
          <Card key={e.id} style={{marginBottom:6,padding:"8px 12px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:500,color:"var(--po-text)"}}>{e.description}</div>
                <div style={{fontSize:10,color:"var(--po-dim)"}}>{fmtD(e.date.slice(0,10))}</div>
              </div>
              <div style={{fontSize:14,fontWeight:700,color:e.type==="due"?"#34D399":e.type==="opening"?(e.amount<0?"#34D399":"#F59E0B"):"var(--po-dim)"}}>{e.type==="due"?`+${e.amount}`:e.type==="opening"?(e.amount<0?`+${Math.abs(e.amount)} credit`:`owed ${e.amount}`):`owed ${e.amount}`}</div>
            </div>
          </Card>
        )}
      </>}
    </>;
  }

  // ── Admin view ──
  const expenseTotals = {};
  entries.filter(e=>e.type==="expense").forEach(e=>{ const c=e.category||"Misc"; expenseTotals[c]=(expenseTotals[c]||0)+e.amount; });
  const totalDues = entries.filter(e=>e.type==="due").reduce((s,e)=>s+e.amount,0);
  const totalMiscIncome = entries.filter(e=>e.type==="income_misc").reduce((s,e)=>s+e.amount,0);
  const totalExpenses = entries.filter(e=>e.type==="expense").reduce((s,e)=>s+e.amount,0);
  const totalOwed = payingMembers.reduce((s,m)=>s+Math.max(0,liabilityOf(m.userId)),0);

  return <>
    <Card style={{marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:14}}>
        <div style={{display:"flex",flexDirection:"column",gap:12,flexShrink:0}}>
          <div>
            <div style={{fontSize:10,color:"var(--po-dim)"}}>Monthly due</div>
            <div style={{fontSize:14,fontWeight:700,color:"var(--po-text)"}}>{bk.monthlyDue} EGP</div>
            {bk.monthlyDueSince&&<div style={{fontSize:9,color:"var(--po-dim)"}}>since {fmtD(bk.monthlyDueSince)}</div>}
            <span onClick={()=>{
              const va=prompt("New monthly due (EGP):",String(bk.monthlyDue));
              if(va===null||isNaN(parseFloat(va)))return;
              const vd=prompt("Effective from (YYYY-MM-DD):", bk.monthlyDueSince||todayStr);
              if(vd===null)return;
              onSetBookkeeping({monthlyDue:parseFloat(va), monthlyDueSince:vd});
            }} style={{fontSize:10,color:"#6366F1",cursor:"pointer"}}>✏️ edit</span>
          </div>
          <div>
            <div style={{fontSize:10,color:"var(--po-dim)"}}>Casual members charged</div>
            <div style={{fontSize:14,fontWeight:700,color:"var(--po-text)"}}>{includeCasual?"Yes":"No"}</div>
            <span onClick={()=>{if(window.confirm(includeCasual?"Stop charging casual members the monthly due?\n\nOnly Regular members will keep accruing new charges going forward — charges already recorded aren't removed.":"Start charging casual members the monthly due again?\n\nThey'll start accruing new charges going forward — no back-charges for the time they were excluded."))onSetBookkeeping({includeCasual:!includeCasual});}} style={{fontSize:10,color:"#6366F1",cursor:"pointer"}}>✏️ edit</span>
          </div>
          <div>
            <div style={{fontSize:10,color:"var(--po-dim)"}}>Opening balance</div>
            <div style={{fontSize:14,fontWeight:700,color:"var(--po-text)"}}>{bk.openingBalance||0} EGP</div>
            <span onClick={()=>{const v=prompt("Opening cash balance (EGP) — whatever was already in the box before you started tracking here:",String(bk.openingBalance||0));if(v!==null&&!isNaN(parseFloat(v)))onSetBookkeeping({openingBalance:parseFloat(v)});}} style={{fontSize:10,color:"#6366F1",cursor:"pointer"}}>✏️ edit</span>
          </div>
        </div>
        <div style={{flex:1,textAlign:"center"}}>
          <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:4}}>Cash Balance</div>
          <div style={{fontSize:32,fontWeight:700,color:cashBalance>=0?"#34D399":"#EF4444"}}>{cashBalance.toLocaleString()} EGP</div>
        </div>
      </div>
    </Card>

    <div style={{display:"flex",gap:6,marginBottom:showExpense||showIncome?8:12}}>
      {!showExpense&&<SmBtn label="+ Add Expense" onClick={()=>{setShowExpense(true);setShowIncome(false);}} color="#F59E0B" style={{flex:1,textAlign:"center",justifyContent:"center",display:"flex"}}/>}
      {!showIncome&&<SmBtn label="+ Add Income" onClick={()=>{setShowIncome(true);setShowExpense(false);}} color="#34D399" style={{flex:1,textAlign:"center",justifyContent:"center",display:"flex"}}/>}
    </div>
    {showExpense&&<Card style={{marginBottom:12}}>
      <Inp label="Description" value={expDesc} onChange={setExpDesc} placeholder="e.g. Court staff tip, balls, ice"/>
      <Inp label="Amount (EGP)" value={expAmount} onChange={setExpAmount} type="number"/>
      <Inp label="Date" value={expDate} onChange={setExpDate} type="date"/>
      <Drp label="Category" value={expCategory} onChange={setExpCategory} options={(expenseCategories||[]).map(c=>({v:c,l:c}))}/>
      <div style={{display:"flex",gap:6}}>
        <Btn label="Add" primary onClick={()=>{const amt=parseFloat(expAmount);if(expDesc&&amt>0){onAddLedgerEntry({type:"expense",amount:amt,description:expDesc,category:expCategory||"Misc",date:dateInputToISO(expDate)});setExpDesc("");setExpAmount("");setExpCategory("");setExpDate(todayStr);setShowExpense(false);}}} style={{flex:1}}/>
        <SmBtn label="Cancel" onClick={()=>{setShowExpense(false);setExpDesc("");setExpAmount("");setExpCategory("");setExpDate(todayStr);}} color="#94A3B8" style={{flex:1}}/>
      </div>
    </Card>}
    {showIncome&&<Card style={{marginBottom:12}}>
      <Inp label="Description" value={incDesc} onChange={setIncDesc} placeholder="e.g. Sponsor contribution, event surplus"/>
      <Inp label="Amount (EGP)" value={incAmount} onChange={setIncAmount} type="number"/>
      <Inp label="Date" value={incDate} onChange={setIncDate} type="date"/>
      <div style={{display:"flex",gap:6}}>
        <Btn label="Add" primary onClick={()=>{const amt=parseFloat(incAmount);if(incDesc&&amt>0){onAddLedgerEntry({type:"income_misc",amount:amt,description:incDesc,date:dateInputToISO(incDate)});setIncDesc("");setIncAmount("");setIncDate(todayStr);setShowIncome(false);}}} style={{flex:1}}/>
        <SmBtn label="Cancel" onClick={()=>{setShowIncome(false);setIncDesc("");setIncAmount("");setIncDate(todayStr);}} color="#94A3B8" style={{flex:1}}/>
      </div>
    </Card>}

    <CollapsibleSection label={<>👥 Player Liabilities{totalOwed>0?<span style={{fontWeight:400,color:"#F59E0B"}}>&nbsp;— {totalOwed.toLocaleString()} EGP owed</span>:null}</>} defaultOpen={false}>
    {payingMembers.map(m=>{
      const u=users.find(x=>x.id===m.userId); if(!u) return null;
      const memberEntries = entries.filter(e=>e.memberId===u.id);
      const liability = liabilityOf(u.id);
      const isOpen = openStatementUid===u.id;
      const myEntries = sortedEntries.filter(e=>e.memberId===u.id&&personalEntryTypes.has(e.type));
      const openingEntry = memberEntries.find(e=>e.type==="opening");
      const outstanding = outstandingChargesFor(memberEntries);
      return <Card key={u.id} style={{marginBottom:6,padding:"8px 12px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div onClick={e=>{e.stopPropagation();onViewProfile&&onViewProfile(u.id);}} style={{cursor:onViewProfile?"pointer":"default"}}><Av u={u} size={32}/></div>
          <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>setOpenStatementUid(o=>o===u.id?null:u.id)}>
            <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{u.nickname}</div>
            <div style={{fontSize:11,color:liability<=0?"#34D399":"#F59E0B"}}>{liability<=0?`${Math.abs(liability).toLocaleString()} EGP credit`:`${liability.toLocaleString()} EGP owed`}</div>
          </div>
          {liability>0&&(payingId===u.id
            ? null
            : <div onClick={e=>e.stopPropagation()}><SmBtn label="Record Payment" onClick={()=>{setPayingId(u.id);setPayAmount(String(liability));setPayDate(todayStr);}} color="#6366F1"/></div>)}
        </div>
        {/* Each unpaid month (or the opening balance) gets its own named line — "2 late
            months" reads as 2 rows, not one lumped total (payments still apply FIFO). */}
        {outstanding.length>0&&<div style={{marginTop:6,paddingTop:6,borderTop:"0.5px dashed var(--po-bdr)"}}>
          {outstanding.map(o=><div key={o.id} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"2px 0"}}>
            <span style={{color:"var(--po-dim)"}}>{o.type==="opening"?"Opening Balance":monthLabel(o.month)}</span>
            <span style={{fontWeight:600,color:"#F59E0B"}}>{o.remaining.toLocaleString()} EGP{o.paidSoFar>0?` (${o.paidSoFar} paid)`:""}</span>
          </div>)}
        </div>}
        {payingId===u.id&&<div style={{marginTop:8,paddingTop:8,borderTop:"0.5px solid var(--po-bdr)"}} onClick={e=>e.stopPropagation()}>
          <Inp label="Amount (EGP)" value={payAmount} onChange={setPayAmount} type="number"/>
          <Inp label="Date" value={payDate} onChange={setPayDate} type="date"/>
          <div style={{display:"flex",gap:6}}>
            <Btn label="Record Payment" primary onClick={()=>{const amt=parseFloat(payAmount)||liability;if(amt>0){onAddLedgerEntry({type:"due",memberId:u.id,amount:amt,month:curMonth,description:"Payment",date:dateInputToISO(payDate)});}setPayingId(null);setPayAmount("");setPayDate(todayStr);}} style={{flex:1}}/>
            <SmBtn label="Cancel" onClick={()=>{setPayingId(null);setPayAmount("");setPayDate(todayStr);}} color="#94A3B8" style={{flex:1}}/>
          </div>
        </div>}
        {/* Opening balance is always reachable here (not buried behind expand) — it's a
            per-player, one-time setup action admins need to find easily. */}
        <div style={{fontSize:10,color:"#6366F1",cursor:"pointer",marginTop:6}} onClick={e=>{e.stopPropagation();
          const v=prompt(`Opening balance for ${u.nickname} (EGP) — a starting balance from before this ledger existed, specific to this player.\nPositive = they already owed money. Negative = they already had credit.`, String(openingEntry?.amount||0));
          if(v===null) return;
          const amt=parseFloat(v);
          if(isNaN(amt)) return;
          if(openingEntry) onDeleteLedgerEntry(openingEntry.id);
          if(amt!==0) onAddLedgerEntry({type:"opening",memberId:u.id,amount:amt,description:"Opening balance"});
        }}>{openingEntry?`✏️ Edit opening balance (${openingEntry.amount})`:"+ Set opening balance"}</div>
        {isOpen&&<div style={{marginTop:8,paddingTop:8,borderTop:"0.5px solid var(--po-bdr)"}} onClick={e=>e.stopPropagation()}>
          {myEntries.length===0?<div style={{fontSize:11,color:"var(--po-dim)",textAlign:"center",padding:"8px 0"}}>No activity yet.</div>:myEntries.map(e=>
            <div key={e.id} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11}}>
              <span style={{color:"var(--po-dim)"}}>{fmtD(e.date.slice(0,10))} · {e.description}</span>
              <span style={{fontWeight:700,color:e.type==="due"?"#34D399":e.type==="opening"&&e.amount<0?"#34D399":"var(--po-dim)"}}>{e.type==="due"?"+":e.type==="opening"?(e.amount<0?"credit ":"owed "):"−"}{Math.abs(e.amount)}</span>
            </div>
          )}
        </div>}
      </Card>;
    })}
    </CollapsibleSection>

    <CollapsibleSection label="📊 Cash Statement" defaultOpen={false}>
      <Card>
        {[["Opening balance",bk.openingBalance||0,"var(--po-text)"],["Player dues (income)",totalDues,"#34D399"],["Misc income",totalMiscIncome,"#34D399"],["Expenses",totalExpenses,"#EF4444"],["Net Cash Balance",cashBalance,cashBalance>=0?"#34D399":"#EF4444"]].map(([k,v,color])=>
          <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
            <span style={{fontSize:12,color:"var(--po-dim)"}}>{k}</span>
            <span style={{fontSize:13,fontWeight:700,color}}>{v.toLocaleString()} EGP</span>
          </div>
        )}
      </Card>
    </CollapsibleSection>

    <CollapsibleSection label="📊 Expenses by Category" defaultOpen={false}>
      <Card>
        {Object.keys(expenseTotals).length===0?<div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"12px 0"}}>No expenses recorded yet.</div>:
          Object.entries(expenseTotals).sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>
            <div key={cat} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
              <span style={{fontSize:12,color:"var(--po-dim)"}}>{cat}</span>
              <span style={{fontSize:13,fontWeight:700,color:"var(--po-text)"}}>{amt.toLocaleString()} EGP</span>
            </div>
          )}
      </Card>
    </CollapsibleSection>

    <SmBtn label={showHistory?"▲ Hide Full Ledger":`▼ Show Full Ledger (${entries.length} entries)`} onClick={()=>setShowHistory(o=>!o)} color="#6366F1" style={{width:"100%",marginTop:12,marginBottom:showHistory?8:0,textAlign:"center",justifyContent:"center",display:"flex"}}/>
    {showHistory&&(sortedEntries.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No entries yet.</div></Card>:sortedEntries.map(e=>{
      const memberName = e.memberId ? (users.find(u=>u.id===e.memberId)?.nickname||"—") : null;
      const isOpeningCredit = e.type==="opening"&&e.amount<0;
      const sign = e.type==="due"||e.type==="income_misc" ? "+" : e.type==="expense" ? "−" : e.type==="opening" ? (isOpeningCredit?"credit ":"owed ") : "owed ";
      const color = e.type==="due"||e.type==="income_misc"||isOpeningCredit ? "#34D399" : e.type==="expense" ? "#EF4444" : "var(--po-dim)";
      return <Card key={e.id} style={{marginBottom:6,padding:"8px 12px"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:500,color:"var(--po-text)"}}>{memberName?`${memberName} — ${e.description||"Monthly due"}`:e.description}</div>
            <div style={{fontSize:10,color:"var(--po-dim)",display:"flex",gap:6,flexWrap:"wrap"}}>
              <span>{fmtD(e.date.slice(0,10))}</span>
              {e.category&&<span>· {e.category}</span>}
              {e.eventName&&<span onClick={()=>onOpenEvent&&onOpenEvent(e.eventId)} style={{color:onOpenEvent?"#6366F1":"inherit",cursor:onOpenEvent?"pointer":"default"}}>· {e.eventName}</span>}
            </div>
          </div>
          <div style={{fontSize:14,fontWeight:700,color}}>{sign}{Math.abs(e.amount)}</div>
          <SmBtn label="✕" onClick={()=>{if(window.confirm("Remove this ledger entry?"))onDeleteLedgerEntry(e.id);}} color="#EF4444" style={{padding:"4px 8px",fontSize:11}}/>
        </div>
      </Card>;
    }))}
  </>;
}

// ── Venues ────────────────────────────────────────────
function VenueList({venues,onAdd,onEdit,onBack}){
  const [venueSearch,setVenueSearch]=useState("");
  const safeVenues = (venues||[]).filter(v=>v && Array.isArray(v.courts));
  const brokenCount = (venues||[]).length - safeVenues.length;
  const vq=venueSearch.trim().toLowerCase();
  const shownVenues = vq ? safeVenues.filter(v=>v.name?.toLowerCase().includes(vq)||v.area?.toLowerCase().includes(vq)||v.gov?.toLowerCase().includes(vq)) : safeVenues;
  return <><BBtn onBack={onBack} label="Back"/><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)"}}>Venues</div><Btn label="+ Add Venue" primary onClick={onAdd}/></div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:12,padding:"8px 12px",background:"var(--po-card)",borderRadius:8}}>ℹ️ Use any venue immediately. Platform Admin approval publishes globally.</div>
    {brokenCount>0&&<div style={{fontSize:12,color:"#F87171",marginBottom:12,padding:"8px 12px",background:"#EF444411",border:"0.5px solid #EF444444",borderRadius:8}}>⚠️ {brokenCount} venue(s) have corrupted data and were hidden. Go to Settings → Data → Repair to fix, or Factory Reset if the issue persists.</div>}
    {safeVenues.length>6&&<input value={venueSearch} onChange={e=>setVenueSearch(e.target.value)} placeholder="🔍 Search venues..." className="po-inp" style={{width:"100%",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box",marginBottom:12}}/>}
    {safeVenues.length===0&&brokenCount===0&&<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No venues yet.</div></Card>}
    {vq&&shownVenues.length===0&&<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No venues match "{venueSearch}"</div></Card>}
    {shownVenues.map(v=><Card key={v.id}><div style={{display:"flex",gap:12,alignItems:"flex-start"}}><div style={{width:44,height:44,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🏟</div><div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:15,color:"var(--po-text)"}}>{v.name}</span>{SEEDED_VENUE_IDS.has(v.id)&&<SeedBadge/>}{v.status==="pending"&&<Bdg label="⏳ Pending" color="#F59E0B"/>}{v.status==="pending_edit"&&<Bdg label="✏️ Edit Pending" color="#F59E0B"/>}{(!v.status||v.status==="approved")&&<Bdg label="✓ Approved" color="#34D399"/>}</div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>📍 {v.area} · {v.gov}</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:4}}>{(v.sports?.length?v.sports:[DEFAULT_SPORT]).map(s=><Bdg key={s} label={sportLabel(s)} color="#A78BFA"/>)}{(v.sports?.includes("Padel Tennis")??true)&&<Bdg label={`${v.courts.length} courts · ${v.pricePerHour>0?`${v.pricePerHour} EGP/hr`:"Free"}${v.extraFee>0?` +${v.extraFee}`:""}`} color="#38BDF8"/>}{v.sports?.includes("Football")&&<Bdg label={`${(v.pitches||[]).length} pitches · ${getVenuePricing(v,"Football").pricePerHour>0?`${getVenuePricing(v,"Football").pricePerHour} EGP/hr`:"Free"}${getVenuePricing(v,"Football").extraFee>0?` +${getVenuePricing(v,"Football").extraFee}`:""}`} color="#34D399"/>}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{[v.courts.length?v.courts.map(c=>c.name).join(" · "):null,v.pitches?.length?v.pitches.map(p=>p.name).join(" · "):null].filter(Boolean).join(" · ")}</div></div><div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>{(v.mapsUrl||(typeof v.lat==="number"&&typeof v.lng==="number"))&&<MapOpenPicker venue={v} label="📍 Maps"/>}<SmBtn label="✏️ Edit" onClick={()=>onEdit(v.id)} color="#6366F1"/></div></div></Card>)}
  </>;
}
function VenueForm({editV,onBack,onSave,egypt}){
  const ie=!!editV;
  const emptyCourtNames=Array(Math.max(0,10-(editV?.courts.length||0))).fill("");
  const emptyPitchNames=Array(Math.max(0,10-(editV?.pitches?.length||0))).fill("");
  const [f,setF]=useState({name:editV?.name||"",country:editV?.country||"مصر",gov:editV?.gov||"",area:editV?.area||"",sports:editV?.sports?.length?editV.sports:[DEFAULT_SPORT],pricePerHour:editV?String(editV.pricePerHour):"",extraFee:editV?String(editV.extraFee):"",pricePerHourFootball:editV?.pricePerHourFootball!=null?String(editV.pricePerHourFootball):"",extraFeeFootball:editV?.extraFeeFootball!=null?String(editV.extraFeeFootball):"",mapsUrl:editV?.mapsUrl||"",lat:editV?.lat!=null?String(editV.lat):"",lng:editV?.lng!=null?String(editV.lng):"",instapayLink:editV?.instapayLink||"",courtNames:editV?[...editV.courts.map(c=>c.name),...emptyCourtNames]:["Court 1","Court 2","","","","","","","",""],pitchNames:editV?[...(editV.pitches||[]).map(p=>p.name),...emptyPitchNames]:["Pitch 1","Pitch 2","","","","","","","",""]});
  const set=(k,v)=>setF(p=>({...p,[k]:v})),setC=(i,v)=>setF(p=>{const n=[...p.courtNames];n[i]=v;return{...p,courtNames:n};}),setP=(i,v)=>setF(p=>{const n=[...p.pitchNames];n[i]=v;return{...p,pitchNames:n};});
  const multiSport=f.sports.length>1;
  return <><BBtn onBack={onBack} label="Venues"/><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:ie?4:16}}>{ie?"Edit Venue":"Add Venue"}</div>{ie&&<div style={{fontSize:12,color:"#F59E0B",marginBottom:14,padding:"8px 12px",background:"#F59E0B11",borderRadius:8}}>✏️ Changes apply immediately. Pending global review.</div>}
    <Card><Inp label="Venue Name" value={f.name} onChange={v=>set("name",v)} placeholder="e.g. Wadi Degla Club"/><AreaSel country={f.country} gov={f.gov} area={f.area} onChange={set} egypt={egypt}/><div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:6}}>Sports (select all that apply)</div><SportPicker selected={f.sports} onChange={v=>set("sports",v)}/></div>
    {f.sports.includes("Padel Tennis")&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><Inp label={multiSport?"Padel Price/hr (EGP)":"Price/hr (EGP)"} value={f.pricePerHour} onChange={v=>set("pricePerHour",v)} type="number"/><Inp label={multiSport?"Padel Extra Booking (EGP)":"Extra Booking (EGP)"} value={f.extraFee} onChange={v=>set("extraFee",v)} type="number"/></div>}
    {f.sports.includes("Football")&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><Inp label={multiSport?"Football Price/hr (EGP)":"Price/hr (EGP)"} value={f.pricePerHourFootball} onChange={v=>set("pricePerHourFootball",v)} type="number" placeholder={multiSport?"blank = same as padel":""}/><Inp label={multiSport?"Football Extra Booking (EGP)":"Extra Booking (EGP)"} value={f.extraFeeFootball} onChange={v=>set("extraFeeFootball",v)} type="number" placeholder={multiSport?"blank = same as padel":""}/></div>}
    <Inp label="Google Maps URL" value={f.mapsUrl} onChange={v=>set("mapsUrl",v)} placeholder="https://maps.google.com/..."/>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8,padding:"8px 10px",background:"var(--po-inp)",borderRadius:8}}>📍 For "How far is it?" and one-tap navigation to work reliably, add coordinates below — shortened share links (maps.app.goo.gl/…) don't contain them. In Google Maps: long-press the location on the map, then tap the coordinates shown at the bottom to copy them.</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><Inp label="Latitude (optional)" value={f.lat} onChange={v=>set("lat",v)} type="number" placeholder="e.g. 30.0333"/><Inp label="Longitude (optional)" value={f.lng} onChange={v=>set("lng",v)} type="number" placeholder="e.g. 31.4913"/></div>
    <Inp label="InstaPay Link (optional)" value={f.instapayLink} onChange={v=>set("instapayLink",v)} placeholder="https://ipn.eg/S/venuename/instapay/..."/>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:14,padding:"8px 10px",background:"var(--po-inp)",borderRadius:8}}>💳 Shown on this venue's info for whoever's settling up the court fees directly with the venue (usually the event's collector, not each player individually).</div>
    {f.sports.includes("Padel Tennis")&&<div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Padel Court Names (up to 10)</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>{f.courtNames.map((cn,i)=><input key={i} value={cn} onChange={e=>setC(i,e.target.value)} placeholder={`Court ${i+1}`} className="po-inp" style={{background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13}}/>)}</div></div>}
    {f.sports.includes("Football")&&<div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Football Pitch Names (up to 10)</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>{f.pitchNames.map((pn,i)=><input key={i} value={pn} onChange={e=>setP(i,e.target.value)} placeholder={`Pitch ${i+1}`} className="po-inp" style={{background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13}}/>)}</div></div>}
    <Btn label={ie?"Save & Submit for Review":"Add Venue & Submit for Review"} primary onClick={()=>{if(f.name&&f.country&&f.area&&f.sports.length)onSave({...f,lat:f.lat?parseFloat(f.lat):null,lng:f.lng?parseFloat(f.lng):null},ie?editV.id:null);}} style={{width:"100%"}}/></Card></>;
}

// ── Event Card ────────────────────────────────────────
function EvCard({ev,me,users,venues,onClick}){
  const sc={registration_open:"#34D399",completed:"var(--po-sub)",cancelled:"#EF4444"};
  const sl={registration_open:"Open",completed:"Completed",cancelled:"Cancelled"};
  const tl={open:"Open Day",closed_ind:"Closed Ind.",closed_teams:"Closed Teams"};
  const creator=users?.find(u=>u.id===ev.createdBy);
  const venue=venues?.find(v=>v.id===ev.venueId);
  const photoCount=ev.photos?.length||0;
  const liveStartAt=ev.plan?.matchModeStartAt;
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{
    if(!liveStartAt||ev.status==="completed"||ev.status==="cancelled")return;
    const t=setInterval(()=>setNow(Date.now()),1000);
    return ()=>clearInterval(t);
  },[liveStartAt,ev.status]);
  const live=getLiveMatchInfo(ev,now);
  const remaining=live?Math.max(0,Math.round((live.roundEndAt-now)/1000)):null;
  const clock=remaining!=null?`${String(Math.floor(remaining/60)).padStart(2,"0")}:${String(remaining%60).padStart(2,"0")}`:null;
  const avgUsr=calcEventAvgUsr(ev,users||[]);
  return <Card style={{cursor:"pointer"}}><div onClick={onClick} style={{display:"flex",gap:10,alignItems:"center"}}>{avgUsr!=null?<EventLevelBadge avg={avgUsr} sport={ev.sport||DEFAULT_SPORT}/>:<div style={{width:42,height:42,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>📅</div>}<div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{ev.name}</span><span style={{fontSize:10,color:"var(--po-dim)",background:"var(--po-inp)",padding:"1px 6px",borderRadius:5}}>#{ev.id}</span>{live&&<LiveBdg label="LIVE"/>}{ev.isDemo&&me.id===1&&<Bdg label="Demo" color="#F59E0B"/>}{ev.visibility==="private"&&<Bdg label="🔒 Private" color="#94A3B8"/>}<Bdg label={sl[ev.status]||ev.status} color={sc[ev.status]||"#94A3B8"}/>{ev.type&&<Bdg label={tl[ev.type]||ev.type} color="#6366F1"/>}{!ev.type&&<Bdg label="🗳 Poll" color="#F59E0B"/>}{photoCount>0&&<span style={{fontSize:10,color:"#A5B4FC",background:"#6366F122",padding:"1px 6px",borderRadius:5}}>🖼 {photoCount}</span>}</div>{live&&<div style={{fontSize:12,fontWeight:700,color:"#EF4444",marginBottom:2}}>⏱ Round {live.slot}/{live.tr} · ends in {clock}</div>}{ev.commName&&<div style={{fontSize:11,color:"var(--po-dim)",display:"flex",alignItems:"center",gap:4,marginBottom:2}}>👥 {ev.commName}</div>}{venue&&<div style={{fontSize:11,color:"var(--po-dim)",display:"flex",alignItems:"center",gap:4,marginBottom:2}}>🏟 {venue.name}</div>}<div style={{fontSize:11,color:"var(--po-dim)"}}>{ev.pitches?.length?`${ev.pitches.join(", ")}`:`${ev.courts} courts`}{creator?` · by ${creator.nickname}`:""}</div>{(()=>{
              // Compact version of the graduated Min/Max capacity indicator (V0.09.22, EvDetail)
              // — same status-pill + Min-tick language, scaled down for a list card (no marker
              // dot or Start/Max text labels, the fill edge itself shows position at this size).
              const {active,waitlisted}=splitRegsByCapacity(ev);
              const cnt=active.length;
              const shownCap=getMaxPlayers(ev)||ev.courts*5||1;
              const minReq=ev.courts*4;
              const pct=Math.min(100,(cnt/shownCap)*100);
              const minPct=Math.min(100,(minReq/shownCap)*100);
              const showMinTick=minReq>0&&minReq<shownCap;
              const isFull=cnt>=shownCap;
              const pastMin=cnt>=minReq;
              const barColor=isFull?"#EF4444":pastMin?"#34D399":"#6366F1";
              const statusLabel=isFull?"Full":pastMin?"On track":`Needs ${Math.max(0,minReq-cnt)}`;
              return <div style={{marginTop:4}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <span style={{fontSize:11,fontWeight:700,color:"var(--po-text)"}}>{cnt}<span style={{fontWeight:500,color:"var(--po-dim)"}}> / {shownCap} registered</span></span>
                  <span style={{fontSize:9,fontWeight:700,padding:"1px 7px",borderRadius:20,color:barColor,background:`${barColor}22`}}>{statusLabel}</span>
                </div>
                <div style={{height:6,borderRadius:3,background:"var(--po-bdr)",position:"relative"}}>
                  <div style={{position:"absolute",left:0,top:0,height:"100%",borderRadius:3,width:`${pct}%`,background:barColor,transition:"width 0.3s"}}/>
                  {showMinTick&&<div style={{position:"absolute",top:-2,left:`${minPct}%`,width:2,height:10,background:"var(--po-card)",borderLeft:"2px solid var(--po-bg)",transform:"translateX(-1px)"}}/>}
                </div>
                {waitlisted.length>0&&<div style={{fontSize:10,color:"#F59E0B",marginTop:3}}>⏳ {waitlisted.length} waiting</div>}
              </div>;
            })()}<div style={{fontSize:11,color:"var(--po-dim)",marginTop:3}}>{fmtD(ev.date)} · {fmtT(ev.time)}{ev.timeTo?` → ${fmtT(ev.timeTo)}`:""}</div></div></div></Card>;
}

// ── Event Create Form ─────────────────────────────────
function EventForm({venues,onBack,onCreate,commName,commSports}){
  const sportOptions=commSports?.length?commSports:[DEFAULT_SPORT];
  const [f,setF]=useState({name:"",description:"",date:"",time:"18:00",timeTo:"22:00",venueId:"",courts:"2",pollMode:false,eventType:getEventTypesForSport(sportOptions[0])[0].key,visibility:"public",sport:sportOptions[0],pitchNames:[],teamSize:"5",numTeams:"3",numTeamsTouched:false});
  const set=(k,v)=>setF(p=>({...p,[k]:v}));const v=venues.find(x=>x.id===parseInt(f.venueId));
  const isFootball=f.sport==="Football";
  const venuePitches=v?.pitches||[];
  const c=isFootball?f.pitchNames.length:(parseInt(f.courts)||0);
  const maxC=v?v.courts.length:10;
  // Default to Pitch 1 selected whenever football pitches first become available (new venue
  // picked, or switching to Football) — matches the owner's explicit call: pitch 1 by default,
  // not an empty selection the admin has to remember to fill in.
  useEffect(()=>{
    if(isFootball&&venuePitches.length>0&&f.pitchNames.length===0) set("pitchNames",[venuePitches[0].name]);
  },[isFootball,f.venueId,venuePitches.length]);
  // Suggested team count: 3 for a single shared pitch (room for one team to rotate off), or
  // 2 per pitch once there's more than one (each pitch runs its own pair independently) — the
  // owner's exact formula. Stays a live suggestion, not forced, so it stops overwriting the
  // admin's own number the moment they touch the field themselves.
  useEffect(()=>{
    if(!isFootball||f.numTeamsTouched) return;
    const suggested=f.pitchNames.length<=1?3:f.pitchNames.length*2;
    set("numTeams",String(suggested));
  },[isFootball,f.pitchNames.length,f.numTeamsTouched]);
  const togglePitch=name=>setF(p=>({...p,pitchNames:p.pitchNames.includes(name)?p.pitchNames.filter(n=>n!==name):[...p.pitchNames,name]}));
  // Reset to the new sport's default type whenever Sport changes — not just when the current
  // value becomes invalid, since e.g. "open" is a valid key for both sports but football's
  // default should be "Teams" (closed_teams), not padel's "Open Day" default carrying over.
  useEffect(()=>{
    set("eventType",getEventTypesForSport(f.sport)[0].key);
  },[f.sport]);
  const durHrs=(()=>{ if(!f.time||!f.timeTo) return 2; const [h1,m1]=f.time.split(":").map(Number); const [h2,m2]=f.timeTo.split(":").map(Number); if(isNaN(h2)) return 2; let mins=(h2*60+m2)-(h1*60+m1); if(mins<=0) mins+=24*60; return Math.max(0.5, mins/60); })();
  const vPricing=getVenuePricing(v,f.sport);
  const tot=v?Math.round((vPricing.pricePerHour+vPricing.extraFee)*c*durHrs):0;
  const doSuggestName=()=>set("name",suggestEventName({date:f.date,time:f.time,venueName:v?.name,commName,sport:f.sport}));
  return <><BBtn onBack={onBack} label="Community"/><div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>New Event</div><Card>
    {/* ── Common fields — same for every sport ── */}
    <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
      <div style={{flex:1}}><Inp label="Event Name" value={f.name} onChange={v2=>set("name",v2)} placeholder="e.g. Friday Night Padel"/></div>
      <button type="button" onClick={doSuggestName} title="Suggest a name" style={{marginBottom:14,padding:"9px 12px",borderRadius:8,border:"0.5px solid #6366F1",background:"#6366F122",color:"#A5B4FC",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>✨ Suggest</button>
    </div>
    <Inp label="Description / Remark (optional)" value={f.description} onChange={v2=>set("description",v2)} placeholder="e.g. Bring extra balls, court 3 booked separately" multiline/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:0}}>
      <Inp label="Date" value={f.date} onChange={v2=>set("date",v2)} type="date"/>
      <Inp label="Start" value={f.time} onChange={v2=>set("time",v2)} type="time"/>
      <Inp label="End" value={f.timeTo} onChange={v2=>set("timeTo",v2)} type="time"/>
    </div>
    <div style={{marginBottom:12}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Venue</div><select value={f.venueId} onChange={e=>set("venueId",e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}><option value="">Select venue...</option>{venues.map(x=><option key={x.id} value={x.id}>{x.name} — {x.area}</option>)}</select>{v&&<div style={{marginTop:5,fontSize:11,color:"var(--po-dim)"}}>{isFootball?`${venuePitches.length} pitches`:`${v.courts.length} courts`} · {vPricing.pricePerHour} EGP/hr{vPricing.extraFee>0?` · +${vPricing.extraFee} booking`:""}</div>}</div>
    <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Visibility</div><div style={{display:"flex",gap:8}}>{[["🌐 Public","public"],["🔒 Private (invite-only)","private"]].map(([lbl,v2])=><button key={v2} onClick={()=>set("visibility",v2)} style={{flex:1,padding:"8px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${f.visibility===v2?"#6366F1":"var(--po-bdr)"}`,background:f.visibility===v2?"#6366F133":"var(--po-bdr)",color:f.visibility===v2?"#A5B4FC":"var(--po-dim)",fontSize:12,fontWeight:500}}>{lbl}</button>)}</div><div style={{fontSize:11,color:"var(--po-dim)",marginTop:6}}>{f.visibility==="private"?"Only members you invite can see and register for this event.":"Visible and open to all community members."}</div></div>

    {/* ── Sport ── */}
    {sportOptions.length>1&&<div style={{marginBottom:14}}><Drp label="Sport" value={f.sport} onChange={v2=>set("sport",v2)} options={sportOptions.map(s=>({v:s,l:s}))}/></div>}

    {/* ── Sport-specific fields ── */}
    {isFootball
      ? <>
          {v&&<div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Pitches (Pitch 1 selected by default)</div>{venuePitches.length===0?<div style={{fontSize:12,color:"#F59E0B",padding:"8px 10px",background:"#F59E0B11",borderRadius:8}}>This venue has no football pitches set up yet — add them by editing the venue.</div>:<div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{venuePitches.map(p=><div key={p.name} onClick={()=>togglePitch(p.name)} style={{padding:"7px 12px",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,border:`0.5px solid ${f.pitchNames.includes(p.name)?"#6366F1":"var(--po-bdr)"}`,background:f.pitchNames.includes(p.name)?"#6366F122":"var(--po-inp)",color:f.pitchNames.includes(p.name)?"#A5B4FC":"var(--po-dim)"}}>{p.name}</div>)}</div>}</div>}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:0}}>
            <Inp label="Team size" value={f.teamSize} onChange={v2=>set("teamSize",v2.replace(/\D/g,""))} type="number"/>
            <Inp label="Number of teams" value={f.numTeams} onChange={v2=>{set("numTeams",v2.replace(/\D/g,""));set("numTeamsTouched",true);}} type="number"/>
          </div>
          <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:14,marginTop:-8}}>Default: 3 teams for 1 pitch, or 2 per pitch for more — adjust anytime.</div>
        </>
      : <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Courts (max {maxC})</div><select value={f.courts} onChange={e=>set("courts",e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}>{Array.from({length:maxC},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}</select></div>}
    {c>0&&v&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>{(isFootball?[["Pitches",c],["Teams",f.numTeams||0],["Cost",`${tot} EGP`]]:[["Min",c*4],["Max",c*5],["Cost",`${tot} EGP`]]).map(([l,val])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"9px 4px",textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:"#6366F1"}}>{val}</div><div style={{fontSize:10,color:"var(--po-dim)"}}>{l}</div></div>)}</div>}
    {!isFootball&&<div style={{fontSize:11,color:"var(--po-dim)",marginBottom:14,marginTop:-8}}>Max players = courts × 5 = <b>{(parseInt(f.courts)||0)*5}</b>. Once full, new registrations automatically go to a waitlist and move up if someone cancels.</div>}
    {isFootball&&<div style={{fontSize:11,color:"var(--po-dim)",marginBottom:14,marginTop:-8}}>Max players = team size × number of teams = <b>{(parseInt(f.teamSize)||0)*(parseInt(f.numTeams)||0)}</b>. Once full, new registrations automatically go to a waitlist and move up if someone cancels.</div>}
    <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Event Type</div><div style={{display:"flex",gap:8,marginBottom:8}}>{[["Choose Now",false],["🗳 Poll (24h)",true]].map(([lbl,pm])=><button key={lbl} onClick={()=>set("pollMode",pm)} style={{flex:1,padding:"8px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${f.pollMode===pm?"#6366F1":"var(--po-bdr)"}`,background:f.pollMode===pm?"#6366F133":"var(--po-bdr)",color:f.pollMode===pm?"#A5B4FC":"var(--po-dim)",fontSize:12,fontWeight:500}}>{lbl}</button>)}</div>{!f.pollMode&&getEventTypesForSport(f.sport).map(t=><div key={t.key} onClick={()=>set("eventType",t.key)} className="po-inp" style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:"pointer",border:`0.5px solid ${f.eventType===t.key?"#6366F1":"var(--po-bdr)"}`,background:f.eventType===t.key?"#6366F122":"var(--po-inp)"}}><div style={{fontWeight:600,fontSize:13,color:f.eventType===t.key?"#A5B4FC":"var(--po-text)"}}>{t.label}</div><div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>{t.desc}</div></div>)}{f.pollMode&&<div style={{padding:"10px 12px",background:"var(--po-inp)",borderRadius:8,fontSize:12,color:"var(--po-sub)"}}>Regular Members vote 24h. Admin can override.</div>}</div>
    <Btn label="Create Event" primary onClick={()=>{if(f.name&&f.date&&f.venueId)onCreate(f);}} style={{width:"100%"}}/>
  </Card></>;
}

// ── Event Edit Form (courts + times only) ─────────────
function EventEditForm({ev,venues,commSports,onBack,onSave}){
  const sportOptions=commSports?.length?commSports:[DEFAULT_SPORT];
  const [f,setF]=useState({name:ev.name,description:ev.description||"",date:ev.date,courts:String(ev.courts),time:ev.time,timeTo:ev.timeTo||"",eventType:ev.type||"open",visibility:ev.visibility||"public",venueId:String(ev.venueId||""),sport:ev.sport||sportOptions[0],maxPlayers:ev.maxPlayers?String(ev.maxPlayers):"",teamSize:ev.teamSize?String(ev.teamSize):"5",numTeams:ev.numTeams?String(ev.numTeams):"3"});
  const set=(k,val)=>setF(p=>({...p,[k]:val}));
  const v=venues.find(x=>x.id===parseInt(f.venueId));
  const maxC=v?v.courts.length:10;
  const isFootball=f.sport==="Football";
  const vPricing=getVenuePricing(v,f.sport);
  // Neither sport's cap is typed in directly anymore — football derives it from team size ×
  // number of teams, padel derives it from courts × 5 (the real default max — courts×6 is only
  // an exception ceiling for unusual manual cases, changed 2026-08-18 per admin direction), so
  // it always stays in sync with the real fields instead of being able to drift apart from
  // them. Opening Edit on an existing event and saving recomputes and applies this immediately,
  // which is how an already-live event's cap gets corrected without touching Firestore by hand.
  useEffect(()=>{
    const computed=isFootball?(parseInt(f.teamSize)||0)*(parseInt(f.numTeams)||0):(parseInt(f.courts)||0)*5;
    if(computed>0) set("maxPlayers",String(computed));
  },[isFootball,f.teamSize,f.numTeams,f.courts]);
  const isCompleted = ev.status==="completed";
  const lockedType = !!ev.plan || isCompleted; // can't change type once a plan has been generated or event is completed
  const lockedCourts = isCompleted; // court count locked once completed — would corrupt historical match/break records
  return <><BBtn onBack={onBack} label={ev.name}/><div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>Edit Event</div>
    <Card>
      <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:14,padding:"8px 12px",background:"var(--po-card)",borderRadius:8}}>ℹ️ {isCompleted?"This event is completed — date, time, and venue can still be corrected, but courts and type are locked to protect historical results.":lockedType?"Type is locked — a plan has already been generated for this event.":"Players and plan stay unchanged unless you change the event type."}</div>
      <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
        <div style={{flex:1}}><Inp label="Event Name" value={f.name} onChange={v2=>set("name",v2)} placeholder="e.g. Monday at Galleria"/></div>
        <button type="button" onClick={()=>set("name",suggestEventName({date:f.date,time:f.time,venueName:v?.name,sport:f.sport}))} title="Suggest a name" style={{marginBottom:14,padding:"9px 12px",borderRadius:8,border:"0.5px solid #6366F1",background:"#6366F122",color:"#A5B4FC",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>✨ Suggest</button>
      </div>
      <Inp label="Description / Remark (optional)" value={f.description} onChange={v2=>set("description",v2)} placeholder="e.g. Bring extra balls" multiline/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:0}}>
        <Inp label="Date" value={f.date} onChange={v2=>set("date",v2)} type="date"/>
        <Inp label="Start Time" value={f.time} onChange={v2=>set("time",v2)} type="time"/>
        <Inp label="End Time" value={f.timeTo} onChange={v2=>set("timeTo",v2)} type="time"/>
      </div>
      {/* Venue stays editable even after the event is completed — unlike courts/type, changing
          it can't corrupt historical match/break records, it's just correcting where the
          event actually happened. */}
      <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Venue</div><select value={f.venueId} onChange={e=>set("venueId",e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}><option value="">Select venue...</option>{venues.map(x=><option key={x.id} value={x.id}>{x.name} — {x.area}</option>)}</select>{v&&<div style={{marginTop:5,fontSize:11,color:"var(--po-dim)"}}>{isFootball?`${(v.pitches||[]).length} pitches`:`${v.courts.length} courts`} · {vPricing.pricePerHour} EGP/hr{vPricing.extraFee>0?` · +${vPricing.extraFee} booking`:""}</div>}</div>
      <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:6}}>Visibility</div><div style={{display:"flex",gap:8}}>{[["🌐 Public","public"],["🔒 Private","private"]].map(([lbl,v2])=><button key={v2} onClick={()=>set("visibility",v2)} style={{flex:1,padding:"8px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${f.visibility===v2?"#6366F1":"var(--po-bdr)"}`,background:f.visibility===v2?"#6366F133":"var(--po-bdr)",color:f.visibility===v2?"#A5B4FC":"var(--po-dim)",fontSize:12,fontWeight:500}}>{lbl}</button>)}</div></div>

      {sportOptions.length>1&&<div style={{marginBottom:14}}><Drp label="Sport" value={f.sport} onChange={v2=>set("sport",v2)} options={sportOptions.map(s=>({v:s,l:s}))}/></div>}

      {isFootball&&<>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:0}}>
          <Inp label="Team size" value={f.teamSize} onChange={v2=>set("teamSize",v2.replace(/\D/g,""))} type="number"/>
          <Inp label="Number of teams" value={f.numTeams} onChange={v2=>set("numTeams",v2.replace(/\D/g,""))} type="number"/>
        </div>
        <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:14,marginTop:-8}}>Max players = team size × number of teams = <b>{(parseInt(f.teamSize)||0)*(parseInt(f.numTeams)||0)}</b>. Once full, new registrations automatically go to a waitlist and move up if someone cancels.</div>
      </>}
      {!lockedCourts&&<>
        {f.sport==="Football"
          ? <div style={{marginBottom:14,padding:"8px 10px",background:"var(--po-inp)",borderRadius:8,fontSize:11,color:"var(--po-dim)"}}>ℹ️ Pitch selection isn't editable here yet ({ev.courts} pitch{ev.courts!==1?"es":""} currently) — recreate the event to change pitches.</div>
          : <>
              <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Courts (max {maxC})</div>
                <select value={f.courts} onChange={e=>set("courts",e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}>
                  {Array.from({length:maxC},(_,i)=>i+1).map(n=><option key={n} value={n}>{n} courts (Min: {n*4}, Max: {n*5})</option>)}
                </select>
              </div>
              <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:14,marginTop:-8}}>Max players = courts × 5 = <b>{(parseInt(f.courts)||0)*5}</b>. Once full, new registrations automatically go to a waitlist and move up if someone cancels.</div>
            </>}
        <div style={{marginBottom:14}}>
          <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:6}}>Event Type{lockedType?" (locked)":""}</div>
          {getEventTypesForSport(f.sport).map(t=><div key={t.key} onClick={()=>!lockedType&&set("eventType",t.key)} className="po-inp" style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:lockedType?"default":"pointer",opacity:lockedType&&f.eventType!==t.key?0.4:1,border:`0.5px solid ${f.eventType===t.key?"#6366F1":"var(--po-bdr)"}`,background:f.eventType===t.key?"#6366F122":"var(--po-inp)"}}>
            <div style={{fontWeight:600,fontSize:13,color:f.eventType===t.key?"#A5B4FC":"var(--po-text)"}}>{t.label}</div>
          </div>)}
        </div>
      </>}
      <Btn label="Save Changes" primary onClick={()=>onSave(lockedCourts?{name:f.name,description:f.description,date:f.date,time:f.time,timeTo:f.timeTo,visibility:f.visibility,venueId:parseInt(f.venueId),sport:f.sport,maxPlayers:f.maxPlayers?parseInt(f.maxPlayers)||null:null,...(isFootball?{teamSize:parseInt(f.teamSize)||5,numTeams:parseInt(f.numTeams)||3}:{})}:{name:f.name,description:f.description,date:f.date,courts:parseInt(f.courts),time:f.time,timeTo:f.timeTo,type:f.eventType,visibility:f.visibility,venueId:parseInt(f.venueId),sport:f.sport,maxPlayers:f.maxPlayers?parseInt(f.maxPlayers)||null:null,...(isFootball?{teamSize:parseInt(f.teamSize)||5,numTeams:parseInt(f.numTeams)||3}:{})})} style={{width:"100%"}}/>
    </Card>
  </>;
}

// ══════════════════════════════════════════════════════
//  POLL BLOCK — outside EvDetail to prevent remount
// ══════════════════════════════════════════════════════
function PollBlock({ev,me,isReg,isAdmin,onVote,onResolveType}){
  if(!ev.poll||ev.poll.resolved)return null;
  const pt=EVENT_TYPES.reduce((acc,t)=>{acc[t.key]=Object.values(ev.poll.votes).filter(vs=>vs.includes(t.key)).length;return acc;},{});
  const pw=Object.entries(pt).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const mv=ev.poll.votes[me.id]||[];
  return <div className="po-inp" style={{background:"var(--po-inp)",borderRadius:10,padding:"12px",marginBottom:12}}>
    <div style={{fontSize:12,fontWeight:600,color:"#F59E0B",marginBottom:8}}>🗳 Event Type Poll</div>
    {EVENT_TYPES.map(t=>{const votes=pt[t.key],tot2=Math.max(Object.keys(ev.poll.votes).length,1),pct=Math.round(votes/tot2*100),voted=mv.includes(t.key);return <div key={t.key} onClick={()=>(isReg||isAdmin)&&onVote(t.key)} style={{marginBottom:6,cursor:(isReg||isAdmin)?"pointer":"default",padding:"8px 10px",borderRadius:8,border:`0.5px solid ${voted?"#6366F1":"var(--po-bdr)"}`,background:voted?"#6366F111":"transparent"}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:13,fontWeight:500,color:"var(--po-text)"}}>{t.label}</span><span style={{fontSize:12,color:"var(--po-dim)"}}>{votes}</span></div><div style={{height:4,background:"var(--po-bdr)",borderRadius:2}}><div style={{height:"100%",width:`${pct}%`,background:"#6366F1",borderRadius:2,transition:"width 0.3s"}}/></div></div>;})}
    {isAdmin&&<div style={{marginTop:10}}><div style={{fontSize:11,color:"var(--po-dim)",marginBottom:6}}>Override:</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{EVENT_TYPES.map(t=><SmBtn key={t.key} label={t.label} onClick={()=>onResolveType(t.key)} color={pw===t.key?"#34D399":"#6366F1"}/>)}</div></div>}
  </div>;
}

// ══════════════════════════════════════════════════════
//  BREAKS TAB
// ══════════════════════════════════════════════════════
function ResultsTable({plan, ciStands, tc, maxPts}){
  // Build cell content for each player/round
  const cellFor=(uid, round)=>{
    const onBreak=(round.onBreak||[]).some(p=>p.userId===uid);
    if(onBreak) return {text:"Break", win:false};
    for(const m of round.matches){
      const inA=m.teamA.some(p=>p.userId===uid), inB=m.teamB.some(p=>p.userId===uid);
      if(inA||inB){
        const won=(inA&&m.winner==="A")||(inB&&m.winner==="B");
        return {text:`C${m.court}${won?"-WIN":""}`, win:won};
      }
    }
    return {text:"—", win:false};
  };
  const rowBg = i => i%2===0 ? "var(--po-card)" : "var(--po-inp)";
  return <div style={{overflowX:"auto",borderRadius:8}}>
    <table style={{borderCollapse:"separate",borderSpacing:0,width:"100%",minWidth:plan.rounds.length*88+260}}>
      <thead><tr>
        <th style={{position:"sticky",left:0,zIndex:3,background:"var(--po-card)",padding:"8px 10px",textAlign:"left",fontSize:11,color:"var(--po-dim)",borderBottom:"1px solid var(--po-bdr)",boxShadow:"2px 0 4px -2px rgba(0,0,0,0.3)"}}>Player</th>
        {plan.rounds.map((r,ri)=><th key={ri} style={{padding:"8px 10px",fontSize:11,color:"var(--po-dim)",borderBottom:"1px solid var(--po-bdr)",textAlign:"center",whiteSpace:"nowrap",background:"var(--po-card)"}}>Match{ri+1}</th>)}
        <th style={{padding:"8px 10px",fontSize:11,color:"var(--po-dim)",borderBottom:"1px solid var(--po-bdr)",textAlign:"center",background:"var(--po-card)"}}>PES</th>
        <th style={{padding:"8px 10px",fontSize:11,color:"var(--po-dim)",borderBottom:"1px solid var(--po-bdr)",textAlign:"center",background:"var(--po-card)"}}>Total</th>
      </tr></thead>
      <tbody>
        {ciStands.map((s,i)=>{
          // detect ties for bracket display
          const tied = ciStands.filter(x=>x.pts===s.pts&&x.wins===s.wins&&x.courtWinSum===s.courtWinSum).length>1;
          const mp = personalMaxCI(s.breaks, personalRoundsCI(s.user.id, plan), tc);
          const pes = mp>0 ? Math.round((s.pts/mp)*100*10)/10 : 0;
          return <tr key={s.user.id}>
            <td style={{position:"sticky",left:0,zIndex:2,background:rowBg(i),padding:"6px 10px",fontSize:12,fontWeight:600,color:"var(--po-text)",whiteSpace:"nowrap",borderBottom:"0.5px solid var(--po-bdr)",boxShadow:"2px 0 4px -2px rgba(0,0,0,0.3)"}}>
              {i===0?"🏆 ":tied?`[${i+1}] `:`${i+1} `}{s.user.nickname} <span style={{fontSize:10,color:"var(--po-dim)",fontWeight:400}}>({historicUsr(s.user.id,plan,s.user.usr)})</span>
            </td>
            {plan.rounds.map((r,ri)=>{
              const c=cellFor(s.user.id,r);
              return <td key={ri} style={{padding:"6px 8px",fontSize:11,textAlign:"center",borderBottom:"0.5px solid var(--po-bdr)",background:rowBg(i),color:c.win?"#34D399":c.text==="Break"?"var(--po-dim)":"var(--po-text)",fontWeight:c.win?700:400}}>{c.text}</td>;
            })}
            <td style={{padding:"6px 10px",fontSize:12,fontWeight:600,textAlign:"center",background:rowBg(i),color:"#A5B4FC",borderBottom:"0.5px solid var(--po-bdr)"}}>{pes}%</td>
            <td style={{padding:"6px 10px",fontSize:13,fontWeight:700,textAlign:"center",background:"#6366F122",color:"#6366F1",borderBottom:"0.5px solid var(--po-bdr)"}}>{s.pts}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
// X-System preview table (Platform Admin only) — shared shape for CI (rows=players) and
// CT Ladder (rows=teams). Each row expands to show the per-match formula breakdown so the
// number is inspectable, not a black box. See PLAN: parallel scoring system.
// 3-level nested expand: row (player/team + xPES) → tap → compact per-match list
// (W/L, round, court, opponents, score, xPts) → tap a match → the formula breakdown for
// that one match (Expected/Actual/Δ/H2H). Keeps the common "who beat whom" skim fast while
// still letting the math be interrogated when actually wanted.
// Platform-Admin-only 3-way switch for the Standings tab. Everyone else never sees this —
// the tab always renders "pes" (today's official standings) for them.
function StandingsViewToggle({view,onChange}){
  const opts=[["pes","PES (Court-Based)",1],["delta","Delta",0.5],["output","PES (Performance Based)",1.5]];
  return <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"nowrap"}}>
    {opts.map(([k,label,w])=><div key={k} onClick={()=>onChange(k)} style={{flex:`${w} 1 0%`,minWidth:0,textAlign:"center",padding:"7px 4px",borderRadius:8,cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",border:`1.5px solid ${view===k?"#A78BFA":"var(--po-bdr)"}`,background:view===k?"#A78BFA22":"var(--po-inp)",color:view===k?"#A78BFA":"var(--po-dim)"}}>{label}</div>)}
  </div>;
}
function XStandingsPreview({rows}){
  const [expandedRow,setExpandedRow]=useState(null);
  const [expandedMatch,setExpandedMatch]=useState(null);
  if(!rows.length) return <div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No completed matches yet to preview.</div>;
  return <div>
    {rows.map((r,i)=>{
      const isOpen=expandedRow===r.key;
      const avgDelta=r.matches.length?r.matches.reduce((s,m)=>s+m.delta,0)/r.matches.length:0;
      return <div key={r.key} style={{marginBottom:6}}>
        <div onClick={()=>{setExpandedRow(o=>o===r.key?null:r.key);setExpandedMatch(null);}} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:8,background:"var(--po-inp)",cursor:"pointer"}}>
          <span style={{fontSize:11,color:"var(--po-dim)",width:18}}>{i+1}</span>
          <span style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{r.name}</div>
            {r.subtitle&&<div style={{fontSize:10,color:"var(--po-dim)"}}>{r.subtitle}</div>}
          </span>
          <span style={{fontSize:13,fontWeight:700,color:avgDelta>=0?"#34D399":"#EF4444",whiteSpace:"nowrap"}}>Avg Δ {avgDelta>=0?"+":""}{Math.round(avgDelta*100)}%</span>
          <span style={{fontSize:11,color:"var(--po-dim)"}}>{isOpen?"▲":"▼"}</span>
        </div>
        {isOpen&&<div style={{padding:"6px 2px"}}>
          {r.matches.map((m,mi)=>{
            const mKey=`${r.key}-${mi}`, mOpen=expandedMatch===mKey;
            return <div key={mi} style={{marginBottom:3}}>
              <div onClick={()=>setExpandedMatch(o=>o===mKey?null:mKey)} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 8px",borderRadius:6,background:"var(--po-card)",cursor:"pointer",fontSize:11}}>
                <span style={{width:14,textAlign:"center",fontWeight:700,color:m.won?"#34D399":"#EF4444"}}>{m.won?"W":"L"}</span>
                <span style={{color:"var(--po-dim)",whiteSpace:"nowrap"}}>R{m.round}·C{m.court}</span>
                <span style={{flex:1,color:"var(--po-text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.partnerName&&<span style={{color:"var(--po-dim)"}}>w/ {m.partnerName} </span>}vs {m.oppNames.join(" & ")}</span>
                <span style={{color:"var(--po-dim)",whiteSpace:"nowrap"}}>{m.hasRealScore?`${m.scoreA}–${m.scoreB}`:"no score"}</span>
                <span style={{fontWeight:700,color:m.delta>=0?"#34D399":"#EF4444",minWidth:38,textAlign:"right",whiteSpace:"nowrap"}}>{m.delta>=0?"+":""}{Math.round(m.delta*100)}%</span>
                <span style={{fontSize:9,color:"var(--po-dim)"}}>{mOpen?"▲":"▼"}</span>
              </div>
              {mOpen&&<div style={{padding:"7px 10px",background:"var(--po-inp)",borderRadius:6,marginTop:2}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px 14px",fontSize:11}}>
                  <div><span style={{color:"var(--po-dim)"}}>Expected </span><span style={{color:"var(--po-text)",fontWeight:600}}>{Math.round(m.E*100)}%</span></div>
                  <div><span style={{color:"var(--po-dim)"}}>Actual </span><span style={{color:"var(--po-text)",fontWeight:600}}>{Math.round(m.S*100)}%</span></div>
                  <div><span style={{color:"var(--po-dim)"}}>Δ </span><span style={{fontWeight:700,color:m.delta>=0?"#34D399":"#EF4444"}}>{m.delta>=0?"+":""}{Math.round(m.delta*100)}%</span></div>
                  <div><span style={{color:"var(--po-dim)"}}>H2H adj </span><span style={{color:"var(--po-text)",fontWeight:600}}>×{m.h2hFactor}</span></div>
                </div>
              </div>}
            </div>;
          })}
        </div>}
      </div>;
    })}
    <div style={{fontSize:10,color:"var(--po-dim)",marginTop:8,padding:"0 4px",lineHeight:1.5}}>🧪 Computed live from current USR and match history — not stored, not official. Δ = actual result minus what the USR gap predicted; a big favorite winning narrowly can still score negative even on a win. "no score" = matches recorded before score capture existed, treated as an average-margin win/loss.</div>
  </div>;
}
// Output PES / Output TES — deliberately flat, no expand/collapse: the owner only wants the
// three numbers that matter (Entry USR, the delta that moved it, and the result), not the
// per-match archaeology XStandingsPreview offers for the Delta view.
function OutputPESTable({rows}){
  if(!rows.length) return <div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No completed matches yet to preview.</div>;
  return <div>
    {rows.map((r,i)=><div key={r.key} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 10px",borderRadius:8,background:"var(--po-inp)",marginBottom:6}}>
      <span style={{fontSize:11,color:"var(--po-dim)",width:18}}>{i+1}</span>
      <span style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{r.name}</div>
        {r.subtitle&&<div style={{fontSize:10,color:"var(--po-dim)"}}>{r.subtitle}</div>}
      </span>
      <span style={{fontSize:11,color:"var(--po-dim)",textAlign:"right",whiteSpace:"nowrap"}}>Entry <b style={{color:"var(--po-text)"}}>{Math.round(r.entryUsr*10)/10}</b></span>
      <span style={{fontSize:11,fontWeight:700,color:r.avgDelta>=0?"#34D399":"#EF4444",textAlign:"right",whiteSpace:"nowrap"}}>{r.avgDelta>=0?"+":""}{Math.round(r.avgDelta*100)}%</span>
      <span style={{fontSize:15,fontWeight:700,color:"#A78BFA",textAlign:"right",whiteSpace:"nowrap"}}>{r.score}</span>
    </div>)}
    <div style={{fontSize:10,color:"var(--po-dim)",marginTop:4,padding:"0 4px",lineHeight:1.5}}>🧪 Output PES = Entry USR + this event's performance delta. Computed live, not stored, not official — only becomes real if this event is closed with Output PES below.</div>
  </div>;
}
function BreaksTab({plan,ev,users,bp,tc,onEditBreak,onRegenerate,isAdmin,onViewProfile}){
  const activeRegistrations=splitRegsByCapacity(ev).active;
  const bpr=Math.max(0,activeRegistrations.length-tc*4);

  // Count completed rounds (all matches have winners)
  const completedRounds=plan.rounds.filter(r=>r.matches.every(m=>m.winner!=null)).length;
  // Generated rounds = plan.rounds.length
  const generatedRounds=plan.rounds.length;

  // State of each round column:
  // ri < completedRounds  → FROZEN 🔒 (played)
  // ri < generatedRounds  → PENDING 🔄 (generated, not played — changeable from Rounds tab only)
  // ri >= generatedRounds → OPEN ✏️ (not yet generated — fully editable)

  function validate(bp2){
    const w=[];
    bp2.forEach((r,ri)=>{if(r.length!==bpr)w.push(`R${ri+1}: ${r.length} breaks (needs ${bpr})`);});
    activeRegistrations.forEach(r=>{let last=-2;bp2.forEach((round,ri)=>{if(round.includes(r.userId)){if(ri-last===1)w.push(`${users.find(u=>u.id===r.userId)?.nickname}: consecutive breaks R${ri} & R${ri+1}`);last=ri;}});});
    const counts={};activeRegistrations.forEach(r=>{counts[r.userId]=bp2.filter(b=>b.includes(r.userId)).length;});
    const vals=Object.values(counts);if(vals.length>0&&Math.max(...vals)-Math.min(...vals)>1)w.push(`Unequal breaks: max=${Math.max(...vals)}, min=${Math.min(...vals)}`);
    return w;
  }
  const warnings=validate(plan.breakPlan||[]);

  return <Card>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
      <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)"}}>Break Schedule</div>
      {isAdmin&&ev.status!=="completed"&&<button onMouseDown={e=>{e.preventDefault();onRegenerate();}}
        style={{padding:"6px 12px",borderRadius:7,border:"0.5px solid #6366F144",background:"#6366F111",color:"#A5B4FC",fontSize:12,fontWeight:500,cursor:"pointer"}}>
        🔄 Regenerate Future
      </button>}
    </div>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8}}>
      {plan.totalRounds} rounds · {tc} courts · {bpr} on break/round · Break = {bp} pts
    </div>

    {/* Legend */}
    <div style={{display:"flex",gap:10,marginBottom:6,flexWrap:"wrap"}}>
      {[["🔒","Frozen (played)","#EF444433","#EF4444"],["🔄","Pending (generated)","#F59E0B22","#F59E0B"],["✏️","Open (editable)","#34D39911","#34D399"]].map(([icon,label,bg,cl])=>
        <div key={label} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:cl}}>
          <div style={{width:20,height:20,borderRadius:4,background:bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11}}>{icon}</div>
          <span>{label}</span>
        </div>
      )}
    </div>
    <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
      {[["▶","No break","#34D399"],["🪑","Suggested","#F59E0B"],["🔐","Firm (locked)","#8B5CF6"]].map(([icon,label,cl])=>
        <div key={label} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:cl}}>
          <span style={{fontSize:12}}>{icon}</span>
          <span>{label}</span>
        </div>
      )}
    </div>

    {warnings.length>0&&<div style={{padding:"8px 12px",background:"#F59E0B11",border:"0.5px solid #F59E0B44",borderRadius:8,marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:600,color:"#F59E0B",marginBottom:4}}>⚠️ Issues:</div>
      {warnings.map((w,i)=><div key={i} style={{fontSize:11,color:"#F59E0B"}}>{w}</div>)}
    </div>}

    {isAdmin&&<div style={{fontSize:11,color:"#6366F1",marginBottom:10,padding:"6px 10px",background:"#6366F111",borderRadius:6}}>
      💡 Pending columns (🔄) change via Rounds tab swap · Open columns (✏️) tap to edit here
    </div>}

    <div style={{overflowX:"auto"}}>
      <table style={{borderCollapse:"collapse",minWidth:"100%"}}>
        <thead><tr style={{borderBottom:"0.5px solid var(--po-bdr)"}}>
          <th style={{fontSize:11,color:"var(--po-dim)",padding:"6px 10px",fontWeight:600,textAlign:"left",whiteSpace:"nowrap"}}>Player</th>
          {Array.from({length:plan.totalRounds},(_,ri)=>{
            const isFrozen=ri<completedRounds;
            const isPending=ri>=completedRounds&&ri<generatedRounds;
            const isOpen=ri>=generatedRounds;
            return <th key={ri} style={{fontSize:11,color:isFrozen?"#EF4444":isPending?"#F59E0B":"#34D399",padding:"6px 6px",fontWeight:600,textAlign:"center",minWidth:38}}>
              R{ri+1}<br/>
              <span style={{fontSize:13}}>{isFrozen?"🔒":isPending?"🔄":"✏️"}</span>
            </th>;
          })}
          <th style={{fontSize:11,color:"var(--po-dim)",padding:"6px 8px",fontWeight:600,textAlign:"center"}}>Total</th>
        </tr></thead>
        <tbody>{ev.registrations.map(r=>{
          const u=users.find(u=>u.id===r.userId);if(!u)return null;
          const totalB=(plan.breakPlan||[]).filter(b=>b.includes(u.id)).length;
          return <tr key={u.id} style={{borderBottom:"0.5px solid var(--po-bdr)"}}>
            <td style={{padding:"6px 10px",whiteSpace:"nowrap"}}>
              <div onClick={()=>onViewProfile&&onViewProfile(u.id)} style={{display:"flex",alignItems:"center",gap:6,cursor:onViewProfile?"pointer":"default"}}>
                <Av u={u} size={22}/>
                <span style={{fontSize:12,color:"var(--po-text)",fontWeight:500}}>{u.nickname}</span>
              </div>
            </td>
            {Array.from({length:plan.totalRounds},(_,ri)=>{
              const onB=(plan.breakPlan?.[ri]||[]).includes(u.id);
              const isFrozen=ri<completedRounds;
              const isPending=ri>=completedRounds&&ri<generatedRounds;
              const isOpen=ri>=generatedRounds;
              const canEdit=isOpen&&isAdmin; // only open rounds, and only admins, may edit from the Breaks tab

              const isFirm = isOpen && (plan.firmBreaks?.[ri]||[]).includes(u.id);
              const bg   = isFirm ? "#8B5CF633" : onB ? (isFrozen?"#EF444422":isPending?"#F59E0B22":"#F59E0B33") : (isFrozen?"#33333322":isPending?"var(--po-bdr)":"#34D39911");
              const bdr  = isFirm ? "#8B5CF6AA" : onB ? (isFrozen?"#EF444455":isPending?"#F59E0B55":"#F59E0B44") : (isFrozen?"#33333344":isPending?"#1E293B44":"#34D39933");
              const icon = isFirm ? "🔐" : onB ? "🪑" : (isFrozen?"—":isPending?"·":"▶");

              return <td key={ri} style={{padding:"3px 4px",textAlign:"center"}}>
                <div
                  onClick={()=>canEdit&&onEditBreak(ri,u.id)}
                  style={{width:32,height:32,borderRadius:6,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center",fontSize:onB?14:11,background:bg,border:`0.5px solid ${bdr}`,cursor:canEdit?"pointer":"default",transition:"all 0.15s",opacity:isFrozen?0.5:1}}>
                  {icon}
                </div>
              </td>;
            })}
            <td style={{padding:"6px 8px",textAlign:"center"}}>
              <span style={{fontSize:13,fontWeight:700,color:warnings.length>0?"#F59E0B":"#34D399"}}>{totalB}</span>
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {isAdmin&&<div style={{marginTop:10,fontSize:11,color:"var(--po-dim)"}}>Tap an open cell to cycle: ▶ none → 🪑 suggested → 🔐 firm (locked — survives Regenerate) → back to none</div>}
  </Card>;
}

// ══════════════════════════════════════════════════════
//  CT TEAM CARD
// ══════════════════════════════════════════════════════
function CTTeamCard({team,group,sport,showBreakPref,isAdmin,onSetTeamBreakPref,canEdit,selectedUserId,onPlayerTap,onRenameTeam}){
  const isFootballEv = sport==="Football";
  const poolColors = ["#6366F1","#06B6D4","#F472B6","#34D399","#F59E0B"];
  const isPool = group && group.startsWith("P");
  const poolNum = isPool ? parseInt(group.slice(1))-1 : (group==="A"?0:1);
  const gc = poolColors[poolNum % poolColors.length];
  const badgeLabel = isPool ? group : `Group ${group}`;
  const badgeIcon = isPool ? group : group;
  const [editingName,setEditingName] = useState(false);
  const [nameVal,setNameVal] = useState(team.name);
  const saveName = () => {
    setEditingName(false);
    const trimmed = nameVal.trim();
    if(trimmed && trimmed!==team.name && onRenameTeam) onRenameTeam(team.id,trimmed);
    else setNameVal(team.name);
  };
  return <Card style={{marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:10}}>
    <div style={{width:36,height:36,borderRadius:8,background:`${gc}22`,border:`0.5px solid ${gc}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:gc,flexShrink:0}}>{badgeIcon}{team.id}</div>
    <div style={{flex:1}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
        {editingName
          ? <input autoFocus value={nameVal} onChange={e=>setNameVal(e.target.value)} onBlur={saveName} onKeyDown={e=>{if(e.key==="Enter")saveName();if(e.key==="Escape"){setNameVal(team.name);setEditingName(false);}}} className="po-inp" style={{fontSize:13,fontWeight:600,padding:"2px 6px",borderRadius:5,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",width:120}}/>
          : <span style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{team.name}</span>}
        {isAdmin&&onRenameTeam&&!editingName&&<span onClick={()=>{setNameVal(team.name);setEditingName(true);}} style={{fontSize:11,cursor:"pointer",color:"var(--po-dim)"}}>✏️</span>}
        <span style={{fontSize:12,color:"var(--po-dim)"}}>({isFootballEv?footballGradeLabel(team.avgUsr):team.avgUsr})</span>
        <Bdg label={badgeLabel} color={gc}/>
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:10}}>{team.players.map(p=>{
        const uid=p.userId||p.id, isSel=selectedUserId===uid;
        return <div key={uid} onClick={canEdit?()=>onPlayerTap(team.id,uid):undefined}
          style={{display:"flex",alignItems:"center",gap:4,cursor:canEdit?"pointer":"default",padding:isSel?"2px 6px":"2px 0",borderRadius:6,background:isSel?"#FBBF2422":"transparent",border:isSel?"0.5px solid #FBBF2466":"0.5px solid transparent"}}>
          <Av u={p} size={22}/><span className="po-sub" style={{fontSize:12,color:isSel?"#FBBF24":"var(--po-sub)",fontWeight:isSel?700:400}}>{p.nickname}</span><span style={{fontSize:10,color:"var(--po-dim)"}}>{isFootballEv?(p.footballSkill||"?"):p.usr}</span>
        </div>;
      })}</div>
      {showBreakPref&&(isAdmin
        ? <div style={{display:"flex",alignItems:"center",gap:4,marginTop:6}}>
            <span style={{fontSize:10,color:"var(--po-dim)"}}>Break:</span>
            <select value={team.breakPref||"none"} onChange={e=>onSetTeamBreakPref&&onSetTeamBreakPref(team.id,e.target.value)} className="po-inp" style={{fontSize:10,padding:"1px 4px",borderRadius:5,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)"}}>
              <option value="none">No Preference</option>
              <option value="early">Prefer Early</option>
              <option value="mid">Prefer Mid</option>
              <option value="late">Prefer Late</option>
            </select>
          </div>
        : <div style={{fontSize:10,color:"var(--po-dim)",marginTop:4}}>Break: {BREAK_PREF_LABELS[team.breakPref||"none"]}</div>
      )}
    </div>
  </div></Card>;
}

// Football-only, optional per-TEAM goal tally — one instance per side, so a side's tagged
// goals can only ever be checked against that same side's own score (mixing both teams into
// one shared list was the actual bug: a team-2 player could show more goals tagged than team 2
// even scored, with nothing to catch it since the old check summed both teams together).
// Fully controlled (scorers/expanded from the parent) — not just for reuse across the
// live-draft/decided-match contexts, but because MatchCard is defined *inside* CTMatchesTab's
// render body, so it gets a fresh function identity (and everything under it remounts) on
// every CTMatchesTab re-render. Any state kept locally in here — like whether the editor panel
// is open — got wiped on literally every +/- tap (which itself triggers that re-render),
// collapsing the panel after each click. Lifting `expanded` up to CTMatchesTab's own state
// (which does NOT remount) fixes that at the root.
// onChangeScorers fires live on every +/- tap (so the per-player counters update instantly and
// the tally is never lost) but deliberately does NOT touch the match score — that only happens
// in onClose, fired once when ✕ is tapped, so the big score number doesn't visibly jump around
// while goals are still being tagged. onClose is expected to raise the score up to the tagged
// total if it's currently lower (the score is a floor on the scorers sum, never the reverse).
function TeamGoalsEditor({players,scorers,onChangeScorers,onClose,teamGoals,isAdmin,expanded,onToggleExpand,showSummaryText}){
  const tagged = (scorers||[]).reduce((s,x)=>s+(x.goals||0),0);
  const bump = (uid,d) => {
    const cur = scorers||[];
    const newGoals = Math.max(0,(cur.find(x=>x.userId===uid)?.goals||0)+d);
    const next = cur.filter(x=>x.userId!==uid);
    if(newGoals>0) next.push({userId:uid,goals:newGoals});
    onChangeScorers(next);
  };
  const close = () => { onClose&&onClose(); onToggleExpand(); };
  if(!isAdmin && (!scorers||scorers.length===0)) return null;
  const hasScorers = scorers&&scorers.length>0;
  if(!expanded){
    return <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
      <button onClick={()=>isAdmin&&onToggleExpand()} disabled={!isAdmin} style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:7,border:"0.5px solid #6366F144",background:"#6366F111",color:"#A5B4FC",cursor:isAdmin?"pointer":"default",whiteSpace:"nowrap"}}>⚽ Scorers</button>
      {hasScorers&&showSummaryText&&<div style={{fontSize:10,color:"var(--po-dim)",textAlign:"center",maxWidth:130}}>{scorers.map(s=>{const p=players.find(pp=>(pp.userId||pp.id)===s.userId);return `${p?.nickname||"?"}${s.goals>1?` x${s.goals}`:""}`;}).join(", ")}</div>}
    </div>;
  }
  return <div style={{marginTop:6,padding:"8px 10px",background:"var(--po-inp)",borderRadius:8,minWidth:180}}>
    <div style={{fontSize:11,fontWeight:600,color:"var(--po-dim)",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
      <span>⚽ Scorers{teamGoals!=null&&tagged!==teamGoals?<span style={{color:"#F59E0B"}}> ({tagged}/{teamGoals})</span>:""}</span>
      <button onClick={close} style={{width:28,height:28,borderRadius:7,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",color:"var(--po-text)",fontSize:15,fontWeight:700,cursor:"pointer",lineHeight:1,flexShrink:0}}>✕</button>
    </div>
    {players.map(p=>{
      const uid=p.userId||p.id;
      const g=(scorers||[]).find(x=>x.userId===uid)?.goals||0;
      return <div key={uid} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0"}}>
        <span style={{fontSize:12,color:"var(--po-text)"}}>{p.nickname}</span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={()=>bump(uid,-1)} style={{width:30,height:30,borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",fontSize:16,fontWeight:700,color:"var(--po-text)",cursor:"pointer",lineHeight:1}}>−</button>
          <span style={{fontSize:14,fontWeight:700,minWidth:16,textAlign:"center",color:"var(--po-text)"}}>{g}</span>
          <button onClick={()=>bump(uid,1)} style={{width:30,height:30,borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",fontSize:16,fontWeight:700,color:"var(--po-text)",cursor:"pointer",lineHeight:1}}>+</button>
        </div>
      </div>;
    })}
  </div>;
}

// ══════════════════════════════════════════════════════
//  CT MATCHES TAB
// ══════════════════════════════════════════════════════
function CTBreaksTab({plan,tc,onRegenBreaks,onSwapBreak,onToggleFirm,isAdmin}){
  const [selSwap, setSelSwap] = useState(null); // {ri, tid} for pending swap
  const teams = plan.sorted || plan.teams;
  const totalRounds = plan.maxRounds || plan.rounds.length;
  const breakPlan = plan.breakPlan || [];
  const firmBreaks = plan.firmBreaks || {};
  const generatedCount = plan.rounds.length;
  // Teams that are currently on break in each round (from breakPlan)
  const breakSet = (ri) => new Set(breakPlan[ri]||[]);

  function handleCellTap(ri, t){
    if(!isAdmin) return;
    if(ri < generatedCount) return; // locked/generated — can't swap
    if(!selSwap){
      // First tap: only meaningful to tap a break slot
      if(breakSet(ri).has(t.id)) setSelSwap({ri, tid:t.id});
      return;
    }
    if(selSwap.ri !== ri){setSelSwap(null); return;} // different round — cancel
    if(selSwap.tid === t.id){setSelSwap(null); return;} // same team — deselect
    // Two different teams in same ungenerated round — swap break
    onSwapBreak&&onSwapBreak(ri, selSwap.tid, t.id);
    setSelSwap(null);
  }

  function cellStyle(ri, t){
    const onBreak = breakSet(ri).has(t.id);
    const isGenerated = ri < generatedCount;
    const isSel = selSwap&&selSwap.ri===ri&&selSwap.tid===t.id;
    const canInteract = !isGenerated&&isAdmin;
    return {
      padding:"6px 4px", textAlign:"center",
      borderBottom:"0.5px solid var(--po-bdr)",
      cursor:canInteract?"pointer":"default",
      background: isSel?"#6366F133":onBreak&&!isGenerated?"#F59E0B11":"transparent",
    };
  }

  const teamLabel = (t) => {
    const players = t.players||[];
    if(players.length===0) return t.name;
    return players.map(p=>p.nickname).join(" & ");
  };

  return <>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,gap:8}}>
      <div style={{fontSize:11,color:"var(--po-dim)"}}>
        {isAdmin?"🔒 Frozen · 🔄 Generated · ✏️ Open (tap ☕ to swap · tap 🔐 to lock/unlock Firm)":"🔒 Frozen · 🔄 Generated · ✏️ Open"}
      </div>
      {isAdmin&&onRegenBreaks&&<button onClick={()=>{if(window.confirm("Regenerate break schedule?\n\nThis will recalculate breaks for all ungenerated rounds based on current teams. Generated rounds are not affected."))onRegenBreaks();}} style={{padding:"5px 12px",borderRadius:6,border:"0.5px solid #F59E0B44",background:"#F59E0B11",color:"#F59E0B",fontSize:11,fontWeight:600,cursor:"pointer"}}>🔄 Regenerate Breaks</button>}
    </div>
    {selSwap&&<div style={{marginBottom:8,padding:"8px 12px",background:"#6366F111",borderRadius:8,fontSize:12,color:"#A5B4FC"}}>
      ✋ {teams.find(t=>t.id===selSwap.tid)?.name} selected — tap another team in R{selSwap.ri+1} to swap break
    </div>}
    <div style={{overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
      <table style={{borderCollapse:"collapse",tableLayout:"fixed",minWidth:Math.max(280, 140+totalRounds*42)}}>
        <colgroup>
          <col style={{width:140}}/>
          {Array.from({length:totalRounds},(_,ri)=><col key={ri} style={{width:42}}/>)}
        </colgroup>
        <thead><tr>
          <th style={{position:"sticky",left:0,zIndex:2,background:"var(--po-card)",padding:"8px 10px",textAlign:"left",fontSize:11,color:"var(--po-dim)",borderBottom:"1px solid var(--po-bdr)"}}>Team / Players</th>
          {Array.from({length:totalRounds},(_,ri)=>{
            const isFrozen=ri<generatedCount&&plan.rounds[ri]?.matchesA?.every(m=>m.winner!=null);
            const isPending=ri<generatedCount&&!isFrozen;
            return <th key={ri} style={{fontSize:11,color:isFrozen?"#EF4444":isPending?"#F59E0B":"#34D399",padding:"6px 0",fontWeight:600,textAlign:"center",borderBottom:"1px solid var(--po-bdr)",width:38}}>R{ri+1}</th>;
          })}
        </tr></thead>
        <tbody>
          {teams.map((t,i)=><tr key={t.id} style={{background:i%2===0?"transparent":"var(--po-bdr)11"}}>
            <td style={{position:"sticky",left:0,background:i%2===0?"var(--po-card)":"var(--po-cardAlt,var(--po-card))",padding:"6px 10px",fontSize:11,fontWeight:600,color:"var(--po-text)",borderBottom:"0.5px solid var(--po-bdr)"}}>
              <div>{t.name}</div>
              <div style={{fontWeight:400,fontSize:10,color:"var(--po-dim)"}}>{(t.players||[]).map(p=>p.nickname).join(" & ")}</div>
            </td>
            {Array.from({length:totalRounds},(_,ri)=>{
              const onBreak=breakSet(ri).has(t.id);
              const isGenerated=ri<generatedCount;
              const isSel=selSwap&&selSwap.ri===ri&&selSwap.tid===t.id;
              const isFirm=!isGenerated&&(firmBreaks[ri]||[]).includes(t.id);
              return <td key={ri} onClick={()=>handleCellTap(ri,t)} style={{...cellStyle(ri,t),position:"relative",background:isFirm?"#8B5CF622":cellStyle(ri,t).background}}>
                {onBreak
                  ? <span style={{fontSize:13,opacity:isGenerated?1:0.65,color:isFirm?"#8B5CF6":isSel?"#6366F1":"#F59E0B"}}>{isFirm?"🔐":"☕"}</span>
                  : <span style={{color:"var(--po-dim)",fontSize:11}}>·</span>
                }
                {onBreak&&!isGenerated&&isAdmin&&<span onClick={e=>{e.stopPropagation();onToggleFirm&&onToggleFirm(ri,t.id);}} title={isFirm?"Unlock":"Lock as Firm"} style={{position:"absolute",top:0,right:1,fontSize:8,cursor:"pointer",opacity:0.6}}>{isFirm?"🔓":"🔐"}</span>}
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    {isAdmin&&generatedCount<totalRounds&&<div style={{marginTop:8,fontSize:10,color:"var(--po-dim)"}}>Rounds {generatedCount+1}–{totalRounds}: planned · not yet generated · tap ☕ then another team to swap</div>}
  </>;
}


function CTMatchesTab({plan,sport,comms,onSetWinCT,onSetCTScorers,onToggleCTLeagueLive,onApplyPromo,onNextFootballRound,onNextCTLadder,onSwapCTLadder,totalBookingMin,eventDate,eventTime,eventId,sim,onSetMatchModeStart,onStopMatchMode,isAdmin}){
  const isFootballEv = sport==="Football";
  const teamRatingLabel = v => isFootballEv ? footballGradeLabel(v) : v;
  const [selT,setSelT]=useState(null); // {ri,tid} for ladder team swap
  const [scores,setScores]=useState({});
  // Which per-team goal-scorer editors are expanded — kept here (not inside TeamGoalsEditor
  // itself) since MatchCard remounts on every re-render; see TeamGoalsEditor's comment.
  const [expandedGoals,setExpandedGoals]=useState({});
  const toggleGoalsExpand=key=>setExpandedGoals(g=>({...g,[key]:!g[key]}));
  const [collapsedRounds,setCollapsedRounds]=useState(new Set()); // manually toggled rounds (overrides the completed-round default)

  function getS(ri,mi,side){return scores[`${ri}_${mi}_${side}`]||{scoreA:0,scoreB:0,scorersA:[],scorersB:[]};}
  function setS(ri,mi,side,field,val){setScores(s=>({...s,[`${ri}_${mi}_${side}`]:{...getS(ri,mi,side),[field]:val}}));}
  // Decided-match scorer editing draft — same local-then-commit-on-close pattern as getS/setS
  // above, kept in its own key so it doesn't collide with a pending match's draft. Needed
  // because reading m.scorersA/scorersB directly at commit time is subject to Firestore's
  // round-trip latency: tag 2 goals quickly then hit close, and the close handler could still
  // see only the first tap's write if it reads off m instead of this synchronous local draft
  // (this exact race is what let a team's recorded score stay below its own tagged goal count).
  function getDS(ri,mi,side,m){ return scores[`${ri}_${mi}_${side}_decided`] || {scorersA:m.scorersA||[], scorersB:m.scorersB||[]}; }
  function setDS(ri,mi,side,m,field,val){ const cur=getDS(ri,mi,side,m); setScores(s=>({...s,[`${ri}_${mi}_${side}_decided`]:{...cur,[field]:val}})); }
  const gcA="#6366F1",gcB="#06B6D4";
  const isLeague=plan.format==="league";
  const tc=plan.courts;

  // All matches done in current round?
  const lastRound=plan.rounds[plan.rounds.length-1];
  const lastRoundDone=lastRound&&[...lastRound.matchesA,...(lastRound.matchesB||[])].every(m=>m.winner);

  // A team can only really be playing one match at a time. The widget only ever reads the
  // LATEST round for "live" matches (mmBuildCTLeaguePayload), so that's the only round a
  // team can actually be live in right now — checking the card's own round (ri) instead of
  // always the latest missed conflicts entirely whenever the card in question (e.g. an
  // already-completed match) sits in an earlier round than the live one.
  function isTeamLiveElsewhere(ri,mi,side,teamId){
    if(teamId==null)return false;
    const lastRi=plan.rounds.length-1;
    const round=plan.rounds[lastRi];
    if(!round)return false;
    const all=[...(round.matchesA||[]).map((mm,i)=>({mm,s:"A",i})),...(round.matchesB||[]).map((mm,i)=>({mm,s:"B",i}))];
    return all.some(({mm,s,i})=>!(ri===lastRi&&s===side&&i===mi)&&mm.live&&!mm.winner&&(mm.teamA?.id===teamId||mm.teamB?.id===teamId));
  }

  function MatchCard({m,ri,mi,side}){
    const gc=side==="A"?gcA:gcB, sc=getS(ri,mi,side);
    const h2h=calcExactHeadToHead(comms||[], (m.teamA?.players||[]).map(p=>p.userId), (m.teamB?.players||[]).map(p=>p.userId), {excludeEventId:eventId, beforeRound:ri});
    const H2HRow=()=>h2h.meetings===0?null:<div style={{textAlign:"center",marginBottom:5,fontSize:12,fontWeight:700,padding:"4px 6px",borderRadius:7,background:"var(--po-inp)"}}>
      <span style={{color:gcA}}>{Math.round(h2h.sideAWinRate*100)}%</span> <span style={{fontSize:10}}>📊</span> <span style={{color:gcB}}>{Math.round(h2h.sideBWinRate*100)}%</span> <span style={{fontWeight:400,fontSize:10,color:"var(--po-dim)"}}>({h2h.meetings}n)</span>
    </div>;
    // USR-gap fallback badge — shown whenever there's no head-to-head history, whether the
    // match is still open or already settled, so reviewing an old match keeps the same
    // context that was available when the winner was picked.
    const bAvgA=m.teamA?.avgUsr??0, bAvgB=m.teamB?.avgUsr??0, bGap=Math.abs(bAvgA-bAvgB);
    const BalanceBadge=()=>(h2h.meetings===0&&bAvgA!==bAvgB)?<span title={`USR gap: ${bGap} (${m.teamA?.name} avg ${bAvgA} vs ${m.teamB?.name} avg ${bAvgB}) — no head-to-head history yet`} style={{fontSize:10,fontWeight:700,color:bGap<=5?"#34D399":bGap<=10?"#F59E0B":"#EF4444"}}>⚖️ {bAvgA>bAvgB?m.teamA?.name:m.teamB?.name} +{Math.round((bGap/((bAvgA+bAvgB)/2))*100)}%</span>:null;
    // Same conflict check for both states below — a completed match's teams can still be
    // "busy" if one of them is now live in a different, still-undecided match, so it needs
    // the same dimming treatment as an undecided match would.
    // isTeamLiveElsewhere already excludes this exact card's own position from its scan
    // (ri/side/mi), so the actually-live card's own conflictA/conflictB always come back
    // false on their own — no extra "&& !m.live" guard needed here. That guard used to be
    // here and was the actual bug: a completed match can go on carrying a stale live:true
    // from before it was decided (now cleared going forward by setWinCT, but harmless
    // either way since this no longer depends on m.live at all).
    const conflictA=isLeague&&isTeamLiveElsewhere(ri,mi,side,m.teamA?.id);
    const conflictB=isLeague&&isTeamLiveElsewhere(ri,mi,side,m.teamB?.id);
    const hasConflict=conflictA||conflictB;
    if(m.winner){return <Card style={{marginBottom:6,padding:"10px 12px",border:"0.5px solid #34D39444",opacity:hasConflict?0.5:1}}>
      {hasConflict&&<div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,fontWeight:600,color:"#EF4444",background:"#EF444411",borderRadius:7,padding:"5px 8px",marginBottom:6}}>⚠️ {conflictA?m.teamA?.name:m.teamB?.name} live elsewhere right now</div>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
        <span style={{fontSize:10,fontWeight:700,color:"var(--po-dim)",textTransform:"uppercase"}}>{isFootballEv?"Pitch":"Court"} {m.court}{isLeague&&!isFootballEv?` · Group ${side}`:""}</span>
        <Bdg label={`${m.winner==="A"?m.teamA?.name:m.teamB?.name} wins`} color="#34D399"/>
      </div>
      {(()=>{
        const ds = isFootballEv ? getDS(ri,mi,side,m) : null;
        // Shared by both teams' close buttons — either one commits both sides together, so
        // it's correct regardless of which panel the admin actually closes. Reads only from
        // the synchronous local draft (ds), never from m, so there's no dependency on a
        // Firestore round-trip having completed yet.
        const commitDecidedScorers = () => {
          const sumA=(ds.scorersA||[]).reduce((s,x)=>s+x.goals,0), sumB=(ds.scorersB||[]).reduce((s,x)=>s+x.goals,0);
          onSetCTScorers(ri,mi,side, ds.scorersA||[], ds.scorersB||[]);
          const newScoreA=Math.max(m.scoreA||0,sumA), newScoreB=Math.max(m.scoreB||0,sumB);
          if(newScoreA!==m.scoreA||newScoreB!==m.scoreB) onSetWinCT(ri,mi,side,m.winner,newScoreA,newScoreB);
        };
        return <div style={{display:"flex",alignItems:"flex-start",gap:6,marginBottom:5}}>
          <div style={{flex:1,textAlign:"center"}}>
            <div style={{fontSize:11,color:gc,fontWeight:600}}>{m.teamA?.name}</div>
            <div style={{fontSize:10,color:"var(--po-dim)"}}>{(m.teamA?.players||[]).map(p=>p.nickname).join(" & ")}</div>
            <div style={{fontSize:19,fontWeight:700,color:m.winner==="A"?"#34D399":"var(--po-dim)",marginTop:2}}>{m.scoreA}</div>
            {isFootballEv&&<TeamGoalsEditor players={m.teamA?.players||[]} scorers={ds.scorersA}
              onChangeScorers={v=>setDS(ri,mi,side,m,"scorersA",v)}
              onClose={commitDecidedScorers}
              teamGoals={m.scoreA} isAdmin={isAdmin} showSummaryText
              expanded={!!expandedGoals[`${ri}_${mi}_${side}_dA`]} onToggleExpand={()=>toggleGoalsExpand(`${ri}_${mi}_${side}_dA`)}/>}
          </div>
          <div style={{fontSize:12,color:"#334155",fontWeight:700,marginTop:2}}>—</div>
          <div style={{flex:1,textAlign:"center"}}>
            <div style={{fontSize:11,color:gc,fontWeight:600}}>{m.teamB?.name}</div>
            <div style={{fontSize:10,color:"var(--po-dim)"}}>{(m.teamB?.players||[]).map(p=>p.nickname).join(" & ")}</div>
            <div style={{fontSize:19,fontWeight:700,color:m.winner==="B"?"#34D399":"var(--po-dim)",marginTop:2}}>{m.scoreB}</div>
            {isFootballEv&&<TeamGoalsEditor players={m.teamB?.players||[]} scorers={ds.scorersB}
              onChangeScorers={v=>setDS(ri,mi,side,m,"scorersB",v)}
              onClose={commitDecidedScorers}
              teamGoals={m.scoreB} isAdmin={isAdmin} showSummaryText
              expanded={!!expandedGoals[`${ri}_${mi}_${side}_dB`]} onToggleExpand={()=>toggleGoalsExpand(`${ri}_${mi}_${side}_dB`)}/>}
          </div>
        </div>;
      })()}
      <H2HRow/>
      <BalanceBadge/>
      {isAdmin&&<div style={{display:"flex",justifyContent:"flex-end"}}><SmBtn label="↩ Undo" onClick={()=>onSetWinCT(ri,mi,side,null,0,0)} color="#EF4444"/></div>}
    </Card>;}

    return <Card style={{marginBottom:6,padding:"10px 12px",opacity:hasConflict?0.5:1}}>
      {hasConflict&&<div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,fontWeight:600,color:"#EF4444",background:"#EF444411",borderRadius:7,padding:"5px 8px",marginBottom:6}}>⚠️ {conflictA?m.teamA?.name:m.teamB?.name} already live elsewhere — can't also flag this one</div>}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,gap:8,flexWrap:"wrap"}}>
        <span style={{fontSize:10,fontWeight:700,color:"var(--po-dim)",textTransform:"uppercase"}}>{isFootballEv?"Pitch":"Court"} {m.court}{isLeague&&!isFootballEv?` · Group ${side}`:""}{!isLeague&&<span style={{color:"#38BDF8",marginLeft:8,textTransform:"none",fontSize:11}}> win = {ctLadderCourtPts(m.court,tc)} pts</span>}</span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <BalanceBadge/>
          {/* Whether this match shows on the admin's Match Mode widget — display-only there
              (no tap-to-record), doesn't touch winner/score. Same tap-to-toggle interaction
              as the break-lock 🔓/🔐 badges elsewhere in this screen. Blocked while a
              conflicting team is already live elsewhere. */}
          {isLeague&&isAdmin&&onToggleCTLeagueLive&&<span onClick={()=>!hasConflict&&onToggleCTLeagueLive(ri,mi,side)} style={{fontSize:10,fontWeight:700,padding:"3px 9px",borderRadius:20,cursor:hasConflict?"default":"pointer",display:"inline-flex",alignItems:"center",gap:5,background:m.live?"#EF444422":"var(--po-inp)",color:m.live?"#EF4444":"var(--po-dim)",border:`0.5px solid ${m.live?"#EF444455":"var(--po-bdr)"}`}}>{m.live?"🔴 Live on widget":"⚪ Not on widget"}</span>}
        </div>
      </div>
      {(()=>{
        const ri2=plan.rounds.findIndex(r=>r.roundNum===plan.rounds[plan.rounds.length-1].roundNum);
        function TeamBox({team,side2}){const isSel=selT&&selT.ri===ri2&&selT.tid===team?.id;
          const oppTeam=team===m.teamA?m.teamB:m.teamA;
          const myIds=(team?.players||[]).map(p=>p.userId), oppIds=(oppTeam?.players||[]).map(p=>p.userId);
          return <div onClick={()=>{if(!isAdmin||!onSwapCTLadder||isLeague)return;if(selT&&selT.ri===ri2&&selT.tid!==team?.id){onSwapCTLadder(ri2,selT.tid,team.id);setSelT(null);}else setSelT({ri:ri2,tid:team?.id});}} style={{textAlign:"center",padding:"3px",borderRadius:8,border:`1.5px solid ${isSel?"#FBBF24":"transparent"}`,background:isSel?"#FBBF2411":"transparent",cursor:isAdmin&&!isLeague&&onSwapCTLadder?"pointer":"default"}}>
            <div style={{fontSize:12,fontWeight:600,color:isSel?"#FBBF24":"var(--po-text)",marginBottom:1}}>{team?.name} <span style={{fontSize:10,color:"var(--po-dim)"}}>({teamRatingLabel(team?.avgUsr)})</span></div>
            <div style={{fontSize:10,color:"var(--po-dim)",display:"flex",flexWrap:"wrap",justifyContent:"center",gap:4}}>
              {(team?.players||[]).map((p,pi)=>{const badge=personalMatchBadge(comms||[],p.userId,myIds,oppIds);return <span key={p.userId}>{pi>0&&"& "}{p.nickname} ({isFootballEv?(p.footballSkill||"?"):p.usr}){badge.isDream&&" 🔥"}{badge.isFunny&&" 😂"}</span>;})}
            </div>
          </div>;}
        return <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:6,marginBottom:6,alignItems:"center"}}><TeamBox team={m.teamA} side2="A"/><span style={{fontSize:11,color:"#334155",fontWeight:700}}>VS</span><TeamBox team={m.teamB} side2="B"/></div>;
      })()}
      <H2HRow/>
      {isAdmin?<>
        <div style={{display:"flex",justifyContent:"center",alignItems:"flex-start",gap:14,marginBottom:6,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"flex-start",gap:6}}>
            {isFootballEv&&<TeamGoalsEditor players={m.teamA?.players||[]} scorers={sc.scorersA}
              onChangeScorers={v=>setS(ri,mi,side,"scorersA",v)}
              onClose={()=>{const sum=(sc.scorersA||[]).reduce((s,x)=>s+x.goals,0);if(sum>sc.scoreA)setS(ri,mi,side,"scoreA",sum);}}
              teamGoals={sc.scoreA} isAdmin={isAdmin} showSummaryText
              expanded={!!expandedGoals[`${ri}_${mi}_${side}_A`]} onToggleExpand={()=>toggleGoalsExpand(`${ri}_${mi}_${side}_A`)}/>}
            <ScoreStepper value={sc.scoreA} onChange={v=>setS(ri,mi,side,"scoreA",v)} label={m.teamA?.name||"A"}/>
          </div>
          <div style={{fontSize:14,color:"#334155",fontWeight:700,marginTop:14}}>—</div>
          <div style={{display:"flex",alignItems:"flex-start",gap:6}}>
            <ScoreStepper value={sc.scoreB} onChange={v=>setS(ri,mi,side,"scoreB",v)} label={m.teamB?.name||"B"} flip/>
            {isFootballEv&&<TeamGoalsEditor players={m.teamB?.players||[]} scorers={sc.scorersB}
              onChangeScorers={v=>setS(ri,mi,side,"scorersB",v)}
              onClose={()=>{const sum=(sc.scorersB||[]).reduce((s,x)=>s+x.goals,0);if(sum>sc.scoreB)setS(ri,mi,side,"scoreB",sum);}}
              teamGoals={sc.scoreB} isAdmin={isAdmin} showSummaryText
              expanded={!!expandedGoals[`${ri}_${mi}_${side}_B`]} onToggleExpand={()=>toggleGoalsExpand(`${ri}_${mi}_${side}_B`)}/>}
          </div>
        </div>
        {(()=>{
          // Floor-enforced at the actual commit point, not just when the goals panel is
          // closed — tagging goals then tapping a win/lose button directly (without closing
          // the panel first) is a completely normal flow, and skipping this here is exactly
          // what let a team's saved score end up below its own tagged goal count.
          const sumA=(sc.scorersA||[]).reduce((s,x)=>s+x.goals,0), sumB=(sc.scorersB||[]).reduce((s,x)=>s+x.goals,0);
          const fA=Math.max(sc.scoreA,sumA), fB=Math.max(sc.scoreB,sumB);
          return <>
            {fA===fB&&fA>0&&<div style={{textAlign:"center",fontSize:11,color:"#F59E0B",marginBottom:6}}>⚠️ Tied — adjust score to confirm winner</div>}
            <div style={{display:"flex",gap:6}}>
              <button onMouseDown={e=>{e.preventDefault();onSetWinCT(ri,mi,side,"A",fA,fB);if(isFootballEv&&(sc.scorersA?.length||sc.scorersB?.length))onSetCTScorers(ri,mi,side,sc.scorersA||[],sc.scorersB||[]);}}
                disabled={fA<=fB}
                style={{flex:1,padding:"8px 0",borderRadius:8,border:`0.5px solid ${fA>fB?"#6366F144":"var(--po-bdr)"}`,background:fA>fB?"#6366F122":"transparent",color:fA>fB?"#A5B4FC":"var(--po-dim)",fontSize:12,fontWeight:600,cursor:fA<=fB?"default":"pointer",opacity:fA<=fB?0.4:1}}>
                ← {m.teamA?.name}
              </button>
              <button onMouseDown={e=>{e.preventDefault();onSetWinCT(ri,mi,side,"B",fA,fB);if(isFootballEv&&(sc.scorersA?.length||sc.scorersB?.length))onSetCTScorers(ri,mi,side,sc.scorersA||[],sc.scorersB||[]);}}
                disabled={fB<=fA}
                style={{flex:1,padding:"8px 0",borderRadius:8,border:`0.5px solid ${fB>fA?"#06B6D444":"var(--po-bdr)"}`,background:fB>fA?"#06B6D422":"transparent",color:fB>fA?"#67E8F9":"var(--po-dim)",fontSize:12,fontWeight:600,cursor:fB<=fA?"default":"pointer",opacity:fB<=fA?0.4:1}}>
                {m.teamB?.name} →
              </button>
            </div>
          </>;
        })()}
      </>:<div style={{textAlign:"center",fontSize:11,color:"var(--po-dim)",marginTop:6}}>⏳ Waiting for result</div>}
    </Card>;
  }

  // Rounds displayed newest first
  const reversedRounds=[...plan.rounds].reverse();

  return <>
    <div style={{marginBottom:12,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6}}>
      <span style={{fontSize:12,color:"var(--po-dim)"}}>{isLeague?`League Round ${plan.leagueRound}`:"Ladder"} · {tc} {isFootballEv?"pitch"+(tc!==1?"es":""):"courts"}</span>
      <div style={{display:"flex",gap:6}}>{isLeague&&(isFootballEv?<Bdg label={`${plan.teams?.length||0} teams`} color={gcA}/>:<><Bdg label={`A: ${plan.groupA?.length} teams`} color={gcA}/><Bdg label={`B: ${plan.groupB?.length} teams`} color={gcB}/></>)}</div>
    </div>

    {/* Ladder: break row + next match button on top */}
    {!isLeague&&lastRound&&(()=>{
      const onBreak=lastRound.onBreak||[];
      const bPts=ctLadderBreakPts(tc);
      const maxR=plan.maxRounds||99;
      const ladderDone=plan.rounds.length>=maxR;
      return <>
        {selT&&<div style={{fontSize:12,padding:"8px 12px",borderRadius:8,marginBottom:8,background:"#FBBF2411",border:"0.5px solid #FBBF2444",display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{color:"#FBBF24"}}>✋ Team selected — tap another team or break team to swap</span><SmBtn label="✕" onClick={()=>setSelT(null)} color="#EF4444"/></div>}
      {lastRoundDone&&!ladderDone&&isAdmin&&<Btn label={`▶ Generate Next Match (Round ${plan.rounds.length+1} of ${maxR})`} primary onClick={onNextCTLadder} style={{width:"100%",marginBottom:12}}/>}
        {lastRoundDone&&ladderDone&&<div style={{padding:"12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:10,fontSize:13,fontWeight:600,color:"#34D399",textAlign:"center",marginBottom:12}}>🏆 Event Complete — all rounds played! Check Standings.</div>}
        {onBreak.length>0&&<div style={{background:"#F59E0B0D",border:"0.5px solid #F59E0B33",borderRadius:10,padding:"10px 12px",marginBottom:12}}>
          <div style={{fontSize:11,color:"#F59E0B",fontWeight:600,marginBottom:8}}>🪑 On Break — {bPts} pts each{isAdmin&&onSwapCTLadder&&<span style={{fontSize:10,color:"var(--po-dim)",marginLeft:8}}>Tap to select for swap</span>}</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{onBreak.map(t=>{const isSel=selT?.ri===lastRound.roundNum-1&&selT?.tid===t.id;return <div key={t.id} onClick={()=>{if(!isAdmin||!onSwapCTLadder)return;if(selT&&selT.ri===lastRound.roundNum-1&&selT.tid!==t.id){onSwapCTLadder(lastRound.roundNum-1,selT.tid,t.id);setSelT(null);}else setSelT({ri:lastRound.roundNum-1,tid:t.id});}} style={{padding:"6px 10px",background:isSel?"#FBBF2422":"#F59E0B11",border:`1.5px solid ${isSel?"#FBBF24":"#F59E0B44"}`,borderRadius:8,cursor:isAdmin&&onSwapCTLadder?"pointer":"default"}}>
            <div style={{fontSize:12,color:isSel?"#FBBF24":"#F59E0B",fontWeight:600}}>{t.name} ({teamRatingLabel(t.avgUsr)})</div>
            <div style={{fontSize:10,color:"var(--po-sub)"}}>{t.players?.map(p=>p.nickname).join(" & ")}</div>
          </div>;})}</div>
        </div>}
      </>;
    })()}

    {/* League: promo button on top (football: no groups, so just a plain next round, no promo/relegation) */}
    {isLeague&&lastRoundDone&&plan.leagueRound<(plan.maxRounds||99)&&<>
      {!isFootballEv&&plan.lastPromo&&<div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8,padding:"8px 12px",background:"var(--po-card)",borderRadius:8}}>
        Last: <span style={{color:"#34D399"}}>{plan.lastPromo.promoted?.map?.(t=>t?.name).join(", ")||plan.lastPromo.promoted?.name}</span> promoted · <span style={{color:"#F59E0B"}}>{plan.lastPromo.relegated?.filter(Boolean).map(t=>t?.name).join(", ")}</span> relegated
      </div>}
      {isAdmin&&(isFootballEv
        ? <Btn label="▶ Generate Next Round" primary onClick={onNextFootballRound} style={{width:"100%",marginBottom:12}}/>
        : <Btn label="🔀 Apply Promotion/Relegation & Start Next Round" primary onClick={onApplyPromo} style={{width:"100%",marginBottom:12}}/>)}
    </>}
    {isLeague&&lastRoundDone&&plan.leagueRound>=(plan.maxRounds||99)&&<div style={{padding:"12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:10,fontSize:13,fontWeight:600,color:"#34D399",textAlign:"center",marginBottom:12}}>🏆 Event Complete — all rounds played! Check Standings.</div>}
    {isLeague&&lastRoundDone&&plan.leagueRound>=(plan.maxRounds||99)&&<div style={{padding:"6px 10px",background:"#6366F111",borderRadius:6,fontSize:11,color:"#6366F1",marginBottom:8}}>Final standings: all teams merged by total points</div>}

    {/* Rounds — newest first */}
    {reversedRounds.map((round,revIdx)=>{
      const ri=plan.rounds.length-1-revIdx;
      const isLatest=revIdx===0;
      const isRoundComplete=[...round.matchesA,...(round.matchesB||[])].every(m=>m.winner);
      const manuallySet=collapsedRounds.has(ri);
      const toggle=()=>setCollapsedRounds(s=>{const n=new Set(s);n.has(ri)?n.delete(ri):n.add(ri);return n;});
      // Default: completed + not latest → collapsed. A manual toggle flips that specific round's state.
      const defaultCollapsed = isRoundComplete && !isLatest;
      const effCollapsed = manuallySet ? !defaultCollapsed : defaultCollapsed;
      return <div key={ri} style={{marginBottom:20,opacity:isLatest?1:0.7}}>
        <div onClick={isRoundComplete?toggle:undefined} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,cursor:isRoundComplete?"pointer":"default"}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            {isRoundComplete&&<span style={{fontSize:11,color:"var(--po-dim)",transform:effCollapsed?"rotate(-90deg)":"none",display:"inline-block",transition:"transform 0.15s"}}>▾</span>}
            <span style={{fontSize:14,fontWeight:700,color:isLatest?"var(--po-text)":"var(--po-dim)"}}>
              {isLeague?`League Round ${round.roundNum}`:`Match Round ${round.roundNum}`}
            </span>
          </div>
          {isRoundComplete&&<Bdg label="✓ Complete" color="#34D399"/>}
        </div>
        {effCollapsed?null:<>
        {isLatest&&isAdmin&&<MatchTimerWidget plan={plan} roundDuration={plan.matchDuration||plan.roundDuration} totalRounds={Math.max(1,Math.round(totalBookingMin/(plan.matchDuration||plan.roundDuration||20)))} totalBookingMin={totalBookingMin} eventDate={eventDate} eventTime={eventTime} eventId={eventId} unitLabel="Match" sim={sim} onStart={onSetMatchModeStart} onStop={onStopMatchMode}/>}
        {isLeague
          ?<>{[...round.matchesA].sort((a,b)=>a.court-b.court||(a.winner?1:0)-(b.winner?1:0)).map((m,mi)=><MatchCard key={`A${m.court}-${mi}`} m={m} ri={ri} mi={round.matchesA.indexOf(m)} side="A"/>)}{[...(round.matchesB||[])].sort((a,b)=>a.court-b.court||(a.winner?1:0)-(b.winner?1:0)).map((m,mi)=><MatchCard key={`B${m.court}-${mi}`} m={m} ri={ri} mi={round.matchesB.indexOf(m)} side="B"/>)}</>
          :<>{round.matchesA.map((m,mi)=><MatchCard key={`A${mi}`} m={m} ri={ri} mi={mi} side="A"/>)}</>
        }
        </>}
      </div>;
    })}
  </>;
}

// Minutes remaining for rounds 2..N after Round 1 keeps its full duration and the
// admin-declared delay is absorbed — split evenly so the last round still finishes
// on the booking's end time. Falls back to (rounds × duration) when no end time is set,
// which still compresses proportionally to the delay.
function computeRoundEndOffsets(totalRounds, roundDuration, totalBookingMin, delayMin){
  const offsets = {};
  const bookingMin = totalBookingMin || (totalRounds*roundDuration);
  // Round 1 is no longer treated as fixed-length — the whole remaining window (after
  // the delay is subtracted) is split evenly across every round, round 1 included, so a
  // late start compresses ALL rounds proportionally instead of only rounds 2+.
  const remainingMin = Math.max(totalRounds, bookingMin - delayMin); // never compress below 1 min/round total
  const evenDur = remainingMin/totalRounds;
  for (let n=1; n<=totalRounds; n++) offsets[n] = n*evenDur;
  return offsets;
}

// For the Events list: is this event's Match Mode currently mid-round right now? Mirrors
// MatchTimerWidget's own slot math exactly, just read from outside that component. Safe to
// assume at most one event can ever be live at a time — setMatchModeStart enforces that
// app-wide — so this never has to disambiguate between two "current" events.
function getLiveMatchInfo(ev, now){
  const plan = ev.plan;
  if (!plan || !plan.matchModeStartAt || ev.status==="completed" || ev.status==="cancelled") return null;
  const rd = plan.matchDuration || plan.roundDuration || 20;
  // ev.timeTo can be earlier-in-the-day than ev.time when the booking crosses midnight
  // (e.g. 11:00 PM -> 12:00 AM) — both get built from the same ev.date string, so timeTo
  // lands "before" time and the subtraction goes deeply negative. Roll it to the next
  // calendar day whenever that happens.
  let totalBookingMin = rd;
  if (ev.time && ev.timeTo) {
    const startMs = new Date(`${ev.date}T${ev.time}`).getTime();
    let endMs = new Date(`${ev.date}T${ev.timeTo}`).getTime();
    if (endMs <= startMs) endMs += 24*60*60*1000;
    totalBookingMin = (endMs-startMs)/60000;
  }
  // Deliberately NOT plan.maxRounds/totalRounds — for CT League those count "League Round"
  // batches (a batch can hold several matches), a different number entirely from the
  // per-match timer slot this countdown needs. The real native-sync effect (source of
  // truth for the actual widget/whistle) always derives this fresh the same way, for every
  // format, so mirroring it exactly here is what keeps the two from ever disagreeing.
  const tr = Math.max(1, Math.round(totalBookingMin/rd));
  const delayMin = plan.matchModeDelayMin ?? 0;
  const offsets = computeRoundEndOffsets(tr, rd, totalBookingMin, delayMin);
  const startMs = new Date(plan.matchModeStartAt).getTime();
  const elapsedMin = (now-startMs)/60000;
  let slotRaw = 1;
  while (offsets[slotRaw]!==undefined && offsets[slotRaw]<=elapsedMin) slotRaw++;
  if (slotRaw>tr) return null; // whole event's time window has elapsed
  const slot = Math.min(slotRaw, tr);
  const roundEndAt = startMs + (offsets[slot]||slot*rd)*60000;
  return {slot, tr, roundEndAt};
}

// ══════════════════════════════════════════════════════
//  MATCH MODE — countdown widget shown atop the active round
// ══════════════════════════════════════════════════════
function MatchTimerWidget({plan,roundDuration,totalRounds,totalBookingMin,eventDate,eventTime,eventId,unitLabel,sim,onStart,onStop,isCompleted}){
  const [now,setNow]         = useState(Date.now());
  const [startInput,setStartInput] = useState(()=>{ const n=new Date(); return `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`; });
  const [flash,setFlash]     = useState(false);
  const prevSlotRef = React.useRef(null);
  const rd = roundDuration || 20; // defensive fallback — legacy/seed plans may predate this field
  const tr = totalRounds || 1;
  const started = !!plan.matchModeStartAt;
  const delayMin = plan.matchModeDelayMin ?? 0;
  const offsets = started ? computeRoundEndOffsets(tr, rd, totalBookingMin, delayMin) : null;
  // Real usage only: can't start Match Mode before the event's actual scheduled moment
  // arrives — Practice Session has no such restriction, since it's meant to work "as if now".
  const eventStartMs = eventDate&&eventTime ? new Date(`${eventDate}T${eventTime}`).getTime() : null;
  const tooEarly = !sim && !started && eventStartMs && now<eventStartMs;

  // The clock is completely independent — it always shows "what slot should we be
  // on right now" based on real elapsed time, whether or not that round has actually
  // been generated / has results in yet. It never pauses and never waits.
  let slotRaw = 1;
  if (started && offsets) {
    const elapsedMin = (now-new Date(plan.matchModeStartAt).getTime())/60000;
    while (offsets[slotRaw]!==undefined && offsets[slotRaw]<=elapsedMin) slotRaw++;
  }
  const eventOver = started && slotRaw>tr;
  const slot = Math.min(slotRaw, tr);
  const endAt = started ? new Date(plan.matchModeStartAt).getTime() + (offsets[slot]||slot*rd)*60000 : null;
  const remaining = started ? Math.max(0, Math.round((endAt-now)/1000)) : null;
  const restDur = started && offsets ? (offsets[2]!==undefined ? offsets[2]-offsets[1] : rd) : rd;
  const isCompressed = started && Math.round(restDur)<rd;
  if (prevSlotRef.current === null) prevSlotRef.current = slotRaw; // seed on mount — no whistle for "just arrived mid-round"

  const [firedRounds,setFiredRounds] = useState([]);

  // Polls the native durable "did this round's alarm actually ring" record — this works
  // even if the app was fully closed at the moment some of them fired. Also listens live
  // for instant updates when the app happens to be open when one rings.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !started || !eventId) return;
    let sub, stopped = false;
    const poll = () => MatchMode.getFiredWhistles({eventId:String(eventId)}).then(r=>{ if(!stopped) setFiredRounds(r?.rounds||[]); }).catch(()=>{});
    poll();
    const iv = setInterval(poll, 5000);
    MatchMode.addListener("whistleFired", ()=>poll()).then(h=>sub=h);
    return () => { stopped=true; clearInterval(iv); sub?.remove(); };
  }, [started, eventId]);

  useEffect(() => {
    const iv = setInterval(()=>setNow(Date.now()), 1000); // ticks off the device's real clock, always
    return () => clearInterval(iv);
  }, []);

  // Fires the alarm and flashes red the instant a slot's time is up, then moves
  // straight on to counting down the next slot — automatically, every time, in both
  // real use and Practice Session. Actually generating the next match's data stays a
  // separate manual step (results + the existing "Next Round" button) exactly as today.
  useEffect(() => {
    if (slotRaw>prevSlotRef.current) {
      prevSlotRef.current = slotRaw;
      setFlash(true);
      const t = setTimeout(()=>setFlash(false), 2500);
      return () => clearTimeout(t);
    }
  }, [slotRaw]);

  if (!started) {
    if (isCompleted) return null; // event finished, Match Mode was never used — nothing to show
    if (tooEarly) {
      const evClock = new Date(eventStartMs).toLocaleString([], {day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
      return <Card style={{marginBottom:10,background:"#33415511",border:"0.5px solid var(--po-bdr)"}}>
        <div style={{fontSize:12,fontWeight:600,color:"var(--po-dim)",marginBottom:6}}>⏱ Match Mode</div>
        <div style={{fontSize:11,color:"var(--po-dim)"}}>Can't start yet — the event is scheduled for {evClock}. This unlocks automatically once that time arrives.</div>
      </Card>;
    }
    return <Card style={{marginBottom:10,background:"#6366F111",border:"0.5px solid #6366F144"}}>
      <div style={{fontSize:12,fontWeight:600,color:"#A5B4FC",marginBottom:8}}>⏱ Match Mode</div>
      <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8}}>What time did Round 1 actually start?</div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <input type="time" value={startInput} onChange={e=>setStartInput(e.target.value)} className="po-inp"
          style={{flex:1,background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}/>
        <Btn label="Start ▶" primary onClick={()=>{
          const startAt = new Date(`${eventDate}T${startInput}`).toISOString();
          const delayMin = minutesBetween(eventTime,startInput);
          const offsets = computeRoundEndOffsets(tr, rd, totalBookingMin, delayMin);
          const roundEndTimes = Object.entries(offsets).map(([round,off])=>({round:+round, endsAt:new Date(new Date(startAt).getTime()+off*60000).toISOString()}));
          onStart(startAt, delayMin, roundEndTimes);
        }}/>
      </div>
    </Card>;
  }

  // Historical reference list of every round's whistle time — shown whenever Match Mode
  // was actually used for this event, regardless of whether it's still live, the booking
  // window is over, or the event itself is already closed. Also shown on the web version
  // (informational only — web can't schedule the native alarm, but the times themselves
  // are still useful to see, and any ✓ recorded natively will still show once synced).
  const scheduleList = eventId&&offsets ? <Card style={{marginBottom:10}}>
    <div style={{fontSize:11,fontWeight:600,color:"var(--po-dim)",marginBottom:8}}>🔔 Native whistle schedule</div>
    {Array.from({length:tr},(_,i)=>i+1).map(r=>{
      const rEndsAt = new Date(plan.matchModeStartAt).getTime() + (offsets[r]||r*rd)*60000;
      const rClock = new Date(rEndsAt).toLocaleTimeString([], {hour:"numeric",minute:"2-digit",hour12:true});
      const isFired = firedRounds.includes(r);
      return <div key={r} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0",borderTop:r>1?"0.5px solid var(--po-bdr)":"none"}}>
        <span style={{fontSize:12,color:"var(--po-text)"}}>{unitLabel||"Round"} {r} — {rClock}</span>
        <span style={{fontSize:13,color:isFired?"#34D399":"var(--po-dim)",fontWeight:700}}>{isFired?"✓":"⏳"}</span>
      </div>;
    })}
  </Card> : null;

  if (isCompleted || eventOver) {
    return <>
      <Card style={{marginBottom:10,background:"#EF444422",border:"0.5px solid #EF444466"}}>
        <div style={{fontSize:11,color:"#EF4444",fontWeight:600}}>🏁 {isCompleted?"Event completed":"Booking time is up"}</div>
        <div style={{fontSize:12,color:"var(--po-dim)",marginTop:4}}>All {tr} scheduled rounds have run their course.</div>
      </Card>
      {scheduleList}
    </>;
  }

  const mm = String(Math.floor(remaining/60)).padStart(2,"0");
  const ss = String(remaining%60).padStart(2,"0");
  const endClock = endAt ? new Date(endAt).toLocaleTimeString([], {hour:"numeric",minute:"2-digit",hour12:true}) : null;
  return <>
  <Card style={{marginBottom:10,background:flash?"#EF444422":"#6366F111",border:`0.5px solid ${flash?"#EF444466":"#6366F144"}`}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div>
        <div style={{fontSize:11,color:flash?"#EF4444":"#A5B4FC",fontWeight:600}}>{flash?"⏰ Time's up!":endClock?`⏱ ${unitLabel||"Round"} ${slot} ends at ${endClock}`:`⏱ ${unitLabel||"Round"} ${slot} ends in`}</div>
        <div style={{fontSize:26,fontWeight:800,color:flash?"#EF4444":"var(--po-text)",fontVariantNumeric:"tabular-nums"}}>{mm}:{ss}</div>
        {isCompressed&&<div style={{fontSize:10,color:"#F59E0B",marginTop:4}}>⚠️ Compressed to ~{Math.round(restDur)}min to catch up from the {delayMin}min delay</div>}
      </div>
      <div style={{display:"flex",gap:6}}>
        {flash&&<SmBtn label="🔔 Replay" onClick={playWhistle} color="#EF4444"/>}
        {onStop&&<SmBtn label="🛑 Stop" onClick={()=>{if(window.confirm("Stop Match Mode? This ends the live timer/notification for this event."))onStop();}} color="#EF4444"/>}
      </div>
    </div>
  </Card>
  {scheduleList}
  </>;
}

// ══════════════════════════════════════════════════════
//  EVENT DETAIL
// ══════════════════════════════════════════════════════
function EvDetail({ev,comm,comms,users,venues,me,uidLinks,onBack,onOpenCommunity,onEditEvent,onRegister,onCheckIn,onAddMember,onAddGuest,onVote,onResolveType,onCloseEvent,onStartCI,onSetWinCI,onNextRound,onSwap,onRebalanceCourt,onEditBreak,onRegenerateBreaks,onStartCT,onSetWinCT,onSetCTScorers,onToggleCTLeagueLive,onApplyPromo,onNextFootballRound,onNextCTLadder,onSwapCTLadder,onRemoveFromEvent,onAddEventPhoto,onRemoveEventPhoto,onEditGuestUsr,onEditEventUsr,onSetBreakPrefOverride,onToast,onDuplicate,onDelete,onArchive,onUnarchive,onViewProfile,onSwapCTBreak,onToggleCTBreakFirm,onSetTeamBreakPref,onRegenCTBreaks,onToggleExempt,onTogglePaid,onUpdateEventFinance,onSetMatchModeStart,onStopMatchMode,onMarkWhistlesScheduled,onSwapCTTeamPlayers,onRenameTeam,onCreateInvite,onRequestEventJoin,onApproveEventJoin,onRejectEventJoin,onSetFootballSkill,onRetirePlayer,onToggleEventAdmin,onAddLedgerEntry,expenseCategories,onPostEventAnnouncement,onDeleteEventAnnouncement,onReplyEventAnnouncement,onDeleteEventAnnouncementReply,initialTab,onTabChange,godMode,subscriptionSettings}){
  const [tab,setTab]       = useState(initialTab||"players");
  useEffect(()=>{ onTabChange&&onTabChange(tab); }, [tab]);
  const [sim,setSim]       = useState(false);
  const [showLedgerForm,setShowLedgerForm] = useState(false);
  const [ledgerType,setLedgerType] = useState("expense");
  const [ledgerDesc,setLedgerDesc] = useState("");
  const [ledgerAmount,setLedgerAmount] = useState("");
  const [ledgerCategory,setLedgerCategory] = useState("");
  const [eventAnnouncementText,setEventAnnouncementText] = useState("");
  const [eventReplyingTo,setEventReplyingTo] = useState(null); // announcement id whose reply box is open
  const [eventReplyText,setEventReplyText] = useState("");
  const suggestedRoundDur = ev.rotationMin||20;
  const eventBookingMins = (()=>{
    if(!ev.time||!ev.timeTo) return 120;
    const [h1,m1]=ev.time.split(":").map(Number);
    const [h2,m2]=(ev.timeTo||"").split(":").map(Number);
    if(isNaN(h2)) return 120;
    let mins=(h2*60+m2)-(h1*60+m1); if(mins<=0) mins+=24*60;
    return mins;
  })();
  const [roundDur,setRDur] = useState(suggestedRoundDur);
  // Total rounds is fully derived from the event's real booking window ÷ round duration —
  // no manual round-count picker; changing the duration recomputes this automatically.
  const totalR = Math.max(1, Math.round(eventBookingMins/(roundDur||20)));
  const [showAddM,setSAM]  = useState(false);
  const [addMemberSearch,setAddMemberSearch] = useState("");
  const [inviteUrl,setInviteUrl] = useState(null);
  const [showHeaderMenu,setShowHeaderMenu] = useState(false);
  const [openPlayerMenu,setOpenPlayerMenu] = useState(null); // userId whose Players-tab action menu is open
  const [photoUploading2,setPhotoUploading2] = useState(false);
  const [photoUploadProgress,setPhotoUploadProgress] = useState(null); // {done,total} while a multi-select batch is in flight
  const [photoUploadError,setPhotoUploadError] = useState("");
  const handleEventPhotoSelect = async (e) => {
    const files = Array.from(e.target.files||[]); if (!files.length) return;
    setPhotoUploading2(true); setPhotoUploadError(""); setPhotoUploadProgress({done:0,total:files.length});
    let failCount = 0;
    for (let i=0;i<files.length;i++) {
      try { const photo = await uploadEventPhoto(ev.id, files[i]); onAddEventPhoto(photo); }
      catch(err) {
        console.log("Event photo upload failed", err);
        failCount++;
        setPhotoUploadError(`${err.code||"error"}: ${err.message||err}`);
      }
      setPhotoUploadProgress({done:i+1,total:files.length});
    }
    if (failCount>0) onToast&&onToast(files.length>1?`${files.length-failCount}/${files.length} photos uploaded — ${failCount} failed`:"Upload failed — see details below","err");
    setPhotoUploadProgress(null);
    setPhotoUploading2(false);
    e.target.value = "";
  };
  const [collapsedRounds,setCollapsedRounds] = useState(new Set()); // manually toggled CI rounds (overrides the completed-round default)
  const [showAddG,setSAG]  = useState(false);
  const [gf,setGf]         = useState({n:"",name:"",p:"",usr:"50"});
  const [sel,setSel]       = useState(null);
  // In-progress CI score entry, keyed by "ri_mi" — mirrors CTMatchesTab's scores state.
  const [ciScores,setCiScores] = useState({});
  const getCiS=(ri,mi)=>ciScores[`${ri}_${mi}`]||{scoreA:0,scoreB:0};
  const setCiS=(ri,mi,field,val)=>setCiScores(s=>({...s,[`${ri}_${mi}`]:{...getCiS(ri,mi),[field]:val}}));
  const [ctSel,setCtSel]   = useState(null); // {teamId,userId} — for tap-a-player-to-swap between teams
  const [showResultsTable,setShowResultsTable] = useState(false);
  const [standingsView,setStandingsView] = useState("pes"); // "pes" | "delta" | "output" — Platform-Admin-only toggle, everyone else always sees "pes"
  const [ctC,setCtC]       = useState(null);
  const [ctTopPoolSize,setCtTopPoolSize] = useState(null); // null = auto (top-ranked players → the auto-computed bigger pool)
  const [ctF,setCtF]       = useState("league");
  const [ctDur,setCtDur]   = useState(ev.rotationMin||20);
  const [simSnapshot,setSimSnapshot] = useState(null); // deep clone of `ev` taken when sim starts; discarded on exit
  const [simEv,setSimEv]   = useState(null);           // local working copy mutated only while sim is active

  // While sim is active, ALL reads/writes happen against simEv (a local, throwaway copy).
  // The real `ev` prop (and therefore global app state) is never touched during a sim session.
  const effEv = sim && simEv ? simEv : ev;
  const startSim = () => {
    const snap = JSON.parse(JSON.stringify(ev));
    setSimSnapshot(snap);
    const working = JSON.parse(JSON.stringify(ev));
    if (working.status === "completed") {
      // Completed events are normally locked — reset the practice copy so it can be replayed from scratch.
      working.status = "registration_open";
      working.plan = null;
      working.checkedIn = [...working.registrations.map(r=>r.userId)];
    }
    setSimEv(working);
    setSim(true);
    setTab(isCI?"rounds":isCT?"teams":"players");
  };
  const exitSim = () => {
    setSim(false);
    setSimEv(null);
    setSimSnapshot(null);
    onToast&&onToast("Simulation ended — no changes were saved");
  };

  // ── Sim-aware action dispatcher ──────────────────────
  // When sim is active, mutate the local simEv copy using the same logic as the
  // real handlers in the parent component. When sim is inactive, just call through
  // to the real handlers (which write to global app state as normal).
  const simMutate = (fn) => setSimEv(prev => fn(prev));

  const act = {
    checkIn: (uid) => sim
      ? simMutate(e => e.checkedIn.includes(uid) ? e : {...e, checkedIn:[...e.checkedIn, uid]})
      : onCheckIn(uid),
    register: () => sim
      ? simMutate(e => e.registrations.find(r=>r.userId===me.id) ? e : {...e, registrations:[...e.registrations,{userId:me.id,registeredAt:new Date().toISOString(),status:"registered",addedBy:null,isGuest:false}]})
      : onRegister(),
    requestEventJoin: () => onRequestEventJoin&&onRequestEventJoin(),
    approveEventJoin: uid => onApproveEventJoin&&onApproveEventJoin(uid),
    rejectEventJoin: uid => onRejectEventJoin&&onRejectEventJoin(uid),
    addMember: (uid) => sim
      ? simMutate(e => e.registrations.find(r=>r.userId===uid) ? e : {...e, registrations:[...e.registrations,{userId:uid,registeredAt:new Date().toISOString(),status:"registered",addedBy:"admin",isGuest:false}]})
      : onAddMember(uid),
    addGuest: (g) => sim
      ? onToast&&onToast("Adding new guests isn't supported in Simulation Mode — use an existing player.","err")
      : onAddGuest(g),
    removeFromEvent: (uid) => sim
      ? simMutate(e => ({...e, registrations:e.registrations.filter(r=>r.userId!==uid), checkedIn:e.checkedIn.filter(id=>id!==uid)}))
      : onRemoveFromEvent(uid),
    editGuestUsr: (uid,usr) => sim ? null /* not applicable in sim */ : onEditGuestUsr(uid,usr),
    setFootballSkill: (uid,skill) => sim ? null /* not applicable in sim */ : onSetFootballSkill(uid,skill),
    retirePlayer: (uid) => sim ? null /* not applicable in sim */ : onRetirePlayer(uid),
    toggleEventAdmin: (uid) => sim ? null /* not applicable in sim */ : onToggleEventAdmin(uid),
    editEventUsr: (uid,usr) => sim
      ? simMutate(e => ({...e, registrations:e.registrations.map(r=>r.userId!==uid?r:{...r,eventUsr:usr===""?null:parseInt(usr)||0})}))
      : onEditEventUsr(uid,usr),
    setBreakPrefOverride: (uid,pref) => sim
      ? simMutate(e => ({...e, registrations:e.registrations.map(r=>r.userId!==uid?r:{...r,breakPrefOverride:pref})}))
      : onSetBreakPrefOverride(uid,pref),
    startCI: (n,dur) => sim
      ? simMutate(e => {
          const players = e.registrations.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return{...u,usr:r.eventUsr??u.usr,userId:r.userId,histBreaks:0,breakPref:r.breakPrefOverride||u.breakPref||"none"};}).filter(Boolean);
          return {...e, plan:{...genRound1(players, e.courts, n), roundDuration:dur}};
        })
      : onStartCI(n,dur),
    setWinCI: (ri,mi,w,sA,sB) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const scoreA = w ? (sA ?? (w==="A"?1:0)) : 0;
          const scoreB = w ? (sB ?? (w==="B"?1:0)) : 0;
          const rounds = e.plan.rounds.map((r,rr)=>rr!==ri?r:{...r,matches:r.matches.map((m,mm)=>mm!==mi?m:{...m,winner:w,scoreA,scoreB})});
          return {...e, plan:{...e.plan, rounds}};
        })
      : onSetWinCI(ri,mi,w,sA,sB),
    nextRound: () => sim
      ? simMutate(e => e.plan ? {...e, plan: genNextRoundCI(e.plan,e.retiredIds||[])} : e)
      : onNextRound(),
    swap: (ri,a,b) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const rounds = JSON.parse(JSON.stringify(e.plan.rounds));
          const r = rounds[ri];
          function loc(uid){for(let mi=0;mi<r.matches.length;mi++)for(const t of["teamA","teamB"]){const pi=r.matches[mi][t].findIndex(p=>p.userId===uid);if(pi!==-1)return{w:"court",mi,t,pi};}const bi=r.onBreak.findIndex(p=>p.userId===uid);if(bi!==-1)return{w:"break",bi};return null;}
          const locA=loc(a), locB=loc(b);
          if(!locA||!locB) return e;
          const getP=(l)=>l.w==="court"?r.matches[l.mi][l.t][l.pi]:r.onBreak[l.bi];
          const pA=getP(locA), pB=getP(locB);
          if(locA.w==="court") r.matches[locA.mi][locA.t][locA.pi]=pB; else r.onBreak[locA.bi]=pB;
          if(locB.w==="court") r.matches[locB.mi][locB.t][locB.pi]=pA; else r.onBreak[locB.bi]=pA;
          return {...e, plan:{...e.plan, rounds}};
        })
      : onSwap(ri,a,b),
    rebalanceCourt: (ri,mi) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const rounds=e.plan.rounds.map((r,rr)=>{
            if(rr!==ri)return r;
            return {...r,matches:r.matches.map((m,mm)=>{
              if(mm!==mi||m.winner)return m;
              const four=[...m.teamA,...m.teamB].sort((a,b)=>b.usr-a.usr);
              const pair=snakePairCI(four);
              return {...m,teamA:pair.teamA,teamB:pair.teamB};
            })};
          });
          return {...e, plan:{...e.plan, rounds}};
        })
      : onRebalanceCourt(ri,mi),
    editBreak: (ri,uid,v) => sim ? null /* break editing not mirrored in sim — exit sim to make this change for real */ : onEditBreak(ri,uid,v),
    regenerateBreaks: () => sim ? null : onRegenerateBreaks(),
    swapCTBreak: (ri,tA,tB) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const breakPlan = e.plan.breakPlan.map((round,i)=>{
            if(i!==ri) return round;
            const hasA=round.includes(tA), hasB=round.includes(tB);
            let next=[...round];
            if(hasA&&!hasB){next=next.filter(id=>id!==tA);next.push(tB);}
            else if(hasB&&!hasA){next=next.filter(id=>id!==tB);next.push(tA);}
            return next;
          });
          return {...e, plan:{...e.plan, breakPlan}};
        })
      : onSwapCTBreak&&onSwapCTBreak(ri,tA,tB),
    toggleCTBreakFirm: (ri,tid) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const firmBreaks = e.plan.firmBreaks||{};
          const isFirm = (firmBreaks[ri]||[]).includes(tid);
          const newList = isFirm ? (firmBreaks[ri]||[]).filter(id=>id!==tid) : [...(firmBreaks[ri]||[]), tid];
          return {...e, plan:{...e.plan, firmBreaks:{...firmBreaks,[ri]:newList}}};
        })
      : onToggleCTBreakFirm&&onToggleCTBreakFirm(ri,tid),
    setTeamBreakPref: (tid,pref) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const bump=t=>t.id===tid?{...t,breakPref:pref}:t;
          return {...e, plan:{...e.plan, teams:(e.plan.teams||[]).map(bump), sorted:(e.plan.sorted||[]).map(bump), groupA:(e.plan.groupA||[]).map(bump), groupB:(e.plan.groupB||[]).map(bump)}};
        })
      : onSetTeamBreakPref&&onSetTeamBreakPref(tid,pref),
    regenCTBreaks: () => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const plan=e.plan;
          const generatedRounds=plan.rounds.length;
          const teams=plan.sorted||plan.teams;
          const tc=plan.courts;
          const total=plan.maxRounds||plan.breakPlan.length;
          const newBreakPlan=[...plan.breakPlan];
          for(let i=0;i<generatedRounds;i++){
            const r=plan.rounds[i];
            if(r.onBreak&&r.onBreak.length>0) newBreakPlan[i]=(r.onBreakIds||r.onBreak.map(t=>t.id||t.teamId));
          }
          const fresh=buildCTBreakPlan(teams,tc,total,newBreakPlan.slice(0,generatedRounds),plan.firmBreaks||{});
          for(let i=generatedRounds;i<total;i++) newBreakPlan[i]=fresh[i];
          return {...e, plan:{...plan, breakPlan:newBreakPlan}};
        })
      : onRegenCTBreaks&&onRegenCTBreaks(),
    swapCTTeamPlayers: (teamIdA,userIdA,teamIdB,userIdB) => onSwapCTTeamPlayers&&onSwapCTTeamPlayers(teamIdA,userIdA,teamIdB,userIdB),
    renameCTTeam: (tid,newName) => onRenameTeam&&onRenameTeam(tid,newName),
    startCT: (c,f,dur,topPoolSizeOverride) => sim
      ? simMutate(e => {
          const players = e.registrations.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return{...u,usr:teamFormationRating(u,e),userId:r.userId};}).filter(Boolean);
          return {...e, plan: generateCTPlan(players, c, f, e, dur, topPoolSizeOverride)};
        })
      : onStartCT(c,f,dur,topPoolSizeOverride),
    setWinCT: (ri,mi,side,w,sA,sB) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const rounds=e.plan.rounds.map((r,rr)=>{
            if(rr!==ri) return r;
            const up=arr=>arr.map((m,mm)=>mm!==mi?m:{...m,winner:w,scoreA:sA,scoreB:sB,live:w?false:m.live});
            return {...r, matchesA:side==="A"?up(r.matchesA):r.matchesA, matchesB:side==="B"?up(r.matchesB):r.matchesB};
          });
          return {...e, plan:{...e.plan, rounds}};
        })
      : onSetWinCT(ri,mi,side,w,sA,sB),
    setCTScorers: (ri,mi,side,scorersA,scorersB) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const rounds=e.plan.rounds.map((r,rr)=>{
            if(rr!==ri) return r;
            const up=arr=>arr.map((m,mm)=>mm!==mi?m:{...m,scorersA,scorersB});
            return {...r, matchesA:side==="A"?up(r.matchesA):r.matchesA, matchesB:side==="B"?up(r.matchesB):r.matchesB};
          });
          return {...e, plan:{...e.plan, rounds}};
        })
      : onSetCTScorers(ri,mi,side,scorersA,scorersB),
    toggleCTLeagueLive: (ri,mi,side) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const rounds=e.plan.rounds.map((r,rr)=>{
            if(rr!==ri) return r;
            const up=arr=>arr.map((m,mm)=>mm!==mi?m:{...m,live:!m.live});
            return {...r, matchesA:side==="A"?up(r.matchesA):r.matchesA, matchesB:side==="B"?up(r.matchesB):r.matchesB};
          });
          return {...e, plan:{...e.plan, rounds}};
        })
      : onToggleCTLeagueLive(ri,mi,side),
    applyPromo: () => sim
      ? simMutate(e => e.plan ? {...e, plan: applyPromoRelegation(e.plan,e.retiredIds||[])} : e)
      : onApplyPromo(),
    nextFootballRound: () => sim
      ? simMutate(e => e.plan ? {...e, plan: nextFootballLeagueRound(e.plan)} : e)
      : onNextFootballRound(),
    nextCTLadder: () => sim
      ? simMutate(e => e.plan ? {...e, plan: genNextCTLadder(e.plan,e.retiredIds||[])} : e)
      : onNextCTLadder(),
    swapCTLadder: (ri,tidA,tidB) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const rounds=JSON.parse(JSON.stringify(e.plan.rounds));
          const r=rounds[ri];
          function locT(tid){
            for(let mi=0;mi<r.matchesA.length;mi++){
              if(r.matchesA[mi].teamA?.id===tid) return {w:"match",mi,side:"teamA"};
              if(r.matchesA[mi].teamB?.id===tid) return {w:"match",mi,side:"teamB"};
            }
            const bi=r.onBreak.findIndex(t=>t.id===tid);
            if(bi!==-1) return {w:"break",bi};
            return null;
          }
          function getT(l){return l.w==="match"?r.matchesA[l.mi][l.side]:r.onBreak[l.bi];}
          function setT(l,t){if(l.w==="match") r.matchesA[l.mi][l.side]=t; else r.onBreak[l.bi]=t;}
          const lA=locT(tidA), lB=locT(tidB);
          if(!lA||!lB) return e;
          const tA=getT(lA), tB=getT(lB); setT(lA,tB); setT(lB,tA);
          r.onBreakIds=r.onBreak.map(t=>t.id);
          return {...e, plan:{...e.plan, rounds}};
        })
      : onSwapCTLadder(ri,tidA,tidB),
    closeEvent: (scoringMethod) => sim
      ? (onToast&&onToast("Can't close an event while simulating — exit Simulation Mode first.","err"))
      : onCloseEvent(scoringMethod),
    vote: (k) => sim ? null : onVote(k),
    resolveType: (k) => sim ? null : onResolveType(k),
    toggleExempt: (uid) => sim
      ? simMutate(e=>{const ex=new Set(e.exempted||[]);ex.has(uid)?ex.delete(uid):ex.add(uid);return{...e,exempted:[...ex]};})
      : onToggleExempt&&onToggleExempt(uid),
    togglePaid: (uid) => sim
      ? simMutate(e=>{const p=new Set(e.paidIds||[]);p.has(uid)?p.delete(uid):p.add(uid);return{...e,paidIds:[...p]};})
      : onTogglePaid&&onTogglePaid(uid),
    setMatchModeStart: (startAt,delayMin,roundEndTimes) => sim
      ? simMutate(e=>({...e,plan:{...e.plan,matchModeStartAt:startAt,matchModeDelayMin:delayMin}}))
      : onSetMatchModeStart&&onSetMatchModeStart(startAt,delayMin,roundEndTimes),
    updateFinance: (fields) => sim
      ? simMutate(e=>({...e,...fields}))
      : onUpdateEventFinance&&onUpdateEventFinance(fields),
  };

  const venue  = venues.find(v=>v.id===effEv.venueId);
  const myMem  = comm.members.find(m=>m.userId===me.id);
  const isPlatformAdmin = me?.id===1;
  // Real (community-level) admin — only this can grant/revoke event-scoped admin, so an
  // event admin can never promote anyone themselves (no privilege escalation loophole). God
  // Mode folds in here too (not just isAdmin below) so a flagged Platform Admin gets real-admin
  // actions like promoting event admins, not just the read-heavy isAdmin surface.
  const isRealAdmin = myMem?.role==="owner"||myMem?.role==="admin"||(isPlatformAdmin&&godMode);
  const isEventAdmin = (effEv.eventAdmins||[]).includes(me.id);
  // Event-scoped admin (promoted per-event, not community-wide) gets full admin treatment
  // everywhere in THIS screen only — nothing outside EvDetail ever reads eventAdmins.
  const isAdmin= isRealAdmin||isEventAdmin;
  // Delete/Archive are a narrower, more destructive permission than the rest of the admin menu
  // (Edit/Duplicate/Unarchive) — only the event's actual creator, or the platform owner with God
  // Mode on, can do either. A community admin or an event-scoped admin who didn't create this
  // specific event cannot, even though they can see/use the rest of the "⋮" menu.
  const canDeleteOrArchive = ev.createdBy===me.id || (isPlatformAdmin&&godMode);
  const isReg  = myMem?.status==="regular";
  const myReg  = effEv.registrations.find(r=>r.userId===me.id);
  const isCIn  = effEv.checkedIn.includes(me.id);
  const isOpen = effEv.type==="open";
  const isCI   = effEv.type==="closed_ind";
  const isCT   = effEv.type==="closed_teams";
  const isFootballEv = effEv.sport==="Football";
  const tc     = effEv.courts;
  const bp     = breakPts(tc);
  const minReq = tc*4, maxCap=tc*5;
  // Financial model:
  // Total = (courtCost × courts × durationHours) + (extraFee × courts × durationHours) + one flat additional amount
  // Paying = checkedIn - exempted
  const durationHrs = (()=>{
    if(!effEv.time||!effEv.timeTo) return 2;
    const [h1,m1]=effEv.time.split(":").map(Number);
    const [h2,m2]=(effEv.timeTo||"").split(":").map(Number);
    if(isNaN(h2)) return 2;
    // Booking crossing midnight (e.g. 11:00 PM -> 12:00 AM) otherwise goes deeply negative
    // here, collapsing round generation and the real whistle schedule down to the 0.5hr
    // floor (BUGS.md #1) — roll to the next day whenever end lands before start.
    let mins=(h2*60+m2)-(h1*60+m1); if(mins<=0) mins+=24*60;
    return Math.max(0.5, mins/60);
  })();
  const exemptedIds = new Set(effEv.exempted||[]);
  const courtTotal  = (effEv.costPerCourt||0)*tc*durationHrs;
  const extraFeeTotal = (effEv.extraFee||0)*tc*durationHrs;
  const extraExp    = effEv.extraExpenses||0; // one flat additional amount, if any (e.g. extra gear, a shared tip)
  const totC        = Math.round(courtTotal + extraFeeTotal + extraExp);
  const cinCnt      = effEv.checkedIn.length;
  // Open Events split cost by actual check-in; CI/CT have no check-in step,
  // so cost is split across registered (active, non-waitlisted) players instead
  // (attendance is assumed).
  const attendeeIds = isOpen ? effEv.checkedIn : splitRegsByCapacity(effEv,comm).active.map(r=>r.userId);
  const attCnt      = attendeeIds.length;
  const payingCnt   = Math.max(0, attCnt - [...exemptedIds].filter(id=>attendeeIds.includes(id)).length);
  const cpp         = payingCnt>0?(totC/payingCnt).toFixed(0):"—";
  // Settlement — one person (usually the organizer, but changeable) collects from everyone else.
  const paidIds     = new Set(effEv.paidIds||[]);
  const payerId     = effEv.settlementPayerId ?? effEv.createdBy ?? attendeeIds[0] ?? null;
  const paidCnt     = attendeeIds.filter(uid=>!exemptedIds.has(uid)&&uid!==payerId&&paidIds.has(uid)).length;
  const owingCnt    = Math.max(0, payingCnt - (attendeeIds.includes(payerId)&&!exemptedIds.has(payerId)?1:0)); // everyone paying except the collector themself
  const collectedSoFar = payingCnt>0 ? Math.round((totC/payingCnt)*paidCnt) : 0;
  const inRW   = new Date()<new Date(effEv.regularUntil);
  // Casual members can self-register directly (they just land on the waitlist during the
  // window — enforced by splitRegsByCapacity's tier-aware split). Guests (and anyone not yet a
  // community member at all) still need admin approval to even queue up — they get the
  // "Request to Join" flow instead; once approved they follow the exact same waitlist/sweep
  // rule as a self-registering Casual (see isPriorityReg — "approved" is deliberately not
  // priority), just gated behind an admin saying yes first.
  const isGuestTier = !myMem || myMem.status==="guest";
  const canReg = !myReg&&effEv.status==="registration_open"&&!isGuestTier;
  const myWouldWaitlist = !myReg && (()=>{
    const max=getMaxPlayers(effEv); if(!max) return false;
    const simEv={...effEv, registrations:[...effEv.registrations,{userId:me.id,addedBy:null}]};
    return splitRegsByCapacity(simEv,comm).waitlisted.some(r=>r.userId===me.id);
  })();
  const myEventJoinPending = (effEv.joinRequests||[]).some(r=>r.userId===me.id);
  const isDay  = sim||effEv.date===today;
  const plan   = effEv.plan;
  const isCompleted = effEv.status==="completed";

  // First tap selects a player; a second tap on a player from a DIFFERENT team swaps them.
  // Tapping the same player again, or another player on the SAME team, just clears/reselects.
  const handleCTPlayerTap = (teamId, userId) => {
    if (!ctSel) { setCtSel({teamId,userId}); return; }
    if (ctSel.teamId===teamId) { setCtSel(ctSel.userId===userId?null:{teamId,userId}); return; }
    act.swapCTTeamPlayers(ctSel.teamId, ctSel.userId, teamId, userId);
    setCtSel(null);
  };

  // ── Match Mode Persistent Notification (native Android, CI events, admin only) ──
  // Starts the foreground-service notification once Match Mode begins, refreshes it
  // whenever a new round is generated, and tears it down when the event ends. The
  // notification itself calls back into this same generation/result logic — no
  // duplicated match-generation code lives on the native side.
  const mmRoundCountRef = useRef(0);
  const mmEverStartedRef = useRef(false);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !isAdmin || !isCI || sim || !plan) return;
    const started = !!plan.matchModeStartAt;
    if (started) mmEverStartedRef.current = true;
    // Don't treat "!started" as a real stop signal unless we've actually confirmed Match
    // Mode running before in this session. On a cold app open, the very first render can
    // briefly show stale/cached data (before Firestore's real sync lands) with no
    // matchModeStartAt yet — treating that as "stop everything" was cancelling every
    // scheduled whistle on every single app reopen, permanently losing any round whose
    // alarm time fell inside that few-second window. isCompleted is a real, trustworthy
    // signal regardless, since an event doesn't flicker in and out of "completed".
    if (isCompleted || (!started && mmEverStartedRef.current)) { MatchMode.stop().catch(()=>{}); mmRoundCountRef.current = 0; return; }
    if (!started) return;
    const ri = plan.rounds.length - 1;
    const round = plan.rounds[ri];
    if (!round) return;
    const tr = plan.totalRounds || 1;
    const rd = plan.roundDuration || plan.matchDuration || 20;
    const delayMin = plan.matchModeDelayMin ?? 0;
    const offsets = computeRoundEndOffsets(tr, rd, durationHrs*60, delayMin);
    const slot = Math.min(ri+1, tr);
    const whistleAt = new Date(plan.matchModeStartAt).getTime() + (offsets[slot]||slot*rd)*60000;
    const payload = { eventId: effEv.id, roundIndex: ri, roundNumber: round.round, whistleAt: String(whistleAt), isLastRound: (ri+1)>=tr, breakPlayers: mmBreakLabel(round), courts: mmBuildRoundPayload(round, comms||[], effEv.id) };
    if (mmRoundCountRef.current === 0) {
      MatchMode.start(payload).catch(e=>console.log("MatchMode.start failed", e));
    } else {
      console.log("[MatchModeDiag] pushing MatchMode.update, courts=", JSON.stringify(payload.courts));
      MatchMode.update(payload).catch(e=>console.log("MatchMode.update failed", e));
    }
    mmRoundCountRef.current = plan.rounds.length;
    // Schedule every round's whistle upfront, exactly once per real Match Mode start —
    // gated by a Firestore-durable flag (not the ref above, which resets on every app
    // reopen/remount and was causing a full re-schedule — and cancellation of
    // still-pending alarms — every single time the app was closed and reopened). The
    // whistle is purely a function of (start time, round count, round duration); it
    // shouldn't need "a new round was generated" or "results came in" to know when the
    // next one rings, and it shouldn't repeat just because the screen reopened.
    if (plan.mmScheduledFor !== plan.matchModeStartAt) {
      const startMs = new Date(plan.matchModeStartAt).getTime();
      const schedule = [];
      for (let r=1; r<=tr; r++) schedule.push({ round: r, whistleAt: String(startMs + (offsets[r]||r*rd)*60000) });
      MatchMode.scheduleWhistles({ eventId: String(effEv.id), schedule }).catch(e=>console.log("scheduleWhistles failed", e));
      onMarkWhistlesScheduled?.(plan.matchModeStartAt);
    }
  }, [Capacitor.isNativePlatform() && isAdmin && isCI && plan?.matchModeStartAt, plan?.rounds?.length, JSON.stringify(plan?.rounds?.[plan?.rounds?.length-1]?.matches?.map(m=>m.winner)||[]), isCompleted]);

  // ── Match Mode for CT events (native Android, admin only) — schedule + whistle only ──
  // CT's data shape (teams, pre-generated league schedules vs round-by-round ladder) is
  // different enough from CI that court-by-court win-recording/Generate from the
  // notification isn't included here — this covers the schedule list + the actual native
  // alarms, which is what was asked for. The notification shows round number + countdown
  // only, no interactive court buttons (courts: [] means no Generate button either).
  const mmCTStartedRef = useRef(0);
  const mmCTEverStartedRef = useRef(false);
  const [mmCTTick,setMmCTTick] = useState(0);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !isAdmin || !isCT || sim || !plan?.matchModeStartAt) return;
    const iv = setInterval(() => setMmCTTick(t=>t+1), 30000);
    return () => clearInterval(iv);
  }, [Capacitor.isNativePlatform() && isAdmin && isCT && plan?.matchModeStartAt]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !isAdmin || !isCT || sim || !plan) return;
    const started = !!plan.matchModeStartAt;
    if (started) mmCTEverStartedRef.current = true;
    if (isCompleted || (!started && mmCTEverStartedRef.current)) { MatchMode.stop().catch(()=>{}); mmCTStartedRef.current = 0; return; }
    if (!started) return;
    const rd = plan.matchDuration || plan.roundDuration || 20;
    const tr = Math.max(1, Math.round(durationHrs*60/rd));
    const delayMin = plan.matchModeDelayMin ?? 0;
    const offsets = computeRoundEndOffsets(tr, rd, durationHrs*60, delayMin);
    const startMs = new Date(plan.matchModeStartAt).getTime();
    const elapsedMin = (Date.now()-startMs)/60000;
    let slot = 1; while (offsets[slot]!==undefined && offsets[slot]<=elapsedMin) slot++;
    slot = Math.min(slot, tr);
    const whistleAt = startMs + (offsets[slot]||slot*rd)*60000;
    // Ladder is one match per court per round — same shape as CI, so it gets the full
    // interactive widget (courts populated, tap-to-record-winner, Generate button). League
    // can schedule multiple matches per court per round with no single "current match"
    // concept, so its courts come from the display-only "currently live" payload instead
    // (admin-flagged matches only) — interactive:false tells the native side to skip
    // wiring tap listeners on these rows entirely.
    const isLadder = plan.format==="ladder";
    const lastRound = plan.rounds[plan.rounds.length-1];
    const courts = isLadder ? mmBuildCTLadderPayload(lastRound, comms||[], effEv.id) : mmBuildCTLeaguePayload(lastRound, comms||[], effEv.id);
    const ladderLastRound = isLadder && plan.rounds.length>=(plan.maxRounds||99);
    const breakPlayers = isLadder ? mmCTBreakLabel(lastRound) : "";
    const payload = { eventId: String(effEv.id), roundIndex: slot-1, roundNumber: slot, whistleAt: String(whistleAt), isLastRound: isLadder?ladderLastRound:(slot>=tr), breakPlayers, courts, interactive: isLadder };
    // TEMPORARY diagnostic for "widget doesn't know the round progressed" — remove once found.
    console.log("[MatchModeDiag CT] effect fired — plan.rounds.length="+plan.rounds.length+" slot="+slot+" courts="+courts.length+" winners="+JSON.stringify(courts.map(c=>c.winner))+" action="+(mmCTStartedRef.current===0?"START":"UPDATE"));
    if (mmCTStartedRef.current === 0) MatchMode.start(payload).catch(e=>console.log("MatchMode.start (CT) failed", e));
    else MatchMode.update(payload).catch(e=>console.log("MatchMode.update (CT) failed", e));
    mmCTStartedRef.current = slot;
    if (plan.mmScheduledFor !== plan.matchModeStartAt) {
      const schedule = []; for (let r=1; r<=tr; r++) schedule.push({ round: r, whistleAt: String(startMs + (offsets[r]||r*rd)*60000) });
      MatchMode.scheduleWhistles({ eventId: String(effEv.id), schedule }).catch(e=>console.log("scheduleWhistles (CT) failed", e));
      onMarkWhistlesScheduled?.(plan.matchModeStartAt);
    }
  }, [Capacitor.isNativePlatform() && isAdmin && isCT && plan?.matchModeStartAt, isCompleted, mmCTTick, plan?.rounds?.length, JSON.stringify([...(plan?.rounds?.[plan?.rounds?.length-1]?.matchesA||[]),...(plan?.rounds?.[plan?.rounds?.length-1]?.matchesB||[])].map(m=>m.winner+":"+(m.live?1:0)))]);

  // Safety net: the native foreground service can get killed independently of this
  // component (e.g. app swiped away while locked). When the app comes back to the
  // foreground, force a fresh push of the current round state so the notification
  // (and its Generate Next Round button) reliably reflect reality even if a background
  // tap was missed or the service died in the meantime.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !isAdmin || !isCI || sim) return;
    let sub;
    CapApp.addListener("resume", () => { mmRoundCountRef.current = 0; }).then(h=>sub=h);
    return () => { sub?.remove(); };
  }, [isAdmin, isCI, sim]);

  // Keep refs pointing at the latest plan/callbacks WITHOUT tearing down the native
  // listeners below — this is what actually fixes Generate/winner taps getting lost.
  // Logcat showed the listener-registration effect re-running (remove+re-add) roughly
  // every 3 seconds, because its dependency array included `plan` and the callback props
  // directly — both get a new identity on nearly every render. That left real gaps where
  // NO listener was attached at all; any native tap landing in one of those gaps was
  // silently lost. Refs let the effect below register once and stay registered.
  const planRef = useRef(plan);
  const onSetWinCIRef = useRef(onSetWinCI);
  const onNextRoundRef = useRef(onNextRound);
  const onSetWinCTRef = useRef(onSetWinCT);
  const onNextCTLadderRef = useRef(onNextCTLadder);
  useEffect(() => { planRef.current = plan; onSetWinCIRef.current = onSetWinCI; onNextRoundRef.current = onNextRound; onSetWinCTRef.current = onSetWinCT; onNextCTLadderRef.current = onNextCTLadder; });

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !isAdmin || !isCI || sim) return;
    let winSub, genSub, cancelled = false;
    (async () => {
      const w = await MatchMode.addListener("courtWinner", ({ court, team }) => {
        console.log("[MatchModeDiag] courtWinner event received in JS", court, team);
        const p = planRef.current;
        const ri = p?.rounds?.length ? p.rounds.length - 1 : -1;
        const mi = p?.rounds?.[ri]?.matches?.findIndex(m=>m.court===court);
        console.log("[MatchModeDiag] resolved ri="+ri+" mi="+mi);
        if (ri>=0 && mi>=0) onSetWinCIRef.current(ri, mi, team);
      });
      const g = await MatchMode.addListener("generateNextRound", () => {
        console.log("[MatchModeDiag] generateNextRound event received in JS");
        // A single fixed delay isn't enough when this fires during a cold app resume
        // (the whole app can still be mounting/loading its data at that moment) — so
        // this retries quietly a few times before giving up and showing the warning.
        const attempts = [300, 800, 1500, 2500, 4000, 6000, 8000, 10000];
        const tryGenerate = (i) => {
          const ok = onNextRoundRef.current(i < attempts.length - 1); // silent except on the last try
          if (!ok && i < attempts.length - 1) setTimeout(()=>tryGenerate(i+1), attempts[i+1]-attempts[i]);
        };
        setTimeout(()=>tryGenerate(0), attempts[0]);
      });
      console.log("[MatchModeDiag] listeners registered successfully");
      if (cancelled) { w.remove(); g.remove(); } else { winSub = w; genSub = g; }
    })().catch(e=>console.log("MatchMode.addListener failed", e));
    return () => { cancelled = true; winSub?.remove(); genSub?.remove(); };
  }, [isAdmin, isCI, sim]);

  // Same wiring as CI above, but for CT Ladder: matches live in matchesA (single group,
  // one per court), "side" is always "A" (ladder has no group A/B split), and Generate maps
  // to onNextCTLadder instead of onNextRound. Only active in ladder format — League never
  // populates courts so these events simply never fire there.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !isAdmin || !isCT || sim || plan?.format!=="ladder") return;
    let winSub, genSub, cancelled = false;
    (async () => {
      const w = await MatchMode.addListener("courtWinner", ({ court, team }) => {
        const p = planRef.current;
        const ri = p?.rounds?.length ? p.rounds.length - 1 : -1;
        const mi = p?.rounds?.[ri]?.matchesA?.findIndex(m=>m.court===court);
        if (ri>=0 && mi>=0) onSetWinCTRef.current(ri, mi, "A", team, team==="A"?1:0, team==="A"?0:1);
      });
      const g = await MatchMode.addListener("generateNextRound", () => {
        // Same race CI had: the widget's own "all courts done" state can be a beat ahead
        // of this court's winner tap actually landing in the plan (Firestore write latency,
        // or a cold app resume still mounting) — generating from that stale state corrupts
        // the round. Retry with backoff instead of generating on the first, possibly-early,
        // attempt — mirrors the CI listener above exactly.
        const attempts = [300, 800, 1500, 2500, 4000, 6000, 8000, 10000];
        const tryGenerate = (i) => {
          const ok = onNextCTLadderRef.current(i < attempts.length - 1); // silent except on the last try
          if (!ok && i < attempts.length - 1) setTimeout(()=>tryGenerate(i+1), attempts[i+1]-attempts[i]);
        };
        setTimeout(()=>tryGenerate(0), attempts[0]);
      });
      if (cancelled) { w.remove(); g.remove(); } else { winSub = w; genSub = g; }
    })().catch(e=>console.log("MatchMode.addListener (CT) failed", e));
    return () => { cancelled = true; winSub?.remove(); genSub?.remove(); };
  }, [isAdmin, isCT, sim, plan?.format]);



  const tl     = {open:"Open Day",closed_ind:"Closed Individuals",closed_teams:"Closed Teams"};

  // CT calc — active (non-waitlisted) registrants only, matching what startCT will actually use
  const activeRegCount = splitRegsByCapacity(effEv,comm).active.length;
  const eventAvgUsr = calcEventAvgUsr(effEv,users,comm);
  // Football's pitches are fixed at event creation, not admin-selectable here like padel's
  // courts — selCtC just reads them straight off the event instead of offering a min/max choice.
  const footballPitches = Math.max(1, effEv.pitchNames?.length || effEv.courts || 1);
  const ctCC   = isCT&&!isFootballEv?calcCTCourts(activeRegCount,effEv.reservedCourts||effEv.courts||2):null;
  const selCtC = isFootballEv ? footballPitches : (ctC??ctCC?.min??tc);
  const nTeams = isFootballEv ? (effEv.numTeams||3) : Math.floor(activeRegCount/2);
  const breakTeams = Math.max(0,nTeams-selCtC*2);
  const ladderOK   = (breakTeams*2)<=selCtC;
  // Round 1 is "locked" once any match in it has a winner recorded — after this, no more player changes
  const ctR1Locked = isCT&&plan&&plan.rounds.length>0&&(
    (plan.rounds[0].matchesA||[]).some(m=>m.winner)||
    (plan.rounds[0].matchesB||[]).some(m=>m.winner)
  ); // break PLAYERS (teams×2) must not exceed courts

  // CI
  const lastCIR = plan?.rounds?.[plan.rounds.length-1];
  const canNext = isCI&&lastCIR&&lastCIR.matches.every(m=>m.winner!=null)&&plan.rounds.length<plan.totalRounds;
  // CI Round 1 is locked once any match in it has a winner recorded
  const ciR1Locked = isCI&&plan&&plan.rounds.length>0&&
    plan.rounds[0].matches.some(m=>m.winner!=null);
  const ciStands = isCI?calcCIStandings(plan,users):[];
  const ctStands = isCT?calcCTStandings(plan):[];
  const [sharing,setSharing] = useState(false);
  const [showDup,setShowDup] = useState(false);
  const [dupDate,setDupDate] = useState(()=>{const d=new Date(ev.date);d.setDate(d.getDate()+7);return d.toISOString().split("T")[0];});
  const [dupTime,setDupTime] = useState(ev.time);
  const [dupTimeTo,setDupTimeTo] = useState(ev.timeTo||"");
  const [dupKeepPlayers,setDupKeepPlayers] = useState(false);
  const [dupName,setDupName] = useState(ev.name);
  const [shareDiag,setShareDiag] = useState(null);

  const sharePlayers = effEv.registrations.map(r=>{const u=users.find(u=>u.id===r.userId);return u?{...u,usr:r.eventUsr??u.usr}:null;}).filter(Boolean);

  async function handleShareBefore(){
    setSharing(true);setShareDiag(null);
    try{
      const photoMap = await preloadPlayerPhotos(sharePlayers);
      const cards=[buildEventInfoCard(effEv,venue,sharePlayers,comm.name, isCT&&plan?plan:null, photoMap)];
      if(isCI&&plan&&plan.rounds&&plan.rounds.length>0){
        try{
          cards.push(buildFullBreakTableCard(effEv,venue,plan,tc,comm.name));
        }catch(breakErr){
          console.error("Break table card build failed:", breakErr);
          onToast&&onToast("Couldn't build the break schedule card","err");
        }
        try{
          cards.push(buildRound1Card(effEv,venue,plan,tc,comm.name));
        }catch(r1Err){
          console.error("Round 1 card build failed:", r1Err);
          onToast&&onToast("Couldn't build the Round 1 card","err");
        }
      }
      if(isCT&&plan&&plan.format==="league"){
        try{
          cards.push(buildLeaguePoolsCard(effEv,venue,plan,comm.name));
        }catch(poolErr){
          console.error("League pools card build failed:", poolErr);
          onToast&&onToast("Couldn't build the league pools card","err");
        }
      }
      if(isCT&&plan&&plan.format==="ladder"&&plan.rounds&&plan.rounds.length>0){
        try{
          cards.push(buildLadderBreakTableCard(effEv,venue,plan,tc,comm.name));
        }catch(breakErr){
          console.error("Ladder break table card build failed:", breakErr);
          onToast&&onToast("Couldn't build the break schedule card","err");
        }
        try{
          cards.push(buildLadderRound1Card(effEv,venue,plan,tc,comm.name));
        }catch(r1Err){
          console.error("Ladder Round 1 card build failed:", r1Err);
          onToast&&onToast("Couldn't build the Round 1 card","err");
        }
      }
      // Enhancement #30 — the images alone carried no accompanying message, so whoever
      // received them via WhatsApp/etc had no text context (date, time, or where it even is)
      // without opening each image. Location comes from the venue's Maps link when set.
      const shareText = [
        `🎾 ${effEv.name}`,
        `📅 ${fmtD(effEv.date)}${effEv.time?` · ${fmtT(effEv.time)}${effEv.timeTo?` – ${fmtT(effEv.timeTo)}`:""}`:""}`,
        `📍 ${venue?.name||"TBA"}${venue?.mapsUrl?`\n🗺️ ${venue.mapsUrl}`:""}`,
        `👥 ${comm.name}`,
        ``,
        `Join us on Matchkeeper!`,
      ].join("\n");
      const result = await shareImages(cards, effEv.name.replace(/\s+/g,"_"), shareText);
      if(result.status==="shared"){ onToast&&onToast(`Shared ✓ (${cards.length} image${cards.length>1?"s":""})`); }
      else { onToast&&onToast(`Native share unavailable — ${cards.length} image(s) downloaded`); setShareDiag(result.diag); }
    }catch(e){
      console.error("Share error:",e);
      onToast&&onToast("Share failed: "+(e.message||"unknown error"),"err");
    }finally{ setSharing(false); }
  }
  async function handleShareAfter(){
    setSharing(true);setShareDiag(null);
    try{
      let cards=[];
      if(isCT&&plan){
        if(ctStands.length>0) cards.push(buildPodiumCard(effEv,venue,ctStands.slice(0,3).map(s=>{
          const teamPlayers=(s.team?.players||[]).map(p=>users.find(u=>u.id===(p.userId||p.id))||p);
          const before=s.team?.avgUsr??0;
          const after=teamPlayers.length?Math.round(teamPlayers.reduce((sum,p)=>sum+(p.usr||0),0)/teamPlayers.length):before;
          const delta=Math.round(after-before);
          return {name:s.team?.name,players:teamPlayers,value:plan.format==="ladder"?s.pts:s.wins,valueLabel:plan.format==="ladder"?"pts":"wins",usrLine:`Avg USR ${before}${delta!==0?` (${delta>0?"+":""}${delta})`:""}`};
        }),comm.name));
        cards.push(buildCTStandingsCard(effEv,venue,ctStands,plan.format,comm.name,users));
        if(plan.format==="ladder"&&plan.rounds?.length>0)
          cards.push(buildCTResultsTableCard(effEv,venue,plan,ctStands,tc,comm.name));
        if(plan.format==="league"&&plan.rounds?.length>0)
          cards.push(buildLeagueMatchResultsCard(effEv,venue,plan,comm.name));
      } else {
        if(ciStands.length>0) cards.push(buildPodiumCard(effEv,venue,ciStands.slice(0,3).map(s=>{
          const before=plan?.sorted?.find(p=>p.userId===s.user.id)?.usr??s.user.usr;
          const delta=Math.round(s.user.usr-before);
          return{name:s.user.nickname,avatarUser:s.user,value:s.pts,valueLabel:"pts",usrLine:`USR ${before}${delta!==0?` (${delta>0?"+":""}${delta})`:""}`};
        }),comm.name));
        cards.push(buildStandingsCard(effEv,venue,ciStands,tc,plan,comm.name));
        if(plan) cards.push(buildResultsTableCard(effEv,venue,plan,ciStands,tc,comm.name));
        if(plan) cards.push(buildRoundResultsCard(effEv,venue,plan,comm.name));
      }
      const payerU = users.find(u=>u.id===payerId);
      const shareText = [
        `🏆 ${effEv.name} — Results`,
        `📅 ${fmtD(effEv.date)}`,
        `📍 ${venue?.name||"—"}${venue?.mapsUrl?`\n🗺️ ${venue.mapsUrl}`:""}`,
        `👥 ${comm.name}`,
        ...(totC>0&&payerU?.instapayLink?[`💳 Pay ${payerU.nickname} (${cpp} EGP): ${payerU.instapayLink}`]:[]),
      ].join("\n");
      const result = await shareImages(cards, effEv.name.replace(/\s+/g,"_")+"_results", shareText);
      if(result.status==="shared"){ onToast&&onToast(`Shared ✓ (${cards.length} image${cards.length>1?"s":""})`); }
      else { onToast&&onToast(`Native share unavailable — ${cards.length} image(s) downloaded`); setShareDiag(result.diag); }
    }catch(e){
      console.error("Share error:",e);
      onToast&&onToast("Share failed: "+(e.message||"unknown error"),"err");
    }finally{ setSharing(false); }
  }

  const tabs=["players",
    ...(isCI?(plan?["breaks","rounds","standings"]:(isAdmin?["rounds"]:[])):[]),
    ...(isCT?(plan?(plan.format==="ladder"?["teams","breaks","matches","standings"]:["teams","matches","standings"]):(isAdmin?["teams"]:[])):[]),
    "manage","photos","ann"
  ];
  const tLabels={info:"ℹ️ Info",players:"👥 Players",manage:"💰 Financial",breaks:"☕ Breaks",rounds:"🔄 Rounds",standings:"🏆 Standings",teams:"👬 Teams",matches:`${ev.sport==="Football"?"⚽":"🎾"} Matches`,photos:`🖼 Photos${(ev.photos?.length||0)>0?` (${ev.photos.length})`:""}`,ann:"📢"};

  function tapP(ri,uid){if(!sel){setSel({ri,uid});return;}if(sel.ri!==ri){setSel({ri,uid});return;}if(sel.uid===uid){setSel(null);return;}act.swap(ri,sel.uid,uid);setSel(null);}
  function PChip({p,ri,matchBadge}){
    const lv=usrLv(p.usr),isSel=sel?.ri===ri&&sel?.uid===p.userId,isTgt=sel&&sel.ri===ri&&sel.uid!==p.userId;
    let histBadge=null;
    if(isTgt&&plan){
      const cnt=plan.partnerHistory?.[sel.uid]?.[p.userId]||0;
      const prevRound=plan.rounds[ri-1];
      const wasLastPartner=prevRound?prevRound.matches.some(m=>{
        const inA=m.teamA?.some(x=>x.userId===sel.uid)&&m.teamA?.some(x=>x.userId===p.userId);
        const inB=m.teamB?.some(x=>x.userId===sel.uid)&&m.teamB?.some(x=>x.userId===p.userId);
        return inA||inB;
      }):false;
      histBadge = wasLastPartner?{label:"🚩",color:"#EF4444"}:cnt>0?{label:`×${cnt}`,color:"#F59E0B"}:{label:"✨️",color:"#34D399"};
    }
    return <div onClick={()=>isAdmin&&!isCompleted&&tapP(ri,p.userId)} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:8,cursor:isAdmin?"pointer":"default",userSelect:"none",border:`2px solid ${isSel?"#FBBF24":isTgt?"#34D399":"transparent"}`,background:isSel?"#FBBF2422":isTgt?"#34D39922":"transparent"}}>
      <Av u={p} size={28}/>
      <span style={{fontSize:13,fontWeight:500,color:"var(--po-text)",flex:1}}>{p.nickname} <span style={{fontSize:11,fontWeight:400,color:"var(--po-dim)"}}>({p.usr})</span></span>
      {matchBadge?.isDream&&<span title="ماتش جامد — this is their Dream Match" style={{fontSize:12}}>🔥</span>}
      {matchBadge?.isFunny&&<span title="ماتش مسخرة — this is their Funny Match" style={{fontSize:12}}>😂</span>}
      {p.wouldBeCourt&&<span title="Court they'd have played on by USR rank" style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:10,whiteSpace:"nowrap",background:"#38BDF822",color:"#38BDF8",border:"0.5px solid #38BDF844"}}>C{p.wouldBeCourt}</span>}
      {histBadge&&<span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:10,whiteSpace:"nowrap",background:`${histBadge.color}22`,color:histBadge.color,border:`0.5px solid ${histBadge.color}44`}}>{histBadge.label}</span>}
    </div>;
  }
  function WinCI({m,ri,mi}){
    const avgA=m.teamA?Math.round(m.teamA.reduce((s,p)=>s+p.usr,0)/m.teamA.length):0;
    const avgB=m.teamB?Math.round(m.teamB.reduce((s,p)=>s+p.usr,0)/m.teamB.length):0;
    if(m.winner){
      const wT=m.winner==="A"?m.teamA:m.teamB;
      const wScore=m.winner==="A"?m.scoreA:m.scoreB, lScore=m.winner==="A"?m.scoreB:m.scoreA;
      const scoreLabel=(wScore!=null&&lScore!=null)?` ${wScore}–${lScore}`:"";
      return <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10}}><div style={{flex:1,padding:"9px",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:12,fontWeight:600,color:"#34D399",textAlign:"center"}}>✓ {wT.map(p=>p.nickname).join(" & ")} won{scoreLabel}</div>{!isCompleted&&isAdmin&&<SmBtn label="↩" onClick={()=>act.setWinCI(ri,mi,null)} color="#EF4444"/>}</div>;
    }
    if(isCompleted) return null;
    if(!isAdmin) return <div style={{textAlign:"center",fontSize:11,color:"var(--po-dim)",marginTop:10}}>⏳ Waiting for result</div>;
    const sc=getCiS(ri,mi);
    return <>
      <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:14,marginTop:10,marginBottom:6}}>
        <ScoreStepper value={sc.scoreA} onChange={v=>setCiS(ri,mi,"scoreA",v)} label={`Team A (${avgA})`}/>
        <div style={{fontSize:14,color:"#334155",fontWeight:700}}>—</div>
        <ScoreStepper value={sc.scoreB} onChange={v=>setCiS(ri,mi,"scoreB",v)} label={`Team B (${avgB})`} flip/>
      </div>
      {sc.scoreA===sc.scoreB&&sc.scoreA>0&&<div style={{textAlign:"center",fontSize:11,color:"#F59E0B",marginBottom:6}}>⚠️ Tied — adjust score to confirm winner</div>}
      <div style={{display:"flex",gap:8}}>
        <button onMouseDown={e=>{e.preventDefault();act.setWinCI(ri,mi,"A",sc.scoreA,sc.scoreB);}}
          disabled={sc.scoreA<=sc.scoreB}
          style={{flex:1,padding:"10px 0",borderRadius:8,border:`0.5px solid ${sc.scoreA>sc.scoreB?"#6366F144":"var(--po-bdr)"}`,background:sc.scoreA>sc.scoreB?"#6366F111":"transparent",color:sc.scoreA>sc.scoreB?"#A5B4FC":"var(--po-dim)",fontSize:13,fontWeight:600,cursor:sc.scoreA<=sc.scoreB?"default":"pointer",opacity:sc.scoreA<=sc.scoreB?0.4:1}}>← Confirm Team A</button>
        <button onMouseDown={e=>{e.preventDefault();act.setWinCI(ri,mi,"B",sc.scoreA,sc.scoreB);}}
          disabled={sc.scoreB<=sc.scoreA}
          style={{flex:1,padding:"10px 0",borderRadius:8,border:`0.5px solid ${sc.scoreB>sc.scoreA?"#06B6D444":"var(--po-bdr)"}`,background:sc.scoreB>sc.scoreA?"#06B6D411":"transparent",color:sc.scoreB>sc.scoreA?"#67E8F9":"var(--po-dim)",fontSize:13,fontWeight:600,cursor:sc.scoreB<=sc.scoreA?"default":"pointer",opacity:sc.scoreB<=sc.scoreA?0.4:1}}>Confirm Team B →</button>
      </div>
    </>;}

  // Subscription read-only lock (Enhancement #17, item 2): a locked, non-admin user who isn't
  // registered in this event only ever sees its card in listings — no detail screen access at
  // all. Checked after every hook above has already run (React rule), right before the real
  // render, so it's a pure early-return on the JSX, not a skipped hook.
  if (isSubscriptionLocked(me,subscriptionSettings) && !myReg && !isAdmin) {
    return <>
      <BBtn onBack={onBack} label="Back"/>
      <Card>
        <div style={{fontWeight:700,fontSize:16,color:"var(--po-text)",marginBottom:6}}>{ev.name}</div>
        {venue&&<div style={{fontSize:12,color:"var(--po-dim)"}}>🏟 {venue.name} · {venue.area}</div>}
        <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:12}}>🗓 {fmtD(ev.date)} · {fmtT(ev.time)}{ev.timeTo?` → ${fmtT(ev.timeTo)}`:""}</div>
        <div style={{fontSize:12,fontWeight:600,color:"#F59E0B",background:"#F59E0B18",border:"0.5px solid #F59E0B44",borderRadius:8,padding:"10px 12px"}}>🔒 Your subscription has expired — event details are only available for events you're registered in. Renew to see this event.</div>
      </Card>
    </>;
  }

  return <>
    <BBtn onBack={onBack} label="Back" sticky eventLabel={`${ev.name} #${ev.id}`} subLabel={tLabels[tab]}/>
    {isAdmin&&!sim&&<div className="po-card" style={{marginBottom:12,padding:"10px 14px",background:"var(--po-card)",borderRadius:10,border:"0.5px solid var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}><div><div style={{fontSize:12,fontWeight:600,color:"var(--po-sub)"}}>🧪 Practice Session</div><div style={{fontSize:11,color:"var(--po-dim)"}}>Try out registrations, matches & scores — nothing is saved</div></div><SmBtn label="Start ▶" onClick={startSim} color="#6366F1"/></div>}
    {sim&&<div style={{marginBottom:12,padding:"10px 14px",background:"#6366F111",borderRadius:10,border:"0.5px solid #6366F155",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}><div><div style={{fontSize:12,fontWeight:600,color:"#A5B4FC"}}>🧪 Practice Session Active</div><div style={{fontSize:10,color:"var(--po-dim)"}}>{ev.status==="completed"?"Replaying from scratch with the same players — original results are untouched":"All changes here are temporary"}</div></div><SmBtn label="Exit & Discard" onClick={exitSim} color="#EF4444"/></div>}

    <Card>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          {eventAvgUsr!=null&&<EventLevelBadge avg={eventAvgUsr} size="lg" sport={effEv.sport||DEFAULT_SPORT}/>}
          <div>
            <div className="po-text" style={{fontWeight:700,fontSize:17,color:"var(--po-text)",marginBottom:4,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>{ev.name} <span style={{fontSize:11,fontWeight:500,color:"var(--po-dim)",background:"var(--po-inp)",padding:"2px 8px",borderRadius:6}}>#{ev.id}</span><Bdg label={sportLabel(ev.sport||DEFAULT_SPORT)} color="#A78BFA"/>{ev.isDemo&&me.id===1&&<Bdg label="Demo" color="#F59E0B"/>}{ev.visibility==="private"&&<Bdg label="🔒 Private" color="#94A3B8"/>}</div>
            {onOpenCommunity&&<div onClick={onOpenCommunity} style={{fontSize:12,color:"#6366F1",fontWeight:600,cursor:"pointer",marginBottom:2}}>👥 {comm.name}</div>}
            {venue&&<div style={{fontSize:12,color:"var(--po-dim)"}}>🏟 {venue.name} · {venue.area}</div>}
            <div style={{fontSize:12,color:"var(--po-dim)"}}>🗓 {fmtD(ev.date)} · {fmtT(ev.time)}{ev.timeTo?` → ${fmtT(ev.timeTo)}`:""}</div>
            {(()=>{const creator=users.find(u=>u.id===ev.createdBy);return creator?<div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>👤 Created by <span onClick={()=>onViewProfile&&onViewProfile(creator.id)} style={{color:onViewProfile?"#6366F1":"inherit",cursor:onViewProfile?"pointer":"default"}}>{creator.nickname}</span></div>:null;})()}
            {ev.description&&<div style={{fontSize:12,color:"var(--po-sub)",marginTop:6,padding:"6px 10px",background:"var(--po-inp)",borderRadius:6,fontStyle:"italic"}}>📝 {ev.description}</div>}
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end"}}>
          {isAdmin&&<div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
            <div onClick={()=>setShowHeaderMenu(o=>!o)} style={{width:30,height:30,borderRadius:"50%",background:"var(--po-inp)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,color:"var(--po-dim)",cursor:"pointer"}}>⋮</div>
            {showHeaderMenu&&<div style={{position:"absolute",top:36,right:0,zIndex:10,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:6,display:"flex",flexDirection:"column",gap:4,minWidth:150,boxShadow:"0 4px 16px rgba(0,0,0,0.3)"}}>
              <SmBtn label="✏️ Edit Event" onClick={()=>{onEditEvent();setShowHeaderMenu(false);}} color="#6366F1" style={{width:"100%"}}/>
              <SmBtn label="⧉ Duplicate" onClick={()=>{setShowDup(o=>!o);setShowHeaderMenu(false);}} color="#F59E0B" style={{width:"100%"}}/>
              {ev.archived&&<SmBtn label="📤 Unarchive" onClick={()=>{onUnarchive();setShowHeaderMenu(false);}} color="#34D399" style={{width:"100%"}}/>}
              {canDeleteOrArchive&&(!isCompleted||(isCompleted&&!ev.archived))&&<div style={{height:1,background:"var(--po-bdr)",margin:"2px 0"}}/>}
              {canDeleteOrArchive&&!isCompleted&&<SmBtn label="🗑 Delete Event" onClick={()=>{if(window.confirm(`Delete "${ev.name}" (#${ev.id})?\n\nThis hides it from everyone in this community immediately — treat it like a permanent action. (Only the platform admin can see and restore deleted events if this was a mistake.)`)){onDelete();setShowHeaderMenu(false);}}} color="#EF4444" style={{width:"100%"}}/>}
              {canDeleteOrArchive&&isCompleted&&!ev.archived&&<SmBtn label="📦 Archive" onClick={()=>{if(window.confirm(`Archive "${ev.name}" (#${ev.id})?\n\nThis hides it from active lists — treat it like a permanent action, same weight as Delete, since restoring requires finding it and manually unarchiving.`)){onArchive();setShowHeaderMenu(false);}}} color="#EF4444" style={{width:"100%"}}/>}
            </div>}
          </div>}
          {!isCompleted&&<div onClick={handleShareBefore} title="Share Event" style={{width:30,height:30,borderRadius:"50%",background:"#34D39922",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,cursor:"pointer",opacity:sharing?0.5:1}}>{sharing?"⏳":"📤"}</div>}
          {isCompleted&&<div onClick={handleShareAfter} title="Share Results" style={{width:30,height:30,borderRadius:"50%",background:"#34D39922",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,cursor:"pointer",opacity:sharing?0.5:1}}>{sharing?"⏳":"📤"}</div>}
          {ev.type&&<Bdg label={tl[ev.type]} color="#6366F1"/>}
          {!ev.type&&<Bdg label="🗳 Poll" color="#F59E0B"/>}
          {isCompleted&&<Bdg label="✓ Completed" color="#34D399"/>}
          {ev.archived&&<Bdg label="📦 Archived" color="#94A3B8"/>}
        </div>
      </div>
      {showDup&&<div style={{marginTop:-4,marginBottom:12,padding:"12px",background:"var(--po-inp)",borderRadius:10,border:"0.5px solid #F59E0B44"}}>
        <div style={{fontSize:12,fontWeight:600,color:"#F59E0B",marginBottom:8}}>⧉ Duplicate this event — pick a new date and time</div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <input type="text" value={dupName} onChange={e=>setDupName(e.target.value)} placeholder="Event name" className="po-inp"
            style={{flex:1,padding:"8px 10px",borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}/>
          <button type="button" onClick={()=>setDupName(suggestEventName({date:dupDate,time:dupTime,venueName:venues.find(v2=>v2.id===ev.venueId)?.name,sport:ev.sport}))} title="Suggest a name" style={{padding:"8px 10px",borderRadius:8,border:"0.5px solid #6366F1",background:"#6366F122",color:"#A5B4FC",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>✨</button>
        </div>
        <input type="date" value={dupDate} onChange={e=>setDupDate(e.target.value)} className="po-inp"
          style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",color:"var(--po-text)",fontSize:13,marginBottom:10,boxSizing:"border-box"}}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          <div>
            <div style={{fontSize:10,color:"var(--po-dim)",marginBottom:3}}>Start time</div>
            <input type="time" value={dupTime} onChange={e=>setDupTime(e.target.value)} className="po-inp"
              style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:"var(--po-dim)",marginBottom:3}}>End time</div>
            <input type="time" value={dupTimeTo} onChange={e=>setDupTimeTo(e.target.value)} className="po-inp"
              style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}/>
          </div>
        </div>
        <div onClick={()=>setDupKeepPlayers(o=>!o)} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:8,background:"var(--po-card)",cursor:"pointer",marginBottom:10}}>
          <div style={{width:40,height:22,borderRadius:11,background:dupKeepPlayers?"#6366F1":"#334155",position:"relative",transition:"background 0.2s",flexShrink:0}}>
            <div style={{position:"absolute",top:2,left:dupKeepPlayers?20:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:600,color:"var(--po-text)"}}>Copy registered players too</div>
            <div style={{fontSize:10,color:"var(--po-dim)"}}>{dupKeepPlayers?"Same players will be pre-registered":"New event starts with no players"}</div>
          </div>
        </div>
        <Btn label="Create Copy" primary onClick={()=>{if(dupDate&&dupTime){onDuplicate(dupDate,dupKeepPlayers,dupTime,dupTimeTo,dupName);setShowDup(false);}}} style={{width:"100%"}}/>
        <div style={{fontSize:11,color:"var(--po-dim)",marginTop:6}}>Creates a fresh copy of "{ev.name}" with no results — same venue, courts, and type.</div>
      </div>}

      {shareDiag&&<div style={{marginBottom:12,padding:"10px 12px",background:"#EF444411",border:"0.5px solid #EF444444",borderRadius:8}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <span style={{fontSize:11,fontWeight:600,color:"#F87171"}}>📋 Share Diagnostics (screenshot this for support)</span>
          <SmBtn label="✕" onClick={()=>setShareDiag(null)} color="#EF4444"/>
        </div>
        {shareDiag.map((d,i)=><div key={i} style={{fontSize:10,color:"var(--po-dim)",fontFamily:"monospace",marginBottom:2}}>{d}</div>)}
      </div>}

      <PollBlock ev={effEv} me={me} isReg={isReg} isAdmin={isAdmin} onVote={act.vote} onResolveType={act.resolveType}/>

      {(()=>{
        // Graduated Min/Max capacity indicator (approved design, replaces the old plain bar +
        // text) — a moving marker on a Min→Max track instead of a single number. Deliberately
        // no "exceptional max" (courts×6) tier: that number isn't reachable through anything in
        // the app today, so showing it would promise capacity that doesn't actually exist.
        const regCap=getMaxPlayers(effEv);
        const {active:activeRegsForBar,waitlisted:waitlistedRegsForBar}=splitRegsByCapacity(effEv,comm);
        const shownCap=regCap??maxCap;
        const cnt=activeRegsForBar.length;
        const pct=shownCap>0?Math.min(100,(cnt/shownCap)*100):0;
        const minPct=shownCap>0?Math.min(100,(minReq/shownCap)*100):0;
        const showMinTick=minReq>0&&minReq<shownCap;
        const isFull=cnt>=shownCap;
        const pastMin=cnt>=minReq;
        const barColor=isFull?"#EF4444":pastMin?"#34D399":"#6366F1";
        const statusLabel=isFull?"Full":pastMin?"On track":`Needs ${Math.max(0,minReq-cnt)} more`;
        return <div style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:10}}>
            <div><span style={{fontSize:20,fontWeight:800,color:"var(--po-text)"}}>{cnt}</span><span style={{fontSize:12,fontWeight:600,color:"var(--po-dim)"}}> / {shownCap} registered</span></div>
            <span style={{fontSize:10,fontWeight:700,padding:"3px 9px",borderRadius:20,color:barColor,background:`${barColor}22`,whiteSpace:"nowrap"}}>{statusLabel}</span>
          </div>
          <div style={{position:"relative",padding:"0 1px",marginBottom:6}}>
            <div style={{height:8,borderRadius:4,background:"var(--po-bdr)",position:"relative"}}>
              <div style={{position:"absolute",left:0,top:0,height:"100%",borderRadius:4,width:`${pct}%`,background:barColor,transition:"width 0.3s"}}/>
              {showMinTick&&<div style={{position:"absolute",top:-3,left:`${minPct}%`,width:2,height:14,background:"var(--po-card)",borderLeft:"2px solid var(--po-bg)",transform:"translateX(-1px)"}}/>}
              <div style={{position:"absolute",top:"50%",left:`${pct}%`,width:14,height:14,borderRadius:"50%",background:barColor,border:"3px solid var(--po-card)",transform:"translate(-50%,-50%)",boxShadow:"0 1px 4px rgba(0,0,0,0.25)",transition:"left 0.3s"}}/>
            </div>
          </div>
          <div style={{position:"relative",fontSize:10,fontWeight:600,color:"var(--po-dim)",height:24}}>
            <div style={{position:"absolute",left:0,textAlign:"left"}}><div style={{fontSize:11,fontWeight:800,color:"var(--po-text)"}}>0</div>Start</div>
            {showMinTick&&<div style={{position:"absolute",left:`${minPct}%`,transform:"translateX(-50%)",textAlign:"center"}}><div style={{fontSize:11,fontWeight:800,color:"var(--po-text)"}}>{minReq}</div>Min</div>}
            <div style={{position:"absolute",right:0,textAlign:"right"}}><div style={{fontSize:11,fontWeight:800,color:"var(--po-text)"}}>{shownCap}</div>Max</div>
          </div>
          {waitlistedRegsForBar.length>0&&<div style={{marginTop:10,display:"flex",alignItems:"center",gap:6,fontSize:11,fontWeight:600,color:"#F59E0B",background:"#F59E0B22",padding:"8px 10px",borderRadius:8}}>⏳ {waitlistedRegsForBar.length} on the waitlist — first in line joins automatically if a spot opens</div>}
          {inRW&&!isReg&&!isAdmin&&<div style={{fontSize:11,color:"#FBBF24",marginTop:6}}>⏳ Priority for Regular Members until {new Date(effEv.regularUntil).toLocaleTimeString([],{hour:"numeric",minute:"2-digit",hour12:true})}</div>}
        </div>;
      })()}

      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:12}}>
        {[[effEv.sport==="Football"?"Pitches":"Courts",tc],["Registered",effEv.registrations.length],
          ...(isOpen?[["Checked In",cinCnt],["Per Person",`${cpp} EGP`]]:
              isCI?[["Rounds",plan?.rounds?.length||0],[`C1=${courtPts(1,tc)}pts`,`Brk=${bp}pts`]]:
              isCT?[["Teams",plan?.teams?.length||0],["Format",plan?.format||"—"]]:[])
        ].map(([l,val])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"7px 4px",textAlign:"center"}}><div style={{fontSize:13,fontWeight:700,color:"var(--po-text)"}}>{val}</div><div style={{fontSize:9,color:"var(--po-dim)",marginTop:1}}>{l}</div></div>)}
      </div>

      {!isCompleted&&effEv.status==="registration_open"&&<>
        {canReg&&<Btn label={myWouldWaitlist?"⏳ Join Waitlist":"I'm In ✓"} primary onClick={act.register} style={{width:"100%",marginBottom:6}}/>}
        {canReg&&myWouldWaitlist&&inRW&&!isReg&&!isAdmin&&<div style={{fontSize:11,color:"#FBBF24",marginTop:-3,marginBottom:6,textAlign:"center"}}>Regular Members get priority for the first 24h — you'll move up automatically after {new Date(effEv.regularUntil).toLocaleTimeString([],{hour:"numeric",minute:"2-digit",hour12:true})} if there's room.</div>}
        {!canReg&&!myReg&&(myEventJoinPending
          ? <div style={{padding:"9px",textAlign:"center",background:"#FBBF2422",border:"0.5px solid #FBBF2444",borderRadius:8,fontSize:13,fontWeight:500,color:"#FBBF24",marginBottom:6}}>⏳ Request sent — waiting for admin approval</div>
          : <Btn label="🙋 Request to Join" onClick={act.requestEventJoin} style={{width:"100%",marginBottom:6}}/>)}
        {myReg&&isSubscriptionLocked(me,subscriptionSettings)&&<div style={{padding:"9px",textAlign:"center",background:"#F59E0B22",border:"0.5px solid #F59E0B44",borderRadius:8,fontSize:13,fontWeight:500,color:"#F59E0B",marginBottom:6}}>🚫 Suspended — your subscription expired, so you've been moved to the waitlist. Renew to reclaim your spot.</div>}
        {myReg&&!isSubscriptionLocked(me,subscriptionSettings)&&isRegWaitlisted(effEv,me.id,comm)&&<div style={{padding:"9px",textAlign:"center",background:"#F59E0B22",border:"0.5px solid #F59E0B44",borderRadius:8,fontSize:13,fontWeight:500,color:"#F59E0B",marginBottom:6}}>⏳ You're on the waitlist — we'll notify you if a spot opens up</div>}
        {myReg&&!isSubscriptionLocked(me,subscriptionSettings)&&!isRegWaitlisted(effEv,me.id,comm)&&isOpen&&(isDay?(!isCIn?<div style={{display:"flex",gap:6,marginBottom:6}}><div style={{flex:1,padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399"}}>✓ Registered</div><Btn label="Check In" primary onClick={()=>act.checkIn(me.id)} style={{flex:1}}/></div>:<div style={{padding:"9px",textAlign:"center",background:"#6366F122",border:"0.5px solid #6366F144",borderRadius:8,fontSize:13,fontWeight:500,color:"#A5B4FC",marginBottom:6}}>✓ Checked In</div>):<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399",marginBottom:6}}>✓ Registered — check-in on event day</div>)}
        {myReg&&!isSubscriptionLocked(me,subscriptionSettings)&&!isRegWaitlisted(effEv,me.id,comm)&&(isCI||isCT)&&<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399",marginBottom:6}}>✓ Registered — attendance via match results</div>}
        {/* Self-service unregister — was admin-only before (removeFromEvent's "✕" in Players),
            leaving a registered player with no way to back out themselves. Same safety gate as
            the admin's own remove button: locked once Round 1 is locked for CI/CT (would
            corrupt matches players are already slotted into); Open events have no plan to lock
            against, so this stays available for them right up to close. */}
        {myReg&&(!effEv.plan||(isCT&&!ctR1Locked)||(isCI&&!ciR1Locked))&&<SmBtn label="Cancel my registration" onClick={()=>{if(window.confirm(`Cancel your registration for "${ev.name}"?\n\nIf you're on the waitlist, this just removes you. If you have an active spot, the next person on the waitlist (if any) will automatically take it.`))act.removeFromEvent(me.id);}} color="#EF4444" style={{width:"100%",marginBottom:6,textAlign:"center",justifyContent:"center",display:"flex"}}/>}
        {isAdmin&&!sim&&<Btn label="🏁 Close & Finish Event" danger onClick={()=>{if(window.confirm(`Close "${ev.name}"?\n\nThis freezes final rankings and locks all results permanently — no more score changes after this. Make sure every match result is entered first.`))act.closeEvent();}} style={{width:"100%"}}/>}
        {isAdmin&&!sim&&isPlatformAdmin&&(isCI||(isCT&&plan?.format==="ladder"))&&<Btn label="🧪 Close with Output PES (Performance Based)" onClick={()=>{if(window.confirm(`Close "${ev.name}" using Output PES (Entry USR + performance delta) instead of the standard court-based formula?\n\nThis is what actually gets written to USR history for this event — same as a normal close, just computed differently. Freezes final rankings permanently, same as the standard close.`))act.closeEvent("new");}} style={{width:"100%",marginTop:6,background:"transparent",border:"0.5px solid #A78BFA66",color:"#A78BFA"}}/>}
        {isAdmin&&sim&&<div style={{padding:"9px",textAlign:"center",background:"#6366F111",border:"0.5px solid #6366F144",borderRadius:8,fontSize:12,color:"#A5B4FC"}}>🧪 Exit Practice Session to close this event for real</div>}
      </>}
      {isCompleted&&<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:600,color:"#34D399"}}>✓ Event Completed</div>}
      {/* Player-facing "who to pay" card — the admin-only Settlement card further down (isAdmin
          gate) is invisible to regular players, so without this they'd have no way to see the
          collector or an InstaPay link at all. Shown to any paying, non-exempt attendee who
          isn't the collector themself, whenever a cost has actually been set. */}
      {totC>0&&attendeeIds.includes(me.id)&&!exemptedIds.has(me.id)&&me.id!==payerId&&(()=>{
        const payerU=users.find(u=>u.id===payerId);
        const iPaid=paidIds.has(me.id);
        return <div style={{marginTop:8,padding:"9px 10px",background:iPaid?"#34D39922":"#6366F122",border:`0.5px solid ${iPaid?"#34D39944":"#6366F144"}`,borderRadius:8}}>
          <div style={{fontSize:12,fontWeight:600,color:iPaid?"#34D399":"#A5B4FC"}}>{iPaid?`✓ You've paid your ${cpp} EGP share`:`💰 You owe ${cpp} EGP — pay ${payerU?.nickname||"the collector"}`}</div>
          {!iPaid&&payerU?.instapayLink&&<SmBtn label={`💳 ${payerU.nickname}'s InstaPay`} onClick={()=>window.open(payerU.instapayLink,"_blank")} color="#6366F1" style={{width:"100%",marginTop:6,textAlign:"center",justifyContent:"center",display:"flex"}}/>}
          {!iPaid&&venue?.instapayLink&&<SmBtn label={`🏟 Pay ${venue.name} via InstaPay`} onClick={()=>window.open(venue.instapayLink,"_blank")} color="#94A3B8" style={{width:"100%",marginTop:6,textAlign:"center",justifyContent:"center",display:"flex"}}/>}
        </div>;
      })()}
    </Card>

    <CollapsibleSection label="ℹ️ Event Info" defaultOpen={false}>
      <Card><div style={{display:"flex",flexDirection:"column",gap:8}}>{[["Venue",venue?`${venue.name}, ${venue.area}`:"TBD"],
        ["Type",ev.type?(getEventTypesForSport(effEv.sport).find(t=>t.key===ev.type)?.label||tl[ev.type]):"Pending Poll"],
        ["Date & Time",`${fmtD(ev.date)} · ${fmtT(ev.time)}${ev.timeTo?" → "+fmtT(ev.timeTo):""}`],
        ["Duration",durationLabel(ev.time, ev.timeTo)],
        ["Created by",(()=>{const u=users.find(u=>u.id===ev.createdBy);return u?<span onClick={()=>onViewProfile&&onViewProfile(u.id)} style={{cursor:onViewProfile?"pointer":"default",color:onViewProfile?"#6366F1":"inherit"}}>{u.nickname} ({u.name})</span>:"—";})()],...(isCI?[["Scoring",Array.from({length:tc},(_,i)=>`Court ${i+1}=${courtPts(i+1,tc)}pts`).join(" · ")+` · Break=${bp}pts`],["Round Duration",`${plan?.roundDuration||roundDur} min`]]:isOpen?[["Rotation",`Every ${effEv.rotationMin} min`],["Check-in","Required · cost split by attendees"]]:isCT?[["Formation",isFootballEv?"Snake Draft (Football Skill)":"Multi-Pool Snake (USR)"],["Competition",plan?.format==="ladder"?"Ladder":isFootballEv?"League":"League + Promotion/Relegation"],[plan?.format==="ladder"?"Scoring":"Ranking",plan?.format==="ladder"?`${isFootballEv?"Pitch":"Court"} ${tc}=1pt ... ${isFootballEv?"Pitch":"Court"} 1=${tc}pts · Break=${ctLadderBreakPts(tc)}pts`:(isFootballEv?"Wins → Score Diff":"Group A first · Wins → Score Diff")],["Match Duration",`${plan?.matchDuration||20} min`]]:[]),["Priority Reg.","Regular Members: 24h early access"]].map(([k,val])=><div key={k} style={{display:"flex",gap:8,paddingBottom:7,borderBottom:"0.5px solid var(--po-bdr)"}}><span className="po-dim" style={{fontSize:12,color:"var(--po-dim)",minWidth:110}}>{k}</span><span className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>{val}</span></div>)}</div></Card>
    </CollapsibleSection>

    <VenueMapCard venue={venue}/>

    {/* Closed Teams Ladder events stack up to 7 tabs (players/teams/breaks/matches/standings/
        manage/photos) — same >5 overflow rule as Community, using the same TwoRowTabs component
        Platform Admin already uses (this screen already shared Tabs' boxed style, so switching
        to its two-row sibling here doesn't change how it looks, just fixes the cramming). */}
    {tabs.length>5
      ? <TwoRowTabs tabs={tabs.map(t=>[t,tLabels[t]||t])} active={tab} onChange={setTab}/>
      : <Tabs tabs={tabs.map(t=>[t,tLabels[t]||t])} active={tab} onChange={setTab}/>}

    {/* PLAYERS */}
    {tab==="players"&&<>
      {isCT&&ctR1Locked&&<div style={{marginBottom:10,padding:"8px 12px",background:"#EF444411",border:"0.5px solid #EF444433",borderRadius:8,fontSize:12,color:"#EF4444"}}>🔒 Round 1 has results — player list, team formation, and breaks are now frozen.</div>}
      {isCT&&!ctR1Locked&&plan&&<div style={{marginBottom:10,padding:"8px 12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:8,fontSize:12,color:"#34D399"}}>✓ You can still add/remove players and regenerate teams until Round 1 has results.</div>}
      {isCI&&ciR1Locked&&<div style={{marginBottom:10,padding:"8px 12px",background:"#EF444411",border:"0.5px solid #EF444433",borderRadius:8,fontSize:12,color:"#EF4444"}}>🔒 Round 1 has results — player list is now frozen.</div>}
      {isCI&&!ciR1Locked&&plan&&<div style={{marginBottom:10,padding:"8px 12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:8,fontSize:12,color:"#34D399"}}>✓ You can still add/remove players until Round 1 has results.</div>}
      {inviteUrl&&<InviteModal url={inviteUrl.url} label={inviteUrl.label} onClose={()=>setInviteUrl(null)}/>}
      {isAdmin&&(effEv.joinRequests||[]).length>0&&<Card style={{marginBottom:10,borderColor:"#FBBF2466",background:"#FBBF240A"}}>
        <ST>🙋 Requests to Join ({effEv.joinRequests.length})</ST>
        {effEv.joinRequests.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return <div key={r.userId} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
          <Av u={u} size={28}/><div style={{flex:1}}><span style={{fontSize:12,fontWeight:500,color:"var(--po-text)"}}>{u.nickname}</span><span style={{fontSize:11,color:"var(--po-dim)",marginLeft:6}}>USR {u.usr}</span></div>
          <SmBtn label="✓" onClick={()=>act.approveEventJoin(u.id)} color="#34D399"/>
          <SmBtn label="✕" onClick={()=>act.rejectEventJoin(u.id)} color="#EF4444"/>
        </div>;})}
      </Card>}
      {isAdmin&&!(ctR1Locked||ciR1Locked)&&<><div style={{display:"flex",gap:6,marginBottom:10}}>{onCreateInvite&&!isCompleted&&<SmBtn label="🔗 Invite Link" onClick={()=>{const label=`Join ${effEv.name}`;setInviteUrl({url:`${INVITE_BASE_URL}/?invite=${onCreateInvite({communityId:comm.id,eventId:effEv.id,label})}`,label});}} color="#34D399" style={{flex:1}}/>}<Btn label="+ Add Member" onClick={()=>{setSAM(o=>!o);setSAG(false);}} style={{flex:1}}/>{!sim&&<Btn label="+ Add Guest" onClick={()=>{setSAG(o=>!o);setSAM(false);}} style={{flex:1}}/>}</div>
      {showAddM&&(()=>{const candidates=comm.members.filter(m=>!new Set(effEv.registrations.map(r=>r.userId)).has(m.userId)).map(m=>users.find(u=>u.id===m.userId)).filter(Boolean);const amQ=addMemberSearch.trim().toLowerCase();const shownCandidates=amQ?candidates.filter(u=>u.nickname?.toLowerCase().includes(amQ)||u.name?.toLowerCase().includes(amQ)):candidates;return <Card style={{marginBottom:10}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Select member to add:</div>{candidates.length>6&&<input value={addMemberSearch} onChange={e=>setAddMemberSearch(e.target.value)} placeholder="🔍 Search members..." className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box",marginBottom:8}}/>}{shownCandidates.map(u=><div key={u.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"0.5px solid var(--po-bdr)"}}><Av u={u} size={30}/><div style={{flex:1}}><div style={{fontSize:13,fontWeight:500,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr}</div></div><SmBtn label="Add" onClick={()=>act.addMember(u.id)} color="#6366F1"/></div>)}{candidates.length===0&&<div style={{fontSize:12,color:"var(--po-dim)",textAlign:"center",padding:"8px 0"}}>All community members are registered ✓</div>}{candidates.length>0&&shownCandidates.length===0&&<div style={{fontSize:12,color:"var(--po-dim)",textAlign:"center",padding:"8px 0"}}>No members match "{addMemberSearch}"</div>}<SmBtn label="✓ Done" onClick={()=>{setSAM(false);setAddMemberSearch("");}} color="#34D399" style={{width:"100%",marginTop:8}}/></Card>;})()}
      {showAddG&&<Card style={{marginBottom:10}}>
        <div style={{fontSize:12,color:"#F59E0B",marginBottom:8}}>⚠️ Nickname and phone required for guests</div>
        {[["Nickname *","n","text"],["Full Name","name","text"],["Phone *","p","tel"]].map(([l,k,t])=><input key={k} type={t} value={gf[k]} onChange={e=>setGf(p=>({...p,[k]:e.target.value}))} placeholder={l} className="po-inp" style={{width:"100%",background:"var(--po-inp)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13,marginBottom:6,boxSizing:"border-box",border:`0.5px solid ${(k==="n"||k==="p")&&!gf[k]?"#EF444466":"var(--po-bdr)"}`}}/>)}
        <div style={{marginBottom:8}}>
          <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Initial USR (editable)</div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <input type="range" min="0" max="100" value={gf.usr} onChange={e=>setGf(p=>({...p,usr:e.target.value}))} style={{flex:1}}/>
            <span style={{fontSize:14,fontWeight:700,color:"#6366F1",minWidth:32}}>{gf.usr}</span>
          </div>
        </div>
        <Btn label="Add Guest" primary onClick={()=>{if(gf.n&&gf.p&&act.addGuest(gf)){setGf({n:"",name:"",p:"",usr:"50"});}}} style={{width:"100%"}}/>
        <SmBtn label="✓ Done" onClick={()=>setSAG(false)} color="#34D399" style={{width:"100%",marginTop:8}}/>
      </Card>}</>}
      {isOpen&&cinCnt>0&&<><ST>Checked In ({cinCnt})</ST>{effEv.checkedIn.map(uid=>{const u=users.find(u=>u.id===uid);if(!u)return null;return <Card key={uid} style={{cursor:onViewProfile?"pointer":"default"}}><div onClick={()=>onViewProfile&&onViewProfile(u.id)} style={{display:"flex",alignItems:"center",gap:10}}><Av u={u} size={34}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr}</div></div><Bdg label="✓ In" color="#34D399"/></div></Card>;})}</>}
      {isCT&&plan?.waitlisted?.length>0&&<>
        <ST>⏳ Waiting List (odd player count)</ST>
        {plan.waitlisted.map(w=>{const wu=users.find(u=>u.id===w.userId);return <Card key={w.userId} style={{marginBottom:8,borderColor:"#F59E0B66",background:"#F59E0B08",cursor:wu&&onViewProfile?"pointer":"default"}}>
          <div onClick={()=>wu&&onViewProfile&&onViewProfile(wu.id)} style={{display:"flex",alignItems:"center",gap:10}}>
            <Av u={wu||w} size={34}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{w.nickname}</div>
              <div style={{fontSize:11,color:"#F59E0B"}}>Waiting — will join when another player registers</div>
            </div>
            <Bdg label="Waiting" color="#F59E0B"/>
          </div>
        </Card>;})}
      </>}
      {(()=>{
        const ctOddWaitlistedIds=new Set((plan?.waitlisted||[]).map(w=>w.userId));
        // Suspension only applies to upcoming events — an already-completed event's attendance
        // record shouldn't retroactively change because someone's subscription later lapsed.
        const rawSplit = splitRegsByCapacity(effEv,comm);
        const {active:capActiveRegs,waitlisted:capWaitlistedRegs,suspendedIds}=effEv.status!=="completed"&&effEv.status!=="cancelled"
          ? applySubscriptionSuspension(rawSplit,effEv,users,subscriptionSettings)
          : {...rawSplit,suspendedIds:new Set()};
        const activeRegs=capActiveRegs.filter(r=>!ctOddWaitlistedIds.has(r.userId));
        return <><ST>Registered ({activeRegs.length})</ST>
        {activeRegs.map(r=>{
        const u=users.find(u=>u.id===r.userId);if(!u)return null;
        const ci2=effEv.checkedIn.includes(u.id);
        const isRetired=(effEv.retiredIds||[]).includes(u.id);
        // Whether this player ever actually showed up in a generated round/match, regardless
        // of Round-1-locked status — found live: a registration can exist for someone who was
        // never included when the plan was formed (a stale invite link, or the silent-drop bug
        // fixed alongside this), leaving nothing real to protect by keeping Remove hidden for
        // them specifically. R1-locked still blocks removing anyone who genuinely played.
        const wasEverInPlan = !effEv.plan ? false : isCI
          ? (effEv.plan.rounds||[]).some(rr=>(rr.matches||[]).some(m=>[...(m.teamA||[]),...(m.teamB||[])].some(p=>(p.userId||p.id)===u.id))||(rr.onBreak||[]).some(p=>(p.userId||p.id)===u.id))
          : isCT
          ? (effEv.plan.teams||[]).some(t=>(t.players||[]).some(p=>(p.userId||p.id)===u.id))
          : false;
        const mStatus=comm.members?.find(m=>m.userId===u.id)?.status;
        const uMem=comm.members?.find(m=>m.userId===u.id);
        const uIsCommAdmin=uMem?.role==="owner"||uMem?.role==="admin";
        const uIsEventAdmin=(effEv.eventAdmins||[]).includes(u.id);
        // Guest-ness used to be checked three different ways (u.isGuest, r.isGuest, mStatus)
        // that could disagree for the same person — e.g. someone added via "+Add Guest" has
        // u.isGuest=true forever, but a later registration for them via an approved join
        // request sets r.isGuest=false on that specific registration, so both a "GUEST" badge
        // AND a non-guest "by approved" badge rendered side by side. One combined signal now.
        const isGuestPerson = u.isGuest || r.isGuest || mStatus==="guest";
        // A real app user with zero community membership record at all (not even guest-tier)
        // who found this specific event and got let in directly — distinct from the padel/
        // football "Guest" concept (someone with no account of their own, or a guest-tier
        // community member). Surfaced separately so it's clear at a glance they aren't a
        // community member in any capacity, not just relabeled as a generic "Guest".
        const isEventOnlyGuest = !isGuestPerson && !mStatus;
        const addedByLabel = r.addedBy==="admin"?"Added by Admin":r.addedBy==="invite"?"via Invite":r.addedBy==="approved"?"Approved":r.addedBy?`by ${r.addedBy}`:null;
        return <Card key={r.userId} style={{opacity:isRetired?0.6:1}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <Av u={u} size={34}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)",display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span onClick={()=>onViewProfile&&onViewProfile(u.id)} style={{cursor:onViewProfile?"pointer":"default"}}>{u.nickname}{effEv.sport!=="Football"&&<span style={{fontWeight:400,color:"var(--po-dim)"}}> ({historicUsr(u.id,effEv.plan,u.usr)})</span>}</span>
                {mStatus&&mStatus!=="guest"&&sBdg(mStatus)}
                {isRetired&&<span style={{marginLeft:4,fontSize:10,color:"#EF4444",fontWeight:700}}>🚑 RETIRED</span>}
                {suspendedIds.has(u.id)&&<span style={{marginLeft:4,fontSize:10,color:"#F59E0B",fontWeight:700}}>🚫 SUSPENDED</span>}
                {uIsEventAdmin&&<span style={{marginLeft:4,fontSize:10,color:"#A78BFA",fontWeight:700}}>🛡️ EVENT ADMIN</span>}
              </div>
              {isAdmin&&isGuestPerson&&u.phone&&<a href={`tel:${u.phone}`} onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:4,fontSize:10.5,color:"var(--po-dim)",marginTop:1,textDecoration:"none"}}>📱 {u.phone}</a>}
              {/* Football events show/edit footballSkill instead of padel USR — the padel USR
                  override machinery (guest USR, event-only USR) has no meaning for football. */}
              {effEv.sport==="Football"
                ? (isAdmin
                    ? <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                        <span style={{fontSize:11,color:"var(--po-dim)"}}>⚽ Skill:</span>
                        <select value={u.footballSkill||""} onChange={e=>act.setFootballSkill(u.id,e.target.value)} className="po-inp" style={{fontSize:11,padding:"2px 6px",borderRadius:5,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)"}}>
                          <option value="">Not Rated</option>
                          {["A","B","C","D","E"].map(g=><option key={g} value={g}>{g}</option>)}
                        </select>
                      </div>
                    : <div style={{fontSize:11,color:"var(--po-dim)"}}>⚽ Skill: {u.footballSkill||"Not Rated"}</div>)
                : (u.isGuest||r.isGuest)&&isAdmin
                ? <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                    <span style={{fontSize:11,color:"var(--po-dim)"}}>USR</span>
                    <input type="number" min="0" max="100" defaultValue={u.usr}
                      onBlur={e=>{const v=parseInt(e.target.value); if(!isNaN(v)&&v!==u.usr){act.editGuestUsr(u.id,v);e.target.style.borderColor="#34D399";}}}
                      onKeyDown={e=>{if(e.key==="Enter"){const v=parseInt(e.target.value);if(!isNaN(v)){act.editGuestUsr(u.id,v);e.target.blur();}}}}
                      className="po-inp"
                      style={{width:52,padding:"2px 6px",borderRadius:6,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",fontSize:12,fontWeight:600}}/>
                    <span style={{fontSize:10,color:"var(--po-dim)"}}>/100</span>
                  </div>
                : (u.isGuest||r.isGuest)
                  ? <div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr}</div>
                  : isAdmin&&!effEv.plan
                  ? <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                      <span style={{fontSize:11,color:"var(--po-dim)"}}>USR</span>
                      <input type="number" min="0" max="100" defaultValue={r.eventUsr??u.usr}
                        onBlur={e=>{const v=parseInt(e.target.value);if(!isNaN(v)){act.editEventUsr(u.id,v);}}}
                        onKeyDown={e=>{if(e.key==="Enter"){const v=parseInt(e.target.value);if(!isNaN(v)){act.editEventUsr(u.id,v);e.target.blur();}}}}
                        className="po-inp"
                        style={{width:52,padding:"2px 6px",borderRadius:6,border:`0.5px solid ${r.eventUsr!=null?"#F59E0B66":"var(--po-bdr)"}`,background:"var(--po-inp)",color:"var(--po-text)",fontSize:12,fontWeight:600}}/>
                      <span style={{fontSize:10,color:"var(--po-dim)"}}>/100</span>
                      {r.eventUsr!=null&&<span style={{fontSize:10,color:"#F59E0B"}}>📌 event-only · base {u.usr}</span>}
                    </div>
                  : <div style={{fontSize:11,color:"var(--po-dim)"}}>USR {r.eventUsr??u.usr}{r.eventUsr!=null&&<span style={{color:"#F59E0B",marginLeft:4}}>📌</span>}</div>
              }
              {isCI&&!u.isGuest&&(isAdmin
                ? <div style={{display:"flex",alignItems:"center",gap:4,marginTop:2}}>
                    <span style={{fontSize:10,color:"var(--po-dim)"}}>Break:</span>
                    <select value={r.breakPrefOverride||""} onChange={e=>act.setBreakPrefOverride(u.id,e.target.value||null)} className="po-inp" style={{fontSize:10,padding:"1px 4px",borderRadius:5,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)"}}>
                      <option value="">Default ({BREAK_PREF_LABELS[u.breakPref||"none"]})</option>
                      <option value="none">No Preference</option>
                      <option value="early">Prefer Early</option>
                      <option value="mid">Prefer Mid</option>
                      <option value="late">Prefer Late</option>
                    </select>
                  </div>
                : <div style={{fontSize:10,color:"var(--po-dim)",marginTop:2}}>Break: {BREAK_PREF_LABELS[r.breakPrefOverride||u.breakPref||"none"]}{r.breakPrefOverride&&<span style={{color:"#F59E0B",marginLeft:3}}>📌 event-only</span>}</div>
              )}
            </div>
            <div style={{display:"flex",gap:4,flexWrap:"wrap",justifyContent:"flex-end",alignItems:"center"}}>
              {isGuestPerson
                ? <Bdg label={addedByLabel?`Guest · ${addedByLabel}`:"Guest"} color="#F59E0B"/>
                : isEventOnlyGuest
                  ? <Bdg label={addedByLabel?`🎫 Event Guest · ${addedByLabel}`:"🎫 Event Guest"} color="#8B5CF6"/>
                  : addedByLabel&&<Bdg label={addedByLabel} color="#6366F1"/>}
              {isOpen&&ci2&&<Bdg label="✓ In" color="#34D399"/>}
              {isAdmin&&<div style={{position:"relative",flexShrink:0}} onClick={e=>e.stopPropagation()}>
                <div onClick={()=>setOpenPlayerMenu(o=>o===u.id?null:u.id)} style={{width:28,height:28,borderRadius:"50%",background:"var(--po-inp)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,color:"var(--po-dim)",cursor:"pointer"}}>⋮</div>
                {openPlayerMenu===u.id&&<div style={{position:"absolute",top:34,right:0,zIndex:10,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:6,display:"flex",flexDirection:"column",gap:4,minWidth:170,boxShadow:"0 4px 16px rgba(0,0,0,0.3)"}}>
                  {isOpen&&!ci2&&isDay&&<SmBtn label="✓ Check In" onClick={()=>{act.checkIn(u.id);setOpenPlayerMenu(null);}} color="#34D399" style={{width:"100%"}}/>}
                  {onCreateInvite&&!Object.values(uidLinks||{}).includes(u.id)&&<SmBtn label="🔗 Invite" onClick={()=>{const label=`Join ${effEv.name} as ${u.nickname}`;setInviteUrl({url:`${INVITE_BASE_URL}/?invite=${onCreateInvite({targetUserId:u.id,communityId:comm.id,eventId:effEv.id,label})}`,label});setOpenPlayerMenu(null);}} color="#34D399" style={{width:"100%"}}/>}
                  {isRealAdmin&&!uIsCommAdmin&&effEv.status!=="completed"&&<SmBtn label={uIsEventAdmin?"🛡️ Demote":"🛡️ Make Admin"} onClick={()=>{setOpenPlayerMenu(null);if(uIsEventAdmin||window.confirm(`Make ${u.nickname} an admin for "${ev.name}" only?\n\nThey'll get full admin controls (check-in, close event, generate rounds, etc.) inside this one event — no community-wide admin access.`))act.toggleEventAdmin(u.id);}} color={uIsEventAdmin?"#94A3B8":"#A78BFA"} style={{width:"100%"}}/>}
                  {effEv.status!=="completed"&&effEv.plan&&((isCT&&ctR1Locked)||(isCI&&ciR1Locked))&&<SmBtn label={isRetired?"↩ Un-retire":"🚑 Retire"} onClick={()=>{setOpenPlayerMenu(null);if(isRetired||window.confirm(isCT?`Mark ${u.nickname}'s whole team as retired from "${ev.name}"?\n\nClosed Teams is fixed doubles, so retiring one player retires their teammate(s) too — the team stops being scheduled in future matches (past results stay as-is). Finance exemption is auto-set based on whether they're retiring before or after the event's midpoint — you can always override it yourself in the Finance tab.`:`Mark ${u.nickname} as retired from "${ev.name}"?\n\nThey'll stop being scheduled in future rounds/matches (past results stay as-is). Their finance exemption is auto-set based on whether they're retiring before or after the event's midpoint — you can always override it yourself in the Finance tab.`))act.retirePlayer(u.id);}} color={isRetired?"#34D399":"#F59E0B"} style={{width:"100%"}}/>}
                  {(!effEv.plan||(isCT&&!ctR1Locked)||(isCI&&!ciR1Locked)||!wasEverInPlan)&&<SmBtn label="✕ Remove" onClick={()=>{setOpenPlayerMenu(null);if(window.confirm(wasEverInPlan?`Remove ${u.nickname} from this event?`:`Remove ${u.nickname} from this event?\n\nThey're registered but were never actually included in any round or match — this just cleans up the registration, no real match data is affected.`))act.removeFromEvent(u.id);}} color="#EF4444" style={{width:"100%"}}/>}
                </div>}
              </div>}
            </div>
          </div>
        </Card>;
      })}
      {capWaitlistedRegs.length>0&&<>
        <ST>⏳ Waitlist ({capWaitlistedRegs.length}) — event full</ST>
        {capWaitlistedRegs.map((r,wi)=>{
          const u=users.find(u=>u.id===r.userId); if(!u) return null;
          const wMStatus=comm.members?.find(m=>m.userId===u.id)?.status;
          return <Card key={r.userId} style={{marginBottom:8,borderColor:"#F59E0B66",background:"#F59E0B08",cursor:onViewProfile?"pointer":"default"}}>
            <div onClick={()=>onViewProfile&&onViewProfile(u.id)} style={{display:"flex",alignItems:"center",gap:10}}>
              <Av u={u} size={34}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)",display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span>{u.nickname}{effEv.sport!=="Football"&&<span style={{fontWeight:400,color:"var(--po-dim)"}}> ({historicUsr(u.id,effEv.plan,u.usr)})</span>}</span>
                  {wMStatus&&sBdg(wMStatus)}
                  {u.isGuest&&<span style={{fontSize:10,color:"#F59E0B"}}>GUEST{isAdmin&&u.phone?` · ${u.phone}`:""}</span>}
                  {suspendedIds.has(u.id)&&<span style={{fontSize:10,color:"#F59E0B",fontWeight:700}}>🚫 SUSPENDED</span>}
                </div>
                <div style={{fontSize:11,color:"#F59E0B"}}>{suspendedIds.has(u.id)?"Subscription expired — moved to waitlist until renewed":`#${wi+1} on the waitlist — joins automatically if a spot opens`}</div>
              </div>
              {isAdmin&&<SmBtn label="✕" onClick={(e)=>{e.stopPropagation();if(window.confirm(`Remove ${u.nickname} from the waitlist?`))act.removeFromEvent(u.id);}} color="#EF4444" style={{padding:"4px 8px",fontSize:11}}/>}
            </div>
          </Card>;
        })}
      </>}
      </>;})()}
    </>}

    {/* MANAGE */}
    {tab==="manage"&&!isAdmin&&(comm?.bookkeeping?.enabled
      ? <Card><div style={{fontSize:12,color:"var(--po-dim)"}}>💰 {comm.name} tracks finances centrally — check the Ledger tab in the community for your balance and statement.</div></Card>
      : <>
      <ST>💰 Financial</ST>
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
          <div style={{fontSize:13,color:"var(--po-dim)"}}>Total event cost</div>
          <div style={{fontSize:14,fontWeight:700,color:"var(--po-text)"}}>{totC} EGP</div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0"}}>
          <div style={{fontSize:13,color:"var(--po-dim)"}}>Per player <span style={{fontSize:10}}>({payingCnt} paying{exemptedIds.size>0?`, ${exemptedIds.size} exempt`:""})</span></div>
          <div style={{fontSize:16,fontWeight:700,color:"#34D399"}}>{cpp} EGP</div>
        </div>
      </Card>
      {attendeeIds.includes(me.id)&&(()=>{
        const isPayer = me.id===payerId;
        const isEx = exemptedIds.has(me.id);
        const isPaid = isPayer || paidIds.has(me.id);
        const payer = users.find(u=>u.id===payerId);
        return <Card style={{marginTop:8}}>
          <div style={{fontSize:12,fontWeight:600,color:"var(--po-dim)",marginBottom:8}}>Your share</div>
          <div style={{fontSize:13,color:"var(--po-text)",marginBottom:isPayer||isEx?0:10}}>{isEx?"You're exempt from payment.":isPayer?"You're collecting from everyone else.":<>You owe {cpp} EGP{payer&&<> to <span onClick={()=>onViewProfile&&onViewProfile(payer.id)} style={{color:onViewProfile?"#6366F1":"inherit",cursor:onViewProfile?"pointer":"default"}}>{payer.nickname}</span></>}.</>}</div>
          {!isPayer&&!isEx&&<div onClick={()=>act.togglePaid(me.id)} style={{textAlign:"center",padding:"9px",borderRadius:8,background:isPaid?"#34D39922":"#6366F1",border:`0.5px solid ${isPaid?"#34D39966":"transparent"}`,color:isPaid?"#34D399":"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>{isPaid?"✓ Marked as Paid":"I Paid"}</div>}
        </Card>;
      })()}
    </>)}

    {tab==="manage"&&isAdmin&&<>
      {/* A community with the ledger switched on absorbs most event costs centrally (via
          monthly dues, tracked in the community's Ledger tab), so this per-event cost-split
          tool is de-emphasized — collapsed by default — rather than gone entirely, since an
          admin may still want to split a one-off cost that isn't going through the fund. */}
      <CollapsibleSection label="🧮 Split This Event's Cost" defaultOpen={!comm?.bookkeeping?.enabled}>
      {isOpen&&activeRegCount<tc*4&&<Card style={{background:"#EF444411",border:"0.5px solid #EF444444",marginBottom:10}}><div style={{fontSize:13,fontWeight:600,color:"#EF4444",marginBottom:4}}>⚠️ Insufficient Players</div><div className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>Need {tc*4} players. Currently {activeRegCount}.</div></Card>}
      {!isOpen&&<Card style={{background:"#6366F111",border:"0.5px solid #6366F144",marginBottom:10}}><div style={{fontSize:11,color:"var(--po-sub)"}}>ℹ️ {isCI?"Closed Individuals":"Closed Teams"} events have no check-in step — cost is split across all {attCnt} registered players (attendance is assumed).</div></Card>}
      {sim&&attCnt>0&&<Card style={{background:"#6366F111",border:"0.5px solid #6366F144",marginBottom:10}}><div style={{fontSize:13,fontWeight:600,color:"#A5B4FC",marginBottom:10}}>💰 Live Cost Settlement</div>{[["Total",`${totC} EGP`],[isOpen?"Checked In":"Registered",attCnt],["Paying",payingCnt],["Per Player",`${cpp} EGP`]].map(([k,val])=><div key={k} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"0.5px solid #6366F122"}}><span style={{fontSize:13,color:"var(--po-dim)"}}>{k}</span><span style={{fontSize:14,fontWeight:700,color:k==="Per Player"?"#A5B4FC":"var(--po-text)"}}>{val}</span></div>)}</Card>}
      <Card>
        {/* Cost breakdown */}
        {[
          ["Courts", `${tc} × ${durationHrs}h × ${effEv.costPerCourt||0} EGP/hr`, `${Math.round(courtTotal)} EGP`],
          ["Extra Fee", `${tc} × ${durationHrs}h × ${effEv.extraFee||0} EGP/hr`, `${Math.round(extraFeeTotal)} EGP`],
          ["Additional Amount", "flat, if any", `${extraExp} EGP`],
        ].map(([k,sub,val])=><div key={k} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
          <div><div style={{fontSize:13,color:"var(--po-text)",fontWeight:500}}>{k}</div><div style={{fontSize:10,color:"var(--po-dim)"}}>{sub}</div></div>
          <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{val}</div>
        </div>)}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
          <div style={{fontSize:14,fontWeight:700,color:"var(--po-text)"}}>Total</div>
          <div style={{fontSize:18,fontWeight:700,color:"#6366F1"}}>{totC} EGP</div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0"}}>
          <div style={{fontSize:13,color:"var(--po-dim)"}}>Per player <span style={{fontSize:10}}>({payingCnt} paying{exemptedIds.size>0?`, ${exemptedIds.size} exempt`:""})</span></div>
          <div style={{fontSize:16,fontWeight:700,color:"#34D399"}}>{cpp} EGP</div>
        </div>
      </Card>

      {/* Edit costs — admin only */}
      {isAdmin&&<Card style={{marginBottom:8}}>
        <div style={{fontSize:12,fontWeight:600,color:"var(--po-dim)",marginBottom:10}}>Edit Costs</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div>
            <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:3}}>Court cost/hr (EGP)</div>
            <input type="number" defaultValue={effEv.costPerCourt||0} className="po-inp"
              style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}
              onBlur={e=>act.updateFinance({costPerCourt:parseFloat(e.target.value)||0})}
              onKeyDown={e=>e.key==="Enter"&&e.target.blur()}/>
          </div>
          <div>
            <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:3}}>Extra fee/court/hr (EGP)</div>
            <input type="number" defaultValue={effEv.extraFee||0} className="po-inp"
              style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}
              onBlur={e=>act.updateFinance({extraFee:parseFloat(e.target.value)||0})}
              onKeyDown={e=>e.key==="Enter"&&e.target.blur()}/>
          </div>
        </div>
        <div>
          <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:3}}>Additional amount (EGP) — flat, if there's anything else on top</div>
          <input type="number" defaultValue={effEv.extraExpenses||0} className="po-inp"
            style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}
            onBlur={e=>act.updateFinance({extraExpenses:parseFloat(e.target.value)||0})}
            onKeyDown={e=>e.key==="Enter"&&e.target.blur()}/>
        </div>
      </Card>}

      {/* Settlement — who's collecting, who's exempt, and who has paid them (one list) */}
      {isAdmin&&attCnt>0&&<>
        <ST>💵 Settlement</ST>
        <Card style={{marginBottom:8}}>
          <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:6}}>Who's collecting the {totC} EGP from everyone?</div>
          <select value={payerId??""} onChange={e=>act.updateFinance({settlementPayerId:parseInt(e.target.value)})} className="po-inp"
            style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13,marginBottom:10}}>
            {attendeeIds.map(uid=>{const u=users.find(u=>u.id===uid);if(!u)return null;return <option key={uid} value={uid}>{u.nickname}{uid===effEv.createdBy?" (organizer)":""}</option>;})}
          </select>
          <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderTop:"0.5px solid var(--po-bdr)"}}>
            <span style={{fontSize:12,color:"var(--po-dim)"}}>Collected so far</span>
            <span style={{fontSize:13,fontWeight:700,color:"#34D399"}}>{paidCnt}/{owingCnt} paid · {collectedSoFar}/{totC} EGP</span>
          </div>
          {/* Collector's own InstaPay (set on their profile) — shown here so the admin can see
              at a glance whether players even have a way to pay this person from the app. The
              player-facing "pay the collector" card below is what actually surfaces it to them. */}
          {(()=>{const payerU=users.find(u=>u.id===payerId);return payerU?.instapayLink&&<div style={{paddingTop:8,borderTop:"0.5px solid var(--po-bdr)"}}><SmBtn label={`💳 ${payerU.nickname}'s InstaPay`} onClick={()=>window.open(payerU.instapayLink,"_blank")} color="#6366F1" style={{width:"100%",textAlign:"center",justifyContent:"center",display:"flex"}}/></div>;})()}
          {/* Venue InstaPay — for whoever's actually settling the court fees with the venue
              (usually the collector), not each player individually. */}
          {venue?.instapayLink&&<div style={{paddingTop:8}}><SmBtn label={`🏟 Pay ${venue.name} via InstaPay`} onClick={()=>window.open(venue.instapayLink,"_blank")} color="#94A3B8" style={{width:"100%",textAlign:"center",justifyContent:"center",display:"flex"}}/></div>}
        </Card>
        <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8}}>Tap "Exempt" for anyone who shouldn't pay — everyone else gets marked "Paid" once they settle up with the collector.</div>
        {attendeeIds.map(uid=>{
          const u=users.find(u=>u.id===uid); if(!u) return null;
          const isPayer = uid===payerId;
          const isEx = exemptedIds.has(uid);
          const isPaid = isPayer || paidIds.has(uid);
          return <Card key={uid} style={{marginBottom:6,background:isEx?"#F59E0B0D":isPaid?"#34D39911":"var(--po-card)",borderColor:isEx?"#F59E0B33":isPaid?"#34D39944":"var(--po-bdr)"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <Av u={u} size={32}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span onClick={()=>onViewProfile&&onViewProfile(u.id)} style={{fontSize:13,fontWeight:600,color:"var(--po-text)",cursor:onViewProfile?"pointer":"default"}}>{u.nickname}</span>
                  {isPayer&&<Bdg label="💰 Collector" color="#F59E0B"/>}
                </div>
                <div style={{fontSize:11,color:"var(--po-dim)"}}>{isEx?"Exempt from payment":isPayer?"Collects from the rest":`${cpp} EGP`}</div>
              </div>
              <div style={{display:"flex",gap:6,flexShrink:0}}>
                <div onClick={()=>act.toggleExempt(uid)} style={{padding:"6px 10px",borderRadius:8,background:isEx?"#F59E0B22":"var(--po-inp)",border:`0.5px solid ${isEx?"#F59E0B66":"var(--po-bdr)"}`,fontSize:12,fontWeight:600,color:isEx?"#F59E0B":"var(--po-dim)",cursor:"pointer"}}>
                  {isEx?"✓ Exempt":"Exempt"}
                </div>
                {!isPayer&&!isEx&&<div onClick={()=>act.togglePaid(uid)} style={{padding:"6px 10px",borderRadius:8,background:isPaid?"#34D39922":"var(--po-inp)",border:`0.5px solid ${isPaid?"#34D39966":"var(--po-bdr)"}`,fontSize:12,fontWeight:600,color:isPaid?"#34D399":"var(--po-dim)",cursor:"pointer"}}>
                  {isPaid?"✓ Paid":"Not Paid"}
                </div>}
              </div>
            </div>
          </Card>;
        })}
      </>}
      </CollapsibleSection>
      {comm?.bookkeeping?.enabled&&<>
        <ST>💰 Community Ledger</ST>
        {!showLedgerForm
          ? <SmBtn label="+ Record income/expense to community fund" onClick={()=>{setShowLedgerForm(true);setLedgerType("expense");setLedgerDesc("");setLedgerAmount("");setLedgerCategory("");}} color="#6366F1" style={{width:"100%",textAlign:"center",justifyContent:"center",display:"flex"}}/>
          : <Card>
              <div style={{display:"flex",gap:6,marginBottom:10}}>
                <SmBtn label="Expense" onClick={()=>setLedgerType("expense")} active={ledgerType==="expense"} color="#EF4444" style={{flex:1,textAlign:"center",justifyContent:"center",display:"flex"}}/>
                <SmBtn label="Income" onClick={()=>setLedgerType("income_misc")} active={ledgerType==="income_misc"} color="#34D399" style={{flex:1,textAlign:"center",justifyContent:"center",display:"flex"}}/>
              </div>
              <Inp label="Description" value={ledgerDesc} onChange={setLedgerDesc} placeholder={ledgerType==="expense"?"e.g. Extra court time":"e.g. Sponsor contribution"}/>
              <Inp label="Amount (EGP)" value={ledgerAmount} onChange={setLedgerAmount} type="number"/>
              {ledgerType==="expense"&&<Drp label="Category" value={ledgerCategory} onChange={setLedgerCategory} options={(expenseCategories||[]).map(c=>({v:c,l:c}))}/>}
              <div style={{display:"flex",gap:6}}>
                <Btn label="Add" primary onClick={()=>{
                  const amt=parseFloat(ledgerAmount);
                  if(!ledgerDesc||!(amt>0))return;
                  onAddLedgerEntry&&onAddLedgerEntry({type:ledgerType,amount:amt,description:ledgerDesc,...(ledgerType==="expense"?{category:ledgerCategory||"Misc"}:{}),eventId:ev.id,eventName:ev.name});
                  setShowLedgerForm(false);setLedgerDesc("");setLedgerAmount("");setLedgerCategory("");
                }} style={{flex:1}}/>
                <SmBtn label="Cancel" onClick={()=>setShowLedgerForm(false)} color="#94A3B8" style={{flex:1}}/>
              </div>
            </Card>}
        <div style={{fontSize:10,color:"var(--po-dim)",marginTop:6}}>Recorded against this event, into the community's central fund (visible in the community's Ledger tab).</div>
      </>}
    </>}

    {/* PHOTOS */}
    {tab==="photos"&&<Card>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
        {(ev.photos||[]).map(p=>{
          const uploader=users.find(u=>u.id===p.uploadedBy);
          // Bug #14: the uploader can pull their own photo back for 5 minutes after posting
          // it (undo an accidental upload) — after that window, only an admin can remove it.
          const uploadedRecently=p.uploadedBy===me.id&&(Date.now()-new Date(p.uploadedAt).getTime())<5*60*1000;
          const canRemove=isAdmin||uploadedRecently;
          return <div key={p.id} style={{position:"relative",aspectRatio:"1",borderRadius:8,overflow:"hidden",background:"var(--po-inp)"}}>
            <img src={p.url} alt="" onClick={()=>window.open(p.url,"_blank")} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}}/>
            {canRemove&&<div onClick={()=>{if(window.confirm(`Remove this photo${uploader?` (uploaded by ${uploader.nickname})`:""}?`))onRemoveEventPhoto(p.id);}} style={{position:"absolute",top:3,right:3,width:20,height:20,borderRadius:"50%",background:"#00000099",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,cursor:"pointer"}}>🗑</div>}
          </div>;
        })}
        <label style={{aspectRatio:"1",borderRadius:8,border:"1.5px dashed var(--po-bdr)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:photoUploading2?"default":"pointer",gap:2}}>
          <input type="file" accept="image/*" multiple style={{display:"none"}} onChange={handleEventPhotoSelect} disabled={photoUploading2}/>
          <span style={{fontSize:18}}>{photoUploading2?"⏳":"➕"}</span>
          <span style={{fontSize:9,color:"var(--po-dim)",textAlign:"center"}}>{photoUploadProgress?`${photoUploadProgress.done}/${photoUploadProgress.total}`:"Add"}</span>
        </label>
      </div>
      {photoUploadError&&<div style={{marginTop:10,fontSize:11,color:"#EF4444",background:"#EF444411",borderRadius:6,padding:"8px 10px"}}>⚠️ {photoUploadError}</div>}
    </Card>}

    {/* ANNOUNCEMENTS — own tab, matching how Community does it (not a collapsible section) */}
    {tab==="ann"&&<>
      {isAdmin&&<Card style={{marginBottom:8}}>
        <Inp label="Post to everyone registered" value={eventAnnouncementText} onChange={setEventAnnouncementText} placeholder="e.g. Court moved to Court 2, bring extra balls..." multiline/>
        <Btn label="📢 Post" primary onClick={()=>{if(eventAnnouncementText.trim()){onPostEventAnnouncement&&onPostEventAnnouncement(eventAnnouncementText);setEventAnnouncementText("");}}} style={{width:"100%"}}/>
      </Card>}
      {(effEv.announcements?.length||0)===0
        ? <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"14px 0"}}>No announcements yet.</div></Card>
        : [...effEv.announcements].reverse().map(a=>
            <Card key={a.id} style={{marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,color:"var(--po-text)",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{a.message}</div>
                  <div style={{fontSize:10,color:"var(--po-dim)",marginTop:6}}>{a.authorName} · {timeAgo(a.createdAt)}</div>
                </div>
                {isAdmin&&<SmBtn label="✕" onClick={()=>{if(window.confirm("Remove this announcement?"))onDeleteEventAnnouncement&&onDeleteEventAnnouncement(a.id);}} color="#EF4444" style={{padding:"4px 8px",fontSize:11,flexShrink:0}}/>}
              </div>
              {(a.replies?.length||0)>0&&<div style={{marginTop:10,paddingTop:8,borderTop:"0.5px solid var(--po-bdr)",display:"flex",flexDirection:"column",gap:8}}>
                {a.replies.map(r=>
                  <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:6,paddingLeft:10}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,color:"var(--po-text)",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{r.message}</div>
                      <div style={{fontSize:9,color:"var(--po-dim)",marginTop:3}}>{r.authorName} · {timeAgo(r.createdAt)}</div>
                    </div>
                    {isAdmin&&<SmBtn label="✕" onClick={()=>{if(window.confirm("Remove this reply?"))onDeleteEventAnnouncementReply&&onDeleteEventAnnouncementReply(a.id,r.id);}} color="#EF4444" style={{padding:"3px 6px",fontSize:10,flexShrink:0}}/>}
                  </div>
                )}
              </div>}
              <div style={{marginTop:8,paddingTop:8,borderTop:(a.replies?.length||0)>0?"none":"0.5px solid var(--po-bdr)"}}>
                {eventReplyingTo===a.id
                  ? <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <input autoFocus value={eventReplyText} onChange={e=>setEventReplyText(e.target.value)} placeholder="Reply..." className="po-inp" style={{flex:1,padding:"6px 8px",borderRadius:6,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",fontSize:12}} onKeyDown={e=>{if(e.key==="Enter"&&eventReplyText.trim()){onReplyEventAnnouncement&&onReplyEventAnnouncement(a.id,eventReplyText);setEventReplyText("");setEventReplyingTo(null);}}}/>
                      <SmBtn label="Send" onClick={()=>{if(eventReplyText.trim()){onReplyEventAnnouncement&&onReplyEventAnnouncement(a.id,eventReplyText);setEventReplyText("");setEventReplyingTo(null);}}} color="#6366F1"/>
                      <SmBtn label="✕" onClick={()=>{setEventReplyingTo(null);setEventReplyText("");}} color="#94A3B8"/>
                    </div>
                  : <div onClick={()=>{setEventReplyingTo(a.id);setEventReplyText("");}} style={{fontSize:11,color:"#6366F1",cursor:"pointer"}}>💬 Reply</div>}
              </div>
            </Card>
          )}
    </>}

    {/* CI BREAKS */}
    {tab==="breaks"&&isCI&&plan&&<BreaksTab plan={plan} ev={effEv} users={users} bp={bp} tc={tc} onEditBreak={act.editBreak} onRegenerate={act.regenerateBreaks} isAdmin={isAdmin} onViewProfile={onViewProfile}/>}

    {/* CI ROUNDS */}
    {tab==="rounds"&&isCI&&<>
      {isAdmin&&!plan&&<Card>
        <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Generate Round 1</div>
        <div style={{fontSize:13,color:"var(--po-sub)",marginBottom:12}}>{activeRegCount} players · {tc} courts · {Math.max(0,activeRegCount-tc*4)} on break/round</div>
        <div style={{background:"var(--po-inp)",borderRadius:8,padding:"10px 12px",marginBottom:12}}><div style={{fontSize:11,color:"var(--po-dim)",marginBottom:6}}>Scoring:</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{Array.from({length:tc},(_,i)=><Bdg key={i} label={`Court ${i+1} = ${courtPts(i+1,tc)} pts`} color="#38BDF8"/>)}<Bdg label={`Break = ${bp} pts`} color="#F59E0B"/></div></div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><span style={{fontSize:12,color:"var(--po-dim)"}}>Round duration:</span>{[10,15,20,25,30].map(n=><SmBtn key={n} label={`${n}m`} onClick={()=>setRDur(n)} active={roundDur===n} color="#6366F1"/>)}</div>
        <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:16}}>💡 {totalR} rounds fit this event's booking window automatically ({roundDur}m each)</div>
        {activeRegCount<tc*4?<div style={{padding:"10px",background:"#EF444411",border:"0.5px solid #EF444444",borderRadius:8,fontSize:12,color:"#EF4444"}}>⚠️ Need at least {tc*4} players.</div>:<Btn label="🎯 Generate Round 1" primary onClick={()=>act.startCI(totalR,roundDur)} style={{width:"100%"}}/>}
      </Card>}
      {plan&&<>
        <div style={{padding:"8px 12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:8,fontSize:12,color:"#34D399",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span>✓ {plan.sorted?.length||0} players · {plan.totalRounds} rounds · {tc} courts</span>
          {isAdmin&&(!ciR1Locked?<SmBtn label="🔄 Regenerate" onClick={()=>{if(window.confirm("Discard current pairings and start over?\n\nRound 1 will be rebuilt from the current registered players. This cannot be undone."))act.startCI(plan.totalRounds,plan.roundDuration);}} color="#F59E0B"/>:<span style={{fontSize:10,color:"var(--po-dim)"}}>🔒 R1 locked</span>)}
        </div>
        {/* Next round button ON TOP */}
        {isAdmin&&canNext&&!isCompleted&&<Btn label={`▶ Generate Round ${plan.rounds.length+1} of ${plan.totalRounds}`} primary onClick={act.nextRound} style={{width:"100%",marginBottom:12}}/>}
        {plan.rounds.length>=plan.totalRounds&&plan.rounds.every(r=>r.matches.every(m=>m.winner!=null))&&<div style={{textAlign:"center",padding:"14px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:10,fontSize:14,fontWeight:600,color:"#34D399",marginBottom:12}}>🏆 Complete — check Standings!</div>}

        {/* Swap hint */}
        <div style={{fontSize:12,padding:"9px 12px",borderRadius:8,marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,background:sel?"#FBBF2411":"var(--po-bdr)",border:`0.5px solid ${sel?"#FBBF2444":"#334155"}`}}>
          <span style={{color:sel?"#FBBF24":"var(--po-dim)"}}>{isCompleted?"🔒 Event completed — results locked":sel?`✋ ${users.find(u=>u.id===sel.uid)?.nickname} — tap another in Round ${sel.ri+1} to swap · badges show partner history with them`:isAdmin?"💡 Tap player to select · tap another in same round to swap":"Live matches, breaks, and results for this event"}</span>
          {sel&&!isCompleted&&<SmBtn label="✕" onClick={()=>setSel(null)} color="#EF4444"/>}
        </div>

        {/* Rounds — newest first */}
        {[...plan.rounds].reverse().map((round,revIdx)=>{
          const ri=plan.rounds.length-1-revIdx;
          const isLatest=revIdx===0;
          const isRoundComplete=round.matches.every(m=>m.winner!=null);
          const manuallySet=collapsedRounds.has(ri);
          const toggle=()=>setCollapsedRounds(s=>{const n=new Set(s);n.has(ri)?n.delete(ri):n.add(ri);return n;});
          const defaultCollapsed = isRoundComplete && !isLatest;
          const effCollapsed = manuallySet ? !defaultCollapsed : defaultCollapsed;
          return <div key={ri} style={{marginBottom:24,opacity:isLatest?1:0.75}}>
            <div onClick={isRoundComplete?toggle:undefined} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,cursor:isRoundComplete?"pointer":"default"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                {isRoundComplete&&<span style={{fontSize:11,color:"var(--po-dim)",transform:effCollapsed?"rotate(-90deg)":"none",display:"inline-block",transition:"transform 0.15s"}}>▾</span>}
                <span style={{fontSize:15,fontWeight:700,color:isLatest?"var(--po-text)":"var(--po-dim)"}}>Round {round.round}</span>
                <Bdg label={`${plan.roundDuration||roundDur} min`} color="var(--po-dim)"/>
              </div>
              {isRoundComplete&&<Bdg label="✓ Complete" color="#34D399"/>}
            </div>
            {effCollapsed?null:<>
            {isLatest&&<MatchTimerWidget plan={plan} roundDuration={plan.roundDuration||roundDur} totalRounds={plan.totalRounds} totalBookingMin={durationHrs*60} eventDate={effEv.date} eventTime={effEv.time} eventId={effEv.id} sim={sim} onStart={act.setMatchModeStart} onStop={onStopMatchMode} isCompleted={isCompleted}/>}
            {round.onBreak.length>0&&<div style={{background:"var(--po-inp)",border:"0.5px solid #F59E0B33",borderRadius:10,padding:"10px 12px",marginBottom:10}}><div style={{fontSize:11,color:"#F59E0B",fontWeight:600,marginBottom:8}}>🪑 On Break — {bp} pts each</div><div style={{display:"flex",flexWrap:"wrap",gap:4}}>{round.onBreak.map(p=><PChip key={p.userId} p={p} ri={ri}/>)}</div></div>}
            {round.matches.map((m,mi)=>{
              const avgA=m.teamA.reduce((s,p)=>s+p.usr,0)/m.teamA.length, avgB=m.teamB.reduce((s,p)=>s+p.usr,0)/m.teamB.length;
              const gap=Math.abs(avgA-avgB);
              const h2h=calcExactHeadToHead(comms||[], m.teamA.map(p=>p.userId), m.teamB.map(p=>p.userId), {excludeEventId:effEv.id, beforeRound:ri});
              return <Card key={mi} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <span style={{fontSize:12,fontWeight:700,color:"var(--po-dim)",textTransform:"uppercase",letterSpacing:0.5}}>Court {m.court}</span>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  {h2h.meetings===0&&avgA!==avgB&&<span title={`USR gap: ${gap.toFixed(1)} (Team A avg ${avgA.toFixed(0)} vs Team B avg ${avgB.toFixed(0)}) — no head-to-head history yet`} style={{fontSize:10,fontWeight:700,color:gap<=5?"#34D399":gap<=10?"#F59E0B":"#EF4444"}}>⚖️ Team {avgA>avgB?"A":"B"} +{Math.round((gap/((avgA+avgB)/2))*100)}%</span>}
                  {isAdmin&&!m.winner&&<SmBtn label="🔀 Re-pair" onClick={()=>act.rebalanceCourt(ri,mi)} color="#38BDF8"/>}
                  <Bdg label={`Win = ${courtPts(m.court,tc)} pts`} color="#38BDF8"/>
                </div>
              </div>
              {h2h.meetings>0&&<div style={{textAlign:"center",marginBottom:10,fontSize:13,fontWeight:700,padding:"6px 8px",borderRadius:8,background:"var(--po-inp)"}}>
                <span style={{color:"#A5B4FC"}}>{Math.round(h2h.sideAWinRate*100)}%</span> <span style={{fontSize:11}}>📊</span> <span style={{color:"#67E8F9"}}>{Math.round(h2h.sideBWinRate*100)}%</span> <span style={{fontWeight:400,fontSize:11,color:"var(--po-dim)"}}>({h2h.meetings} n.)</span>
              </div>}
              <div style={{display:"grid",gridTemplateColumns:"1fr 30px 1fr",gap:8,alignItems:"start"}}>
                <div style={{background:m.winner==="A"?"#34D39911":"var(--po-inp)",border:`0.5px solid ${m.winner==="A"?"#34D39944":"var(--po-bdr)"}`,borderRadius:10,padding:"8px"}}>
                  <div style={{fontSize:10,color:"var(--po-dim)",marginBottom:6,fontWeight:600,textAlign:"center"}}>TEAM A <span style={{color:"var(--po-dim)"}}>({Math.round(m.teamA.reduce((s,p)=>s+p.usr,0)/m.teamA.length)})</span></div>
                  {ctComboLabel(m.teamA)&&<div style={{fontSize:9,fontWeight:700,color:"#F59E0B",textAlign:"center",marginTop:-3,marginBottom:5}}>🏷 {ctComboLabel(m.teamA)}</div>}
                  {m.teamA.map(p=><PChip key={p.userId} p={p} ri={ri} matchBadge={personalMatchBadge(comms||[],p.userId,m.teamA.map(x=>x.userId),m.teamB.map(x=>x.userId))}/>)}
                </div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",paddingTop:24}}><span style={{fontSize:10,color:"#334155",fontWeight:700}}>VS</span></div>
                <div style={{background:m.winner==="B"?"#34D39911":"var(--po-inp)",border:`0.5px solid ${m.winner==="B"?"#34D39944":"var(--po-bdr)"}`,borderRadius:10,padding:"8px"}}>
                  <div style={{fontSize:10,color:"var(--po-dim)",marginBottom:6,fontWeight:600,textAlign:"center"}}>TEAM B <span style={{color:"var(--po-dim)"}}>({Math.round(m.teamB.reduce((s,p)=>s+p.usr,0)/m.teamB.length)})</span></div>
                  {ctComboLabel(m.teamB)&&<div style={{fontSize:9,fontWeight:700,color:"#F59E0B",textAlign:"center",marginTop:-3,marginBottom:5}}>🏷 {ctComboLabel(m.teamB)}</div>}
                  {m.teamB.map(p=><PChip key={p.userId} p={p} ri={ri} matchBadge={personalMatchBadge(comms||[],p.userId,m.teamB.map(x=>x.userId),m.teamA.map(x=>x.userId))}/>)}
                </div>
              </div>
              <WinCI m={m} ri={ri} mi={mi}/>
            </Card>;})}
            </>}
          </div>;
        })}
      </>}
    </>}

    {/* CI STANDINGS */}
    {tab==="standings"&&isCI&&<>
      {isCompleted&&ciStands.length>0&&<Podium top3={ciStands.slice(0,3).map(s=>{const before=plan?.sorted?.find(p=>p.userId===s.user.id)?.usr??s.user.usr;const delta=Math.round(s.user.usr-before);return{name:s.user.nickname,avatarUser:s.user,value:s.pts,valueLabel:"pts",usrLine:`USR ${before}${delta!==0?` (${delta>0?"+":""}${delta})`:""}`};})}/>}
      {plan&&<StandingsViewToggle view={standingsView} onChange={setStandingsView}/>}

      {standingsView==="pes"&&<>
        <div style={{marginBottom:10,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:12,color:"var(--po-dim)"}}>{Array.from({length:tc},(_,i)=>`Court ${i+1}=${courtPts(i+1,tc)}pts`).join(" · ")} · Break={bp}pts</div>
        {ciStands.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>Record winners to see standings.</div></Card>:<>
          {ciStands.map((s,i)=>{const mp=plan?personalMaxCI(s.breaks,personalRoundsCI(s.user.id,plan),tc):0,pes=mp>0?Math.round((s.pts/mp)*100*10)/10:0;return <Card key={s.user.id} style={{cursor:onViewProfile?"pointer":"default"}}><div onClick={()=>onViewProfile&&onViewProfile(s.user.id)} style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,background:i<3?"#6366F133":"var(--po-bdr)",color:i===0?"#FBBF24":i===1?"#94A3B8":i===2?"#CD7C2F":"var(--po-dim)"}}>{i+1}</div><Av u={s.user} size={34}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{s.user.nickname} <span style={{fontSize:11,fontWeight:400,color:"var(--po-dim)"}}>({historicUsr(s.user.id,plan,s.user.usr)})</span></div><div style={{fontSize:11,color:"var(--po-dim)"}}>{s.wins} wins · {s.breaks} breaks · {s.played} played · max {mp}pts</div></div><div style={{textAlign:"right",marginRight:8}}><div style={{fontSize:14,fontWeight:700,color:"#A5B4FC"}}>{pes}%</div><div style={{fontSize:9,color:"var(--po-dim)"}}>PES</div></div><div style={{textAlign:"right"}}><div style={{fontSize:22,fontWeight:700,color:"#6366F1"}}>{s.pts}</div><div style={{fontSize:10,color:"var(--po-dim)"}}>pts</div></div></div></Card>;})}
          {plan&&<SmBtn label={showResultsTable?"▲ Hide Results Table":"▼ Show Results Table"} onClick={()=>setShowResultsTable(o=>!o)} color="#6366F1" style={{width:"100%",marginTop:6,marginBottom:showResultsTable?10:0,textAlign:"center",justifyContent:"center",display:"flex"}}/>}
          {showResultsTable&&plan&&<Card style={{padding:8}}><ResultsTable plan={plan} ciStands={ciStands} tc={tc}/></Card>}
        </>}
      </>}

      {standingsView==="delta"&&<>
        <div style={{marginBottom:10,padding:"8px 12px",background:"#A78BFA11",border:"0.5px solid #A78BFA33",borderRadius:8,fontSize:11,color:"var(--po-dim)",lineHeight:1.5}}>🧪 <b>Delta Standings — Performance Delta.</b> How each player did relative to what their current USR predicted — 50% = exactly as expected, above = overperformed, below = underperformed (even on a win). Computed live from current match data, not official, doesn't affect real standings — view only.</div>
        {plan?<XStandingsPreview rows={calcXCIPreview(plan,users,comms,effEv).map(p=>({key:p.userId,name:p.user.nickname,score:p.xPES,matches:p.matches}))}/>:<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>No rounds yet.</div></Card>}
      </>}

      {standingsView==="output"&&<>
        <div style={{marginBottom:10,padding:"8px 12px",background:"#A78BFA11",border:"0.5px solid #A78BFA33",borderRadius:8,fontSize:11,color:"var(--po-dim)",lineHeight:1.5}}>🧪 <b>Output PES — Performance Based.</b> Entry USR adjusted by this event's performance delta — a typical day nudges ~±7 points, a genuinely extreme day (best/worst observed) moves close to ~±40. Same 0–100 scale as real USR, so it's directly comparable — view only. {isPlatformAdmin?`This is what gets written to USR history if this event is closed with "🧪 Close with Output PES" below instead of the standard close.`:"Only the Platform Admin can close an event using this instead of the standard scoring."}</div>
        {plan?<OutputPESTable rows={calcXCIPreview(plan,users,comms,effEv).map(p=>({key:p.userId,name:p.user.nickname,entryUsr:p.entryUsr,avgDelta:p.avgDelta,score:p.outputPES})).sort((a,b)=>b.score-a.score)}/>:<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>No rounds yet.</div></Card>}
      </>}
    </>}

    {/* CT TEAMS */}
    {tab==="teams"&&isCT&&<>
      {isAdmin&&!plan&&<Card>
        <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Form Teams & Start</div>
        <div style={{fontSize:13,color:"var(--po-sub)",marginBottom:12}}>{isFootballEv?`${activeRegCount} players → ${footballPitches} pitch${footballPitches!==1?"es":""} → ${nTeams} teams`:`${activeRegCount} players → ${Math.floor(activeRegCount/6)} pools → ${Math.floor(activeRegCount/2)} teams`}</div>
        {ctCC?.warning&&<div style={{padding:"8px 12px",background:"#F59E0B11",border:"0.5px solid #F59E0B44",borderRadius:8,fontSize:12,color:"#F59E0B",marginBottom:12}}>⚠️ {ctCC.warning}</div>}
        {isFootballEv
          ? <div style={{marginBottom:14,padding:"8px 10px",background:"var(--po-inp)",borderRadius:8,fontSize:11,color:"var(--po-dim)"}}>ℹ️ {footballPitches} pitch{footballPitches!==1?"es":""} · {nTeams} teams (from event setup) — edit the event to change these.</div>
          : <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Courts:</div><div style={{display:"flex",gap:8}}>{[ctCC?.min,ctCC?.max].filter((v,i,a)=>v&&a.indexOf(v)===i).map(n=><button key={n} onClick={()=>setCtC(n)} style={{flex:1,padding:"10px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${selCtC===n?"#6366F1":"var(--po-bdr)"}`,background:selCtC===n?"#6366F122":"var(--po-inp)",color:selCtC===n?"#A5B4FC":"var(--po-sub)",fontSize:13,fontWeight:600}}>{n} {n===ctCC?.min?"(min)":"(max)"}</button>)}</div></div>}
        <div style={{marginBottom:16}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Format:</div>
          {[{k:"league",l:isFootballEv?"League":"League + Promotion/Relegation",d:isFootballEv?"Full round robin · every team plays every other team":"Groups play full round robin · top promoted · bottom relegated",ok:true},
            {k:"ladder",l:"Ladder",d:ladderOK?"Teams climb/descend · break schedule · court points":(isFootballEv?`❌ Invalid: Pitches > 1. Use League instead.`:`❌ Invalid: ${breakTeams} break team(s) > ${selCtC} court(s). Use League instead.`),ok:ladderOK}
          ].map(f=><div key={f.k} onClick={()=>f.ok&&setCtF(f.k)} style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:f.ok?"pointer":"not-allowed",border:`0.5px solid ${ctF===f.k?"#6366F1":f.ok?"var(--po-bdr)":"#EF444433"}`,background:ctF===f.k?"#6366F122":f.ok?"transparent":"#EF444408",opacity:f.ok?1:0.7}}>
            <div style={{fontWeight:600,fontSize:13,color:ctF===f.k?"#A5B4FC":f.ok?"var(--po-text)":"#EF4444",marginBottom:2}}>{f.l}</div>
            <div style={{fontSize:11,color:f.ok?"var(--po-dim)":"#EF4444"}}>{f.d}</div>
          </div>)}
        </div>
        <div style={{marginBottom:16}}>
          <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Match duration:</div>
          <div style={{display:"flex",gap:8}}>{[10,15,20,25,30].map(n=><SmBtn key={n} label={`${n}m`} onClick={()=>setCtDur(n)} active={ctDur===n} color="#6366F1"/>)}</div>
          <div style={{fontSize:11,color:"var(--po-dim)",marginTop:6}}>💡 {Math.max(1,Math.round(durationHrs*60/(ctDur||20)))} match rounds fit this event's booking window automatically ({ctDur}m each)</div>
        </div>
        {!isFootballEv&&(()=>{
          const cur=splitRegsByCapacity(effEv,comm).active.map(r=>{const u=users.find(u=>u.id===r.userId);return u?{...u,usr:teamFormationRating(u,effEv)}:null;}).filter(Boolean);
          const autoPools=segmentPools(cur), alt=altTopPoolSize(cur);
          if(!alt) return null;
          const autoTop=autoPools[0]?.length, autoBottom=autoPools[1]?.length;
          return <div style={{marginBottom:16}}>
            <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Which group should be the top-ranked (elite) group?</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setCtTopPoolSize(null)} style={{flex:1,padding:"10px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${!ctTopPoolSize?"#6366F1":"var(--po-bdr)"}`,background:!ctTopPoolSize?"#6366F122":"var(--po-inp)",color:!ctTopPoolSize?"#A5B4FC":"var(--po-sub)",fontSize:12,fontWeight:600}}>Top {autoTop} <span style={{opacity:0.6}}>(default)</span></button>
              <button onClick={()=>setCtTopPoolSize(alt)} style={{flex:1,padding:"10px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${ctTopPoolSize===alt?"#6366F1":"var(--po-bdr)"}`,background:ctTopPoolSize===alt?"#6366F122":"var(--po-inp)",color:ctTopPoolSize===alt?"#A5B4FC":"var(--po-sub)",fontSize:12,fontWeight:600}}>Top {alt}</button>
            </div>
            <div style={{fontSize:10,color:"var(--po-dim)",marginTop:6}}>{ctTopPoolSize?`Top ${alt} players → smaller elite group of ${alt} · remaining ${autoTop} → the other group`:`Top ${autoTop} players → the bigger group of ${autoTop} · remaining ${autoBottom} → the other group`}. The bigger group gets priority on courts each round.</div>
          </div>;
        })()}
        <Btn label="🎯 Form Teams & Start" primary onClick={()=>act.startCT(selCtC,ctF,ctDur,ctTopPoolSize)} style={{width:"100%"}}/>
      </Card>}
      {plan&&<>
        {!isFootballEv&&isAdmin&&!ctR1Locked&&(()=>{
          const cur=splitRegsByCapacity(effEv,comm).active.map(r=>{const u=users.find(u=>u.id===r.userId);return u?{...u,usr:teamFormationRating(u,effEv)}:null;}).filter(Boolean);
          const autoPools=segmentPools(cur), alt=altTopPoolSize(cur);
          if(!alt) return null;
          const autoTop=autoPools[0]?.length;
          return <Card style={{marginBottom:10}}>
            <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Top-ranked (elite) group size — change and hit Regenerate to apply:</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setCtTopPoolSize(null)} style={{flex:1,padding:"10px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${!ctTopPoolSize?"#6366F1":"var(--po-bdr)"}`,background:!ctTopPoolSize?"#6366F122":"var(--po-inp)",color:!ctTopPoolSize?"#A5B4FC":"var(--po-sub)",fontSize:12,fontWeight:600}}>Top {autoTop} <span style={{opacity:0.6}}>(default)</span></button>
              <button onClick={()=>setCtTopPoolSize(alt)} style={{flex:1,padding:"10px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${ctTopPoolSize===alt?"#6366F1":"var(--po-bdr)"}`,background:ctTopPoolSize===alt?"#6366F122":"var(--po-inp)",color:ctTopPoolSize===alt?"#A5B4FC":"var(--po-sub)",fontSize:12,fontWeight:600}}>Top {alt}</button>
            </div>
          </Card>;
        })()}
        <div style={{padding:"8px 12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:8,fontSize:12,color:"#34D399",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span>✓ {plan.teams?.length||0} teams · {plan.format==="ladder"?"Ladder":"League"} · {plan.courts} {isFootballEv?"pitches":"courts"}</span>
          {isAdmin&&(plan.rounds.length===0||!plan.rounds[0]?.matchesA?.some(m=>m.winner)
            ? (!ctR1Locked?<SmBtn label="🔄 Regenerate" onClick={()=>{if(window.confirm("Discard current team formation and start over?\n\nAll teams and the current Round 1 will be cleared. Registered players stay.\n\nThis cannot be undone."))act.startCT(plan.courts,plan.format,plan.matchDuration,ctTopPoolSize);}} color="#F59E0B"/>:<span style={{fontSize:10,color:"var(--po-dim)"}}>🔒 R1 locked</span>)
            : null)}
        </div>
        {isAdmin&&!ctR1Locked&&<div style={{padding:"8px 12px",background:"#6366F111",border:"0.5px solid #6366F133",borderRadius:8,fontSize:11,color:"var(--po-dim)",marginBottom:12}}>💡 {ctSel?`✋ Selected — tap a player on another team to swap`:`Tap a player, then tap another player on a different team to swap them`}</div>}
        {plan.format==="ladder"?<>
          {/* Ladder: show Pools (how teams were formed) but make clear they don't affect gameplay */}
          {(() => {
            const poolNums = [...new Set((plan.teams||[]).map(t=>t.poolIdx))].sort();
            return poolNums.map(pi => {
              const poolTeams = (plan.teams||[]).filter(t=>t.poolIdx===pi);
              return <React.Fragment key={pi}>
                {poolNums.length>1&&<ST>Pool {pi+1} — {poolTeams.length} teams</ST>}
                {poolTeams.map(t=><CTTeamCard key={t.id} team={t} group={`P${pi+1}`} sport={effEv.sport} showBreakPref={plan.format==="ladder"} isAdmin={isAdmin} onSetTeamBreakPref={act.setTeamBreakPref} canEdit={isAdmin&&!ctR1Locked} selectedUserId={ctSel?.userId} onPlayerTap={handleCTPlayerTap} onRenameTeam={act.renameCTTeam}/>)}
              </React.Fragment>;
            });
          })()}
        </>:<>
          <ST>Group A — {plan.groupA?.length||0} teams</ST>
          {(plan.groupA||[]).map(t=><CTTeamCard key={t.id} team={t} group="A" sport={effEv.sport} showBreakPref={plan.format==="ladder"} isAdmin={isAdmin} onSetTeamBreakPref={act.setTeamBreakPref} canEdit={isAdmin&&!ctR1Locked} selectedUserId={ctSel?.userId} onPlayerTap={handleCTPlayerTap} onRenameTeam={act.renameCTTeam}/>)}
          {plan.groupB?.length>0&&<><ST>Group B — {plan.groupB.length} teams</ST>{plan.groupB.map(t=><CTTeamCard key={t.id} team={t} group="B" sport={effEv.sport} showBreakPref={plan.format==="ladder"} isAdmin={isAdmin} onSetTeamBreakPref={act.setTeamBreakPref} canEdit={isAdmin&&!ctR1Locked} selectedUserId={ctSel?.userId} onPlayerTap={handleCTPlayerTap} onRenameTeam={act.renameCTTeam}/>)}</>}
        </>}
      </>}
    </>}

    {/* CT BREAKS (Ladder only) */}
    {tab==="breaks"&&isCT&&plan&&plan.format==="ladder"&&<CTBreaksTab plan={plan} tc={tc} onRegenBreaks={act.regenCTBreaks} onSwapBreak={act.swapCTBreak} onToggleFirm={act.toggleCTBreakFirm} isAdmin={isAdmin}/>}

    {/* CT MATCHES */}
    {tab==="matches"&&isCT&&plan&&<CTMatchesTab plan={plan} sport={effEv.sport} comms={comms} onSetWinCT={act.setWinCT} onSetCTScorers={act.setCTScorers} onToggleCTLeagueLive={act.toggleCTLeagueLive} onApplyPromo={act.applyPromo} onNextFootballRound={act.nextFootballRound} onNextCTLadder={act.nextCTLadder} onSwapCTLadder={act.swapCTLadder} totalBookingMin={durationHrs*60} eventDate={effEv.date} eventTime={effEv.time} eventId={effEv.id} sim={sim} onSetMatchModeStart={act.setMatchModeStart} onStopMatchMode={onStopMatchMode} isAdmin={isAdmin}/>}

    {/* CT STANDINGS */}
    {tab==="standings"&&isCT&&<>
      {isCompleted&&ctStands.length>0&&<Podium top3={ctStands.slice(0,3).map(s=>{
        const teamPlayers=(s.team?.players||[]).map(p=>users.find(u=>u.id===(p.userId||p.id))||p);
        const before=s.team?.avgUsr??0;
        const after=teamPlayers.length?Math.round(teamPlayers.reduce((sum,p)=>sum+(p.usr||0),0)/teamPlayers.length):before;
        const delta=Math.round(after-before);
        return {name:s.team?.name,players:teamPlayers,value:plan?.format==="ladder"?s.pts:s.wins,valueLabel:plan?.format==="ladder"?"pts":"wins",usrLine:`Avg USR ${before}${delta!==0?` (${delta>0?"+":""}${delta})`:""}`};
      })}/>}
      {plan?.format==="ladder"&&<StandingsViewToggle view={standingsView} onChange={setStandingsView}/>}

      {(standingsView==="pes"||plan?.format!=="ladder")&&<>
      {/* Scoring info bar */}
      <div style={{marginBottom:10,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:12,color:"var(--po-dim)"}}>
        {plan?.format==="ladder"
          ? `Court pts: ${Array.from({length:tc},(_,i)=>`C${i+1}=${ctLadderCourtPts(i+1,tc)}`).join(" · ")} · Break=${ctLadderBreakPts(tc)}`
          : "Cumulative all rounds · Wins → Score Diff · Group A first"}
      </div>

      {ctStands.length===0
        ? <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>Record results to see standings.</div></Card>
        : <>
          {/* Standings list */}
          {ctStands.map((s,i)=>{
            const gc = plan?.format==="ladder"?"#6366F1":(s.group==="A"?"#6366F1":"#06B6D4");
            const maxRoundsPlayed = plan?.rounds?.length||0;
            const maxPts = plan?.format==="ladder" ? ctTeamMaxPts(s.team?.id,plan) : 0;
            const tes = plan?.format==="ladder"&&maxPts>0 ? Math.round((s.pts/maxPts)*100*10)/10 : null;
            return <Card key={s.team?.id||i} style={{marginBottom:6}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,background:i<3?"#6366F133":"var(--po-bdr)",color:i===0?"#FBBF24":i===1?"#94A3B8":i===2?"#CD7C2F":"var(--po-dim)"}}>{s.finalRank}</div>
                <div style={{width:32,height:32,borderRadius:8,background:`${gc}22`,border:`0.5px solid ${gc}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:gc,flexShrink:0}}>{plan?.format!=="ladder"?s.group:""}{s.team?.id}</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{s.team?.name}</div>
                  <div style={{fontSize:11,color:"var(--po-dim)"}}>{s.team?.players?.map(p=>p.nickname).join(" & ")}</div>
                  <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>
                    {plan?.format!=="ladder"
                      ? `${s.wins}W · ${s.losses}L · Diff ${s.scoreDiff>=0?"+":""}${s.scoreDiff}`
                      : `${s.wins}W · ${s.losses}L · ${s.breaks||0} breaks · max ${maxPts}pts`}
                    {tes!==null&&<span style={{marginLeft:8,color:"#6366F1",fontWeight:600}}>TES {tes}%</span>}
                  </div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:18,fontWeight:700,color:gc}}>{plan?.format==="ladder"?s.pts:s.wins}</div>
                  <div style={{fontSize:10,color:"var(--po-dim)"}}>{plan?.format==="ladder"?"pts":"wins"}</div>
                </div>
              </div>
            </Card>;
          })}

          {/* Match Results Table — Ladder only */}
          {plan?.format==="ladder"&&plan?.rounds?.length>0&&<>
            <ST>Match Results</ST>
            <div style={{overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
              <table style={{borderCollapse:"collapse",tableLayout:"fixed",minWidth:Math.max(300,130+plan.rounds.length*50),width:"100%"}}>
                <colgroup>
                  <col style={{width:130}}/>
                  {plan.rounds.map((_,ri)=><col key={ri} style={{width:50}}/>)}
                </colgroup>
                <thead><tr>
                  <th style={{padding:"6px 8px",textAlign:"left",fontSize:10,fontWeight:700,color:"var(--po-dim)",borderBottom:"1px solid var(--po-bdr)",background:"var(--po-card)"}}>TEAM</th>
                  {plan.rounds.map((_,ri)=><th key={ri} style={{padding:"6px 4px",textAlign:"center",fontSize:10,fontWeight:700,color:"var(--po-dim)",borderBottom:"1px solid var(--po-bdr)",background:"var(--po-card)"}}>R{ri+1}</th>)}
                </tr></thead>
                <tbody>
                  {ctStands.map((s,si)=><tr key={s.team?.id} style={{background:si%2===0?"transparent":"var(--po-bdr)22"}}>
                    <td style={{padding:"6px 8px",fontSize:11,fontWeight:600,color:"var(--po-text)",borderBottom:"0.5px solid var(--po-bdr)"}}>
                      <div>{s.team?.name}</div>
                      <div style={{fontSize:9,color:"var(--po-dim)",fontWeight:400}}>{s.team?.players?.map(p=>p.nickname.split(" ")[0]).join(" & ")}</div>
                    </td>
                    {plan.rounds.map((r,ri)=>{
                      const onBreak=(r.onBreak||[]).some(t=>t.id===s.team?.id);
                      if(onBreak) return <td key={ri} style={{textAlign:"center",fontSize:11,color:"#F59E0B",padding:"6px 4px",borderBottom:"0.5px solid var(--po-bdr)"}}>☕<div style={{fontSize:8,color:"var(--po-dim)"}}>{ctLadderBreakPts(tc)}</div></td>;
                      const match=r.matchesA?.find(m=>m.teamA?.id===s.team?.id||m.teamB?.id===s.team?.id);
                      if(!match) return <td key={ri} style={{textAlign:"center",fontSize:10,color:"var(--po-dim)",borderBottom:"0.5px solid var(--po-bdr)"}}>—</td>;
                      const isA=match.teamA?.id===s.team?.id;
                      const won=(isA&&match.winner==="A")||(!isA&&match.winner==="B");
                      const pts=won?ctLadderCourtPts(match.court,tc):0;
                      return <td key={ri} style={{textAlign:"center",padding:"6px 4px",borderBottom:"0.5px solid var(--po-bdr)"}}>
                        <div style={{fontSize:11,fontWeight:won?700:400,color:match.winner?(won?"#34D399":"#EF4444"):"var(--po-dim)"}}>{match.winner?(won?"W":"L"):"·"}</div>
                        <div style={{fontSize:9,color:"var(--po-dim)"}}>C{match.court}{won?` +${pts}`:""}</div>
                      </td>;
                    })}
                  </tr>)}
                </tbody>
              </table>
            </div>
          </>}
        </>}
      </>}

      {standingsView==="delta"&&plan?.format==="ladder"&&<>
        <div style={{marginBottom:10,padding:"8px 12px",background:"#A78BFA11",border:"0.5px solid #A78BFA33",borderRadius:8,fontSize:11,color:"var(--po-dim)",lineHeight:1.5}}>🧪 <b>Delta Standings — Performance Delta.</b> How each team did relative to what their avg USR predicted — 50% = exactly as expected, above = overperformed, below = underperformed (even on a win). Computed live from current match data, not official, doesn't affect real standings — view only.</div>
        <XStandingsPreview rows={calcXCTLadderPreview(plan,users,comms,effEv).map(t=>({key:t.teamId,name:t.team?.name,subtitle:(t.team?.players||[]).map(p=>p.nickname).join(" & "),score:t.xTES,matches:t.matches}))}/>
      </>}

      {standingsView==="output"&&plan?.format==="ladder"&&<>
        <div style={{marginBottom:10,padding:"8px 12px",background:"#A78BFA11",border:"0.5px solid #A78BFA33",borderRadius:8,fontSize:11,color:"var(--po-dim)",lineHeight:1.5}}>🧪 <b>Output PES — Performance Based.</b> Entry USR adjusted by this event's performance delta — a typical day nudges ~±7 points, a genuinely extreme day (best/worst observed) moves close to ~±40. Same 0–100 scale as real USR, so it's directly comparable — view only. {isPlatformAdmin?`This is what gets written to USR history if this event is closed with "🧪 Close with Output PES" below instead of the standard close.`:"Only the Platform Admin can close an event using this instead of the standard scoring."}</div>
        <OutputPESTable rows={calcXCTLadderPreview(plan,users,comms,effEv).map(t=>({key:t.teamId,name:t.team?.name,subtitle:(t.team?.players||[]).map(p=>p.nickname).join(" & "),entryUsr:t.entryUsr,avgDelta:t.avgDelta,score:t.outputTES})).sort((a,b)=>b.score-a.score)}/>
      </>}

      {isFootballEv&&plan&&(()=>{
        const scorers=calcTopScorers(plan);
        if(scorers.length===0) return null;
        return <>
          <ST>⚽ Top Scorers</ST>
          {scorers.map((s,i)=><Card key={s.userId} style={{marginBottom:6}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,background:i<3?"#6366F133":"var(--po-bdr)",color:i===0?"#FBBF24":i===1?"#94A3B8":i===2?"#CD7C2F":"var(--po-dim)"}}>{i+1}</div>
              {s.player&&<Av u={s.player} size={30}/>}
              <div style={{flex:1,fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{s.player?.nickname||"Unknown"}</div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:18,fontWeight:700,color:"#6366F1"}}>{s.goals}</div>
                <div style={{fontSize:10,color:"var(--po-dim)"}}>{s.goals===1?"goal":"goals"}</div>
              </div>
            </div>
          </Card>)}
        </>;
      })()}
    </>}
  </>;
}

// ══════════════════════════════════════════════════════
//  EVENTS LIST
// ══════════════════════════════════════════════════════
function EvList({events,me,users,comms,venues,eventCommFilter,onOpen,onCreateEv,onBulkArchive,onBulkDelete}){
  const [sub,setSub]=useState("coming");
  const [showCommPicker,setShowCommPicker]=useState(false);
  const [incompleteOpen,setIncompleteOpen]=useState(true);
  const [completedOpen,setCompletedOpen]=useState(false);
  const [selMode,setSelMode]=useState(false);
  const [selected,setSelected]=useState(new Set());
  const filteredEvents = (!eventCommFilter||eventCommFilter==="all") ? events : events.filter(ev=>ev.communityId===parseInt(eventCommFilter));
  const myIds=new Set(filteredEvents.filter(ev=>ev.registrations?.some(r=>r.userId===me.id)||ev.createdBy===me.id).map(ev=>ev.id));
  const now=Date.now();
  const isFutureEv=ev=>{ if(!ev.date) return true; const t=new Date(`${ev.date}T23:59:59`).getTime(); return isNaN(t)||t>=now; };
  // Coming/Past is decided strictly by whether the event's date+time has passed — not by admin status.
  // This surfaces events whose time has come and gone but were never closed (Incomplete), instead of
  // leaving them stuck under "Coming" forever. Cancelled events don't appear in this quick view at all —
  // they live under the community's own Archived section.
  const evTime=ev=>{ const t=new Date(`${ev.date}T${ev.time||"00:00"}`).getTime(); return isNaN(t)?0:t; };
  const byNewestFirst=(a,b)=>evTime(b)-evTime(a);
  const coming=filteredEvents.filter(ev=>ev.status!=="cancelled"&&isFutureEv(ev)&&!ev.archived&&myIds.has(ev.id)).sort(byNewestFirst);
  const pastAll=filteredEvents.filter(ev=>ev.status!=="cancelled"&&!isFutureEv(ev)&&!ev.archived&&myIds.has(ev.id)).sort(byNewestFirst);
  const pastCompleted=pastAll.filter(ev=>ev.status==="completed");
  const pastIncomplete=pastAll.filter(ev=>ev.status!=="completed");
  const past=pastAll;
  const others=filteredEvents.filter(ev=>ev.status!=="cancelled"&&isFutureEv(ev)&&!ev.archived&&!myIds.has(ev.id)).sort(byNewestFirst);
  const adminComms=comms.filter(c=>c.members.some(m=>m.userId===me.id&&(m.role==="owner"||m.role==="admin")));
  const isAdm=adminComms.length>0;
  const adminCommIds=new Set(adminComms.map(c=>c.id));
  const handleNewClick=()=>{ if(adminComms.length<=1){ if(adminComms.length===1)onCreateEv(adminComms[0].id); return; } setShowCommPicker(true); };
  const toggleSel=eid=>setSelected(s=>{const n=new Set(s);n.has(eid)?n.delete(eid):n.add(eid);return n;});
  const selItems=[...selected].map(eid=>{const ev=filteredEvents.find(e=>e.id===eid);return ev?{cid:ev.communityId,eid:ev.id}:null;}).filter(Boolean);
  const exitSelMode=()=>{setSelMode(false);setSelected(new Set());};
  function Row({ev}){
    const canSelect=selMode&&adminCommIds.has(ev.communityId);
    const isSel=selected.has(ev.id);
    return <div style={{position:"relative"}}>
      {canSelect&&<div onClick={()=>toggleSel(ev.id)} style={{position:"absolute",top:14,left:10,zIndex:2,width:20,height:20,borderRadius:5,border:`1.5px solid ${isSel?"#6366F1":"var(--po-dim)"}`,background:isSel?"#6366F1":"var(--po-card)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:12,color:"#fff",fontWeight:700}}>{isSel?"✓":""}</div>}
      <div style={{marginLeft:canSelect?30:0,opacity:selMode&&!canSelect?0.5:1}}>
        <EvCard ev={ev} me={me} users={users} venues={venues} onClick={canSelect?()=>toggleSel(ev.id):(selMode?undefined:()=>onOpen(ev.communityId,ev.id))}/>
      </div>
    </div>;
  }
  return <><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)"}}>Events</div>
    {isAdm&&!selMode&&<div style={{display:"flex",gap:8}}><SmBtn label="☑ Select" onClick={()=>setSelMode(true)} color="#6366F1"/><Btn label="+ New" primary onClick={handleNewClick}/></div>}
    {selMode&&<SmBtn label="✕ Cancel" onClick={exitSelMode} color="#94A3B8"/>}
  </div>
  {selMode&&<Card style={{marginBottom:12,padding:"10px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
    <span style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{selected.size} selected</span>
    <div style={{display:"flex",gap:8}}>
      <SmBtn label="🗄 Archive" color="#F59E0B" onClick={()=>{if(selItems.length===0)return;if(window.confirm(`Archive ${selItems.length} event(s)?`)){onBulkArchive&&onBulkArchive(selItems);exitSelMode();}}}/>
      {/* Bulk delete is Platform-Admin-only — unlike single-event delete (creator-only) or bulk
          archive, this can wipe activity across communities the actor doesn't even own, and is
          exactly the action a real incident traced back to (an event vanished, no audit trail).
          Community admins doing routine cleanup still have bulk Archive and single-event Delete. */}
      {me.id===1&&<SmBtn label="🗑 Delete" color="#EF4444" onClick={()=>{if(selItems.length===0)return;if(window.confirm(`Delete ${selItems.length} event(s)?\n\nThis hides them from everyone in their communities immediately — treat it like a permanent action. Completed events will be skipped — use Archive for those instead.`)){onBulkDelete&&onBulkDelete(selItems);exitSelMode();}}}/>}
    </div>
  </Card>}
    {showCommPicker&&<Card style={{marginBottom:12}}>
      <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Which community?</div>
      {adminComms.map(c=><div key={c.id} onClick={()=>{setShowCommPicker(false);onCreateEv(c.id);}} style={{padding:"9px 10px",borderRadius:8,cursor:"pointer",fontSize:13,color:"var(--po-text)",border:"0.5px solid var(--po-bdr)",marginBottom:6}}>{c.name}</div>)}
      <div onClick={()=>setShowCommPicker(false)} style={{textAlign:"center",fontSize:12,color:"var(--po-dim)",cursor:"pointer",marginTop:4}}>Cancel</div>
    </Card>}
    <Tabs tabs={[[`coming`,`Coming (${coming.length})`],[`past`,`Past (${past.length})`]]} active={sub} onChange={setSub}/>
    {sub==="coming"&&<>{coming.length===0?<Card><div style={{textAlign:"center",padding:"24px 0",color:"var(--po-dim)",fontSize:13}}><div style={{fontSize:28,marginBottom:8}}>📅</div>No upcoming events.</div></Card>:coming.map(ev=><Row key={ev.id} ev={ev}/>)}{others.length>0&&<><ST>Other Upcoming</ST>{others.map(ev=><Row key={ev.id} ev={ev}/>)}</>}</>}
    {sub==="past"&&(past.length===0?<Card><div style={{textAlign:"center",padding:"24px 0",color:"var(--po-dim)",fontSize:13}}>No past events yet.</div></Card>:<>
      {pastIncomplete.length>0&&<>
        <div onClick={()=>setIncompleteOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",margin:"16px 0 8px"}}>
          <span style={{fontSize:11,color:"var(--po-dim)",transform:incompleteOpen?"none":"rotate(-90deg)",transition:"transform 0.15s"}}>▾</span>
          <span style={{fontSize:13,fontWeight:600,color:"var(--po-text)",textTransform:"uppercase",letterSpacing:0.5}}>⏳ Incomplete ({pastIncomplete.length})</span>
        </div>
        {incompleteOpen&&pastIncomplete.map(ev=><Row key={ev.id} ev={ev}/>)}
      </>}
      {pastCompleted.length>0&&<>
        <div onClick={()=>setCompletedOpen(o=>!o)} style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",margin:"16px 0 8px"}}>
          <span style={{fontSize:11,color:"var(--po-dim)",transform:completedOpen?"none":"rotate(-90deg)",transition:"transform 0.15s"}}>▾</span>
          <span style={{fontSize:13,fontWeight:600,color:"var(--po-text)",textTransform:"uppercase",letterSpacing:0.5}}>✅ Completed ({pastCompleted.length})</span>
        </div>
        {completedOpen&&pastCompleted.map(ev=><Row key={ev.id} ev={ev}/>)}
      </>}
    </>)}
  </>;
}

// ══════════════════════════════════════════════════════
//  PROFILE & SETTINGS
// ══════════════════════════════════════════════════════
function ComboCard({combo, lv, eventsDesc, teamName, onRename}){
  const [expanded, setExpanded] = useState(false);
  const [editingName,setEditingName] = useState(false);
  const [nameVal,setNameVal] = useState(teamName||"");
  const tr = combo.currentTr;
  const eventCount = combo.events.length;
  const saveName = () => {
    setEditingName(false);
    const trimmed = nameVal.trim();
    if(onRename && trimmed && trimmed!==teamName) onRename(trimmed);
    else setNameVal(teamName||"");
  };
  return <Card style={{marginBottom:8,padding:0,overflow:"hidden"}}>
    {/* Header row — always visible */}
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px"}}>
      {/* TR badge */}
      <div onClick={()=>setExpanded(e=>!e)} style={{width:40,height:40,borderRadius:10,background:`${lv.c}22`,border:`1.5px solid ${lv.c}44`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0,cursor:"pointer"}}>
        <div style={{fontSize:14,fontWeight:700,color:lv.c,lineHeight:1}}>{tr??"-"}</div>
        <div style={{fontSize:8,color:lv.c,fontWeight:600}}>TR</div>
      </div>
      <div onClick={()=>!editingName&&setExpanded(e=>!e)} style={{flex:1,minWidth:0,cursor:editingName?"default":"pointer"}}>
        {editingName
          ? <input autoFocus value={nameVal} onClick={e=>e.stopPropagation()} onChange={e=>setNameVal(e.target.value)} onBlur={saveName} onKeyDown={e=>{if(e.key==="Enter")saveName();if(e.key==="Escape"){setNameVal(teamName||"");setEditingName(false);}}} placeholder="Team name (optional)" className="po-inp" style={{fontSize:13,fontWeight:700,padding:"2px 6px",borderRadius:5,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",width:"90%"}}/>
          : <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontWeight:700,fontSize:14,color:"var(--po-text)"}}>{teamName || `with ${combo.partnerName}`}</span>
              {onRename&&<span onClick={e=>{e.stopPropagation();setNameVal(teamName||"");setEditingName(true);}} style={{fontSize:11,cursor:"pointer",color:"var(--po-dim)"}}>✏️</span>}
            </div>}
        <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>{teamName?`with ${combo.partnerName} · `:""}{eventCount} event{eventCount!==1?"s":""} together</div>
      </div>
      <div onClick={()=>setExpanded(e=>!e)} style={{fontSize:18,color:"var(--po-dim)",transition:"transform 0.2s",transform:expanded?"rotate(180deg)":"none",cursor:"pointer"}}>⌄</div>
    </div>

    {/* Expanded: TR history per event */}
    {expanded&&<div style={{borderTop:"0.5px solid var(--po-bdr)"}}>
      {/* Column headers */}
      <div style={{display:"grid",gridTemplateColumns:"72px 1fr 44px 44px",gap:4,padding:"6px 14px",background:"var(--po-bdr)",fontSize:10,fontWeight:700,color:"var(--po-dim)"}}>
        <span>DATE</span><span>EVENT</span><span style={{textAlign:"right"}}>TES</span><span style={{textAlign:"right"}}>TR Δ</span>
      </div>
      {eventsDesc.map((h,i)=>{
        const prevTr = i<eventsDesc.length-1 ? eventsDesc[i+1].tr : null;
        const delta = (h.tr!=null&&prevTr!=null) ? h.tr-prevTr : null;
        return <div key={i} style={{display:"grid",gridTemplateColumns:"72px 1fr 44px 44px",gap:4,padding:"9px 14px",borderBottom:i<eventsDesc.length-1?"0.5px solid var(--po-bdr)":"none",alignItems:"center"}}>
          <div style={{fontSize:10,color:"var(--po-dim)"}}>{fmtD(h.date)}</div>
          <div>
            <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:1,display:"flex",alignItems:"center",gap:4}}>
              <span>#{h.eventId} · {h.format==="ladder"?"Ladder":"League"}</span>
              {h.retired&&<span style={{fontSize:9,background:"#EF444422",color:"#EF4444",borderRadius:3,padding:"0 4px",fontWeight:700}}>🚑 RETIRED</span>}
            </div>
            <div style={{fontSize:12,fontWeight:600,color:"var(--po-text)"}}>{h.eventName}</div>
          </div>
          <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:"#6366F1"}}>{h.tes}%</div>
          <div style={{textAlign:"right",fontSize:12,fontWeight:700,color:delta!=null?(delta>0?"#34D399":delta<0?"#EF4444":"var(--po-dim)"):"var(--po-dim)"}}>
            {delta!=null?(delta>0?"+":"")+delta:"—"}
          </div>
        </div>;
      })}
      {/* Current TR summary */}
      <div style={{padding:"8px 14px",background:"var(--po-bdr)22",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:11,color:"var(--po-dim)"}}>Current TR (rolling avg last 5)</span>
        <span style={{fontSize:14,fontWeight:700,color:lv.c}}>{tr??"-"}</span>
      </div>
    </div>}
  </Card>;
}

function ProfileSc({user,me,comms,onBack,viewedByAdmin,onEditUser,isMeTab,onOpenCommunity,onOpenEvent,onExploreCommunities,onViewProfile,onSetComboName,usrWindowSize=5,egypt}){
  const isPlatformAdmin = me?.id===1;
  const showContact = !viewedByAdmin || isPlatformAdmin;
  // Full activity (USR History / Teams / Reports) is only for the owner, the real platform
  // admin, or a viewer who actually shares a community with this profile — a total stranger
  // just gets the basic info card, not this person's match history.
  const shareCommunity = comms.some(c=>c.members.some(m=>m.userId===me?.id)&&c.members.some(m=>m.userId===user.id));
  const canSeeActivity = !viewedByAdmin || isPlatformAdmin || shareCommunity;
  // Renaming a combo's team name: the owner themselves, the real platform admin, or a
  // community admin who shares a community with this profile — same admin bar as renaming
  // from the event's own Teams tab, just reachable from the profile page too.
  const canManageCombo = !viewedByAdmin || isPlatformAdmin || comms.some(c=>c.members.some(m=>m.userId===me?.id&&(m.role==="owner"||m.role==="admin"))&&c.members.some(m=>m.userId===user.id));
  // "You" only makes sense when the viewer IS the profile owner — otherwise it's misleading,
  // so it's swapped for the owner's own name (in red, not clickable — already on their page).
  const meLabel = viewedByAdmin ? <span style={{color:"#EF4444",fontWeight:600}}>{user.nickname}</span> : "You";
  const NameLink = ({uid,nickname}) => {
    if(!nickname) return <>—</>;
    return <span onClick={e=>{if(onViewProfile){e.stopPropagation();onViewProfile(uid);}}} style={{color:onViewProfile?"#6366F1":"inherit",cursor:onViewProfile?"pointer":"default"}}>{nickname}</span>;
  };
  const [tab,setTab]=useState("usr");
  const [expandedHist,setExpandedHist]=useState(null); // eventId currently expanded, or null
  const [recentOnly,setRecentOnly]=useState(false);
  const [expandedRow,setExpandedRow]=useState(null); // `${kind}-${userId}` for the open Partners/Opponents row, or null
  const [expandedSection,setExpandedSection]=useState(null); // "partner"|"opponent" for the open "Insufficient data" section, or null
  const [editing,setEditing]=useState(false);
  const [ef,setEf]=useState({nickname:user.nickname,phone:user.phone||"",breakPref:user.breakPref||"none",country:user.country||"مصر",gov:user.gov||"",area:user.area||""});
  const [photoUploading,setPhotoUploading]=useState(false);
  const isMe = me && user.id===me.id;
  const handlePhotoSelect = async (e) => {
    const file = e.target.files[0]; e.target.value="";
    if (!file) return;
    setPhotoUploading(true);
    try{ const url = await uploadProfilePhoto(user.id, file); onEditUser(user.id,{nickname:user.nickname,name:user.name,country:user.country,gov:user.gov,area:user.area,usr:user.usr,phone:user.phone,photoURL:url}); }
    catch(err){ console.log("Photo upload error", err); }
    setPhotoUploading(false);
  };
  const lv=usrLv(user.usr),mine=comms.filter(c=>c.members.some(m=>m.userId===user.id));
  const ec=mine.reduce((s,c)=>s+c.events.filter(e=>!e.deleted&&e.registrations.some(r=>r.userId===user.id)).length,0);
  const usrHist=[...(user.usrHistory||[])].reverse();

  // Build team history from all CT completed events the user participated in

  return <>{isMeTab?<div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>Me</div>:<BBtn onBack={onBack} label="Back"/>}
  {viewedByAdmin&&<div style={{marginBottom:12,padding:"8px 12px",background:"#6366F122",border:"0.5px solid #6366F144",borderRadius:8,fontSize:12,color:"#A5B4FC"}}>{isPlatformAdmin?"🛡 Viewing as Platform Admin — visible only to you":`👀 Viewing ${user.nickname}'s profile`}</div>}
  <Card><div style={{display:"flex",gap:14,alignItems:"center",marginBottom:16}}>
    <Av u={user} size={isMeTab?68:56}/>
    <div style={{flex:1,minWidth:0}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{fontWeight:700,fontSize:18,color:"var(--po-text)"}}>{user.nickname}</div>
        <div style={{fontSize:10,color:"var(--po-dim)",background:"var(--po-bdr)",borderRadius:4,padding:"2px 6px",fontFamily:"monospace"}}>#{user.id}</div>
      </div>
      <div style={{fontSize:13,color:"var(--po-dim)"}}>{user.name}</div>
      <div style={{fontSize:12,color:"var(--po-dim)"}}>📍 {user.area} · {user.gov} · {user.country||"مصر"}</div>
      {showContact&&<div style={{fontSize:12,color:"var(--po-dim)",marginTop:2}}>✉️ {user.email || <span style={{color:"var(--po-bdr)"}}>—</span>}</div>}
      {showContact&&<div style={{fontSize:12,color:"var(--po-dim)",marginTop:2}}>{user.phone ? <a href={`tel:${user.phone}`} style={{color:"inherit",textDecoration:"none"}}>📱 {user.phone}</a> : <>📱 <span style={{color:"var(--po-bdr)"}}>—</span></>}</div>}
      <div style={{fontSize:12,color:"var(--po-dim)",marginTop:2}}>☕ Break Preference: {BREAK_PREF_LABELS[user.breakPref||"none"]}</div>
    </div>
    {(isMe||isPlatformAdmin)&&!editing&&<SmBtn label="✏️ Edit" onClick={()=>{setEf({nickname:user.nickname,phone:user.phone||"",breakPref:user.breakPref||"none",instapayLink:user.instapayLink||"",country:user.country||"مصر",gov:user.gov||"",area:user.area||""});setEditing(true);}} color="#6366F1"/>}
  </div>
  {(isMe||isPlatformAdmin)&&editing&&<div style={{borderTop:"0.5px solid var(--po-bdr)",paddingTop:14,marginTop:2}}>
    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
      <Av u={user} size={48}/>
      <label style={{cursor:photoUploading?"default":"pointer"}}>
        <input type="file" accept="image/*" style={{display:"none"}} onChange={handlePhotoSelect} disabled={photoUploading}/>
        <span style={{fontSize:13,fontWeight:600,color:photoUploading?"var(--po-dim)":"#6366F1"}}>{photoUploading?"Uploading…":"📷 Change Photo"}</span>
      </label>
    </div>
    <Inp label="Nickname" value={ef.nickname} onChange={v=>setEf(p=>({...p,nickname:v}))}/>
    <Inp label="Phone" value={ef.phone} onChange={v=>setEf(p=>({...p,phone:v}))}/>
    <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Location</div>
    <AreaSel country={ef.country} gov={ef.gov} area={ef.area} onChange={(k,v)=>setEf(p=>({...p,[k]:v}))} egypt={egypt}/>
    <Drp label="Break Preference" value={ef.breakPref} onChange={v=>setEf(p=>({...p,breakPref:v}))} options={[{v:"none",l:"No Preference"},{v:"early",l:"Prefer Early Break"},{v:"mid",l:"Prefer Mid-Event Break"},{v:"late",l:"Prefer Late Break"}]}/>
    <div style={{fontSize:11,color:"var(--po-dim)",marginTop:-4,marginBottom:12}}>Used as your default whenever you join an event — admins can override it per event.</div>
    <Inp label="InstaPay Link (optional)" value={ef.instapayLink} onChange={v=>setEf(p=>({...p,instapayLink:v}))} placeholder="https://ipn.eg/S/yourname/instapay/..."/>
    <div style={{fontSize:11,color:"var(--po-dim)",marginTop:-4,marginBottom:12}}>Shown when you're picked as an event's payment collector, so other players can pay you straight from the app.</div>
    <div style={{display:"flex",gap:8,marginTop:4}}>
      <Btn label="Save" primary onClick={()=>{if(!ef.nickname.trim()||!ef.gov||!ef.area)return;if(onEditUser(user.id,{nickname:ef.nickname,name:user.name,country:ef.country,gov:ef.gov,area:ef.area,usr:user.usr,phone:ef.phone,breakPref:ef.breakPref,instapayLink:ef.instapayLink.trim()})!==false)setEditing(false);}} style={{flex:1}}/>
      <Btn label="Cancel" onClick={()=>setEditing(false)} style={{flex:1}}/>
    </div>
  </div>}
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
    {[["Communities",mine.length],["Events",ec]].map(([l,v])=>
      <div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 4px",textAlign:"center"}}>
        <div style={{fontSize:15,fontWeight:700,color:"var(--po-text)"}}>{v}</div>
        <div style={{fontSize:10,color:"var(--po-dim)",marginTop:1}}>{l}</div>
      </div>
    )}
  </div>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
    <div className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 10px"}}>
      <div style={{fontSize:11,fontWeight:600,color:"var(--po-dim)",marginBottom:4}}>🎾 Padel</div>
      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between"}}>
        <span style={{fontSize:11,color:"var(--po-dim)"}}>USR</span>
        <span style={{fontSize:14,fontWeight:700,color:"var(--po-text)"}}>{user.usr}</span>
      </div>
      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",marginTop:2}}>
        <span style={{fontSize:11,color:"var(--po-dim)"}}>Level</span>
        <span style={{fontSize:14,fontWeight:700,color:lv.c}}>{lv.l}</span>
      </div>
    </div>
    {/* Football has no computed rating (no match-result history to derive one from yet) — just
        the admin's manually-set A-E tier. Always shown (with a "Not Rated" fallback) so the
        profile visibly reflects football data even before an admin has set anything. */}
    <div className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 10px"}}>
      <div style={{fontSize:11,fontWeight:600,color:"var(--po-dim)",marginBottom:4}}>⚽ Football</div>
      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between"}}>
        <span style={{fontSize:11,color:"var(--po-dim)"}}>Skill Level</span>
        <span style={{fontSize:14,fontWeight:700,color:"var(--po-text)"}}>{user.footballSkill||"Not Rated"}</span>
      </div>
    </div>
  </div>
  </Card>

  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"16px 0 8px"}}>
    <span style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{isMeTab?"My Communities":`${user.nickname}'s Communities`}</span>
    {isMeTab&&<span onClick={()=>onExploreCommunities&&onExploreCommunities()} style={{fontSize:12,fontWeight:600,color:"#6366F1",cursor:"pointer"}}>🔍 Explore / Join / Create</span>}
  </div>
  {mine.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"14px 0"}}>{isMeTab?<>Not in any community yet. <span style={{color:"#6366F1",cursor:"pointer"}} onClick={()=>onExploreCommunities&&onExploreCommunities()}>Explore →</span></>:"Not in any community yet."}</div></Card>
    :mine.map(c=>{const myRole=c.members.find(m=>m.userId===user.id)?.role;
      return <Card key={c.id} style={{padding:"10px 14px",marginBottom:6}}>
        <div onClick={()=>onOpenCommunity&&onOpenCommunity(c.id)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:onOpenCommunity?"pointer":"default"}}>
          <span style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{c.name}</span>
          {rBdg(myRole)}
        </div>
      </Card>;})}

  {canSeeActivity ? <>
  <div style={{display:"flex",gap:6,margin:"16px 0 8px"}}>
    {[["usr","📈 USR History"],["teams","👥 Teams"],["reports","🤝 Reports"]].map(([k,l])=>
      <button key={k} onClick={()=>setTab(k)} style={{flex:1,padding:"9px",borderRadius:8,border:`0.5px solid ${tab===k?"#6366F1":"var(--po-bdr)"}`,background:tab===k?"#6366F122":"var(--po-inp)",color:tab===k?"#A5B4FC":"var(--po-sub)",fontSize:13,fontWeight:600,cursor:"pointer"}}>{l}</button>
    )}
  </div>

  {tab==="usr"&&<>
    {usrHist.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No CI event history yet.</div></Card>
    :<Card style={{padding:0,overflow:"hidden"}}>
      {/* Column headers */}
      <div style={{display:"grid",gridTemplateColumns:"68px 1fr 44px 64px",gap:2,padding:"7px 12px",background:"var(--po-bdr)",fontSize:10,fontWeight:700,color:"var(--po-dim)"}}>
        <span>DATE</span><span>EVENT</span>
        <span style={{textAlign:"right"}}>PES</span>
        <span style={{textAlign:"right"}}>BEF → Δ</span>
      </div>
      {usrHist.map((h,i)=>{
        const seedUsr = user.seedUsr ?? user.usr;
        const histChron = [...usrHist].reverse();
        const idx = histChron.findIndex((x,xi)=>xi===histChron.length-1-i);
        const histUpToNow = histChron.slice(0, histChron.length-1-i);
        const prevUsr = calcWeightedUSR(histUpToNow, seedUsr, usrWindowSize);
        const newUsr = calcWeightedUSR([...histUpToNow,h], seedUsr, usrWindowSize);
        const delta = newUsr - prevUsr;
        const deltaColor = delta>0?"#34D399":delta<0?"#EF4444":"var(--po-dim)";
        const deltaArrow = delta>0?"↑":delta<0?"↓":"—";
        const isCTEvent = h.type==="ct";
        const hostComm = comms.find(c=>c.events.some(e=>e.id===h.eventId));
        const hostEvent = hostComm?.events.find(e=>e.id===h.eventId);
        const isExpanded = expandedHist===h.eventId;
        let extraStats = null;
        if (isExpanded && hostEvent?.plan) {
          if (hostEvent.type==="closed_ind") {
            const stands = calcCIStandings(hostEvent.plan, [user]);
            const s = stands.find(s=>s.user.id===user.id);
            if (s) {
              let finalCourt = null;
              for (let ri=hostEvent.plan.rounds.length-1; ri>=0 && finalCourt===null; ri--) {
                for (const m of hostEvent.plan.rounds[ri].matches) {
                  if (m.teamA.some(p=>p.userId===user.id)||m.teamB.some(p=>p.userId===user.id)) { finalCourt=m.court; break; }
                }
              }
              extraStats = {wins:s.wins, pts:s.pts, breaks:s.breaks, finalCourt};
            }
          } else if (hostEvent.type==="closed_teams") {
            const stands = calcCTStandings(hostEvent.plan);
            const team = hostEvent.plan.teams?.find(t=>t.players?.some(p=>p.userId===user.id));
            const s = team&&stands.find(s=>s.team?.id===team.id);
            if (s) extraStats = {wins:s.wins, pts:s.pts, breaks:s.breaks, finalCourt:null, isTeam:true};
          }
        }
        return <div key={i} style={{borderBottom:i<usrHist.length-1?"0.5px solid var(--po-bdr)":"none"}}>
        <div onClick={()=>hostComm&&setExpandedHist(o=>o===h.eventId?null:h.eventId)} style={{display:"grid",gridTemplateColumns:"68px 1fr 44px 64px",gap:2,padding:"10px 12px",alignItems:"center",cursor:hostComm?"pointer":"default"}}>
          <div style={{fontSize:10,color:"var(--po-dim)"}}>{fmtD(h.date)}</div>
          <div>
            <div style={{fontSize:10,color:"var(--po-dim)",display:"flex",alignItems:"center",gap:4}}>
              #{h.eventId}
              {isCTEvent&&<span style={{fontSize:9,background:"#06B6D422",color:"#06B6D4",borderRadius:3,padding:"0 4px",fontWeight:700}}>CT ×0.5</span>}
              {h.retired&&<span style={{fontSize:9,background:"#EF444422",color:"#EF4444",borderRadius:3,padding:"0 4px",fontWeight:700}}>🚑 RETIRED</span>}
            </div>
            <div onClick={e=>{if(hostComm){e.stopPropagation();onOpenEvent&&onOpenEvent(hostComm.id,h.eventId);}}} style={{fontSize:12,fontWeight:600,color:hostComm?"#6366F1":"var(--po-text)",cursor:hostComm?"pointer":"default"}}>{h.eventName}</div>
          </div>
          <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:isCTEvent?"#06B6D4":"#6366F1"}}>{h.pes}%</div>
          <div style={{textAlign:"right"}}>
            <span style={{fontSize:12,color:"var(--po-dim)"}}>{prevUsr} </span>
            <span style={{fontSize:13,fontWeight:700,color:deltaColor}}>{deltaArrow}{Math.abs(delta)>0?Math.abs(delta):""}</span>
          </div>
        </div>
        {isExpanded&&<div style={{padding:"4px 12px 12px"}}>
          {hostComm&&<div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8}}>👥 {hostComm.name}</div>}
          {extraStats?<div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:8}}>
            {[["Wins",extraStats.wins],["Points",extraStats.pts],["Breaks",extraStats.breaks],[extraStats.isTeam?"Team":"Final Court",extraStats.isTeam?"—":(extraStats.finalCourt?`C${extraStats.finalCourt}`:"—")]].map(([l,v])=>
              <div key={l} style={{background:"var(--po-inp)",borderRadius:6,padding:"6px 2px",textAlign:"center"}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--po-text)"}}>{v}</div>
                <div style={{fontSize:9,color:"var(--po-dim)"}}>{l}</div>
              </div>)}
          </div>:<div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8}}>No detailed stats available for this event.</div>}
        </div>}
        </div>;
      })}
    </Card>}
    <div style={{marginTop:8,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:11,color:"var(--po-dim)"}}>
      Seed USR: <b style={{color:"var(--po-text)"}}>{user.seedUsr??user.usr}</b> · Rolling avg of last 5 events · BEF = USR before each event
    </div>
  </>}

  {tab==="teams"&&<>
    {(()=>{
      // Group teamsHistory by combination (comboKey)
      const rawHist = user.teamsHistory||[];
      // Also build from event data for backward compat (before TR was implemented)
      const combos = {};
      rawHist.forEach(h=>{
        if(!combos[h.comboKey]) combos[h.comboKey]={
          comboKey:h.comboKey, partnerId:h.partnerId, partnerName:h.partnerName,
          events:[], currentTr:null
        };
        combos[h.comboKey].events.push(h);
        // Latest TR is the TR from the most recent event
        combos[h.comboKey].currentTr = h.tr??null;
      });
      const comboList = Object.values(combos).sort((a,b)=>(b.currentTr??0)-(a.currentTr??0));

      if(comboList.length===0) return <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No Closed Teams history yet.<br/><span style={{fontSize:11}}>TR is calculated when a CT event is closed.</span></div></Card>;

      return comboList.map(combo=>{
        const lv=usrLv(combo.currentTr??50);
        const eventsDesc=[...combo.events].reverse();
        return <ComboCard key={combo.comboKey} combo={combo} lv={lv} eventsDesc={eventsDesc}
          teamName={user.comboNames?.[combo.comboKey]}
          onRename={canManageCombo&&onSetComboName?name=>onSetComboName(combo.partnerId,name):undefined}/>;
      });
    })()}
    <div style={{marginTop:8,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:11,color:"var(--po-dim)"}}>
      TR = rolling average of last 5 TES scores for each partner combination · Seed = avg USR of both players
    </div>
  </>}

  {tab==="reports"&&(()=>{
    const stats = calcPartnerOpponentStats(comms, user.id, {recentOnly});
    const totalPairs = stats.partnersRanked.length+stats.partnersInsufficient.length+stats.opponentsRanked.length+stats.opponentsInsufficient.length;
    const dream = calcDreamOrFunnyMatch(stats,"dream");
    const funny = calcDreamOrFunnyMatch(stats,"funny");
    const dreamH2H = dream ? calcExactHeadToHead(comms, [user.id, dream.partner.userId], dream.opponents.map(o=>o.userId)) : null;
    const funnyH2H = funny ? calcExactHeadToHead(comms, [user.id, funny.partner.userId], funny.opponents.map(o=>o.userId)) : null;
    const PairRow = ({rowKey,kind,rank,name,userId,rate,num,den,goodColor,history}) => {
      const isOpen = expandedRow===rowKey;
      return <div>
        <div onClick={()=>setExpandedRow(o=>o===rowKey?null:rowKey)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 12px",cursor:"pointer"}}>
          <span style={{fontSize:13,color:"var(--po-text)"}}>{rank}. <span onClick={e=>{if(onViewProfile){e.stopPropagation();onViewProfile(userId);}}} style={{color:onViewProfile?"#6366F1":"var(--po-text)",cursor:onViewProfile?"pointer":"default"}}>{name}</span> <span style={{fontSize:9,color:"var(--po-dim)"}}>{isOpen?"▲":"▼"}</span></span>
          <span style={{fontSize:13,fontWeight:700,color:goodColor}}>{Math.round(rate*100)}% <span style={{fontSize:10,fontWeight:400,color:"var(--po-dim)"}}>({num}/{den})</span></span>
        </div>
        {isOpen&&<div style={{padding:"0 12px 10px"}}>
          {history.map((h,hi)=><div key={hi} style={{padding:"7px 0",borderTop:"0.5px solid var(--po-bdr)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11}}>
              <span style={{color:"var(--po-dim)"}}>{fmtD(h.date)} · <span onClick={e=>{const hc=comms.find(c=>c.events.some(ev=>ev.id===h.eventId));if(hc){e.stopPropagation();onOpenEvent&&onOpenEvent(hc.id,h.eventId);}}} style={{color:"#6366F1",cursor:"pointer",fontWeight:600}}>{h.eventName}</span> <Bdg label={h.type==="ct"?"CT":"CI"} color={h.type==="ct"?"#06B6D4":"#6366F1"}/></span>
              <span style={{fontWeight:700,color:h.won?"#34D399":"#EF4444"}}>{h.won?"✅ Won":"❌ Lost"}{h.score?` ${h.score.for}–${h.score.against}`:""}</span>
            </div>
            <div style={{color:"var(--po-text)",fontSize:12,marginTop:2}}>{kind==="partner"
              ? <>{meLabel} & <NameLink uid={userId} nickname={name}/> vs {h.against.map((o,oi)=><React.Fragment key={o.userId||oi}>{oi>0&&" & "}<NameLink uid={o.userId} nickname={o.nickname}/></React.Fragment>)}</>
              : <>{meLabel} & <NameLink uid={h.partner?.userId} nickname={h.partner?.nickname}/> vs <NameLink uid={userId} nickname={name}/> & <NameLink uid={h.oppPartner?.userId} nickname={h.oppPartner?.nickname}/></>}</div>
          </div>)}
        </div>}
      </div>;
    };
    const InsufficientList = ({items,label,kind}) => {
      if(items.length===0) return null;
      const sectionOpen = expandedSection===kind;
      return <div style={{marginBottom:14}}>
        <div onClick={()=>setExpandedSection(o=>o===kind?null:kind)} style={{fontSize:11,color:"var(--po-dim)",cursor:"pointer",padding:"4px 0"}}>{sectionOpen?"▾":"▸"} بيانات غير كافية — {label} ({items.length})</div>
        {sectionOpen&&<Card style={{padding:0,overflow:"hidden",marginTop:6}}>
          {items.map((p,i)=>{
            const rowKey=`insuff-${kind}-${p.userId}`, isOpen=expandedRow===rowKey;
            return <div key={p.userId} style={{borderBottom:i<items.length-1?"0.5px solid var(--po-bdr)":"none"}}>
              <div onClick={()=>setExpandedRow(o=>o===rowKey?null:rowKey)} style={{padding:"8px 12px",display:"flex",justifyContent:"space-between",fontSize:12,cursor:"pointer"}}>
                <span style={{color:"var(--po-text)"}}><span onClick={e=>{if(onViewProfile){e.stopPropagation();onViewProfile(p.userId);}}} style={{color:onViewProfile?"#6366F1":"var(--po-text)",cursor:onViewProfile?"pointer":"default"}}>{p.nickname}</span> <span style={{fontSize:9,color:"var(--po-dim)"}}>{isOpen?"▲":"▼"}</span></span>
                <span style={{color:"var(--po-dim)"}}>{p.matches} match{p.matches!==1?"es":""}</span>
              </div>
              {isOpen&&<div style={{padding:"0 12px 8px"}}>
                {p.history.map((h,hi)=><div key={hi} style={{padding:"6px 0",borderTop:"0.5px solid var(--po-bdr)"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11}}>
                    <span style={{color:"var(--po-dim)"}}>{fmtD(h.date)} · <span onClick={e=>{const hc=comms.find(c=>c.events.some(ev=>ev.id===h.eventId));if(hc){e.stopPropagation();onOpenEvent&&onOpenEvent(hc.id,h.eventId);}}} style={{color:"#6366F1",cursor:"pointer",fontWeight:600}}>{h.eventName}</span> <Bdg label={h.type==="ct"?"CT":"CI"} color={h.type==="ct"?"#06B6D4":"#6366F1"}/></span>
                    <span style={{fontWeight:700,color:h.won?"#34D399":"#EF4444"}}>{h.won?"✅ Won":"❌ Lost"}{h.score?` ${h.score.for}–${h.score.against}`:""}</span>
                  </div>
                  <div style={{color:"var(--po-text)",fontSize:12,marginTop:2}}>{kind==="partner"
                    ? <>{meLabel} & <NameLink uid={p.userId} nickname={p.nickname}/> vs {h.against.map((o,oi)=><React.Fragment key={o.userId||oi}>{oi>0&&" & "}<NameLink uid={o.userId} nickname={o.nickname}/></React.Fragment>)}</>
                    : <>{meLabel} & <NameLink uid={h.partner?.userId} nickname={h.partner?.nickname}/> vs <NameLink uid={p.userId} nickname={p.nickname}/> & <NameLink uid={h.oppPartner?.userId} nickname={h.oppPartner?.nickname}/></>}</div>
                </div>)}
              </div>}
            </div>;
          })}
        </Card>}
      </div>;
    };
    return <>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}>
        <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--po-dim)",cursor:"pointer"}}>
          <input type="checkbox" checked={recentOnly} onChange={e=>setRecentOnly(e.target.checked)}/>
          Recent only (last 6 months)
        </label>
      </div>

      {totalPairs===0
        ? <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No match history yet.</div></Card>
        : <>
          {dream&&<Card style={{marginBottom:10,border:"0.5px solid #F59E0B44",background:"#F59E0B0A"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#F59E0B",marginBottom:4}}>🔥 ماتش جامد — Dream Match</div>
            <div style={{fontSize:13,color:"var(--po-text)"}}>{meLabel} & <b onClick={()=>onViewProfile&&onViewProfile(dream.partner.userId)} style={{color:onViewProfile?"#6366F1":"inherit",cursor:onViewProfile?"pointer":"default"}}>{dream.partner.nickname}</b> vs {dream.opponents.map((o,oi)=><React.Fragment key={o.userId}>{oi>0&&" & "}<b onClick={()=>onViewProfile&&onViewProfile(o.userId)} style={{color:onViewProfile?"#6366F1":"inherit",cursor:onViewProfile?"pointer":"default"}}>{o.nickname}</b></React.Fragment>)}</div>
            {dreamH2H&&dreamH2H.last&&<div style={{fontSize:11,color:"var(--po-dim)",marginTop:6}}>Last time this exact matchup happened ({fmtD(dreamH2H.last.date)}): {dreamH2H.last.sideAWon?<>✅ {meLabel} won</>:<>❌ {meLabel} lost</>}{dreamH2H.meetings>1&&<> · {dreamH2H.meetings} meetings, {meLabel} won {Math.round(dreamH2H.sideAWinRate*100)}% of them</>}</div>}
          </Card>}
          {funny&&<Card style={{marginBottom:14,border:"0.5px solid #06B6D444",background:"#06B6D40A"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#06B6D4",marginBottom:4}}>😂 ماتش مسخرة — Funny Match</div>
            <div style={{fontSize:13,color:"var(--po-text)"}}>{meLabel} & <b onClick={()=>onViewProfile&&onViewProfile(funny.partner.userId)} style={{color:onViewProfile?"#6366F1":"inherit",cursor:onViewProfile?"pointer":"default"}}>{funny.partner.nickname}</b> vs {funny.opponents.map((o,oi)=><React.Fragment key={o.userId}>{oi>0&&" & "}<b onClick={()=>onViewProfile&&onViewProfile(o.userId)} style={{color:onViewProfile?"#6366F1":"inherit",cursor:onViewProfile?"pointer":"default"}}>{o.nickname}</b></React.Fragment>)}</div>
            {funnyH2H&&funnyH2H.last&&<div style={{fontSize:11,color:"var(--po-dim)",marginTop:6}}>Last time this exact matchup happened ({fmtD(funnyH2H.last.date)}): {funnyH2H.last.sideAWon?<>✅ {meLabel} won</>:<>❌ {meLabel} lost</>}{funnyH2H.meetings>1&&<> · {funnyH2H.meetings} meetings, {meLabel} won {Math.round(funnyH2H.sideAWinRate*100)}% of them</>}</div>}
          </Card>}

          <ST>🤝 Partners Win Rate</ST>
          <Card style={{padding:0,overflow:"hidden"}}>
            {stats.partnersRanked.length===0
              ? <div style={{padding:"14px 12px",textAlign:"center",fontSize:12,color:"var(--po-dim)"}}>No ranked partners yet ({REPORT_MIN_MATCHES}+ matches together needed).</div>
              : stats.partnersRanked.map((p,i)=><div key={p.userId} style={{borderBottom:i<stats.partnersRanked.length-1?"0.5px solid var(--po-bdr)":"none"}}>
                  <PairRow rowKey={`partner-${p.userId}`} kind="partner" rank={i+1} name={p.nickname} userId={p.userId} rate={p.winRate} num={p.wins} den={p.matches} goodColor="#34D399" history={p.history}/>
                </div>)}
          </Card>
          <InsufficientList items={stats.partnersInsufficient} label="partners" kind="partner"/>

          <ST>⚔️ Opponents Lose Rate</ST>
          <Card style={{padding:0,overflow:"hidden"}}>
            {stats.opponentsRanked.length===0
              ? <div style={{padding:"14px 12px",textAlign:"center",fontSize:12,color:"var(--po-dim)"}}>No ranked opponents yet ({REPORT_MIN_MATCHES}+ matches against needed).</div>
              : stats.opponentsRanked.map((o,i)=><div key={o.userId} style={{borderBottom:i<stats.opponentsRanked.length-1?"0.5px solid var(--po-bdr)":"none"}}>
                  <PairRow rowKey={`opponent-${o.userId}`} kind="opponent" rank={i+1} name={o.nickname} userId={o.userId} rate={o.loseRate} num={o.losses} den={o.matches} goodColor="#EF4444" history={o.history}/>
                </div>)}
          </Card>
          <InsufficientList items={stats.opponentsInsufficient} label="opponents" kind="opponent"/>

          <div style={{marginTop:8,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:11,color:"var(--po-dim)"}}>
            Official (closed) matches only, Closed Individuals and Closed Teams combined · Minimum {REPORT_MIN_MATCHES} matches together/against to be ranked · Tap a row for match-by-match history · Dream/Funny Match hidden until you have enough data
          </div>
        </>}
    </>;
  })()}

  </> : <Card><div style={{textAlign:"center",padding:"16px 0",color:"var(--po-dim)",fontSize:13}}>🔒 Match history is only visible to people who share a community with {user.nickname}.</div></Card>}
  </>;
}
const SeedBadge = ()=><span title="Seeded data">🌱</span>;
const SEEDED_USER_IDS = new Set([1,2,3,4,5,6,7,8,9,10,11,12]);
const SEEDED_COMM_IDS = new Set([1]);
const SEEDED_VENUE_IDS = new Set([1]);
const SEEDED_EVENT_IDS = new Set([1,2,3]);

function PlatformAdminSc({users,comms,venues,uidLinks,onCreateInvite,initialTab,onTabChange,onBack,onAddUser,onEditUser,onRecalcUsr,onDeleteUser,onUnlinkUser,onSuspendUser,onViewProfile,onOpenCommunity,onOpenEvent,onExport,onRepairIds,onFactoryReset,onBackfillGuests,onCleanOrphanedLinks,onMergeDuplicateUser,backups=[],backupsLoading,onRefreshBackups,onCreateBackup,onRestoreBackup,onDeleteBackup,egypt,onSaveEgypt,auditLog=[],onRefreshAudit,auditRefreshing,auditHasMore,auditLoadingMore,onLoadMoreAudit,expenseCategories=[],onSaveExpenseCategories,usrWindowSize=5,onSetUsrWindowSize,onCloneToDev,cloningToDev,subscriptionSettings,onSaveSubscriptionSettings,onSetUserSubscription,subscriptionTransactions=[],onConfirmPayment,onToast,onLogAudit,onRestoreDeletedEvent}){
  const toast2 = onToast || (()=>{});
  const [tab,setTab]=useState(initialTab||"audit");
  useEffect(()=>{ onTabChange&&onTabChange(tab); }, [tab]);
  const [editing,setEditing]=useState(null);
  const [inviteUrl,setInviteUrl]=useState(null);
  const [nf,setNf]=useState({nickname:"",name:"",country:"مصر",gov:"القاهرة",area:"المعادي",usr:"50",breakPref:"none"});
  const [showAdd,setShowAdd]=useState(false);
  const [userSearch,setUserSearch]=useState("");
  const [auditSearch,setAuditSearch]=useState("");
  const [auditActionFilter,setAuditActionFilter]=useState("");
  const [auditVersionFilter,setAuditVersionFilter]=useState("");
  const [auditActorFilter,setAuditActorFilter]=useState("");
  const [auditSort,setAuditSort]=useState({key:"ts",dir:"desc"});
  const [auditBucketsOpen,setAuditBucketsOpen]=useState({Today:true,Yesterday:false,"This week":false,"This month":false,"This year":false,Old:false});
  const [linkFilter,setLinkFilter]=useState(null); // null | "linked" | "unlinked" — toggled via the count badges
  const [newGovName,setNewGovName]=useState("");
  const [areaInputs,setAreaInputs]=useState({}); // gov -> pending new-area text
  const [newCountryName,setNewCountryName]=useState("");
  const [selectedCountry,setSelectedCountry]=useState(null); // resolved with a fallback once egypt is known, right before the Areas tab renders
  const [newCatName,setNewCatName]=useState("");
  const [editingCat,setEditingCat]=useState(null); // category name currently being renamed
  const [editCatInput,setEditCatInput]=useState("");
  const [usrWindowInput,setUsrWindowInput]=useState(String(usrWindowSize));
  const [openUserMenu,setOpenUserMenu]=useState(null);
  const [showDupEmails,setShowDupEmails]=useState(false);
  const [subsSearch,setSubsSearch]=useState("");
  const [editingSubFor,setEditingSubFor]=useState(null); // userId currently being set
  const [subExpiryInput,setSubExpiryInput]=useState("");
  const [monthlyPriceInput,setMonthlyPriceInput]=useState(String(subscriptionSettings?.monthlyPriceEGP??100));
  const [annualPriceInput,setAnnualPriceInput]=useState(String(subscriptionSettings?.annualPriceEGP??1000));
  const [startDateInput,setStartDateInput]=useState(()=>(subscriptionSettings?.enabledAt||new Date().toISOString()).slice(0,10));
  // These three only ever initialized once at mount, so a save made from a DIFFERENT device/tab
  // (which does land in Firestore and does update `subscriptionSettings` live) never showed up
  // here without a full page reload — looking exactly like the save silently failed, even though
  // it actually persisted correctly. Keep them in sync with the real synced value.
  useEffect(()=>{ setMonthlyPriceInput(String(subscriptionSettings?.monthlyPriceEGP??100)); }, [subscriptionSettings?.monthlyPriceEGP]);
  useEffect(()=>{ setAnnualPriceInput(String(subscriptionSettings?.annualPriceEGP??1000)); }, [subscriptionSettings?.annualPriceEGP]);
  useEffect(()=>{ setStartDateInput((subscriptionSettings?.enabledAt||new Date().toISOString()).slice(0,10)); }, [subscriptionSettings?.enabledAt]);
  const [subsView,setSubsView]=useState("manage"); // manage | statement
  const [payingFor,setPayingFor]=useState(null); // userId currently confirming a payment for
  const [payPlan,setPayPlan]=useState("monthly");
  const [payMethod,setPayMethod]=useState("InstaPay");
  const set=(k,v)=>setNf(p=>({...p,[k]:v}));
  const allEvents=comms.flatMap(c=>c.events.map(ev=>({...ev,commName:c.name,communityId:c.id})));
  const linkedUserIds=new Set(Object.values(uidLinks||{}));
  const linkedCount=users.filter(u=>linkedUserIds.has(u.id)).length;
  const orphanedLinksCount=Object.entries(uidLinks||{}).filter(([,uid])=>!users.find(u=>u.id===uid)).length;
  // Duplicate-email audit (Platform Admin, detective tool) — catches a duplicate after the
  // fact regardless of how it happened (stale client, a race, anything).
  const dupEmailGroups = (()=>{
    const byEmail={};
    users.forEach(u=>{ const e=u.email?.toLowerCase().trim(); if(e) (byEmail[e]=byEmail[e]||[]).push(u); });
    return Object.entries(byEmail).filter(([,us])=>us.length>1);
  })();
  const hasFootprint = uid => comms.some(c=>c.members.some(m=>m.userId===uid)||c.events.some(ev=>ev.registrations.some(r=>r.userId===uid)||(ev.checkedIn||[]).includes(uid)||(ev.eventAdmins||[]).includes(uid)||(ev.retiredIds||[]).includes(uid)||(ev.exempted||[]).includes(uid)));
  const q=userSearch.trim().toLowerCase();
  const filteredUsers=users
    .filter(u=>!q||u.nickname?.toLowerCase().includes(q)||u.name?.toLowerCase().includes(q))
    .filter(u=>!linkFilter||(linkFilter==="linked")===linkedUserIds.has(u.id));
  useEffect(()=>{ if(tab==="data") onRefreshBackups&&onRefreshBackups(); }, [tab]);

  return <><BBtn onBack={onBack} label="Back"/>
  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
    <div style={{fontSize:20}}>🛡</div>
    <div>
      <div style={{fontSize:18,fontWeight:700,color:"var(--po-text)"}}>Platform Administration</div>
      <div style={{fontSize:11,color:"var(--po-dim)"}}>Full access · handle with care</div>
    </div>
  </div>

  <TwoRowTabs tabs={[["audit","🕵️ Audit Trail"],["users",`Users (${users.length})`],["archived","Archived Events"],["deleted",`🗑 Deleted (${allEvents.filter(ev=>ev.deleted).length})`],["areas",`Areas (${Object.keys(egypt||{}).length} countr${Object.keys(egypt||{}).length===1?"y":"ies"})`],["cats",`💰 Categories (${expenseCategories.length})`],["usr","🎯 USR Window"],["subs","💳 Subscriptions"],["data","Data & Backup"]]} active={tab} onChange={setTab}/>

  {tab==="cats"&&(()=>{
    const renameCat=(oldName,newName)=>{
      const trimmed=newName.trim();
      if(!trimmed||trimmed===oldName||expenseCategories.includes(trimmed))return;
      onSaveExpenseCategories&&onSaveExpenseCategories(expenseCategories.map(c=>c===oldName?trimmed:c));
    };
    const deleteCat=name=>{
      if(expenseCategories.length<=1)return;
      if(window.confirm(`Delete category "${name}"? Existing expenses already tagged with it keep the label — this only removes it from the dropdown going forward.`))
        onSaveExpenseCategories&&onSaveExpenseCategories(expenseCategories.filter(c=>c!==name));
    };
    return <>
      <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:12}}>Expense categories offered in every community's Ledger tab. Renaming or removing one doesn't change the label already saved on past expense entries.</div>
      {expenseCategories.map(c=>
        <Card key={c} style={{marginBottom:6,padding:"8px 12px"}}>
          {editingCat===c
            ? <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <input autoFocus value={editCatInput} onChange={e=>setEditCatInput(e.target.value)} className="po-inp" style={{flex:1,padding:"6px 8px",borderRadius:6,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",fontSize:13}}/>
                <SmBtn label="✓" onClick={()=>{renameCat(c,editCatInput);setEditingCat(null);}} color="#34D399"/>
                <SmBtn label="✕" onClick={()=>setEditingCat(null)} color="#94A3B8"/>
              </div>
            : <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <span style={{fontSize:13,color:"var(--po-text)"}}>{c}</span>
                <div style={{display:"flex",gap:6}}>
                  <SmBtn label="✏️" onClick={()=>{setEditingCat(c);setEditCatInput(c);}} color="#6366F1"/>
                  <SmBtn label="🗑" onClick={()=>deleteCat(c)} color="#EF4444"/>
                </div>
              </div>}
        </Card>
      )}
      <div style={{display:"flex",gap:6,marginTop:10}}>
        <input value={newCatName} onChange={e=>setNewCatName(e.target.value)} placeholder="New category name..." className="po-inp" style={{flex:1,padding:"9px 12px",borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",color:"var(--po-text)",fontSize:13}}/>
        <Btn label="+ Add" primary onClick={()=>{const t=newCatName.trim();if(t&&!expenseCategories.includes(t)){onSaveExpenseCategories&&onSaveExpenseCategories([...expenseCategories,t]);setNewCatName("");}}}/>
      </div>
    </>;
  })()}

  {tab==="usr"&&<>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:12}}>How many events (weighted — a Closed Teams event counts as 0.5, Closed Individuals as 1.0) go into each player's rolling USR average. Changing this does NOT recompute anyone's current USR and does NOT pull back-in any event that's already outside their active window — it only changes how many <i>new</i> events it takes to reach the new size, starting from each player's next completed event.</div>
    <Card style={{marginBottom:12,textAlign:"center"}}>
      <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:4}}>Current window</div>
      <div style={{fontSize:32,fontWeight:700,color:"var(--po-text)"}}>{usrWindowSize} events</div>
    </Card>
    <Inp label="New window size (events)" value={usrWindowInput} onChange={setUsrWindowInput} type="number"/>
    <Btn label="Apply" primary onClick={()=>{
      const n=parseInt(usrWindowInput);
      if(isNaN(n)||n<1||n>20)return;
      if(n===usrWindowSize)return;
      if(window.confirm(`Change the USR window from ${usrWindowSize} to ${n} events?\n\nThis freezes every event that's currently outside each player's active window — they'll never be pulled back in, even later. The new size only fills up from events completed from now on.`))
        onSetUsrWindowSize&&onSetUsrWindowSize(n);
    }} style={{width:"100%"}}/>
  </>}

  {tab==="subs"&&(()=>{
    const subQ=subsSearch.trim().toLowerCase();
    const shownUsers=users.filter(u=>u.id!==1&&(!subQ||u.nickname?.toLowerCase().includes(subQ)));
    // Four states, independent of the global enforcement switch (so an admin can see exactly
    // where everyone stands before ever flipping enforcement on) — mirrors the same grace-period
    // math as isSubscriptionLocked/isSubscriptionInGrace, just without the .enabled gate.
    const statusOf=u=>{
      if(u.subscription?.status==="comped") return {label:"✓ Comped",color:"#34D399"};
      const exp=u.subscription?.expiresAt;
      if(!exp) return {label:"— Free",color:"var(--po-dim)"};
      const expMs=new Date(exp).getTime(), graceEndMs=expMs+SUBSCRIPTION_GRACE_MS, now=Date.now();
      if(expMs>now) return {label:`✓ Subscribed — until ${fmtD(exp)}`,color:"#34D399"};
      if(graceEndMs>now) return {label:`⏳ Grace — ends ${fmtD(new Date(graceEndMs).toISOString())}`,color:"#F59E0B"};
      return {label:`🚫 Suspended — since ${fmtD(new Date(graceEndMs).toISOString())}`,color:"#EF4444"};
    };
    const activeCount=users.filter(u=>u.id!==1&&isSubscriptionActive(u)).length;
    const startPayment=(u,plan)=>{
      const price=plan==="annual"?subscriptionSettings.annualPriceEGP:subscriptionSettings.monthlyPriceEGP;
      onConfirmPayment&&onConfirmPayment(u.id,{plan,amount:price,method:payMethod});
      setPayingFor(null);
    };
    return <>
      <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:12}}>Enhancement #17 — Phase 1. No payment gateway wired up yet: this is the manual bridge — someone sends an InstaPay/Vodafone Cash/bank transfer directly, you confirm it arrived, and set their access below. Stays off until you're ready — flipping it on is the moment every non-comped, non-expired-free user everywhere starts seeing read-only mode.</div>
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <SmBtn label="⚙️ Manage" onClick={()=>setSubsView("manage")} color={subsView==="manage"?"#6366F1":"var(--po-dim)"} style={{flex:1}}/>
        <SmBtn label="📊 Statement" onClick={()=>setSubsView("statement")} color={subsView==="statement"?"#6366F1":"var(--po-dim)"} style={{flex:1}}/>
      </div>
      {subsView==="manage"&&<>
      <Card style={{marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div>
            <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)"}}>{subscriptionSettings.enabled?"🟢 Enforcement is ON":"⚪ Enforcement is OFF"}</div>
            <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>{activeCount} of {users.length-1} users currently active</div>
          </div>
          <SmBtn label={subscriptionSettings.enabled?"Turn Off":"Turn On"} color={subscriptionSettings.enabled?"#EF4444":"#34D399"} onClick={()=>{
            const next=!subscriptionSettings.enabled;
            if(next&&!window.confirm(`⚠️ Enable subscription enforcement now?\n\nEvery user without an active or comped subscription will immediately drop to read-only (can view, can't create/register/admin) — everywhere in the app, right away. Make sure you've set up whoever needs to stay active first.`))return;
            onSaveSubscriptionSettings&&onSaveSubscriptionSettings({...subscriptionSettings,enabled:next});
            onLogAudit&&onLogAudit("admin.subscriptionEnforcement", `Subscription enforcement turned ${next?"ON":"OFF"}`, null, null);
          }}/>
        </div>
        {/* Visible and editable regardless of on/off, so the admin can plan/document the start
            date before ever flipping enforcement on — not just an auto-stamp after the fact. */}
        <div style={{display:"flex",gap:6,alignItems:"center",paddingTop:10,borderTop:"0.5px solid var(--po-bdr)"}}>
          <span style={{fontSize:11,color:"var(--po-dim)",flexShrink:0}}>📅 Start date</span>
          <input type="date" value={startDateInput} onChange={e=>setStartDateInput(e.target.value)} className="po-inp" style={{flex:1,background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"6px 8px",color:"var(--po-text)",fontSize:12}}/>
          <SmBtn label="Save" onClick={()=>{if(!startDateInput)return;onSaveSubscriptionSettings&&onSaveSubscriptionSettings({...subscriptionSettings,enabledAt:new Date(startDateInput+"T00:00:00").toISOString()});onLogAudit&&onLogAudit("admin.subscriptionStartDate", `Subscription start date set to ${startDateInput}`, null, null);toast2("Start date saved ✓");}} color="#6366F1"/>
        </div>
      </Card>
      <Card style={{marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)",marginBottom:10}}>Pricing (EGP)</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          <Inp label="Monthly" value={monthlyPriceInput} onChange={setMonthlyPriceInput} type="number"/>
          <Inp label="Annual" value={annualPriceInput} onChange={setAnnualPriceInput} type="number"/>
        </div>
        <Btn label="Save Pricing" onClick={()=>{
          const m=parseFloat(monthlyPriceInput),a=parseFloat(annualPriceInput);
          if(isNaN(m)||isNaN(a))return;
          onSaveSubscriptionSettings&&onSaveSubscriptionSettings({...subscriptionSettings,monthlyPriceEGP:m,annualPriceEGP:a});
          onLogAudit&&onLogAudit("admin.subscriptionPricing", `Subscription pricing changed to ${m} EGP/month, ${a} EGP/year`, null, null);
          toast2("Pricing saved ✓");
        }} style={{width:"100%"}}/>
      </Card>
      <input value={subsSearch} onChange={e=>setSubsSearch(e.target.value)} placeholder="🔍 Search by name..." className="po-inp" style={{width:"100%",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box",marginBottom:12}}/>
      {shownUsers.map(u=>{
        const st=statusOf(u);
        return <Card key={u.id} style={{marginBottom:6,padding:"10px 12px"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <Av u={u} size={30}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{u.nickname}</div>
              <div style={{fontSize:11,color:st.color,marginTop:1}}>{st.label}</div>
            </div>
            <SmBtn label="💰 Payment" onClick={()=>{setPayingFor(o=>o===u.id?null:u.id);setEditingSubFor(null);}} color="#34D399"/>
            <SmBtn label={editingSubFor===u.id?"✕":"Set"} onClick={()=>{setEditingSubFor(o=>o===u.id?null:u.id);setSubExpiryInput("");setPayingFor(null);}} color="#6366F1"/>
          </div>
          {payingFor===u.id&&<div style={{marginTop:10,paddingTop:10,borderTop:"0.5px solid var(--po-bdr)"}}>
            <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8}}>Confirm a manual transfer received from {u.nickname} — extends from today, or from their current expiry if still active/in grace.</div>
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              <SmBtn label={`Monthly · ${subscriptionSettings.monthlyPriceEGP} EGP`} onClick={()=>setPayPlan("monthly")} color={payPlan==="monthly"?"#34D399":"var(--po-dim)"} style={{flex:1}}/>
              <SmBtn label={`Annual · ${subscriptionSettings.annualPriceEGP} EGP`} onClick={()=>setPayPlan("annual")} color={payPlan==="annual"?"#34D399":"var(--po-dim)"} style={{flex:1}}/>
            </div>
            <select value={payMethod} onChange={e=>setPayMethod(e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13,marginBottom:8,boxSizing:"border-box"}}>
              <option>InstaPay</option><option>Vodafone Cash</option><option>Bank Transfer</option><option>Cash</option><option>Other</option>
            </select>
            <Btn label={`✓ Confirm ${payPlan==="annual"?"Annual":"Monthly"} Payment`} primary onClick={()=>startPayment(u,payPlan)} style={{width:"100%"}}/>
          </div>}
          {editingSubFor===u.id&&<div style={{marginTop:10,paddingTop:10,borderTop:"0.5px solid var(--po-bdr)"}}>
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              <input type="date" value={subExpiryInput} onChange={e=>setSubExpiryInput(e.target.value)} className="po-inp" style={{flex:1,background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13}}/>
              <SmBtn label="Set Active Until" onClick={()=>{if(!subExpiryInput)return;onSetUserSubscription&&onSetUserSubscription(u.id,{status:"active",expiresAt:new Date(subExpiryInput+"T23:59:59").toISOString()});setEditingSubFor(null);}} color="#34D399"/>
            </div>
            <div style={{display:"flex",gap:6}}>
              <SmBtn label="✓ Comp (no expiry)" onClick={()=>{onSetUserSubscription&&onSetUserSubscription(u.id,{status:"comped"});setEditingSubFor(null);}} color="#FBBF24" style={{flex:1}}/>
              <SmBtn label="Clear" onClick={()=>{if(window.confirm(`Clear ${u.nickname}'s subscription status?`)){onSetUserSubscription&&onSetUserSubscription(u.id,{status:"none"});setEditingSubFor(null);}}} color="#EF4444" style={{flex:1}}/>
            </div>
          </div>}
        </Card>;
      })}
      </>}
      {subsView==="statement"&&(()=>{
        const txns=[...subscriptionTransactions].sort((a,b)=>new Date(b.confirmedAt)-new Date(a.confirmedAt));
        const now=new Date();
        const inMonth=t=>{const d=new Date(t.confirmedAt);return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth();};
        const inYear=t=>new Date(t.confirmedAt).getFullYear()===now.getFullYear();
        const sum=arr=>arr.reduce((s,t)=>s+(t.amount||0),0);
        const totals=[["All time",sum(txns)],["This year",sum(txns.filter(inYear))],["This month",sum(txns.filter(inMonth))],["Transactions",txns.length]];
        return <>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            {totals.map(([l,v])=><Card key={l} style={{textAlign:"center",padding:"12px 8px"}}>
              <div style={{fontSize:18,fontWeight:700,color:"var(--po-text)"}}>{l==="Transactions"?v:`${v.toLocaleString()} EGP`}</div>
              <div style={{fontSize:10,color:"var(--po-dim)",marginTop:2}}>{l}</div>
            </Card>)}
          </div>
          {txns.length===0&&<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No confirmed payments yet.</div></Card>}
          {txns.map(t=>{
            const u=users.find(u=>u.id===t.userId);
            return <Card key={t.id} style={{marginBottom:6,padding:"10px 12px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{u?.nickname||t.userNickname||"(deleted user)"}</div>
                  <div style={{fontSize:11,color:"var(--po-dim)",marginTop:1}}>{t.plan==="annual"?"Annual":"Monthly"} · {t.method} · confirmed by {t.confirmedBy}</div>
                  <div style={{fontSize:10,color:"var(--po-dim)",marginTop:1}}>{timeAgo(t.confirmedAt)}</div>
                </div>
                <div style={{fontSize:14,fontWeight:700,color:"#34D399",flexShrink:0}}>+{t.amount} EGP</div>
              </div>
            </Card>;
          })}
        </>;
      })()}
    </>;
  })()}

  {tab==="audit"&&(()=>{
    const aq=auditSearch.trim().toLowerCase();
    const actionOpts=[...new Set(auditLog.map(e=>e.action).filter(Boolean))].sort();
    const versionOpts=[...new Set(auditLog.map(e=>e.appVersion).filter(Boolean))].sort().reverse();
    const actorOpts=[...new Set(auditLog.map(e=>e.actorName).filter(Boolean))].sort();
    let filtered=auditLog
      .filter(e=>!aq||e.actorName?.toLowerCase().includes(aq)||e.summary?.toLowerCase().includes(aq)||e.action?.toLowerCase().includes(aq))
      .filter(e=>!auditActionFilter||e.action===auditActionFilter)
      .filter(e=>!auditVersionFilter||e.appVersion===auditVersionFilter)
      .filter(e=>!auditActorFilter||e.actorName===auditActorFilter);
    const {key:sortKey,dir:sortDir}=auditSort;
    filtered=[...filtered].sort((a,b)=>{
      const av=a[sortKey]??"", bv=b[sortKey]??"";
      if(av<bv) return sortDir==="asc"?-1:1;
      if(av>bv) return sortDir==="asc"?1:-1;
      return 0;
    });
    const toggleSort=k=>setAuditSort(s=>s.key===k?{key:k,dir:s.dir==="asc"?"desc":"asc"}:{key:k,dir:k==="ts"?"desc":"asc"});
    const SortTh=({k,label})=><th onClick={()=>toggleSort(k)} style={{cursor:"pointer",padding:"8px 10px",textAlign:"left",fontSize:11,fontWeight:700,color:"var(--po-dim)",borderBottom:"0.5px solid var(--po-bdr)",whiteSpace:"nowrap",userSelect:"none"}}>{label}{sortKey===k?(sortDir==="asc"?" ▲":" ▼"):""}</th>;
    // Today expanded by default, everything older starts collapsed — the list can run to 200
    // rows, so this keeps the screen useful without hiding anything (just a tap away).
    const BUCKET_ORDER=["Today","Yesterday","This week","This month","This year","Old"];
    const bucketOf=(iso)=>{
      const d=new Date(iso), now=new Date();
      const startOfDay=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate());
      const daysAgo=Math.round((startOfDay(now)-startOfDay(d))/86400000);
      if(daysAgo<=0) return "Today";
      if(daysAgo===1) return "Yesterday";
      if(daysAgo<=7) return "This week";
      if(d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()) return "This month";
      if(d.getFullYear()===now.getFullYear()) return "This year";
      return "Old";
    };
    const buckets={};
    filtered.forEach(e=>{ const b=bucketOf(e.ts); (buckets[b]=buckets[b]||[]).push(e); });
    // "Concerned object" — what the entry is actually about, resolved from the targetType/
    // targetId already stored on every logAudit() call. Falls back to a plain, non-clickable
    // label (not null) for a type this resolver doesn't know how to open yet, or a target that
    // no longer exists (deleted user/community/event) — never a dead link.
    const resolveAuditTarget = e => {
      if (!e.targetType || e.targetId==null) return null;
      if (e.targetType==="user") {
        const u=users.find(u=>u.id===e.targetId);
        return u ? {icon:"👤",label:u.nickname,onClick:()=>onViewProfile&&onViewProfile(u.id)} : {icon:"👤",label:"(deleted user)",onClick:null};
      }
      if (e.targetType==="community") {
        const c=comms.find(c=>c.id===e.targetId);
        return c ? {icon:"👥",label:c.name,onClick:()=>onOpenCommunity&&onOpenCommunity(c.id)} : {icon:"👥",label:"(deleted community)",onClick:null};
      }
      if (e.targetType==="event") {
        for (const c of comms) {
          const ev=c.events.find(ev=>ev.id===e.targetId);
          if (ev) return {icon:"🎾",label:ev.name,onClick:()=>onOpenEvent&&onOpenEvent(c.id,ev.id)};
        }
        return {icon:"🎾",label:"(deleted event)",onClick:null};
      }
      if (e.targetType==="venue") {
        const v=venues.find(v=>v.id===e.targetId);
        return {icon:"🏟",label:v?v.name:"(deleted venue)",onClick:null};
      }
      if (e.targetType==="backup") return {icon:"💾",label:"Backup",onClick:()=>setTab("data")};
      return {icon:"📄",label:`${e.targetType} #${e.targetId}`,onClick:null};
    };
    return <>
      <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:12}}>Oversight log of admin-level and sensitive actions — who did what, and when. Shows the most recent {auditLog.length} entries (up to 200). Routine browsing isn't logged, only writes that change or affect someone else's data.</div>
      <div style={{display:"flex",gap:6,marginBottom:8}}>
        <input value={auditSearch} onChange={e=>setAuditSearch(e.target.value)} placeholder="🔍 Search by person or action..." className="po-inp" style={{flex:1,minWidth:0,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}/>
        <div onClick={()=>!auditRefreshing&&onRefreshAudit&&onRefreshAudit()} title="Refresh" style={{width:38,height:38,flexShrink:0,borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-card)",display:"flex",alignItems:"center",justifyContent:"center",cursor:auditRefreshing?"default":"pointer",fontSize:16,opacity:auditRefreshing?0.4:1}}>🔄</div>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
        <select value={auditActorFilter} onChange={e=>setAuditActorFilter(e.target.value)} className="po-inp" style={{flex:"1 1 120px",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 8px",color:"var(--po-text)",fontSize:12}}>
          <option value="">All users</option>
          {actorOpts.map(a=><option key={a} value={a}>{a}</option>)}
        </select>
        <select value={auditActionFilter} onChange={e=>setAuditActionFilter(e.target.value)} className="po-inp" style={{flex:"1 1 130px",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 8px",color:"var(--po-text)",fontSize:12}}>
          <option value="">All actions</option>
          {actionOpts.map(a=><option key={a} value={a}>{a}</option>)}
        </select>
        <select value={auditVersionFilter} onChange={e=>setAuditVersionFilter(e.target.value)} className="po-inp" style={{flex:"1 1 100px",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 8px",color:"var(--po-text)",fontSize:12}}>
          <option value="">All versions</option>
          {versionOpts.map(v=><option key={v} value={v}>{v}</option>)}
        </select>
        {(auditActionFilter||auditVersionFilter||auditActorFilter)&&<div onClick={()=>{setAuditActionFilter("");setAuditVersionFilter("");setAuditActorFilter("");}} style={{fontSize:11,color:"#6366F1",cursor:"pointer",display:"flex",alignItems:"center",padding:"0 6px"}}>Clear ✕</div>}
      </div>
      {filtered.length===0&&<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>{auditLog.length===0?"No activity logged yet.":"No matches"}</div></Card>}
      {filtered.length>0&&<div style={{overflowX:"auto",WebkitOverflowScrolling:"touch",border:"0.5px solid var(--po-bdr)",borderRadius:8}}>
        <table style={{borderCollapse:"collapse",width:"100%",minWidth:540,tableLayout:"fixed"}}>
          <colgroup><col style={{width:52}}/><col style={{width:64}}/><col style={{width:80}}/><col style={{width:140}}/><col style={{width:90}}/><col style={{width:88}}/></colgroup>
          <thead><tr>
            <SortTh k="ts" label="Time"/>
            <SortTh k="actorName" label="Actor"/>
            <SortTh k="action" label="Action"/>
            <th style={{padding:"8px 10px",textAlign:"left",fontSize:11,fontWeight:700,color:"var(--po-dim)",borderBottom:"0.5px solid var(--po-bdr)"}}>Summary</th>
            <th style={{padding:"8px 10px",textAlign:"left",fontSize:11,fontWeight:700,color:"var(--po-dim)",borderBottom:"0.5px solid var(--po-bdr)"}}>Object</th>
            <SortTh k="appVersion" label="Ver · Platform"/>
          </tr></thead>
          <tbody>
            {BUCKET_ORDER.filter(b=>buckets[b]?.length).map(b=>{
              const items=buckets[b], isOpen=auditBucketsOpen[b];
              return <React.Fragment key={b}>
                <tr onClick={()=>setAuditBucketsOpen(o=>({...o,[b]:!o[b]}))} style={{cursor:"pointer",background:"var(--po-inp)"}}>
                  <td colSpan={6} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"var(--po-sub)",userSelect:"none"}}>
                    <span style={{display:"inline-block",transition:"transform 0.15s",transform:isOpen?"rotate(0deg)":"rotate(-90deg)",marginRight:6}}>⌄</span>
                    {b} ({items.length})
                  </td>
                </tr>
                {isOpen&&items.map(e=>{
                  const target=resolveAuditTarget(e);
                  return <tr key={e.id} style={{borderBottom:"0.5px solid var(--po-bdr)"}}>
                    <td style={{padding:"8px 6px",fontSize:10,color:"var(--po-dim)",whiteSpace:"nowrap"}} title={e.ts}>{timeAgo(e.ts)}</td>
                    <td style={{padding:"8px 6px",fontSize:11,color:"var(--po-text)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.actorName}</td>
                    <td style={{padding:"8px 6px"}}><span style={{fontSize:8.5,color:"var(--po-dim)",fontFamily:"monospace",background:"var(--po-bdr)",borderRadius:3,padding:"1px 3px",display:"inline-block",whiteSpace:"normal",wordBreak:"break-word"}}>{e.action}</span></td>
                    <td style={{padding:"8px 10px",fontSize:12,color:"var(--po-text)",whiteSpace:"normal",wordBreak:"break-word",lineHeight:1.35}}>{e.summary}</td>
                    <td style={{padding:"8px 6px",fontSize:11,whiteSpace:"normal",wordBreak:"break-word",lineHeight:1.3}}>
                      {!target?<span style={{color:"var(--po-dim)"}}>—</span>
                        :target.onClick?<span onClick={target.onClick} style={{color:"#6366F1",cursor:"pointer"}}>{target.icon} {target.label}</span>
                        :<span style={{color:"var(--po-dim)"}}>{target.icon} {target.label}</span>}
                    </td>
                    <td style={{padding:"8px 10px",fontSize:10,color:"var(--po-dim)",whiteSpace:"nowrap",lineHeight:1.4}}>
                      <div>{e.appVersion||"—"}</div>
                      <div>{e.platform?(e.platform==="Android"?"🤖 Android":"🌐 Web"):"—"}</div>
                    </td>
                  </tr>;
                })}
              </React.Fragment>;
            })}
          </tbody>
        </table>
      </div>}
      {auditHasMore&&filtered.length>0&&<SmBtn label={auditLoadingMore?"Loading…":"↓ Load older entries"} onClick={()=>!auditLoadingMore&&onLoadMoreAudit&&onLoadMoreAudit()} color="#6366F1" style={{width:"100%",marginTop:10,textAlign:"center",justifyContent:"center",display:"flex"}}/>}
    </>;
  })()}

  {tab==="users"&&<>
    <div style={{display:"flex",gap:6,marginBottom:12}}>
      <div onClick={()=>setLinkFilter(f=>f==="linked"?null:"linked")} style={{cursor:"pointer",opacity:linkFilter&&linkFilter!=="linked"?0.4:1}}><Bdg label={`🔗 ${linkedCount} linked${linkFilter==="linked"?" ✕":""}`} color="#34D399"/></div>
      <div onClick={()=>setLinkFilter(f=>f==="unlinked"?null:"unlinked")} style={{cursor:"pointer",opacity:linkFilter&&linkFilter!=="unlinked"?0.4:1}}><Bdg label={`◌ ${users.length-linkedCount} unlinked${linkFilter==="unlinked"?" ✕":""}`} color="#F59E0B"/></div>
    </div>
    <input value={userSearch} onChange={e=>setUserSearch(e.target.value)} placeholder="🔍 Search by name..." className="po-inp" style={{width:"100%",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box",marginBottom:12}}/>
    <Btn label="+ Add User" primary onClick={()=>{setShowAdd(true);setEditing(null);setNf({nickname:"",name:"",country:"مصر",gov:"القاهرة",area:"المعادي",usr:"50",phone:"",breakPref:"none",footballSkill:""});}} style={{width:"100%",marginBottom:12}}/>
    {showAdd&&<Card style={{marginBottom:12}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:10}}>{editing?"Edit User":"New User"}</div>
      {[["Nickname","nickname"],["Full Name","name"]].map(([l,k])=>
        <Inp key={k} label={l} value={nf[k]||""} onChange={v=>set(k,v)}/>
      )}
      <AreaSel country={nf.country} gov={nf.gov} area={nf.area} onChange={set} egypt={egypt}/>
      <Inp label="Phone" value={nf.phone||""} onChange={v=>set("phone",v)}/>
      <Inp label="Seed USR (0–100) — Padel" value={nf.usr} onChange={v=>set("usr",v)}/>
      {editing&&<div style={{fontSize:10,color:"var(--po-dim)",marginTop:-6,marginBottom:8}}>The baseline used in USR calculations — changing it won't move their current USR until you confirm a recalculation.</div>}
      <Drp label="Football Skill Level" value={nf.footballSkill||""} onChange={v=>set("footballSkill",v)} options={[{v:"",l:"Not Rated"},{v:"A",l:"A — Elite"},{v:"B",l:"B"},{v:"C",l:"C"},{v:"D",l:"D"},{v:"E",l:"E — Beginner"}]}/>
      <div style={{fontSize:10,color:"var(--po-dim)",marginTop:-6,marginBottom:8}}>Manually set, not computed — football has no match-result history to derive a rating from yet.</div>
      <Drp label="Break Preference" value={nf.breakPref||"none"} onChange={v=>set("breakPref",v)} options={[{v:"none",l:"No Preference"},{v:"early",l:"Prefer Early Break"},{v:"mid",l:"Prefer Mid-Event Break"},{v:"late",l:"Prefer Late Break"}]}/>
      <div style={{display:"flex",gap:8,marginTop:8}}>
        <Btn label="Save" primary onClick={()=>{
          if(!nf.nickname.trim())return;
          const newSeed = parseInt(nf.usr)||50;
          const prevSeed = editing ? (users.find(u=>u.id===editing)?.seedUsr ?? users.find(u=>u.id===editing)?.usr) : null;
          const ok = editing ? onEditUser(editing,{...nf,usr:newSeed}) : onAddUser({...nf,usr:newSeed});
          if(ok!==false){
            if(editing&&onRecalcUsr&&newSeed!==prevSeed&&window.confirm(`Seed USR changed from ${prevSeed} to ${newSeed}.\n\nRecalculate this player's current USR from their full history using the new seed now?`)){
              onRecalcUsr(editing);
            }
            setShowAdd(false);setEditing(null);
          }
        }} style={{flex:1}}/>
        <Btn label="Cancel" onClick={()=>{setShowAdd(false);setEditing(null);}} style={{flex:1}}/>
      </div>
    </Card>}
    {filteredUsers.length===0&&<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No players match "{userSearch}"</div></Card>}
    {filteredUsers.map(u=>{
      const isLinked = linkedUserIds.has(u.id);
      const hasHistory = u.usrHistory?.length>0;
      return <Card key={u.id} style={{marginBottom:8}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div onClick={()=>onViewProfile(u.id)} style={{cursor:"pointer"}}><Av u={u} size={36}/></div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
            <span style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{u.nickname}</span>
            <span style={{fontSize:10,color:"var(--po-dim)",fontFamily:"monospace",background:"var(--po-bdr)",borderRadius:3,padding:"0 4px"}}>#{u.id}</span>
            {SEEDED_USER_IDS.has(u.id)&&<SeedBadge/>}
            {u.isGuest&&<Bdg label="Guest" color="#F59E0B"/>}
            {u.suspended&&<Bdg label="🚫 Suspended" color="#EF4444"/>}
            <Bdg label={isLinked?"🔗 Linked":"◌ Unlinked"} color={isLinked?"#34D399":"#94A3B8"}/>
          </div>
          <div style={{fontSize:11,color:"var(--po-dim)"}}>{u.name||"—"} · USR {u.usr} · seed {u.seedUsr??u.usr}</div>
          <div style={{fontSize:10,color:"var(--po-dim)"}}>{u.area} · {u.gov} · {u.country||"مصر"}</div>
        </div>
        <div style={{position:"relative",flexShrink:0}} onClick={e=>e.stopPropagation()}>
          <div onClick={()=>setOpenUserMenu(o=>o===u.id?null:u.id)} style={{width:30,height:30,borderRadius:"50%",background:"var(--po-inp)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:"var(--po-dim)",cursor:"pointer"}}>⋮</div>
          {openUserMenu===u.id&&<div style={{position:"absolute",top:34,right:0,zIndex:10,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:6,display:"flex",flexDirection:"column",gap:4,minWidth:160,boxShadow:"0 4px 16px rgba(0,0,0,0.3)"}}>
            {onCreateInvite&&!isLinked&&<SmBtn label="🔗 Invite" onClick={()=>{setOpenUserMenu(null);const label=`Join Matchkeeper as ${u.nickname}`;setInviteUrl({url:`${INVITE_BASE_URL}/?invite=${onCreateInvite({targetUserId:u.id,label})}`,label});}} color="#34D399" style={{width:"100%"}}/>}
            {onUnlinkUser&&isLinked&&<SmBtn label="🔓 Unlink" onClick={()=>{setOpenUserMenu(null);if(window.confirm(`Unlink ${u.nickname} from their signed-in account?\n\nUse this if the wrong person got linked as this profile (e.g. a shared/forwarded invite link opened by someone else). This restores ${u.nickname} to unclaimed and clears the email/photo that got copied onto it — the account that was linked will be signed out of this profile and can claim/create their own next time they sign in.`))onUnlinkUser(u.id);}} color="#EF4444" style={{width:"100%"}}/>}
            <SmBtn label="✏️ Edit" onClick={()=>{setOpenUserMenu(null);setEditing(u.id);setNf({nickname:u.nickname,name:u.name||"",country:u.country||"مصر",gov:u.gov||"القاهرة",area:u.area||"",usr:String(u.seedUsr??u.usr??50),phone:u.phone||"",breakPref:u.breakPref||"none",footballSkill:u.footballSkill||""});setShowAdd(true);}} color="#F59E0B" style={{width:"100%"}}/>
            {/* A player who has actually played (usrHistory.length>0) can never be fully
                deleted — their history line is permanent. Suspend is the only option for
                them: reversible, blocks the account from being used, touches nothing else.
                A user with no play history (never got past joining/registering) can still be
                deleted outright — nothing of substance would be lost. */}
            {hasHistory
              ? (u.id!==1&&<SmBtn label={u.suspended?"▶ Unsuspend":"⏸ Suspend"} onClick={()=>{
                  setOpenUserMenu(null);
                  const msg = u.suspended
                    ? `Unsuspend ${u.nickname}?\n\nThey'll be able to sign in and use the app again.`
                    : `Suspend ${u.nickname}?\n\nThey won't be able to sign in or use the app until unsuspended. All their match history, stats, and team/event records stay exactly as they are — nothing is deleted or hidden from other players' views. This player has real match history, so they can't be permanently deleted — suspend is the only way to disable their account.`;
                  if(window.confirm(msg))onSuspendUser(u.id);
                }} color={u.suspended?"#34D399":"#F59E0B"} style={{width:"100%"}}/>)
              : (!SEEDED_USER_IDS.has(u.id)&&<SmBtn label="🗑 Delete" onClick={()=>{setOpenUserMenu(null);if(window.confirm(`Delete ${u.nickname}?\nThis cannot be undone.`))onDeleteUser(u.id);}} color="#EF4444" style={{width:"100%"}}/>)}
          </div>}
        </div>
      </div>
    </Card>;})}
    {inviteUrl&&<InviteModal url={inviteUrl.url} label={inviteUrl.label} onClose={()=>setInviteUrl(null)}/>}
  </>}

  {tab==="archived"&&<>
    {allEvents.filter(ev=>ev.archived).length===0
      ?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No archived events.</div></Card>
      :allEvents.filter(ev=>ev.archived).map(ev=><Card key={`${ev.communityId}-${ev.id}`} style={{marginBottom:8}}>
        <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:4}}>{ev.commName} · #{ev.id}{SEEDED_EVENT_IDS.has(ev.id)&&<> <SeedBadge/></>}</div>
        <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{ev.name}</div>
        <div style={{fontSize:11,color:"var(--po-dim)"}}>{fmtD(ev.date)} · {ev.type}</div>
      </Card>)}
  </>}

  {/* Platform-Admin-only visibility into soft-deleted events — invisible to everyone else,
      including the community's own admins. Not the same list as Archived: archived events are
      still visible to the community, these are not. */}
  {tab==="deleted"&&<>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:12}}>Deleted events are hidden from everyone (including the community's own admins) but never actually erased — only you can see and restore them here.</div>
    {allEvents.filter(ev=>ev.deleted).length===0
      ?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No deleted events.</div></Card>
      :allEvents.filter(ev=>ev.deleted).sort((a,b)=>new Date(b.deletedAt||0)-new Date(a.deletedAt||0)).map(ev=><Card key={`${ev.communityId}-${ev.id}`} style={{marginBottom:8}}>
        <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:4}}>{ev.commName} · #{ev.id}{SEEDED_EVENT_IDS.has(ev.id)&&<> <SeedBadge/></>}</div>
        <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{ev.name}</div>
        <div style={{fontSize:11,color:"var(--po-dim)"}}>{fmtD(ev.date)} · {ev.type}</div>
        <div style={{fontSize:11,color:"#EF4444",marginTop:4}}>🗑 Deleted by {ev.deletedByName||"—"} · {ev.deletedAt?timeAgo(ev.deletedAt):"—"}</div>
        <SmBtn label="↩️ Restore" onClick={()=>onRestoreDeletedEvent&&onRestoreDeletedEvent(ev.communityId,ev.id)} color="#34D399" style={{width:"100%",marginTop:8}}/>
      </Card>)}
  </>}
  {tab==="areas"&&(()=>{
    const countries=Object.keys(egypt||{});
    const country=selectedCountry&&countries.includes(selectedCountry)?selectedCountry:countries[0];
    const govs=country?(egypt||{})[country]||{}:{};
    return <>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:12}}>Countries, governorates and areas used in location pickers everywhere (players, communities, venues). Changes apply immediately across the app.</div>
    <Card style={{marginBottom:12}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:10}}>Add Country</div>
      <div style={{display:"flex",gap:8}}>
        <input value={newCountryName} onChange={e=>setNewCountryName(e.target.value)} placeholder="e.g. الإمارات" className="po-inp" style={{flex:1,background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}/>
        <Btn label="+ Add" primary onClick={()=>{
          const name=newCountryName.trim();
          if(!name||(egypt||{})[name])return;
          onSaveEgypt({...(egypt||{}),[name]:{}});
          setNewCountryName("");
          setSelectedCountry(name);
        }}/>
      </div>
    </Card>
    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
      {countries.map(c=><div key={c} onClick={()=>setSelectedCountry(c)} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:20,cursor:"pointer",border:`1.5px solid ${c===country?"#6366F1":"var(--po-bdr)"}`,background:c===country?"#6366F122":"var(--po-inp)",fontSize:12,fontWeight:600,color:c===country?"#A5B4FC":"var(--po-dim)"}}>
        {c}
        <span onClick={e=>{e.stopPropagation();
          const govCount=Object.keys((egypt||{})[c]||{}).length;
          if(countries.length<=1){window.alert("Can't delete the last remaining country.");return;}
          if(window.confirm(`Delete country "${c}" and its ${govCount} governorate(s)?\n\nAny existing communities/venues/players already set to this country keep their saved value — it just won't be selectable for new ones.`)){
            const n={...egypt};delete n[c];onSaveEgypt(n);
            if(c===country)setSelectedCountry(Object.keys(n)[0]||null);
          }
        }} style={{cursor:"pointer",color:"#EF4444",fontWeight:700}}>×</span>
      </div>)}
    </div>
    {country&&<>
      <Card style={{marginBottom:12}}>
        <div style={{fontWeight:600,fontSize:13,marginBottom:10}}>Add Governorate in {country}</div>
        <div style={{display:"flex",gap:8}}>
          <input value={newGovName} onChange={e=>setNewGovName(e.target.value)} placeholder="e.g. أسوان" className="po-inp" style={{flex:1,background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}/>
          <Btn label="+ Add" primary onClick={()=>{
            const name=newGovName.trim();
            if(!name||govs[name])return;
            onSaveEgypt({...egypt,[country]:{...govs,[name]:[]}});
            setNewGovName("");
          }}/>
        </div>
      </Card>
      {Object.keys(govs).map(gov=>{
        const areas=govs[gov]||[];
        const inputVal=areaInputs[gov]||"";
        return <Card key={gov} style={{marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{gov}</div>
            <SmBtn label="🗑 Delete" color="#EF4444" onClick={()=>{
              if(window.confirm(`Delete governorate "${gov}" and its ${areas.length} area(s)?\n\nAny existing communities/venues/players already set to this governorate keep their saved value — it just won't be selectable for new ones.`)){
                const n={...govs};delete n[gov];onSaveEgypt({...egypt,[country]:n});
              }
            }}/>
          </div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {areas.length===0&&<div style={{fontSize:12,color:"var(--po-dim)"}}>No areas yet.</div>}
            {areas.map(a=><div key={a} style={{display:"flex",alignItems:"center",gap:4,background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:16,padding:"5px 6px 5px 12px",fontSize:12,color:"var(--po-text)"}}>
              {a}
              <span onClick={()=>{
                if(window.confirm(`Remove area "${a}" from ${gov}?`)){
                  onSaveEgypt({...egypt,[country]:{...govs,[gov]:areas.filter(x=>x!==a)}});
                }
              }} style={{cursor:"pointer",color:"#EF4444",fontWeight:700,padding:"0 4px"}}>×</span>
            </div>)}
          </div>
          <div style={{display:"flex",gap:8}}>
            <input value={inputVal} onChange={e=>setAreaInputs(p=>({...p,[gov]:e.target.value}))} placeholder="New area name" className="po-inp" style={{flex:1,background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box"}}/>
            <SmBtn label="+ Add" color="#6366F1" onClick={()=>{
              const name=inputVal.trim();
              if(!name||areas.includes(name))return;
              onSaveEgypt({...egypt,[country]:{...govs,[gov]:[...areas,name]}});
              setAreaInputs(p=>({...p,[gov]:""}));
            }}/>
          </div>
        </Card>;
      })}
    </>}
  </>;
  })()}

  {tab==="data"&&<>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:12}}>These tools affect every player and event in the community. Only Platform Admins can see this tab.</div>

    <ST>Manual Backup</ST>
    <Card style={{marginBottom:12}}>
      <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:10}}>Saves a snapshot of every player, community and event right now. Takes a few seconds. Use this before doing anything risky.</div>
      <Btn label="📸 Backup Now" primary onClick={onCreateBackup} style={{width:"100%"}}/>
    </Card>

    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
      <ST style={{marginBottom:0}}>Recent Backups</ST>
      <SmBtn label={backupsLoading?"Loading…":"↻ Refresh"} onClick={onRefreshBackups} color="#6366F1"/>
    </div>
    <CollapsibleSection label={`📦 ${backups.length} backup${backups.length===1?"":"s"}`} defaultOpen={false}>
    {backups.length===0
      ? <Card style={{marginBottom:16}}><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>{backupsLoading?"Loading…":"No backups yet — tap \"Backup Now\" to create the first one."}</div></Card>
      : backups.map(b=><Card key={b.id} style={{marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:18}}>📦</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{timeAgo(b.createdAt)}</div>
              <div style={{fontSize:11,color:"var(--po-dim)"}}>by {b.createdBy||"unknown"} · {b.version||"—"} · {fmtBytes(new Blob([b.value||""]).size)}</div>
            </div>
            <SmBtn label="Restore" onClick={()=>{if(window.confirm(`Restore this backup from ${timeAgo(b.createdAt)}?\n\nThis replaces ALL current players, communities and events with what was saved at that moment. Anything added or changed since then will be lost unless you back it up first.`))onRestoreBackup(b.id);}} color="#F59E0B"/>
            <SmBtn label="🗑" onClick={()=>{if(window.confirm("Delete this backup? This cannot be undone."))onDeleteBackup(b.id);}} color="#EF4444"/>
          </div>
        </Card>)}
    </CollapsibleSection>

    <ST>Other Tools</ST>
    <Card style={{padding:0,overflow:"hidden",marginBottom:16}}>
      <div onClick={onExport} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer",borderBottom:"0.5px solid var(--po-bdr)"}}>
        <span style={{fontSize:18}}>💾</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Export Data</span>
        <span style={{fontSize:12,color:"var(--po-dim)"}}>Download JSON</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
      <div onClick={()=>{if(window.confirm("Repair duplicate event IDs?\n\nThis scans all events and reassigns new unique IDs to any duplicates found, without deleting any data. Safe to run anytime."))onRepairIds();}} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer",borderBottom:"0.5px solid var(--po-bdr)"}}>
        <span style={{fontSize:18}}>🔧</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Repair Data (Event IDs & Venues)</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
      <div onClick={()=>{if(window.confirm("Backfill guest memberships?\n\nThis scans every event for guests added before this feature existed, and adds any missing ones to their community's member list. Safe to run anytime — never removes or duplicates anything."))onBackfillGuests();}} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer",borderBottom:"0.5px solid var(--po-bdr)"}}>
        <span style={{fontSize:18}}>🧑‍🤝‍🧑</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Backfill Guest Memberships</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
      <div onClick={()=>{if(window.confirm(`Clean orphaned account links?\n\nFound ${orphanedLinksCount} email/Google login(s) still "claimed" by a deleted user — this releases them so that person can sign in fresh again. Safe to run anytime.`))onCleanOrphanedLinks();}} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:orphanedLinksCount>0?"pointer":"default",borderBottom:"0.5px solid var(--po-bdr)",opacity:orphanedLinksCount>0?1:0.5}}>
        <span style={{fontSize:18}}>🧹</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Clean Orphaned Account Links{orphanedLinksCount>0?` (${orphanedLinksCount})`:""}</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
      <div onClick={()=>setShowDupEmails(o=>!o)} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:dupEmailGroups.length>0?"pointer":"default",borderBottom:"0.5px solid var(--po-bdr)",opacity:dupEmailGroups.length>0?1:0.5}}>
        <span style={{fontSize:18}}>📧</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Find Duplicate Emails{dupEmailGroups.length>0?` (${dupEmailGroups.length})`:""}</span>
        <span style={{color:"var(--po-dim)"}}>{showDupEmails?"⌄":"›"}</span>
      </div>
      <div onClick={()=>{if(window.confirm("⚠️ Factory Reset — Delete ALL data?\n\nThis permanently erases every community, event, venue, and player, replacing them with the original seed data.\n\nCreate a backup first if you want to keep anything. This cannot be undone."))onFactoryReset();}} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer",borderBottom:!IS_DEV_ENV?"0.5px solid var(--po-bdr)":"none"}}>
        <span style={{fontSize:18}}>⚠️</span>
        <span style={{flex:1,fontSize:14,color:"#EF4444"}}>Factory Reset (Erase Everything)</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
      {!IS_DEV_ENV&&<div onClick={()=>{if(cloningToDev)return;if(window.confirm("☁️ Clone production data to DEV?\n\nThis copies every current user, community, event, venue, and setting into the padelos-dev test environment, OVERWRITING everything currently there.\n\nThis does NOT touch production — it's a one-way copy TO the test environment only. You may be asked to sign into the DEV environment once (first time only)."))onCloneToDev();}} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:cloningToDev?"default":"pointer",opacity:cloningToDev?0.5:1,borderBottom:"0.5px solid var(--po-bdr)"}}>
        <span style={{fontSize:18}}>☁️</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>{cloningToDev?"Cloning to DEV…":"Clone Data to DEV"}</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>}
      <div onClick={()=>window.open(IS_DEV_ENV?"https://www.matchkeeper.app":"https://padelos-dev.web.app","_blank")} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer"}}>
        <span style={{fontSize:18}}>{IS_DEV_ENV?"🏭":"🧪"}</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>{IS_DEV_ENV?"Open Production":"Open DEV Environment"}</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
    </Card>
    {showDupEmails&&<Card style={{marginBottom:16}}>
      {dupEmailGroups.length===0&&<div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"10px 0"}}>No duplicate emails found ✓</div>}
      {dupEmailGroups.map(([email,us],gi)=><div key={email} style={{marginBottom:gi<dupEmailGroups.length-1?14:0,paddingBottom:gi<dupEmailGroups.length-1?14:0,borderBottom:gi<dupEmailGroups.length-1?"0.5px solid var(--po-bdr)":"none"}}>
        <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8,wordBreak:"break-all"}}>{email}</div>
        {us.map(u=>{
          const linked=Object.values(uidLinks||{}).includes(u.id);
          const footprint=hasFootprint(u.id);
          return <div key={u.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
            <Av u={u} size={26}/>
            <div style={{flex:1,minWidth:120}}>
              <div style={{fontSize:12,fontWeight:600,color:"var(--po-text)"}}>{u.nickname} <span style={{color:"var(--po-dim)",fontWeight:400}}>#{u.id}</span></div>
              <div style={{fontSize:10,color:"var(--po-dim)"}}>{linked?"🔗 Linked":"— Unlinked"} · {u.isGuest?"Guest":"Member"} · {footprint?"has history":"no history"}</div>
            </div>
            {!footprint&&us.filter(o=>o.id!==u.id).map(other=>
              <SmBtn key={other.id} label={`Merge into ${other.nickname}`} onClick={()=>{if(window.confirm(`Merge ${u.nickname} (#${u.id}) into ${other.nickname} (#${other.id})?\n\nThis moves ${u.nickname}'s login (if any) onto ${other.nickname}, then deletes the #${u.id} record. ${u.nickname} has no event/community history, so nothing else is lost.`))onMergeDuplicateUser&&onMergeDuplicateUser(other.id,u.id);}} color="#6366F1"/>
            )}
            {footprint&&<span style={{fontSize:10,color:"#F59E0B"}}>⚠️ has history — needs manual review, not auto-mergeable</span>}
          </div>;
        })}
      </div>)}
    </Card>}
  </>}
  </>;
}

function SettingsSc({user,users,comms,eventCommFilter,onSetEventCommFilter,dark,onToggleDark,onSendTestNotif,onBack}){
  const [pushStatus,setPushStatus] = useState("idle"); // idle | working | on | off | error
  const [pushErrDetail,setPushErrDetail] = useState("");
  // Separate from pushStatus: once Android reports "denied" (permanently blocked — no
  // dialog will ever show again), requestPermissions() is a dead end and the only way
  // forward is the system Settings screen, so the button needs to switch to that instead
  // of retrying a call that can't work anymore.
  const [pushBlocked,setPushBlocked] = useState(false);
  const [infoPanel,setInfoPanel] = useState(null); // 'faq' | 'terms' | null
  const admin = users.find(u=>u.id===1); // platform admin — used for Contact Support links
  const isNative = Capacitor.isNativePlatform();
  useEffect(() => {
    if (isNative) {
      PushNotifications.checkPermissions().then(res => {
        setPushStatus(res.receive === "granted" ? "on" : "error");
        setPushBlocked(res.receive === "denied");
        if (res.receive !== "granted") setPushErrDetail("Notifications permission not granted — enable it for Matchkeeper in your phone's system Settings app");
      });
    } else if ("Notification" in window) {
      // Reflects whatever the auto-prompt-on-login already resolved (App.jsx's autoPushTriedRef
      // effect) — without this, a web user who was already silently enabled at launch would
      // still see "Enable" here as if nothing had happened.
      if (Notification.permission === "granted") setPushStatus("on");
      else if (Notification.permission === "denied") { setPushStatus("error"); setPushBlocked(true); setPushErrDetail("Browser notification permission was denied"); }
    }
  }, [isNative]);
  const [locStatus,setLocStatus] = useState("idle"); // idle | working | on | off | error
  useEffect(() => {
    if (!isNative) return;
    Geolocation.checkPermissions().then(res => {
      setLocStatus(res.location === "granted" ? "on" : "error");
    }).catch(()=>setLocStatus("error"));
  }, [isNative]);
  const enableLoc = async () => {
    setLocStatus("working");
    try {
      const res = await Geolocation.requestPermissions();
      setLocStatus(res.location === "granted" ? "on" : "error");
    } catch(e) { console.log("Location permission request failed", e); setLocStatus("error"); }
  };
  const enablePush = async () => {
    setPushStatus("working");
    const res = await enablePushNotifications(user.id);
    setPushStatus(res.ok ? "on" : "error");
    setPushBlocked(res.permState === "denied");
    setPushErrDetail(res.ok ? "" : (res.reason==="denied"?"Browser notification permission was denied":res.reason==="unsupported"?"This browser doesn't support push notifications":res.reason==="no-token"?"Couldn't get a push token — try again":(res.detail||"Unknown error")));
  };
  const openAppSettings = () => {
    NativeSettings.open({optionAndroid: AndroidSettings.ApplicationDetails, optionIOS: IOSSettings.App}).catch(e=>console.log("openAppSettings failed", e));
  };
  return <><BBtn onBack={onBack} label="Back"/>
    <div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>Settings</div>
    <ST>Notifications</ST>
    <Card style={{marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <span style={{fontSize:20}}>🔔</span>
        <div style={{flex:1}}>
          <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)"}}>Push Notifications</div>
          <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>
            {pushStatus==="on"?"Enabled on this device ✓":pushStatus==="error"?`${isNative?"Off — ":"Couldn't enable — "}${pushErrDetail}`:pushStatus==="working"?"Setting up…":isNative?"Checking…":"Get notified even when the app is closed"}
          </div>
        </div>
        {(!isNative||pushStatus==="error")&&<Btn label={pushStatus==="on"?"✓ On":pushStatus==="error"?(pushBlocked?"Open Settings":"Try Again"):"Enable"} primary={pushStatus!=="on"} onClick={(isNative&&pushBlocked)?openAppSettings:enablePush} style={{flexShrink:0}}/>}
        {isNative&&pushStatus==="on"&&<span style={{fontSize:18}}>✅</span>}
      </div>
      {pushStatus==="on"&&<div onClick={onSendTestNotif} style={{marginTop:12,paddingTop:12,borderTop:"0.5px solid var(--po-bdr)",textAlign:"center",fontSize:12,fontWeight:600,color:"#6366F1",cursor:"pointer"}}>Send myself a test notification</div>}
    </Card>
    {isNative&&<Card style={{marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <span style={{fontSize:20}}>📍</span>
        <div style={{flex:1}}>
          <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)"}}>Location Access</div>
          <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>
            {locStatus==="on"?"Enabled on this device ✓":locStatus==="error"?"Off — needed for venue distance & directions":locStatus==="working"?"Requesting…":"Checking…"}
          </div>
        </div>
        {(locStatus==="error"||locStatus==="off")&&<Btn label="Enable" primary onClick={enableLoc} style={{flexShrink:0}}/>}
        {locStatus==="on"&&<span style={{fontSize:18}}>✅</span>}
      </div>
    </Card>}
    <ST>Preferences</ST>
    <Card style={{padding:0,overflow:"hidden"}}>
      {/* Dark Mode Toggle */}
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:"0.5px solid var(--po-bdr)"}}>
        <span style={{fontSize:18}}>🌙</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Dark Mode</span>
        <div onClick={onToggleDark} style={{width:44,height:24,borderRadius:12,background:dark?"#6366F1":"#334155",position:"relative",cursor:"pointer",transition:"background 0.2s",flexShrink:0}}>
          <div style={{position:"absolute",top:2,left:dark?20:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 4px #00000044"}}/>
        </div>
        <span style={{fontSize:12,color:"var(--po-dim)",minWidth:24}}>{dark?"On":"Off"}</span>
      </div>
      {[{i:"🌍",l:"Language",n:"English"},{i:"📍",l:"Home Area",n:user.area}].map((item,i)=><div key={item.l} onClick={item.l==="Language"?()=>alert("Arabic support is planned for a future update — English only for now."):undefined} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:i<1?"0.5px solid var(--po-bdr)":"none",cursor:"pointer"}}><span style={{fontSize:18}}>{item.i}</span><span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>{item.l}</span><span style={{fontSize:12,color:"var(--po-dim)"}}>{item.n}</span><span style={{color:"var(--po-dim)"}}>›</span></div>)}
    </Card>
        <ST>Support</ST>
    <Card style={{padding:0,overflow:"hidden"}}>
      <div onClick={()=>setInfoPanel(p=>p==="faq"?null:"faq")} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:"0.5px solid var(--po-bdr)",cursor:"pointer"}}>
        <span style={{fontSize:18}}>❓</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Help & FAQ</span>
        <span style={{color:"var(--po-dim)"}}>{infoPanel==="faq"?"▲":"▼"}</span>
      </div>
      {infoPanel==="faq"&&<div style={{padding:"4px 16px 16px",borderBottom:"0.5px solid var(--po-bdr)",fontSize:12,color:"var(--po-sub)",lineHeight:1.6}}>
        <b style={{color:"var(--po-text)"}}>How do I join an event?</b><br/>Open the event and tap "I'm In" to register.<br/><br/>
        <b style={{color:"var(--po-text)"}}>How is my USR calculated?</b><br/>It's the average of your last 5 event scores.<br/><br/>
        <b style={{color:"var(--po-text)"}}>What happens if I'm on a break?</b><br/>Break rounds still earn points — you'll be back on court soon.<br/><br/>
        <b style={{color:"var(--po-text)"}}>Can I cancel my registration?</b><br/>Yes, freely up to 24 hours before the event starts.
      </div>}
      <a href={admin?.phone?`https://wa.me/2${admin.phone.replace(/^0/,"")}`:undefined} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:"0.5px solid var(--po-bdr)",cursor:"pointer",textDecoration:"none"}}>
        <span style={{fontSize:18}}>💬</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>WhatsApp Support</span>
        <span style={{fontSize:12,color:"var(--po-dim)"}}>{admin?.phone||"—"}</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </a>
      <a href={admin?.email?`mailto:${admin.email}`:undefined} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:"0.5px solid var(--po-bdr)",cursor:"pointer",textDecoration:"none"}}>
        <span style={{fontSize:18}}>📩</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Email Support</span>
        <span style={{fontSize:12,color:"var(--po-dim)"}}>{admin?.email||"—"}</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </a>
      <div onClick={()=>setInfoPanel(p=>p==="terms"?null:"terms")} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer"}}>
        <span style={{fontSize:18}}>⚖️</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Terms & Privacy</span>
        <span style={{color:"var(--po-dim)"}}>{infoPanel==="terms"?"▲":"▼"}</span>
      </div>
      {infoPanel==="terms"&&<div style={{padding:"4px 16px 16px",fontSize:12,color:"var(--po-sub)",lineHeight:1.6}}>
        Matchkeeper is an internal tool used to organize your community's events. Your name, phone number, and match history are visible only to your community's admins and members — never sold or shared outside it. For any question about your data, contact the community admin directly above.
      </div>}
    </Card>
    <div style={{textAlign:"center",marginTop:24,fontSize:12,color:"var(--po-bdr)"}}>Matchkeeper {APP_VERSION}</div>
  </>;
}

function NotificationsSc({notifications,me,onBack,onMarkAllRead,onOpen}){
  const myNotifs = notifications.filter(n=>n.userId===me.id);
  const unreadCount = myNotifs.filter(n=>!n.read).length;
  const icons = {reg_open:"🎾",registered:"✓",event_updated:"✏️",reminder_h24:"⏰",reminder_h3:"⏰",reminder_h1:"⏰",announcement:"📢",eventAnnouncement:"📢",announcementReply:"💬",eventAnnouncementReply:"💬",waitlisted:"⏳",waitlistPromoted:"🎉",eventJoinRequest:"🙋",new_community:"🌱",new_event_platform:"🆕",eventRegistration:"🎾",inviteClaimed:"🔗"};
  return <><BBtn onBack={onBack} label="Back"/>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{fontSize:20}}>🔔</div>
        <div style={{fontSize:18,fontWeight:700,color:"var(--po-text)"}}>Notifications</div>
      </div>
      {unreadCount>0&&<SmBtn label={`Mark all read (${unreadCount})`} onClick={onMarkAllRead} color="#6366F1"/>}
    </div>
    {myNotifs.length===0
      ? <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>No notifications yet — event registrations, reminders and changes will show up here.</div></Card>
      : myNotifs.map(n=><Card key={n.id} style={{marginBottom:8,background:n.read?"var(--po-card)":"#6366F111",borderColor:n.read?"var(--po-bdr)":"#6366F144"}}>
          <div onClick={()=>onOpen(n)} style={{display:"flex",gap:10,alignItems:"flex-start",cursor:"pointer"}}>
            <div style={{fontSize:18,flexShrink:0}}>{icons[n.type]||"🔔"}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{n.title}</div>
                {!n.read&&<div style={{width:7,height:7,borderRadius:"50%",background:"#6366F1",flexShrink:0}}/>}
              </div>
              {n.body&&<div style={{fontSize:12,color:"var(--po-sub)",marginTop:3}}>{n.body}</div>}
              <div style={{fontSize:10,color:"var(--po-dim)",marginTop:5}}>{timeAgo(n.createdAt)}</div>
            </div>
          </div>
        </Card>)
    }
  </>;
}
