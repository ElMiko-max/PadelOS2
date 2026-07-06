import React, { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile,
} from "firebase/auth";
import { getFirestore, doc, setDoc, onSnapshot, collection } from "firebase/firestore";
import { getMessaging, getToken } from "firebase/messaging";

// ── Firebase (Phase 1: auth. Phase 2: Firestore replaces localStorage as the
// shared source of truth, so every device sees the same data in real time) ──
const firebaseConfig = {
  apiKey: "AIzaSyAldFg5ofZgXfgn_JSORc_uqkWuq5sGnIY",
  authDomain: "padelos-6f999.firebaseapp.com",
  projectId: "padelos-6f999",
  storageBucket: "padelos-6f999.firebasestorage.app",
  messagingSenderId: "807847071392",
  appId: "1:807847071392:web:b104417c7af0f5967f43c5",
  measurementId: "G-H6DLLT7Q7C",
};
const firebaseApp = initializeApp(firebaseConfig);
const VAPID_KEY = "BDjCxodsXfmCwv1dPsSgssbLFMh-K9vW4JRJb-zoOweEy6cxpXtPoHVDtkydh56tnDOdSJfa5FrY7cMLirnHXyw";
// Requests notification permission, registers the service worker, and saves this
// device's push token to Firestore so the Cloud Function knows where to send pushes.
async function enablePushNotifications(userId){
  try{
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return {ok:false, reason:"unsupported"};
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return {ok:false, reason:"denied"};
    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const messaging = getMessaging(firebaseApp);
    const token = await getToken(messaging, {vapidKey: VAPID_KEY, serviceWorkerRegistration: reg});
    if (!token) return {ok:false, reason:"no-token"};
    await setDoc(doc(db,"fcmTokens", String(userId)), {token, updatedAt:new Date().toISOString()});
    return {ok:true};
  }catch(e){ console.log("Push enable error", e); return {ok:false, reason:"error"}; }
}
const fbAuth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();


// ══════════════════════════════════════════════════════
//  PadelOS v7 – Clean rebuild with Closed Teams + Score Steppers
// ══════════════════════════════════════════════════════

const EGYPT = {
  "القاهرة": ["المعادي","مدينة نصر","الزمالك","مصر الجديدة","التجمع الخامس","القاهرة الجديدة","مدينتي","المقطم","شبرا","عين شمس"],
  "الجيزة":  ["الشيخ زايد","6 أكتوبر","المهندسين","العجوزة","الدقي","إمبابة"],
  "الإسكندرية": ["سموحة","لوران","المنتزه","سيدي جابر","محرم بك"],
  "القليوبية": ["شبرا الخيمة","بنها","قليوب","الخانكة"],
};
// ── App Version ──────────────────────────────────────
// Format: MAJOR.SESSION.PATCH
//   MAJOR   — stays 0 until v1.0 is formally declared launch-ready, then becomes 1
//   SESSION — increments once per work session (each time we sit down to make changes)
//   PATCH   — increments on every upload/push within that session, resets to 0 on a new session
const APP_VERSION = "V0.02.30";

const EVENT_TYPES = [
  { key:"open",         label:"Open Day",           desc:"Social · all levels · check-in" },
  { key:"closed_ind",   label:"Closed Individuals",  desc:"Competitive · rotating partners · ranked" },
  { key:"closed_teams", label:"Closed Teams",        desc:"Fixed teams · compete throughout" },
];

