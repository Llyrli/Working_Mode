// background.js — rest-alarm modal with snooze & disable + robust fallback
import { classifyPage } from "./classify.js";

/* ---------------- Defaults ---------------- */
const DEFAULT_SETTINGS = {
  enabled: true,
  intervalMinutes: 5,
  apiKey: "",
  model: "gemini-2.0-flash",
  categoriesConfig: [
    { name: "work",          umbrella: "work" },
    { name: "study",         umbrella: "work" },
    { name: "utility",       umbrella: "work" },
    { name: "social",        umbrella: "rest" },
    { name: "entertainment", Qumbrella: "rest" },
    { name: "other",         umbrella: "other" }
  ],
  timeZone: "America/Chicago",
  learnedRules: {},
  categoryColors: {},
  pieRange: "1d",
  showCategoryTable: true,
  pairsCollapsed: false,
  focusPolicy: { enabled: true, softAfterMin: 5, hardAfterMin: 15, cooldownMin: 10, dailyMax: 8 }
};

/* ---------------- Runtime ---------------- */
let state = { currentTabId: null, currentCategory: "other", lastSwitchTs: Date.now(), lastAccrualTs: Date.now(), currentDomain: "unknown" };
let remindState = { lastDayKey: null, lastReminderTs: 0, reminderCountToday: 0, muteUntilTs: 0 };

const CACHE_TTL_MS = 10 * 60 * 1000;
let domainCache = Object.create(null);

/* ---------------- Storage helpers ---------------- */
function migrateConfig(cfg) { if (!Array.isArray(cfg.categoriesConfig)) cfg.categoriesConfig = DEFAULT_SETTINGS.categoriesConfig.slice(); if (!cfg.categoryColors || typeof cfg.categoryColors !== "object") cfg.categoryColors = {}; return cfg; }
function getSettings() { return new Promise((res)=> chrome.storage.sync.get(DEFAULT_SETTINGS, (cfg)=> { cfg = migrateConfig({ ...DEFAULT_SETTINGS, ...cfg }); cfg.categories = (cfg.categoriesConfig || []).map(c => c.name); res(cfg); })); }
function storageGet(key) { return new Promise((res)=> chrome.storage.local.get([key], (o)=> res(o[key]))); }
function storageSet(key, v) { return new Promise((res)=> chrome.storage.local.set({ [key]: v }, res)); }

/* ---------------- Time helpers ---------------- */
function normalizeTimeZone(tz) { const s = tz || "UTC"; try { new Intl.DateTimeFormat("en-CA", { timeZone: s }).format(new Date()); return s; } catch { return "UTC"; } }
function dayKeyLocal(tzRaw, dateObj=new Date()){ const tz=normalizeTimeZone(tzRaw); const parts=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(dateObj).reduce((a,p)=>(a[p.type]=p.value,a),{}); return `${parts.year}-${parts.month}-${parts.day}`; }
function extractDomain(url) { try { return new URL(url).hostname; } catch { return "unknown"; } }
function mapToUmbrella(fine, settings){ const s=String(fine||"").toLowerCase(); const hit=(settings.categoriesConfig||[]).find(c=>(c.name||"").toLowerCase()===s); return hit ? (hit.umbrella||"other") : "other"; }

