// options.js — add working "clear data" with confirm + toast; keep existing features

const DEFAULTS = {
  apiKey: "",
  model: "gemini-2.0-flash",
  intervalMinutes: 5,
  timeZone: "America/Chicago",
  pieRange: "1d",
  categoriesConfig: [
    { name: "work", umbrella: "work" },
    { name: "study", umbrella: "work" },
    { name: "utility", umbrella: "work" },
    { name: "social", umbrella: "rest" },
    { name: "entertainment", umbrella: "rest" },
    { name: "other", umbrella: "other" }
  ],
  categoryColors: {}
};

const $ = (id) => document.getElementById(id);
function getSync(keys){ return new Promise(res => chrome.storage.sync.get(keys, (o)=> res(o))); }
function setSync(obj){ return new Promise(res => chrome.storage.sync.set(obj, res)); }
function postMessage(type, payload={}){ return new Promise(res=> chrome.runtime.sendMessage({ type, ...payload }, r=> { void chrome.runtime.lastError; res(r||{ok:false}); })); }

function ensureConfig(o){
  const cfg = { ...DEFAULTS, ...o };
  if (!Array.isArray(cfg.categoriesConfig)) cfg.categoriesConfig = DEFAULTS.categoriesConfig.slice();
  if (!cfg.categoryColors || typeof cfg.categoryColors !== "object") cfg.categoryColors = {};
  return cfg;
}

/* ------------ Color helpers (unchanged) ------------ */
function hexToHsl(hex) {
  try {
    const n = parseInt(hex.replace("#",""), 16);
    const r = ((n>>16)&255)/255, g=((n>>8)&255)/255, b=(n&255)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h, s, l = (max + min)/2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d/(2 - max - min) : d/(max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return { h, s, l };
  } catch { return { h: Math.random(), s: 0.6, l: 0.5 }; }
}
function hslToHex(h, s, l){
  function hue2rgb(p, q, t){
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1/3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1/3) * 255);
  return "#" + r.toString(16).padStart(2,"0") + g.toString(16).padStart(2,"0") + b.toString(16).padStart(2,"0");
}
function hueFromHex(hex){ return (hexToHsl(hex).h || 0) * 360; }
function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
function generateDistinctColor(existingHexList) {
  const existingHues = existingHexList
    .map(h => hueFromHex(h))
    .filter(h => Number.isFinite(h));
  if (existingHues.length === 0) {
    const h = Math.random() * 360;
    return hslToHex(h/360, 0.64, 0.52);
  }
  const GOLDEN_ANGLE = 137.508;
  const candidates = [];
  const seed = Math.random() * 360;
  for (let i = 0; i < 48; i++) {
    const h = (seed + i * GOLDEN_ANGLE) % 360;
    candidates.push((h + (Math.random()*10-5) + 360) % 360);
  }
  let bestH = candidates[0], bestScore = -1;
  for (const h of candidates) {
    const minD = existingHues.reduce((m, eh) => Math.min(m, hueDistance(h, eh)), 360);
    if (minD > bestScore) { bestScore = minD; bestH = h; }
  }
  const s = 0.60 + (Math.random()*0.15 - 0.075);
  const l = 0.48 + (Math.random()*0.12 - 0.06);
  return hslToHex(bestH/360, Math.max(0.4, Math.min(0.8, s)), Math.max(0.35, Math.min(0.65, l)));
}

