import React, { useState, useEffect } from "react";

// ══════════════════════════════════════════════════════
//  PadelOS v7 – Clean rebuild with Closed Teams + Score Steppers
// ══════════════════════════════════════════════════════

const EGYPT = {
  "القاهرة": ["المعادي","مدينة نصر","الزمالك","مصر الجديدة","التجمع الخامس","القاهرة الجديدة","مدينتي","المقطم","شبرا","عين شمس"],
  "الجيزة":  ["الشيخ زايد","6 أكتوبر","المهندسين","العجوزة","الدقي","إمبابة"],
  "الإسكندرية": ["سموحة","لوران","المنتزه","سيدي جابر","محرم بك"],
  "القليوبية": ["شبرا الخيمة","بنها","قليوب","الخانكة"],
};
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
function diversePair(cp, ph) {
  const opts = [[[0,1],[2,3]],[[0,2],[1,3]],[[0,3],[1,2]]]; let best = opts[0], bestScore = Infinity;
  opts.forEach(([a,b]) => { const s=(ph[cp[a[0]].userId]?.[cp[a[1]].userId]||0)+(ph[cp[b[0]].userId]?.[cp[b[1]].userId]||0); if(s<bestScore){bestScore=s;best=[a,b];} });
  return { teamA:[cp[best[0][0]],cp[best[0][1]]], teamB:[cp[best[1][0]],cp[best[1][1]]] };
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
  lastRound.matches.forEach(m=>{[m.teamA,m.teamB].forEach(team=>{const[a,b]=team;if(!a||!b)return;if(!ph[a.userId])ph[a.userId]={};if(!ph[b.userId])ph[b.userId]={};ph[a.userId][b.userId]=(ph[a.userId][b.userId]||0)+1;ph[b.userId][a.userId]=(ph[b.userId][a.userId]||0)+1;});});
  const newBreakIds=breakPlan[ri]||[], onBreak=sorted.filter(p=>newBreakIds.includes(p.userId)), buckets={};
  for(let c=1;c<=courts;c++) buckets[c]=[];
  lastRound.matches.forEach(m=>{if(!m.winner)return;const W=m.winner==="A"?m.teamA:m.teamB,L=m.winner==="A"?m.teamB:m.teamA;W.forEach(p=>buckets[Math.max(1,m.court-1)].push(p));L.forEach(p=>buckets[Math.min(courts,m.court+1)].push(p));});
  for(let c=1;c<=courts;c++) buckets[c]=buckets[c].filter(p=>!newBreakIds.includes(p.userId));
  const returning=sorted.filter(p=>(lastRound.onBreakIds||[]).includes(p.userId)&&!newBreakIds.includes(p.userId));
  returning.forEach(rp=>{const needy=Object.entries(buckets).filter(([,ps])=>ps.length<4).sort((a,b)=>a[1].length-b[1].length)[0];if(needy)buckets[parseInt(needy[0])].push(rp);});
  const matches=[]; for(let c=1;c<=courts;c++){const cp=buckets[c].slice(0,4);if(cp.length<4)continue;const pair=diversePair(cp,ph);matches.push({court:c,teamA:pair.teamA,teamB:pair.teamB,winner:null});}
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
  plan.rounds.forEach(r=>{(r.onBreak||[]).forEach(p=>{if(!pts[p.userId])pts[p.userId]={pts:0,wins:0,breaks:0,played:0};pts[p.userId].pts+=breakPts(tc);pts[p.userId].breaks++;});r.matches.forEach(m=>{if(!m.winner)return;const wp=courtPts(m.court,tc),W=m.winner==="A"?m.teamA:m.teamB,L=m.winner==="A"?m.teamB:m.teamA;W.forEach(p=>{if(!pts[p.userId])pts[p.userId]={pts:0,wins:0,breaks:0,played:0};pts[p.userId].pts+=wp;pts[p.userId].wins++;pts[p.userId].played++;});L.forEach(p=>{if(!pts[p.userId])pts[p.userId]={pts:0,wins:0,breaks:0,played:0};pts[p.userId].played++;});});});
  return Object.entries(pts).map(([uid,s])=>({...s,user:users.find(u=>u.id===parseInt(uid))})).filter(s=>s.user).sort((a,b)=>b.pts-a.pts||b.wins-a.wins);
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

function generateCTPlan(players, courts, format, ev=null) {
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
    const maxR = ev ? calcMaxRounds(ev, "ladder", groupA, groupB, courts) : 99;
    return { format:"ladder", teams, groupA, groupB, courts, courtsA, courtsB, leagueRound:1, maxRounds:maxR,
      breakPlan: ladderBreakPlan, sorted,
      rounds:[{ roundNum:1, type:"ladder", matchesA:matches, matchesB:[], onBreak, onBreakIds }] };
  }

  // League: full RR per group = 1 League Round
  const allMatchesA = rrSchedule(groupA).map((m,i) => ({...m, court:(i%courtsA)+1}));
  const allMatchesB = rrSchedule(groupB).map((m,i) => ({...m, court:courtsA+(i%courtsB)+1}));
  const maxLeagueR = ev ? calcMaxRounds(ev, "league", groupA, groupB, courts) : 99;
  return { format:"league", teams, groupA, groupB, courts, courtsA, courtsB, leagueRound:1, maxRounds:maxLeagueR,
    rounds:[{ roundNum:1, type:"league", matchesA:allMatchesA, matchesB:allMatchesB, onBreak:[] }] };
}

// CT Ladder Break Plan (same logic as CI but for teams)
function buildCTBreakPlan(teams, courts, totalRounds) {
  const N = teams.length, bpr = Math.max(0, N - courts*2);
  if (bpr <= 0) return Array.from({length:totalRounds}, ()=>[]);
  const totalSlots = bpr * totalRounds, base = Math.floor(totalSlots/N), extras = totalSlots % N;
  const sorted = [...teams].sort((a,b) => (b.histBreaks||0) - (a.histBreaks||0));
  const ent = {}; sorted.forEach((t,i) => { ent[t.id] = base + (i<extras?1:0); });
  const assigned={}, lastB={}; teams.forEach(t => { assigned[t.id]=0; lastB[t.id]=-99; });
  const plan = [];
  for (let r = 0; r < totalRounds; r++) {
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
  {id:1, name:"Galleria Moon Valley", gov:"القاهرة", area:"القاهرة الجديدة", courts:3, pricePerHour:0, notes:""},
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
      startTime:"21:00",
      endTime:"23:00",
      courts:3,
      status:"completed",
      closedAt:"2026-06-29T23:00:00.000Z",
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
    }]
  },
];

let _uid=13,_cid=2,_eid=2,_vid=2;

// ── Helpers ───────────────────────────────────────────
const usrLv  = u => u>=80?{l:"A",c:"#C084FC"}:u>=65?{l:"B",c:"#38BDF8"}:u>=50?{l:"C",c:"#34D399"}:u>=35?{l:"D",c:"#FBBF24"}:{l:"E",c:"#F87171"};
const ini2   = s => s.substring(0,2).toUpperCase();
const fmtD   = d => new Date(d).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
const isFut  = d => d >= today;
const isPst  = d => d <  today;
const avgUsr = players => players.length ? Math.round(players.reduce((s,p)=>s+p.usr,0)/players.length) : 0;

