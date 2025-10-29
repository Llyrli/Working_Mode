// popup.js — compact manual-change UI + timezone-aware export + instant reclassify

let ui = {};
let base = { range: "1d", totalsFine: {}, categoriesMeta: [], topDomainPairs: [], todayStats: null, timeline: [], timeZone: "UTC" };
let live = { category: "other", umbrella: "other", lastSwitchTs: Date.now(), currentDomain: "unknown", restAlarmEnabled: true, pairsCollapsed: false };
let categoryColors = {};

/* ---------- utils ---------- */
const $ = (id) => document.getElementById(id);
function cacheElements(){
  ui = {
    recheck: $("recheck"), current: $("current"), pie: $("pie"), pieTitle: $("pieTitle"),
    legendBody: $("legendBody"), pairsToggle: $("pairsToggle"), pairsCaret: $("pairsCaret"),
    domainList: $("domainList"), domainTbody: $("domainTbody"), exportBtn: $("export"),
    restToggle: $("restToggle"), pageTimerWrap: $("pageTimerWrap"), pageTimer: $("pageTimer"),
    manualCat: $("manualCat"), toggleManual: $("toggleManual"), caret: $("caret"),
  };
}
function postMessage(type, payload={}){ return new Promise(res=> chrome.runtime.sendMessage({ type, ...payload }, r=> { void chrome.runtime.lastError; res(r||{ok:false}); })); }
function fmtHMS(sec){ sec=Math.max(0,Math.floor(sec)); const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; return h>0?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
function hashColor(cat){ let h=0; for(const ch of String(cat)) h=(h*31+ch.charCodeAt(0))>>>0; return `hsl(${h%360} 55% 55%)`; }
function colorFor(cat){ return categoryColors?.[cat] || FIXED[cat] || hashColor(cat); }
const FIXED={ work:"#1f8f3e", study:"#2b6cb0", utility:"#b08b2b", social:"#cc7a00", entertainment:"#c53030", other:"#718096" };
function hexFromCss(c){ if(c.startsWith("#"))return c; const ctx=document.createElement("canvas").getContext("2d"); ctx.fillStyle=c; const rgb=ctx.fillStyle; const m=rgb.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/i); if(!m)return"#777777"; const r=(+m[1]).toString(16).padStart(2,"0"), g=(+m[2]).toString(16).padStart(2,"0"), b=(+m[3]).toString(16).padStart(2,"0"); return `#${r}${g}${b}`; }
function softPair(colorHexOrHsl, aBg=0.22, aBar=0.45){ const c=hexFromCss(colorHexOrHsl); const n=parseInt(c.slice(1),16); const r=(n>>16)&255,g=(n>>8)&255,b=n&255; return { bg:`rgba(${r},${g},${b},${aBg})`, bar:`rgba(${r},${g},${b},${aBar})` }; }
function escapeHtml(s){ return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeTSV(s){ return String(s).replace(/\\t/g,"  ").replace(/\\r?\\n/g,"  "); }
function fmtLocal(ts, tz){
  try{
    const d = new Date(ts||Date.now());
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz||'UTC',
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit',
      hour12:false
    }).formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }catch{ return new Date(ts||Date.now()).toISOString(); }
}