/* ---------------- Accounting ---------------- */
async function settleTime() {
  try {
    const now = Date.now();
    const deltaSec = Math.max(0, Math.round((now - (state.lastAccrualTs || now)) / 1000));
    state.lastAccrualTs = now;
    if (deltaSec === 0) return;

    const settings = await getSettings();
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = tab?.url || "unknown://";
    const domain = extractDomain(url);
    state.currentDomain = domain;

    const dayKey = dayKeyLocal(settings.timeZone);
    const key = `stats:${dayKey}`;
    const cur = (await storageGet(key)) || { totalsUmbrella:{}, totalsFine:{}, byDomain:{} };

    const fine = state.currentCategory || "other";
    const umb = mapToUmbrella(fine, settings);

    cur.totalsUmbrella[umb] = (Number(cur.totalsUmbrella[umb]) || 0) + deltaSec;
    cur.totalsFine[fine]    = (Number(cur.totalsFine[fine]) || 0) + deltaSec;

    cur.byDomain[domain] = cur.byDomain[domain] || { category: fine, umbrella: umb, seconds: 0 };
    cur.byDomain[domain].category = fine;
    cur.byDomain[domain].umbrella = umb;
    cur.byDomain[domain].seconds  = (Number(cur.byDomain[domain].seconds) || 0) + deltaSec;
    await storageSet(key, cur);

    const segKey = `segments:${dayKey}`;
    const segs = (await storageGet(segKey)) || [];
    segs.push({ ts: now, domain, category: fine, umbrella: umb, seconds: deltaSec });
    await storageSet(segKey, segs);

    const dayIndexKey = "segments:days";
    const dayList = (await storageGet(dayIndexKey)) || [];
    if (!dayList.includes(dayKey)) dayList.push(dayKey);
    while (dayList.length > 400) dayList.shift();
    await storageSet(dayIndexKey, dayList);
  } catch (e) { console.error("[Working Mode] settleTime error:", e); }
}

/* ---------------- Classification ---------------- */
function pickCustomCategoryIfMatch({ url, title }, settings) {
  try {
    const text = `${url} ${extractDomain(url)} ${title}`.toLowerCase();
    const names = (settings.categoriesConfig || []).map(c => c.name).sort((a,b)=> b.length - a.length);
    for (const name of names) {
      const n = String(name||"").toLowerCase().replace(/[_-]+/g, " ");
      const tokens = n.split(/\s+/).filter(Boolean);
      const allHit = tokens.every(t => text.includes(t));
      if (allHit || text.includes(n)) return name;
    }
  } catch {}
  return null;
}
async function applyCategory(newFine, meta = {}) {
  try {
    const prevFine = state.currentCategory;
    if (newFine !== prevFine) {
      await settleTime();
      state.currentCategory = newFine;
      state.lastSwitchTs = Date.now();
      state.lastAccrualTs = Date.now();
    }
    chrome.runtime.sendMessage({ type: "CATEGORY_UPDATED", payload: { category: state.currentCategory, cached: !!meta.cached, reason: meta.reason || "" } }, () => { void chrome.runtime.lastError; });
  } catch (e) { console.error("[Working Mode] applyCategory error:", e); }
}
async function reclassifyActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) return;

    const domain = extractDomain(tab.url);
    if (state.currentDomain && domain && domain !== state.currentDomain) {
      await settleTime();
      state.lastAccrualTs = Date.now();
    }
    state.currentDomain = domain;

    const settings = await getSettings();
    const hit = domainCache[domain];
    if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) {
      await applyCategory(hit.category, { cached: true, reason: "cache" });
      return;
    }

    let fine = pickCustomCategoryIfMatch({ url: tab.url, title: tab.title || "" }, settings);
    if (!fine) {
      const result = await classifyPage({ url: tab.url, title: tab.title || "" }, settings);
      fine = String(result?.category || "other");
      const validNames = new Set((settings.categoriesConfig || []).map(c => c.name.toLowerCase()));
      if (!validNames.has(fine.toLowerCase())) {
        if (validNames.has("entertainment") && /youtube|netflix|bilibili|twitch|iqiyi|youku/i.test(tab.url)) fine = "entertainment";
        else if (validNames.has("social") && /(twitter|x\.com|weibo|reddit|facebook|instagram|tiktok)/i.test(tab.url)) fine = "social";
        else if (validNames.has("work") && /(docs\.google|drive\.google|notion|confluence|jira|github|gitlab|figma|slack|linear)/i.test(tab.url)) fine = "work";
        else if (validNames.has("study") && /(wikipedia|arxiv|khanacademy|coursera|udemy|edx|brilliant)/i.test(tab.url)) fine = "study";
        else if (validNames.has("utility") && /(mail\.google|outlook\.live|calendar\.google|maps\.google|bank|alipay|paypal|wise\.com)/i.test(tab.url)) fine = "utility";
        else fine = "other";
      }
    }
    domainCache[domain] = { category: fine, ts: Date.now() };
    await applyCategory(fine, { cached: false, reason: "auto" });
  } catch (e) { console.error("[Working Mode] reclassifyActiveTab error:", e); }
}