// ── CI scoring ────────────────────────────────────────
const courtPts = (court, tc) => tc - court + 1;
const breakPts = (tc) => Math.floor((tc + 1) / 2);

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
    eligible.sort((a, b) => { const rd = (ent[b.userId]-assigned[b.userId])-(ent[a.userId]-assigned[a.userId]); if (rd!==0) return rd; return (r-lastB[b.userId])-(r-lastB[a.userId]); });
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
  const playing=sorted.filter(p=>!onBreakIds.includes(p.userId)), onBreak=sorted.filter(p=>onBreakIds.includes(p.userId));
  const matches=[]; for(let c=0;c<courts;c++){const cp=playing.slice(c*4,(c+1)*4);if(cp.length<4)break;const pair=snakePairCI(cp);matches.push({court:c+1,teamA:pair.teamA,teamB:pair.teamB,winner:null});}
  return {rounds:[{round:1,matches,onBreak,onBreakIds}],courts,totalRounds,breakPlan,partnerHistory:{},sorted};
}
function genNextRoundCI(plan) {
  const {rounds,courts,breakPlan,sorted}=plan, ri=rounds.length, lastRound=rounds[ri-1];
  const ph=JSON.parse(JSON.stringify(plan.partnerHistory||{}));
  const lastRoundPairs=new Set();
  lastRound.matches.forEach(m=>{[m.teamA,m.teamB].forEach(team=>{const[a,b]=team;if(!a||!b)return;if(!ph[a.userId])ph[a.userId]={};if(!ph[b.userId])ph[b.userId]={};ph[a.userId][b.userId]=(ph[a.userId][b.userId]||0)+1;ph[b.userId][a.userId]=(ph[b.userId][a.userId]||0)+1;lastRoundPairs.add(pairKey(a.userId,b.userId));});});
  const newBreakIds=breakPlan[ri]||[], onBreak=sorted.filter(p=>newBreakIds.includes(p.userId)), buckets={};
  for(let c=1;c<=courts;c++) buckets[c]=[];
  lastRound.matches.forEach(m=>{if(!m.winner)return;const W=m.winner==="A"?m.teamA:m.teamB,L=m.winner==="A"?m.teamB:m.teamA;W.forEach(p=>buckets[Math.max(1,m.court-1)].push(p));L.forEach(p=>buckets[Math.min(courts,m.court+1)].push(p));});
  for(let c=1;c<=courts;c++) buckets[c]=buckets[c].filter(p=>!newBreakIds.includes(p.userId));
  const returning=sorted.filter(p=>(lastRound.onBreakIds||[]).includes(p.userId)&&!newBreakIds.includes(p.userId));
  returning.forEach(rp=>{const needy=Object.entries(buckets).filter(([,ps])=>ps.length<4).sort((a,b)=>a[1].length-b[1].length)[0];if(needy)buckets[parseInt(needy[0])].push(rp);});
  const matches=[]; for(let c=1;c<=courts;c++){const cp=buckets[c].slice(0,4);if(cp.length<4)continue;const pair=diversePair(cp,ph,lastRoundPairs);matches.push({court:c,teamA:pair.teamA,teamB:pair.teamB,winner:null});}
  return {...plan,rounds:[...rounds,{round:ri+1,matches,onBreak,onBreakIds:newBreakIds}],partnerHistory:ph};
}
function regenerateBreakPlan(plan, playedRounds) {
  // Keep breaks for played rounds as-is
  // Recompute breaks for future rounds respecting rules
  const players = plan.sorted;
  const courts = plan.courts;
  const totalRounds = plan.totalRounds;
  const bpr = Math.max(0, players.length - courts*4);
  if (bpr === 0) return plan.breakPlan;

  // Count breaks already assigned in played rounds
  const breakCounts = {};
  players.forEach(p => { breakCounts[p.userId] = 0; });
  const fixedPlan = plan.breakPlan.slice(0, playedRounds);
  fixedPlan.forEach(round => {
    round.forEach(uid => { if(breakCounts[uid]!==undefined) breakCounts[uid]++; });
  });

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

  // Remaining breaks needed per player
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
    const eligible = players.filter(p => remaining[p.userId] > 0);
    eligible.sort((a,b) => {
      const remDiff = remaining[b.userId] - remaining[a.userId];
      if (remDiff !== 0) return remDiff;
      const consecA = r - lastBreak[a.userId] <= 1 ? 1 : 0;
      const consecB = r - lastBreak[b.userId] <= 1 ? 1 : 0;
      if (consecA !== consecB) return consecA - consecB; // avoid consecutive
      return a.usr - b.usr; // lower USR priority
    });
    const noConsec = eligible.filter(p => r - lastBreak[p.userId] > 1);
    const pool = noConsec.length >= bpr ? noConsec : eligible;
    const chosen = pool.slice(0, bpr).map(p => p.userId);
    chosen.forEach(uid => { remaining[uid]--; lastBreak[uid] = r; });
    futurePlan.push(chosen);
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

function segmentPools(players) {
  const sorted = [...players].sort((a,b) => b.usr - a.usr);
  const N = sorted.length, numPools = Math.max(1, Math.floor(N/6));
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

function snakeTeams(poolPlayers, poolIdx, startId) {
  const sorted = [...poolPlayers].sort((a,b) => b.usr - a.usr);
  const teams = [], half = Math.floor(sorted.length/2);
  for (let i = 0; i < half; i++) {
    const p1=sorted[i], p2=sorted[sorted.length-1-i];
    teams.push({ id:startId+i, name:`Team ${startId+i}`, players:[p1,p2], avgUsr:Math.round((p1.usr+p2.usr)/2), poolIdx });
  }
  return teams;
}

function formCTTeams(players) {
  const pools = segmentPools(players); const teams = []; let teamId = 1;
  pools.forEach((pool,pi) => { const pt=snakeTeams(pool,pi,teamId); teams.push(...pt); teamId+=pt.length; });
  return { teams, pools, numPools:pools.length };
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
  const mins=(eh*60+em)-(sh*60+sm);
  return mins>0?mins:120;
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

function generateCTPlan(players, courts, format, ev=null, matchDuration=20) {
  const { teams, pools } = formCTTeams(players);
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
function buildCTBreakPlan(teams, courts, totalRounds, lockedRounds=[]) {
  const N = teams.length, bpr = Math.max(0, N - courts*2);
  if (bpr <= 0) return Array.from({length:totalRounds}, ()=>[]);
  const totalSlots = bpr * totalRounds, base = Math.floor(totalSlots/N), extras = totalSlots % N;
  const sorted = [...teams].sort((a,b) => (b.histBreaks||0) - (a.histBreaks||0));
  const ent = {}; sorted.forEach((t,i) => { ent[t.id] = base + (i<extras?1:0); });
  const assigned={}, lastB={}; teams.forEach(t => { assigned[t.id]=0; lastB[t.id]=-99; });

  // Seed assigned counts from locked rounds (already happened)
  lockedRounds.forEach((ids,ri)=>{
    (ids||[]).forEach(id=>{ if(assigned[id]!==undefined){assigned[id]++;lastB[id]=ri;} });
  });

  const plan = [...lockedRounds]; // start with locked rounds
  for (let r = lockedRounds.length; r < totalRounds; r++) {
    const eligible = teams.filter(t => assigned[t.id] < ent[t.id]);
    eligible.sort((a,b) => { const rd=(ent[b.id]-assigned[b.id])-(ent[a.id]-assigned[a.id]); if(rd!==0)return rd; return (r-lastB[b.id])-(r-lastB[a.id]); });
    const noC = eligible.filter(t => r-lastB[t.id]>1);
    const pool = noC.length>=bpr ? noC : eligible;
    const chosen = pool.slice(0,bpr).map(t=>t.id);
    chosen.forEach(id => { assigned[id]++; lastB[id]=r; });
    plan.push(chosen);
  }
  return plan;
}

// CT Ladder: generate next match
function genNextCTLadder(plan) {
  const { rounds, courts, sorted, breakPlan } = plan;
  const ri = rounds.length;
  const lastRound = rounds[ri-1];
  const newBreakIds = breakPlan[ri] || [];
  const onBreak = sorted.filter(t => newBreakIds.includes(t.id));

  // Court ladder: winners up, losers down
  const buckets = {}; for(let c=1;c<=courts;c++) buckets[c]=[];
  lastRound.matchesA.forEach(m => {
    if (!m.winner) return;
    const W = m.winner==="A"?m.teamA:m.teamB, L = m.winner==="A"?m.teamB:m.teamA;
    buckets[Math.max(1,m.court-1)].push(W);
    buckets[Math.min(courts,m.court+1)].push(L);
  });
  // Remove teams on break
  for(let c=1;c<=courts;c++) buckets[c]=buckets[c].filter(t=>!newBreakIds.includes(t.id));
  // Add returning teams
  const returning = sorted.filter(t=>(lastRound.onBreakIds||[]).includes(t.id)&&!newBreakIds.includes(t.id));
  returning.forEach(t => { const needy=Object.entries(buckets).filter(([,ts])=>ts.length<2).sort((a,b)=>a[1].length-b[1].length)[0]; if(needy)buckets[parseInt(needy[0])].push(t); });

  const matches=[];
  for(let c=1;c<=courts;c++) {
    const cp=buckets[c].slice(0,2);
    if(cp.length>=2) matches.push({court:c,teamA:cp[0],teamB:cp[1],winner:null,scoreA:0,scoreB:0});
  }
  return {...plan, rounds:[...rounds,{roundNum:ri+1,type:"ladder",matchesA:matches,matchesB:[],onBreak,onBreakIds:newBreakIds}]};
}

// CT Ladder scoring
const ctLadderCourtPts = (court, tc) => tc - court + 1;
const ctLadderBreakPts = (tc) => Math.floor((tc+1)/2);

// Weighted USR calculation: CI events weight=1.0, CT events weight=0.5
// Rolling window = last entries until sum(weights) >= 5.0
// Seed entries (from initial USR) always weight=1.0
function calcWeightedUSR(usrHistory, seedUsr){
  if(!usrHistory||usrHistory.length===0) return seedUsr;
  // Build the working list newest-first
  const hist=[...usrHistory].reverse();
  let weightedSum=0, totalWeight=0;
  for(const h of hist){
    if(totalWeight>=5.0) break;
    const w = h.type==="ct" ? 0.5 : 1.0;
    const remaining = 5.0 - totalWeight;
    const actualW = Math.min(w, remaining);
    weightedSum += h.pes * actualW;
    totalWeight += actualW;
  }
  // Fill remaining weight with seed
  if(totalWeight < 5.0){
    weightedSum += seedUsr * (5.0 - totalWeight);
    totalWeight = 5.0;
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
  const totalRounds = (plan.rounds||[]).length;
  const breakCount = (plan.rounds||[]).filter(r=>
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

function applyPromoRelegation(plan) {
  const { groupA, groupB, courts, rounds, leagueRound } = plan;
  const rankedA = rankGroupCT(groupA, rounds);
  const rankedB = rankGroupCT(groupB, rounds);
  const sA = groupA.length, sB = groupB.length;

  // Groups swap sizes: if A>B then A loses 2 gains 1, if A=B then 1 each, if A<B then A gains 2 loses 1
  let upCount, downCount;
  if (sA > sB)       { upCount=1; downCount=2; }
  else if (sA < sB)  { upCount=2; downCount=1; }
  else                { upCount=1; downCount=1; }

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
      checkedIn:[1,2,3,4,5,6,7,8,9,10,11,12],
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

let _uid=13,_cid=2,_eid=4,_vid=2,_nid=1,_crid=1;

// ── Helpers ───────────────────────────────────────────
const usrLv  = u => u>=80?{l:"A",c:"#C084FC"}:u>=65?{l:"B",c:"#38BDF8"}:u>=50?{l:"C",c:"#34D399"}:u>=35?{l:"D",c:"#FBBF24"}:{l:"E",c:"#F87171"};
const ini2   = s => s.substring(0,2).toUpperCase();
const fmtD   = d => new Date(d).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
const timeAgo = (iso) => {
  const s = Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if (s<60) return "now";
  if (s<3600) return `${Math.floor(s/60)}m ago`;
  if (s<86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
};
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

function drawHeader(ctx, w, title, subtitle, communityName){
  const headerH = 108;
  const grad = ctx.createLinearGradient(0,0,w,headerH);
  grad.addColorStop(0, COLORS.headerFrom);
  grad.addColorStop(1, COLORS.headerTo);
  ctx.fillStyle = grad; ctx.fillRect(0,0,w,headerH);
  ctx.fillStyle = "#fff"; ctx.textBaseline = "alphabetic";
  ctx.font = "700 15px Arial"; ctx.fillText("🎾 PadelOS", 16, 26);
  if(communityName){ ctx.font="600 10px Arial"; ctx.fillStyle="#E0E7FF"; ctx.textAlign="right"; ctx.fillText(communityName, w-16, 26); ctx.textAlign="left"; }
  ctx.fillStyle = "#fff"; ctx.font = "700 19px Arial";
  fitText(ctx, title, 16, 56, w-32);
  if(subtitle){ ctx.font="500 11px Arial"; ctx.fillStyle="#E0E7FF"; ctx.fillText(subtitle, 16, 78); }
  return headerH;
}

function drawFooter(ctx, w, h){
  ctx.fillStyle = COLORS.dim; ctx.font="9px Arial"; ctx.textAlign="center";
  ctx.fillText("Generated by PadelOS", w/2, h-12);
  ctx.textAlign="left";
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
function canvasToFileSync(canvas, name){
  // Synchronous conversion — keeps us in the user gesture context for navigator.share
  const dataUrl = canvas.toDataURL("image/png");
  const arr = dataUrl.split(","), mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  const u8arr = new Uint8Array(bstr.length);
  for(let i=0;i<bstr.length;i++) u8arr[i]=bstr.charCodeAt(i);
  return new File([u8arr], name, {type:mime});
}

async function shareImages(canvases, baseName){
  const diag=[];
  // Convert canvases to files SYNCHRONOUSLY using toDataURL
  // This keeps us in the user gesture context so navigator.share() doesn't fail
  const files = canvases.map((c,i)=>canvasToFileSync(c,`${baseName}_${i+1}.png`));
  diag.push(`files ready: ${files.length}`);
  diag.push(`navigator.share: ${typeof navigator.share}`);
  diag.push(`navigator.canShare: ${typeof navigator.canShare}`);

  if(navigator.share && navigator.canShare){
    let canMulti=false;
    try{ canMulti = navigator.canShare({files}); }catch(e){ diag.push(`canShare(multi) threw: ${e.message}`); }
    diag.push(`canShare(multi files): ${canMulti}`);
    if(canMulti){
      try{
        await navigator.share({files, title:baseName});
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
          await navigator.share({files:[f], title:baseName});
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
  const m=(eh*60+em)-(sh*60+sm); if(m<=0) return "—";
  const h=Math.floor(m/60), rm=m%60;
  return h>0?(rm>0?`${h}h ${rm}min`:`${h}h`):`${rm}min`;
}
const EVENT_TYPE_LABELS = {open:"Open Day",closed_ind:"Closed Individuals",closed_teams:"Closed Teams"};

function buildEventInfoCard(ev, venue, players, communityName, ctPlan=null){
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
  let y = drawHeader(ctx, w, ev.name, `${fmtD(ev.date)} · ${ev.time}${ev.timeTo?" → "+ev.timeTo:""}`, communityName);
  y += 16;

  // Info card
  ctx.fillStyle = COLORS.card; roundRect(ctx, 14, y, w-28, 150, 12); ctx.fill();
  ctx.strokeStyle = COLORS.border; ctx.lineWidth=1; roundRect(ctx, 14, y, w-28, 150, 12); ctx.stroke();
  y += 14;
  const totalCount = ctPlan ? ctPlan.teams.length*2 : players.length;
  const infoRows = [
    ["📍 Location", venue ? venue.name : "TBD"],
    ["⏱ Duration", durationLabel(ev.time, ev.timeTo)],
    ["🎾 Courts", `${ev.courts} courts`],
    ["🏷 Format", EVENT_TYPE_LABELS[ev.type] || "Open"],
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
      ctx.fillStyle = lv.c+"33"; ctx.beginPath(); ctx.arc(x+15, yy+13, 9, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = lv.c; ctx.font="700 8px Arial"; ctx.textAlign="center";
      ctx.fillText((p.avatar||ini2(p.nickname)), x+15, yy+16); ctx.textAlign="left";
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
  const text = `${fmtD(ev.date)} · ${ev.time}${ev.timeTo?" → "+ev.timeTo:""}${venue?"  ·  📍 "+venue.name:""}`;
  ctx.fillStyle = COLORS.card; roundRect(ctx, 16, y, w-32, 38, 10); ctx.fill();
  ctx.strokeStyle = COLORS.border; roundRect(ctx, 16, y, w-32, 38, 10); ctx.stroke();
  ctx.fillStyle = COLORS.text; ctx.font="700 12px Arial";
  fitText(ctx, ev.name, 26, y+16, w-52);
  ctx.fillStyle = COLORS.sub; ctx.font="10px Arial";
  fitText(ctx, text, 26, y+31, w-52);
  return y + 48;
}

function buildStandingsCard(ev,venue,ciStands,tc,plan,communityName){
  const w = CARD_W;
  const h = 108 + 16 + 48 + ciStands.length*52 + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  const maxPts = maxPossibleCI(plan);
  let y = drawHeader(ctx, w, "Final standings", `Max possible: ${maxPts||"—"} pts`, communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  ciStands.forEach((s,i)=>{
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
  const maxPts = maxPossibleCI(plan);
  let y = drawHeader(ctx, w, "Match results", `${plan.rounds.length} rounds · Max ${maxPts||"—"} pts`, communityName);
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
      ctx.fillStyle = gc; ctx.font="700 9px Arial"; ctx.textAlign="center";
      ctx.fillText("C"+m.court, 34, y+18);
      ctx.font="500 7px Arial";
      ctx.fillText("ORT", 34, y+28);
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
  const groupColors = ["#6366F1","#06B6D4"];
  const groups = [
    {label:"Group A", courts:plan.courtsA, matches:(plan.rounds||[]).flatMap(r=>r.matchesA||[])},
    {label:"Group B", courts:plan.courtsB, matches:(plan.rounds||[]).flatMap(r=>r.matchesB||[])},
  ].filter(g=>g.matches.length>0);

  let estH = 108 + 16 + 48;
  groups.forEach(g=>{ estH += 28 + g.matches.length*48; });
  const h = estH + 30;
  const {c, ctx} = makeCard(w, h);
  ctx.fillStyle = COLORS.bg; ctx.fillRect(0,0,w,h);
  let y = drawHeader(ctx, w, "Match results", "League", communityName);
  y += 16;
  y = drawEventStrip(ctx, w, y, ev, venue);

  groups.forEach((g, gi)=>{
    const gc = groupColors[gi % groupColors.length];
    ctx.fillStyle = gc; roundRect(ctx, 14, y, w-28, 22, 7); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font="700 10px Arial";
    ctx.fillText(`${g.label} — ${g.matches.length} matches`, 22, y+15);
    y += 28;

    g.matches.forEach((m,i)=>{
      const won_A = m.winner==="A", won_B = m.winner==="B";
      ctx.fillStyle = i%2===0 ? COLORS.card : COLORS.cardAlt;
      roundRect(ctx, 14, y, w-28, 42, 9); ctx.fill();
      ctx.strokeStyle = COLORS.border; roundRect(ctx, 14, y, w-28, 42, 9); ctx.stroke();

      // Court badge
      ctx.fillStyle = gc+"22"; roundRect(ctx, 20, y+7, 28, 28, 6); ctx.fill();
      ctx.fillStyle = gc; ctx.font="700 9px Arial"; ctx.textAlign="center";
      ctx.fillText("C"+m.court, 34, y+17); ctx.font="500 7px Arial"; ctx.fillText("ORT",34,y+27);
      ctx.textAlign="left";

      // Team A
      const nameW = w-28-80;
      ctx.fillStyle = won_A ? COLORS.green : COLORS.text;
      ctx.font = won_A ? "700 11px Arial" : "600 11px Arial";
      fitText(ctx, (won_A?"✓ ":"")+m.teamA?.name, 58, y+18, nameW);

      // Score
      if(m.winner){
        const score = `${m.scoreA??0}–${m.scoreB??0}`;
        ctx.fillStyle = COLORS.dim; ctx.font="700 10px Arial"; ctx.textAlign="right";
        ctx.fillText(score, w-22, y+18); ctx.textAlign="left";
      }

      // Team B
      ctx.fillStyle = won_B ? COLORS.green : COLORS.sub;
      ctx.font = won_B ? "700 11px Arial" : "11px Arial";
      fitText(ctx, (won_B?"✓ ":"")+m.teamB?.name, 58, y+34, nameW);

      if(!m.winner){
        ctx.fillStyle = COLORS.dim; ctx.font="9px Arial"; ctx.textAlign="right";
        ctx.fillText("pending", w-22, y+26); ctx.textAlign="left";
      }

      y += 48;
    });
    y += 6;
  });

  drawFooter(ctx, w, h);
  return c;
}

function buildCTStandingsCard(ev, venue, ctStands, format, communityName){
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
    const maxPts=ctEventMaxPts(plan);
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
function Av({u,size=36}){const lv=usrLv(u.usr);return <div style={{width:size,height:size,borderRadius:"50%",flexShrink:0,background:`${lv.c}22`,border:`1.5px solid ${lv.c}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.36,fontWeight:600,color:lv.c}}>{u.avatar||ini2(u.nickname)}</div>;}
function Bdg({label,color}){return <span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:20,background:`${color}22`,color,border:`0.5px solid ${color}44`,whiteSpace:"nowrap"}}>{label}</span>;}
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
  return <div style={{position:"sticky",top:60,zIndex:40,background:"var(--po-bg)",marginLeft:-12,marginRight:-12,paddingLeft:12,paddingRight:12,marginBottom:8,borderBottom:"0.5px solid var(--po-bdr)"}}>{content}</div>;
}
function Inp({label,value,onChange,placeholder="",type="text",multiline}){const s={width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13,resize:"vertical",boxSizing:"border-box"};return <div style={{marginBottom:12}}><div className="po-dim" style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>{label}</div>{multiline?<textarea className="po-inp" value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={3} style={s}/>:<input className="po-inp" type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={s}/>}</div>;}
function Drp({label,value,onChange,options}){return <div style={{marginBottom:12}}><div className="po-dim" style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>{label}</div><select className="po-inp" value={value} onChange={e=>onChange(e.target.value)} style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}><option value="">اختر...</option>{options.map(o=><option key={o.v||o} value={o.v||o}>{o.l||o.v||o}</option>)}</select></div>;}
function Tabs({tabs,active,onChange}){return <div className="po-inp" style={{display:"flex",gap:4,background:"var(--po-inp)",borderRadius:8,padding:4,marginBottom:14}}>{tabs.map(([k,l])=><button key={k} onClick={()=>onChange(k)} style={{flex:1,padding:"8px 0",borderRadius:6,border:active===k?"2px solid #6366F1":"2px solid transparent",fontSize:12,fontWeight:active===k?700:500,cursor:"pointer",background:active===k?"#6366F1":"transparent",color:active===k?"#FFFFFF":"var(--po-dim)",transition:"all 0.15s"}}>{l}</button>)}</div>;}
function rBdg(r){const m={owner:["#C084FC","Owner"],admin:["#38BDF8","Admin"],member:["#64748B","Member"]};const[c,l]=m[r]||["#64748B",r];return <Bdg label={l} color={c}/>;}
function sBdg(s){const m={regular:["#34D399","Regular"],casual:["#FBBF24","Casual"],inactive:["#94A3B8","Inactive"]};const[c,l]=m[s]||["#94A3B8",s];return <Bdg label={l} color={c}/>;}
function AreaSel({gov,area,onChange}){const govs=Object.keys(EGYPT),areas=gov?EGYPT[gov]||[]:[];return <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}><Drp label="المحافظة" value={gov} onChange={v=>{onChange("gov",v);onChange("area","");}} options={govs.map(g=>({v:g,l:g}))}/><Drp label="المنطقة" value={area} onChange={v=>onChange("area",v)} options={areas.map(a=>({v:a,l:a}))}/></div>;}

// Score Stepper — fixed scroll issue with onMouseDown instead of onClick
function ScoreStepper({value,onChange,label}){
  return <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
    <div style={{fontSize:10,color:"var(--po-dim)",fontWeight:600,textAlign:"center",maxWidth:70,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>
    <button
      onMouseDown={e=>{e.preventDefault();onChange(Math.min(9,value+1));}}
      style={{width:38,height:38,borderRadius:8,border:"0.5px solid #6366F144",background:"#6366F111",color:"#A5B4FC",fontSize:22,fontWeight:700,cursor:"pointer",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center",touchAction:"none"}}>+</button>
    <div style={{fontSize:30,fontWeight:700,color:"var(--po-text)",minWidth:44,textAlign:"center",lineHeight:1}}>{value}</div>
    <button
      onMouseDown={e=>{e.preventDefault();onChange(Math.max(0,value-1));}}
      style={{width:38,height:38,borderRadius:8,border:"0.5px solid #EF444444",background:"#EF444411",color:"#EF4444",fontSize:22,fontWeight:700,cursor:"pointer",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center",touchAction:"none"}}>−</button>
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
    try{ await signInWithPopup(fbAuth, googleProvider); }
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
        <div style={{width:56,height:56,borderRadius:16,background:"linear-gradient(135deg,#6366F1,#818CF8)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,fontWeight:800,color:"#fff",margin:"0 auto 12px"}}>PO</div>
        <div style={{fontSize:20,fontWeight:700,color:"#F1F5F9"}}>PadelOS</div>
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

// ══════════════════════════════════════════════════════
//  CLAIM PROFILE — first login after this account isn't linked to anyone yet.
//  Picking an existing player keeps their whole history (USR, past events);
//  "That's not me" is the only path that creates a brand new profile.
// ══════════════════════════════════════════════════════
function ClaimProfileScreen({authUser,unclaimed,wasRejected,onClaim,onCreateNew,onSignOut}){
  const [q,setQ] = useState("");
  const filtered = unclaimed.filter(u => u.nickname.toLowerCase().includes(q.toLowerCase()) || u.name.toLowerCase().includes(q.toLowerCase()));
  return <div style={{minHeight:"100vh",background:"#0E1117",padding:"32px 20px"}}>
    <div style={{maxWidth:420,margin:"0 auto"}}>
      <div style={{textAlign:"center",marginBottom:20}}>
        <div style={{fontSize:19,fontWeight:700,color:"#F1F5F9"}}>Which one is you?</div>
        <div style={{fontSize:13,color:"#64748B",marginTop:6}}>Signed in as {authUser.email || authUser.displayName}. Pick your existing player profile so your history carries over — an admin will confirm it's really you. Only choose "That's not me" if you're genuinely new.</div>
        {wasRejected&&<div style={{fontSize:12,color:"#F87171",background:"#F8717122",border:"0.5px solid #F8717144",borderRadius:8,padding:"8px 10px",marginTop:12}}>Your last request wasn't approved. Double check you're picking the right name, or create a new profile instead.</div>}
      </div>

      <input placeholder="Search your name…" value={q} onChange={e=>setQ(e.target.value)}
        style={{width:"100%",background:"#161B22",border:"0.5px solid #30363D",borderRadius:8,padding:"11px 12px",color:"#F1F5F9",fontSize:14,marginBottom:14,boxSizing:"border-box"}}/>

      <div style={{maxHeight:380,overflowY:"auto",display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
        {filtered.map(u=>{
          const lv = usrLv(u.usr);
          return <div key={u.id} onClick={()=>onClaim(u.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:10,background:"#161B22",border:"0.5px solid #30363D",cursor:"pointer"}}>
            <div style={{width:34,height:34,borderRadius:"50%",flexShrink:0,background:`${lv.c}22`,border:`1.5px solid ${lv.c}66`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:lv.c}}>{u.avatar||ini2(u.nickname)}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:600,color:"#F1F5F9"}}>{u.nickname}</div>
              <div style={{fontSize:11,color:"#64748B"}}>{u.name} · USR {u.usr}</div>
            </div>
          </div>;
        })}
        {filtered.length===0&&<div style={{textAlign:"center",fontSize:13,color:"#64748B",padding:"16px 0"}}>No match — try a different search, or create a new profile below.</div>}
      </div>

      <button onClick={onCreateNew} style={{width:"100%",padding:"11px",borderRadius:8,border:"0.5px solid #30363D",background:"transparent",color:"#94A3B8",fontSize:13,fontWeight:600,cursor:"pointer",marginBottom:10}}>
        That's not me — create a new profile
      </button>
      <div onClick={onSignOut} style={{textAlign:"center",fontSize:12,color:"#64748B",cursor:"pointer"}}>Wrong account? Sign out</div>
    </div>
  </div>;
}

export default function PadelOS() {
  useEffect(() => { document.title = `PadelOS ${APP_VERSION}`; }, []);
  const [users,  setUsers]  = useState(INIT_USERS);
  const [venues, setVenues] = useState(INIT_VENUES);
  const [comms,  setComms]  = useState(INIT_COMMS);
  const [notifications, setNotifications] = useState([]);
  const [claimRequests, setClaimRequests] = useState([]); // {id, userId, firebaseUid, email, displayName, requestedAt, status}
  const [uidLinks, setUidLinks] = useState({}); // {firebaseUid: userId} — one Firestore doc per entry, see sync below
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [nav,    setNav]    = useState("communities");
  const [view,   setView]   = useState({screen:"list"});
  const [navHistory, setNavHistory] = useState([]); // stack of {nav, view} for back navigation

  // Firebase Authentication — Phase 1: real login, data still lives in localStorage.
  useEffect(() => {
    const unsub = onAuthStateChanged(fbAuth, (u) => { setAuthUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  // Which local PadelOS profile belongs to the signed-in Firebase account, if any.
  // Claiming an existing profile requires admin approval (see claimRequests) so nobody
  // can just pick someone else's name — only "not on this list" is immediate, since it
  // can't impersonate anyone. The actual firebaseUid→userId link lives in its own
  // per-document collection (uidLinks, synced above) — never in the users blob — so it
  // can't be silently reverted by an unrelated users-array write from another device.
  const linkedUserId = authUser ? uidLinks[authUser.uid] : null;
  const linkedMe = linkedUserId!=null ? (users.find(u => u.id===linkedUserId) || null) : null;
  const me = linkedMe || users[0];
  const myPendingRequest = authUser ? claimRequests.find(r => r.firebaseUid===authUser.uid && r.status==="pending") : null;
  const myLastRequest = authUser ? [...claimRequests].reverse().find(r => r.firebaseUid===authUser.uid) : null;
  const requestClaim = (userId) => {
    if (userId === 1) { // the seed owner profile — approving anyone else requires *someone* already linked, so this one is instant
      linkUidToUser(authUser.uid, 1);
      setUsers(us => us.map(u => u.id===1 ? {...u, email:authUser.email||u.email} : u));
      return;
    }
    const id = _crid++;
    setClaimRequests(rs => [...rs, {id, userId, firebaseUid:authUser.uid, email:authUser.email, displayName:authUser.displayName||"", requestedAt:new Date().toISOString(), status:"pending"}]);
  };
  const approveClaim = (reqId) => {
    setClaimRequests(rs => rs.map(r => r.id===reqId ? {...r, status:"approved"} : r));
    const req = claimRequests.find(r => r.id===reqId);
    if (req) {
      linkUidToUser(req.firebaseUid, req.userId);
      setUsers(us => us.map(u => u.id===req.userId ? {...u, email:req.email||u.email} : u));
    }
  };
  const rejectClaim = (reqId) => setClaimRequests(rs => rs.map(r => r.id===reqId ? {...r, status:"rejected"} : r));
  const createFreshProfile = () => {
    const newId = _uid++;
    const displayName = authUser.displayName || authUser.email?.split("@")[0] || "Player";
    setUsers(us => [...us, {id:newId, email:authUser.email, nickname:displayName, name:displayName, avatar:ini2(displayName), usr:50, joined:today, isGuest:false}]);
    linkUidToUser(authUser.uid, newId);
  };

  const go = (screen, extra={}) => {
    setNavHistory(h=>[...h, {nav, view}]); // push current state before navigating
    setView({screen,...extra});
  };
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

  // ── Firestore sync (Phase 2) — comms/users/venues/notifications/claimRequests are
  // shared cloud data now; every signed-in device sees the same thing in real time.
  // `dark` stays a local device preference in localStorage.
  // syncedRef tracks, per key, the JSON of whatever we last received FROM Firestore or
  // sent TO it — this is what stops the listen-effect and write-effect from echoing
  // back and forth into an infinite loop.
  const syncedRef = useRef({comms:null, users:null, venues:null, notifications:null, claimRequests:null});
  const [loadedKeys, setLoadedKeys] = useState([]);
  const markLoaded = (k) => setLoadedKeys(ks => ks.includes(k) ? ks : [...ks, k]);
  const dataLoaded = ["comms","users","venues","notifications","claimRequests","uidLinks"].every(k => loadedKeys.includes(k));

  useEffect(() => { try { const d = localStorage.getItem('padelos_dark'); if (d!==null) setDark(d==='1'); } catch(e){} }, []);
  useEffect(() => { try { localStorage.setItem('padelos_dark', dark?'1':'0'); } catch(e){} }, [dark]);

  // comms
  useEffect(() => {
    const unsub = onSnapshot(doc(db,"padelos","comms"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.comms) { syncedRef.current.comms = json; setComms(remote);
          _cid = Math.max(_cid, ...remote.map(c=>c.id), 0) + 1;
          _eid = Math.max(_eid, ...remote.flatMap(c=>c.events.map(e=>e.id)), 0) + 1;
        }
      } else { syncedRef.current.comms = JSON.stringify(INIT_COMMS); setDoc(doc(db,"padelos","comms"),{value:JSON.stringify(INIT_COMMS)}); }
      markLoaded("comms");
    }, e => { console.log("Firestore comms error", e); markLoaded("comms"); });
    return unsub;
  }, []);
  useEffect(() => {
    if (!dataLoaded) return;
    const json = JSON.stringify(comms);
    if (json === syncedRef.current.comms) return;
    syncedRef.current.comms = json;
    setDoc(doc(db,"padelos","comms"), {value:JSON.stringify(comms)}).catch(e=>console.log("Firestore write error (comms)", e));
  }, [comms, dataLoaded]);

  // users
  useEffect(() => {
    const unsub = onSnapshot(doc(db,"padelos","users"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.users) { syncedRef.current.users = json; setUsers(remote);
          _uid = Math.max(_uid, ...remote.map(u=>u.id), 0) + 1;
        }
      } else { syncedRef.current.users = JSON.stringify(INIT_USERS); setDoc(doc(db,"padelos","users"),{value:JSON.stringify(INIT_USERS)}); }
      markLoaded("users");
    }, e => { console.log("Firestore users error", e); markLoaded("users"); });
    return unsub;
  }, []);
  useEffect(() => {
    if (!dataLoaded) return;
    const json = JSON.stringify(users);
    if (json === syncedRef.current.users) return;
    syncedRef.current.users = json;
    setDoc(doc(db,"padelos","users"), {value:JSON.stringify(users)}).catch(e=>console.log("Firestore write error (users)", e));
  }, [users, dataLoaded]);

  // venues
  useEffect(() => {
    const unsub = onSnapshot(doc(db,"padelos","venues"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.venues) { syncedRef.current.venues = json; setVenues(remote);
          _vid = Math.max(_vid, ...remote.map(v=>v.id), 0) + 1;
        }
      } else { syncedRef.current.venues = JSON.stringify(INIT_VENUES); setDoc(doc(db,"padelos","venues"),{value:JSON.stringify(INIT_VENUES)}); }
      markLoaded("venues");
    }, e => { console.log("Firestore venues error", e); markLoaded("venues"); });
    return unsub;
  }, []);
  useEffect(() => {
    if (!dataLoaded) return;
    const json = JSON.stringify(venues);
    if (json === syncedRef.current.venues) return;
    syncedRef.current.venues = json;
    setDoc(doc(db,"padelos","venues"), {value:JSON.stringify(venues)}).catch(e=>console.log("Firestore write error (venues)", e));
  }, [venues, dataLoaded]);

  // notifications
  useEffect(() => {
    const unsub = onSnapshot(doc(db,"padelos","notifications"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.notifications) { syncedRef.current.notifications = json; setNotifications(remote);
          _nid = Math.max(_nid, ...remote.map(n=>n.id), 0) + 1;
        }
      } else { syncedRef.current.notifications = JSON.stringify([]); setDoc(doc(db,"padelos","notifications"),{value:JSON.stringify([])}); }
      markLoaded("notifications");
    }, e => { console.log("Firestore notifications error", e); markLoaded("notifications"); });
    return unsub;
  }, []);
  useEffect(() => {
    if (!dataLoaded) return;
    const json = JSON.stringify(notifications);
    if (json === syncedRef.current.notifications) return;
    syncedRef.current.notifications = json;
    setDoc(doc(db,"padelos","notifications"), {value:JSON.stringify(notifications)}).catch(e=>console.log("Firestore write error (notifications)", e));
  }, [notifications, dataLoaded]);

  // claimRequests
  useEffect(() => {
    const unsub = onSnapshot(doc(db,"padelos","claimRequests"), snap => {
      if (snap.exists()) {
        const raw = snap.data().value; const remote = typeof raw==="string" ? JSON.parse(raw) : raw; // tolerate old pre-stringify docs
        const json = JSON.stringify(remote);
        if (json !== syncedRef.current.claimRequests) { syncedRef.current.claimRequests = json; setClaimRequests(remote);
          _crid = Math.max(_crid, ...remote.map(r=>r.id), 0) + 1;
        }
      } else { syncedRef.current.claimRequests = JSON.stringify([]); setDoc(doc(db,"padelos","claimRequests"),{value:JSON.stringify([])}); }
      markLoaded("claimRequests");
    }, e => { console.log("Firestore claimRequests error", e); markLoaded("claimRequests"); });
    return unsub;
  }, []);
  useEffect(() => {
    if (!dataLoaded) return;
    const json = JSON.stringify(claimRequests);
    if (json === syncedRef.current.claimRequests) return;
    syncedRef.current.claimRequests = json;
    setDoc(doc(db,"padelos","claimRequests"), {value:JSON.stringify(claimRequests)}).catch(e=>console.log("Firestore write error (claimRequests)", e));
  }, [claimRequests, dataLoaded]);

  // uidLinks — one Firestore document PER identity link (padelos_links/{firebaseUid} = {userId}).
  // Deliberately NOT part of the users blob: this is the exact data that was getting lost
  // (a claim approval silently reverted) when a stale device overwrote the whole users
  // array. A per-document write here can never be clobbered by an unrelated write elsewhere.
  useEffect(() => {
    const unsub = onSnapshot(collection(db,"padelos_links"), snap => {
      const map = {};
      snap.forEach(d => { map[d.id] = d.data().userId; });
      setUidLinks(map);
      markLoaded("uidLinks");
    }, e => { console.log("Firestore uidLinks error", e); markLoaded("uidLinks"); });
    return unsub;
  }, []);
  const linkUidToUser = (firebaseUid, userId) => setDoc(doc(db,"padelos_links",firebaseUid), {userId}).catch(e=>console.log("Firestore write error (uidLinks)", e));

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
    const updatedUsers = users.map(u => {
      let updatedUser = {...u, usrHistory: [...(u.usrHistory||[])]};
      completedCI.forEach(ev => {
        // Skip if this event already has a history entry for this user
        if (updatedUser.usrHistory.some(h => h.eventId === ev.id)) return;
        const plan = ev.plan;
        const maxPts = maxPossibleCI(plan);
        if (maxPts <= 0) return;
        const stands = calcCIStandings(plan, users);
        const s = stands.find(s => s.user.id === u.id);
        if (!s) return;
        const pes = Math.round((s.pts / maxPts) * 100 * 10) / 10;
        updatedUser.usrHistory.push({eventId: ev.id, eventName: ev.name, date: ev.date, pes, type:"ci"});
        anyUpdate = true;
      });
      if (!anyUpdate && updatedUser.usrHistory === u.usrHistory) return u;
      const hist = updatedUser.usrHistory;
      if (hist.length === 0) return u;
      const seedUsr = u.seedUsr ?? u.usr;
      const newUsr = calcWeightedUSR(hist, seedUsr);
      return {...updatedUser, usr: newUsr, seedUsr: u.seedUsr ?? u.usr};
    });

    if (anyUpdate) setUsers(updatedUsers);
  }, [dataLoaded]); // re-runs once the restore completes; only meaningful after that


  const editUser = (id, data) => {
    setUsers(us => us.map(u => u.id===id ? {...u, nickname:data.nickname, name:data.name, gov:data.gov, area:data.area, usr:data.usr, avatar:ini2(data.nickname)} : u));
    toast2("Player updated ✓");
  };
  const deleteUser = (id) => {
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
    toast2("Player removed");
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
  const factoryReset = () => {
    try {
      localStorage.removeItem('padelos_v10');
      localStorage.removeItem('padelos_v09');
      setDoc(doc(db,"padelos","comms"), {value:JSON.stringify(INIT_COMMS)});
      setDoc(doc(db,"padelos","users"), {value:JSON.stringify(INIT_USERS)});
      setDoc(doc(db,"padelos","venues"), {value:JSON.stringify(INIT_VENUES)});
      setDoc(doc(db,"padelos","notifications"), {value:JSON.stringify([])});
      setDoc(doc(db,"padelos","claimRequests"), {value:JSON.stringify([])});
    } catch(e) {}
    window.location.reload();
  };
  // ────────────────────────────────────────────────────

  const toast2 = (msg,t="ok") => { setToast({msg,t}); setTimeout(()=>setToast(null),2600); };
  // go() defined above with history tracking
  const updC = (id,fn) => setComms(cs=>cs.map(c=>c.id===id?fn(c):c));
  const getEv = (cid,eid) => comms.find(c=>c.id===cid)?.events.find(e=>e.id===eid);

  // ── Notifications ──────────────────────────────────────
  // Event-scoped notifications only (registration, reminders, changes) — see Ch09.
  // Direct messaging / broadcasts / other categories are deferred.
  const notify = (userIds, type, ev, title, body) => {
    const uniq = [...new Set((userIds||[]).filter(Boolean))];
    if (uniq.length===0) return;
    const now = new Date().toISOString();
    setNotifications(ns => [
      ...uniq.map(uid => ({id:_nid++, userId:uid, type, eventId:ev?.id, communityId:ev?.communityId, eventName:ev?.name, title, body, createdAt:now, read:false})),
      ...ns,
    ]);
  };
  const markNotifRead = (id) => setNotifications(ns => ns.map(n => n.id===id?{...n,read:true}:n));
  const markAllNotifRead = () => setNotifications(ns => ns.map(n => n.userId===me.id?{...n,read:true}:n));

  // Reminder engine — checks upcoming events every minute and fires a one-time
  // notification per threshold (24h/3h/1h before start) to all registered players.
  // Fired flags are stored on the event itself so reminders never repeat, even across reloads.
  useEffect(() => {
    const checkReminders = () => {
      const now = Date.now();
      comms.forEach(c => {
        c.events.forEach(ev => {
          if (!ev.date || !ev.time || ev.status==="completed" || ev.status==="cancelled") return;
          const start = new Date(`${ev.date}T${ev.time}`).getTime();
          if (isNaN(start)) return;
          const hoursLeft = (start-now)/3600000;
          const fired = ev.remindersFired || {};
          [[24,"h24","~24h"],[3,"h3","~3h"],[1,"h1","~1h"]].forEach(([h,key,label])=>{
            if (hoursLeft<=h && hoursLeft>0 && !fired[key]) {
              const recipients = ev.registrations.map(r=>r.userId);
              notify(recipients, `reminder_${key}`, ev, `⏰ ${ev.name} starts in ${label}`, `${fmtD(ev.date)} · ${ev.time}`);
              updC(ev.communityId, c2=>({...c2,events:c2.events.map(e=>e.id!==ev.id?e:{...e,remindersFired:{...(e.remindersFired||{}),[key]:true}})}));
            }
          });
        });
      });
    };
    checkReminders();
    const iv = setInterval(checkReminders, 60000);
    return () => clearInterval(iv);
  }, [comms]);

  // Community
  const createComm=(d)=>{const id=_cid++;setComms(cs=>[...cs,{id,...d,founded:today,members:[{userId:me.id,role:"owner",status:"regular",since:today}],joinRequests:[],events:[]}]);toast2(`${d.name} created!`);go("comm",{cid:id});};
  const saveComm=(id,d)=>{updC(id,c=>({...c,...d}));toast2("Saved ✓");go("comm",{cid:id});};
  const approveReq=(cid,uid)=>{updC(cid,c=>({...c,joinRequests:c.joinRequests.filter(r=>r.userId!==uid),members:[...c.members,{userId:uid,role:"member",status:"casual",since:today}]}));toast2("Approved ✓");};
  const rejectReq=(cid,uid)=>{updC(cid,c=>({...c,joinRequests:c.joinRequests.filter(r=>r.userId!==uid)}));toast2("Rejected");};
  const requestJoin=(cid)=>{updC(cid,c=>c.joinRequests.some(r=>r.userId===me.id)?c:({...c,joinRequests:[...c.joinRequests,{userId:me.id,requestedAt:today}]}));toast2("Request sent ✓");};
  const promoteM=(cid,uid)=>{updC(cid,c=>({...c,members:c.members.map(m=>m.userId===uid?{...m,role:"admin"}:m)}));toast2("Promoted ✓");};
  const kickM=(cid,uid)=>{updC(cid,c=>({...c,members:c.members.filter(m=>m.userId!==uid)}));toast2("Removed");};
  const inviteUser=(cid,uid)=>{const u=users.find(u=>u.id===uid);updC(cid,c=>({...c,members:[...c.members,{userId:uid,role:"member",status:"casual",since:today}]}));toast2(`${u?.nickname} added ✓`);};

  // Venue
  const saveVenue=(d,editId=null)=>{const courts=d.courtNames.filter(Boolean).map(n=>({name:n}));if(editId){setVenues(vs=>vs.map(v=>v.id===editId?{...v,...d,courts,status:"pending_edit"}:v));toast2("Saved · Pending review");}else{const id=_vid++;setVenues(vs=>[...vs,{id,...d,courts,status:"pending"}]);toast2("Added · Pending review");}go("list");};

  // Event
  const createEvent=(cid,d)=>{
    const id=_eid++;const v=venues.find(x=>x.id===parseInt(d.venueId));
    const ev={id,communityId:cid,name:d.name,description:d.description||"",createdBy:me.id,date:d.date,time:d.time,timeTo:d.timeTo||"",venueId:parseInt(d.venueId),courts:parseInt(d.courts)||2,type:d.pollMode?null:d.eventType,status:"registration_open",regOpenAt:new Date().toISOString(),regularUntil:new Date(Date.now()+24*3600000).toISOString(),poll:d.pollMode?{votes:{},resolved:false}:null,registrations:[],checkedIn:[],rotationMin:parseInt(d.rotationMin)||15,costPerCourt:v?.pricePerHour||0,extraFee:v?.extraFee||0,plan:null,reservedCourts:v?.courts.length||2};
    updC(cid,c=>({...c,events:[...c.events,ev]}));toast2("Event created ✓");go("event",{cid,eid:id});
    const comm = comms.find(c=>c.id===cid);
    if (!d.pollMode && ev.type) {
      const recipients = (comm?.members||[]).filter(m=>m.userId!==me.id).map(m=>m.userId);
      notify(recipients, "reg_open", ev, `🎾 New event: ${ev.name}`, `Registration is open — ${fmtD(ev.date)}`);
    }
  };
  const editEvent=(cid,eid,d)=>{
    const before = getEv(cid,eid);
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,...d})}));toast2("Event updated ✓");go("event",{cid,eid});
    if (before) {
      const changed = [];
      if (d.date!==undefined && d.date!==before.date) changed.push("date");
      if (d.time!==undefined && d.time!==before.time) changed.push("time");
      if (d.timeTo!==undefined && d.timeTo!==before.timeTo) changed.push("time");
      if (d.venueId!==undefined && parseInt(d.venueId)!==before.venueId) changed.push("venue");
      if (d.courts!==undefined && parseInt(d.courts)!==before.courts) changed.push("courts");
      if (changed.length>0) {
        const uniqChanged = [...new Set(changed)];
        const recipients = before.registrations.map(r=>r.userId).filter(uid=>uid!==me.id);
        notify(recipients, "event_updated", before, `✏️ ${before.name} updated`, `Changed: ${uniqChanged.join(", ")} — check the event for details.`);
      }
    }
  };
  const duplicateEvent=(cid,eid,newDate,keepPlayers,newTime,newTimeTo)=>{
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
      name:ev.name,
      description: ev.description ? `${ev.description}\n${dupNote}` : dupNote,
      createdBy:ev.createdBy,
      date:newDate,
      time:newTime||ev.time,
      timeTo:newTimeTo||ev.timeTo,
      venueId:ev.venueId,
      courts:ev.courts,
      type:ev.type,
      rotationMin:ev.rotationMin,
      reservedCourts:ev.reservedCourts,
      costPerCourt:v?.pricePerHour||0, // re-derived from the venue, not copied from the old event
      extraFee:v?.extraFee||0,
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
  const deleteEvent=(cid,eid)=>{
    console.log("[deleteEvent] called with", {cid, eid});
    const ev=getEv(cid,eid);
    console.log("[deleteEvent] found event:", ev);
    if(!ev){toast2("Event not found (id "+eid+")","err");return;}
    if(ev.status==="completed"){toast2("Cannot delete a completed event — use Archive instead","err");return;}
    updC(cid,c=>{
      const before=c.events.length;
      const after={...c,events:c.events.filter(e=>e.id!==eid)};
      console.log("[deleteEvent] events before:", before, "after:", after.events.length);
      return after;
    });
    toast2("Event deleted (id "+eid+")");
    go("comm",{cid});
  };
  const archiveEvent=(cid,eid)=>{
    console.log("[archiveEvent] called with", {cid, eid});
    const ev=getEv(cid,eid);
    console.log("[archiveEvent] found event:", ev);
    if(!ev){toast2("Event not found (id "+eid+")","err");return;}
    updC(cid,c=>{
      const updated={...c,events:c.events.map(e=>e.id!==eid?e:{...e,archived:true,archivedAt:new Date().toISOString()})};
      console.log("[archiveEvent] updated events:", updated.events.find(e=>e.id===eid));
      return updated;
    });
    toast2("Event archived (id "+eid+")");
    go("comm",{cid});
  };
  const unarchiveEvent=(cid,eid)=>{
    console.log("[unarchiveEvent] called with", {cid, eid});
    updC(cid,c=>({...c,events:c.events.map(e=>e.id!==eid?e:{...e,archived:false,archivedAt:null})}));
    toast2("Event restored");
  };
  const closeEvent=(cid,eid)=>{
    const ev=getEv(cid,eid);
    if(!ev){toast2("Event not found","err");return;}

    // ── CI: Calculate PES → update USR ───────────────
    if(ev.type==="closed_ind"&&ev.plan){
      const plan=ev.plan;
      const stands=calcCIStandings(plan,users);
      setUsers(us=>us.map(u=>{
        const s=stands.find(s=>s.user.id===u.id);
        const maxPts=maxPossibleCI(plan);
        if(!s||maxPts<=0)return u;
        const pes=Math.round((s.pts/maxPts)*100*10)/10;
        const hist=[...(u.usrHistory||[]), {eventId:eid, eventName:ev.name, date:ev.date, pes, type:"ci"}];
        const seedUsr = u.seedUsr ?? u.usr;
        const newUsr = calcWeightedUSR(hist, seedUsr);
        return {...u, usr:newUsr, usrHistory:hist, seedUsr: u.seedUsr ?? u.usr};
      }));
    }

    // ── CT: Calculate TES → update TR per combination ─
    if(ev.type==="closed_teams"&&ev.plan){
      const plan=ev.plan;
      const stands=calcCTStandings(plan);
      const format=plan.format;

      // Calculate TES for each team
      const teamTES = {};
      stands.forEach(s=>{
        let tes=0;
        if(format==="ladder"){
          // Use per-team max pts (team-specific, accounts for which rounds they were on break)
          const maxPts=ctEventMaxPts(plan);
          tes=maxPts>0?Math.round((s.pts/maxPts)*100*10)/10:0;
        } else {
          // League: wins ÷ total matches played × 100
          const totalMatches=(s.wins||0)+(s.losses||0);
          tes=totalMatches>0?Math.round(((s.wins||0)/totalMatches)*100*10)/10:0;
        }
        teamTES[s.team?.id]=tes;
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
          eventId:eid,eventName:ev.name,date:ev.date,format,tes};
        const comboHist=[...comboHistory,newEntry];
        const padded=comboHist.length<5
          ?[...Array(5-comboHist.length).fill({tes:seedTr}),...comboHist]
          :comboHist.slice(-5);
        const newTr=Math.round(padded.reduce((sum,h)=>sum+h.tes,0)/padded.length);
        newEntry.tr=newTr;

        // Also add TES to usrHistory with weight 0.5 → affects USR
        const seedUsr = u.seedUsr ?? u.usr;
        const usrHist=[...(u.usrHistory||[]), {eventId:eid, eventName:ev.name, date:ev.date, pes:tes, type:"ct"}];
        const newUsr = calcWeightedUSR(usrHist, seedUsr);

        const otherHistory=prevHistory.filter(h=>h.comboKey!==comboKey);
        return {...u, usr:newUsr, usrHistory:usrHist, seedUsr, teamsHistory:[...otherHistory,...comboHist]};
      }));
    }

    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,status:"completed",closedAt:new Date().toISOString()})}));
    toast2("Event closed ✓ — ratings updated");
  };
  const registerEv=(cid,eid)=>{
    const ev=getEv(cid,eid);
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.registrations.find(r=>r.userId===me.id)?ev:{...ev,registrations:[...ev.registrations,{userId:me.id,registeredAt:new Date().toISOString(),status:"registered",addedBy:null,isGuest:false}]})}));
    toast2("Registered ✓");
    if (ev) notify([me.id], "registered", ev, `✓ You're in for ${ev.name}`, `${fmtD(ev.date)}${ev.time?` · ${ev.time}`:""}`);
  };
  const addMember=(cid,eid,uid)=>{
    const ev=getEv(cid,eid);
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.registrations.find(r=>r.userId===uid)?ev:{...ev,registrations:[...ev.registrations,{userId:uid,registeredAt:new Date().toISOString(),status:"registered",addedBy:"admin",isGuest:false}]})}));
    toast2(`${users.find(u=>u.id===uid)?.nickname} added ✓`);
    if (ev) notify([uid], "registered", ev, `✓ You're in for ${ev.name}`, `${fmtD(ev.date)}${ev.time?` · ${ev.time}`:""} — added by an admin`);
  };
  const addGuest=(cid,eid,g)=>{
    const id=_uid++;
    const newUser={id,nickname:g.n,name:g.name||g.n,phone:g.p,gov:"—",area:"—",usr:parseInt(g.usr)||0,joined:today,avatar:ini2(g.n),isGuest:true};
    setUsers(us=>[...us,newUser]);
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:[...ev.registrations,{userId:id,registeredAt:new Date().toISOString(),status:"registered",addedBy:me.nickname,isGuest:true}]})}));
    toast2(`${g.n} added ✓`);
  };
  const checkIn=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.checkedIn.includes(uid)?ev:{...ev,checkedIn:[...ev.checkedIn,uid]})}));toast2("Checked in ✓");};
  const votePoll=(cid,eid,key)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid||!ev.poll)return ev;const v={...ev.poll.votes};const my=v[me.id]||[];v[me.id]=my.includes(key)?my.filter(k=>k!==key):[...my,key];return{...ev,poll:{...ev.poll,votes:v}};})}));};
  const resolveT=(cid,eid,key)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,type:key,poll:ev.poll?{...ev.poll,resolved:true,result:key}:null})}));toast2("Type set ✓");};
  const setPlan=(cid,eid,plan)=>updC(cid,c=>({...c,events:c.events.map(ev=>ev.id===eid?{...ev,plan}:ev)}));
  const removeFromEvent=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:ev.registrations.filter(r=>r.userId!==uid),checkedIn:ev.checkedIn.filter(id=>id!==uid)})}));toast2("Removed from event");};
  const toggleExempt=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid)return ev;const ex=new Set(ev.exempted||[]);ex.has(uid)?ex.delete(uid):ex.add(uid);return{...ev,exempted:[...ex]};})}));};
  const togglePaid=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid)return ev;const p=new Set(ev.paidIds||[]);p.has(uid)?p.delete(uid):p.add(uid);return{...ev,paidIds:[...p]};})}));};
  const setMatchModeStart=(cid,eid,delayMin)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||!ev.plan?ev:{...ev,plan:{...ev.plan,matchModeStartAt:new Date().toISOString(),matchModeDelayMin:delayMin}})}));};
  const updateEventFinance=(cid,eid,fields)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,...fields})}));toast2("Updated ✓");};
  const editGuestUsr=(uid,usr)=>{setUsers(us=>us.map(u=>u.id===uid?{...u,usr:parseInt(usr)||0}:u));toast2("USR updated ✓");};
  const editEventUsr=(cid,eid,uid,usr)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:ev.registrations.map(r=>r.userId!==uid?r:{...r,eventUsr:usr===""?null:parseInt(usr)||0})})}));};

  // CI
  const startCI=(cid,eid,n,dur)=>{
    const ev=getEv(cid,eid);if(!ev)return;
    const players=ev.registrations.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return{...u,usr:r.eventUsr??u.usr,userId:r.userId,histBreaks:0};}).filter(Boolean);
    setPlan(cid,eid,{...genRound1(players,ev.courts,n),roundDuration:dur});
  };
  const nextRoundCI=(cid,eid)=>{const ev=getEv(cid,eid);if(!ev?.plan)return;setPlan(cid,eid,genNextRoundCI(ev.plan));toast2("Next round generated ✓");};
  const setWinCI=(cid,eid,ri,mi,w)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid||!ev.plan)return ev;const rounds=ev.plan.rounds.map((r,rr)=>rr!==ri?r:{...r,matches:r.matches.map((m,mm)=>mm!==mi?m:{...m,winner:w})});return{...ev,plan:{...ev.plan,rounds}};})}));};
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
  const editBreakCI=(cid,eid,ri,uid,shouldBreak)=>{
    const ev=getEv(cid,eid);if(!ev?.plan)return;
    const bpr=Math.max(0,ev.registrations.length-ev.courts*4);
    const breakPlan=ev.plan.breakPlan.map((round,i)=>{
      if(i!==ri)return round;
      if(shouldBreak&&!round.includes(uid))return [...round,uid];
      if(!shouldBreak)return round.filter(id=>id!==uid);
      return round;
    });
    const newCount=breakPlan[ri].length;
    if(newCount!==bpr)toast2(`Warning: R${ri+1} has ${newCount} breaks (needs ${bpr})`,"err");
    else toast2("Break updated — tap Regenerate to apply to future rounds");
    // Also update the current round's onBreak/onBreakIds in rounds array
    const rounds=ev.plan.rounds.map((r,rr)=>{
      if(rr!==ri)return r;
      const newBreakIds=breakPlan[ri];
      const onBreak=ev.plan.sorted.filter(p=>newBreakIds.includes(p.userId));
      return{...r,onBreak,onBreakIds:newBreakIds};
    });
    setPlan(cid,eid,{...ev.plan,breakPlan,rounds});
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
    const fresh=buildCTBreakPlan(teams,tc,total,newBreakPlan.slice(0,generatedRounds));
    for(let i=generatedRounds;i<total;i++) newBreakPlan[i]=fresh[i];
    setPlan(cid,eid,{...plan,breakPlan:newBreakPlan});
    toast2("Break schedule regenerated ✓");
  };

  const startCT=(cid,eid,courts,fmt,dur)=>{
    const ev=getEv(cid,eid);if(!ev)return;
    let players=ev.registrations.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return{...u,usr:r.eventUsr??u.usr,userId:r.userId};}).filter(Boolean);
    let waitlisted=null;
    if(players.length%2!==0){
      // Odd count — last player in registrations array goes to waiting list
      const regs=ev.registrations;
      const lastReg=regs[regs.length-1];
      const lastPlayer=players.find(p=>(p.userId||p.id)===lastReg?.userId);
      waitlisted=lastPlayer||players[players.length-1];
      players=players.filter(p=>(p.userId||p.id)!==(waitlisted.userId||waitlisted.id));
      toast2(`${waitlisted.nickname} moved to waiting list — need even number for team formation`,"err");
    }
    const newPlan={...generateCTPlan(players,courts,fmt,ev,dur||20),waitlisted:waitlisted?[{userId:waitlisted.userId,nickname:waitlisted.nickname,usr:waitlisted.usr}]:[]};
    setPlan(cid,eid,newPlan);
    toast2(`Teams formed ✓ — ${Math.floor(players.length/2)} teams`);
  };
  const setWinCT=(cid,eid,ri,mi,side,w,sA,sB)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid||!ev.plan)return ev;const rounds=ev.plan.rounds.map((r,rr)=>{if(rr!==ri)return r;const up=arr=>arr.map((m,mm)=>mm!==mi?m:{...m,winner:w,scoreA:sA,scoreB:sB});return{...r,matchesA:side==="A"?up(r.matchesA):r.matchesA,matchesB:side==="B"?up(r.matchesB):r.matchesB};});return{...ev,plan:{...ev.plan,rounds}};})}));};
  const applyPromo=(cid,eid)=>{const ev=getEv(cid,eid);if(!ev?.plan)return;setPlan(cid,eid,applyPromoRelegation(ev.plan));toast2("Groups reshuffled ✓");};
  const nextCTLadder=(cid,eid)=>{const ev=getEv(cid,eid);if(!ev?.plan)return;setPlan(cid,eid,genNextCTLadder(ev.plan));toast2("Next match generated ✓");};
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
  const event=comm&&view.eid?comm.events.find(e=>e.id===view.eid):null;
  const allEvents=comms.flatMap(c=>c.events.map(ev=>({...ev,commName:c.name,communityId:c.id})));

  if (authLoading || !dataLoaded) {
    return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"#64748B",fontSize:14}}>Loading…</div>
    </div>;
  }
  if (!authUser) {
    return <LoginScreen/>;
  }
  if (!linkedMe) {
    if (myPendingRequest) {
      const target = users.find(u=>u.id===myPendingRequest.userId);
      return <div style={{minHeight:"100vh",background:"#0E1117",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
        <div style={{maxWidth:360,textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>⏳</div>
          <div style={{fontSize:17,fontWeight:700,color:"#F1F5F9",marginBottom:8}}>Waiting for approval</div>
          <div style={{fontSize:13,color:"#64748B",marginBottom:20}}>You asked to claim <b style={{color:"#F1F5F9"}}>{target?.nickname}</b>'s profile. A community admin needs to confirm that's really you before you can continue.</div>
          <div onClick={()=>signOut(fbAuth)} style={{fontSize:12,color:"#818CF8",cursor:"pointer"}}>Sign out</div>
        </div>
      </div>;
    }
    const pendingUserIds = new Set(claimRequests.filter(r=>r.status==="pending").map(r=>r.userId));
    const claimedUserIds = new Set(Object.values(uidLinks));
    const unclaimed = users.filter(u => !claimedUserIds.has(u.id) && !pendingUserIds.has(u.id));
    return <ClaimProfileScreen authUser={authUser} unclaimed={unclaimed} wasRejected={myLastRequest?.status==="rejected"} onClaim={requestClaim} onCreateNew={createFreshProfile} onSignOut={()=>signOut(fbAuth)}/>;
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
      <TopBar me={me} nav={nav} menu={menu} setMenu={setMenu} TH={TH} dark={dark} onNav={n=>{goRoot(n);}} onProfile={()=>{setNavHistory(h=>[...h,{nav,view}]);setNav("profile");setView({screen:"profile",uid:me.id});setMenu(false);}} onVenues={()=>{goRoot("venues");setMenu(false);}} onSettings={()=>{goRoot("settings");setMenu(false);}} onPlatformAdmin={()=>{setNavHistory(h=>[...h,{nav,view}]);setNav("platform");setView({screen:"admin"});setMenu(false);}} onSignOut={()=>signOut(fbAuth)}
        notifications={notifications} notifMenu={notifMenu} setNotifMenu={setNotifMenu}
        onMarkNotifRead={markNotifRead} onMarkAllNotifRead={markAllNotifRead}
        onOpenNotif={n=>{setNotifMenu(false);markNotifRead(n.id);if(n.communityId&&n.eventId){setNav("communities");setNavHistory(h=>[...h,{nav,view}]);setView({screen:"event",cid:n.communityId,eid:n.eventId});}}}
        onSeeAllNotifs={()=>{setNotifMenu(false);setNavHistory(h=>[...h,{nav,view}]);setNav("notifications");setView({screen:"list"});}}
      />
      <div style={{flex:1,maxWidth:680,width:"100%",margin:"0 auto",padding:"16px 12px 80px"}}>
        {nav==="communities"&&view.screen==="list"&&<CommList comms={comms} me={me} dark={dark} TH={TH} onOpen={id=>go("comm",{cid:id})} onCreate={()=>go("createComm")}/>}
        {nav==="communities"&&view.screen==="createComm"&&<CommForm onBack={goBack} onSave={createComm}/>}
        {nav==="communities"&&view.screen==="editComm"&&comm&&<CommForm comm={comm} onBack={()=>go("comm",{cid:comm.id})} onSave={d=>saveComm(comm.id,d)}/>}
        {nav==="communities"&&view.screen==="comm"&&comm&&<CommDetail comm={comm} users={users} me={me} onBack={goBack} onEdit={()=>go("editComm",{cid:comm.id})} onApprove={uid=>approveReq(comm.id,uid)} onReject={uid=>rejectReq(comm.id,uid)} onRequestJoin={()=>requestJoin(comm.id)} onPromote={uid=>promoteM(comm.id,uid)} onKick={uid=>kickM(comm.id,uid)} onInvite={uid=>inviteUser(comm.id,uid)} onOpenEv={eid=>go("event",{cid:comm.id,eid})} onCreateEv={()=>go("createEvent",{cid:comm.id})} onViewProfile={uid=>{setNav("profile");setNavHistory(h=>[...h,{nav,view}]);setView({screen:"profile",uid,backCid:comm.id});}}/>}
        {nav==="communities"&&view.screen==="createEvent"&&comm&&<EventForm venues={venues} onBack={()=>go("comm",{cid:comm.id})} onCreate={d=>createEvent(comm.id,d)}/>}
        {nav==="communities"&&view.screen==="editEvent"&&comm&&event&&<EventEditForm ev={event} venues={venues} onBack={()=>go("event",{cid:comm.id,eid:event.id})} onSave={d=>editEvent(comm.id,event.id,d)}/>}
        {nav==="communities"&&view.screen==="event"&&comm&&event&&
          <EvDetail key={event.id} ev={event} comm={comm} users={users} venues={venues} me={me} onToast={msg=>toast2(msg)}
            onDuplicate={(newDate,keepPlayers,newTime,newTimeTo)=>duplicateEvent(comm.id,event.id,newDate,keepPlayers,newTime,newTimeTo)}
            onDelete={()=>deleteEvent(comm.id,event.id)}
            onArchive={()=>archiveEvent(comm.id,event.id)}
            onUnarchive={()=>unarchiveEvent(comm.id,event.id)}
            onViewProfile={uid=>{setNav("profile");setNavHistory(h=>[...h,{nav,view}]);setView({screen:"profile",uid,backCid:comm.id});}}
            onToggleExempt={uid=>toggleExempt(comm.id,event.id,uid)}
            onTogglePaid={uid=>togglePaid(comm.id,event.id,uid)}
            onSetMatchModeStart={delayMin=>setMatchModeStart(comm.id,event.id,delayMin)}
            onUpdateEventFinance={fields=>updateEventFinance(comm.id,event.id,fields)}
            onSwapCTBreak={(ri,tA,tB)=>swapCTBreak(comm.id,event.id,ri,tA,tB)}
            onRegenCTBreaks={()=>regenCTBreaks(comm.id,event.id)}
            onBack={()=>go("comm",{cid:comm.id})}
            onEditEvent={()=>go("editEvent",{cid:comm.id,eid:event.id})}
            onRegister={()=>registerEv(comm.id,event.id)}
            onCheckIn={uid=>checkIn(comm.id,event.id,uid)}
            onAddMember={uid=>addMember(comm.id,event.id,uid)}
            onAddGuest={g=>addGuest(comm.id,event.id,g)}
            onVote={k=>votePoll(comm.id,event.id,k)}
            onResolveType={k=>resolveT(comm.id,event.id,k)}
            onCloseEvent={()=>closeEvent(comm.id,event.id)}
            onStartCI={(n,dur)=>startCI(comm.id,event.id,n,dur)}
            onSetWinCI={(ri,mi,w)=>setWinCI(comm.id,event.id,ri,mi,w)}
            onNextRound={()=>nextRoundCI(comm.id,event.id)}
            onSwap={(ri,a,b)=>swapCI(comm.id,event.id,ri,a,b)}
            onEditBreak={(ri,uid,v)=>editBreakCI(comm.id,event.id,ri,uid,v)}
            onRegenerateBreaks={()=>regenerateBreaksCI(comm.id,event.id)}
            onRemoveFromEvent={uid=>removeFromEvent(comm.id,event.id,uid)}
            onEditGuestUsr={(uid,usr)=>editGuestUsr(uid,usr)}
            onEditEventUsr={(uid,usr)=>editEventUsr(comm.id,event.id,uid,usr)}
            onStartCT={(c,f,dur)=>startCT(comm.id,event.id,c,f,dur)}
            onSetWinCT={(ri,mi,side,w,sA,sB)=>setWinCT(comm.id,event.id,ri,mi,side,w,sA,sB)}
            onApplyPromo={()=>applyPromo(comm.id,event.id)}
            onNextCTLadder={()=>nextCTLadder(comm.id,event.id)}
            onSwapCTLadder={(ri,a,b)=>swapCTLadder(comm.id,event.id,ri,a,b)}
          />
        }
        {nav==="events"&&view.screen==="list"&&<EvList events={allEvents} me={me} users={users} comms={comms} onOpen={(cid,eid)=>{setNav("communities");go("event",{cid,eid});}} onCreateEv={()=>{const ac=comms.find(c=>c.members.some(m=>m.userId===me.id&&(m.role==="owner"||m.role==="admin")));if(ac){setNav("communities");go("createEvent",{cid:ac.id});}}}/>}
        {nav==="venues"&&view.screen==="list"&&<VenueList venues={venues} onAdd={()=>go("addVenue")} onEdit={id=>go("editVenue",{vid:id})} onBack={goBack}/>}
        {nav==="venues"&&view.screen==="addVenue"&&<VenueForm onBack={goBack} onSave={saveVenue}/>}
        {nav==="venues"&&view.screen==="editVenue"&&<VenueForm editV={venues.find(v=>v.id===view.vid)} onBack={goBack} onSave={saveVenue}/>}
        {nav==="profile"&&<ProfileSc user={users.find(u=>u.id===(view.uid??me.id))||me} viewedByAdmin={!!view.uid&&view.uid!==me.id} comms={comms} onBack={goBack}/>}
        {nav==="settings"&&<SettingsSc user={me} users={users} dark={dark} onToggleDark={()=>setDark(d=>!d)} onAddUser={u=>{const id=_uid++;setUsers(us=>[...us,{id,...u,joined:today,avatar:ini2(u.nickname),isGuest:false}]);toast2(`${u.nickname} added ✓`);}} onExport={exportData} onEditUser={editUser} onDeleteUser={deleteUser} onRepairIds={repairDuplicateIds} onFactoryReset={factoryReset} onSendTestNotif={()=>{notify([me.id],"test",null,"🔔 Test notification",`Hey ${me.nickname}, if you see this on your lock screen, push is working!`);toast2("Sent — check your lock screen ✓");}} onBack={goBack}/>}
        {nav==="notifications"&&<NotificationsSc notifications={notifications} me={me}
          onBack={goBack} onMarkAllRead={markAllNotifRead}
          onOpen={n=>{markNotifRead(n.id);if(n.communityId&&n.eventId){setNav("communities");setNavHistory(h=>[...h,{nav:"notifications",view}]);setView({screen:"event",cid:n.communityId,eid:n.eventId});}}}/>}
        {nav==="platform"&&<PlatformAdminSc users={users} comms={comms} venues={venues} onBack={goBack}
          onAddUser={u=>{const id=_uid++;setUsers(us=>[...us,{id,...u,joined:today,avatar:ini2(u.nickname),isGuest:false,seedUsr:parseInt(u.usr)||50}]);toast2(`${u.nickname} added ✓`);}}
          onEditUser={(id,updates)=>{setUsers(us=>us.map(u=>u.id===id?{...u,...updates,seedUsr:u.seedUsr??u.usr}:u));toast2("Updated ✓");}}
          onDeleteUser={uid=>{setUsers(us=>us.filter(u=>u.id!==uid));toast2("Removed ✓");}}
          onViewProfile={uid=>{setNavHistory(h=>[...h,{nav,view}]);setNav("profile");setView({screen:"profile",uid});}}
          claimRequests={claimRequests} onApproveClaim={approveClaim} onRejectClaim={rejectClaim}
        />}
      </div>
      {toast&&<div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:toast.t==="err"?"#EF4444":"#10B981",color:"#fff",padding:"10px 20px",borderRadius:8,fontSize:13,fontWeight:500,zIndex:999,whiteSpace:"nowrap",boxShadow:"0 4px 20px #00000055"}}>{toast.msg}</div>}
    </div>
  );
}

function TopBar({me,nav,menu,setMenu,onNav,onProfile,onVenues,onSettings,onPlatformAdmin,onSignOut,TH,dark,
  notifications=[],notifMenu,setNotifMenu,onMarkNotifRead,onMarkAllNotifRead,onOpenNotif,onSeeAllNotifs}){
  const myNotifs = notifications.filter(n=>n.userId===me.id);
  const unreadCount = myNotifs.filter(n=>!n.read).length;
  const tabs = [
    {k:"communities", l:"Communities", chip:"#FBBF24", iconColor:"#7C4A03", rot:-4, icon:(
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="3.8" fill="currentColor"/><circle cx="8.5" cy="8.5" r="1.3" fill="#FBBF24"/>
        <circle cx="16.5" cy="10" r="3" fill="currentColor"/><circle cx="16.5" cy="10" r="1" fill="#FBBF24"/>
        <path d="M3 20.5c0-3.8 2.7-6.3 5.9-6.3s5.6 2.3 5.9 5.6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none"/>
        <path d="M13.5 16.8c2.5-0.3 5 1.6 5.3 4.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none"/>
      </svg>
    )},
    {k:"events", l:"Events", chip:"#F472B6", iconColor:"#7A1042", rot:4, icon:(
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="3.5" width="18" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="2.4"/>
        <path d="M12 3.5v17" stroke="currentColor" strokeWidth="1.8" strokeDasharray="0.5 3.2" strokeLinecap="round"/>
        <circle cx="7.3" cy="14.5" r="2.1" fill="currentColor"/><circle cx="16.7" cy="8.5" r="2.1" fill="currentColor"/>
      </svg>
    )},
  ];
  return <div style={{background:TH?.nav||"#0E1117",borderBottom:`0.5px solid ${TH?.border||"var(--po-bdr)"}`,padding:"0 8px",display:"flex",alignItems:"center",justifyContent:"space-between",height:60,position:"sticky",top:0,left:0,right:0,width:"100%",zIndex:50,transition:"all 0.2s",boxSizing:"border-box",gap:4}}>
    <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
      <div style={{width:26,height:26,background:"linear-gradient(135deg,#6366F1,#06B6D4)",borderRadius:7,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#fff",flexShrink:0}}>PO</div>
      <div style={{display:"flex",flexDirection:"column",lineHeight:1.05}}>
        <span style={{fontSize:11,fontWeight:600,color:dark?"#F1F5F9":"#FFFFFF"}}>PadelOS</span>
        <span style={{fontSize:8,fontWeight:400,color:dark?"#F1F5F9":"#FFFFFF",opacity:0.6}}>v{APP_VERSION}</span>
      </div>
    </div>
    <div style={{display:"flex",gap:6,flex:1,justifyContent:"center",minWidth:0}}>{tabs.map(t=>{
      const active = nav===t.k;
      return <button key={t.k} onClick={()=>onNav(t.k)} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px 6px 6px",borderRadius:11,border:"none",fontSize:12,fontWeight:700,cursor:"pointer",minHeight:38,background:active?"rgba(255,255,255,0.97)":"rgba(255,255,255,0.16)",transition:"all 0.15s",flexShrink:1,overflow:"hidden"}}>
        <div style={{width:26,height:26,borderRadius:8,background:t.chip,color:t.iconColor,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transform:`rotate(${t.rot}deg)`}}>
          {React.cloneElement(t.icon,{width:17,height:17})}
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
      <div onClick={()=>setMenu(o=>!o)} style={{cursor:"pointer",padding:2}}><Av u={me} size={30}/></div>
      {menu&&<div style={{position:"absolute",right:0,top:42,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:6,minWidth:190,zIndex:100,boxShadow:"0 8px 32px #00000066"}}>
        <div style={{padding:"8px 10px 10px",borderBottom:"0.5px solid var(--po-bdr)",marginBottom:4}}><div className="po-text" style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{me.nickname}</div><div className="po-dim" style={{fontSize:11,color:"var(--po-dim)"}}>USR {me.usr} · {usrLv(me.usr).l}</div></div>
        {[{i:"👤",l:"My Profile",fn:onProfile},...(me.id===1?[{i:"🛡",l:"Platform Admin",fn:onPlatformAdmin}]:[]),{i:"🏟",l:"Venues",fn:onVenues},{i:"⚙️",l:"Settings",fn:onSettings},{i:"🚪",l:"Sign Out",fn:()=>{setMenu(false);onSignOut&&onSignOut();},d:true}].map(x=><button key={x.l} onClick={x.fn} style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"10px 10px",minHeight:40,borderRadius:7,border:"none",background:"transparent",color:x.d?"#EF4444":"var(--po-sub)",fontSize:13,cursor:"pointer",textAlign:"left"}}>{x.i} {x.l}</button>)}
      </div>}
    </div>
  </div>;
}

// ── Communities ───────────────────────────────────────
function CommList({comms,me,onOpen,onCreate}){
  const [sub,setSub]=useState("mine"),[q,setQ]=useState("");
  const mine=comms.filter(c=>c.members.some(m=>m.userId===me.id));
  const shown=comms.filter(c=>c.type==="public"&&!c.members.some(m=>m.userId===me.id)).filter(c=>!q?c.gov===me.gov||c.area===me.area:c.name.toLowerCase().includes(q.toLowerCase())||c.area.includes(q));
  function CR({c}){const act=c.members.filter(m=>m.status!=="inactive").length,my=c.members.find(m=>m.userId===me.id);return <Card style={{cursor:"pointer"}}><div onClick={()=>onOpen(c.id)} style={{display:"flex",gap:12,alignItems:"flex-start"}}><div style={{width:44,height:44,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🏸</div><div style={{flex:1,minWidth:0}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:15,color:"var(--po-text)"}}>{c.name}</span>{SEEDED_COMM_IDS.has(c.id)&&<SeedBadge/>}<Bdg label={c.type==="public"?"Public":"Private"} color={c.type==="public"?"#34D399":"var(--po-sub)"}/>{my&&rBdg(my.role)}</div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:2}}>📍 {c.area} · {c.gov}</div><div className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>{act} members · {c.events.length} events</div></div></div></Card>;}
  return <><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)"}}>Communities</div><Btn label="+ New" onClick={onCreate} primary/></div>
    <Tabs tabs={[["mine",`Mine (${mine.length})`],["explore","Explore"]]} active={sub} onChange={setSub}/>
    {sub==="mine"&&(mine.length===0?<Card><div style={{textAlign:"center",padding:"24px 0",color:"var(--po-dim)",fontSize:13}}><div style={{fontSize:28,marginBottom:8}}>🏸</div>No communities. <span style={{color:"#6366F1",cursor:"pointer"}} onClick={()=>setSub("explore")}>Explore →</span></div></Card>:mine.map(c=><CR key={c.id} c={c}/>))}
    {sub==="explore"&&<><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search by name or area..." className="po-inp" style={{width:"100%",background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"9px 12px",color:"var(--po-text)",fontSize:13,boxSizing:"border-box",marginBottom:8}}/>{!q&&<div style={{fontSize:11,color:"var(--po-dim)",marginBottom:10}}>📍 Near {me.area}</div>}{shown.length===0?<Card><div style={{textAlign:"center",padding:"20px 0",color:"var(--po-dim)",fontSize:13}}>No communities found.</div></Card>:shown.map(c=><CR key={c.id} c={c}/>)}</>}
  </>;
}

function CommForm({comm,onBack,onSave}){
  const ie=!!comm;const [f,setF]=useState({name:comm?.name||"",description:comm?.description||"",country:"مصر",gov:comm?.gov||"",area:comm?.area||"",type:comm?.type||"public"});const set=(k,v)=>setF(p=>({...p,[k]:v}));
  return <><BBtn onBack={onBack} label={ie?comm.name:"Communities"}/><div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>{ie?"Edit Community":"New Community"}</div><Card><Inp label="Name" value={f.name} onChange={v=>set("name",v)} placeholder="e.g. Maadi Padel Club"/><Inp label="Description" value={f.description} onChange={v=>set("description",v)} multiline/><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Location</div><AreaSel gov={f.gov} area={f.area} onChange={set}/><div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:6}}>Visibility</div>{["public","private"].map(t=><div key={t} onClick={()=>set("type",t)} className="po-inp" style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:"pointer",border:`0.5px solid ${f.type===t?"#6366F1":"var(--po-bdr)"}`,background:f.type===t?"#6366F122":"var(--po-inp)"}}><div style={{fontWeight:600,fontSize:13,color:f.type===t?"#A5B4FC":"var(--po-text)",marginBottom:2,textTransform:"capitalize"}}>{t}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{t==="public"?"Discoverable · anyone can request · Admin approves":"Hidden · invitation only"}</div></div>)}</div><Btn label={ie?"Save Changes":"Create Community"} primary onClick={()=>{if(f.name&&f.gov&&f.area)onSave(f);}} style={{width:"100%"}}/></Card></>;
}