// ── Shared UI ─────────────────────────────────────────
function Av({u,size=36}){const lv=usrLv(u.usr);return <div style={{width:size,height:size,borderRadius:"50%",flexShrink:0,background:`${lv.c}22`,border:`1.5px solid ${lv.c}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.36,fontWeight:600,color:lv.c}}>{u.avatar||ini2(u.nickname)}</div>;}
function Bdg({label,color}){return <span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:20,background:`${color}22`,color,border:`0.5px solid ${color}44`,whiteSpace:"nowrap"}}>{label}</span>;}
function Btn({label,onClick,primary,danger,disabled,style={}}){
  const bg=primary?"#6366F1":danger?"#EF444422":"transparent", bc=primary?"#6366F1":danger?"#EF4444":"var(--po-bdr)", cl=primary?"#fff":danger?"#EF4444":"var(--po-sub)";
  return <button onClick={onClick} disabled={disabled} style={{padding:"9px 16px",borderRadius:8,border:`0.5px solid ${bc}`,background:disabled?"var(--po-bdr)":bg,color:disabled?"var(--po-dim)":cl,fontSize:13,fontWeight:500,cursor:disabled?"default":"pointer",opacity:disabled?0.6:1,...style}}>{label}</button>;
}
function SmBtn({label,onClick,color="#6366F1",active,style={}}){return <button onClick={onClick} style={{padding:"5px 12px",borderRadius:6,fontSize:12,fontWeight:500,cursor:"pointer",whiteSpace:"nowrap",border:`0.5px solid ${active?"#6366F1":color+"44"}`,background:active?"#6366F133":`${color}11`,color:active?"#A5B4FC":color,...style}}>{label}</button>;}
function Card({children,style={}}){return <div className="po-card" style={{background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:12,padding:"14px 16px",marginBottom:10,...style}}>{children}</div>;}
function ST({children}){return <div className="po-dim" style={{fontSize:11,fontWeight:600,color:"var(--po-dim)",textTransform:"uppercase",letterSpacing:1,marginBottom:8,marginTop:16}}>{children}</div>;}
function BBtn({onBack,label="Back"}){return <button onClick={onBack} className="po-dim" style={{display:"flex",alignItems:"center",gap:4,background:"none",border:"none",color:"var(--po-dim)",fontSize:13,cursor:"pointer",marginBottom:16,padding:0}}>← {label}</button>;}
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
export default function PadelOS() {
  const [users,  setUsers]  = useState(INIT_USERS);
  const [venues, setVenues] = useState(INIT_VENUES);
  const [comms,  setComms]  = useState(INIT_COMMS);
  const [me]                = useState(INIT_USERS[0]);
  const [nav,    setNav]    = useState("communities");
  const [view,   setView]   = useState({screen:"list"});
  const [toast,  setToast]  = useState(null);
  const [menu,   setMenu]   = useState(false);
  const [dark,   setDark]   = useState(false);
  // Theme colors
  const TH = dark ? {
    bg:"var(--po-inp)", card:"var(--po-card)", border:"var(--po-bdr)", text:"var(--po-text)",
    sub:"var(--po-sub)", dim:"var(--po-dim)", input:"var(--po-inp)", nav:"var(--po-inp)",
    cardShadow:"none", accent:"#6366F1", accentLight:"#6366F133",
  } : {
    bg:"#EEF2FF", card:"#FFFFFF", border:"#C7D2FE", text:"#1E1B4B",
    sub:"#3730A3", dim:"#374151", input:"#FFFFFF", nav:"#4F46E5",
    cardShadow:"0 2px 8px #6366F118", accent:"#4F46E5", accentLight:"#EEF2FF",
  };

  // ── localStorage persistence ──────────────────────
  useEffect(() => {
    try {
      // Migrate from v09 if v10 doesn't exist yet
      const v09 = localStorage.getItem('padelos_v09');
      if (v09 && !localStorage.getItem('padelos_v10')) {
        localStorage.setItem('padelos_v10', v09);
        localStorage.removeItem('padelos_v09');
      }
      const saved = localStorage.getItem('padelos_v10');
      if (saved) {
        const d = JSON.parse(saved);
        if (d.comms)  setComms(d.comms);
        if (d.users)  setUsers(d.users);
        if (d.venues) setVenues(d.venues);
        if (d.dark !== undefined) setDark(d.dark);
      }
    } catch(e) { console.log('Load error', e); }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('padelos_v10', JSON.stringify({comms, users, venues, dark}));
    } catch(e) { console.log('Save error', e); }
  }, [comms, users, venues, dark]);

  const exportData = () => {
    try {
      const data = JSON.stringify({users, venues, comms, exportedAt: new Date().toISOString(), version:"v10"}, null, 2);
      const blob = new Blob([data], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "padelos_backup.json"; a.click();
      URL.revokeObjectURL(url);
      toast2("Data exported ✓");
    } catch(e) { toast2("Export failed","err"); }
  };
  // ────────────────────────────────────────────────────

  const toast2 = (msg,t="ok") => { setToast({msg,t}); setTimeout(()=>setToast(null),2600); };
  const go = (screen,extra={}) => setView({screen,...extra});
  const updC = (id,fn) => setComms(cs=>cs.map(c=>c.id===id?fn(c):c));
  const getEv = (cid,eid) => comms.find(c=>c.id===cid)?.events.find(e=>e.id===eid);

  // Community
  const createComm=(d)=>{const id=_cid++;setComms(cs=>[...cs,{id,...d,founded:today,members:[{userId:me.id,role:"owner",status:"regular",since:today}],joinRequests:[],events:[]}]);toast2(`${d.name} created!`);go("comm",{cid:id});};
  const saveComm=(id,d)=>{updC(id,c=>({...c,...d}));toast2("Saved ✓");go("comm",{cid:id});};
  const approveReq=(cid,uid)=>{updC(cid,c=>({...c,joinRequests:c.joinRequests.filter(r=>r.userId!==uid),members:[...c.members,{userId:uid,role:"member",status:"casual",since:today}]}));toast2("Approved ✓");};
  const rejectReq=(cid,uid)=>{updC(cid,c=>({...c,joinRequests:c.joinRequests.filter(r=>r.userId!==uid)}));toast2("Rejected");};
  const promoteM=(cid,uid)=>{updC(cid,c=>({...c,members:c.members.map(m=>m.userId===uid?{...m,role:"admin"}:m)}));toast2("Promoted ✓");};
  const kickM=(cid,uid)=>{updC(cid,c=>({...c,members:c.members.filter(m=>m.userId!==uid)}));toast2("Removed");};
  const inviteUser=(cid,uid)=>{const u=users.find(u=>u.id===uid);updC(cid,c=>({...c,members:[...c.members,{userId:uid,role:"member",status:"casual",since:today}]}));toast2(`${u?.nickname} added ✓`);};

  // Venue
  const saveVenue=(d,editId=null)=>{const courts=d.courtNames.filter(Boolean).map(n=>({name:n}));if(editId){setVenues(vs=>vs.map(v=>v.id===editId?{...v,...d,courts,status:"pending_edit"}:v));toast2("Saved · Pending review");}else{const id=_vid++;setVenues(vs=>[...vs,{id,...d,courts,status:"pending"}]);toast2("Added · Pending review");}go("list");};

  // Event
  const createEvent=(cid,d)=>{
    const id=_eid++;const v=venues.find(x=>x.id===parseInt(d.venueId));
    const ev={id,communityId:cid,name:d.name,createdBy:me.id,date:d.date,time:d.time,timeTo:d.timeTo||"",venueId:parseInt(d.venueId),courts:parseInt(d.courts)||2,type:d.pollMode?null:d.eventType,status:"registration_open",regOpenAt:new Date().toISOString(),regularUntil:new Date(Date.now()+24*3600000).toISOString(),poll:d.pollMode?{votes:{},resolved:false}:null,registrations:[],checkedIn:[],rotationMin:parseInt(d.rotationMin)||15,costPerCourt:v?.pricePerHour||0,extraFee:v?.extraFee||0,plan:null,reservedCourts:v?.courts.length||2};
    updC(cid,c=>({...c,events:[...c.events,ev]}));toast2("Event created ✓");go("event",{cid,eid:id});
  };
  const editEvent=(cid,eid,d)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,...d})}));toast2("Event updated ✓");go("event",{cid,eid});};
  const closeEvent=(cid,eid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,status:"completed",closedAt:new Date().toISOString()})}));toast2("Event closed ✓");};
  const registerEv=(cid,eid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.registrations.find(r=>r.userId===me.id)?ev:{...ev,registrations:[...ev.registrations,{userId:me.id,registeredAt:new Date().toISOString(),status:"registered",addedBy:null,isGuest:false}]})}));toast2("Registered ✓");};
  const addMember=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.registrations.find(r=>r.userId===uid)?ev:{...ev,registrations:[...ev.registrations,{userId:uid,registeredAt:new Date().toISOString(),status:"registered",addedBy:"admin",isGuest:false}]})}));toast2(`${users.find(u=>u.id===uid)?.nickname} added ✓`);};
  const addGuest=(cid,eid,g)=>{
    const id=_uid++;
    const newUser={id,nickname:g.n,name:g.name||g.n,phone:g.p,gov:"—",area:"—",usr:parseInt(g.usr)||0,joined:today,avatar:ini2(g.n),isGuest:true};
    setUsers(us=>[...us,newUser]);
    updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:[...ev.registrations,{userId:id,registeredAt:new Date().toISOString(),status:"registered",addedBy:"admin",isGuest:true}]})}));
    toast2(`${g.n} added ✓`);
  };
  const checkIn=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid||ev.checkedIn.includes(uid)?ev:{...ev,checkedIn:[...ev.checkedIn,uid]})}));toast2("Checked in ✓");};
  const votePoll=(cid,eid,key)=>{updC(cid,c=>({...c,events:c.events.map(ev=>{if(ev.id!==eid||!ev.poll)return ev;const v={...ev.poll.votes};const my=v[me.id]||[];v[me.id]=my.includes(key)?my.filter(k=>k!==key):[...my,key];return{...ev,poll:{...ev.poll,votes:v}};})}));};
  const resolveT=(cid,eid,key)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,type:key,poll:ev.poll?{...ev.poll,resolved:true,result:key}:null})}));toast2("Type set ✓");};
  const setPlan=(cid,eid,plan)=>updC(cid,c=>({...c,events:c.events.map(ev=>ev.id===eid?{...ev,plan}:ev)}));
  const removeFromEvent=(cid,eid,uid)=>{updC(cid,c=>({...c,events:c.events.map(ev=>ev.id!==eid?ev:{...ev,registrations:ev.registrations.filter(r=>r.userId!==uid),checkedIn:ev.checkedIn.filter(id=>id!==uid)})}));toast2("Removed from event");};
  const editGuestUsr=(uid,usr)=>{setUsers(us=>us.map(u=>u.id===uid?{...u,usr:parseInt(usr)||0}:u));toast2("USR updated ✓");};

  // CI
  const startCI=(cid,eid,n,dur)=>{
    const ev=getEv(cid,eid);if(!ev)return;
    const players=ev.registrations.map(r=>({...users.find(u=>u.id===r.userId),userId:r.userId,histBreaks:0})).filter(p=>p.userId);
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
  const startCT=(cid,eid,courts,fmt)=>{const ev=getEv(cid,eid);if(!ev)return;const players=ev.registrations.map(r=>({...users.find(u=>u.id===r.userId),userId:r.userId})).filter(p=>p.userId);setPlan(cid,eid,generateCTPlan(players,courts,fmt,ev));toast2("Teams formed ✓");};
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
  const allEvents=comms.flatMap(c=>c.events.map(ev=>({...ev,commName:c.name})));

  return (
    <div onClick={()=>menu&&setMenu(false)}
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
      <TopBar me={me} nav={nav} menu={menu} setMenu={setMenu} TH={TH} dark={dark} onNav={n=>{setNav(n);go("list");}} onProfile={()=>{setNav("profile");go("list");setMenu(false);}} onVenues={()=>{setNav("venues");go("list");setMenu(false);}} onSettings={()=>{setNav("settings");go("list");setMenu(false);}}/>
      <div style={{flex:1,maxWidth:680,width:"100%",margin:"0 auto",padding:"16px 12px 80px"}}>
        {nav==="communities"&&view.screen==="list"&&<CommList comms={comms} me={me} dark={dark} TH={TH} onOpen={id=>go("comm",{cid:id})} onCreate={()=>go("createComm")}/>}
        {nav==="communities"&&view.screen==="createComm"&&<CommForm onBack={()=>go("list")} onSave={createComm}/>}
        {nav==="communities"&&view.screen==="editComm"&&comm&&<CommForm comm={comm} onBack={()=>go("comm",{cid:comm.id})} onSave={d=>saveComm(comm.id,d)}/>}
        {nav==="communities"&&view.screen==="comm"&&comm&&<CommDetail comm={comm} users={users} me={me} onBack={()=>go("list")} onEdit={()=>go("editComm",{cid:comm.id})} onApprove={uid=>approveReq(comm.id,uid)} onReject={uid=>rejectReq(comm.id,uid)} onPromote={uid=>promoteM(comm.id,uid)} onKick={uid=>kickM(comm.id,uid)} onInvite={uid=>inviteUser(comm.id,uid)} onOpenEv={eid=>go("event",{cid:comm.id,eid})} onCreateEv={()=>go("createEvent",{cid:comm.id})}/>}
        {nav==="communities"&&view.screen==="createEvent"&&comm&&<EventForm venues={venues} onBack={()=>go("comm",{cid:comm.id})} onCreate={d=>createEvent(comm.id,d)}/>}
        {nav==="communities"&&view.screen==="editEvent"&&comm&&event&&<EventEditForm ev={event} venues={venues} onBack={()=>go("event",{cid:comm.id,eid:event.id})} onSave={d=>editEvent(comm.id,event.id,d)}/>}
        {nav==="communities"&&view.screen==="event"&&comm&&event&&
          <EvDetail ev={event} comm={comm} users={users} venues={venues} me={me}
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
            onStartCT={(c,f)=>startCT(comm.id,event.id,c,f)}
            onSetWinCT={(ri,mi,side,w,sA,sB)=>setWinCT(comm.id,event.id,ri,mi,side,w,sA,sB)}
            onApplyPromo={()=>applyPromo(comm.id,event.id)}
            onNextCTLadder={()=>nextCTLadder(comm.id,event.id)}
            onSwapCTLadder={(ri,a,b)=>swapCTLadder(comm.id,event.id,ri,a,b)}
          />
        }
        {nav==="events"&&view.screen==="list"&&<EvList events={allEvents} me={me} comms={comms} onOpen={(cid,eid)=>{setNav("communities");go("event",{cid,eid});}} onCreateEv={()=>{const ac=comms.find(c=>c.members.some(m=>m.userId===me.id&&(m.role==="owner"||m.role==="admin")));if(ac){setNav("communities");go("createEvent",{cid:ac.id});}}}/>}
        {nav==="venues"&&view.screen==="list"&&<VenueList venues={venues} onAdd={()=>go("addVenue")} onEdit={id=>go("editVenue",{vid:id})} onBack={()=>{setNav("communities");go("list");}}/>}
        {nav==="venues"&&view.screen==="addVenue"&&<VenueForm onBack={()=>go("list")} onSave={saveVenue}/>}
        {nav==="venues"&&view.screen==="editVenue"&&<VenueForm editV={venues.find(v=>v.id===view.vid)} onBack={()=>go("list")} onSave={saveVenue}/>}
        {nav==="profile"&&<ProfileSc user={me} comms={comms} onBack={()=>{setNav("communities");go("list");}}/>}
        {nav==="settings"&&<SettingsSc user={me} users={users} dark={dark} onToggleDark={()=>setDark(d=>!d)} onAddUser={u=>{const id=_uid++;setUsers(us=>[...us,{id,...u,joined:today,avatar:ini2(u.nickname),isGuest:false}]);toast2(`${u.nickname} added ✓`);}} onExport={exportData} onBack={()=>{setNav("communities");go("list");}}/>}
      </div>
      {toast&&<div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:toast.t==="err"?"#EF4444":"#10B981",color:"#fff",padding:"10px 20px",borderRadius:8,fontSize:13,fontWeight:500,zIndex:999,whiteSpace:"nowrap",boxShadow:"0 4px 20px #00000055"}}>{toast.msg}</div>}
    </div>
  );
}

function TopBar({me,nav,menu,setMenu,onNav,onProfile,onVenues,onSettings,TH,dark}){
  return <div style={{background:TH?.nav||"#0E1117",borderBottom:`0.5px solid ${TH?.border||"var(--po-bdr)"}`,padding:"0 16px",display:"flex",alignItems:"center",justifyContent:"space-between",height:52,position:"sticky",top:0,zIndex:50,transition:"all 0.2s"}}>
    <div style={{display:"flex",alignItems:"center",gap:8}}>
      <div style={{width:28,height:28,background:"linear-gradient(135deg,#6366F1,#06B6D4)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#fff"}}>PO</div>
      <span style={{fontSize:15,fontWeight:600,color:dark?"#F1F5F9":"#FFFFFF"}}>PadelOS <span style={{fontSize:11,fontWeight:400,opacity:0.7}}>v0.9</span></span>
    </div>
    <div style={{display:"flex",gap:2}}>{[["communities","Communities"],["events","Events"]].map(([k,l])=><button key={k} onClick={()=>onNav(k)} style={{padding:"5px 14px",borderRadius:6,border:"none",fontSize:12,fontWeight:500,cursor:"pointer",background:nav===k?(dark?"var(--po-bdr)":"rgba(255,255,255,0.25)"):"transparent",color:dark?(nav===k?"#F1F5F9":"var(--po-dim)"):"#FFFFFF"}}>{l}</button>)}</div>
    <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
      <div onClick={()=>setMenu(o=>!o)} style={{cursor:"pointer"}}><Av u={me} size={32}/></div>
      {menu&&<div style={{position:"absolute",right:0,top:40,background:"var(--po-card)",border:"0.5px solid var(--po-bdr)",borderRadius:10,padding:6,minWidth:190,zIndex:100,boxShadow:"0 8px 32px #00000066"}}>
        <div style={{padding:"8px 10px 10px",borderBottom:"0.5px solid var(--po-bdr)",marginBottom:4}}><div className="po-text" style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{me.nickname}</div><div className="po-dim" style={{fontSize:11,color:"var(--po-dim)"}}>USR {me.usr} · {usrLv(me.usr).l}</div></div>
        {[{i:"👤",l:"My Profile",fn:onProfile},{i:"🏟",l:"Venues",fn:onVenues},{i:"⚙️",l:"Settings",fn:onSettings},{i:"🚪",l:"Sign Out",fn:()=>setMenu(false),d:true}].map(x=><button key={x.l} onClick={x.fn} style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"8px 10px",borderRadius:7,border:"none",background:"transparent",color:x.d?"#EF4444":"var(--po-sub)",fontSize:13,cursor:"pointer",textAlign:"left"}}>{x.i} {x.l}</button>)}
      </div>}
    </div>
  </div>;
}

// ── Communities ───────────────────────────────────────
function CommList({comms,me,onOpen,onCreate}){
  const [sub,setSub]=useState("mine"),[q,setQ]=useState("");
  const mine=comms.filter(c=>c.members.some(m=>m.userId===me.id));
  const shown=comms.filter(c=>c.type==="public"&&!c.members.some(m=>m.userId===me.id)).filter(c=>!q?c.gov===me.gov||c.area===me.area:c.name.toLowerCase().includes(q.toLowerCase())||c.area.includes(q));
  function CR({c}){const act=c.members.filter(m=>m.status!=="inactive").length,my=c.members.find(m=>m.userId===me.id);return <Card style={{cursor:"pointer"}}><div onClick={()=>onOpen(c.id)} style={{display:"flex",gap:12,alignItems:"flex-start"}}><div style={{width:44,height:44,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🏸</div><div style={{flex:1,minWidth:0}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:15,color:"var(--po-text)"}}>{c.name}</span><Bdg label={c.type==="public"?"Public":"Private"} color={c.type==="public"?"#34D399":"var(--po-sub)"}/>{my&&rBdg(my.role)}</div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:2}}>📍 {c.area} · {c.gov}</div><div className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>{act} members · {c.events.length} events</div></div></div></Card>;}
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

function CommDetail({comm,users,me,onBack,onEdit,onApprove,onReject,onPromote,onKick,onInvite,onOpenEv,onCreateEv}){
  const [tab,setTab]=useState("members");
  const [showInvite,setShowInvite]=useState(false);
  const myRole=comm.members.find(m=>m.userId===me.id)?.role;
  const isAdmin=myRole==="owner"||myRole==="admin";
  const regs=comm.members.filter(m=>m.status!=="inactive");
  const avgU=regs.length?Math.round(regs.reduce((s,m)=>s+(users.find(u=>u.id===m.userId)?.usr||0),0)/regs.length):0;
  const tdefs=[["members","Members"],["events","Events"],...(isAdmin?[["requests",`Requests${comm.joinRequests.length>0?` (${comm.joinRequests.length})`:""}`]]:[])];
  const statusOrder={regular:0,casual:1,inactive:2},roleOrder={owner:0,admin:1,member:2};
  const sortedMembers=[...comm.members].sort((a,b)=>{if(roleOrder[a.role]!==roleOrder[b.role])return roleOrder[a.role]-roleOrder[b.role];return(statusOrder[a.status]||0)-(statusOrder[b.status]||0);});
  const nonMembers=users.filter(u=>!comm.members.some(m=>m.userId===u.id));

  return <><BBtn onBack={onBack} label="Communities"/>
    <Card>
      <div style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12}}>
        <div style={{width:52,height:52,borderRadius:12,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>🏸</div>
        <div style={{flex:1}}><div className="po-text" style={{fontWeight:700,fontSize:17,color:"var(--po-text)",marginBottom:2}}>{comm.name}</div><div style={{fontSize:12,color:"var(--po-dim)"}}>📍 {comm.area} · {comm.gov} · Founded {fmtD(comm.founded)}</div></div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}><Bdg label={comm.type==="public"?"Public":"Private"} color={comm.type==="public"?"#34D399":"var(--po-sub)"}/>{myRole==="owner"&&<SmBtn label="✏️" onClick={onEdit} color="#6366F1"/>}</div>
      </div>
      <div style={{fontSize:13,color:"var(--po-sub)",marginBottom:14}}>{comm.description}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>{[["Members",regs.length],["Events",comm.events.length],["Avg USR",avgU||"—"],["Requests",comm.joinRequests.length]].map(([l,v])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 0",textAlign:"center"}}><div style={{fontSize:16,fontWeight:700,color:"var(--po-text)"}}>{v}</div><div style={{fontSize:10,color:"var(--po-dim)",marginTop:1}}>{l}</div></div>)}</div>
    </Card>
    <Tabs tabs={tdefs} active={tab} onChange={setTab}/>

    {tab==="members"&&<>
      {["owner","admin","member"].map(rf=>{
        const list=sortedMembers.filter(m=>m.role===rf);if(!list.length)return null;
        return <div key={rf}><ST>{rf==="owner"?"Owner":rf==="admin"?"Admins":"Members"}</ST>
          {list.map(m=>{const u=users.find(u=>u.id===m.userId);if(!u)return null;const isMe=u.id===me.id;return(
            <Card key={m.userId}><div style={{display:"flex",alignItems:"center",gap:10}}>
              <Av u={u} size={38}/>
              <div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{u.nickname}</span>{sBdg(m.status)}{isMe&&<Bdg label="You" color="#6366F1"/>}</div><div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>USR {u.usr} · {u.area}</div></div>
              {isAdmin&&!isMe&&m.role!=="owner"&&<div style={{display:"flex",gap:4}}>{m.role==="member"&&<SmBtn label="↑ Admin" onClick={()=>onPromote(u.id)} color="#6366F1"/>}<SmBtn label="Remove" onClick={()=>onKick(u.id)} color="#EF4444"/></div>}
            </div></Card>
          );})}
        </div>;
      })}
      {isAdmin&&<>
        <SmBtn label={showInvite?"▲ Hide Invite":"+ Invite Platform User"} onClick={()=>setShowInvite(o=>!o)} color="#6366F1" style={{marginTop:8,width:"100%"}}/>
        {showInvite&&nonMembers.length>0&&<Card style={{marginTop:8}}>
          {nonMembers.map(u=><div key={u.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
            <Av u={u} size={28}/><div style={{flex:1}}><span style={{fontSize:12,fontWeight:500,color:"var(--po-text)"}}>{u.nickname}</span><span style={{fontSize:11,color:"var(--po-dim)",marginLeft:6}}>USR {u.usr} · {u.area}</span></div>
            <SmBtn label="+ Add" onClick={()=>{onInvite(u.id);setShowInvite(false);}} color="#6366F1"/>
          </div>)}
        </Card>}
      </>}
    </>}

    {tab==="events"&&<>{isAdmin&&<Btn label="+ New Event" primary onClick={onCreateEv} style={{width:"100%",marginBottom:12}}/>}{comm.events.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No events yet</div></Card>:comm.events.map(ev=><EvCard key={ev.id} ev={ev} onClick={()=>onOpenEv(ev.id)}/>)}</>}
    {tab==="requests"&&isAdmin&&(comm.joinRequests.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"20px 0"}}>No pending requests</div></Card>:comm.joinRequests.map(req=>{const u=users.find(u=>u.id===req.userId);if(!u)return null;return(<Card key={req.userId}><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}><Av u={u} size={38}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr} · {u.area}</div></div></div>{req.message&&<div style={{fontSize:12,color:"var(--po-sub)",background:"var(--po-inp)",borderRadius:6,padding:"7px 10px",marginBottom:10}}>{req.message}</div>}<div style={{display:"flex",gap:6}}><Btn label="Approve" primary onClick={()=>onApprove(req.userId)} style={{flex:1}}/><Btn label="Reject" danger onClick={()=>onReject(req.userId)} style={{flex:1}}/></div></Card>);}))}</>;
}

// ── Venues ────────────────────────────────────────────
function VenueList({venues,onAdd,onEdit,onBack}){
  return <><BBtn onBack={onBack} label="Back"/><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)"}}>Venues</div><Btn label="+ Add Venue" primary onClick={onAdd}/></div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:12,padding:"8px 12px",background:"var(--po-card)",borderRadius:8}}>ℹ️ Use any venue immediately. Platform Admin approval publishes globally.</div>
    {venues.map(v=><Card key={v.id}><div style={{display:"flex",gap:12,alignItems:"flex-start"}}><div style={{width:44,height:44,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>🏟</div><div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:15,color:"var(--po-text)"}}>{v.name}</span>{v.status==="pending"&&<Bdg label="⏳ Pending" color="#F59E0B"/>}{v.status==="pending_edit"&&<Bdg label="✏️ Edit Pending" color="#F59E0B"/>}{(!v.status||v.status==="approved")&&<Bdg label="✓ Approved" color="#34D399"/>}</div><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>📍 {v.area} · {v.gov}</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:4}}><Bdg label={`${v.courts.length} courts`} color="#38BDF8"/><Bdg label={`${v.pricePerHour} EGP/hr`} color="#34D399"/>{v.extraFee>0&&<Bdg label={`+${v.extraFee} booking`} color="#FBBF24"/>}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{v.courts.map(c=>c.name).join(" · ")}</div></div><SmBtn label="✏️ Edit" onClick={()=>onEdit(v.id)} color="#6366F1"/></div></Card>)}
  </>;
}
function VenueForm({editV,onBack,onSave}){
  const ie=!!editV;const emptyNames=Array(Math.max(0,10-(editV?.courts.length||0))).fill("");
  const [f,setF]=useState({name:editV?.name||"",gov:editV?.gov||"",area:editV?.area||"",pricePerHour:editV?String(editV.pricePerHour):"",extraFee:editV?String(editV.extraFee):"",mapsUrl:editV?.mapsUrl||"",courtNames:editV?[...editV.courts.map(c=>c.name),...emptyNames]:["Court 1","Court 2","","","","","","","",""]});
  const set=(k,v)=>setF(p=>({...p,[k]:v})),setC=(i,v)=>setF(p=>{const n=[...p.courtNames];n[i]=v;return{...p,courtNames:n};});const areas=f.gov?EGYPT[f.gov]||[]:[];
  return <><BBtn onBack={onBack} label="Venues"/><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:ie?4:16}}>{ie?"Edit Venue":"Add Venue"}</div>{ie&&<div style={{fontSize:12,color:"#F59E0B",marginBottom:14,padding:"8px 12px",background:"#F59E0B11",borderRadius:8}}>✏️ Changes apply immediately. Pending global review.</div>}
    <Card><Inp label="Venue Name" value={f.name} onChange={v=>set("name",v)} placeholder="e.g. Wadi Degla Club"/><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:0}}><Drp label="المحافظة" value={f.gov} onChange={v=>{set("gov",v);set("area","");}} options={Object.keys(EGYPT).map(g=>({v:g,l:g}))}/><Drp label="المنطقة" value={f.area} onChange={v=>set("area",v)} options={areas.map(a=>({v:a,l:a}))}/></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><Inp label="Price/hr (EGP)" value={f.pricePerHour} onChange={v=>set("pricePerHour",v)} type="number"/><Inp label="Extra Booking (EGP)" value={f.extraFee} onChange={v=>set("extraFee",v)} type="number"/></div><Inp label="Google Maps URL" value={f.mapsUrl} onChange={v=>set("mapsUrl",v)} placeholder="https://maps.google.com/..."/>
    <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Court Names (up to 10)</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>{f.courtNames.map((cn,i)=><input key={i} value={cn} onChange={e=>setC(i,e.target.value)} placeholder={`Court ${i+1}`} className="po-inp" style={{background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"7px 10px",color:"var(--po-text)",fontSize:13}}/>)}</div></div>
    <Btn label={ie?"Save & Submit for Review":"Add Venue & Submit for Review"} primary onClick={()=>{if(f.name&&f.area)onSave(f,ie?editV.id:null);}} style={{width:"100%"}}/></Card></>;
}

// ── Event Card ────────────────────────────────────────
function EvCard({ev,onClick}){
  const sc={registration_open:"#34D399",completed:"var(--po-sub)",cancelled:"#EF4444"};
  const sl={registration_open:"Open",completed:"Closed",cancelled:"Cancelled"};
  const tl={open:"Open Day",closed_ind:"Closed Ind.",closed_teams:"Closed Teams"};
  return <Card style={{cursor:"pointer"}}><div onClick={onClick} style={{display:"flex",gap:10,alignItems:"center"}}><div style={{width:42,height:42,borderRadius:10,background:"var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>📅</div><div style={{flex:1}}><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}><span style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{ev.name}</span><Bdg label={sl[ev.status]||ev.status} color={sc[ev.status]||"#94A3B8"}/>{ev.type&&<Bdg label={tl[ev.type]||ev.type} color="#6366F1"/>}{!ev.type&&<Bdg label="🗳 Poll" color="#F59E0B"/>}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{ev.courts} courts · {ev.registrations.length} registered</div><div style={{fontSize:11,color:"var(--po-dim)",marginTop:1}}>{fmtD(ev.date)} · {ev.time}{ev.timeTo?` → ${ev.timeTo}`:""}</div></div></div></Card>;
}

// ── Event Create Form ─────────────────────────────────
function EventForm({venues,onBack,onCreate}){
  const [f,setF]=useState({name:"",date:"",time:"18:00",timeTo:"22:00",venueId:"",courts:"2",rotationMin:"15",pollMode:false,eventType:"open"});
  const set=(k,v)=>setF(p=>({...p,[k]:v}));const v=venues.find(x=>x.id===parseInt(f.venueId)),c=parseInt(f.courts)||0,maxC=v?v.courts.length:10,tot=v?(v.pricePerHour*c+v.extraFee*c):0;
  return <><BBtn onBack={onBack} label="Community"/><div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>New Event</div><Card>
    <Inp label="Event Name" value={f.name} onChange={v2=>set("name",v2)} placeholder="e.g. Friday Night Padel"/>
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
  const [f,setF]=useState({courts:String(ev.courts),time:ev.time,timeTo:ev.timeTo||""});
  const set=(k,val)=>setF(p=>({...p,[k]:val}));
  const maxC=v?v.courts.length:10;
  return <><BBtn onBack={onBack} label={ev.name}/><div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>Edit Event</div>
    <Card>
      <div style={{fontSize:12,color:"var(--po-dim)",marginBottom:14,padding:"8px 12px",background:"var(--po-card)",borderRadius:8}}>ℹ️ You can change courts count and times. Players and plan stay unchanged.</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:0}}>
        <Inp label="Start Time" value={f.time} onChange={v2=>set("time",v2)} type="time"/>
        <Inp label="End Time" value={f.timeTo} onChange={v2=>set("timeTo",v2)} type="time"/>
      </div>
      <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:4}}>Courts (max {maxC})</div>
        <select value={f.courts} onChange={e=>set("courts",e.target.value)} className="po-inp" style={{width:"100%",background:"var(--po-inp)",border:"0.5px solid var(--po-bdr)",borderRadius:8,padding:"8px 10px",color:"var(--po-text)",fontSize:13}}>
          {Array.from({length:maxC},(_,i)=>i+1).map(n=><option key={n} value={n}>{n} courts (Ideal: {n*5}, Max: {n*6})</option>)}
        </select>
      </div>
      <Btn label="Save Changes" primary onClick={()=>onSave({courts:parseInt(f.courts),time:f.time,timeTo:f.timeTo})} style={{width:"100%"}}/>
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
      <button onMouseDown={e=>{e.preventDefault();onRegenerate();}}
        style={{padding:"6px 12px",borderRadius:7,border:"0.5px solid #6366F144",background:"#6366F111",color:"#A5B4FC",fontSize:12,fontWeight:500,cursor:"pointer"}}>
        🔄 Regenerate Future
      </button>
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
  const gc=group==="A"?"#6366F1":"#06B6D4";
  return <Card style={{marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:10}}>
    <div style={{width:36,height:36,borderRadius:8,background:`${gc}22`,border:`0.5px solid ${gc}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:gc,flexShrink:0}}>{group}{team.id}</div>
    <div style={{flex:1}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
        <span style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{team.name}</span>
        <span style={{fontSize:12,color:"var(--po-dim)"}}>({team.avgUsr})</span>
        <Bdg label={`Group ${group}`} color={gc}/>
      </div>
      <div style={{display:"flex",gap:10}}>{team.players.map(p=>{const lv=usrLv(p.usr);return <div key={p.userId||p.id} style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:22,height:22,borderRadius:"50%",background:`${lv.c}22`,border:`1px solid ${lv.c}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:lv.c}}>{p.avatar||ini2(p.nickname)}</div><span className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>{p.nickname}</span><span style={{fontSize:10,color:"var(--po-dim)"}}>{p.usr}</span></div>;})}</div>
    </div>
  </div></Card>;
}

// ══════════════════════════════════════════════════════
//  CT MATCHES TAB
// ══════════════════════════════════════════════════════
function CTMatchesTab({plan,onSetWinCT,onApplyPromo,onNextCTLadder,onSwapCTLadder}){
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
        {lastRoundDone&&ladderDone&&<div style={{padding:"12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:10,fontSize:13,fontWeight:600,color:"#34D399",textAlign:"center",marginBottom:12}}>🏆 Event Complete — all rounds played! Check Standings.</div>}}
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
        {isLeague
          ?<>{round.matchesA.map((m,mi)=><MatchCard key={`A${mi}`} m={m} ri={ri} mi={mi} side="A"/>)}{(round.matchesB||[]).map((m,mi)=><MatchCard key={`B${mi}`} m={m} ri={ri} mi={mi} side="B"/>)}</>
          :<>{round.matchesA.map((m,mi)=><MatchCard key={`A${mi}`} m={m} ri={ri} mi={mi} side="A"/>)}</>
        }
      </div>;
    })}
  </>;
}

// ══════════════════════════════════════════════════════
//  EVENT DETAIL
// ══════════════════════════════════════════════════════
function EvDetail({ev,comm,users,venues,me,onBack,onEditEvent,onRegister,onCheckIn,onAddMember,onAddGuest,onVote,onResolveType,onCloseEvent,onStartCI,onSetWinCI,onNextRound,onSwap,onEditBreak,onRegenerateBreaks,onStartCT,onSetWinCT,onApplyPromo,onNextCTLadder,onSwapCTLadder,onRemoveFromEvent,onEditGuestUsr}){
  const [tab,setTab]       = useState("info");
  const [sim,setSim]       = useState(false);
  const [totalR,setTotalR] = useState(6);
  const [roundDur,setRDur] = useState(20);
  const [showAddM,setSAM]  = useState(false);
  const [showAddG,setSAG]  = useState(false);
  const [gf,setGf]         = useState({n:"",name:"",p:"",usr:"50"});
  const [sel,setSel]       = useState(null);
  const [ctC,setCtC]       = useState(null);
  const [ctF,setCtF]       = useState("league");

  const venue  = venues.find(v=>v.id===ev.venueId);
  const myMem  = comm.members.find(m=>m.userId===me.id);
  const isAdmin= myMem?.role==="owner"||myMem?.role==="admin";
  const isReg  = myMem?.status==="regular";
  const myReg  = ev.registrations.find(r=>r.userId===me.id);
  const isCIn  = ev.checkedIn.includes(me.id);
  const isOpen = ev.type==="open";
  const isCI   = ev.type==="closed_ind";
  const isCT   = ev.type==="closed_teams";
  const tc     = ev.courts;
  const bp     = breakPts(tc);
  const ideal  = tc*5, maxCap=tc*6;
  const totC   = (ev.costPerCourt||0)*tc+(ev.extraFee||0)*tc;
  const cinCnt = ev.checkedIn.length;
  const cpp    = cinCnt>0?(totC/cinCnt).toFixed(0):"—";
  const inRW   = new Date()<new Date(ev.regularUntil);
  const canReg = !myReg&&ev.status==="registration_open"&&(!inRW||isReg||isAdmin);
  const isDay  = sim||ev.date===today;
  const isFut2 = !sim&&ev.date>today;
  const plan   = ev.plan;
  const tl     = {open:"Open Day",closed_ind:"Closed Individuals",closed_teams:"Closed Teams"};
  const isCompleted = ev.status==="completed";

  // CT calc
  const ctCC   = isCT?calcCTCourts(ev.registrations.length,ev.reservedCourts||ev.courts||2):null;
  const selCtC = ctC??ctCC?.min??tc;
  const nTeams = Math.floor(ev.registrations.length/2);
  const breakTeams = Math.max(0,nTeams-selCtC*2);
  const ladderOK   = (breakTeams*2)<=selCtC; // break PLAYERS (teams×2) must not exceed courts

  // CI
  const lastCIR = plan?.rounds?.[plan.rounds.length-1];
  const canNext = isCI&&lastCIR&&lastCIR.matches.every(m=>m.winner!=null)&&plan.rounds.length<plan.totalRounds;
  const ciStands = isCI?calcCIStandings(plan,users):[];
  const ctStands = isCT?calcCTStandings(plan):[];

  const tabs=["info","players",
    ...(isCI&&isAdmin?(plan?["breaks","rounds","standings"]:["rounds"]):[]),
    ...(isCT&&isAdmin?(plan?["teams","matches","standings"]:["teams"]):[]),
    ...(isOpen&&isAdmin?["manage"]:[])
  ];
  const tLabels={info:"Info",players:"Players",manage:"Manage",breaks:"Breaks",rounds:"Rounds",standings:"Standings",teams:"Teams",matches:"Matches"};

  function tapP(ri,uid){if(!sel){setSel({ri,uid});return;}if(sel.ri!==ri){setSel({ri,uid});return;}if(sel.uid===uid){setSel(null);return;}onSwap(ri,sel.uid,uid);setSel(null);}
  function PChip({p,ri}){const lv=usrLv(p.usr),isSel=sel?.ri===ri&&sel?.uid===p.userId,isTgt=sel&&sel.ri===ri&&sel.uid!==p.userId;return <div onClick={()=>tapP(ri,p.userId)} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:8,cursor:"pointer",userSelect:"none",border:`2px solid ${isSel?"#FBBF24":isTgt?"#34D399":"transparent"}`,background:isSel?"#FBBF2422":isTgt?"#34D39922":"transparent"}}><div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,background:`${lv.c}22`,border:`1.5px solid ${lv.c}66`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:lv.c}}>{p.avatar||ini2(p.nickname)}</div><span style={{fontSize:13,fontWeight:500,color:"var(--po-text)",flex:1}}>{p.nickname}</span><span style={{fontSize:11,color:"var(--po-dim)"}}>{p.usr}</span></div>;}
  function WinCI({m,ri,mi}){
    const avgA=m.teamA?Math.round(m.teamA.reduce((s,p)=>s+p.usr,0)/m.teamA.length):0;
    const avgB=m.teamB?Math.round(m.teamB.reduce((s,p)=>s+p.usr,0)/m.teamB.length):0;
    if(m.winner){const wT=m.winner==="A"?m.teamA:m.teamB;return <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10}}><div style={{flex:1,padding:"9px",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:12,fontWeight:600,color:"#34D399",textAlign:"center"}}>✓ {wT.map(p=>p.nickname).join(" & ")} won</div><SmBtn label="↩" onClick={()=>onSetWinCI(ri,mi,null)} color="#EF4444"/></div>;}
    return <div style={{display:"flex",gap:8,marginTop:10}}>
      <button onMouseDown={e=>{e.preventDefault();onSetWinCI(ri,mi,"A");}} style={{flex:1,padding:"10px 0",borderRadius:8,border:"0.5px solid #6366F144",background:"#6366F111",color:"#A5B4FC",fontSize:13,fontWeight:600,cursor:"pointer"}}>← Team A wins <span style={{fontSize:10,opacity:0.7}}>({avgA})</span></button>
      <button onMouseDown={e=>{e.preventDefault();onSetWinCI(ri,mi,"B");}} style={{flex:1,padding:"10px 0",borderRadius:8,border:"0.5px solid #06B6D444",background:"#06B6D411",color:"#67E8F9",fontSize:13,fontWeight:600,cursor:"pointer"}}>Team B wins → <span style={{fontSize:10,opacity:0.7}}>({avgB})</span></button>
    </div>;}

  return <>
    <BBtn onBack={onBack} label={comm.name}/>
    {isAdmin&&isFut2&&!sim&&<div className="po-card" style={{marginBottom:12,padding:"10px 14px",background:"var(--po-card)",borderRadius:10,border:"0.5px solid var(--po-bdr)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}><div><div style={{fontSize:12,fontWeight:600,color:"var(--po-sub)"}}>🧪 Simulation Mode</div><div style={{fontSize:11,color:"var(--po-dim)"}}>Test the full event flow</div></div><SmBtn label="Simulate ▶" onClick={()=>{setSim(true);setTab(isCI?"rounds":isCT?"teams":"players");}} color="#6366F1"/></div>}
    {sim&&<div style={{marginBottom:12,padding:"10px 14px",background:"#6366F111",borderRadius:10,border:"0.5px solid #6366F155",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}><div><div style={{fontSize:12,fontWeight:600,color:"#A5B4FC"}}>🧪 Simulation Active</div></div><SmBtn label="Exit" onClick={()=>setSim(false)} color="#EF4444"/></div>}

    <Card>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div>
          <div className="po-text" style={{fontWeight:700,fontSize:17,color:"var(--po-text)",marginBottom:4}}>{ev.name}</div>
          {venue&&<div style={{fontSize:12,color:"var(--po-dim)"}}>🏟 {venue.name} · {venue.area}</div>}
          <div style={{fontSize:12,color:"var(--po-dim)"}}>🗓 {fmtD(ev.date)} · {ev.time}{ev.timeTo?` → ${ev.timeTo}`:""}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end"}}>
          {ev.type&&<Bdg label={tl[ev.type]} color="#6366F1"/>}
          {!ev.type&&<Bdg label="🗳 Poll" color="#F59E0B"/>}
          {isCompleted&&<Bdg label="✓ Closed" color="#34D399"/>}
          {isAdmin&&!isCompleted&&<SmBtn label="✏️ Edit" onClick={onEditEvent} color="#6366F1"/>}
        </div>
      </div>

      <PollBlock ev={ev} me={me} isReg={isReg} isAdmin={isAdmin} onVote={onVote} onResolveType={onResolveType}/>

      <div style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--po-dim)",marginBottom:4}}><span>{ev.registrations.length} registered</span><span>Ideal {ideal} · Max {maxCap}</span></div>
        <div style={{height:6,background:"var(--po-bdr)",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,transition:"width 0.3s",width:`${Math.min(100,(ev.registrations.length/ideal)*100)}%`,background:ev.registrations.length>=ideal?"#EF4444":"#6366F1"}}/></div>
        {inRW&&!isReg&&!isAdmin&&<div style={{fontSize:11,color:"#FBBF24",marginTop:3}}>⏳ Priority for Regular Members until {new Date(ev.regularUntil).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div>}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:12}}>
        {[["Courts",tc],["Registered",ev.registrations.length],
          ...(isOpen?[["Checked In",cinCnt],["Per Person",`${cpp} EGP`]]:
              isCI?[["Rounds",plan?.rounds?.length||0],[`C1=${courtPts(1,tc)}pts`,`Brk=${bp}pts`]]:
              isCT?[["Teams",plan?.teams?.length||0],["Format",plan?.format||"—"]]:[])
        ].map(([l,val])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"7px 4px",textAlign:"center"}}><div style={{fontSize:13,fontWeight:700,color:"var(--po-text)"}}>{val}</div><div style={{fontSize:9,color:"var(--po-dim)",marginTop:1}}>{l}</div></div>)}
      </div>

      {!isCompleted&&ev.status==="registration_open"&&<>
        {canReg&&<Btn label="I'm In ✓" primary onClick={onRegister} style={{width:"100%",marginBottom:6}}/>}
        {myReg&&isOpen&&(isDay?(!isCIn?<div style={{display:"flex",gap:6,marginBottom:6}}><div style={{flex:1,padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399"}}>✓ Registered</div><Btn label="Check In" primary onClick={()=>onCheckIn(me.id)} style={{flex:1}}/></div>:<div style={{padding:"9px",textAlign:"center",background:"#6366F122",border:"0.5px solid #6366F144",borderRadius:8,fontSize:13,fontWeight:500,color:"#A5B4FC",marginBottom:6}}>✓ Checked In</div>):<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399",marginBottom:6}}>✓ Registered — check-in on event day</div>)}
        {myReg&&(isCI||isCT)&&<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:500,color:"#34D399",marginBottom:6}}>✓ Registered — attendance via match results</div>}
        {isAdmin&&<Btn label="🏁 Close & Finish Event" danger onClick={onCloseEvent} style={{width:"100%"}}/>}
      </>}
      {isCompleted&&<div style={{padding:"9px",textAlign:"center",background:"#34D39922",border:"0.5px solid #34D39944",borderRadius:8,fontSize:13,fontWeight:600,color:"#34D399"}}>✓ Event Completed & Closed</div>}
    </Card>

    <Tabs tabs={tabs.map(t=>[t,tLabels[t]||t])} active={tab} onChange={setTab}/>

    {/* INFO */}
    {tab==="info"&&<Card><div style={{display:"flex",flexDirection:"column",gap:8}}>{[["Venue",venue?`${venue.name}, ${venue.area}`:"TBD"],
        ["Type",ev.type?tl[ev.type]:"Pending Poll"],
        ["Date & Time",`${fmtD(ev.date)} · ${ev.time}${ev.timeTo?" → "+ev.timeTo:""}`],
        ["Duration",(()=>{if(!ev.time||!ev.timeTo)return "—";const[sh,sm]=ev.time.split(":").map(Number);const[eh,em]=ev.timeTo.split(":").map(Number);const m=(eh*60+em)-(sh*60+sm);if(m<=0)return "—";const h=Math.floor(m/60),rm=m%60;return h>0?(rm>0?`${h}h ${rm}min`:`${h}h`):`${rm}min`;})()],
        ["Created by",(()=>{const u=users.find(u=>u.id===ev.createdBy);return u?`${u.nickname} (${u.name})`:"—";})()],...(isCI?[["Scoring",Array.from({length:tc},(_,i)=>`Court ${i+1}=${courtPts(i+1,tc)}pts`).join(" · ")+` · Break=${bp}pts`],["Round Duration",`${plan?.roundDuration||roundDur} min`]]:isOpen?[["Rotation",`Every ${ev.rotationMin} min`],["Check-in","Required · cost split by attendees"]]:isCT?[["Formation","Multi-Pool Snake (USR)"],["Competition",plan?.format==="ladder"?"Ladder":"League + Promo/Relego"],[plan?.format==="ladder"?"Scoring":"Ranking",plan?.format==="ladder"?`Court ${tc}=1pt ... Court 1=${tc}pts · Break=${ctLadderBreakPts(tc)}pts`:"Group A first · Wins → Score Diff"]]:[]),["Priority Reg.","Regular Members: 24h early access"]].map(([k,val])=><div key={k} style={{display:"flex",gap:8,paddingBottom:7,borderBottom:"0.5px solid var(--po-bdr)"}}><span className="po-dim" style={{fontSize:12,color:"var(--po-dim)",minWidth:110}}>{k}</span><span className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>{val}</span></div>)}</div></Card>}

    {/* PLAYERS */}
    {tab==="players"&&<>
      {isAdmin&&<><div style={{display:"flex",gap:6,marginBottom:10}}><Btn label="+ Add Member" onClick={()=>{setSAM(o=>!o);setSAG(false);}} style={{flex:1}}/><Btn label="+ Add Guest" onClick={()=>{setSAG(o=>!o);setSAM(false);}} style={{flex:1}}/></div>
      {showAddM&&<Card style={{marginBottom:10}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Select member to add:</div>{comm.members.filter(m=>!new Set(ev.registrations.map(r=>r.userId)).has(m.userId)).map(m=>users.find(u=>u.id===m.userId)).filter(Boolean).map(u=><div key={u.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"0.5px solid var(--po-bdr)"}}><Av u={u} size={30}/><div style={{flex:1}}><div style={{fontSize:13,fontWeight:500,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr}</div></div><SmBtn label="Add" onClick={()=>{onAddMember(u.id);setSAM(false);}} color="#6366F1"/></div>)}</Card>}
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
        <Btn label="Add Guest" primary onClick={()=>{if(gf.n&&gf.p){onAddGuest(gf);setGf({n:"",name:"",p:"",usr:"50"});setSAG(false);}}} style={{width:"100%"}}/>
      </Card>}</>}
      {isOpen&&cinCnt>0&&<><ST>Checked In ({cinCnt})</ST>{ev.checkedIn.map(uid=>{const u=users.find(u=>u.id===uid);if(!u)return null;return <Card key={uid}><div style={{display:"flex",alignItems:"center",gap:10}}><Av u={u} size={34}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{u.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr}</div></div><Bdg label="✓ In" color="#34D399"/></div></Card>;})}</>}
      <ST>Registered ({ev.registrations.length})</ST>
      {ev.registrations.map(r=>{
        const u=users.find(u=>u.id===r.userId);if(!u)return null;
        const ci2=ev.checkedIn.includes(u.id);
        return <Card key={r.userId}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <Av u={u} size={34}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>
                {u.nickname}
                {u.isGuest&&<span style={{marginLeft:4,fontSize:10,color:"#F59E0B"}}>GUEST{u.phone?` · ${u.phone}`:""}</span>}
              </div>
              {/* Guest USR - editable inline */}
              {u.isGuest||r.isGuest
                ? <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                    <span style={{fontSize:11,color:"var(--po-dim)"}}>USR</span>
                    <input type="number" min="0" max="100" value={u.usr}
                      onChange={e=>onEditGuestUsr(u.id,e.target.value)}
                      className="po-inp"
                      style={{width:52,padding:"2px 6px",borderRadius:6,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",fontSize:12,fontWeight:600}}/>
                    <span style={{fontSize:10,color:"var(--po-dim)"}}>/100</span>
                  </div>
                : <div style={{fontSize:11,color:"var(--po-dim)"}}>USR {u.usr}</div>
              }
            </div>
            <div style={{display:"flex",gap:4,flexWrap:"wrap",justifyContent:"flex-end",alignItems:"center"}}>
              {r.addedBy==="admin"&&<Bdg label="👤 Admin" color="#6366F1"/>}
              {r.isGuest&&<Bdg label="Guest" color="#F59E0B"/>}
              {isOpen&&!ci2&&isAdmin&&isDay&&<SmBtn label="✓ In" onClick={()=>onCheckIn(u.id)} color="#34D399"/>}
              {isOpen&&ci2&&<Bdg label="✓ In" color="#34D399"/>}
              {isAdmin&&!ev.plan&&<SmBtn label="✕" onClick={()=>onRemoveFromEvent(u.id)} color="#EF4444" style={{padding:"4px 8px",fontSize:11}}/>}
            </div>
          </div>
        </Card>;
      })}
    </>}

    {/* MANAGE */}
    {tab==="manage"&&isAdmin&&isOpen&&<>
      {ev.registrations.length<tc*4&&<Card style={{background:"#EF444411",border:"0.5px solid #EF444444",marginBottom:10}}><div style={{fontSize:13,fontWeight:600,color:"#EF4444",marginBottom:4}}>⚠️ Insufficient Players</div><div className="po-sub" style={{fontSize:12,color:"var(--po-sub)"}}>Need {tc*4} players. Currently {ev.registrations.length}.</div></Card>}
      {sim&&cinCnt>0&&<Card style={{background:"#6366F111",border:"0.5px solid #6366F144",marginBottom:10}}><div style={{fontSize:13,fontWeight:600,color:"#A5B4FC",marginBottom:10}}>💰 Live Cost Settlement</div>{[["Total",`${totC} EGP`],["Checked In",cinCnt],["Per Player",`${cpp} EGP`]].map(([k,val])=><div key={k} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"0.5px solid #6366F122"}}><span style={{fontSize:13,color:"var(--po-dim)"}}>{k}</span><span style={{fontSize:14,fontWeight:700,color:k==="Per Player"?"#A5B4FC":"var(--po-text)"}}>{val}</span></div>)}</Card>}
      <ST>Financial Summary</ST><Card>{[["Courts",tc],["Cost/court",`${ev.costPerCourt||0} EGP`],["Total",`${totC} EGP`],["Checked in",cinCnt],["Per player",cinCnt>0?`${cpp} EGP`:"—"]].map(([k,val])=><div key={k} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"0.5px solid var(--po-bdr)"}}><span style={{fontSize:13,color:"var(--po-dim)"}}>{k}</span><span style={{fontSize:13,fontWeight:600,color:k==="Per player"?"#34D399":"var(--po-text)"}}>{val}</span></div>)}</Card>
    </>}

    {/* CI BREAKS */}
    {tab==="breaks"&&isCI&&isAdmin&&plan&&<BreaksTab plan={plan} ev={ev} users={users} bp={bp} tc={tc} onEditBreak={onEditBreak} onRegenerate={onRegenerateBreaks}/>}

    {/* CI ROUNDS */}
    {tab==="rounds"&&isCI&&isAdmin&&<>
      {!plan&&<Card>
        <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Generate Round 1</div>
        <div style={{fontSize:13,color:"var(--po-sub)",marginBottom:12}}>{ev.registrations.length} players · {tc} courts · {Math.max(0,ev.registrations.length-tc*4)} on break/round</div>
        <div style={{background:"var(--po-inp)",borderRadius:8,padding:"10px 12px",marginBottom:12}}><div style={{fontSize:11,color:"var(--po-dim)",marginBottom:6}}>Scoring:</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{Array.from({length:tc},(_,i)=><Bdg key={i} label={`Court ${i+1} = ${courtPts(i+1,tc)} pts`} color="#38BDF8"/>)}<Bdg label={`Break = ${bp} pts`} color="#F59E0B"/></div></div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><span style={{fontSize:12,color:"var(--po-dim)"}}>Round duration:</span>{[15,20,25,30].map(n=><SmBtn key={n} label={`${n}m`} onClick={()=>setRDur(n)} active={roundDur===n} color="#6366F1"/>)}</div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}><span style={{fontSize:12,color:"var(--po-dim)"}}>Total rounds:</span>{[4,5,6,7,8].map(n=><SmBtn key={n} label={`${n}`} onClick={()=>setTotalR(n)} active={totalR===n} color="#6366F1"/>)}</div>
        {ev.registrations.length<tc*4?<div style={{padding:"10px",background:"#EF444411",border:"0.5px solid #EF444444",borderRadius:8,fontSize:12,color:"#EF4444"}}>⚠️ Need at least {tc*4} players.</div>:<Btn label="🎯 Generate Round 1" primary onClick={()=>onStartCI(totalR,roundDur)} style={{width:"100%"}}/>}
      </Card>}
      {plan&&<>
        {/* Next round button ON TOP */}
        {canNext&&<Btn label={`▶ Generate Round ${plan.rounds.length+1} of ${plan.totalRounds}`} primary onClick={onNextRound} style={{width:"100%",marginBottom:12}}/>}
        {plan.rounds.length>=plan.totalRounds&&plan.rounds.every(r=>r.matches.every(m=>m.winner!=null))&&<div style={{textAlign:"center",padding:"14px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:10,fontSize:14,fontWeight:600,color:"#34D399",marginBottom:12}}>🏆 Complete — check Standings!</div>}

        {/* Swap hint */}
        <div style={{fontSize:12,padding:"9px 12px",borderRadius:8,marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,background:sel?"#FBBF2411":"var(--po-bdr)",border:`0.5px solid ${sel?"#FBBF2444":"#334155"}`}}>
          <span style={{color:sel?"#FBBF24":"var(--po-dim)"}}>{sel?`✋ ${users.find(u=>u.id===sel.uid)?.nickname} — tap another in Round ${sel.ri+1} to swap`:"💡 Tap player to select · tap another in same round to swap"}</span>
          {sel&&<SmBtn label="✕" onClick={()=>setSel(null)} color="#EF4444"/>}
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
      {ciStands.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>Record winners to see standings.</div></Card>:ciStands.map((s,i)=><Card key={s.user.id}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,background:i<3?"#6366F133":"var(--po-bdr)",color:i===0?"#FBBF24":i===1?"#94A3B8":i===2?"#CD7C2F":"var(--po-dim)"}}>{i+1}</div><Av u={s.user} size={34}/><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{s.user.nickname}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{s.wins} wins · {s.breaks} breaks · {s.played} played</div></div><div style={{textAlign:"right"}}><div style={{fontSize:22,fontWeight:700,color:"#6366F1"}}>{s.pts}</div><div style={{fontSize:10,color:"var(--po-dim)"}}>pts</div></div></div></Card>)}
    </>}

    {/* CT TEAMS */}
    {tab==="teams"&&isCT&&isAdmin&&<>
      {!plan&&<Card>
        <div style={{fontSize:14,fontWeight:600,color:"var(--po-text)",marginBottom:8}}>Form Teams & Start</div>
        <div style={{fontSize:13,color:"var(--po-sub)",marginBottom:12}}>{ev.registrations.length} players → {Math.floor(ev.registrations.length/6)} pools → {Math.floor(ev.registrations.length/2)} teams</div>
        {ctCC?.warning&&<div style={{padding:"8px 12px",background:"#F59E0B11",border:"0.5px solid #F59E0B44",borderRadius:8,fontSize:12,color:"#F59E0B",marginBottom:12}}>⚠️ {ctCC.warning}</div>}
        <div style={{marginBottom:14}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Courts:</div><div style={{display:"flex",gap:8}}>{[ctCC?.min,ctCC?.max].filter((v,i,a)=>v&&a.indexOf(v)===i).map(n=><button key={n} onClick={()=>setCtC(n)} style={{flex:1,padding:"10px",borderRadius:8,cursor:"pointer",border:`0.5px solid ${selCtC===n?"#6366F1":"var(--po-bdr)"}`,background:selCtC===n?"#6366F122":"var(--po-inp)",color:selCtC===n?"#A5B4FC":"var(--po-sub)",fontSize:13,fontWeight:600}}>{n} {n===ctCC?.min?"(min)":"(max)"}</button>)}</div></div>
        <div style={{marginBottom:16}}><div style={{fontSize:12,color:"var(--po-dim)",marginBottom:8}}>Format:</div>
          {[{k:"league",l:"League + Promotion/Relegation",d:"Groups play full round robin · top promoted · bottom relegated",ok:true},
            {k:"ladder",l:"Ladder",d:ladderOK?"Teams climb/descend · break schedule · court points":`❌ Invalid: ${breakTeams} break team(s) > ${selCtC} court(s). Use League instead.`,ok:ladderOK}
          ].map(f=><div key={f.k} onClick={()=>f.ok&&setCtF(f.k)} style={{padding:"10px 12px",borderRadius:8,marginBottom:6,cursor:f.ok?"pointer":"not-allowed",border:`0.5px solid ${ctF===f.k?"#6366F1":f.ok?"var(--po-bdr)":"#EF444433"}`,background:ctF===f.k?"#6366F122":f.ok?"#0E1117":"#EF444408",opacity:f.ok?1:0.55}}>
            <div style={{fontWeight:600,fontSize:13,color:ctF===f.k?"#A5B4FC":f.ok?"var(--po-text)":"#EF4444",marginBottom:2}}>{f.l}</div>
            <div style={{fontSize:11,color:f.ok?"var(--po-dim)":"#EF4444"}}>{f.d}</div>
          </div>)}
        </div>
        <Btn label="🎯 Form Teams & Start" primary onClick={()=>onStartCT(selCtC,ctF)} style={{width:"100%"}}/>
      </Card>}
      {plan&&<>
        <div style={{padding:"8px 12px",background:"#34D39911",border:"0.5px solid #34D39933",borderRadius:8,fontSize:12,color:"#34D399",marginBottom:12}}>✓ {plan.teams.length} teams · {plan.format==="ladder"?"Ladder":"League"} · {plan.courts} courts</div>
        <ST>Group A — {plan.groupA.length} teams</ST>
        {plan.groupA.map(t=><CTTeamCard key={t.id} team={t} group="A"/>)}
        {plan.groupB?.length>0&&<><ST>Group B — {plan.groupB.length} teams</ST>{plan.groupB.map(t=><CTTeamCard key={t.id} team={t} group="B"/>)}</>}
      </>}
    </>}

    {/* CT MATCHES */}
    {tab==="matches"&&isCT&&isAdmin&&plan&&<CTMatchesTab plan={plan} onSetWinCT={onSetWinCT} onApplyPromo={onApplyPromo} onNextCTLadder={onNextCTLadder} onSwapCTLadder={onSwapCTLadder}/>}

    {/* CT STANDINGS */}
    {tab==="standings"&&isCT&&<>
      <div style={{marginBottom:10,padding:"8px 12px",background:"var(--po-card)",borderRadius:8,fontSize:12,color:"var(--po-dim)"}}>
        {plan?.format==="ladder"?`Court scoring: ${Array.from({length:tc},(_,i)=>`C${i+1}=${ctLadderCourtPts(i+1,tc)}pts`).join(" · ")} · Break=${ctLadderBreakPts(tc)}pts`:"Cumulative all rounds · Group A first · Wins → Score Diff"}
      </div>
      {ctStands.length===0?<Card><div style={{textAlign:"center",color:"var(--po-dim)",fontSize:13,padding:"24px 0"}}>Record results to see standings.</div></Card>
      :ctStands.map((s,i)=>{const gc=s.group==="A"?"#6366F1":"#06B6D4";return <div key={s.team?.id||i}><Card style={{marginBottom:6}}><div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,background:i<3?"#6366F133":"var(--po-bdr)",color:i===0?"#FBBF24":i===1?"#94A3B8":i===2?"#CD7C2F":"var(--po-dim)"}}>{s.finalRank}</div>
        <div style={{width:32,height:32,borderRadius:8,background:`${gc}22`,border:`0.5px solid ${gc}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:gc,flexShrink:0}}>{s.group}{s.team?.id}</div>
        <div style={{flex:1}}>
          <div style={{fontWeight:600,fontSize:14,color:"var(--po-text)"}}>{s.team?.name} <span style={{fontSize:12,color:"var(--po-dim)"}}>({s.team?.avgUsr})</span></div>
          <div style={{fontSize:11,color:"var(--po-dim)"}}>{s.team?.players?.map(p=>p.nickname).join(" & ")}</div>
          <div style={{fontSize:11,color:"var(--po-dim)",marginTop:2}}>{s.wins}W · {s.losses}L{plan?.format!=="ladder"?` · Diff ${s.scoreDiff>=0?"+":""}${s.scoreDiff}`:` · ${s.breaks||0} breaks`}</div>
        </div>
        <div style={{textAlign:"right"}}><div style={{fontSize:18,fontWeight:700,color:gc}}>{plan?.format==="ladder"?s.pts:s.wins}</div><div style={{fontSize:10,color:"var(--po-dim)"}}>{plan?.format==="ladder"?"pts":"wins"}</div></div>
      </div></Card></div>;})}
    </>}
  </>;
}

