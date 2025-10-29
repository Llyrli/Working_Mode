// classify.js — v1 API via URL ?key=... (no custom header); strong anti-"other"; custom cats first.

export async function classifyPage({ url, title }, settings) {
  const domain = extractDomain(url);

  // categories / umbrellas from settings
  const catNames = getCategoryNames(settings);
  const umbMap   = getUmbrellaMap(settings);
  const restCats = catNames.filter(c => (umbMap[c] || "").toLowerCase() === "rest");

  // A) learned rules
  const learned = (settings.learnedRules || {})[domain];
  if (learned && inSet(learned, catNames)) {
    return { category: learned, reason: "learned rule", confidence: 1.0 };
  }

  // B) heuristics (bias away from other)
  const h = heuristicCategory(url, title, settings);
  if (h) {
    return {
      category: normToOneOf(h, catNames),
      reason: "heuristic match",
      confidence: 0.9,
      suggest_rule: { apply: true, domain, category: normToOneOf(h, catNames), type: "whitelist" }
    };
  }

  // C) no api key -> anti-other fallback
  if (!settings.apiKey) {
    const guess = antiOtherFallback(url, title, catNames, restCats) || "other";
    return { category: guess, reason: "no api key", confidence: guess === "other" ? 0.0 : 0.6 };
  }

  // D) LLM (prefer REST for entertainment/leisure)
  const cats = Array.from(new Set(catNames.map(String))).filter(Boolean);
  const prompt = buildPrompt({ url, title, domain, categories: cats, restCats });

  const trials = dedupe([
    settings.model && { ver: "v1", model: String(settings.model).trim() },
    { ver: "v1", model: "gemini-2.0-flash" },
    { ver: "v1", model: "gemini-2.0-pro" }
  ].filter(Boolean), x => `${x.ver}:${x.model}`);

  for (const t of trials) {
    const r = await callGemini(t.ver, t.model, settings.apiKey, prompt);
    if (r.ok && r.data?.category) {
      let cat = r.data.category;
      if (!inSet(cat, cats)) cat = "other";
      if (String(cat).toLowerCase() === "other") {
        const guess = heuristicCategory(url, title, settings) || antiOtherFallback(url, title, cats, restCats);
        if (guess) cat = guess;
      }
      return {
        category: normToOneOf(cat, cats),
        reason: r.data.reason || "LLM",
        confidence: r.data.confidence ?? 0.6,
        suggest_rule: r.data.suggest_rule
      };
    }
  }

  // E) total fallback
  const guess = heuristicCategory(url, title, settings) || antiOtherFallback(url, title, cats, restCats) || "other";
  return { category: guess, reason: "fallback", confidence: guess === "other" ? 0.1 : 0.6 };
}

/* ============== Helpers ============== */

function getCategoryNames(settings) {
  if (!settings) return [];
  if (Array.isArray(settings.categories) && settings.categories.length > 0) {
    return settings.categories.map(String).filter(Boolean);
  }
  const cfg = Array.isArray(settings.categoriesConfig) ? settings.categoriesConfig : [];
  return cfg.map(c => (typeof c === "string" ? c : c?.name)).filter(Boolean);
}
function getUmbrellaMap(settings) {
  const map = Object.create(null);
  const cfg = Array.isArray(settings.categoriesConfig) ? settings.categoriesConfig : [];
  for (const item of cfg) {
    if (!item) continue;
    const name = typeof item === "string" ? item : item.name;
    const umb  = typeof item === "string" ? ""   : item.umbrella;
    if (name) map[String(name)] = String(umb || "");
  }
  return map;
}
function inSet(name, arr) { if (!name || !arr) return false; const n = String(name).toLowerCase(); return arr.some(x => String(x).toLowerCase() === n); }
function extractDomain(u) { try { return new URL(u).hostname; } catch { return "unknown"; } }
function dedupe(arr, keyFn) { const s = new Set(); const out = []; for (const x of arr) { const k = keyFn(x); if (!s.has(k)) { s.add(k); out.push(x); } } return out; }
function clamp01(x) { x = Number(x); return isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; }
function normToOneOf(c, categories) { const s = String(c || "").toLowerCase(); const hit = (categories || []).find(x => String(x).toLowerCase() === s); return hit || "other"; }

function buildPrompt({ url, title, domain, categories, restCats }) {
  const catsLine = categories.join(", ");
  const restLine = (restCats && restCats.length) ? restCats.join(", ") : "";
  return `
You are a strict JSON machine. Choose ONE category from: ${catsLine}.
Unless it is truly unknown or generic, do NOT use "other".
- For entertainment/leisure (video/music/streaming/gaming/anime/short-video/live-streaming), choose a category under the "rest" umbrella: [${restLine}].
Guidelines: Prefer specific categories; use host/path/title; output STRICT JSON keys: category, reason, confidence, suggest_rule.
Examples:
Input: URL=https://www.youtube.com/watch?v=abc, Title="Lo-fi beats"
Output: {"category":"entertainment","reason":"video streaming","confidence":0.95,"suggest_rule":{"apply":true,"domain":"youtube.com","category":"entertainment","type":"whitelist"}}
Input: URL=https://github.com/user/repo, Title="Readme"
Output: {"category":"work","reason":"code hosting","confidence":0.9,"suggest_rule":{"apply":true,"domain":"github.com","category":"work","type":"whitelist"}}

URL: ${url}
Title: ${title}
Domain: ${domain}
ONLY return JSON like:
{"category":"<one of [${catsLine}]>","reason":"<short>","confidence":0.0-1.0,"suggest_rule":{"apply":true|false,"domain":"${domain}","category":"<same>","type":"whitelist"}}
`.trim();
}