function CommStatsTab({comm, users, onViewProfile}){
  const [view, setView] = useState("usr");
  const members = comm.members.map(m=>users.find(u=>u.id===m.userId)).filter(Boolean);
  const completedEvents = comm.events.filter(ev=>ev.status==="completed"&&ev.plan);

  // Build stats per member
  const stats = members.map(u=>{
    let participations=0, wins=0, totalPts=0, totalMaxPts=0;
    completedEvents.forEach(ev=>{
      const reg=ev.registrations?.find(r=>r.userId===u.id);
      if(!reg) return;
      participations++;
      if(ev.type==="closed_ind"&&ev.plan){
        const stands=calcCIStandings(ev.plan,users);
        const s=stands.find(s=>s.user.id===u.id);
        if(s){wins+=s.wins; totalPts+=s.pts; totalMaxPts+=maxPossibleCI(ev.plan);}
      }
      if(ev.type==="closed_teams"&&ev.plan){
        const stands=calcCTStandings(ev.plan);
        const team=ev.plan.teams?.find(t=>t.players?.some(p=>p.userId===u.id));
        const s=stands.find(s=>s.team?.id===team?.id);
        if(s){wins+=s.wins; totalPts+=s.pts;}
        if(ev.plan.format==="ladder") totalMaxPts+=ctEventMaxPts(ev.plan);
      }
    });
    return {user:u, participations, wins, totalPts, totalMaxPts};
  });

  const views={
    usr:{label:"🏆 USR Rank", sort:(a,b)=>b.user.usr-a.user.usr, val:s=>`USR ${s.user.usr}`, sub:s=>usrLv(s.user.usr).l},
    events:{label:"📅 Participations", sort:(a,b)=>b.participations-a.participations, val:s=>`${s.participations} events`, sub:()=>""},
    wins:{label:"⚡ Most Wins", sort:(a,b)=>b.wins-a.wins, val:s=>`${s.wins} wins`, sub:()=>""},
    pts:{label:"💯 Most Points", sort:(a,b)=>b.totalPts-a.totalPts, val:s=>`${s.totalPts} pts`, sub:()=>""},
  };

  const sorted=[...stats].sort(views[view].sort);

  return <>
    <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
      {Object.entries(views).map(([k,v])=><button key={k} onClick={()=>setView(k)}
        style={{padding:"7px 12px",borderRadius:8,border:`0.5px solid ${view===k?"#6366F1":"var(--po-bdr)"}`,background:view===k?"#6366F122":"var(--po-card)",color:view===k?"#A5B4FC":"var(--po-sub)",fontSize:12,fontWeight:600,cursor:"pointer"}}>
        {v.label}
      </button>)}
    </div>
    {sorted.map((s,i)=>{
      const lv=usrLv(s.user.usr);
      const medal=i===0?"🥇":i===1?"🥈":i===2?"🥉":`${i+1}.`;
      return <Card key={s.user.id} style={{marginBottom:6}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{fontSize:18,width:28,textAlign:"center",flexShrink:0}}>{medal}</div>
          <Av u={s.user} size={34}/>
          <div style={{flex:1,cursor:"pointer"}} onClick={()=>onViewProfile&&onViewProfile(s.user.id)}>
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

function CommDetail({comm,users,me,onBack,onEdit,onApprove,onReject,onRequestJoin,onPromote,onKick,onInvite,onOpenEv,onCreateEv,onViewProfile}){
  const [tab,setTab]=useState("members");
  const [showInvite,setShowInvite]=useState(false);
  const myRole=comm.members.find(m=>m.userId===me.id)?.role;
  const isAdmin=myRole==="owner"||myRole==="admin";
  const isMember=!!myRole;
  const hasPendingJoin=comm.joinRequests.some(r=>r.userId===me.id);
  const regs=comm.members.filter(m=>m.status!=="inactive");
  const avgU=regs.length?Math.round(regs.reduce((s,m)=>s+(users.find(u=>u.id===m.userId)?.usr||0),0)/regs.length):0;
  const tdefs=[["members","Members"],["events","Events"],["stats","Stats"],...(isAdmin?[["requests",`Requests${comm.joinRequests.length>0?` (${comm.joinRequests.length})`:""}`]]:[])];
  const statusOrder={regular:0,casual:1,inactive:2},roleOrder={owner:0,admin:1,member:2};
  const sortedMembers=[...comm.members].sort((a,b)=>{if(roleOrder[a.role]!==roleOrder[b.role])return roleOrder[a.role]-roleOrder[b.role];return(statusOrder[a.status]||0)-(statusOrder[b.status]||0);});
  const nonMembers=users.filter(u=>!comm.members.some(m=>m.userId===u.id));

  return <><BBtn onBack={onBack} label="Communities" sticky subLabel={tab==="members"?"Members":tab==="events"?"Events":"Requests"}/>
    <Card>
      <div style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
        <div style={{width:52,height:52,borderRadius:12,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>🏸</div>
        <div style={{flex:1}}><div className="po-text" style={{fontWeight:700,fontSize:17,color:"var(--po-text)",marginBottom:2}}>{comm.name}{SEEDED_COMM_IDS.has(comm.id)&&<> <SeedBadge/></>}</div><div style={{fontSize:12,color:"var(--po-dim)"}}>📍 {comm.area} · {comm.gov} · Founded {fmtD(comm.founded)}</div></div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}><Bdg label={comm.type==="public"?"Public":"Private"} color={comm.type==="public"?"#34D399":"var(--po-sub)"}/>{myRole==="owner"&&<SmBtn label="✏️" onClick={onEdit} color="#6366F1"/>}</div>
      </div>
      <div style={{fontSize:13,color:"var(--po-sub)",marginBottom:14}}>{comm.description}</div>
      {!isMember&&<div style={{marginBottom:14}}>
        {hasPendingJoin
          ? <div style={{textAlign:"center",fontSize:13,fontWeight:600,color:"var(--po-dim)",background:"var(--po-inp)",borderRadius:8,padding:"10px 0"}}>⏳ Request pending approval</div>
          : <Btn label="+ Request to Join" primary onClick={onRequestJoin} style={{width:"100%"}}/>}
      </div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>{[["Members",regs.length],["Events",comm.events.length],["Avg USR",avgU||"—"],["Requests",comm.joinRequests.length]].map(([l,v])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 0",textAlign:"center"}}><div style={{fontSize:16,fontWeight:700,color:"var(--po-text)"}}>{v}</div><div style={{fontSize:10,color:"var(--po-dim)",marginTop:1}}>{l}</div></div>)}</div>
    </Card>
    <Tabs tabs={tdefs} active={tab} onChange={setTab}/>

    {tab==="members"&&<>
      {isAdmin&&<>
        <SmBtn label={showInvite?"▲ Hide Invite":"+ Invite Platform User"} onClick={()=>setShowInvite(o=>!o)} color="#6366F1" style={{marginBottom:12,width:"100%"}}/>
        {showInvite&&nonMembers.length>0&&<Card style={{marginBottom:12}}>
          {nonMembers.map(u=><div key={u.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
            <Av u={u} size={28}/><div style={{flex:1}}><span style={{fontSize:12,fontWeight:500,color:"var(--po-text)"}}>{u.nickname}</span><span style={{fontSize:11,color:"var(--po-dim)",marginLeft:6}}>USR {u.usr} · {u.area}</span></div>
            <SmBtn label="+ Add" onClick={()=>{onInvite(u.id);setShowInvite(false);}} color="#6366F1"/>
          </div>)}
        </Card>}
      </>}
      {["owner","admin","member"].map(rf=>{
        const list=sortedMembers.filter(m=>m.role===rf);if(!list.length)return null;
        return <div key={rf}><ST>{rf==="owner"?"Owner":rf==="admin"?"Admins":"Members"}</ST>
          {list.map(m=>{const u=users.find(u=>u.id===m.userId);if(!u)return null;const isMe=u.id===me.id;return(
            <Card key={m.userId} style={{cursor:isAdmin?"pointer":"default"}}><div onClick={()=>isAdmin&&onViewProfile(u.id)} style={{display:"flex",alignItems:"center",gap:10}}>
              <Av u={u} size={38}/>
              <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{u.nickname}</span>{sBdg(m.status)}{isMe&&<Bdg label="You" color="#6366F1"/>}{isAdmin&&!isMe&&<span style={{fontSize:10,color:"var(--po-dim)"}}>👁 tap to view</span>}</div><div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>USR {u.usr} · {u.area}</div></div>
              {isAdmin&&!isMe&&m.role!=="owner"&&<div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>{m.role==="member"&&<SmBtn label="↑ Admin" onClick={()=>onPromote(u.id)} color="#6366F1"/>}<SmBtn label="Remove" onClick={()=>onKick(u.id)} color="#EF4444"/></div>}
            </div></Card>
          );})}
        </div>;
      })}
    </>}

    {tab==="events"&&<>{isAdmin&&<Btn label="+ New Event" primary onClick={onCreateEv} style={{width:"100%",marginBottom:12}}/>}
      {(() => { const visEvents = comm.events;
      return visEvents.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No events yet</div></Card>:<>
        {(() => {
          const upcoming=visEvents.filter(ev=>ev.status!=="completed"&&ev.status!=="cancelled"&&!ev.archived);
          const past=visEvents.filter(ev=>(ev.status==="completed"||ev.status==="cancelled")&&!ev.archived);
          const archived=visEvents.filter(ev=>ev.archived);
          return <>
            {upcoming.length>0?<>{upcoming.map(ev=><EvCard key={ev.id} ev={ev} me={me} users={users} onClick={()=>onOpenEv(ev.id)}/>)}</>
              :<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"16px 0"}}>No upcoming events</div></Card>}
            {past.length>0&&<CollapsibleSection label={`📁 Past Events (${past.length})`} defaultOpen={false}>
              {past.map(ev=><EvCard key={ev.id} ev={ev} me={me} users={users} onClick={()=>onOpenEv(ev.id)}/>)}
            </CollapsibleSection>}
            {isAdmin&&archived.length>0&&<CollapsibleSection label={`📦 Archived (${archived.length})`} defaultOpen={false}>
              {archived.map(ev=><EvCard key={ev.id} ev={ev} me={me} users={users} onClick={()=>onOpenEv(ev.id)}/>)}
            </CollapsibleSection>}
          </>;
        })()}
      </>; })()}
    </>}
    {tab==="stats"&&<CommStatsTab comm={comm} users={users} onViewProfile={onViewProfile}/>}
    {tab==="requests"&&isAdmin&&(comm.joinRequests.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No pending requests</div></Card>:comm.joinRequests.map(req=>{const u=users.find(u=>u.id===req.userId);if(!u)return null;return(<Card key={req.userId}><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}><Av u={u} size={38}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr} · {u.area}</div></div></div>{req.message&&<div style={{fontSize:12,color:"var(--po-sub)",background:"var(--po-inp)",borderRadius:6,padding:"7px 10px",marginBottom:10}}>{req.message}</div>}<div style={{display:"flex",gap:6}}><Btn label="Approve" primary onClick={()=>onApprove(req.userId)} style={{flex:1}}/><Btn label="Reject" danger onClick={()=>onReject(req.userId)} style={{flex:1}}/></div></Card>);}))}</>;
}

// ── Venues ────────────────────────────────────────────
function VenueList({venues,onAdd,onEdit,onBack}){
  const safeVenues = (venues||[]).filter(v=>v && Array.isArray(v.courts));
  const brokenCount = (venues||[]).length - safeVenues.length;
  return <><BBtn onBack={onBack} label="Back"/><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)"}}>Venues</div><Btn label="+ Add Venue" primary onClick={onAdd}/></div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:12,padding:"8px 12px",background:"var(--po-card)",borderRadius:8}}>ℹ️ Use any venue immediately. Platform Admin approval publishes globally.</div>
    {brokenCount>0&&<div style={{fontSize:12,color:"#F87171",marginBottom:12,padding:"8px 12px",background:"#EF444411",border:"0.5px solid #EF444444",borderRadius:8}}>⚠️ {brokenCount} venue(s) have corrupted data and were hidden. Go to Settings → Data → Repair to fix, or Factory Reset if the issue persists.</div>}
    {safeVenues.length===0&&brokenCount===0&&<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No venues yet.</div></Card>}
    {safeVenues.map(v=><Card key={v.id}><div style={{display:"flex",gap:12,alignItems:"flex-start"}}><div style={{width:44,height:44,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🏟</div><div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:15,color:"var(--po-text)"}}>{v.name}</span>{SEEDED_VENUE_IDS.has(v.id)&&<SeedBadge/>}{v.status==="pending"&&<Bdg label="⏳ Pending" color="#F59E0B"/>}{v.status==="pending_edit"&&<Bdg label="✏️ Edit Pending" color="#F59E0B"/>}{(!v.status||v.status==="approved")&&<Bdg label="✓ Approved" color="#34D399"/>}</div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>📍 {v.area} · {v.gov}</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:4}}><Bdg label={`${v.courts.length} courts`} color="#38BDF8"/>{v.pricePerHour>0&&<Bdg label={`${v.pricePerHour} EGP/hr`} color="#34D399"/>}{v.pricePerHour===0&&<Bdg label="Free" color="#34D399"/>}{v.extraFee>0&&<Bdg label={`+${v.extraFee} EGP booking`} color="#F59E0B"/>}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{v.courts.map(c=>c.name).join(" · ")}</div></div><div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>{(v.mapsUrl||(typeof v.lat==="number"&&typeof v.lng==="number"))&&<MapOpenPicker venue={v} label="📍 Maps"/>}<SmBtn label="✏️ Edit" onClick={()=>onEdit(v.id)} color="#6366F1"/></div></div></Card>)}
  </>;
}
function VenueForm({editV,onBack,onSave}){
  const ie=!!editV;const emptyNames=Array(Math.max(0,10-(editV?.courts.length||0))).fill("");
  const [f,setF]=useState({name:editV?.name||"",gov:editV?.gov||"",area:editV?.area||"",pricePerHour:editV?String(editV.pricePerHour):"",extraFee:editV?String(editV.extraFee):"",mapsUrl:editV?.mapsUrl||"",lat:editV?.lat!=null?String(editV.lat):"",lng:editV?.lng!=null?String(editV.lng):"",courtNames:editV?[...editV.courts.map(c=>c.name),...emptyNames]:["Court 1","Court 2","","","","","","","",""]});
  const set=(k,v)=>setF(p=>({...p,[k]:v})),setC=(i,v)=>setF(p=>{const n=[...p.courtNames];n[i]=v;return{...p,courtNames:n};});const areas=f.gov?EGYPT[f.gov]||[]:[];
  return <><BBtn onBack={onBack} label="Venues"/><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:ie?4:16}}>{ie?"Edit Venue":"Add Venue"}</div>{ie&&<div style={{fontSize:12,color:"#F59E0B",marginBottom:14,padding:"8px 12px",background:"#F59E0B11",borderRadius:8}}>✏️ Changes apply immediately. Pending global review.</div>}
    <Card><Inp label="Venue Name" value={f.name} onChange={v=>set("name",v)} placeholder="e.g. Wadi Degla Club"/><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:0}}><Drp label="المحافظة" value={f.gov} onChange={v=>{set("gov",v);set("area","");}} options={Object.keys(EGYPT).map(g=>({v:g,l:g}))}/><Drp label="المنطقة" value={f.area} onChange={v=>set("area",v)} options={areas.map(a=>({v:a,l:a}))}/></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><Inp label="Price/hr (EGP)" value={f.pricePerHour} onChange={v=>set("pricePerHour",v)} type="number"/><Inp label="Extra Booking (EGP)" value={f.extraFee} onChange={v=>set("extraFee",v)} type="number"/></div><Inp label="Google Maps URL" value={f.mapsUrl} onChange={v=>set("mapsUrl",v)} placeholder="https://maps.google.com/..."/>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8,padding:"8px 10px",background:"var(--po-inp)",borderRadius:8}}>📍 For "How far is it?" and one-tap navigation to work reliably, add coordinates below — shortened share links (maps.app.goo.gl/…) don't contain them. In Google Maps: long-press the location on the map, then tap the coordinates shown at the bottom to copy them.</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><Inp label="Latitude (optional)" value={f.lat} onChange={v=>set("lat",v)} type="number" placeholder="e.g. 30.0333"/><Inp label="Longitude (optional)" value={f.lng} onChange={v=>set("lng",v)} type="number" placeholder="e.g. 31.4913"/></div>
    <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Court Names (up to 10)</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>{f.courtNames.map((cn,i)=><input key={i} value={cn} onChange={e=>setC(i,e.target.value)} placeholder={`Court ${i+1}`} className="po-inp" style={{background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13}}/>)}</div></div>
    <Btn label={ie?"Save & Submit for Review":"Add Venue & Submit for Review"} primary onClick={()=>{if(f.name&&f.area)onSave({...f,lat:f.lat?parseFloat(f.lat):null,lng:f.lng?parseFloat(f.lng):null},ie?editV.id:null);}} style={{width:"100%"}}/></Card></>;
}