/* ---------------- Rest-alarm modal (renamed to avoid duplicate identifiers) ---------------- */
async function presentRestModal(payload) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "SHOW_REST_MODAL", payload }, async () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // Fallback: system notification (ensures visibility)
        const minutes = Math.floor((payload?.minutesOnRest ?? 0));
        const threshold = payload?.thresholdMinutes ?? 5;
        const iconUrl = chrome.runtime.getURL("icons/icon-128.png");
        try {
          await chrome.notifications.create({
            type: "basic",
            iconUrl,
            title: "Rest Alarm",
            message: `You have been on the rest page for ${minutes} minutes (threshold: ${threshold} minutes).`
          });
        } catch {}
      }
    });
  } catch (e) { console.warn("[Working Mode] presentRestModal error:", e); }
}
async function handleRestModalAction(action) {
  const now = Date.now();
  if (action === "closeOnce") {
    remindState.lastReminderTs = now;
  } else if (action === "snooze30") {
    remindState.muteUntilTs = now + 30 * 60 * 1000;
    remindState.lastReminderTs = now;
  } else if (action === "disable") {
    const s = await getSettings();
    const fp = { ...(s.focusPolicy || {}), enabled: false };
    await new Promise(r => chrome.storage.sync.set({ focusPolicy: fp }, r));
    await startAlarms();
  }
}

/* ---------------- Reminder Policy ---------------- */
async function maybeCheckFocusReminder(settings) {
  try {
    const fp = settings.focusPolicy || {};
    if (!fp.enabled) return;

    const dk = dayKeyLocal(settings.timeZone);
    if (remindState.lastDayKey !== dk) {
      remindState = { lastDayKey: dk, lastReminderTs: 0, reminderCountToday: 0, muteUntilTs: 0 };
    }
    if (remindState.reminderCountToday >= (fp.dailyMax ?? 8)) return;

    // Only within "rest"
    const umb = mapToUmbrella(state.currentCategory, settings);
    if (umb !== "rest") return;

    const now = Date.now();
    if (remindState.muteUntilTs && now < remindState.muteUntilTs) return;

    const sinceSwitchSec = Math.max(0, Math.round((now - (state.lastSwitchTs || now)) / 1000));
    const userMin = Number(settings.intervalMinutes) || 5;
    const thresholdSec = Math.max(30, Math.round(userMin * 60)); // define BEFORE usage
    const cooldownSec  = thresholdSec;                            // define BEFORE usage

    if ((now - remindState.lastReminderTs) < cooldownSec * 1000) return;

    if (sinceSwitchSec >= thresholdSec) {
      await presentRestModal({ minutesOnRest: Math.floor(sinceSwitchSec / 60), thresholdMinutes: userMin });
      remindState.lastReminderTs = now;
      remindState.reminderCountToday += 1;
    }
  } catch (e) { console.error("[Working Mode] focus reminder error:", e); }
}

/* ---------------- Alarms & lifecycle ---------------- */
async function startAlarms() {
  try {
    const settings = await getSettings();
    await chrome.alarms.clear("working-mode-tick");
    const p = Math.max(1, Number(settings.intervalMinutes) || 5);
    chrome.alarms.create("working-mode-tick", { periodInMinutes: p });
    console.log("[Working Mode] alarm started, period(min) =", p);
  } catch (e) { console.error("[Working Mode] startAlarms error:", e); }
}
function stopAlarms(){ chrome.alarms.clear("working-mode-tick", ()=>{}); }

chrome.alarms.onAlarm.addListener((alarm) => { (async () => {
  try {
    if (alarm?.name !== "working-mode-tick") return;
    const settings = await getSettings();
    if (!settings.enabled) return;
    await settleTime();
    await maybeCheckFocusReminder(settings);
  } catch (e) { console.error("[Working Mode] onAlarm error:", e); }
})(); });

/* ---------------- Auto classify hooks ---------------- */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { if (changeInfo.status === "complete" && tab.active) reclassifyActiveTab(); });
chrome.tabs.onActivated.addListener(() => { reclassifyActiveTab(); });
chrome.windows.onFocusChanged.addListener((winId) => { if (winId !== chrome.windows.WINDOW_ID_NONE) reclassifyActiveTab(); });