/* ----- Gemini v1: use URL ?key=..., no custom header (avoid preflight) ----- */
async function callGemini(ver, model, apiKey, prompt) {
  const base = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent`;
  const endpoint = `${base}?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: { temperature: 0 }
  };

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort("timeout"), 12000);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer"
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
          await wait(400 + Math.random()*400);
          continue;
        }
        console.warn("[Working Mode] Gemini HTTP error:", res.status, txt.slice(0, 180));
        return { ok: false };
      }

      const data = await res.json().catch(() => null);
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text
               ?? data?.candidates?.[0]?.content?.parts?.[0]?.string_value
               ?? "";
      const json = extractJSON(raw);
      if (!json) return { ok: false };

      const out = {
        category: json.category,
        reason: (json.reason ?? "").toString().slice(0, 60) || "",
        confidence: clamp01(json.confidence),
        suggest_rule: sanitizeSuggestRule(json.suggest_rule)
      };
      return { ok: !!out.category, data: out };

    } catch (e) {
      console.error("[Working Mode] Gemini call error:", e);
      if (attempt === 0) { await wait(200 + Math.random()*300); continue; }
      return { ok: false };
    } finally {
      clearTimeout(tid);
    }
  }
  return { ok: false };
}

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
function sanitizeSuggestRule(sr) {
  if (!sr || typeof sr !== "object") return { apply: false, domain: "", category: "", type: "whitelist" };
  const domain = typeof sr.domain === "string" ? sr.domain : "";
  const category = typeof sr.category === "string" ? sr.category : "";
  const apply = !!sr.apply && !!domain && !!category;
  return { apply, domain, category, type: "whitelist" };
}
function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```json\s*/i, "")
       .replace(/^```\s*/i, "")
       .replace(/```$/i, "")
       .trim();
  const direct = safeParse(t);
  if (direct) return direct;
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { const p = safeParse(m[0]); if (p) return p; }
  return null;
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/* ----- Heuristics & fallbacks ----- */
function heuristicCategory(url, title, settings) {
  const u = String(url || "").toLowerCase();
  const t = String(title || "").toLowerCase();

  const catNames = getCategoryNames(settings);
  const umbMap   = getUmbrellaMap(settings);
  const has = (name) => catNames.map(s => String(s).toLowerCase()).includes(String(name).toLowerCase());
  const isRestCat = (c) => (umbMap[c] || "").toLowerCase() === "rest";

  const customEnglishLike = catNames.find(c => /english|language.*learn|learn.*english/i.test(c));
  if (customEnglishLike) {
    if (/duolingo|bbc\.co\.uk\/learningenglish|ef\.com|ielts|toefl|voa.*learning|quizlet|dictionary\.cambridge|deepl|youglish/i.test(u + t)) {
      return customEnglishLike;
    }
  }

  const entertainmentHit =
    /youtube|bilibili|twitch|netflix|iqiyi|youku|spotify|music\.apple\.com|soundcloud|vimeo|hulu|disneyplus|steamcommunity|store\.steampowered\.com|epicgames|douyin|tiktok|nico.*video/i.test(u + t);

  if (entertainmentHit) {
    if (has("entertainment") && isRestCat("entertainment")) return "entertainment";
    if (has("social") && isRestCat("social")) return "social";
    const anyRest = catNames.find(c => isRestCat(c));
    if (anyRest) return anyRest;
  }

  if (/twitter|x\.com|weibo|reddit|facebook|instagram/i.test(u + t)) {
    if (has("social") && isRestCat("social")) return "social";
  }

  if (/docs\.google|drive\.google|notion|confluence|jira|github|gitlab|figma|slack|linear|asana|microsoft\.sharepoint/i.test(u + t)) {
    if (has("work")) return "work";
  }
  if (/wikipedia|arxiv|khanacademy|coursera|udemy|edx|brilliant|mit\.edu\/open|classroom\.google/i.test(u + t)) {
    if (has("study")) return "study";
  }
  if (/mail\.google|outlook\.live|calendar\.google|maps\.google|bank|alipay|paypal|wise\.com|booking|airbnb|map\./i.test(u + t)) {
    if (has("utility")) return "utility";
  }

  for (const c of catNames) {
    const s = String(c).toLowerCase();
    if (!s || s === "other") continue;
    if (u.includes(s) || t.includes(s)) return c;
  }
  return null;
}
function antiOtherFallback(url, title, categories, restCats) {
  const u = String(url || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  const has = (name) => categories.some(x => String(x).toLowerCase() === String(name).toLowerCase());
  const restHas = (name) => restCats && restCats.some(x => String(x).toLowerCase() === String(name).toLowerCase());

  if (/(youtube|bilibili|twitch|netflix|iqiyi|youku|spotify|music\.apple\.com|soundcloud|hulu|disneyplus|steam|epicgames|douyin|tiktok|nico.*video)/i.test(u + t)) {
    if (has("entertainment") && restHas("entertainment")) return "entertainment";
    if (has("social") && restHas("social")) return "social";
    if (restCats && restCats.length) return restCats[0];
  }
  if (has("social") && /(twitter|x\.com|weibo|reddit|facebook|instagram)/i.test(u + t)) return "social";
  if (has("work")  && /(docs\.google|drive\.google|notion|confluence|jira|github|gitlab|figma|slack|linear)/i.test(u + t)) return "work";
  if (has("study") && /(wikipedia|arxiv|khanacademy|coursera|udemy|edx|brilliant)/i.test(u + t)) return "study";
  if (has("utility")&& /(mail\.google|outlook\.live|calendar\.google|maps\.google|bank|alipay|paypal|wise\.com)/i.test(u + t)) return "utility";
  return null;
}