/* -------------------- Time zone helpers -------------------- */
function getAllTimeZones() {
  if (Intl.supportedValuesOf) {
    try { return Intl.supportedValuesOf("timeZone"); } catch {}
  }
  return [
    "UTC","Etc/GMT","Europe/London","Europe/Berlin","Europe/Paris","Europe/Moscow",
    "Africa/Cairo","Africa/Johannesburg","Asia/Dubai","Asia/Kolkata","Asia/Bangkok",
    "Asia/Singapore","Asia/Shanghai","Asia/Tokyo","Australia/Sydney",
    "Pacific/Auckland","America/Anchorage","America/Los_Angeles","America/Denver",
    "America/Chicago","America/New_York","America/Sao_Paulo"
  ];
}
function tzOffsetMinutes(tz) {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  });
  const parts = dtf.formatToParts(now).reduce((a,p)=> (a[p.type]=p.value, a), {});
  const asUTCms = Date.UTC(
    Number(parts.year), Number(parts.month)-1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  const diffMin = Math.round((asUTCms - now.getTime()) / 60000);
  return diffMin * -1;
}
function fmtGMTOffset(mins) {
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const hh = String(Math.floor(abs/60)).padStart(2,"0");
  const mm = String(abs%60).padStart(2,"0");
  return `GMT${sign}${hh}:${mm}`;
}
function buildTZOptions(selectEl, currentValue) {
  const zones = getAllTimeZones()
    .map(z => ({ z, off: tzOffsetMinutes(z) }))
    .sort((a,b)=> a.off - b.off || a.z.localeCompare(b.z));
  const frag = document.createDocumentFragment();
  zones.forEach(({z, off}) => {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = `${fmtGMTOffset(off)} — ${z}`;
    if (z === currentValue) opt.selected = true;
    frag.appendChild(opt);
  });
  selectEl.innerHTML = "";
  selectEl.appendChild(frag);
}