// ── Event Card ────────────────────────────────────────
function EvCard({ev,me,users,onClick}){
  const sc={registration_open:"#34D399",completed:"var(--po-sub)",cancelled:"#EF4444"};
  const sl={registration_open:"Open",completed:"Completed",cancelled:"Cancelled"};
  const tl={open:"Open Day",closed_ind:"Closed Ind.",closed_teams:"Closed Teams"};
  const creator=users?.find(u=>u.id===ev.createdBy);
  return <Card style={{cursor:"pointer"}}><div onClick={onClick} style={{display:"flex",gap:10,alignItems:"center"}}><div style={{width:42,height:42,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>📅</div><div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{ev.name}</span><span style={{fontSize:10,color:"var(--po-dim)",background:"var(--po-inp)",padding:"1px 6px",borderRadius:5}}>#{ev.id}</span>{ev.isDemo&&<Bdg label="Demo" color="#F59E0B"/>}<Bdg label={sl[ev.status]||ev.status} color={sc[ev.status]||"#94A3B8"}/>{ev.type&&<Bdg label={tl[ev.type]||ev.type} color="#6366F1"/>}{!ev.type&&<Bdg label="🗳 Poll" color="#F59E0B"/>}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{ev.courts} courts · {ev.registrations.length} registered{creator?` · by ${creator.nickname}`:""}</div><div style={{fontSize:11,color:"var(--po-dim)",marginTop:1}}>{fmtD(ev.date)} · {ev.time}{ev.timeTo?` → ${ev.timeTo}`:""}</div></div></div></Card>;
}

// ── Event Create Form ─────────────────────────────────
function EventForm({venues,onBack,onCreate}){
  const [f,setF]=useState({name:"",description:"",date:"",time:"18:00",timeTo:"22:00",venueId:"",courts:"2",rotationMin:"15",pollMode:false,eventType:"open"});
  const set=(k,v)=>setF(p=>({...p,[k]:v}));const v=venues.find(x=>x.id===parseInt(f.venueId)),c=parseInt(f.courts)||0,maxC=v?v.courts.length:10,tot=v?(v.pricePerHour*c+v.extraFee*c):0;
  return <><BBtn onBack={onBack} label="Community"/><div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>New Event</div><Card>
    <Inp label="Event Name" value={f.name} onChange={v2=>set("name",v2)} placeholder="e.g. Friday Night Padel"/>
    <Inp label="Description / Remark (optional)" value={f.description} onChange={v2=>set("description",v2)} placeholder="e.g. Bring extra balls, court 3 booked separately" multiline/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:0}}>
      <Inp label="Date" value={f.date} onChange={v2=>set("date",v2)} type="date"/>
      <Inp label="Start" value={f.time} onChange={v2=>set("time",v2)} type="time"/>
      <Inp label="End" value={f.timeTo} onChange={v2=>set("timeTo",v2)} type="time"/>
    </div>
    <div style={{marginBottom:12}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Venue</div><select value={f.venueId} onChange={e=>set("venueId",e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}><option value="">Select venue...</option>{venues.map(x=><option key={x.id} value={x.id}>{x.name} — {x.area}</option>)}</select>{v&&<div style={{marginTop:5,fontSize:11,color:"var(--po-dim)"}}>{v.courts.length} courts · {v.pricePerHour} EGP/hr{v.extraFee>0?` · +${v.extraFee} booking`:""}</div>}</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:0}}><div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Courts (max {maxC})</div><select value={f.courts} onChange={e=>set("courts",e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13,marginBottom:12}}>{Array.from({length:maxC},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}</select></div><Inp label="Rotation (min)" value={f.rotationMin} onChange={v2=>set("rotationMin",v2)} type="number"/></div>
    {c>0&&v&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>{[["Ideal",c*5],["Max",c*6],["Cost",`${tot} EGP`]].map(([l,val])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"9px 4px",textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:"#6366F1"}}>{val}</div><div style={{fontSize:10,color:"var(--po-dim)"}}>{l}</div></div>)}</div>}
    <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Event Type</div><div style={{display:"flex",gap:8,marginBottom:8}}>{[["Choose Now",false],["🗳 Poll (24h)",true]].map(([lbl,pm])=><button key={lbl} onClick={()=>set("pollMode",pm)} style={{flex:1,padding:"8px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${f.pollMode===pm?"#6366F1":"var(--po-bdr)"}`,background:f.pollMode===pm?"#6366F133":"var(--po-bdr)",color:f.pollMode===pm?"#A5B4FC":"var(--po-dim)",fontSize:12,fontWeight:500}}>{lbl}</button>)}</div>{!f.pollMode&&EVENT_TYPES.map(t=><div key={t.key} onClick={()=>set("eventType",t.key)} className="po-inp" style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:"pointer",border:`0.5px solid ${f.eventType===t.key?"#6366F1":"var(--po-bdr)"}`,background:f.eventType===t.key?"#6366F122":"var(--po-inp)"}}><div style={{fontWeight:600,fontSize:13,color:f.eventType===t.key?"#A5B4FC":"var(--po-text)"}}>{t.label}</div><div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>{t.desc}</div></div>)}{f.pollMode&&<div style={{padding:"10px 12px",background:"var(--po-inp)",borderRadius:8,fontSize:12,color:"var(--po-sub)"}}>Regular Members vote 24h. Admin can override.</div>}</div>
    <Btn label="Create Event" primary onClick={()=>{if(f.name&&f.date&&f.venueId)onCreate(f);}} style={{width:"100%"}}/>
  </Card></>;
}

// ── Event Edit Form (courts + times only) ─────────────
function EventEditForm({ev,venues,onBack,onSave}){
  const v=venues.find(x=>x.id===ev.venueId);
  const [f,setF]=useState({name:ev.name,description:ev.description||"",date:ev.date,courts:String(ev.courts),time:ev.time,timeTo:ev.timeTo||"",eventType:ev.type||"open"});
  const set=(k,val)=>setF(p=>({...p,[k]:val}));
  const maxC=v?v.courts.length:10;
  const isCompleted = ev.status==="completed";
  const lockedType = !!ev.plan || isCompleted; // can't change type once a plan has been generated or event is completed
  const lockedCourts = isCompleted; // court count locked once completed — would corrupt historical match/break records
  return <><BBtn onBack={onBack} label={ev.name}/><div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>Edit Event</div>
    <Card>
      <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:14,padding:"8px 12px",background:"var(--po-card)",borderRadius:8}}>ℹ️ {isCompleted?"This event is completed — date/time can still be corrected, but courts and type are locked to protect historical results.":lockedType?"Type is locked — a plan has already been generated for this event.":"Players and plan stay unchanged unless you change the event type."}</div>
      <Inp label="Event Name" value={f.name} onChange={v2=>set("name",v2)} placeholder="e.g. Monday at Galleria"/>
      <Inp label="Description / Remark (optional)" value={f.description} onChange={v2=>set("description",v2)} placeholder="e.g. Bring extra balls" multiline/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:0}}>
        <Inp label="Date" value={f.date} onChange={v2=>set("date",v2)} type="date"/>
        <Inp label="Start Time" value={f.time} onChange={v2=>set("time",v2)} type="time"/>
        <Inp label="End Time" value={f.timeTo} onChange={v2=>set("timeTo",v2)} type="time"/>
      </div>
      {!lockedCourts&&<>
        <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Courts (max {maxC})</div>
          <select value={f.courts} onChange={e=>set("courts",e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}>
            {Array.from({length:maxC},(_,i)=>i+1).map(n=><option key={n} value={n}>{n} courts (Ideal: {n*5}, Max: {n*6})</option>)}
          </select>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:6}}>Event Type{lockedType?" (locked)":""}</div>
          {EVENT_TYPES.map(t=><div key={t.key} onClick={()=>!lockedType&&set("eventType",t.key)} className="po-inp" style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:lockedType?"default":"pointer",opacity:lockedType&&f.eventType!==t.key?0.4:1,border:`0.5px solid ${f.eventType===t.key?"#6366F1":"var(--po-bdr)"}`,background:f.eventType===t.key?"#6366F122":"var(--po-inp)"}}>
            <div style={{fontWeight:600,fontSize:13,color:f.eventType===t.key?"#A5B4FC":"var(--po-text)"}}>{t.label}</div>
          </div>)}
        </div>
      </>}
      <Btn label="Save Changes" primary onClick={()=>onSave(lockedCourts?{name:f.name,description:f.description,date:f.date,time:f.time,timeTo:f.timeTo}:{name:f.name,description:f.description,date:f.date,courts:parseInt(f.courts),time:f.time,timeTo:f.timeTo,type:f.eventType})} style={{width:"100%"}}/>
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
          const mp = maxPossibleCI(plan);
          const pes = mp>0 ? Math.round((s.pts/mp)*100*10)/10 : 0;
          return <tr key={s.user.id}>
            <td style={{position:"sticky",left:0,zIndex:2,background:rowBg(i),padding:"6px 10px",fontSize:12,fontWeight:600,color:"var(--po-text)",whiteSpace:"nowrap",borderBottom:"0.5px solid var(--po-bdr)",boxShadow:"2px 0 4px -2px rgba(0,0,0,0.3)"}}>
              {i===0?"🏆 ":tied?`[${i+1}] `:`${i+1} `}{s.user.nickname} <span style={{fontSize:10,color:"var(--po-dim)",fontWeight:400}}>({s.user.usr})</span>
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
function BreaksTab({plan,ev,users,bp,tc,onEditBreak,onRegenerate}){
  const bpr=Math.max(0,ev.registrations.length-tc*4);

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
    ev.registrations.forEach(r=>{let last=-2;bp2.forEach((round,ri)=>{if(round.includes(r.userId)){if(ri-last===1)w.push(`${users.find(u=>u.id===r.userId)?.nickname}: consecutive breaks R${ri} & R${ri+1}`);last=ri;}});});
    const counts={};ev.registrations.forEach(r=>{counts[r.userId]=bp2.filter(b=>b.includes(r.userId)).length;});
    const vals=Object.values(counts);if(vals.length>0&&Math.max(...vals)-Math.min(...vals)>1)w.push(`Unequal breaks: max=${Math.max(...vals)}, min=${Math.min(...vals)}`);
    return w;
  }
  const warnings=validate(plan.breakPlan||[]);

  return <Card>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
      <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)"}}>Break Schedule</div>
      {ev.status!=="completed"&&<button onMouseDown={e=>{e.preventDefault();onRegenerate();}}
        style={{padding:"6px 12px",borderRadius:7,border:"0.5px solid #6366F144",background:"#6366F111",color:"#A5B4FC",fontSize:12,fontWeight:500,cursor:"pointer"}}>
        🔄 Regenerate Future
      </button>}
    </div>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8}}>
      {plan.totalRounds} rounds · {tc} courts · {bpr} on break/round · Break = {bp} pts
    </div>

    {/* Legend */}
    <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
      {[["🔒","Frozen (played)","#EF444433","#EF4444"],["🔄","Pending (generated)","#F59E0B22","#F59E0B"],["✏️","Open (editable)","#34D39911","#34D399"]].map(([icon,label,bg,cl])=>
        <div key={label} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:cl}}>
          <div style={{width:20,height:20,borderRadius:4,background:bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11}}>{icon}</div>
          <span>{label}</span>
        </div>
      )}
    </div>

    {warnings.length>0&&<div style={{padding:"8px 12px",background:"#F59E0B11",border:"0.5px solid #F59E0B44",borderRadius:8,marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:600,color:"#F59E0B",marginBottom:4}}>⚠️ Issues:</div>
      {warnings.map((w,i)=><div key={i} style={{fontSize:11,color:"#F59E0B"}}>{w}</div>)}
    </div>}

    <div style={{fontSize:11,color:"#6366F1",marginBottom:10,padding:"6px 10px",background:"#6366F111",borderRadius:6}}>
      💡 Pending columns (🔄) change via Rounds tab swap · Open columns (✏️) tap to edit here
    </div>

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
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <Av u={u} size={22}/>
                <span style={{fontSize:12,color:"var(--po-text)",fontWeight:500}}>{u.nickname}</span>
              </div>
            </td>
            {Array.from({length:plan.totalRounds},(_,ri)=>{
              const onB=(plan.breakPlan?.[ri]||[]).includes(u.id);
              const isFrozen=ri<completedRounds;
              const isPending=ri>=completedRounds&&ri<generatedRounds;
              const isOpen=ri>=generatedRounds;
              const canEdit=isOpen; // only open rounds editable from breaks tab

              const bg   = onB ? (isFrozen?"#EF444422":isPending?"#F59E0B22":"#F59E0B33") : (isFrozen?"#33333322":isPending?"var(--po-bdr)":"#34D39911");
              const bdr  = onB ? (isFrozen?"#EF444455":isPending?"#F59E0B55":"#F59E0B44") : (isFrozen?"#33333344":isPending?"#1E293B44":"#34D39933");
              const icon = onB ? "🪑" : (isFrozen?"—":isPending?"·":"▶");

              return <td key={ri} style={{padding:"3px 4px",textAlign:"center"}}>
                <div
                  onClick={()=>canEdit&&onEditBreak(ri,u.id,!onB)}
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
    <div style={{marginTop:10,fontSize:11,color:"var(--po-dim)"}}>Tap ✏️ open cells to edit breaks directly</div>
  </Card>;
}

// ══════════════════════════════════════════════════════
//  CT TEAM CARD
// ══════════════════════════════════════════════════════
function CTTeamCard({team,group}){
  const poolColors = ["#6366F1","#06B6D4","#F472B6","#34D399","#F59E0B"];
  const isPool = group && group.startsWith("P");
  const poolNum = isPool ? parseInt(group.slice(1))-1 : (group==="A"?0:1);
  const gc = poolColors[poolNum % poolColors.length];
  const badgeLabel = isPool ? group : `Group ${group}`;
  const badgeIcon = isPool ? group : group;
  return <Card style={{marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:10}}>
    <div style={{width:36,height:36,borderRadius:8,background:`${gc}22`,border:`0.5px solid ${gc}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:gc,flexShrink:0}}>{badgeIcon}{team.id}</div>
    <div style={{flex:1}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
        <span style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{team.name}</span>
        <span style={{fontSize:12,color:"var(--po-dim)"}}>({team.avgUsr})</span>
        <Bdg label={badgeLabel} color={gc}/>
      </div>
      <div style={{display:"flex",gap:10}}>{team.players.map(p=>{const lv=usrLv(p.usr);return <div key={p.userId||p.id} style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:22,height:22,borderRadius:"50%",background:`${lv.c}22`,border:`1px solid ${lv.c}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:lv.c}}>{p.avatar||ini2(p.nickname)}</div><span className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>{p.nickname}</span><span style={{fontSize:10,color:"var(--po-dim)"}}>{p.usr}</span></div>;})}</div>
    </div>
  </div></Card>;
}