/* ---------- lifecycle ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();

  // Reclassify instantly when popup opens (so you "open and see final result")
  await postMessage("RECLASSIFY_NOW");

  ui.recheck && (ui.recheck.onclick = async ()=>{ await postMessage("RECLASSIFY_NOW"); await refreshHead(); });

  // Collapse/expand manual select
  if (ui.toggleManual && ui.manualCat && ui.caret) {
    ui.toggleManual.onclick = () => {
      const open = ui.manualCat.style.display !== "none";
      ui.manualCat.style.display = open ? "none" : "inline-block";
      ui.caret.textContent = open ? "▾" : "▴";
    };
    ui.manualCat.onchange = async () => {
      const val = ui.manualCat.value;
      if (!val) return;
      const r = await postMessage("SET_MANUAL_CATEGORY", { category: val });
      if (r?.ok) {
        ui.manualCat.style.display = "none";
        ui.caret.textContent = "▾";
        await refreshHead();
      }
    };
  }

  ui.pairsToggle && (ui.pairsToggle.onclick = ()=>{ live.pairsCollapsed=!live.pairsCollapsed; ui.pairsCaret&&(ui.pairsCaret.textContent=live.pairsCollapsed?"▸":"▾"); ui.domainList&&(ui.domainList.style.display=live.pairsCollapsed?"none":"block"); });
  ui.exportBtn && (ui.exportBtn.onclick = exportTxt);
  ui.restToggle && (ui.restToggle.onclick = async ()=>{ const to=!live.restAlarmEnabled; await postMessage("SET_REST_ALARM",{value:to}); live.restAlarmEnabled=to; renderRestToggle(); });

  chrome.runtime.onMessage.addListener((msg)=>{ if (msg?.type==="CATEGORY_UPDATED") refreshHead(); });

  await refreshAllBase();
  startLiveTick();
});

/* ---------- base ---------- */
async function refreshAllBase(){
  const prefs = await postMessage("GET_UI_PREFS");
  if (prefs?.ok) {
    base.range = prefs.prefs?.pieRange || "1d";
    live.pairsCollapsed = !!prefs.prefs?.pairsCollapsed;
    categoryColors = prefs.prefs?.categoryColors || {};
    base.timeZone = prefs.prefs?.timeZone || "UTC";
    ui.pairsCaret && (ui.pairsCaret.textContent = live.pairsCollapsed ? "▸" : "▾");
    ui.domainList && (ui.domainList.style.display = live.pairsCollapsed ? "none" : "block");
  }
  const r = await postMessage("GET_REST_ALARM");
  live.restAlarmEnabled = !!r?.enabled;
  renderRestToggle();
  ui.pieTitle && (ui.pieTitle.textContent = rangeLabel(base.range) + " Pie");

  await refreshHead();
  await refreshRangeData();
  populateManualSelect();
  drawAll();
}
async function refreshHead(){
  const st = await postMessage("GET_TODAY_STATS");
  if (!st?.ok) return;
  base.todayStats = st.data || null;
  live.category = st.category || "other";
  live.umbrella = st.umbrella || "other";
  live.lastSwitchTs = st.lastSwitchTs || Date.now();
  live.currentDomain = st.currentDomain || "unknown";

  if (ui.current) {
    const col = colorFor(live.category);
    const soft = softPair(col);
    ui.current.textContent = live.category;
    ui.current.style.background = soft.bg;
    ui.current.style.color = "#0f172a";
    ui.current.style.border = "1px solid rgba(0,0,0,0.08)";
    ui.current.style.boxShadow = `inset 0 -4px 0 0 ${soft.bar}`;
  }
  const showTimer = (live.restAlarmEnabled && live.umbrella === "rest");
  ui.pageTimerWrap && (ui.pageTimerWrap.style.display = showTimer ? "block" : "none");
}
function renderRestToggle(){
  ui.restToggle && (ui.restToggle.textContent = live.restAlarmEnabled ? "Disable" : "Enable");
  const showTimer = (live.restAlarmEnabled && live.umbrella === "rest");
  ui.pageTimerWrap && (ui.pageTimerWrap.style.display = showTimer ? "block" : "none");
}
async function refreshRangeData(){
  const r1 = await postMessage("GET_STATS_RANGE_FINE", { range: base.range });
  base.totalsFine = r1?.ok ? (r1.totalsFine || {}) : {};
  base.categoriesMeta = r1?.ok ? (r1.categoriesMeta || []) : [];

  const r2 = await postMessage("GET_TOP_DOMAIN_PAIRS_RANGE", { range: base.range, limit: 50 });
  base.topDomainPairs = r2?.ok ? (r2.topDomainPairs || []) : [];

  const r3 = await postMessage("GET_TIMELINE_RANGE", { range: base.range });
  base.timeline = r3?.ok ? (r3.segs || []) : [];
}
function populateManualSelect(){
  if (!ui.manualCat) return;
  const list = (base.categoriesMeta || []).map(x=>x.name);
  ui.manualCat.innerHTML = list.map(n=>`<option value="${escapeHtml(n)}"${n===live.category?" selected":""}>${escapeHtml(n)}</option>`).join("");
}