// ══════════════════════════════════════════════════════
//  EVENTS LIST
// ══════════════════════════════════════════════════════
function EvList({events,me,comms,onOpen,onCreateEv}){
  const [sub,setSub]=useState("coming");
  const myIds=new Set(events.filter(ev=>ev.registrations?.some(r=>r.userId===me.id)).map(ev=>ev.id));
  // Coming = future AND not completed
  const coming=events.filter(ev=>isFut(ev.date)&&myIds.has(ev.id)&&ev.status!=="completed");
  const past=events.filter(ev=>isPst(ev.date)||ev.status==="completed").filter(ev=>myIds.has(ev.id));
  const others=events.filter(ev=>isFut(ev.date)&&!myIds.has(ev.id)&&ev.status!=="completed");
  const isAdm=comms.some(c=>c.members.some(m=>m.userId===me.id&&(m.role==="owner"||m.role==="admin")));
  function Row({ev}){return <div><div style={{fontSize:11,color:"var(--po-dim)",marginBottom:3}}>{ev.commName}</div><EvCard ev={ev} onClick={()=>onOpen(ev.communityId,ev.id)}/></div>;}
  return <><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={{fontSize:18,fontWeight:600,color:"var(--po-text)"}}>Events</div>{isAdm&&<Btn label="+ New" primary onClick={onCreateEv}/>}</div>
    <Tabs tabs={[[`coming`,`Coming (${coming.length})`],[`past`,`Past & Closed (${past.length})`]]} active={sub} onChange={setSub}/>
    {sub==="coming"&&<>{coming.length===0?<Card><div style={{textAlign:"center",padding:"24px 0",color:"var(--po-dim)",fontSize:13}}><div style={{fontSize:28,marginBottom:8}}>📅</div>No upcoming events.</div></Card>:coming.map(ev=><Row key={ev.id} ev={ev}/>)}{others.length>0&&<><ST>Other Upcoming</ST>{others.map(ev=><Row key={ev.id} ev={ev}/>)}</>}</>}
    {sub==="past"&&(past.length===0?<Card><div style={{textAlign:"center",padding:"24px 0",color:"var(--po-dim)",fontSize:13}}>No past events yet.</div></Card>:past.map(ev=><Row key={ev.id} ev={ev}/>))}
  </>;
}