/* -------------------- Category table rendering -------------------- */
function renderRows(cfg){
  const body = $("catBody");
  if (!body) return;
  body.innerHTML = "";
  const umbrellas = ["work","rest","other"];

  const rows = [...cfg.categoriesConfig].sort((a,b)=>{
    if (a.umbrella !== b.umbrella) return umbrellas.indexOf(a.umbrella) - umbrellas.indexOf(b.umbrella);
    return a.name.localeCompare(b.name);
  });

  for (const item of rows){
    const tr = document.createElement("tr");

    if (!cfg.categoryColors[item.name]) {
      const used = Object.values(cfg.categoryColors);
      cfg.categoryColors[item.name] = generateDistinctColor(used);
      chrome.storage.sync.set({ categoryColors: cfg.categoryColors });
    }

    const tdName = document.createElement("td");
    tdName.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="text" value="${item.name}" data-type="name" style="flex:1; padding:6px 8px; border:1px solid #d0d7e5; border-radius:6px;" />
        <input type="color" value="${cfg.categoryColors[item.name]}" data-type="color" title="Color" />
      </div>`;
    tr.appendChild(tdName);

    const tdUmb = document.createElement("td");
    tdUmb.innerHTML = `
      <select data-type="umbrella" style="padding:6px 8px; border:1px solid #d0d7e5; border-radius:6px;">
        ${["work","rest","other"].map(u=> `<option value="${u}" ${u===item.umbrella?'selected':''}>${u}</option>`).join("")}
      </select>`;
    tr.appendChild(tdUmb);

    const tdOps = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "btn-sm";
    delBtn.textContent = "Delete";
    delBtn.onclick = async ()=>{
      let cc = [...cfg.categoriesConfig];
      cc = cc.filter(c => !(c.name === item.name && c.umbrella === item.umbrella));
      if (cc.length === 0) return;
      cfg.categoriesConfig = cc;
      await setSync({ categoriesConfig: cfg.categoriesConfig });
      renderRows(cfg);
    };
    tdOps.appendChild(delBtn);
    tr.appendChild(tdOps);

    tr.querySelectorAll("input[data-type='name']").forEach(inp=>{
      inp.onchange = async () => {
        const newName = inp.value.trim();
        if (!newName) return (inp.value = item.name);
        const idx = cfg.categoriesConfig.findIndex(c => c.name === item.name);
        if (idx >= 0) {
          cfg.categoriesConfig[idx].name = newName;
          const col = cfg.categoryColors[item.name];
          if (col) { delete cfg.categoryColors[item.name]; cfg.categoryColors[newName] = col; }
          await setSync({ categoriesConfig: cfg.categoriesConfig, categoryColors: cfg.categoryColors });
          renderRows(cfg);
        }
      };
    });
    tr.querySelectorAll("select[data-type='umbrella']").forEach(sel=>{
      sel.onchange = async () => {
        const newUmb = sel.value;
        const idx = cfg.categoriesConfig.findIndex(c => c.name === item.name);
        if (idx >= 0) {
          cfg.categoriesConfig[idx].umbrella = newUmb;
          await setSync({ categoriesConfig: cfg.categoriesConfig });
          renderRows(cfg);
        }
      };
    });
    tr.querySelectorAll("input[data-type='color']").forEach(color=>{
      color.onchange = async () => {
        const v = color.value;
        cfg.categoryColors[item.name] = v;
        await setSync({ categoryColors: cfg.categoryColors });
      };
    });

    body.appendChild(tr);
  }
}

/* -------------------- Init -------------------- */
async function init(){
  const els = {
    apiKey: $("apiKey"),
    model: $("model"),
    interval: $("interval"),
    timezone: $("timezone"),
    pieRange: $("pieRange"),
    addCat: $("addCat"),
    newCatName: $("newCatName"),
    newCatUmb: $("newCatUmb"),
    save: $("save"),
    eye: $("eye"),
    saveStatus: $("saveStatus"),
    catBody: $("catBody"),
    clearData: $("clearData") // NEW
  };

  let cfg = ensureConfig(await getSync(null));

  // Fill basics
  if (els.apiKey) els.apiKey.value = cfg.apiKey || "";
  if (els.model) els.model.value = cfg.model || "gemini-2.0-flash";
  if (els.interval) els.interval.value = cfg.intervalMinutes || 5;
  if (els.pieRange) els.pieRange.value = cfg.pieRange || "1d";

  // Build global time zone select with labels like "GMT+08:00 — Asia/Shanghai"
  if (els.timezone) {
    buildTZOptions(els.timezone, cfg.timeZone || "UTC");
  }

  renderRows(cfg);

  // Save basics
  if (els.save) els.save.onclick = async ()=>{
    const patch = {
      apiKey: els.apiKey ? els.apiKey.value.trim() : "",
      model: els.model ? (els.model.value.trim() || "gemini-2.0-flash") : "gemini-2.0-flash",
      intervalMinutes: Math.max(0.5, Number(els.interval?.value || 5)), // allow sub-minute config
      timeZone: els.timezone?.value || "UTC",
      pieRange: els.pieRange?.value || "1d"
    };
    await setSync(patch);
    if (els.saveStatus) {
      els.saveStatus.textContent = "Saved ✓";
      setTimeout(()=> els.saveStatus.textContent="", 1200);
    }
  };

  // Show/Hide API key
  if (els.eye && els.apiKey) {
    els.eye.onclick = () => { els.apiKey.type = (els.apiKey.type === "password" ? "text" : "password"); };
  }

  // Add category
  if (els.addCat) els.addCat.onclick = async ()=>{
    const name = (els.newCatName?.value || "").trim();
    const umbrella = els.newCatUmb?.value || "other";
    if (!name) return;

    const snapshot = await getSync(["categoriesConfig", "categoryColors"]);
    const curCfg = ensureConfig(snapshot);
    if (curCfg.categoriesConfig.some(c => c.name.toLowerCase() === name.toLowerCase())) return;

    const existingColors = Object.values(curCfg.categoryColors);
    const newColor = generateDistinctColor(existingColors);

    curCfg.categoriesConfig.push({ name, umbrella });
    curCfg.categoryColors[name] = newColor;

    await setSync({ categoriesConfig: curCfg.categoriesConfig, categoryColors: curCfg.categoryColors });
    if (els.newCatName) els.newCatName.value = "";
    renderRows(curCfg);
  };

  // NEW: Clear data button — confirm + call background + alert result
  if (els.clearData) els.clearData.onclick = async ()=>{
    if (!confirm("Are you sure you want to clear all statistical data? This action cannot be undone.")) return;
    const r = await postMessage("CLEAR_ALL_DATA");
    if (r?.ok) {
      alert(`Cleared ${r.cleared || 0} statistical records.`);
    } else {
      alert("Clear failed, please try again.");
    }
  };
}

document.addEventListener("DOMContentLoaded", init);