/* ---------------- Messages & init ---------------- */
chrome.runtime.onInstalled.addListener(async () => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, async (cfg) => {
    cfg = migrateConfig({ ...DEFAULT_SETTINGS, ...cfg });
    chrome.storage.sync.set(cfg, async () => {
      await reclassifyActiveTab();
      await startAlarms();
      console.log("[Working Mode] settings initialized.");
    });
  });
});
chrome.runtime.onStartup.addListener(async ()=> { await reclassifyActiveTab(); await startAlarms(); });
chrome.storage.onChanged.addListener((changes, area) => {
  try {
    if (area === "sync" && (changes.enabled || changes.intervalMinutes || changes.focusPolicy)) {
      const enabled = changes.enabled?.newValue ?? (changes.focusPolicy?.newValue?.enabled);
      if (enabled === false) stopAlarms(); else startAlarms();
    }
    if (area === "sync" && changes.categoriesConfig) domainCache = Object.create(null);
  } catch (e) { console.error("[Working Mode] storage.onChanged error:", e); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_TODAY_STATS") {
        const settings = await getSettings();
        const key = `stats:${dayKeyLocal(settings.timeZone)}`;
        const data = (await storageGet(key)) || { totalsUmbrella:{}, totalsFine:{}, byDomain:{} };
        const umb = mapToUmbrella(state.currentCategory, settings);
        sendResponse({ ok:true, data, category: state.currentCategory, umbrella: umb, lastSwitchTs: state.lastSwitchTs, currentDomain: state.currentDomain });
      }
      else if (msg?.type === "GET_STATS_RANGE_FINE") {
        const settings = await getSettings();
        const range = (msg.range || settings.pieRange || "1d");
        const totals = {};
        const segs = await (async function getTimelineRange(r){
          const days = r==="1h"?1: r==="1d"?1: r==="1mo"?30: r==="1y"?365:7;
          const now = Date.now();
          let out=[]; 
          for (let i=0;i<days;i++){
            const dt = new Date(now - i*86400*1000);
            const dk = dayKeyLocal(settings.timeZone, dt);
            const seg = (await storageGet(`segments:${dk}`)) || [];
            out.push(...seg);
          }
          if (r==="1h"){ const cutoff = now - 3600*1000; out = out.filter(s=> (s?.ts||0) >= cutoff); }
          return out.sort((a,b)=> (a.ts||0)-(b.ts||0));
        })(range);

        for (const s of segs) totals[s.category] = (totals[s.category]||0) + Number(s.seconds||0);

        const retTotals = {};
        const categoriesMeta = [];
        for (const c of (settings.categoriesConfig || [])) {
          const name = c.name;
          retTotals[name] = Number(totals?.[name] || 0);
          categoriesMeta.push({ name, umbrella: c.umbrella || "other" });
        }
        sendResponse({ ok:true, totalsFine: retTotals, range, categoriesMeta });
      }
      else if (msg?.type === "GET_TOP_DOMAIN_PAIRS_RANGE") {
        const settings = await getSettings();
        const range = (msg.range || settings.pieRange || "1d");
        const limit = Math.max(1, Math.min(50, Number(msg.limit || 10)));
        const segs = (await (async function(r){
          const days = r==="1h"?1: r==="1d"?1: r==="1mo"?30: r==="1y"?365:7;
          const now = Date.now(); let out=[];
          for (let i=0;i<days;i++){
            const dt = new Date(now - i*86400*1000);
            const dk = dayKeyLocal(settings.timeZone, dt);
            const seg = (await storageGet(`segments:${dk}`)) || [];
            out.push(...seg);
          }
          if (r==="1h"){ const cutoff = now - 3600*1000; out = out.filter(s=> (s?.ts||0) >= cutoff); }
          return out.sort((a,b)=> (a.ts||0)-(b.ts||0));
        })(range));

        const map = new Map();
        for (const s of segs) {
          const key = `${s.domain}|${s.category}`;
          map.set(key, (map.get(key) || 0) + Number(s.seconds || 0));
        }
        const arr = Array.from(map.entries()).map(([k, seconds])=>{
          const [domain, fine] = k.split("|");
          return { domain, fine, umbrella: mapToUmbrella(fine, settings), seconds };
        }).sort((a,b)=> (b.seconds||0)-(a.seconds||0)).slice(0, limit);
        sendResponse({ ok:true, topDomainPairs: arr, range });
      }
      else if (msg?.type === "RECLASSIFY_NOW") {
        await reclassifyActiveTab();
        sendResponse({ ok:true, category: state.currentCategory });
      }
      else if (msg?.type === "GET_UI_PREFS") {
        const s = await getSettings();
        sendResponse({ ok:true, prefs: {
          pieRange: s.pieRange || "1d",
          showCategoryTable: s.showCategoryTable !== false,
          pairsCollapsed: !!s.pairsCollapsed,
          categoryColors: s.categoryColors || {},
          timeZone: s.timeZone || "UTC"
        }});
      }
      else if (msg?.type === "SET_UI_PREFS") {
        const prefs = msg.prefs || {};
        chrome.storage.sync.get(DEFAULT_SETTINGS, (cfg) => {
          cfg = migrateConfig({ ...DEFAULT_SETTINGS, ...cfg });
          chrome.storage.sync.set({ ...cfg, ...prefs }, () => sendResponse({ ok:true }));
        });
      }
      else if (msg?.type === "GET_REST_ALARM") {
        const s = await getSettings();
        sendResponse({ ok:true, enabled: !!(s.focusPolicy?.enabled) });
      }
      else if (msg?.type === "SET_REST_ALARM") {
        const s = await getSettings();
        const fp = { ...(s.focusPolicy || {}), enabled: !!msg.value };
        await new Promise(r => chrome.storage.sync.set({ focusPolicy: fp }, r));
        await startAlarms();
        sendResponse({ ok:true });
      }
      else if (msg?.type === "GET_TIMELINE_RANGE") {
        const s = await getSettings();
        const range = (msg.range || s.pieRange || "1d");
        const days = range==="1h"?1: range==="1d"?1: range==="1mo"?30: range==="1y"?365:7;
        const now = Date.now(); let out=[];
        for (let i=0;i<days;i++){
          const dt=new Date(now - i*86400*1000);
          const dk=dayKeyLocal(s.timeZone, dt);
          const seg=(await storageGet(`segments:${dk}`)) || [];
          out.push(...seg);
        }
        if (range==="1h"){ const cutoff = now - 3600*1000; out = out.filter(sg => (sg?.ts||0) >= cutoff); }
        sendResponse({ ok:true, segs: out.sort((a,b)=> (a.ts||0)-(b.ts||0)), range });
      }
      else if (msg?.type === "SET_MANUAL_CATEGORY" && msg.category) {
        const s = await getSettings();
        const valid = (s.categoriesConfig||[]).some(c => (c.name||"").toLowerCase() === String(msg.category).toLowerCase());
        if (valid) { await applyCategory(msg.category, { cached:false, reason:"manual" }); sendResponse({ ok:true }); }
        else sendResponse({ ok:false, error:"invalid category" });
      }
      else if (msg?.type === "SET_CATEGORY_COLOR" && msg.name && msg.color) {
        const s = await getSettings();
        const cc = { ...(s.categoryColors||{}) };
        cc[msg.name] = msg.color;
        await new Promise(r => chrome.storage.sync.set({ categoryColors: cc }, r));
        sendResponse({ ok:true });
      }
      else if (msg?.type === "CLEAR_ALL_DATA") {
        chrome.storage.local.get(null, async (all) => {
          const toRemove = Object.keys(all).filter(k => k.startsWith("stats:") || k.startsWith("segments:"));
          chrome.storage.local.remove(toRemove, async () => {
            state.lastAccrualTs = Date.now();
            sendResponse({ ok:true, cleared: toRemove.length });
          });
        });
      }
      else if (msg?.type === "REST_MODAL_ACTION" && msg.action) {
        await handleRestModalAction(msg.action);
        sendResponse({ ok:true });
      }
      else {
        sendResponse({ ok:false, error:"unknown message type" });
      }
    } catch (e) { console.error("[Working Mode] onMessage handler error:", e); sendResponse({ ok:false, error:String(e) }); }
  })();
  return true;
});