function rangeLabel(range){
  switch (range) {
    case "1h":  return "1 hour";
    case "1d":  return "1 day";
    case "1mo": return "1 month";
    case "1y":  return "1 year";
    default:    return range; // fallback
  }
}

/* ---------- tick ---------- */
let tickTimer=null;
function startLiveTick(){
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(async ()=>{ await refreshHead(); drawAll(true); }, 1000);
}
function totalsFineAugmented(){ const out={...base.totalsFine}; const extra=Math.max(0,Math.floor((Date.now()-live.lastSwitchTs)/1000)); out[live.category]=(Number(out[live.category])||0)+extra; return out; }
function topPairsAugmented(){
  const arr=(base.topDomainPairs||[]).map(x=>({...x}));
  const extra=Math.max(0,Math.floor((Date.now()-live.lastSwitchTs)/1000));
  if (live.currentDomain){
    const i=arr.findIndex(x=>x.domain===live.currentDomain && x.fine===live.category);
    if (i>=0) arr[i].seconds=Number(arr[i].seconds||0)+extra;
    else arr.unshift({ domain:live.currentDomain, fine:live.category, umbrella:live.umbrella, seconds:extra });
  }
  arr.sort((a,b)=>(b.seconds||0)-(a.seconds||0));
  return arr;
}

/* ---------- draw ---------- */
function drawAll(){
  if (ui.pageTimerWrap && ui.pageTimerWrap.style.display!=="none" && ui.pageTimer){
    const sec=(Date.now()-live.lastSwitchTs)/1000; ui.pageTimer.textContent = fmtHMS(sec);
  }
  drawPie(totalsFineAugmented());
  renderLegendMerged(totalsFineAugmented());
  renderTopDomains(topPairsAugmented());
}
function drawPie(totalsFine){
  if (!ui.pie) return;
  const ctx = ui.pie.getContext("2d");
  ctx.clearRect(0,0,ui.pie.width, ui.pie.height);
  const entries=Object.entries(totalsFine);
  const total=entries.reduce((s,[,v])=>s+(+v||0),0)||1;
  let start=-Math.PI/2;
  entries.forEach(([k,v])=>{
    const val=+v||0; const angle=(val/total)*Math.PI*2;
    ctx.beginPath(); ctx.moveTo(80,80); ctx.arc(80,80,80,start,start+angle); ctx.closePath();
    ctx.fillStyle=colorFor(k); ctx.fill(); start+=angle;
  });
}
function renderLegendMerged(totalsFine){
  if (!ui.legendBody) return;
  const meta=base.categoriesMeta||[];
  const byUmb={}; for(const m of meta){ const name=m.name, umb=m.umbrella||"other"; const sec=Number(totalsFine[name]||0); (byUmb[umb]||(byUmb[umb]=[])).push({ name, sec }); }
  Object.keys(byUmb).forEach(k=> byUmb[k].sort((a,b)=>b.sec-a.sec));
  const totalSec = Object.values(totalsFine).reduce((s,x)=>s+Number(x||0),0)||1;
  const order=["work","rest","other"];
  const rows=[];
  for (const umb of order){
    const list=byUmb[umb]||[];
    const len=Math.max(1,list.length);
    if (!list.length){
      rows.push({ umbCell:{text:umb,rowspan:1}, catCell:"—", timeCell:`<div class="timepct"><span>—</span><span class="sep">|</span><span>—</span></div>` });
      continue;
    }
    list.forEach((r,i)=>{
      const pct=((r.sec/totalSec)*100).toFixed(1)+"%";
      const col=colorFor(r.name); const soft=softPair(col);
      rows.push({
        umbCell: i===0?{text:umb,rowspan:len}:null,
        catCell:`<span class="cat-chip" style="background:${soft.bg};"><span>${escapeHtml(r.name)}</span><span class="bar" style="background:${soft.bar};"></span></span>`,
        timeCell:`<div class="timepct"><span>${fmtHMS(r.sec)}</span><span class="sep">|</span><span>${pct}</span></div>`
      });
    });
  }
  ui.legendBody.innerHTML="";
  for (const r of rows){
    const tr=document.createElement("tr");
    if (r.umbCell){ const td=document.createElement("td"); td.className="umbrella-cell"; td.rowSpan=r.umbCell.rowspan; td.innerHTML=`<span class="pill" style="background:rgba(0,0,0,.08);">${r.umbCell.text}</span>`; tr.appendChild(td); }
    const tdCat=document.createElement("td"); tdCat.innerHTML=r.catCell;
    const tdT=document.createElement("td"); tdT.innerHTML=r.timeCell;
    tr.appendChild(tdCat); tr.appendChild(tdT); ui.legendBody.appendChild(tr);
  }
}
function renderTopDomains(arr){
  if (!ui.domainTbody) return;
  ui.domainTbody.innerHTML = arr.slice(0,5).map(it=>`<tr><td>${escapeHtml(it.domain)}</td><td>${escapeHtml(it.fine)}</td><td>${fmtHMS(Number(it.seconds||0))}</td></tr>`).join("");
}