// ══════════════════════════════════════════════════════
//  CT MATCHES TAB
// ══════════════════════════════════════════════════════
function CTBreaksTab({plan,tc,onRegenBreaks,onSwapBreak}){
  const [selSwap, setSelSwap] = useState(null); // {ri, tid} for pending swap
  const teams = plan.sorted || plan.teams;
  const totalRounds = plan.maxRounds || plan.rounds.length;
  const breakPlan = plan.breakPlan || [];
  const generatedCount = plan.rounds.length;
  // Teams that are currently on break in each round (from breakPlan)
  const breakSet = (ri) => new Set(breakPlan[ri]||[]);

  function handleCellTap(ri, t){
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
    const canInteract = !isGenerated;
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
        🔒 Frozen · 🔄 Generated · ✏️ Open (tap to swap)
      </div>
      {onRegenBreaks&&<button onClick={()=>{if(window.confirm("Regenerate break schedule?\n\nThis will recalculate breaks for all ungenerated rounds based on current teams. Generated rounds are not affected."))onRegenBreaks();}} style={{padding:"5px 12px",borderRadius:6,border:"0.5px solid #F59E0B44",background:"#F59E0B11",color:"#F59E0B",fontSize:11,fontWeight:600,cursor:"pointer"}}>🔄 Regenerate Breaks</button>}
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
              return <td key={ri} onClick={()=>handleCellTap(ri,t)} style={cellStyle(ri,t)}>
                {onBreak
                  ? <span style={{fontSize:13,opacity:isGenerated?1:0.65,color:isSel?"#6366F1":"#F59E0B"}}>☕</span>
                  : <span style={{color:"var(--po-dim)",fontSize:11}}>·</span>
                }
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    {generatedCount<totalRounds&&<div style={{marginTop:8,fontSize:10,color:"var(--po-dim)"}}>Rounds {generatedCount+1}–{totalRounds}: planned · not yet generated · tap ☕ then another team to swap</div>}
  </>;
}


function CTMatchesTab({plan,onSetWinCT,onApplyPromo,onNextCTLadder,onSwapCTLadder,totalBookingMin,eventDate,eventTime,sim,onSetMatchModeStart}){
  const [selT,setSelT]=useState(null); // {ri,tid} for ladder team swap
  const [scores,setScores]=useState({});

  function getS(ri,mi,side){return scores[`${ri}_${mi}_${side}`]||{scoreA:0,scoreB:0};}
  function setS(ri,mi,side,field,val){setScores(s=>({...s,[`${ri}_${mi}_${side}`]:{...getS(ri,mi,side),[field]:val}}));}
  const gcA="#6366F1",gcB="#06B6D4";
  const isLeague=plan.format==="league";
  const tc=plan.courts;

  // All matches done in current round?
  const lastRound=plan.rounds[plan.rounds.length-1];
  const lastRoundDone=lastRound&&[...lastRound.matchesA,...(lastRound.matchesB||[])].every(m=>m.winner);

  function MatchCard({m,ri,mi,side}){
    const gc=side==="A"?gcA:gcB, sc=getS(ri,mi,side);
    if(m.winner){return <Card style={{marginBottom:8,border:"0.5px solid #34D39444"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <span style={{fontSize:11,fontWeight:700,color:"var(--po-dim)",textTransform:"uppercase"}}>Court {m.court}{isLeague?` · Group ${side}`:""}</span>
        <Bdg label={`${m.winner==="A"?m.teamA?.name:m.teamB?.name} wins`} color="#34D399"/>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{flex:1,textAlign:"center"}}><div style={{fontSize:11,color:gc,fontWeight:600,marginBottom:2}}>{m.teamA?.name}</div>{isLeague&&<div style={{fontSize:26,fontWeight:700,color:m.winner==="A"?"#34D399":"var(--po-dim)"}}>{m.scoreA}</div>}</div>
        {isLeague&&<div style={{fontSize:14,color:"#334155",fontWeight:700}}>—</div>}
        <div style={{flex:1,textAlign:"center"}}><div style={{fontSize:11,color:gc,fontWeight:600,marginBottom:2}}>{m.teamB?.name}</div>{isLeague&&<div style={{fontSize:26,fontWeight:700,color:m.winner==="B"?"#34D399":"var(--po-dim)"}}>{m.scoreB}</div>}</div>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:6}}><SmBtn label="↩ Undo" onClick={()=>onSetWinCT(ri,mi,side,null,0,0)} color="#EF4444"/></div>
    </Card>;}

    return <Card style={{marginBottom:8}}>
      <div style={{fontSize:11,fontWeight:700,color:"var(--po-dim)",textTransform:"uppercase",marginBottom:10}}>Court {m.court}{isLeague?` · Group ${side}`:""}{!isLeague&&<span style={{color:"#38BDF8",marginLeft:8,textTransform:"none",fontSize:11}}> win = {ctLadderCourtPts(m.court,tc)} pts</span>}</div>
      {(()=>{
        const ri2=plan.rounds.findIndex(r=>r.roundNum===plan.rounds[plan.rounds.length-1].roundNum);
        function TeamBox({team,side2}){const isSel=selT&&selT.ri===ri2&&selT.tid===team?.id;return <div onClick={()=>{if(!onSwapCTLadder||isLeague)return;if(selT&&selT.ri===ri2&&selT.tid!==team?.id){onSwapCTLadder(ri2,selT.tid,team.id);setSelT(null);}else setSelT({ri:ri2,tid:team?.id});}} style={{textAlign:"center",padding:"6px",borderRadius:8,border:`1.5px solid ${isSel?"#FBBF24":"transparent"}`,background:isSel?"#FBBF2411":"transparent",cursor:!isLeague&&onSwapCTLadder?"pointer":"default"}}><div style={{fontSize:13,fontWeight:600,color:isSel?"#FBBF24":"var(--po-text)",marginBottom:2}}>{team?.name} <span style={{fontSize:11,color:"var(--po-dim)"}}>({team?.avgUsr})</span></div><div style={{fontSize:11,color:"var(--po-dim)"}}>{team?.players?.map(p=>p.nickname).join(" & ")}</div></div>;}
        return <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:8,marginBottom:isLeague?16:10,alignItems:"center"}}><TeamBox team={m.teamA} side2="A"/><span style={{fontSize:12,color:"#334155",fontWeight:700}}>VS</span><TeamBox team={m.teamB} side2="B"/></div>;
      })()}
      {isLeague&&<>
        <div style={{display:"flex",justifyContent:"center",alignItems:"flex-start",gap:24,marginBottom:12}}>
          <ScoreStepper value={sc.scoreA} onChange={v=>setS(ri,mi,side,"scoreA",v)} label={m.teamA?.name||"A"}/>
          <div style={{fontSize:20,color:"#334155",fontWeight:700,paddingTop:44}}>—</div>
          <ScoreStepper value={sc.scoreB} onChange={v=>setS(ri,mi,side,"scoreB",v)} label={m.teamB?.name||"B"}/>
        </div>
        {sc.scoreA===sc.scoreB&&sc.scoreA>0&&<div style={{textAlign:"center",fontSize:11,color:"#F59E0B",marginBottom:10}}>⚠️ Tied — adjust score to confirm winner</div>}
      </>}
      <div style={{display:"flex",gap:8}}>
        <button onMouseDown={e=>{e.preventDefault();onSetWinCT(ri,mi,side,"A",isLeague?sc.scoreA:1,isLeague?sc.scoreB:0);}}
          disabled={isLeague&&sc.scoreA<=sc.scoreB}
          style={{flex:1,padding:"10px 0",borderRadius:8,border:`0.5px solid ${!isLeague||sc.scoreA>sc.scoreB?"#6366F144":"var(--po-bdr)"}`,background:!isLeague||sc.scoreA>sc.scoreB?"#6366F122":"transparent",color:!isLeague||sc.scoreA>sc.scoreB?"#A5B4FC":"var(--po-dim)",fontSize:13,fontWeight:600,cursor:isLeague&&sc.scoreA<=sc.scoreB?"default":"pointer",opacity:isLeague&&sc.scoreA<=sc.scoreB?0.4:1}}>
          ← {m.teamA?.name}
        </button>
        <button onMouseDown={e=>{e.preventDefault();onSetWinCT(ri,mi,side,"B",isLeague?sc.scoreA:0,isLeague?sc.scoreB:1);}}
          disabled={isLeague&&sc.scoreB<=sc.scoreA}
          style={{flex:1,padding:"10px 0",borderRadius:8,border:`0.5px solid ${!isLeague||sc.scoreB>sc.scoreA?"#06B6D444":"var(--po-bdr)"}`,background:!isLeague||sc.scoreB>sc.scoreA?"#06B6D422":"transparent",color:!isLeague||sc.scoreB>sc.scoreA?"#67E8F9":"var(--po-dim)",fontSize:13,fontWeight:600,cursor:isLeague&&sc.scoreB<=sc.scoreA?"default":"pointer",opacity:isLeague&&sc.scoreB<=sc.scoreA?0.4:1}}>
          {m.teamB?.name} →
        </button>
      </div>
    </Card>;
  }

  // Rounds displayed newest first
  const reversedRounds=[...plan.rounds].reverse();

  return <>
    <div style={{marginBottom:12,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6}}>
      <span style={{fontSize:12,color:"var(--po-dim)"}}>{isLeague?`League Round ${plan.leagueRound}`:"Ladder"} · {tc} courts</span>
      <div style={{display:"flex",gap:6}}>{isLeague&&<><Bdg label={`A: ${plan.groupA?.length} teams`} color={gcA}/><Bdg label={`B: ${plan.groupB?.length} teams`} color={gcB}/></>}</div>
    </div>

    {/* Ladder: break row + next match button on top */}
    {!isLeague&&lastRound&&(()=>{
      const onBreak=lastRound.onBreak||[];
      const bPts=ctLadderBreakPts(tc);
      const maxR=plan.maxRounds||99;
      const ladderDone=plan.rounds.length>=maxR;
      return <>
        {selT&&<div style={{fontSize:12,padding:"8px 12px",borderRadius:8,marginBottom:8,background:"#FBBF2411",border:"0.5px solid #FBBF2444",display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{color:"#FBBF24"}}>✋ Team selected — tap another team or break team to swap</span><SmBtn label="✕" onClick={()=>setSelT(null)} color="#EF4444"/></div>}
      {lastRoundDone&&!ladderDone&&<Btn label={`▶ Generate Next Match (Round ${plan.rounds.length+1} of ${maxR})`} primary onClick={onNextCTLadder} style={{width:"100%",marginBottom:12}}/>}
        {lastRoundDone&&ladderDone&&<div style={{padding:"12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:10,fontSize:13,fontWeight:600,color:"#34D399",textAlign:"center",marginBottom:12}}>🏆 Event Complete — all rounds played! Check Standings.</div>}
        {onBreak.length>0&&<div style={{background:"#F59E0B0D",border:"0.5px solid #F59E0B33",borderRadius:10,padding:"10px 12px",marginBottom:12}}>
          <div style={{fontSize:11,color:"#F59E0B",fontWeight:600,marginBottom:8}}>🪑 On Break — {bPts} pts each{onSwapCTLadder&&<span style={{fontSize:10,color:"var(--po-dim)",marginLeft:8}}>Tap to select for swap</span>}</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{onBreak.map(t=>{const isSel=selT?.ri===lastRound.roundNum-1&&selT?.tid===t.id;return <div key={t.id} onClick={()=>{if(!onSwapCTLadder)return;if(selT&&selT.ri===lastRound.roundNum-1&&selT.tid!==t.id){onSwapCTLadder(lastRound.roundNum-1,selT.tid,t.id);setSelT(null);}else setSelT({ri:lastRound.roundNum-1,tid:t.id});}} style={{padding:"6px 10px",background:isSel?"#FBBF2422":"#F59E0B11",border:`1.5px solid ${isSel?"#FBBF24":"#F59E0B44"}`,borderRadius:8,cursor:onSwapCTLadder?"pointer":"default"}}>
            <div style={{fontSize:12,color:isSel?"#FBBF24":"#F59E0B",fontWeight:600}}>{t.name} ({t.avgUsr})</div>
            <div style={{fontSize:10,color:"var(--po-sub)"}}>{t.players?.map(p=>p.nickname).join(" & ")}</div>
          </div>;})}</div>
        </div>}
      </>;
    })()}

    {/* League: promo button on top */}
    {isLeague&&lastRoundDone&&plan.leagueRound<(plan.maxRounds||99)&&<>
      {plan.lastPromo&&<div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8,padding:"8px 12px",background:"var(--po-card)",borderRadius:8}}>
        Last: <span style={{color:"#34D399"}}>{plan.lastPromo.promoted?.map?.(t=>t?.name).join(", ")||plan.lastPromo.promoted?.name}</span> promoted · <span style={{color:"#F59E0B"}}>{plan.lastPromo.relegated?.filter(Boolean).map(t=>t?.name).join(", ")}</span> relegated
      </div>}
      <Btn label="🔀 Apply Promotion/Relegation & Start Next Round" primary onClick={onApplyPromo} style={{width:"100%",marginBottom:12}}/>
    </>}
    {isLeague&&lastRoundDone&&plan.leagueRound>=(plan.maxRounds||99)&&<div style={{padding:"12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:10,fontSize:13,fontWeight:600,color:"#34D399",textAlign:"center",marginBottom:12}}>🏆 Event Complete — all rounds played! Check Standings.</div>}
    {isLeague&&lastRoundDone&&plan.leagueRound>=(plan.maxRounds||99)&&<div style={{padding:"6px 10px",background:"#6366F111",borderRadius:6,fontSize:11,color:"#6366F1",marginBottom:8}}>Final standings: all teams merged by total points</div>}

    {/* Rounds — newest first */}
    {reversedRounds.map((round,revIdx)=>{
      const ri=plan.rounds.length-1-revIdx;
      const isLatest=revIdx===0;
      return <div key={ri} style={{marginBottom:20,opacity:isLatest?1:0.7}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <span style={{fontSize:14,fontWeight:700,color:isLatest?"var(--po-text)":"var(--po-dim)"}}>
            {isLeague?`League Round ${round.roundNum}`:`Match Round ${round.roundNum}`}
          </span>
          {[...round.matchesA,...(round.matchesB||[])].every(m=>m.winner)&&<Bdg label="✓ Complete" color="#34D399"/>}
        </div>
        {isLatest&&<MatchTimerWidget plan={plan} roundDuration={plan.matchDuration||plan.roundDuration} totalRounds={Math.max(1,Math.round(totalBookingMin/(plan.matchDuration||plan.roundDuration||20)))} totalBookingMin={totalBookingMin} eventDate={eventDate} eventTime={eventTime} unitLabel="Match" sim={sim} onStart={onSetMatchModeStart}/>}
        {isLeague
          ?<>{round.matchesA.map((m,mi)=><MatchCard key={`A${mi}`} m={m} ri={ri} mi={mi} side="A"/>)}{(round.matchesB||[]).map((m,mi)=><MatchCard key={`B${mi}`} m={m} ri={ri} mi={mi} side="B"/>)}</>
          :<>{round.matchesA.map((m,mi)=><MatchCard key={`A${mi}`} m={m} ri={ri} mi={mi} side="A"/>)}</>
        }
      </div>;
    })}
  </>;
}

// Minutes remaining for rounds 2..N after Round 1 keeps its full duration and the
// admin-declared delay is absorbed — split evenly so the last round still finishes
// on the booking's end time. Falls back to (rounds × duration) when no end time is set,
// which still compresses proportionally to the delay.
function computeRoundEndOffsets(totalRounds, roundDuration, totalBookingMin, delayMin){
  const offsets = {1: roundDuration};
  if (totalRounds<=1) return offsets;
  const bookingMin = totalBookingMin || (totalRounds*roundDuration);
  const remainingMin = bookingMin - delayMin - roundDuration;
  const restDur = Math.max(1, remainingMin/(totalRounds-1)); // never compress below 1 min/round
  for (let n=2; n<=totalRounds; n++) offsets[n] = offsets[n-1] + restDur;
  return offsets;
}

// ══════════════════════════════════════════════════════
//  MATCH MODE — countdown widget shown atop the active round
// ══════════════════════════════════════════════════════
function MatchTimerWidget({plan,roundDuration,totalRounds,totalBookingMin,eventDate,eventTime,unitLabel,sim,onStart}){
  const [now,setNow]         = useState(Date.now());
  const [startInput,setStartInput] = useState(addMinutesToTime(eventTime,5)||"");
  const [flash,setFlash]     = useState(false);
  const prevSlotRef = React.useRef(1);
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
  const isCompressed = started && slot>1 && Math.round(restDur)<rd;

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
      playWhistle();
      setFlash(true);
      const t = setTimeout(()=>setFlash(false), 2500);
      return () => clearTimeout(t);
    }
  }, [slotRaw]);

  if (!started) {
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
        <Btn label="Start ▶" primary onClick={()=>onStart(minutesBetween(eventTime,startInput))}/>
      </div>
    </Card>;
  }

  if (eventOver) {
    return <Card style={{marginBottom:10,background:"#EF444422",border:"0.5px solid #EF444466"}}>
      <div style={{fontSize:11,color:"#EF4444",fontWeight:600}}>🏁 Booking time is up</div>
      <div style={{fontSize:12,color:"var(--po-dim)",marginTop:4}}>All {tr} scheduled rounds have run their course.</div>
    </Card>;
  }

  const mm = String(Math.floor(remaining/60)).padStart(2,"0");
  const ss = String(remaining%60).padStart(2,"0");
  const endClock = endAt ? new Date(endAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : null;
  return <Card style={{marginBottom:10,background:flash?"#EF444422":"#6366F111",border:`0.5px solid ${flash?"#EF444466":"#6366F144"}`}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div>
        <div style={{fontSize:11,color:flash?"#EF4444":"#A5B4FC",fontWeight:600}}>{flash?"⏰ Time's up!":endClock?`⏱ ${unitLabel||"Round"} ${slot} ends at ${endClock}`:`⏱ ${unitLabel||"Round"} ${slot} ends in`}</div>
        <div style={{fontSize:26,fontWeight:800,color:flash?"#EF4444":"var(--po-text)",fontVariantNumeric:"tabular-nums"}}>{mm}:{ss}</div>
        {isCompressed&&<div style={{fontSize:10,color:"#F59E0B",marginTop:4}}>⚠️ Compressed to ~{Math.round(restDur)}min to catch up from the {delayMin}min delay</div>}
      </div>
      {flash&&<SmBtn label="🔔 Replay" onClick={playWhistle} color="#EF4444"/>}
    </div>
  </Card>;
}

// ══════════════════════════════════════════════════════
//  EVENT DETAIL
// ══════════════════════════════════════════════════════
function EvDetail({ev,comm,users,venues,me,onBack,onEditEvent,onRegister,onCheckIn,onAddMember,onAddGuest,onVote,onResolveType,onCloseEvent,onStartCI,onSetWinCI,onNextRound,onSwap,onEditBreak,onRegenerateBreaks,onStartCT,onSetWinCT,onApplyPromo,onNextCTLadder,onSwapCTLadder,onRemoveFromEvent,onEditGuestUsr,onEditEventUsr,onToast,onDuplicate,onDelete,onArchive,onUnarchive,onViewProfile,onSwapCTBreak,onRegenCTBreaks,onToggleExempt,onTogglePaid,onUpdateEventFinance,onSetMatchModeStart}){
  const [tab,setTab]       = useState("info");
  const [sim,setSim]       = useState(false);
  const [totalR,setTotalR] = useState(6);
  const [roundDur,setRDur] = useState(20);
  const [showAddM,setSAM]  = useState(false);
  const [showAddG,setSAG]  = useState(false);
  const [gf,setGf]         = useState({n:"",name:"",p:"",usr:"50"});
  const [sel,setSel]       = useState(null);
  const [showResultsTable,setShowResultsTable] = useState(false);
  const [ctC,setCtC]       = useState(null);
  const [ctF,setCtF]       = useState("league");
  const [ctDur,setCtDur]   = useState(20);
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
    editEventUsr: (uid,usr) => sim
      ? simMutate(e => ({...e, registrations:e.registrations.map(r=>r.userId!==uid?r:{...r,eventUsr:usr===""?null:parseInt(usr)||0})}))
      : onEditEventUsr(uid,usr),
    startCI: (n,dur) => sim
      ? simMutate(e => {
          const players = e.registrations.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return{...u,usr:r.eventUsr??u.usr,userId:r.userId,histBreaks:0};}).filter(Boolean);
          return {...e, plan:{...genRound1(players, e.courts, n), roundDuration:dur}};
        })
      : onStartCI(n,dur),
    setWinCI: (ri,mi,w) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const rounds = e.plan.rounds.map((r,rr)=>rr!==ri?r:{...r,matches:r.matches.map((m,mm)=>mm!==mi?m:{...m,winner:w})});
          return {...e, plan:{...e.plan, rounds}};
        })
      : onSetWinCI(ri,mi,w),
    nextRound: () => sim
      ? simMutate(e => e.plan ? {...e, plan: genNextRoundCI(e.plan)} : e)
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
          const fresh=buildCTBreakPlan(teams,tc,total,newBreakPlan.slice(0,generatedRounds));
          for(let i=generatedRounds;i<total;i++) newBreakPlan[i]=fresh[i];
          return {...e, plan:{...plan, breakPlan:newBreakPlan}};
        })
      : onRegenCTBreaks&&onRegenCTBreaks(),
    startCT: (c,f,dur) => sim
      ? simMutate(e => {
          const players = e.registrations.map(r=>{const u=users.find(u=>u.id===r.userId);if(!u)return null;return{...u,usr:r.eventUsr??u.usr,userId:r.userId};}).filter(Boolean);
          return {...e, plan: generateCTPlan(players, c, f, e, dur)};
        })
      : onStartCT(c,f,dur),
    setWinCT: (ri,mi,side,w,sA,sB) => sim
      ? simMutate(e => {
          if(!e.plan) return e;
          const rounds=e.plan.rounds.map((r,rr)=>{
            if(rr!==ri) return r;
            const up=arr=>arr.map((m,mm)=>mm!==mi?m:{...m,winner:w,scoreA:sA,scoreB:sB});
            return {...r, matchesA:side==="A"?up(r.matchesA):r.matchesA, matchesB:side==="B"?up(r.matchesB):r.matchesB};
          });
          return {...e, plan:{...e.plan, rounds}};
        })
      : onSetWinCT(ri,mi,side,w,sA,sB),
    applyPromo: () => sim
      ? simMutate(e => e.plan ? {...e, plan: applyPromoRelegation(e.plan)} : e)
      : onApplyPromo(),
    nextCTLadder: () => sim
      ? simMutate(e => e.plan ? {...e, plan: genNextCTLadder(e.plan)} : e)
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
    closeEvent: () => sim
      ? (onToast&&onToast("Can't close an event while simulating — exit Simulation Mode first.","err"))
      : onCloseEvent(),
    vote: (k) => sim ? null : onVote(k),
    resolveType: (k) => sim ? null : onResolveType(k),
    toggleExempt: (uid) => sim
      ? simMutate(e=>{const ex=new Set(e.exempted||[]);ex.has(uid)?ex.delete(uid):ex.add(uid);return{...e,exempted:[...ex]};})
      : onToggleExempt&&onToggleExempt(uid),
    togglePaid: (uid) => sim
      ? simMutate(e=>{const p=new Set(e.paidIds||[]);p.has(uid)?p.delete(uid):p.add(uid);return{...e,paidIds:[...p]};})
      : onTogglePaid&&onTogglePaid(uid),
    setMatchModeStart: (delayMin) => sim
      ? simMutate(e=>({...e,plan:{...e.plan,matchModeStartAt:new Date().toISOString(),matchModeDelayMin:delayMin}}))
      : onSetMatchModeStart&&onSetMatchModeStart(delayMin),
    updateFinance: (fields) => sim
      ? simMutate(e=>({...e,...fields}))
      : onUpdateEventFinance&&onUpdateEventFinance(fields),
  };

  const venue  = venues.find(v=>v.id===effEv.venueId);
  const myMem  = comm.members.find(m=>m.userId===me.id);
  const isAdmin= myMem?.role==="owner"||myMem?.role==="admin";
  const isReg  = myMem?.status==="regular";
  const myReg  = effEv.registrations.find(r=>r.userId===me.id);
  const isCIn  = effEv.checkedIn.includes(me.id);
  const isOpen = effEv.type==="open";
  const isCI   = effEv.type==="closed_ind";
  const isCT   = effEv.type==="closed_teams";
  const tc     = effEv.courts;
  const bp     = breakPts(tc);
  const ideal  = tc*5, maxCap=tc*6;
  // Financial model:
  // Total = (courtCost × courts × durationHours) + (extraFee × courts × durationHours) + one flat additional amount
  // Paying = checkedIn - exempted
  const durationHrs = (()=>{
    if(!effEv.time||!effEv.timeTo) return 2;
    const [h1,m1]=effEv.time.split(":").map(Number);
    const [h2,m2]=(effEv.timeTo||"").split(":").map(Number);
    if(isNaN(h2)) return 2;
    return Math.max(0.5, ((h2*60+m2)-(h1*60+m1))/60);
  })();
  const exemptedIds = new Set(effEv.exempted||[]);
  const courtTotal  = (effEv.costPerCourt||0)*tc*durationHrs;
  const extraFeeTotal = (effEv.extraFee||0)*tc*durationHrs;
  const extraExp    = effEv.extraExpenses||0; // one flat additional amount, if any (e.g. extra gear, a shared tip)
  const totC        = Math.round(courtTotal + extraFeeTotal + extraExp);
  const cinCnt      = effEv.checkedIn.length;
  // Open Events split cost by actual check-in; CI/CT have no check-in step,
  // so cost is split across registered players instead (attendance is assumed).
  const attendeeIds = isOpen ? effEv.checkedIn : effEv.registrations.map(r=>r.userId);
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
  const canReg = !myReg&&effEv.status==="registration_open"&&(!inRW||isReg||isAdmin);
  const isDay  = sim||effEv.date===today;
  const plan   = effEv.plan;
  const tl     = {open:"Open Day",closed_ind:"Closed Individuals",closed_teams:"Closed Teams"};
  const isCompleted = effEv.status==="completed";

  // CT calc
  const ctCC   = isCT?calcCTCourts(effEv.registrations.length,effEv.reservedCourts||effEv.courts||2):null;
  const selCtC = ctC??ctCC?.min??tc;
  const nTeams = Math.floor(effEv.registrations.length/2);
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
  const [shareDiag,setShareDiag] = useState(null);

  const sharePlayers = effEv.registrations.map(r=>{const u=users.find(u=>u.id===r.userId);return u?{...u,usr:r.eventUsr??u.usr}:null;}).filter(Boolean);

  async function handleShareBefore(){
    setSharing(true);setShareDiag(null);
    try{
      const cards=[buildEventInfoCard(effEv,venue,sharePlayers,comm.name, isCT&&plan?plan:null)];
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
      const result = await shareImages(cards, effEv.name.replace(/\s+/g,"_"));
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
        cards=[buildCTStandingsCard(effEv,venue,ctStands,plan.format,comm.name)];
        if(plan.format==="ladder"&&plan.rounds?.length>0)
          cards.push(buildCTResultsTableCard(effEv,venue,plan,ctStands,tc,comm.name));
        if(plan.format==="league"&&plan.rounds?.length>0)
          cards.push(buildLeagueMatchResultsCard(effEv,venue,plan,comm.name));
      } else {
        cards=[buildStandingsCard(effEv,venue,ciStands,tc,plan,comm.name)];
        if(plan) cards.push(buildResultsTableCard(effEv,venue,plan,ciStands,tc,comm.name));
        if(plan) cards.push(buildRoundResultsCard(effEv,venue,plan,comm.name));
      }
      const result = await shareImages(cards, effEv.name.replace(/\s+/g,"_")+"_results");
      if(result.status==="shared"){ onToast&&onToast(`Shared ✓ (${cards.length} image${cards.length>1?"s":""})`); }
      else { onToast&&onToast(`Native share unavailable — ${cards.length} image(s) downloaded`); setShareDiag(result.diag); }
    }catch(e){
      console.error("Share error:",e);
      onToast&&onToast("Share failed: "+(e.message||"unknown error"),"err");
    }finally{ setSharing(false); }
  }

  const tabs=["info","players",
    ...(isCI&&isAdmin?(plan?["breaks","rounds","standings"]:["rounds"]):[]),
    ...(isCT&&isAdmin?(plan?(plan.format==="ladder"?["teams","breaks","matches","standings"]:["teams","matches","standings"]):["teams"]):[]),
    ...(isAdmin?["manage"]:[])
  ];
  const tLabels={info:"Info",players:"Players",manage:"💰 Financial",breaks:"Breaks",rounds:"Rounds",standings:"Standings",teams:"Teams",matches:"Matches"};

  function tapP(ri,uid){if(!sel){setSel({ri,uid});return;}if(sel.ri!==ri){setSel({ri,uid});return;}if(sel.uid===uid){setSel(null);return;}act.swap(ri,sel.uid,uid);setSel(null);}
  function PChip({p,ri}){
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
    return <div onClick={()=>!isCompleted&&tapP(ri,p.userId)} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:8,cursor:"pointer",userSelect:"none",border:`2px solid ${isSel?"#FBBF24":isTgt?"#34D399":"transparent"}`,background:isSel?"#FBBF2422":isTgt?"#34D39922":"transparent"}}>
      <div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,background:`${lv.c}22`,border:`1.5px solid ${lv.c}66`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:lv.c}}>{p.avatar||ini2(p.nickname)}</div>
      <span style={{fontSize:13,fontWeight:500,color:"var(--po-text)",flex:1}}>{p.nickname}</span>
      {histBadge&&<span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:10,whiteSpace:"nowrap",background:`${histBadge.color}22`,color:histBadge.color,border:`0.5px solid ${histBadge.color}44`}}>{histBadge.label}</span>}
      <span style={{fontSize:11,color:"var(--po-dim)"}}>{p.usr}</span>
    </div>;
  }
  function WinCI({m,ri,mi}){
    const avgA=m.teamA?Math.round(m.teamA.reduce((s,p)=>s+p.usr,0)/m.teamA.length):0;
    const avgB=m.teamB?Math.round(m.teamB.reduce((s,p)=>s+p.usr,0)/m.teamB.length):0;
    if(m.winner){const wT=m.winner==="A"?m.teamA:m.teamB;return <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10}}><div style={{flex:1,padding:"9px",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:12,fontWeight:600,color:"#34D399",textAlign:"center"}}>✓ {wT.map(p=>p.nickname).join(" & ")} won</div>{!isCompleted&&<SmBtn label="↩" onClick={()=>act.setWinCI(ri,mi,null)} color="#EF4444"/>}</div>;}
    if(isCompleted) return null;
    return <div style={{display:"flex",gap:8,marginTop:10}}>
      <button onMouseDown={e=>{e.preventDefault();act.setWinCI(ri,mi,"A");}} style={{flex:1,padding:"10px 0",borderRadius:8,border:"0.5px solid #6366F144",background:"#6366F111",color:"#A5B4FC",fontSize:13,fontWeight:600,cursor:"pointer"}}>← Team A wins <span style={{fontSize:10,opacity:0.7}}>({avgA})</span></button>
      <button onMouseDown={e=>{e.preventDefault();act.setWinCI(ri,mi,"B");}} style={{flex:1,padding:"10px 0",borderRadius:8,border:"0.5px solid #06B6D444",background:"#06B6D411",color:"#67E8F9",fontSize:13,fontWeight:600,cursor:"pointer"}}>Team B wins → <span style={{fontSize:10,opacity:0.7}}>({avgB})</span></button>
    </div>;}

  return <>
    <BBtn onBack={onBack} label={comm.name} sticky eventLabel={`${ev.name} #${ev.id}`} subLabel={tLabels[tab]}/>
    {isAdmin&&!sim&&<div className="po-card" style={{marginBottom:12,padding:"10px 14px",background:"var(--po-card)",borderRadius:10,border:"0.5px solid var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}><div><div style={{fontSize:12,fontWeight:600,color:"var(--po-sub)"}}>🧪 Practice Session</div><div style={{fontSize:11,color:"var(--po-dim)"}}>Try out registrations, matches & scores — nothing is saved</div></div><SmBtn label="Start ▶" onClick={startSim} color="#6366F1"/></div>}
    {sim&&<div style={{marginBottom:12,padding:"10px 14px",background:"#6366F111",borderRadius:10,border:"0.5px solid #6366F155",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}><div><div style={{fontSize:12,fontWeight:600,color:"#A5B4FC"}}>🧪 Practice Session Active</div><div style={{fontSize:10,color:"var(--po-dim)"}}>{ev.status==="completed"?"Replaying from scratch with the same players — original results are untouched":"All changes here are temporary"}</div></div><SmBtn label="Exit & Discard" onClick={exitSim} color="#EF4444"/></div>}

    <Card>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div>
          <div className="po-text" style={{fontWeight:700,fontSize:17,color:"var(--po-text)",marginBottom:4,display:"flex",alignItems:"center",gap:8}}>{ev.name} <span style={{fontSize:11,fontWeight:500,color:"var(--po-dim)",background:"var(--po-inp)",padding:"2px 8px",borderRadius:6}}>#{ev.id}</span>{ev.isDemo&&<Bdg label="Demo" color="#F59E0B"/>}</div>
          {venue&&<div style={{fontSize:12,color:"var(--po-dim)"}}>🏟 {venue.name} · {venue.area}</div>}
          <div style={{fontSize:12,color:"var(--po-dim)"}}>🗓 {fmtD(ev.date)} · {ev.time}{ev.timeTo?` → ${ev.timeTo}`:""}</div>
          {(()=>{const creator=users.find(u=>u.id===ev.createdBy);return creator?<div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>👤 Created by {creator.nickname}</div>:null;})()}
          {ev.description&&<div style={{fontSize:12,color:"var(--po-sub)",marginTop:6,padding:"6px 10px",background:"var(--po-inp)",borderRadius:6,fontStyle:"italic"}}>📝 {ev.description}</div>}
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end"}}>
          {ev.type&&<Bdg label={tl[ev.type]} color="#6366F1"/>}
          {!ev.type&&<Bdg label="🗳 Poll" color="#F59E0B"/>}
          {isCompleted&&<Bdg label="✓ Completed" color="#34D399"/>}
          {ev.archived&&<Bdg label="📦 Archived" color="#94A3B8"/>}
          {isAdmin&&<SmBtn label="✏️ Edit" onClick={onEditEvent} color="#6366F1"/>}
          {isAdmin&&<SmBtn label="⧉ Duplicate" onClick={()=>setShowDup(o=>!o)} color="#F59E0B"/>}
          {isAdmin&&!isCompleted&&<SmBtn label="🗑 Delete" onClick={()=>{if(window.confirm(`Delete "${ev.name}" (#${ev.id})?\n\nThis cannot be undone — all registrations and data will be permanently lost.`))onDelete();}} color="#EF4444"/>}
          {isAdmin&&isCompleted&&!ev.archived&&<SmBtn label="📦 Archive" onClick={()=>{if(window.confirm(`Archive "${ev.name}" (#${ev.id})?\n\nIt will be hidden from event lists but kept permanently in history. You can restore it later.`))onArchive();}} color="#94A3B8"/>}
          {isAdmin&&ev.archived&&<SmBtn label="📤 Unarchive" onClick={onUnarchive} color="#34D399"/>}
          {!isCompleted&&<SmBtn label={sharing?"⏳ Sharing...":"📤 Share Event"} onClick={handleShareBefore} color="#34D399"/>}
          {isCompleted&&<SmBtn label={sharing?"⏳ Sharing...":"📤 Share Results"} onClick={handleShareAfter} color="#34D399"/>}
        </div>
      </div>

      {showDup&&<div style={{marginTop:-4,marginBottom:12,padding:"12px",background:"var(--po-inp)",borderRadius:10,border:"0.5px solid #F59E0B44"}}>
        <div style={{fontSize:12,fontWeight:600,color:"#F59E0B",marginBottom:8}}>⧉ Duplicate this event — pick a new date and time</div>
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
        <Btn label="Create Copy" primary onClick={()=>{if(dupDate&&dupTime){onDuplicate(dupDate,dupKeepPlayers,dupTime,dupTimeTo);setShowDup(false);}}} style={{width:"100%"}}/>
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

      <div style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--po-dim)",marginBottom:4}}><span>{effEv.registrations.length} registered</span><span>Ideal {ideal} · Max {maxCap}</span></div>
        <div style={{height:6,background:"var(--po-bdr)",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,transition:"width 0.3s",width:`${Math.min(100,(effEv.registrations.length/ideal)*100)}%`,background:effEv.registrations.length>=ideal?"#EF4444":"#6366F1"}}/></div>
        {inRW&&!isReg&&!isAdmin&&<div style={{fontSize:11,color:"#FBBF24",marginTop:3}}>⏳ Priority for Regular Members until {new Date(effEv.regularUntil).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div>}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:12}}>
        {[["Courts",tc],["Registered",effEv.registrations.length],
          ...(isOpen?[["Checked In",cinCnt],["Per Person",`${cpp} EGP`]]:
              isCI?[["Rounds",plan?.rounds?.length||0],[`C1=${courtPts(1,tc)}pts`,`Brk=${bp}pts`]]:
              isCT?[["Teams",plan?.teams?.length||0],["Format",plan?.format||"—"]]:[])
        ].map(([l,val])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"7px 4px",textAlign:"center"}}><div style={{fontSize:13,fontWeight:700,color:"var(--po-text)"}}>{val}</div><div style={{fontSize:9,color:"var(--po-dim)",marginTop:1}}>{l}</div></div>)}
      </div>

      {!isCompleted&&effEv.status==="registration_open"&&<>
        {canReg&&<Btn label="I'm In ✓" primary onClick={act.register} style={{width:"100%",marginBottom:6}}/>}
        {myReg&&isOpen&&(isDay?(!isCIn?<div style={{display:"flex",gap:6,marginBottom:6}}><div style={{flex:1,padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399"}}>✓ Registered</div><Btn label="Check In" primary onClick={()=>act.checkIn(me.id)} style={{flex:1}}/></div>:<div style={{padding:"9px",textAlign:"center",background:"#6366F122",border:"0.5px solid #6366F144",borderRadius:8,fontSize:13,fontWeight:500,color:"#A5B4FC",marginBottom:6}}>✓ Checked In</div>):<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399",marginBottom:6}}>✓ Registered — check-in on event day</div>)}
        {myReg&&(isCI||isCT)&&<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399",marginBottom:6}}>✓ Registered — attendance via match results</div>}
        {isAdmin&&!sim&&<Btn label="🏁 Close & Finish Event" danger onClick={act.closeEvent} style={{width:"100%"}}/>}
        {isAdmin&&sim&&<div style={{padding:"9px",textAlign:"center",background:"#6366F111",border:"0.5px solid #6366F144",borderRadius:8,fontSize:12,color:"#A5B4FC"}}>🧪 Exit Practice Session to close this event for real</div>}
      </>}
      {isCompleted&&<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:600,color:"#34D399"}}>✓ Event Completed</div>}
    </Card>

    <VenueMapCard venue={venue}/>

    <Tabs tabs={tabs.map(t=>[t,tLabels[t]||t])} active={tab} onChange={setTab}/>

    {/* INFO */}
    {tab==="info"&&<Card><div style={{display:"flex",flexDirection:"column",gap:8}}>{[["Venue",venue?`${venue.name}, ${venue.area}`:"TBD"],
        ["Type",ev.type?tl[ev.type]:"Pending Poll"],
        ["Date & Time",`${fmtD(ev.date)} · ${ev.time}${ev.timeTo?" → "+ev.timeTo:""}`],
        ["Duration",(()=>{if(!ev.time||!ev.timeTo)return "—";const[sh,sm]=ev.time.split(":").map(Number);const[eh,em]=ev.timeTo.split(":").map(Number);const m=(eh*60+em)-(sh*60+sm);if(m<=0)return "—";const h=Math.floor(m/60),rm=m%60;return h>0?(rm>0?`${h}h ${rm}min`:`${h}h`):`${rm}min`;})()],
        ["Created by",(()=>{const u=users.find(u=>u.id===ev.createdBy);return u?`${u.nickname} (${u.name})`:"—";})()],...(isCI?[["Scoring",Array.from({length:tc},(_,i)=>`Court ${i+1}=${courtPts(i+1,tc)}pts`).join(" · ")+` · Break=${bp}pts`],["Round Duration",`${plan?.roundDuration||roundDur} min`]]:isOpen?[["Rotation",`Every ${effEv.rotationMin} min`],["Check-in","Required · cost split by attendees"]]:isCT?[["Formation","Multi-Pool Snake (USR)"],["Competition",plan?.format==="ladder"?"Ladder":"League + Promo/Relego"],[plan?.format==="ladder"?"Scoring":"Ranking",plan?.format==="ladder"?`Court ${tc}=1pt ... Court 1=${tc}pts · Break=${ctLadderBreakPts(tc)}pts`:"Group A first · Wins → Score Diff"],["Match Duration",`${plan?.matchDuration||20} min`]]:[]),["Priority Reg.","Regular Members: 24h early access"]].map(([k,val])=><div key={k} style={{display:"flex",gap:8,paddingBottom:7,borderBottom:"0.5px solid var(--po-bdr)"}}><span className="po-dim" style={{fontSize:12,color:"var(--po-dim)",minWidth:110}}>{k}</span><span className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>{val}</span></div>)}</div></Card>}

    {/* PLAYERS */}
    {tab==="players"&&<>
      {isCT&&ctR1Locked&&<div style={{marginBottom:10,padding:"8px 12px",background:"#EF444411",border:"0.5px solid #EF444433",borderRadius:8,fontSize:12,color:"#EF4444"}}>🔒 Round 1 has results — player list, team formation, and breaks are now frozen.</div>}
      {isCT&&!ctR1Locked&&plan&&<div style={{marginBottom:10,padding:"8px 12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:8,fontSize:12,color:"#34D399"}}>✓ You can still add/remove players and regenerate teams until Round 1 has results.</div>}
      {isCI&&ciR1Locked&&<div style={{marginBottom:10,padding:"8px 12px",background:"#EF444411",border:"0.5px solid #EF444433",borderRadius:8,fontSize:12,color:"#EF4444"}}>🔒 Round 1 has results — player list is now frozen.</div>}
      {isCI&&!ciR1Locked&&plan&&<div style={{marginBottom:10,padding:"8px 12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:8,fontSize:12,color:"#34D399"}}>✓ You can still add/remove players until Round 1 has results.</div>}
      {isAdmin&&!(ctR1Locked||ciR1Locked)&&<><div style={{display:"flex",gap:6,marginBottom:10}}><Btn label="+ Add Member" onClick={()=>{setSAM(o=>!o);setSAG(false);}} style={{flex:1}}/>{!sim&&<Btn label="+ Add Guest" onClick={()=>{setSAG(o=>!o);setSAM(false);}} style={{flex:1}}/>}</div>
      {showAddM&&<Card style={{marginBottom:10}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Select member to add:</div>{comm.members.filter(m=>!new Set(effEv.registrations.map(r=>r.userId)).has(m.userId)).map(m=>users.find(u=>u.id===m.userId)).filter(Boolean).map(u=><div key={u.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"0.5px solid var(--po-bdr)"}}><Av u={u} size={30}/><div style={{flex:1}}><div style={{fontSize:13,fontWeight:500,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr}</div></div><SmBtn label="Add" onClick={()=>act.addMember(u.id)} color="#6366F1"/></div>)}{comm.members.filter(m=>!new Set(effEv.registrations.map(r=>r.userId)).has(m.userId)).length===0&&<div style={{fontSize:12,color:"var(--po-dim)",textAlign:"center",padding:"8px 0"}}>All community members are registered ✓</div>}<SmBtn label="✓ Done" onClick={()=>setSAM(false)} color="#34D399" style={{width:"100%",marginTop:8}}/></Card>}
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
        <Btn label="Add Guest" primary onClick={()=>{if(gf.n&&gf.p){act.addGuest(gf);setGf({n:"",name:"",p:"",usr:"50"});}}} style={{width:"100%"}}/>
        <SmBtn label="✓ Done" onClick={()=>setSAG(false)} color="#34D399" style={{width:"100%",marginTop:8}}/>
      </Card>}</>}
      {isOpen&&cinCnt>0&&<><ST>Checked In ({cinCnt})</ST>{effEv.checkedIn.map(uid=>{const u=users.find(u=>u.id===uid);if(!u)return null;return <Card key={uid}><div style={{display:"flex",alignItems:"center",gap:10}}><Av u={u} size={34}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr}</div></div><Bdg label="✓ In" color="#34D399"/></div></Card>;})}</>}
      {isCT&&plan?.waitlisted?.length>0&&<>
        <ST>⏳ Waiting List (odd player count)</ST>
        {plan.waitlisted.map(w=>{const wu=users.find(u=>u.id===w.userId);return <Card key={w.userId} style={{marginBottom:8,borderColor:"#F59E0B66",background:"#F59E0B08"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
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
        const waitlistedIds=new Set((plan?.waitlisted||[]).map(w=>w.userId));
        const activeRegs=effEv.registrations.filter(r=>!waitlistedIds.has(r.userId));
        return <><ST>Registered ({activeRegs.length})</ST>
        {activeRegs.map(r=>{
        const u=users.find(u=>u.id===r.userId);if(!u)return null;
        const ci2=effEv.checkedIn.includes(u.id);
        return <Card key={r.userId}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <Av u={u} size={34}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)",display:"flex",alignItems:"center",gap:6}}>
                {u.nickname}
                {isAdmin&&!u.isGuest&&<span onClick={()=>onViewProfile&&onViewProfile(u.id)} style={{fontSize:10,color:COLORS?.accent||"#6366F1",cursor:"pointer",textDecoration:"underline"}}>👁 profile</span>}
                {u.isGuest&&<span style={{marginLeft:4,fontSize:10,color:"#F59E0B"}}>GUEST{u.phone?` · ${u.phone}`:""}</span>}
              </div>
              {/* Guest USR - editable inline, saves on blur or Enter */}
              {u.isGuest||r.isGuest
                ? <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                    <span style={{fontSize:11,color:"var(--po-dim)"}}>USR</span>
                    <input type="number" min="0" max="100" defaultValue={u.usr}
                      onBlur={e=>{const v=parseInt(e.target.value); if(!isNaN(v)&&v!==u.usr){act.editGuestUsr(u.id,v);e.target.style.borderColor="#34D399";}}}
                      onKeyDown={e=>{if(e.key==="Enter"){const v=parseInt(e.target.value);if(!isNaN(v)){act.editGuestUsr(u.id,v);e.target.blur();}}}}
                      className="po-inp"
                      style={{width:52,padding:"2px 6px",borderRadius:6,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",fontSize:12,fontWeight:600}}/>
                    <span style={{fontSize:10,color:"var(--po-dim)"}}>/100 · tap Enter to save</span>
                  </div>
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
            </div>
            <div style={{display:"flex",gap:4,flexWrap:"wrap",justifyContent:"flex-end",alignItems:"center"}}>
              {r.addedBy&&r.addedBy!=="admin"&&!r.isGuest&&<Bdg label={`by ${r.addedBy}`} color="#6366F1"/>}
              {r.addedBy==="admin"&&!r.isGuest&&<Bdg label="Added by Admin" color="#6366F1"/>}
              {(r.isGuest||u.isGuest)&&<Bdg label={r.addedBy?`Guest · by ${r.addedBy}`:"Guest"} color="#F59E0B"/>}
              {isOpen&&!ci2&&isAdmin&&isDay&&<SmBtn label="✓ In" onClick={()=>act.checkIn(u.id)} color="#34D399"/>}
              {isOpen&&ci2&&<Bdg label="✓ In" color="#34D399"/>}
              {isAdmin&&(!effEv.plan||(isCT&&!ctR1Locked)||(isCI&&!ciR1Locked))&&<SmBtn label="✕" onClick={()=>act.removeFromEvent(u.id)} color="#EF4444" style={{padding:"4px 8px",fontSize:11}}/>}
            </div>
          </div>
        </Card>;
      })}</>;})()}
    </>}

    {/* MANAGE */}
    {tab==="manage"&&isAdmin&&<>
      {isOpen&&effEv.registrations.length<tc*4&&<Card style={{background:"#EF444411",border:"0.5px solid #EF444444",marginBottom:10}}><div style={{fontSize:13,fontWeight:600,color:"#EF4444",marginBottom:4}}>⚠️ Insufficient Players</div><div className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>Need {tc*4} players. Currently {effEv.registrations.length}.</div></Card>}
      {!isOpen&&<Card style={{background:"#6366F111",border:"0.5px solid #6366F144",marginBottom:10}}><div style={{fontSize:11,color:"var(--po-sub)"}}>ℹ️ {isCI?"Closed Individuals":"Closed Teams"} events have no check-in step — cost is split across all {attCnt} registered players (attendance is assumed).</div></Card>}
      {sim&&attCnt>0&&<Card style={{background:"#6366F111",border:"0.5px solid #6366F144",marginBottom:10}}><div style={{fontSize:13,fontWeight:600,color:"#A5B4FC",marginBottom:10}}>💰 Live Cost Settlement</div>{[["Total",`${totC} EGP`],[isOpen?"Checked In":"Registered",attCnt],["Paying",payingCnt],["Per Player",`${cpp} EGP`]].map(([k,val])=><div key={k} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"0.5px solid #6366F122"}}><span style={{fontSize:13,color:"var(--po-dim)"}}>{k}</span><span style={{fontSize:14,fontWeight:700,color:k==="Per Player"?"#A5B4FC":"var(--po-text)"}}>{val}</span></div>)}</Card>}
      <ST>💰 Financial</ST>
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
                  <span style={{fontSize:13,fontWeight:600,color:"var(--po-text)"}}>{u.nickname}</span>
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
    </>}

    {/* CI BREAKS */}
    {tab==="breaks"&&isCI&&isAdmin&&plan&&<BreaksTab plan={plan} ev={effEv} users={users} bp={bp} tc={tc} onEditBreak={act.editBreak} onRegenerate={act.regenerateBreaks}/>}

    {/* CI ROUNDS */}
    {tab==="rounds"&&isCI&&isAdmin&&<>
      {!plan&&<Card>
        <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Generate Round 1</div>
        <div style={{fontSize:13,color:"var(--po-sub)",marginBottom:12}}>{effEv.registrations.length} players · {tc} courts · {Math.max(0,effEv.registrations.length-tc*4)} on break/round</div>
        <div style={{background:"var(--po-inp)",borderRadius:8,padding:"10px 12px",marginBottom:12}}><div style={{fontSize:11,color:"var(--po-dim)",marginBottom:6}}>Scoring:</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{Array.from({length:tc},(_,i)=><Bdg key={i} label={`Court ${i+1} = ${courtPts(i+1,tc)} pts`} color="#38BDF8"/>)}<Bdg label={`Break = ${bp} pts`} color="#F59E0B"/></div></div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><span style={{fontSize:12,color:"var(--po-dim)"}}>Round duration:</span>{[15,20,25,30].map(n=><SmBtn key={n} label={`${n}m`} onClick={()=>setRDur(n)} active={roundDur===n} color="#6366F1"/>)}</div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}><span style={{fontSize:12,color:"var(--po-dim)"}}>Total rounds:</span>{[4,5,6,7,8].map(n=><SmBtn key={n} label={`${n}`} onClick={()=>setTotalR(n)} active={totalR===n} color="#6366F1"/>)}</div>
        {effEv.registrations.length<tc*4?<div style={{padding:"10px",background:"#EF444411",border:"0.5px solid #EF444444",borderRadius:8,fontSize:12,color:"#EF4444"}}>⚠️ Need at least {tc*4} players.</div>:<Btn label="🎯 Generate Round 1" primary onClick={()=>act.startCI(totalR,roundDur)} style={{width:"100%"}}/>}
      </Card>}
      {plan&&<>
        {/* Next round button ON TOP */}
        {canNext&&!isCompleted&&<Btn label={`▶ Generate Round ${plan.rounds.length+1} of ${plan.totalRounds}`} primary onClick={act.nextRound} style={{width:"100%",marginBottom:12}}/>}
        {plan.rounds.length>=plan.totalRounds&&plan.rounds.every(r=>r.matches.every(m=>m.winner!=null))&&<div style={{textAlign:"center",padding:"14px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:10,fontSize:14,fontWeight:600,color:"#34D399",marginBottom:12}}>🏆 Complete — check Standings!</div>}

        {/* Swap hint */}
        <div style={{fontSize:12,padding:"9px 12px",borderRadius:8,marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,background:sel?"#FBBF2411":"var(--po-bdr)",border:`0.5px solid ${sel?"#FBBF2444":"#334155"}`}}>
          <span style={{color:sel?"#FBBF24":"var(--po-dim)"}}>{isCompleted?"🔒 Event completed — results locked":sel?`✋ ${users.find(u=>u.id===sel.uid)?.nickname} — tap another in Round ${sel.ri+1} to swap · badges show partner history with them`:"💡 Tap player to select · tap another in same round to swap"}</span>
          {sel&&!isCompleted&&<SmBtn label="✕" onClick={()=>setSel(null)} color="#EF4444"/>}
        </div>

        {/* Rounds — newest first */}
        {[...plan.rounds].reverse().map((round,revIdx)=>{
          const ri=plan.rounds.length-1-revIdx;
          const isLatest=revIdx===0;
          return <div key={ri} style={{marginBottom:24,opacity:isLatest?1:0.75}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:15,fontWeight:700,color:isLatest?"var(--po-text)":"var(--po-dim)"}}>Round {round.round}</span>
                <Bdg label={`${plan.roundDuration||roundDur} min`} color="var(--po-dim)"/>
              </div>
              {round.matches.every(m=>m.winner!=null)&&<Bdg label="✓ Complete" color="#34D399"/>}
            </div>
            {isLatest&&!isCompleted&&<MatchTimerWidget plan={plan} roundDuration={plan.roundDuration||roundDur} totalRounds={plan.totalRounds} totalBookingMin={durationHrs*60} eventDate={effEv.date} eventTime={effEv.time} sim={sim} onStart={act.setMatchModeStart}/>}
            {round.onBreak.length>0&&<div style={{background:"var(--po-inp)",border:"0.5px solid #F59E0B33",borderRadius:10,padding:"10px 12px",marginBottom:10}}><div style={{fontSize:11,color:"#F59E0B",fontWeight:600,marginBottom:8}}>🪑 On Break — {bp} pts each</div><div style={{display:"flex",flexWrap:"wrap",gap:4}}>{round.onBreak.map(p=><PChip key={p.userId} p={p} ri={ri}/>)}</div></div>}
            {round.matches.map((m,mi)=><Card key={mi} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><span style={{fontSize:12,fontWeight:700,color:"var(--po-dim)",textTransform:"uppercase",letterSpacing:0.5}}>Court {m.court}</span><Bdg label={`Win = ${courtPts(m.court,tc)} pts`} color="#38BDF8"/></div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 30px 1fr",gap:8,alignItems:"start"}}>
                <div style={{background:m.winner==="A"?"#34D39911":"var(--po-inp)",border:`0.5px solid ${m.winner==="A"?"#34D39944":"var(--po-bdr)"}`,borderRadius:10,padding:"8px"}}>
                  <div style={{fontSize:10,color:"var(--po-dim)",marginBottom:6,fontWeight:600,textAlign:"center"}}>TEAM A <span style={{color:"var(--po-dim)"}}>({Math.round(m.teamA.reduce((s,p)=>s+p.usr,0)/m.teamA.length)})</span></div>
                  {m.teamA.map(p=><PChip key={p.userId} p={p} ri={ri}/>)}
                </div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",paddingTop:24}}><span style={{fontSize:10,color:"#334155",fontWeight:700}}>VS</span></div>
                <div style={{background:m.winner==="B"?"#34D39911":"var(--po-inp)",border:`0.5px solid ${m.winner==="B"?"#34D39944":"var(--po-bdr)"}`,borderRadius:10,padding:"8px"}}>
                  <div style={{fontSize:10,color:"var(--po-dim)",marginBottom:6,fontWeight:600,textAlign:"center"}}>TEAM B <span style={{color:"var(--po-dim)"}}>({Math.round(m.teamB.reduce((s,p)=>s+p.usr,0)/m.teamB.length)})</span></div>
                  {m.teamB.map(p=><PChip key={p.userId} p={p} ri={ri}/>)}
                </div>
              </div>
              <WinCI m={m} ri={ri} mi={mi}/>
            </Card>)}
          </div>;
        })}
      </>}
    </>}

    {/* CI STANDINGS */}
    {tab==="standings"&&isCI&&<>
      <div style={{marginBottom:10,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:12,color:"var(--po-dim)"}}>{Array.from({length:tc},(_,i)=>`Court ${i+1}=${courtPts(i+1,tc)}pts`).join(" · ")} · Break={bp}pts</div>
      {plan&&<div style={{marginBottom:10,padding:"8px 12px",background:"#6366F122",border:"0.5px solid #6366F144",borderRadius:8,fontSize:12,color:"#A5B4FC",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span>🎯 Max possible: <b>{maxPossibleCI(plan)} pts</b> ({plan.rounds.length} rounds, avg. breaks factored in)</span>
      </div>}
      {ciStands.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>Record winners to see standings.</div></Card>:<>
        {ciStands.map((s,i)=>{const mp=maxPossibleCI(plan),pes=mp>0?Math.round((s.pts/mp)*100*10)/10:0;return <Card key={s.user.id}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,background:i<3?"#6366F133":"var(--po-bdr)",color:i===0?"#FBBF24":i===1?"#94A3B8":i===2?"#CD7C2F":"var(--po-dim)"}}>{i+1}</div><Av u={s.user} size={34}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{s.user.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{s.wins} wins · {s.breaks} breaks · {s.played} played</div></div><div style={{textAlign:"right",marginRight:8}}><div style={{fontSize:14,fontWeight:700,color:"#A5B4FC"}}>{pes}%</div><div style={{fontSize:9,color:"var(--po-dim)"}}>PES</div></div><div style={{textAlign:"right"}}><div style={{fontSize:22,fontWeight:700,color:"#6366F1"}}>{s.pts}</div><div style={{fontSize:10,color:"var(--po-dim)"}}>pts</div></div></div></Card>;})}
        {plan&&<SmBtn label={showResultsTable?"▲ Hide Results Table":"▼ Show Results Table"} onClick={()=>setShowResultsTable(o=>!o)} color="#6366F1" style={{width:"100%",marginTop:6,marginBottom:showResultsTable?10:0,textAlign:"center",justifyContent:"center",display:"flex"}}/>}
        {showResultsTable&&plan&&<Card style={{padding:8}}><ResultsTable plan={plan} ciStands={ciStands} tc={tc} maxPts={maxPossibleCI(plan)}/></Card>}
      </>}
    </>}

    {/* CT TEAMS */}
    {tab==="teams"&&isCT&&isAdmin&&<>
      {!plan&&<Card>
        <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Form Teams & Start</div>
        <div style={{fontSize:13,color:"var(--po-sub)",marginBottom:12}}>{effEv.registrations.length} players → {Math.floor(effEv.registrations.length/6)} pools → {Math.floor(effEv.registrations.length/2)} teams</div>
        {ctCC?.warning&&<div style={{padding:"8px 12px",background:"#F59E0B11",border:"0.5px solid #F59E0B44",borderRadius:8,fontSize:12,color:"#F59E0B",marginBottom:12}}>⚠️ {ctCC.warning}</div>}
        <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Courts:</div><div style={{display:"flex",gap:8}}>{[ctCC?.min,ctCC?.max].filter((v,i,a)=>v&&a.indexOf(v)===i).map(n=><button key={n} onClick={()=>setCtC(n)} style={{flex:1,padding:"10px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${selCtC===n?"#6366F1":"var(--po-bdr)"}`,background:selCtC===n?"#6366F122":"var(--po-inp)",color:selCtC===n?"#A5B4FC":"var(--po-sub)",fontSize:13,fontWeight:600}}>{n} {n===ctCC?.min?"(min)":"(max)"}</button>)}</div></div>
        <div style={{marginBottom:16}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Format:</div>
          {[{k:"league",l:"League + Promotion/Relegation",d:"Groups play full round robin · top promoted · bottom relegated",ok:true},
            {k:"ladder",l:"Ladder",d:ladderOK?"Teams climb/descend · break schedule · court points":`❌ Invalid: ${breakTeams} break team(s) > ${selCtC} court(s). Use League instead.`,ok:ladderOK}
          ].map(f=><div key={f.k} onClick={()=>f.ok&&setCtF(f.k)} style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:f.ok?"pointer":"not-allowed",border:`0.5px solid ${ctF===f.k?"#6366F1":f.ok?"var(--po-bdr)":"#EF444433"}`,background:ctF===f.k?"#6366F122":f.ok?"transparent":"#EF444408",opacity:f.ok?1:0.7}}>
            <div style={{fontWeight:600,fontSize:13,color:ctF===f.k?"#A5B4FC":f.ok?"var(--po-text)":"#EF4444",marginBottom:2}}>{f.l}</div>
            <div style={{fontSize:11,color:f.ok?"var(--po-dim)":"#EF4444"}}>{f.d}</div>
          </div>)}
        </div>
        <div style={{marginBottom:16}}>
          <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Match duration:</div>
          <div style={{display:"flex",gap:8}}>{[15,20,25,30].map(n=><SmBtn key={n} label={`${n}m`} onClick={()=>setCtDur(n)} active={ctDur===n} color="#6366F1"/>)}</div>
        </div>
        <Btn label="🎯 Form Teams & Start" primary onClick={()=>act.startCT(selCtC,ctF,ctDur)} style={{width:"100%"}}/>
      </Card>}
      {plan&&<>
        <div style={{padding:"8px 12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:8,fontSize:12,color:"#34D399",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span>✓ {plan.teams?.length||0} teams · {plan.format==="ladder"?"Ladder":"League"} · {plan.courts} courts</span>
          {plan.rounds.length===0||!plan.rounds[0]?.matchesA?.some(m=>m.winner)
            ? (!ctR1Locked?<SmBtn label="🔄 Regenerate" onClick={()=>{if(window.confirm("Discard current team formation and start over?\n\nAll teams and the current Round 1 will be cleared. Registered players stay.\n\nThis cannot be undone."))act.startCT(plan.courts,plan.format,plan.matchDuration);}} color="#F59E0B"/>:<span style={{fontSize:10,color:"var(--po-dim)"}}>🔒 R1 locked</span>)
            : null}
        </div>
        {plan.format==="ladder"?<>
          {/* Ladder: show Pools (how teams were formed) but make clear they don't affect gameplay */}
          {(() => {
            const poolNums = [...new Set((plan.teams||[]).map(t=>t.poolIdx))].sort();
            return poolNums.map(pi => {
              const poolTeams = (plan.teams||[]).filter(t=>t.poolIdx===pi);
              return <React.Fragment key={pi}>
                <ST>Pool {pi+1} — {poolTeams.length} teams</ST>
                {poolTeams.map(t=><CTTeamCard key={t.id} team={t} group={`P${pi+1}`}/>)}
              </React.Fragment>;
            });
          })()}
        </>:<>
          <ST>Group A — {plan.groupA?.length||0} teams</ST>
          {(plan.groupA||[]).map(t=><CTTeamCard key={t.id} team={t} group="A"/>)}
          {plan.groupB?.length>0&&<><ST>Group B — {plan.groupB.length} teams</ST>{plan.groupB.map(t=><CTTeamCard key={t.id} team={t} group="B"/>)}</>}
        </>}
      </>}
    </>}

    {/* CT BREAKS (Ladder only) */}
    {tab==="breaks"&&isCT&&isAdmin&&plan&&plan.format==="ladder"&&<CTBreaksTab plan={plan} tc={tc} onRegenBreaks={act.regenCTBreaks} onSwapBreak={act.swapCTBreak}/>}

    {/* CT MATCHES */}
    {tab==="matches"&&isCT&&isAdmin&&plan&&<CTMatchesTab plan={plan} onSetWinCT={act.setWinCT} onApplyPromo={act.applyPromo} onNextCTLadder={act.nextCTLadder} onSwapCTLadder={act.swapCTLadder} totalBookingMin={durationHrs*60} eventDate={effEv.date} eventTime={effEv.time} sim={sim} onSetMatchModeStart={act.setMatchModeStart}/>}

    {/* CT STANDINGS */}
    {tab==="standings"&&isCT&&<>
      {/* Scoring info bar */}
      <div style={{marginBottom:10,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:12,color:"var(--po-dim)"}}>
        {plan?.format==="ladder"
          ? `Court pts: ${Array.from({length:tc},(_,i)=>`C${i+1}=${ctLadderCourtPts(i+1,tc)}`).join(" · ")} · Break=${ctLadderBreakPts(tc)}`
          : "Cumulative all rounds · Wins → Score Diff · Group A first"}
      </div>

      {ctStands.length===0
        ? <Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>Record results to see standings.</div></Card>
        : <>
          {/* Unified max score for Ladder — same value used for every team's PES%, average breaks factored in */}
          {plan?.format==="ladder"&&plan?.rounds?.length>0&&(()=>{
            const maxPts = ctEventMaxPts(plan);
            return <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:8,textAlign:"right"}}>Max possible: <b style={{color:"var(--po-text)"}}>{maxPts} pts</b> (avg. breaks factored in)</div>;
          })()}

          {/* Standings list */}
          {ctStands.map((s,i)=>{
            const gc = plan?.format==="ladder"?"#6366F1":(s.group==="A"?"#6366F1":"#06B6D4");
            const maxRoundsPlayed = plan?.rounds?.length||0;
            const maxPts = plan?.format==="ladder" ? ctEventMaxPts(plan) : 0;
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
                      : `${s.wins}W · ${s.losses}L · ${s.breaks||0} breaks`}
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
  </>;
}

// ══════════════════════════════════════════════════════
//  EVENTS LIST
// ══════════════════════════════════════════════════════
function EvList({events,me,users,comms,onOpen,onCreateEv}){
  const [sub,setSub]=useState("coming");
  const myIds=new Set(events.filter(ev=>ev.registrations?.some(r=>r.userId===me.id)).map(ev=>ev.id));
  // Coming = registration still open/active (regardless of date) — covers same-day and duplicated past-dated events
  const coming=events.filter(ev=>ev.status!=="completed"&&ev.status!=="cancelled"&&myIds.has(ev.id));
  const past=events.filter(ev=>(ev.status==="completed"||ev.status==="cancelled")&&!ev.archived&&myIds.has(ev.id));
  const others=events.filter(ev=>ev.status!=="completed"&&ev.status!=="cancelled"&&!myIds.has(ev.id));
  const isAdm=comms.some(c=>c.members.some(m=>m.userId===me.id&&(m.role==="owner"||m.role==="admin")));
  function Row({ev}){return <div><div style={{fontSize:11,color:"var(--po-dim)",marginBottom:3}}>{ev.commName}</div><EvCard ev={ev} me={me} users={users} onClick={()=>onOpen(ev.communityId,ev.id)}/></div>;}
  return <><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)"}}>Events</div>{isAdm&&<Btn label="+ New" primary onClick={onCreateEv}/>}</div>
    <Tabs tabs={[[`coming`,`Coming (${coming.length})`],[`past`,`Past & Closed (${past.length})`]]} active={sub} onChange={setSub}/>
    {sub==="coming"&&<>{coming.length===0?<Card><div style={{textAlign:"center",padding:"24px 0",color:"var(--po-dim)",fontSize:13}}><div style={{fontSize:28,marginBottom:8}}>📅</div>No upcoming events.</div></Card>:coming.map(ev=><Row key={ev.id} ev={ev}/>)}{others.length>0&&<><ST>Other Upcoming</ST>{others.map(ev=><Row key={ev.id} ev={ev}/>)}</>}</>}
    {sub==="past"&&(past.length===0?<Card><div style={{textAlign:"center",padding:"24px 0",color:"var(--po-dim)",fontSize:13}}>No past events yet.</div></Card>:past.map(ev=><Row key={ev.id} ev={ev}/>))}
  </>;
}

// ══════════════════════════════════════════════════════
//  PROFILE & SETTINGS
// ══════════════════════════════════════════════════════
function ComboCard({combo, lv, eventsDesc}){
  const [expanded, setExpanded] = useState(false);
  const tr = combo.currentTr;
  const eventCount = combo.events.length;
  return <Card style={{marginBottom:8,padding:0,overflow:"hidden"}}>
    {/* Header row — always visible */}
    <div onClick={()=>setExpanded(e=>!e)} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",cursor:"pointer"}}>
      {/* TR badge */}
      <div style={{width:40,height:40,borderRadius:10,background:`${lv.c}22`,border:`1.5px solid ${lv.c}44`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        <div style={{fontSize:14,fontWeight:700,color:lv.c,lineHeight:1}}>{tr??"-"}</div>
        <div style={{fontSize:8,color:lv.c,fontWeight:600}}>TR</div>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:700,fontSize:14,color:"var(--po-text)"}}>with {combo.partnerName}</div>
        <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>{eventCount} event{eventCount!==1?"s":""} together</div>
      </div>
      <div style={{fontSize:18,color:"var(--po-dim)",transition:"transform 0.2s",transform:expanded?"rotate(180deg)":"none"}}>⌄</div>
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
            <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:1}}>#{h.eventId} · {h.format==="ladder"?"Ladder":"League"}</div>
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

function ProfileSc({user,comms,onBack,viewedByAdmin}){
  const [tab,setTab]=useState("usr");
  const lv=usrLv(user.usr),mine=comms.filter(c=>c.members.some(m=>m.userId===user.id));
  const ec=mine.reduce((s,c)=>s+c.events.filter(e=>e.registrations.some(r=>r.userId===user.id)).length,0);
  const usrHist=[...(user.usrHistory||[])].reverse();

  // Build team history from all CT completed events the user participated in

  return <><BBtn onBack={onBack} label="Back"/>
  {viewedByAdmin&&<div style={{marginBottom:12,padding:"8px 12px",background:"#6366F122",border:"0.5px solid #6366F144",borderRadius:8,fontSize:12,color:"#A5B4FC"}}>🛡 Viewing as Platform Admin — visible only to you</div>}
  <Card><div style={{display:"flex",gap:14,alignItems:"center",marginBottom:16}}>
    <Av u={user} size={56}/>
    <div>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <div style={{fontWeight:700,fontSize:18,color:"var(--po-text)"}}>{user.nickname}</div>
        <div style={{fontSize:10,color:"var(--po-dim)",background:"var(--po-bdr)",borderRadius:4,padding:"2px 6px",fontFamily:"monospace"}}>#{user.id}</div>
      </div>
      <div style={{fontSize:13,color:"var(--po-dim)"}}>{user.name}</div>
      <div style={{fontSize:12,color:"var(--po-dim)"}}>📍 {user.area} · {user.gov}</div>
    </div>
  </div>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8}}>
    {[["USR",user.usr],["Level",<span style={{color:lv.c,fontWeight:700}}>{lv.l}</span>],["Communities",mine.length],["Events",ec]].map(([l,v])=>
      <div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 4px",textAlign:"center"}}>
        <div style={{fontSize:15,fontWeight:700,color:"var(--po-text)"}}>{v}</div>
        <div style={{fontSize:10,color:"var(--po-dim)",marginTop:1}}>{l}</div>
      </div>
    )}
  </div></Card>

  <div style={{display:"flex",gap:6,margin:"16px 0 8px"}}>
    {[["usr","📈 USR History"],["teams","👥 Teams"]].map(([k,l])=>
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
        const prevUsr = calcWeightedUSR(histUpToNow, seedUsr);
        const newUsr = calcWeightedUSR([...histUpToNow,h], seedUsr);
        const delta = newUsr - prevUsr;
        const deltaColor = delta>0?"#34D399":delta<0?"#EF4444":"var(--po-dim)";
        const deltaArrow = delta>0?"↑":delta<0?"↓":"—";
        const isCTEvent = h.type==="ct";
        return <div key={i} style={{display:"grid",gridTemplateColumns:"68px 1fr 44px 64px",gap:2,padding:"10px 12px",borderBottom:i<usrHist.length-1?"0.5px solid var(--po-bdr)":"none",alignItems:"center"}}>
          <div style={{fontSize:10,color:"var(--po-dim)"}}>{fmtD(h.date)}</div>
          <div>
            <div style={{fontSize:10,color:"var(--po-dim)",display:"flex",alignItems:"center",gap:4}}>
              #{h.eventId}
              {isCTEvent&&<span style={{fontSize:9,background:"#06B6D422",color:"#06B6D4",borderRadius:3,padding:"0 4px",fontWeight:700}}>CT ×0.5</span>}
            </div>
            <div style={{fontSize:12,fontWeight:600,color:"var(--po-text)"}}>{h.eventName}</div>
          </div>
          <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:isCTEvent?"#06B6D4":"#6366F1"}}>{h.pes}%</div>
          <div style={{textAlign:"right"}}>
            <span style={{fontSize:12,color:"var(--po-dim)"}}>{prevUsr} </span>
            <span style={{fontSize:13,fontWeight:700,color:deltaColor}}>{deltaArrow}{Math.abs(delta)>0?Math.abs(delta):""}</span>
          </div>
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
        return <ComboCard key={combo.comboKey} combo={combo} lv={lv} eventsDesc={eventsDesc}/>;
      });
    })()}
    <div style={{marginTop:8,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:11,color:"var(--po-dim)"}}>
      TR = rolling average of last 5 TES scores for each partner combination · Seed = avg USR of both players
    </div>
  </>}

  <ST>{viewedByAdmin?`${user.nickname}'s Communities`:"My Communities"}</ST>
  {mine.map(c=>{const m=c.members.find(m=>m.userId===user.id);return <Card key={c.id}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{fontSize:20}}>🏸</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{c.name}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{c.area}</div></div>{rBdg(m.role)}{sBdg(m.status)}</div></Card>;})}
  </>;
}
const SeedBadge = ()=><span title="Seeded data">🌱</span>;
const SEEDED_USER_IDS = new Set([1,2,3,4,5,6,7,8,9,10,11,12]);
const SEEDED_COMM_IDS = new Set([1]);
const SEEDED_VENUE_IDS = new Set([1]);
const SEEDED_EVENT_IDS = new Set([1,2,3]);

function PlatformAdminSc({users,comms,venues,onBack,onAddUser,onEditUser,onDeleteUser,onViewProfile,claimRequests=[],onApproveClaim,onRejectClaim}){
  const [tab,setTab]=useState("users");
  const [editing,setEditing]=useState(null);
  const [nf,setNf]=useState({nickname:"",name:"",gov:"القاهرة",area:"المعادي",usr:"50"});
  const [showAdd,setShowAdd]=useState(false);
  const set=(k,v)=>setNf(p=>({...p,[k]:v}));
  const allEvents=comms.flatMap(c=>c.events.map(ev=>({...ev,commName:c.name,communityId:c.id})));
  const pendingClaims = claimRequests.filter(r=>r.status==="pending");

  return <><BBtn onBack={onBack} label="Back"/>
  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
    <div style={{fontSize:20}}>🛡</div>
    <div>
      <div style={{fontSize:18,fontWeight:700,color:"var(--po-text)"}}>Platform Administration</div>
      <div style={{fontSize:11,color:"var(--po-dim)"}}>Full access · handle with care</div>
    </div>
  </div>

  <Tabs tabs={[["users",`Users (${users.length})`],["claims",`Claims${pendingClaims.length>0?` (${pendingClaims.length})`:""}`],["archived","Archived Events"]]} active={tab} onChange={setTab}/>

  {tab==="claims"&&<>
    <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:12}}>When someone signs in and picks an existing player as themself, it lands here — confirm it's really them before their account gets linked.</div>
    {pendingClaims.length===0&&<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No pending claims.</div></Card>}
    {pendingClaims.map(r=>{
      const target = users.find(u=>u.id===r.userId);
      if (!target) return null;
      return <Card key={r.id} style={{marginBottom:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <Av u={target} size={36}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)"}}>Claiming: {target.nickname}</div>
            <div style={{fontSize:11,color:"var(--po-dim)"}}>{r.email||r.displayName||"—"} · {timeAgo(r.requestedAt)}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Btn label="✓ Approve" primary onClick={()=>onApproveClaim(r.id)} style={{flex:1}}/>
          <Btn label="✗ Reject" onClick={()=>onRejectClaim(r.id)} style={{flex:1}}/>
        </div>
      </Card>;
    })}
  </>}

  {tab==="users"&&<>
    <Btn label="+ Add User" primary onClick={()=>{setShowAdd(true);setEditing(null);setNf({nickname:"",name:"",gov:"القاهرة",area:"المعادي",usr:"50"});}} style={{width:"100%",marginBottom:12}}/>
    {showAdd&&<Card style={{marginBottom:12}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:10}}>{editing?"Edit User":"New User"}</div>
      {[["Nickname","nickname"],["Full Name","name"],["Governorate","gov"],["Area","area"]].map(([l,k])=>
        <Inp key={k} label={l} value={nf[k]||""} onChange={v=>set(k,v)}/>
      )}
      <Inp label="Initial USR (0–100)" value={nf.usr} onChange={v=>set("usr",v)}/>
      <div style={{display:"flex",gap:8,marginTop:8}}>
        <Btn label="Save" primary onClick={()=>{
          if(!nf.nickname.trim())return;
          if(editing) onEditUser(editing,{...nf,usr:parseInt(nf.usr)||50});
          else onAddUser({...nf,usr:parseInt(nf.usr)||50});
          setShowAdd(false);setEditing(null);
        }} style={{flex:1}}/>
        <Btn label="Cancel" onClick={()=>{setShowAdd(false);setEditing(null);}} style={{flex:1}}/>
      </div>
    </Card>}
    {users.map(u=><Card key={u.id} style={{marginBottom:8}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <Av u={u} size={36}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
            <span style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{u.nickname}</span>
            <span style={{fontSize:10,color:"var(--po-dim)",fontFamily:"monospace",background:"var(--po-bdr)",borderRadius:3,padding:"0 4px"}}>#{u.id}</span>
            {SEEDED_USER_IDS.has(u.id)&&<SeedBadge/>}
            {u.isGuest&&<Bdg label="Guest" color="#F59E0B"/>}
          </div>
          <div style={{fontSize:11,color:"var(--po-dim)"}}>{u.name||"—"} · USR {u.usr} · seed {u.seedUsr??u.usr}</div>
          <div style={{fontSize:10,color:"var(--po-dim)"}}>{u.area} · {u.gov}</div>
        </div>
        <div style={{display:"flex",gap:4}}>
          <SmBtn label="👁" onClick={()=>onViewProfile(u.id)} color="#6366F1"/>
          <SmBtn label="✏️" onClick={()=>{setEditing(u.id);setNf({nickname:u.nickname,name:u.name||"",gov:u.gov||"القاهرة",area:u.area||"",usr:String(u.usr||50)});setShowAdd(true);}} color="#F59E0B"/>
          {!SEEDED_USER_IDS.has(u.id)&&<SmBtn label="🗑" onClick={()=>{if(window.confirm(`Delete ${u.nickname}?\nThis cannot be undone.`))onDeleteUser(u.id);}} color="#EF4444"/>}
        </div>
      </div>
    </Card>)}
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
  </>;
}

function SettingsSc({user,users,dark,onToggleDark,onAddUser,onEditUser,onDeleteUser,onExport,onRepairIds,onFactoryReset,onSendTestNotif,onBack}){
  const [showAddUser,setShowAddUser] = useState(false);
  const [editingId,setEditingId] = useState(null);
  const [nf,setNf] = useState({nickname:"",name:"",gov:"القاهرة",area:"المعادي",usr:"50"});
  const [ef,setEf] = useState({nickname:"",name:"",gov:"القاهرة",area:"المعادي",usr:"50"});
  const [pushStatus,setPushStatus] = useState("idle"); // idle | working | on | off | error
  const set=(k,v)=>setNf(p=>({...p,[k]:v}));
  const sete=(k,v)=>setEf(p=>({...p,[k]:v}));
  const startEdit=(u)=>{setEditingId(u.id);setEf({nickname:u.nickname,name:u.name,gov:u.gov||"القاهرة",area:u.area||"المعادي",usr:String(u.usr)});};
  const enablePush = async () => {
    setPushStatus("working");
    const res = await enablePushNotifications(user.id);
    setPushStatus(res.ok ? "on" : "error");
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
            {pushStatus==="on"?"Enabled on this device ✓":pushStatus==="error"?"Couldn't enable — check browser notification permission":pushStatus==="working"?"Setting up…":"Get notified even when the app is closed"}
          </div>
        </div>
        <Btn label={pushStatus==="on"?"✓ On":"Enable"} primary={pushStatus!=="on"} onClick={enablePush} style={{flexShrink:0}}/>
      </div>
      {pushStatus==="on"&&<div onClick={onSendTestNotif} style={{marginTop:12,paddingTop:12,borderTop:"0.5px solid var(--po-bdr)",textAlign:"center",fontSize:12,fontWeight:600,color:"#6366F1",cursor:"pointer"}}>Send myself a test notification</div>}
    </Card>
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
      {[{i:"🌍",l:"Language",n:"English"},{i:"📍",l:"Home Area",n:user.area}].map((item,i)=><div key={item.l} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:i<1?"0.5px solid var(--po-bdr)":"none",cursor:"pointer"}}><span style={{fontSize:18}}>{item.i}</span><span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>{item.l}</span><span style={{fontSize:12,color:"var(--po-dim)"}}>{item.n}</span><span style={{color:"var(--po-dim)"}}>›</span></div>)}
    </Card>
        <ST>Account</ST>
    <Card style={{padding:0,overflow:"hidden"}}>
      {[{i:"✏️",l:"Edit Profile"},{i:"🔔",l:"Notifications"},{i:"🔒",l:"Privacy"}].map((item,i)=><div key={item.l} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:i<2?"0.5px solid var(--po-bdr)":"none",cursor:"pointer"}}><span style={{fontSize:18}}>{item.i}</span><span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>{item.l}</span><span style={{color:"var(--po-dim)"}}>›</span></div>)}
    </Card>
    <ST>Support</ST>
    <Card style={{padding:0,overflow:"hidden"}}>
      {[{i:"❓",l:"Help & FAQ"},{i:"📩",l:"Contact Support"},{i:"⚖️",l:"Terms & Privacy"}].map((item,i)=><div key={item.l} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderBottom:i<2?"0.5px solid var(--po-bdr)":"none",cursor:"pointer"}}><span style={{fontSize:18}}>{item.i}</span><span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>{item.l}</span><span style={{color:"var(--po-dim)"}}>›</span></div>)}
    </Card>
    <ST>Data</ST>
    <Card style={{padding:0,overflow:"hidden"}}>
      <div onClick={onExport} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer",borderBottom:"0.5px solid var(--po-bdr)"}}>
        <span style={{fontSize:18}}>💾</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Export My Data</span>
        <span style={{fontSize:12,color:"var(--po-dim)"}}>Download backup JSON</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
      <div onClick={()=>{if(window.confirm("Repair duplicate event IDs?\n\nThis scans all events and reassigns new unique IDs to any duplicates found, without deleting any data. Safe to run anytime."))onRepairIds();}} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer",borderBottom:"0.5px solid var(--po-bdr)"}}>
        <span style={{fontSize:18}}>🔧</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Repair Data (Event IDs & Venues)</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
      <div onClick={()=>{if(window.confirm("⚠️ Factory Reset — Delete ALL data?\n\nThis permanently erases every community, event, venue, and player from this device and reloads the app with the original seed data.\n\nExport a backup first if you want to keep anything. This cannot be undone."))onFactoryReset();}} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer"}}>
        <span style={{fontSize:18}}>⚠️</span>
        <span style={{flex:1,fontSize:14,color:"#EF4444"}}>Factory Reset (Erase Everything)</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
    </Card>
    <div style={{textAlign:"center",marginTop:24,fontSize:12,color:"var(--po-bdr)"}}>PadelOS v{APP_VERSION}</div>
  </>;
}

function NotificationsSc({notifications,me,onBack,onMarkAllRead,onOpen}){
  const myNotifs = notifications.filter(n=>n.userId===me.id);
  const unreadCount = myNotifs.filter(n=>!n.read).length;
  const icons = {reg_open:"🎾",registered:"✓",event_updated:"✏️",reminder_h24:"⏰",reminder_h3:"⏰",reminder_h1:"⏰"};
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