// ══════════════════════════════════════════════════════
//  PROFILE & SETTINGS
// ══════════════════════════════════════════════════════
function ProfileSc({user,comms,onBack}){
  const lv=usrLv(user.usr),mine=comms.filter(c=>c.members.some(m=>m.userId===user.id)),ec=mine.reduce((s,c)=>s+c.events.filter(e=>e.registrations.some(r=>r.userId===user.id)).length,0);
  return <><BBtn onBack={onBack} label="Back"/><Card><div style={{display:"flex",gap:14,alignItems:"center",marginBottom:16}}><Av u={user} size={56}/><div><div style={{fontWeight:700,fontSize:18,color:"var(--po-text)"}}>{user.nickname}</div><div style={{fontSize:13,color:"var(--po-dim)"}}>{user.name}</div><div style={{fontSize:12,color:"var(--po-dim)"}}>📍 {user.area} · {user.gov}</div></div></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8}}>{[["USR",user.usr],["Level",<span style={{color:lv.c,fontWeight:700}}>{lv.l}</span>],["Communities",mine.length],["Events",ec]].map(([l,v])=><div key={l} className="po-inp" style={{background:"var(--po-inp)",borderRadius:8,padding:"8px 4px",textAlign:"center"}}><div style={{fontSize:15,fontWeight:700,color:"var(--po-text)"}}>{v}</div><div style={{fontSize:10,color:"var(--po-dim)",marginTop:1}}>{l}</div></div>)}</div></Card><ST>My Communities</ST>{mine.map(c=>{const m=c.members.find(m=>m.userId===user.id);return <Card key={c.id}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{fontSize:20}}>🏸</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:13,color:"var(--po-text)"}}>{c.name}</div><div style={{fontSize:11,color:"var(--po-dim)"}}>{c.area}</div></div>{rBdg(m.role)}{sBdg(m.status)}</div></Card>;})}</>;
}
function SettingsSc({user,users,dark,onToggleDark,onAddUser,onExport,onBack}){
  const [showAddUser,setShowAddUser] = useState(false);
  const [nf,setNf] = useState({nickname:"",name:"",gov:"القاهرة",area:"المعادي",usr:"50"});
  const set=(k,v)=>setNf(p=>({...p,[k]:v}));
  return <><BBtn onBack={onBack} label="Back"/>
    <div className="po-text" style={{fontSize:18,fontWeight:600,color:"var(--po-text)",marginBottom:16}}>Settings</div>
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
    <ST>👥 Platform Users ({users?.length||0})</ST>
    <Card>
      {/* Existing users list */}
      <div style={{maxHeight:200,overflowY:"auto",marginBottom:10}}>
        {(users||[]).map(u=><div key={u.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"0.5px solid var(--po-bdr)"}}>
          <Av u={u} size={28}/>
          <div style={{flex:1}}>
            <span style={{fontSize:12,fontWeight:600,color:"var(--po-text)"}}>{u.nickname}</span>
            {u.isGuest&&<span style={{fontSize:10,color:"#F59E0B",marginLeft:4}}>GUEST</span>}
          </div>
          <span style={{fontSize:12,fontWeight:700,color:"#6366F1"}}>USR {u.usr}</span>
          <span style={{fontSize:10,color:"var(--po-dim)"}}>{u.area}</span>
        </div>)}
      </div>

      {/* Add new user */}
      <SmBtn label={showAddUser?"▲ Cancel":"+ Add New Player"} onClick={()=>setShowAddUser(o=>!o)} color="#6366F1" style={{width:"100%",marginBottom:showAddUser?10:0}}/>
      {showAddUser&&<div style={{marginTop:8}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div>
            <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:3}}>Nickname *</div>
            <input className="po-inp" value={nf.nickname} onChange={e=>set("nickname",e.target.value)} placeholder="e.g. Amka" style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",fontSize:13}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:"var(--po-dim)",marginBottom:3}}>Full Name</div>
            <input className="po-inp" value={nf.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. Ahmed" style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid var(--po-bdr)",background:"var(--po-inp)",color:"var(--po-text)",fontSize:13}}/>
          </div>
        </div>
        <div style={{marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
            <span style={{fontSize:11,color:"var(--po-dim)"}}>Initial USR</span>
            <span style={{fontSize:13,fontWeight:700,color:"#6366F1"}}>{nf.usr}</span>
          </div>
          <input type="range" min="0" max="100" value={nf.usr} onChange={e=>set("usr",e.target.value)} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"var(--po-dim)"}}>
            <span>E (0)</span><span>D (35)</span><span>C (50)</span><span>B (65)</span><span>A (80)</span>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          <Drp label="المحافظة" value={nf.gov} onChange={v=>set("gov",v)} options={Object.keys(EGYPT).map(g=>({v:g,l:g}))}/>
          <Drp label="المنطقة" value={nf.area} onChange={v=>set("area",v)} options={(EGYPT[nf.gov]||[]).map(a=>({v:a,l:a}))}/>
        </div>
        <Btn label="✓ Add Player to Platform" primary
          onClick={()=>{if(nf.nickname){onAddUser({nickname:nf.nickname,name:nf.name||nf.nickname,gov:nf.gov,area:nf.area,usr:parseInt(nf.usr)||50});setNf({nickname:"",name:"",gov:"القاهرة",area:"المعادي",usr:"50"});setShowAddUser(false);}}}
          style={{width:"100%"}}/>
      </div>}
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
      <div onClick={onExport} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",cursor:"pointer"}}>
        <span style={{fontSize:18}}>💾</span>
        <span style={{flex:1,fontSize:14,color:"var(--po-text)"}}>Export My Data</span>
        <span style={{fontSize:12,color:"var(--po-dim)"}}>Download backup JSON</span>
        <span style={{color:"var(--po-dim)"}}>›</span>
      </div>
    </Card>
    <div style={{textAlign:"center",marginTop:24,fontSize:12,color:"var(--po-bdr)"}}>PadelOS v10</div>
  </>;
}