/* ---------- export (timezone-aware) ---------- */
async function exportTxt(){
  const totals = await getAllDomainTotalsBase();
  const lines = [];
  lines.push(`[DomainsTotal]`);
  lines.push(`domain\tcategory\tumbrella\tseconds\thuman`);
  totals.forEach(r=> lines.push(`${r.domain}\t${r.category}\t${r.umbrella}\t${r.seconds}\t${r.human}`));
  lines.push("");
  lines.push(`[Timeline_${base.range}]`);
  lines.push(`timestamp_local(${base.timeZone})\tdomain\tcategory\tumbrella\tseconds`);
  (base.timeline||[]).forEach(t=>{
    const tsLocal = fmtLocal(t.ts||Date.now(), base.timeZone);
    lines.push(`${tsLocal}\t${escapeTSV(t.domain||"")}\t${escapeTSV(t.category||"other")}\t${escapeTSV(t.umbrella||"other")}\t${Number(t.seconds||0)}`);
  });
  const blob = new Blob([new TextEncoder().encode(lines.join("\n"))], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `working_mode_${base.range}.txt`; a.click();
  setTimeout(()=> URL.revokeObjectURL(url), 1500);
}
async function getAllDomainTotalsBase(){
  const map=new Map();
  for (const s of (base.timeline||[])){ const key=s.domain; const cur=map.get(key)||{category:s.category,umbrella:s.umbrella,seconds:0}; cur.category=s.category; cur.umbrella=s.umbrella; cur.seconds+=Number(s.seconds||0); map.set(key,cur); }
  if (map.size===0 && base.range==="1d" && base.todayStats?.byDomain){ for (const [d,v] of Object.entries(base.todayStats.byDomain)){ map.set(d,{ category:v.category||"other", umbrella:v.umbrella||"other", seconds:Number(v.seconds||0)}); } }
  const arr=Array.from(map.entries()).map(([domain,v])=>({domain,category:v.category,umbrella:v.umbrella,seconds:Number(v.seconds||0),human:fmtHMS(Number(v.seconds||0))})).sort((a,b)=>b.seconds-a.seconds);
  return arr;
}
