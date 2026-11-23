/* Pixel researchers: a cast of small outlined researchers who drop in on the dashboard while missions
 * are in progress. The card of each mission a model is working on right now gets its own random schedule: the first visitor turns up after a
 * random wait, walks in from a side, stays 15-30 seconds doing comic researcher things, walks off, and
 * after a random 10-20 second gap the next one comes. Never more than four are on the page at once (one on
 * each busy worker's lit step and one on each busy card), and every arrival, the strip's included, comes one
 * at a time, a random 12-20 seconds apart, so a full house takes about a minute to fill: the strip first, then
 * the stages that have waited longest. A card nobody works on any more sees its visitor walk off.
 * Visitors are drawn from a shuffled roster, so every character gets a turn before anyone repeats. Every
 * character belongs to one of the two workers (the young ones to the Research Assistant, the tenured ones
 * to the Principal Investigator), and a card tagged with data-worker mostly gets visitors from that crew
 * (80% of them, FAVOR; now and then someone from the other crew drops by).
 * On the Settings page each worker's card has its whole crew standing about (a "crew" stage).
 * Researcher Chat has a guide at the top of its panel (a "guide" stage): picking a model sends that model's
 * researcher walking in (a worker's own model brings someone from that worker's crew, any other model someone
 * from the crew its size suggests, the same person for every model of one family) and whoever stood there
 * walks off. The chat says which with a "chatguide" event. Guides don't count toward MAX_ON_STAGE.
 *
 * The pipeline strip is a stage of its own that follows the work instead of a timer (FlowStage). Each
 * busy worker's lit step gets one researcher from that worker's crew, doing that step's kind of work.
 * When the worker's mission moves on (sources -> brief -> check), they run after it. When the work ends,
 * moves to another mission, or passes to the other worker, they say a closing line and walk off, and a new
 * one walks in for whatever started, at least 10 seconds after (GAP_MIN) and in its turn among the page's
 * arrivals. assets/flow.js says when that happens with a "flowchange" event.
 * Purely decorative: canvases are aria-hidden, ignore the pointer, and nothing here talks to the server.
 */
(() => {
"use strict";
if (window.__researchers) return;
window.__researchers = true;

// A page can set its own pace before loading this script (the published About page does: short visits, and
// every visitor says hello): window.RESEARCHERS_PACE = {life: [lo, hi], gap: [lo, hi], first: [lo, hi],
// entry: [lo, hi], greet: chance, rest: [lo, hi]}.
const PACE = window.RESEARCHERS_PACE || {};
// What they say, in the UI's language: assets/lines/<code>.js sets window.RESEARCHER_LINES before this script runs
// (written in that language, not translated). Anything it leaves out is said in English.
const LINES = window.RESEARCHER_LINES || {};
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const [LIFE_MIN, LIFE_MAX] = PACE.life || [15, 30];      // seconds on stage
const [GAP_MIN, GAP_MAX] = PACE.gap || [10, 20];         // seconds between visitors on one stage
const [FIRST_MIN, FIRST_MAX] = PACE.first || [2, 15];    // the first visitor's random wait, so stages never start in step
const [ENTRY_MIN, ENTRY_MAX] = PACE.entry || [12, 20];   // seconds between any two arrivals on the page, so they stagger
const GREET = PACE.greet ?? 0.22;                        // chance a card visitor says something on arrival
const [REST_MIN, REST_MAX] = PACE.rest || [4, 6.5];      // seconds of standing about between bits (a crew's are longer)
const MAX_ON_STAGE = 4;                      // researchers on the whole page at once: two lit steps, two busy cards
const FAVOR = 0.8;                           // share of a working stage's visitors from its own worker's crew
const EDGE = 40;                             // how far off-stage they start and finish their walk
const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;
const now = () => performance.timeOrigin / 1000 + performance.now() / 1000;

// ---------- small helpers ----------

function rng(seed) {                          // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const between = (r, lo, hi) => lo + r() * (hi - lo);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function weighted(r, table) {
  let total = 0;
  for (const k in table) total += table[k];
  let x = r() * total;
  for (const k in table) if ((x -= table[k]) < 0) return k;
  return Object.keys(table)[0];
}
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const hexOf = c => "#" + ((1 << 24) | (Math.round(clamp(c[0], 0, 255)) << 16) | (Math.round(clamp(c[1], 0, 255)) << 8) | Math.round(clamp(c[2], 0, 255))).toString(16).slice(1);
function mix(a, b, t) { const x = rgb(a), y = rgb(b); return hexOf(x.map((v, i) => v + (y[i] - v) * t)); }
const lum = hex => { const c = rgb(hex); return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; };
// Darker (f < 1) or lighter (f > 1), the way pixel art shades: shadows lean cool and violet, lights lean warm.
const COOL = [38, 28, 78], WARM = [255, 240, 205];
function shade(hex, f) {
  const c = rgb(hex), k = f < 1 ? (1 - f) * 0.3 : Math.min(0.3, (f - 1) * 0.3), to = f < 1 ? COOL : WARM;
  return hexOf(c.map((v, i) => { const s = f < 1 ? v * f : v + (255 - v) * (f - 1); return s + (to[i] - s) * k; }));
}
// More colorful, the way handheld-era sprites are: saturation up, greys left grey, lightness kept.
function vivid(hex, k = 1.4) {
  const [r, g, b] = rgb(hex).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 0.04) return hex;
  const sat = d / (1 - Math.abs(2 * l - 1) || 1), s2 = Math.min(0.92, sat * k + 0.03), f = s2 / sat;
  return hexOf([r, g, b].map(v => (l + (v - l) * f) * 255));
}
// The dark of a color, for an outline: sprites of that era are edged in a deep shade of what they outline, not in black.
const tintOf = (r, g, b) => [Math.round(r * 0.26 + 12), Math.round(g * 0.22 + 9), Math.round(b * 0.28 + 22)];
function darkOf(hex) { const c = rgb(hex); return hexOf(tintOf(c[0], c[1], c[2])); }
// A soft line: the dark of a part's own color, for the lines inside the figure (an arm across the chest, one leg
// in front of the other). Where one ends up on the silhouette, the outline pass turns it to ink like the rest.
const SOFT = new Set(), softOf = new Map();
function soft(c) {
  let s = softOf.get(c);
  if (!s) { s = mix(shade(c, 0.62), INK, 0.42); softOf.set(c, s); SOFT.add(parseInt(s.slice(1), 16)); }
  return s;
}
function shuffle(list, r = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const memory = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  delete(k) { try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ } },
};

// ---------- the cast ----------

const INK = "#1d1b22", MOUTH = "#7a3434", WHITE = "#ffffff", BLUSH = "#ff8f9e";
const SKIN = ["#ffe1c6", "#f5cba3", "#e8b38a", "#d49a6a", "#b97c4e", "#9a6038", "#7a4628", "#58321d"];
const BOOKS = ["#d63a3a", "#1f8fc4", "#1fa67f", "#f0a030", "#a02c7a", "#5a55c8"];
const NATURAL_HAIR = ["#17110e", "#2e1f17", "#4b3021", "#6e4527", "#93602f", "#c08d4a", "#a3a3a3"];
const IRIS = ["#6b3d22", "#2f5fa8", "#2f7d4f", "#7a5a22", "#4a3a7a", "#3b2a20"];

// Each character keeps their look (outfit, hair, headwear, signature prop) and their attitude (`brow` and
// `mouth` are their resting expression, `quirk` their own little habit); height, build and some colors vary
// per visit. `fav` boosts the actions they're known for; everything else can still happen.
// `worker` is whose crew they're in: "assistant" (young, the small model) or "pi" (tenured, the big model).
const ROSTER = {
  aris:   { worker: "pi", name: "Dr. Aris", skin: [6, 7, 5], hair: ["#cfcfcf", "#b5b5b5"], style: "receding", facial: "walrus",
            bushy: true, brow: "skeptic", outfit: "labcoat", shirt: ["#5b7fa6", "#6c8fb8"], bow: ["#a83232", "#2d6a4f", "#6a4c93"],
            pants: ["#3a3a40"], shoes: ["#6b3e26"], prop: "tablet", fav: { read: 2, citation: 2.5, notes: 1.5 } },
  aisha:  { worker: "pi", name: "Aisha", skin: [5, 6, 4, 3], head: "hijab", hijab: ["#1f3a5f", "#2d2d4a", "#4a2240", "#1e4d4a"],
            lash: true, outfit: "abaya", top: ["#a9cbe8", "#c4b5e0", "#b5d8c6"], pants: ["#2c3e57"], shoes: ["#2b2b30"],
            prop: "tablet", fav: { notes: 2.5, search: 1.5, typing: 1.5 } },
  ben:    { worker: "assistant", name: "Ben", skin: [1, 2, 3], hair: ["#6e4527", "#93602f", "#4b3021"], style: "short", ahoge: true,
            outfit: "sweater", top: ["#7d8691", "#5f7f6b", "#8a6f5a"], pants: ["#c8b48a", "#b5a27a"], brow: "worry",
            shoes: ["#6b3e26"], pack: ["#6b4a2e", "#3d5a80"], prop: null, fav: { stack: 3, telescope: 1.5, eureka: 1.5 } },
  mei:    { worker: "assistant", name: "Mei", skin: [1, 2, 0], hair: ["#141414", "#2a1d17"], style: "bob", face: "round", lash: true,
            frame: ["#c0392b", "#3d5a80", "#6a4c93"], outfit: "labcoat", shirt: ["#6f8fb3", "#8aa3c2"], pants: ["#2c3340"],
            shoes: ["#2b2b30"], prop: "laptop", fav: { typing: 3, read: 1.5, scroll: 1.5 } },
  sam:    { worker: "assistant", name: "Sam", skin: [2, 3, 4], hair: ["#1d1d1d"], style: "short", head: "cap", cap: ["#2f3640", "#3d3d55", "#7a2e3b"],
            lids: true, outfit: "hoodie", top: ["#7a7f87", "#5c6370", "#6b5b7b"], pants: ["#4a78b5", "#3c5a99"], shoes: ["#e8e8e8"],
            prop: "phone", fav: { typing: 2.5, confused: 1.5, citation: 1.5 } },
  evelyn: { worker: "pi", name: "Prof. Evelyn", skin: [0, 1, 2], hair: ["#cfcfcf", "#e4e4e4"], style: "bigcurly", face: "halfmoon",
            lash: true, outfit: "cardigan", top: ["#8a5a3c", "#6e5a8a", "#4f6e5a"], shirt: ["#efe6d6"], legs: "skirt",
            skirt: ["#2f3640", "#3a2f40"], pants: ["#d8b89a"], shoes: ["#6b3e26"], prop: "book",
            fav: { read: 3, coffee: 2, sleep: 1.5 } },
  david:  { worker: "pi", name: "David", skin: [6, 7, 5], hair: ["#141414"], style: "crop", outfit: "suit", brow: "stern", mouth: "smirk",
            top: ["#22346b", "#2b2e38", "#3b3f48"], tie: ["#e8e8e8", "#c0392b", "#d4a017"], shoes: ["#2b2b30"],
            prop: ["briefcase", "tablet"], fav: { citation: 2, papers: 2, notes: 1.5 } },
  javier: { worker: "assistant", name: "Javier", skin: [3, 4, 5], hair: ["#2a1a12"], style: "tousled", outfit: "overalls", rolled: true,
            pencil: true, grin: true, shirt: ["#b5473a", "#5f7f6b", "#e8e4da", "#8a6f9e"], pants: ["#3f5f8a", "#4a6f9e"],
            shoes: ["#6b3e26"], prop: null, fav: { dig: 3.5, search: 1.5, telescope: 1 } },
  hanna:  { worker: "assistant", name: "Hanna", skin: [1, 2, 0], hair: ["#a07850", "#6e4527", "#c9a46a"], style: "long", head: "beanie",
            lash: true, beanie: ["#5d6b55", "#7a4a4a", "#45556b"], pom: ["#f4efe6", "#e8c39e"], outfit: "jacket",
            top: ["#566152", "#4a5568", "#6b5a45"], pants: ["#4a6f9e"], shoes: ["#e8e8e8"], pack: ["#3a3f45", "#5a3f2e"],
            prop: "laptop", fav: { typing: 2, telescope: 1.5, scroll: 1.5 } },
  kenji:  { worker: "pi", name: "Kenji", skin: [1, 2, 3], hair: ["#141414"], style: "neat", face: "browline", outfit: "labcoat",
            tie: ["#2b2e38", "#7a2e3b"], shirt: ["#5a7fa6", "#4f6d8a"], pants: ["#2f3640"], shoes: ["#2b2b30"], prop: "camera",
            fav: { search: 2.5, telescope: 2, eureka: 1.5 } },
  quill:  { worker: "pi", name: "Det. Quill", skin: [0, 1, 2, 3, 4, 5, 6, 7], hair: NATURAL_HAIR, style: "short", head: "deerstalker",
            brow: "skeptic", mouth: "smirk", outfit: "trench", top: ["#b8925a", "#a07c4c"], pants: ["#3a3a40"], shoes: ["#5d4037"],
            prop: "magnifier", facial: ["mustache", null], fav: { search: 4, confused: 1.5 } },
  pip:    { worker: "assistant", name: "Intern Pip", skin: [0, 1, 2, 3, 4, 5, 6, 7], hair: ["#c9572d", "#e1c27f", "#17110e"], style: "spiky",
            head: "propeller", freckles: true, grin: true, mouth: "smile", outfit: "tshirt", top: ["#e84393", "#0abde3", "#f39c12", "#27ae60"],
            pants: ["#556b2f", "#34495e"], shoes: ["#c0392b", "#e8e8e8"], prop: "mug", fav: { papers: 2.5, coffee: 2.5, stack: 1.5 } },
};
const CAST = Object.keys(ROSTER);                // built-ins, then any custom sprites registered (see SPRITES.md)
const BUILT_IN = new Set(CAST);
// A page can add sprites and switch any off before loading this script:
// window.RESEARCHER_SPRITES = { add: { "custom-sprite-1": spec, ... }, off: ["pip", ...] }.
const SPRITE_CONFIG = window.RESEARCHER_SPRITES || {};
const OFF = new Set(Array.isArray(SPRITE_CONFIG.off) ? SPRITE_CONFIG.off : []);
const enabled = () => CAST.filter(k => !OFF.has(k));
const crewOf = worker => {                        // a crew never ends up empty: switching all of it off is ignored
  const all = CAST.filter(k => !worker || ROSTER[k].worker === worker), on = all.filter(k => !OFF.has(k));
  return on.length ? on : all;
};

function makeLook(kind, seed) {
  const r = rng(seed), t = ROSTER[kind] || ROSTER.aris;
  const one = v => { const c = Array.isArray(v) ? pick(r, v) : v; return typeof c === "string" && c[0] === "#" ? vivid(c) : c; };
  const a = { kind, seed, name: (LINES.names || {})[kind] || t.name, fav: t.fav || {}, worker: t.worker };
  a.skin = vivid(SKIN[r() < 0.7 ? one(t.skin) : Math.floor(r() * SKIN.length)], 1.18);
  const deep = lum(a.skin) < 125;                                // darker skin: warmer shade, eyes that still read
  a.skinD = mix(shade(a.skin, 0.84), "#8a2f3c", 0.14); a.skinL = mix(a.skin, "#fff3dc", deep ? 0.3 : 0.45);
  a.cheek = mix(a.skin, "#ff5a6e", deep ? 0.2 : 0.28);
  a.hair = one(t.hair) || "#17110e";
  const dark = lum(a.hair) < 48;                                 // black hair shines blue, the manga way
  a.hairD = dark ? shade(a.hair, 0.55) : shade(a.hair, 0.7); a.hairL = dark ? mix(a.hair, "#7f95d6", 0.42) : shade(a.hair, 1.32);
  a.style = t.style || "short"; a.head = t.head || null; a.face = t.face || null; a.facial = one(t.facial) || null;
  a.eye = pick(r, IRIS); a.lash = !!t.lash; a.lids = !!t.lids; a.bushy = !!t.bushy; a.ahoge = !!t.ahoge;
  if (deep) a.eye = "#3a2114";                                   // dark eyes read best on dark skin
  a.eyeD = mix(a.eye, INK, deep ? 0.75 : 0.5); a.eyeW = deep ? a.skinL : "#ffffff"; a.lashC = INK;
  a.brow = t.brow || "flat"; a.mouth = t.mouth || "none"; a.grin = !!t.grin;
  a.freckles = !!t.freckles; a.pencil = !!t.pencil; a.frame = one(t.frame) || INK;
  a.rosy = a.worker !== "pi" || !!t.lash;                        // the young ones, and anyone with lashes, get rosy cheeks
  a.nose = !!a.facial;                                           // a mustache needs a nose to sit under
  a.outfit = t.outfit;
  a.top = one(t.top) || "#7d8691"; a.topD = shade(a.top, 0.78);
  a.shirt = one(t.shirt) || "#e8e4da"; a.shirtD = shade(a.shirt, 0.82);
  a.coat = a.outfit === "labcoat" ? "#f6f5f0" : a.top; a.coatD = a.outfit === "labcoat" ? "#cfd3e0" : shade(a.coat, 0.82);
  a.pants = a.outfit === "suit" ? a.top : one(t.pants) || "#3a3a40"; a.pantsD = shade(a.pants, 0.75);
  a.shoes = one(t.shoes) || "#2b2b30"; a.shoesD = shade(a.shoes, 0.75); a.sneaker = lum(a.shoes) > 170;
  a.legsStyle = t.legs || "pants"; a.skirt = one(t.skirt) || "#2f3640";
  a.pack = one(t.pack) || null;
  a.tie = one(t.tie) || null; a.bow = one(t.bow) || null;
  a.hijab = one(t.hijab) || "#1f3a5f"; a.hijabD = shade(a.hijab, 0.72); a.hijabL = shade(a.hijab, 1.45);
  a.veilPal = { j: a.hijab, J: a.hijabD, L: a.hijabL, u: mix(a.hijab, "#ffffff", 0.72), g: "#e9c46a" };
  a.cap = one(t.cap) || "#2f3640"; a.beanie = one(t.beanie) || "#5d6b55"; a.pom = one(t.pom) || "#f4efe6";
  a.hairPal = { f: mix(a.hair, a.skin, 0.55) };                  // a fade: hair thinning into skin
  // Brows sit on the skin, or over whatever comes down to them (bangs, a hat's edge) in a color that shows on it.
  const over = { cap: a.cap, beanie: a.beanie, hardhat: "#e0a800", deerstalker: "#75512f", propeller: "#c79d0a" }[a.head] || a.hair;
  a.fringe = a.head ? 10 : { bob: 8, receding: 13, bigcurly: 9 }[a.style] || 9;
  a.browC = a.bushy ? a.hairL : mix(shade(a.hair, 0.6), a.skin, a.lash ? 0.4 : 0.22);
  if (Math.abs(lum(a.browC) - lum(a.skin)) < 45) a.browC = deep ? "#120c0c" : shade(a.skin, 0.45);
  a.browHi = lum(over) < 42 ? mix(over, "#ffffff", 0.32) : shade(over, 0.5);
  a.prop = one(t.prop) || null;
  a.sleeve = { labcoat: a.coat, suit: a.top, hoodie: a.top, sweater: a.top, cardigan: a.top, jacket: a.top,
               abaya: a.top, trench: a.top, vest: a.shirt, overalls: a.shirt, tshirt: a.top }[a.outfit] || a.top;
  a.sleeveD = a.outfit === "labcoat" ? a.coatD : shade(a.sleeve, 0.78);
  a.cuff = a.outfit === "suit" ? "#f6f6f6" : a.outfit === "abaya" ? a.hijab : null;   // a line of shirt cuff, a trimmed sleeve
  a.rolled = !!t.rolled;
  a.short = a.outfit === "tshirt" || a.rolled; // bare forearms
  a.legs = 12 + Math.floor(r() * 7);          // 12..18 px: short to lanky
  a.torso = 11 + Math.floor(r() * 3);         // 11..13
  a.width = pick(r, [11, 12, 12, 13]);
  a.speed = 12 + a.legs * 0.9 + r() * 4;      // px per second: an amble, 23..32
  a.book = vivid(pick(r, BOOKS));
  a.phase = r() * 7;                          // so glasses glint and wisps sway out of step
  a.base = t.base || kind;                    // a custom sprite keeps its starting sprite's quirk unless it has its own
  a.maps = t.maps || null; a.propMap = t.propMap || null; a.quirk = t.quirk || null;
  if (a.propMap) a.prop = "custom";
  return a;
}

// ---------- drawing ----------

// P(x, y, w, h, color): one rectangle of pixels. x runs toward the way the researcher faces, y runs up
// from the floor. Mirroring for left-facing happens here, so every part is drawn facing right. Nothing is
// drawn below the floor: a sitting researcher's coat folds onto it instead of sinking through.
function painter(g, ox, oy, face) {
  return (x, y, w, h, c) => {
    if (y < 0) { h += y; y = 0; }
    if (!c || w <= 0 || h <= 0) return;
    g.fillStyle = c;
    g.fillRect(ox + (face > 0 ? x : -(x + w - 1)), oy - y - h + 1, w, h);
  };
}
const box = (P, x, y, w, h, c, ink = INK) => { P(x - 1, y - 1, w + 2, h + 2, ink); P(x, y, w, h, c); };
// The same, with the corners of its line left off, so small things (a hand, a shoe) read as round.
const pill = (P, x, y, w, h, c, ink = INK) => { P(x - 1, y, w + 2, h, ink); P(x, y - 1, w, h + 2, ink); P(x, y, w, h, c); };

// A thick straight limb from (x0, y0) to (x1, y1), w pixels wide, with its own line round it so it reads
// against whatever is behind it. The line is dark ink, or a soft line (see `soft`) for the body's own parts.
function limb(P, x0, y0, x1, y1, w, c, ink = true) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1), o = Math.floor((w - 1) / 2), pts = [];
  for (let i = 0; i <= n; i++) pts.push([Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n)]);
  const line = ink === true ? INK : ink;
  if (line) for (const [x, y] of pts) { P(x - o - 1, y - o, w + 2, w, line); P(x - o, y - o - 1, w, w + 2, line); }
  for (const [x, y] of pts) P(x - o, y - o, w, w, c);
}

// A picture in letters, rows top to bottom, its top-left pixel at (x0, yTop). Letters are the color slots a
// custom map uses (SLOTS: h hair, H its shade, l its light, s skin, ...) or come from `pal`. Runs of one
// letter are painted as one rectangle.
function art(P, a, rows, x0, yTop, pal) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let j = 0; j < row.length; j++) {
      const ch = row[j];
      if (ch === ".") continue;
      let n = 1;
      while (j + n < row.length && row[j + n] === ch) n++;
      P(x0 + j, yTop - i, n, 1, slotColor(a, ch, pal));
      j += n - 1;
    }
  }
}

function drawLeg(P, a, cx, off, lift, L, back) {
  const lf = lift ? 2 : 0, foot = cx - 1 + off, sc = back ? a.shoesD : a.shoes, line = soft(a.shoes);
  const pc = back ? a.pantsD : a.pants, pl = soft(a.pants);
  if (lift && L > 9) {                                            // a step: the knee leads, the shin follows
    const kx = cx + Math.round(off * 0.5) + 2, ky = Math.round((L + lf) / 2) + 1;
    limb(P, cx, L - 2, kx, ky, 4, pc, pl); limb(P, kx, ky, cx + off, lf + 4, 4, pc, pl);
  } else limb(P, cx, L - 2, cx + off, lf + 4, 4, pc, pl);
  if (!back && !off && !lift && L > 9) P(cx + 1, 6, 1, L - 9, shade(a.pants, 1.22));   // light down the shin
  if (!back && a.legsStyle !== "skirt") P(cx + off - 1, lf + 4, 4, 1, a.pantsD);   // the hem over the shoe
  P(foot - 1, lf, 7, 3, line); P(foot - 1, lf + 3, 6, 1, line);                    // a shoe with a rounded toe
  P(foot, lf + 2, 5, 1, sc); P(foot, lf + 1, 5, 1, a.sneaker ? (back ? "#c9ccd4" : "#ffffff") : shade(sc, 0.66));
  if (a.sneaker) P(foot + 1, lf + 2, 2, 1, shade(sc, 0.8));                        // laces side
  else P(foot + 3, lf + 2, 1, 1, shade(sc, 1.45));                                 // a shine on the toe
}

function drawArm(P, a, spec, g, back) {
  const [mode, v = 0] = spec || ["swing", 0];
  const ax = back ? g.tl - 1 : g.tr, sy = g.sh - 1;
  const d = back ? -1 : 1;
  let elbow, hand;
  switch (mode) {
    case "forward": elbow = [ax, sy - 5]; hand = [ax + 6 + v, sy - 6]; break;
    case "high":    elbow = [ax + 1, sy - 5]; hand = [ax + 5 + v, sy]; break;
    case "low":     elbow = [ax + 1, sy - 5]; hand = [ax + 6 + v, sy - 10]; break;
    case "up":      elbow = [ax + 3 * d, sy + 5]; hand = [ax + (4 + v) * d, g.top + 1]; break;
    case "head":    elbow = [ax + 5, sy + 6]; hand = [ax + 1, g.top - 1 + v]; break;
    case "mouth":   elbow = [ax + 1, sy - 5]; hand = [ax + 3 + v, g.head + 2]; break;
    case "face":    elbow = [ax + 2, sy - 4]; hand = [ax + 3 + v, g.head + 6]; break;   // a hand up at the glasses
    default:        elbow = [ax + Math.round(v / 2), sy - 6]; hand = [ax + v, sy - a.torso + 3];
  }
  const sleeve = back ? a.sleeveD : a.sleeve, skin = back ? a.skinD : a.skin, line = soft(a.sleeve), bare = soft(a.skin);
  limb(P, ax, sy, elbow[0], elbow[1], 3, sleeve, line);
  limb(P, elbow[0], elbow[1], hand[0], hand[1], 3, a.short ? skin : sleeve, a.short ? bare : line);
  if (!back) P(ax, sy, 2, 1, shade(sleeve, 1.2));                                // light on the shoulder
  if (a.rolled) P(elbow[0] - 1, elbow[1] - 1, 3, 3, shade(sleeve, 1.16));       // the rolled-up cuff
  else if (a.short) P(elbow[0] - 1, elbow[1], 3, 1, shade(sleeve, 0.8));          // a short sleeve's hem
  pill(P, hand[0] - 1, hand[1] - 1, 3, 3, skin, bare);
  if (!a.short) {                                                                  // a cuff where the sleeve ends
    const dx = Math.sign(hand[0] - elbow[0]), dy = Math.sign(hand[1] - elbow[1]);
    const cuff = a.cuff || shade(sleeve, 0.82);
    if (Math.abs(hand[1] - elbow[1]) >= Math.abs(hand[0] - elbow[0])) P(hand[0] - 1, hand[1] - 2 * dy, 3, 1, cuff);
    else P(hand[0] - 2 * dx, hand[1] - 1, 1, 3, cuff);
  }
  if (!back) P(hand[0] - 1, hand[1] - 1, 2, 1, a.skinD);                           // fingers curl under
  return hand;
}

function drawTorso(P, a, g) {
  const { tl, tr, hip, sh } = g, W = tr - tl + 1, T = sh - hip + 1;
  // The body of a garment `drop` pixels longer than the hips: the far side in shade, a soft line where it meets
  // the far arm and the legs. The silhouette pass draws the dark outline, so nothing here is boxed in ink.
  const shell = (c, drop = 0, cd = shade(c, 0.8)) => {
    const b = hip - drop, line = soft(c);
    P(tl, b - 1, W, 1, line);
    P(tl, b, W, sh - b, c); P(tl + 1, sh, W - 2, 1, c);
    P(tl + 1, b, 2, sh - b + 1, cd); P(tl, b, 1, sh - b, line);
    P(tl + 3, b, W - 3, 1, cd);                                   // the hem
    P(tl + 3, sh, W - 5, 1, shade(c, 1.2)); P(tl + 3, sh - 1, 1, 1, shade(c, 1.2));   // light on the shoulders
    return b;
  };
  // The chest is drawn a pixel back from the middle: the front arm hides the front edge of the torso.
  // An open collar: `col` shows in a V that narrows over `depth` rows, edged with `edge` (lapels).
  const vneck = (col, depth, edge) => {
    for (let i = 0; i < depth; i++) {
      const w = Math.max(0, 2 - (i >> 1));
      P(-w - 1, sh - i, 2 * w + 1, 1, col);
      if (edge) { P(-w - 2, sh - i, 1, 1, edge); P(w, sh - i, 1, 1, edge); }
    }
  };
  const tie = (c, len) => { P(-1, sh - len, 1, len, c); P(-2, sh - 1, 3, 1, c); P(-1, sh - 1, 1, 1, shade(c, 0.72)); P(-1, sh - 3, 1, 1, shade(c, 1.25)); };
  const strap = () => { if (a.pack) { P(tr - 4, hip + 2, 2, T - 2, shade(a.pack, 0.9)); P(tr - 4, hip + 2, 1, T - 2, shade(a.pack, 0.68)); P(tr - 4, sh - 4, 2, 1, "#d8b36a"); } };
  switch (a.outfit) {
    case "labcoat": {
      const c = a.coat, cd = a.coatD, b = shell(c, 5, cd), line = soft(c);
      P(0 - 1, b, 1, 5, line); P(1 - 1, b, 1, 1, a.pantsD);               // the coat parts over the knees
      if (g.stride) { P(tl - 1, b, 1, 4, cd); P(tl - 2, b, 1, 2, cd); }   // and its tails fly out behind on a stride
      P(0 - 1, hip + 1, 1, T - 6, cd);                                // buttoned up the middle
      P(1 - 1, hip + 1, 1, 1, "#9aa3b2"); P(1 - 1, hip + 4, 1, 1, "#9aa3b2");
      vneck(a.shirt, 6, cd);
      P(-2 - 1, sh, 1, 1, shade(a.shirt, 1.25)); P(2 - 1, sh, 1, 1, shade(a.shirt, 1.25));   // collar points
      if (a.tie) tie(a.tie, 5);
      if (a.bow) {                                                // a proper bow tie: two wings and a knot
        const w = a.bow;
        P(-3 - 1, sh - 2, 2, 3, w); P(2 - 1, sh - 2, 2, 3, w); P(-1 - 1, sh - 1, 3, 1, w);
        P(0 - 1, sh - 1, 1, 1, shade(w, 0.62)); P(-3 - 1, sh, 1, 1, shade(w, 1.35)); P(2 - 1, sh, 1, 1, shade(w, 1.35));
        P(-3 - 1, sh - 2, 1, 1, shade(w, 0.72)); P(3 - 1, sh - 2, 1, 1, shade(w, 0.72));
      }
      P(-5 - 1, sh - 5, 3, 1, cd); P(-5 - 1, sh - 4, 1, 2, "#2e6fd8"); P(-4 - 1, sh - 4, 1, 1, "#e03131");   // pens in the breast pocket
      P(-5 - 1, hip - 2, 3, 1, cd);                                   // a hip pocket
      P(tl + 3, sh - 1, 1, 1, shade(c, 1.2));
      break;
    }
    case "suit": {
      const c = a.top, cd = a.topD, cl = shade(c, 1.28), b = shell(c, 2, cd);
      P(0 - 1, b, 1, 2, soft(c));                                     // the vent
      P(0 - 1, hip + 1, 1, T - 7, cd); P(1 - 1, hip + 2, 1, 1, cl); P(1 - 1, hip, 1, 1, cl);   // two buttons
      vneck("#f6f6f6", 7, cd);
      P(-3 - 1, sh - 1, 1, 2, cl); P(3 - 1, sh - 1, 1, 2, cl); P(-2 - 1, sh - 3, 1, 2, cl); P(2 - 1, sh - 3, 1, 2, cl);   // lapels catch the light
      P(-4 - 1, sh, 1, 1, cd); P(4 - 1, sh - 2, 1, 1, cd);                // and their notches
      tie(a.tie || "#c0392b", 6);
      P(-2 - 1, sh, 1, 1, "#ffffff"); P(2 - 1, sh, 1, 1, "#ffffff");
      P(-5 - 1, sh - 4, 2, 1, a.tie === "#e8e8e8" ? "#c0392b" : "#f6f6f6"); P(-5 - 1, sh - 5, 2, 1, cd);   // pocket square
      break;
    }
    case "hoodie": {
      const c = a.top, cd = a.topD, cl = shade(c, 1.2);
      shell(c, 0, cd);
      P(tl + 1, hip, W - 1, 2, cd); for (let x = tl + 2; x < tr; x += 2) P(x - 1, hip, 1, 2, shade(c, 0.68));   // ribbed hem
      P(-4 - 1, hip + 3, 8, 3, cd); P(-4 - 1, hip + 5, 1, 1, c); P(3 - 1, hip + 5, 1, 1, c); P(-3 - 1, hip + 3, 6, 1, shade(c, 0.68));   // kangaroo pocket
      P(-3 - 1, sh, 7, 1, cd); P(-2 - 1, sh - 1, 5, 1, cd); P(-1 - 1, sh, 3, 1, shade(c, 0.62));   // the hood's opening round the neck
      P(-1 - 1, sh - 5, 1, 4, "#f1f1f1"); P(2 - 1, sh - 4, 1, 3, "#f1f1f1"); P(-1 - 1, sh - 6, 1, 1, "#aab0ba"); P(2 - 1, sh - 5, 1, 1, "#aab0ba");   // drawstrings
      P(tl + 3, sh - 2, 1, 2, cl);
      break;
    }
    case "cardigan": {
      const c = a.top, cd = a.topD, b = shell(c, 1, cd), gold = "#e0b64a";
      P(-1 - 1, b, 3, sh - b, a.shirt); P(-2 - 1, sh - 2, 5, 3, a.shirt); P(-1 - 1, b, 1, sh - b - 2, a.shirtD);   // the blouse
      P(-2 - 1, b, 1, sh - b - 2, cd); P(2 - 1, b, 1, sh - b - 2, cd); P(-3 - 1, sh - 2, 1, 2, cd); P(3 - 1, sh - 2, 1, 2, cd);   // the knit's edges
      for (let y = hip + 1; y < sh - 3; y += 3) P(2 - 1, y, 1, 1, gold);                 // buttons
      P(-5 - 1, hip, 3, 1, cd); P(-5 - 1, hip + 1, 3, 1, shade(c, 1.15));                    // a pocket
      for (let x = tl + 3; x <= tr; x += 2) if (Math.abs(x) > 2) P(x - 1, b, 1, 1, shade(c, 0.66));   // ribbing at the hem
      P(-1 - 1, sh, 3, 1, "#f3ead8"); P(0 - 1, sh - 1, 1, 1, "#f3ead8");                     // a string of pearls
      P(-4 - 1, sh - 3, 1, 1, gold); P(-5 - 1, sh - 3, 1, 1, "#f6dc8c"); P(-4 - 1, sh - 4, 1, 1, "#c2543c");   // a little brooch
      break;
    }
    case "vest": {
      shell(a.shirt, 0, a.shirtD);
      P(tl + 1, hip, W - 2, T - 2, "#ff8a1a"); P(tl + 1, hip, 2, T - 2, "#e5741a"); P(0 - 1, hip, 1, T - 2, "#c85f10");
      P(tl + 1, hip + 3, W - 2, 2, "#ffe14d"); P(-4 - 1, hip + 5, 2, T - 7, "#ffe14d"); P(2 - 1, hip + 5, 2, T - 7, "#ffe14d");
      P(tl + 1, hip + 3, W - 2, 1, "#e8c93a");
      P(-1 - 1, sh, 3, 1, a.shirtD);
      break;
    }
    case "overalls": {                                             // a shirt under a denim bib and straps
      const bib = T - 5, d = a.pants, dd = a.pantsD, stitch = shade(d, 1.35), brass = "#e0b64a";
      shell(a.shirt, 0, a.shirtD);
      P(tl + 1, hip, W - 1, 3, d); P(tl + 1, hip, 2, 3, dd);                        // the waist
      P(-4 - 1, hip, 8, bib, d); P(-4 - 1, hip, 1, bib, dd);                                // the bib
      P(-4 - 1, hip + bib, 2, 5, d); P(2 - 1, hip + bib, 2, 5, d); P(-4 - 1, hip + bib, 1, 5, dd);   // straps
      P(-4 - 1, hip + bib - 1, 2, 2, brass); P(2 - 1, hip + bib - 1, 2, 2, brass); P(-4 - 1, hip + bib - 1, 1, 1, "#a8842c"); P(2 - 1, hip + bib - 1, 1, 1, "#a8842c");   // brass clasps
      P(-2 - 1, hip + 3, 4, 3, dd); P(-2 - 1, hip + 5, 4, 1, stitch); P(1 - 1, hip + 4, 1, 1, brass);   // the bib pocket, a stitched top and a rivet
      P(-4 - 1, hip + 2, 8, 1, stitch);                                                 // a seam at the waist
      P(-2 - 1, sh, 5, 1, a.shirtD); P(-1 - 1, sh, 3, 1, shade(a.shirt, 1.15));             // collar
      break;
    }
    case "jacket": {
      const c = a.top, cd = a.topD, cl = shade(c, 1.22);
      shell(c, 0, cd);
      P(tl + 1, hip, W - 1, 1, shade(c, 0.66));                                     // the waistband
      P(0 - 1, hip + 1, 1, T - 2, "#c3c8d0"); P(0 - 1, sh - 3, 1, 2, "#eef0f3"); P(1 - 1, hip + 1, 1, T - 4, cd);   // zip and its pull
      P(-3 - 1, sh - 1, 3, 2, cl); P(1 - 1, sh - 1, 3, 2, cl); P(-3 - 1, sh - 1, 1, 1, cd); P(3 - 1, sh - 1, 1, 1, cd);   // collar, turned out
      P(-1 - 1, sh, 2, 1, a.shirt);
      P(-5 - 1, hip + 3, 3, 1, cd); P(-5 - 1, hip + 2, 3, 1, cl);                           // a pocket flap
      strap();
      break;
    }
    case "abaya": {                                                // long and flowing: it widens toward the hem
      const c = a.top, cd = a.topD, cl = shade(c, 1.14), line = soft(c), trim = a.hijab, mid = Math.min(hip, 9);
      P(tl, mid, W, sh - mid, c); P(tl + 1, sh, W - 2, 1, c);
      P(tl - 1, 5, W + 2, mid - 5, c); P(tl - 2, 2, W + 4, 3, c);
      P(tl, mid, 1, sh - mid, line); P(tl + 1, mid, 2, sh - mid + 1, cd);
      P(tl - 1, 5, 2, mid - 5, cd); P(tl - 2, 2, 2, 3, cd);
      for (const x of [-3, 1, 4]) { P(x - 1, 5, 1, Math.max(2, hip - 3 + (x === 1 ? 4 : 0)), cd); P(x + 1 - 1, 5, 1, Math.max(1, hip - 6), cl); }   // folds
      P(tl - 2, 3, W + 4, 1, trim); P(tl - 2, 2, W + 4, 1, shade(trim, 0.7));        // an embroidered band at the hem
      for (let x = tl - 1; x <= tr + 1; x += 2) P(x - 1, 3, 1, 1, "#e9c46a");
      P(tl - 2, 4, W + 4, 1, cl);
      break;
    }
    case "trench": {
      const c = a.top, cd = a.topD, cl = shade(c, 1.2), b = shell(c, 6, cd), leather = "#5a3d24";
      P(0 - 1, b, 1, 6, soft(c));                                     // the back vent shows between the knees
      if (g.stride) { P(tl - 1, b, 1, 5, cd); P(tl - 2, b, 1, 2, cd); }   // the coat swings on a stride
      P(1 - 1, hip + 2, 1, T - 4, cd);                                // double-breasted: the front laps over
      for (const y of [hip + 3, hip + 6]) { P(-2 - 1, y, 1, 1, leather); P(3 - 1, y, 1, 1, leather); }
      P(-1 - 1, sh - 3, 3, 4, a.shirt); P(0 - 1, sh - 3, 1, 3, a.shirtD);
      P(-3 - 1, sh - 3, 2, 3, cl); P(2 - 1, sh - 3, 2, 3, cl); P(-2 - 1, sh - 4, 2, 1, cl); P(1 - 1, sh - 4, 2, 1, cl); P(-3 - 1, sh - 3, 1, 1, cd); P(3 - 1, sh - 3, 1, 1, cd);   // wide lapels
      P(-4 - 1, sh, 3, 3, c); P(-4 - 1, sh, 1, 3, cd); P(2 - 1, sh, 3, 3, c); P(4 - 1, sh + 2, 1, 1, cl);   // the collar, turned up
      P(tl + 1, hip, W - 1, 2, leather); P(tl + 1, hip, W - 1, 1, shade(leather, 0.7)); P(0 - 1, hip, 2, 2, "#e0b64a"); P(1 - 1, hip + 1, 1, 1, "#fff0b8");   // belt and buckle
      P(-2 - 1, hip - 2, 1, 3, leather);                              // the belt's loose end
      P(tl + 1, sh - 1, 3, 1, cd); P(tl + 3, sh - 1, 1, 1, "#e0b64a");   // an epaulette
      break;
    }
    case "tshirt": {
      const c = a.top, cd = a.topD, bolt = "#ffe066";
      shell(c, 0, cd);
      P(-2 - 1, sh, 5, 1, cd); P(-1 - 1, sh, 3, 1, a.skinD);              // the neck band
      P(1 - 1, hip + 9, 2, 1, bolt); P(0 - 1, hip + 8, 2, 1, bolt); P(-1 - 1, hip + 7, 4, 1, bolt); P(1 - 1, hip + 6, 2, 1, bolt); P(0 - 1, hip + 5, 2, 1, bolt); P(0 - 1, hip + 4, 1, 1, bolt);   // a lightning bolt
      P(2 - 1, hip + 7, 1, 1, "#fff6c2");
      P(tl + 3, hip + 1, W - 4, 1, shade(c, 1.12));
      break;
    }
    default: {                                                     // sweater over a collared shirt
      const c = a.top, cd = a.topD, cl = shade(c, 1.24);
      shell(c, 0, cd);
      P(tl + 1, hip, W - 1, 2, cd); for (let x = tl + 2; x < tr; x += 2) P(x - 1, hip, 1, 2, shade(c, 0.66));   // ribbed hem
      P(tl + 3, sh - 5, W - 3, 2, cl); P(tl + 3, sh - 5, W - 3, 1, shade(cl, 0.9)); P(tl + 1, sh - 5, 2, 2, shade(cl, 0.8));   // a stripe across the chest
      P(-3 - 1, sh, 7, 1, cd); P(-1 - 1, sh, 3, 1, a.skinD);              // crew neck
      P(-2 - 1, sh - 1, 1, 1, "#f6f6f6"); P(1 - 1, sh - 1, 1, 1, "#f6f6f6");   // collar points
      strap();
    }
  }
}

function drawSkirt(P, a, g) {                                       // an A-line skirt with a pleat
  const { tl, hip } = g, W = a.width, c = a.skirt, cd = shade(c, 0.76), line = soft(c);
  P(tl - 1, hip - 8, W + 2, 1, line);
  P(tl, hip - 4, W, 4, c); P(tl - 1, hip - 7, W + 2, 3, c);
  P(tl - 1, hip - 7, 2, 3, cd); P(tl, hip - 4, 2, 4, cd);
  P(-1, hip - 7, 1, 6, cd); P(3, hip - 7, 1, 4, cd);
  P(tl - 1, hip - 7, W + 2, 1, shade(c, 1.3));                      // a light band at the hem
}

function drawBack(P, a, g) {                                      // things worn behind the body
  if (a.pack) {
    const c = a.pack, cd = shade(c, 0.74), cl = shade(c, 1.25), x = g.tl - 5, y = g.hip + 1, h = g.sh - g.hip - 2;
    pill(P, x, y, 5, h, c);
    P(x, y, 1, h, cd); P(x, y, 5, 1, cd);
    P(x, y + h - 3, 5, 1, cd); P(x + 1, y + h - 2, 3, 1, cl);     // the top flap catches the light
    P(x + 1, y + 1, 3, 3, cd); P(x + 1, y + 3, 3, 1, cl);         // a front pocket
    P(x + 2, y + h - 4, 1, 2, "#e0b64a");                          // a buckle
    P(x + 2, y + h, 2, 1, cd);                                     // the grab loop
  }
}

// The head is a 14x13 rounded block (the silhouette outline included) on a short neck: big for the body, the
// way manga draws small characters, so the face has room. Faces follow manga shorthand: tall two-pixel eyes
// with a lash line and a catchlight, small mouths, brows that do the acting. Hair and hats are small pictures
// in letters (HAIR, HATS), drawn over the skull.
function drawHead(P, a, g, p, t) {
  const y = g.head;
  let eyes = p.eyes || "open", mouth = p.mouth || a.mouth;
  if (eyes === "open" && a.lids) eyes = "down";                  // a cool half-lidded look
  if (eyes === "closed" && (mouth === "smile" || p.blush)) eyes = "happy";
  if (mouth === "smile" && a.grin) mouth = "grin";
  const hat = HATS[a.head] || null, hair = HAIR[a.style] || HAIR.short, veil = a.head === "hijab";
  drawHairBack(P, a, g, y, t, p);
  drawMaps(P, a, g, "behindHead", t);
  if (a.outfit === "hoodie") { P(-8, g.sh, 6, 4, a.top); P(-8, g.sh, 6, 1, a.topD); P(-8, g.sh + 1, 1, 3, a.topD); P(-6, g.sh + 3, 3, 1, shade(a.top, 1.2)); }   // the hood bunched behind the neck
  P(-1, g.sh + 1, 3, 1, a.skinD); P(1, g.sh + 1, 1, 1, shade(a.skinD, 0.86));   // neck, in the chin's shadow
  // the skull: a soft jaw, the far side in shade
  P(-5, y + 3, 12, 7, a.skin); P(-4, y + 2, 10, 1, a.skin); P(-2, y + 1, 7, 1, a.skin); P(-4, y + 10, 10, 1, a.skin); P(-3, y + 11, 8, 1, a.skin);
  if (hair.bald && !hat) { P(-1, y + 12, 4, 1, a.skin); P(-1, y + 11, 5, 1, a.skinL); P(0, y + 12, 2, 1, a.skinL); P(3, y + 10, 2, 1, a.skinL); }
  if (!veil) { P(-5, y + 3, 1, 7, a.skinD); P(-4, y + 2, 2, 1, a.skinD); P(-4, y + 3, 1, 2, a.skinD); P(-2, y + 1, 2, 1, a.skinD); }
  if (veil) art(P, a, HIJAB, -8, y + 14, a.veilPal);
  drawFace(P, a, y, eyes, mouth, p);
  if (!veil) {
    if (hair.top && !hat) art(P, a, hair.top[1], -9, y + hair.top[0], a.hairPal);
    if (hair.side) art(P, a, hair.side[1], -9, y + hair.side[0], a.hairPal);
    if (!hair.ears) { P(-4, y + 4, 2, 3, a.skin); P(-4, y + 4, 1, 3, a.skinD); P(-3, y + 5, 1, 1, a.skinD); }   // ear
    if (hair.extra) hair.extra(P, a, y, t, !!hat);
  }
  drawBrows(P, a, y, eyes, mouth, p);
  drawGlasses(P, a, y, eyes, p, t);
  if (a.pencil && !veil) { P(-9, y + 7, 1, 1, "#e8838a"); P(-8, y + 7, 3, 1, "#f2c94c"); P(-5, y + 7, 1, 1, "#e8d9b0"); P(-4, y + 7, 1, 1, "#3d3d45"); }   // tucked behind the ear
  if (hat) hat(P, a, y, p, t);
  drawMaps(P, a, g, "head", t);
}

// Eyes are at x 0 and x 4, three rows tall; the mouth sits between and below them.
function drawFace(P, a, y, eyes, mouth, p) {
  const e = a.eye, ed = a.eyeD, small = a.face === "round" || a.face === "browline";
  for (const front of [false, true]) {
    const ex = front ? 4 : 0, out = front ? ex + 2 : ex - 1;
    switch (eyes) {
      case "closed": P(ex, y + 5, 2, 1, INK); if (a.lash) P(out, y + 4, 1, 1, INK); break;
      case "happy": P(ex - 1 + (front ? 1 : 0), y + 5, 1, 1, INK); P(ex + (front ? 1 : 0), y + 6, 1, 1, INK); P(ex + 1 + (front ? 1 : 0), y + 5, 1, 1, INK); break;
      case "down": P(ex, y + 6, 2, 1, a.skinD); P(ex, y + 5, 2, 1, INK); P(ex, y + 4, 2, 1, e); break;
      case "wide": P(ex, y + 7, 2, 1, INK); P(ex, y + 4, 2, 3, e); P(ex + 1, y + 6, 1, 1, ed); P(ex, y + 6, 1, 1, WHITE); P(ex + 1, y + 4, 1, 1, WHITE); break;
      case "up": P(ex, y + 7, 2, 1, INK); P(ex, y + 5, 2, 2, e); P(ex, y + 6, 1, 1, WHITE); P(ex + 1, y + 6, 1, 1, ed); break;
      default:
        if (small) { P(ex, y + 5, 2, 1, INK); P(ex, y + 4, 2, 1, e); P(ex, y + 5, 1, 1, ed); }   // behind glasses: a neat dot
        else { P(ex, y + 6, 2, 1, INK); P(ex, y + 5, 2, 1, ed); P(ex, y + 4, 2, 1, e); P(ex, y + 5, 1, 1, WHITE); }
    }
    if (a.lash && (eyes === "open" || eyes === "wide" || eyes === "up"))   // lashes: the lid's line runs on past the outer corner and dips
      P(out, y + (eyes === "open" ? (small ? 4 : 5) : 6), 1, 1, INK);
  }
  if (p.blush) { P(-3, y + 3, 2, 1, BLUSH); P(5, y + 3, 2, 1, BLUSH); }
  else if (a.rosy) { P(-3, y + 3, 2, 1, a.cheek); P(6, y + 3, 1, 1, a.cheek); }
  if (a.freckles) { const f = mix(a.skin, "#8a4a2a", 0.4); P(-1, y + 3, 1, 1, f); P(1, y + 3, 1, 1, f); P(5, y + 3, 1, 1, f); P(2, y + 4, 1, 1, f); P(3, y + 5, 1, 1, f); }
  if (p.soot) { const s = "#5c5f66"; P(-1, y + 2, 2, 1, s); P(4, y + 8, 2, 1, s); P(-3, y + 8, 1, 1, s); P(6, y + 2, 1, 1, s); P(2, y + 9, 1, 1, s); }
  if (a.nose) { P(7, y + 4, 1, 2, a.skin); P(6, y + 3, 2, 1, a.skinD); }   // a proper nose, in profile
  const lip = mix(a.skin, MOUTH, 0.5), line = mix(a.skin, MOUTH, 0.75);
  switch (mouth) {
    case "smile": P(2, y + 3, 1, 1, line); P(3, y + 2, 2, 1, MOUTH); P(5, y + 3, 1, 1, line); break;
    case "grin": P(2, y + 2, 4, 1, MOUTH); P(3, y + 1, 2, 1, MOUTH); P(3, y + 2, 2, 1, WHITE); break;   // open, teeth showing
    case "o": P(3, y + 1, 2, 2, MOUTH); break;
    case "flat": P(2, y + 2, 3, 1, MOUTH); break;
    case "smirk": P(3, y + 2, 2, 1, MOUTH); P(5, y + 3, 1, 1, line); break;
    default: P(3, y + 2, 2, 1, lip);
  }
  const c = a.hair;
  if (a.facial === "walrus") {                                    // it hides the whole mouth
    P(1, y + 3, 6, 1, c); P(1, y + 2, 2, 1, c); P(5, y + 2, 2, 1, c); P(1, y + 1, 1, 1, a.hairD); P(6, y + 1, 1, 1, a.hairD);
    P(2, y + 3, 2, 1, a.hairL); P(5, y + 3, 1, 1, a.hairL); P(3, y + 2, 2, 1, shade(a.skin, 0.62));
  }
  if (a.facial === "mustache") { P(2, y + 3, 4, 1, c); P(1, y + 2, 1, 1, c); P(6, y + 3, 1, 1, c); P(7, y + 3, 1, 1, c); P(8, y + 4, 1, 1, c); P(3, y + 3, 1, 1, a.hairL); }   // waxed, one end curled up
}

// Brows act: raised in surprise, knitted in doubt, one up for a skeptic. Over bangs or a hat's edge they are
// drawn in a color that shows against it, as manga draws brows through the hair.
function drawBrows(P, a, y, eyes, mouth, p) {
  const kind = p.brow || (eyes === "wide" || eyes === "up" ? "raise" : mouth === "flat" ? "worry" : a.brow);
  const back = a.bushy ? -1 : 0, w = a.bushy ? 3 : 2;
  const B = (x, yy, ww = w) => P(x, y + yy, ww, 1, yy >= a.fringe ? a.browHi : a.browC);
  if (kind === "flat" && (a.face === "browline" || a.fringe <= 8)) return;   // the frames do the job, or bangs cover them
  switch (kind) {
    case "raise": B(back, 9); B(4, 9); break;
    case "stern": B(back, 9, w - 1); B(1, 8, 1); B(4, 8, 1); B(5, 9, w - 1); break;
    case "worry": B(back, 8, w - 1); B(1, 9, 1); B(4, 9, 1); B(5, 8, w - 1); break;
    case "skeptic": B(back, 8); B(4, 9); B(6, 8, 1); break;
    default: B(back, 8); B(4, 8);
  }
}

function drawGlasses(P, a, y, eyes, p, t) {
  if (!a.face) return;
  const shine = p.glint || (t + a.phase) % 7.3 < 0.22;           // now and then the lenses catch the light
  const lens = (ex, y0, h) => {
    if (!(shine || p.screen)) return;
    P(ex, y + y0, 2, h, p.screen ? "#bfe9ff" : "#eef8ff");
    P(ex + 1, y + y0 + h - 1, 1, 1, WHITE); P(ex, y + y0, 1, 1, WHITE);
  };
  if (a.face === "round") {                                       // big round frames in their own color
    const f = a.frame, fd = shade(f, 0.7);
    for (const ex of [0, 4]) {
      P(ex, y + 6, 2, 1, a.skinL); lens(ex, 4, 3);
      P(ex, y + 7, 2, 1, f); P(ex, y + 3, 2, 1, fd);
    }
    P(-1, y + 4, 1, 3, f); P(6, y + 4, 1, 3, f); P(2, y + 5, 2, 1, f); P(2, y + 4, 1, 1, fd); P(3, y + 6, 1, 1, f);   // the rims and the bridge
    P(-4, y + 6, 3, 1, fd);                                        // the arm, back to the ear
  } else if (a.face === "browline") {                             // a heavy top bar, thin wire below
    const wire = "#aab2bd";
    for (const ex of [0, 4]) { lens(ex, 4, 3); P(ex, y + 3, 2, 1, wire); P(ex - 1, y + 4, 1, 2, wire); P(ex + 2, y + 4, 1, 2, wire); P(ex - 1, y + 6, 4, 2, INK); P(ex, y + 6, 2, 1, a.skin); P(ex, y + 7, 1, 1, "#4a4f5c"); }
    P(3, y + 6, 1, 1, wire); P(-4, y + 7, 3, 1, INK);
  } else if (a.face === "halfmoon") {                             // half-moon readers, low on the nose, on a chain
    const gold = "#d9a520", dim = "#a87a14";
    for (const ex of [0, 4]) { P(ex, y + 3, 2, 1, gold); P(ex - 1, y + 4, 1, 1, gold); P(ex + 2, y + 4, 1, 1, gold); if (shine) P(ex, y + 4, 2, 1, "#eef8ff"); }
    P(3, y + 4, 1, 1, dim);
    P(-2, y + 3, 1, 1, dim); P(-3, y + 2, 1, 1, gold); P(-4, y + 1, 1, 1, dim); P(-4, y - 1, 1, 1, gold);   // the chain
  }
}

function drawHairBack(P, a, g, y, t, p) {                        // hair and cloth that hang behind the head
  const c = a.hair, d = a.hairD, l = a.hairL;
  if (a.head === "hijab") {                                       // the scarf's tail, down the back
    P(-9, y - 5, 4, 7, a.hijabD); P(-9, y - 5, 1, 7, shade(a.hijab, 0.55)); P(-8, y - 6, 2, 1, a.hijabD);
    return;
  }
  switch (a.style) {
    case "long": {                                                // down past the shoulders, the tips swaying
      const sway = (p.legF || 0) !== 0 ? Math.sign(p.legF) : Math.round(Math.sin(t * 2.1 + a.phase) * 0.6);
      P(-8, y - 3, 4, 11, c); P(-9, y, 1, 6, c);
      P(-8 + sway, y - 6, 4, 3, c); P(-7 + sway, y - 7, 2, 1, c); P(-8 + sway, y - 6, 1, 1, d);
      P(-5, y - 4, 1, 10, d); P(-8, y - 3, 1, 3, d);
      P(-7, y - 1, 1, 6, l); P(-6, y - 5, 1, 3, l);
      break;
    }
    case "bob": P(-7, y + 1, 3, 4, d); break;
    case "bigcurly": P(-9, y + 2, 4, 3, d); P(-8, y + 1, 2, 1, d); break;
  }
}

// Hair, as pictures: `top` is everything from the crown to the hairline (left off under a hat), `side` what
// shows below a hat's edge too. Each is [its top row above the head's base row, rows], 18 wide from x = -9
// (the skull's skin is x -5 to 6, the eyes x 0 and 4, the ear x -4 to -3). `ears: true` covers the ear.
const HAIR = {
  short: {                                                        // fluffy, with a fringe to the brows
    top: [14, [".......hhhhhhhh...",
               ".....hhhhllhhhhhh.",
               "....hhhhlhhhhhhhh.",
               "...hhHhhhhhhhhhhh.",
               "...hHhhhhhhhhhhhh.",
               "...HHhhHh.hhH.hhH."]],
    side: [9, ["...HHh............",
               "...HHhh.........h.",
               "...HHh............",
               "...HH.............",
               "....H............."]],
    extra(P, a, y, t, hat) {
      if (!a.ahoge || hat) return;                                // the one strand that never lies down
      const k = Math.sin(t * 2.6 + a.phase) > 0.2 ? 1 : 0;
      P(1, y + 15, 1, 1, a.hair); P(1, y + 16, 1, 1, INK); P(1 + k, y + 17, 1, 1, INK); P(2 + k, y + 18, 2, 1, INK); P(4 + k, y + 17, 1, 1, INK);
    },
  },
  tousled: {                                                      // thick and pushed back, a quiff at the front
    top: [15, ["...........hh.h...",
               "......hhhhhhhhhh..",
               ".....hhhhllhhhhhh.",
               "....hhhhlhhhhhhhh.",
               "...hhHhhhhhhhhhhh.",
               "...hHhhhhhhhhhhhh.",
               "...HHHhhh....hhhH."]],
    side: [9, ["...HHH............",
               "...HHhh...........",
               "...HHh............",
               "...HH.............",
               "...H.............."]],
  },
  receding: {                                                     // a shining dome, tufts flying out at the sides, three loyal hairs
    bald: true,
    side: [10, ["....hh............",
                "...hhlh...........",
                "..hhlhhh..........",
                ".hhlhhh...........",
                ".hhhhh............",
                "..hhHh............",
                "....HH............"]],
    extra(P, a, y, t, hat) {
      if (hat) return;
      const k = Math.sin(t * 3 + a.phase) > 0.4 ? 1 : 0;
      for (const x of [-1, 1, 3]) { P(x, y + 13, 1, 1, INK); P(x + k, y + 14, 1, 1, INK); }
    },
  },
  bob: {                                                          // a glossy bob with blunt bangs, curling in at the jaw
    ears: true,
    top: [14, ["......hhhhhhhhh...",
               "....hhhhhhhhhhhh..",
               "...hhhlllllllhhhh.",
               "...hhhhhhhhhhllhh.",
               "...hhhhhhhhhhhhhh.",
               "...hHhhhhhhhhhhhh."]],
    side: [8, ["...hHhHhhHhhHhhhh.",
               "...hHh..........h.",
               "..hhHh..........h.",
               "..hhHh..........h.",
               "..hhHh..........h.",
               "..hhHhh........hh.",
               "...hhHh...........",
               "....hh............"]],
  },
  bigcurly: {                                                     // a cloud of curls and a bun with a pencil in it
    ears: true,
    top: [18, ["........hhhh......",
               ".......hhlhhh.....",
               ".......hHhhHh.....",
               "....hh.hhhhh.hhh..",
               "..hhhhhhhhhhhhhhh.",
               ".hhlhhhlhhhhlhhhhh",
               ".hlhhHhhhHhhhhHhhh",
               "hhhhHhhlhhhHhhhlhh",
               "hhHhhhhhhhhh.hhhHh",
               "hhhhlhhh......hhhh"]],
    side: [8, ["hhhhlhh.........hh",
               ".hhHhhh..........h",
               "hhhhhh............",
               "hhlhHh............",
               ".hhhhh............",
               "..hhHh............",
               "...hh............."]],
    extra(P, a, y, t, hat) {
      P(-3, y + 4, 1, 1, "#f6f1e4");                              // a pearl earring
      if (hat) return;
      P(-4, y + 16, 1, 1, "#3d3d45"); P(-3, y + 16, 1, 1, "#e8d9b0");               // the pencil's point, out the back of the bun
      P(4, y + 18, 1, 1, "#f2c94c"); P(5, y + 19, 1, 1, "#f2c94c"); P(6, y + 20, 1, 1, "#e8838a");
    },
  },
  long: {                                                         // bangs, and a lock framing the face
    ears: true,
    top: [14, [".......hhhhhhhh...",
               ".....hhhhllhhhhhh.",
               "....hhhhlhhhhhhhh.",
               "...hhhhhhhhhhhhhh.",
               "...hHhhhhhhhhhhhh."]],
    side: [9, ["...hHhhhh..hhh..h.",
               "...hHh..........h.",
               "..hhHh..........h.",
               "..hhHh..........h.",
               "..hhHh..........h.",
               "..hhHh..........h.",
               "..hhHh.........h..",
               "..hhHh............",
               "..hhH.............",
               "..hhH............."]],
  },
  crop: {                                                         // a tight crop: flat on top, faded at the sides, a sharp line
    top: [13, ["......hhhhhhhhh...",
               ".....hhhllhShhhh..",
               "....hhhhhhhhhhhh..",
               "....hhhhhhhhhhhh..",
               "....Hhhhhhhhhhh..."]],
    side: [8, ["....HH............",
               "....ff............",
               "....f............."]],
  },
  neat: {                                                         // a side part, swept forward and shining
    top: [14, ["......hhhhhhhhh...",
               "....hhhhhllhhhhhh.",
               "...hhHhhhhllhhhhh.",
               "...hhhHhhhhhhhhhh.",
               "...hhhhhhhhhhhhhh.",
               "...hHhhhh..hhhhhh."]],
    side: [9, ["...hHh............",
               "...HHh.........hh.",
               "...HH.............",
               "...H..............",
               "...H.............."]],
  },
  spiky: {                                                        // spikes in every direction
    top: [16, ["......h....h...h..",
               ".....hh...hhh.hh..",
               ".....hhhhhhhhhhh.h",
               "....hhhlhhhlhhhhh.",
               "...hhhlhhhhhhhhhh.",
               "....hHhhhhhhhhhhh.",
               "...hhHhhhhhhhhhh.."]],
    side: [9, ["..hhHhh.h..h..h.h.",
               ".hhHh.............",
               "..hHh.............",
               ".hhH..............",
               "..hh.............."]],
  },
};

// The hijab: wrapped close round the face over an underscarf, folded at the temple, pinned at the jaw, and
// draped over the shoulders. 17 wide from x = -8, its top row 14 above the head's base row.
const HIJAB = ["......jjjjjjj....",
               "....jjjLLjjjjjj..",
               "...jjLLjjjjjjjjj.",
               "..jjLjjjjjjjjjjj.",
               "..jjjjjjuuuuuuuj.",
               ".jjjjjjj.......j.",
               ".jjJjjj........j.",
               ".jjJjjj........j.",
               "jjjJjjj........j.",
               "jjJjjjj........j.",
               "jjJjjjj........j.",
               ".jjJjjj........j.",
               ".jjjJjgj......jj.",
               "..jjjJjjj....jj..",
               "..jjjjJjjjjjjj...",
               ".jjjjjjJjjjjjj...",
               ".jjJjjjjJjjjjjj..",
               "..jjjLjjjJjjjj..."];

const HATS = {
  cap(P, a, y) {                                                  // a cap, worn backwards: the peak behind, hair through the strap gap
    const c = a.cap;
    art(P, a, [".........cccccccc...",
               ".......ccLLcccccccc.",
               "......ccLccccccccccc",
               "......Ccccccccccshcc",
               ".CCCCCDDDDDDDDDshhDD"], -12, y + 14,
        { c, C: shade(c, 0.72), D: shade(c, 0.6), L: shade(c, 1.35), s: "#d8dde3" });
    P(-11, y + 9, 2, 1, shade(c, 0.6));                           // the peak dips
    P(0, y + 15, 2, 1, shade(c, 0.72));                           // the button on top
  },
  beanie(P, a, y, p) {                                            // a ribbed beanie with a pom-pom that bounces
    const b = a.beanie;
    art(P, a, ["......bbbbbbbb....",
               "....bbbLLbbbbbbb..",
               "...bbbLbbbbbbbbbb.",
               "...bbbbbbbbbbbbbD.",
               "...cCcCcCcCcCcCcc.",
               "...CDCDCDCDCDCDCC."], -9, y + 15,
        { b, L: shade(b, 1.3), D: shade(b, 0.72), c: shade(b, 0.9), C: shade(b, 0.66) });
    const py = y + 18 - (p.bob ? 1 : 0), q = a.pom;
    art(P, a, [".pqp.", "pqppd", ".ppd."], -1, py, { p: q, q: shade(q, 1.18), d: shade(q, 0.78) });
  },
  hardhat(P, a, y) {
    art(P, a, [".......yyyyyyy....",
               ".....yyLLyyRyyyy..",
               "....yyLyyyyRyyyyy.",
               "....yyyyyyyRyyyyy.",
               "..RRRRRRRRRRRRRRRRR"], -9, y + 14, { y: "#ffd23f", L: "#fff2a8", R: "#e0a800" });
  },
  deerstalker(P, a, y) {                                          // checked tweed, a peak each way, the flaps tied up on top
    art(P, a, ["..........fFkFf.......",
               "........ttTTttTTt.....",
               "......TTttTTttTTttT...",
               ".....tFfffTTttTTttT...",
               ".....TFfFfttTTttTTt...",
               ".BBBBbBBBBBBBBBBBBbBBB"], -11, y + 15,
        { t: "#b98d5e", T: "#8a6340", f: "#c9a172", F: "#75512f", B: "#75512f", b: "#5d3f24" });
    P(10, y + 9, 1, 1, "#75512f");                                // the front peak dips over the eyes
  },
  propeller(P, a, y, p, t) {                                      // a beanie in four colors and a spinning propeller
    art(P, a, ["......rryyybbbg...",
               "....rrryYybbBbgg..",
               "...rWryyYybbBbggg.",
               "...rrryyYybbBbggg.",
               "...RRRMMMMNNNNGGG."], -9, y + 14,
        { r: "#e74c3c", y: "#f6c915", b: "#3498db", g: "#2ecc71", R: "#b93a2d", M: "#c79d0a", N: "#2678b0", G: "#229a55",
          Y: "#f9dc5c", B: "#5faee3", W: "#ff9c8f" });
    P(0, y + 15, 2, 1, "#f6c915"); P(0, y + 16, 1, 1, "#6b6f78");
    const moving = (p.legF || 0) !== 0 || (p.legB || 0) !== 0;
    const f = Math.floor(t * 9 * (p.spin || (moving ? 2.2 : 1))) % 4, w = [9, 5, 1, 5][f];
    if (w > 1) { box(P, 1 - Math.ceil(w / 2), y + 17, Math.floor(w / 2), 1, "#e74c3c"); box(P, 1, y + 17, Math.ceil(w / 2), 1, "#3498db"); }
    else box(P, 0, y + 17, 1, 1, "#f6c915");
  },
};

// ---------- custom sprite parts: pixel maps pinned to an anchor (see SPRITES.md) ----------

// Letters a map can use without defining them: they take this visit's colors, so a custom sprite varies like the rest.
const SLOTS = { s: "skin", S: "skinD", h: "hair", H: "hairD", l: "hairL", t: "top", T: "topD", c: "shirt", p: "pants",
                P: "pantsD", o: "shoes", k: null, w: null };
function slotColor(a, ch, pal) {
  if (pal && pal[ch]) return pal[ch];
  if (ch === "k") return INK;
  if (ch === "w") return WHITE;
  return a[SLOTS[ch]] || INK;
}
function mapRows(m, t) { return m.frames ? m.frames[Math.floor(t * (m.fps || 4)) % m.frames.length] : m.rows; }
function paintMap(P, a, rows, x0, y0, pal) {      // (x0, y0) is the map's bottom-left pixel
  const h = rows.length;
  for (let i = 0; i < h; i++)
    for (let j = 0; j < rows[i].length; j++) {
      const ch = rows[i][j];
      if (ch !== ".") P(x0 + j, y0 + h - 1 - i, 1, 1, slotColor(a, ch, pal));
    }
}
// Head layers hang from the head's base row, body layers from the hips, so a map moves with every pose for free.
function drawMaps(P, a, g, layer, t) {
  if (!a.maps) return;
  for (const m of a.maps) if (m.layer === layer)
    paintMap(P, a, mapRows(m, t), m.at[0], (layer === "head" || layer === "behindHead" ? g.head : g.hip) + m.at[1], m.pal);
}

function crownOf(a) {                             // the top of the hair or hat, above the head's base row
  return { cap: 15, beanie: 18, hardhat: 14, deerstalker: 16, propeller: 18 }[a.head]
    || { bigcurly: 18, receding: 14, crop: 13, tousled: 15, spiky: 16 }[a.style] || 14;
}

// Draws the whole researcher; returns where the hands and head ended up so props can attach.
function drawBody(P, a, p, t) {
  const L = p.sit ? 4 : Math.max(5, a.legs - 2 * (p.crouch || 0));
  const bob = p.bob || 0, hip = L + bob, sh = hip + a.torso - 1;
  const tl = -Math.ceil(a.width / 2), tr = tl + a.width - 1;
  const g = { L, tl, tr, hip, sh, head: sh + 2 - (p.nod ? 1 : 0), stride: p.sit ? 0 : Math.sign(p.legF || 0) };
  g.top = g.head + 11;
  g.crown = g.head + crownOf(a);
  g.handB = drawArm(P, a, p.armB, g, true);
  drawBack(P, a, g);
  drawMaps(P, a, g, "back", t);
  if (p.sit) {                                    // on the floor, knees up a little
    const kx = Math.round(a.legs * 0.55), fx = Math.round(a.legs * 0.85);
    const line = soft(a.pants);
    box(P, tl + 1, 1, 6, 4, a.pantsD, line);
    limb(P, kx, 6, fx, 3, 4, a.pants, line); limb(P, 0, 3, kx, 6, 4, a.pants, line);
    pill(P, fx - 1, 1, 5, 2, a.shoes, soft(a.shoes)); P(fx - 1, 1, 5, 1, a.sneaker ? "#ffffff" : shade(a.shoes, 0.66));
  } else {
    drawLeg(P, a, -3, p.legB || 0, p.liftB, L, true);
    drawLeg(P, a, 1, p.legF || 0, p.liftF, L, false);
  }
  if (a.legsStyle === "skirt" && !p.sit) drawSkirt(P, a, g);
  drawTorso(P, a, g);
  drawMaps(P, a, g, "body", t);
  drawHead(P, a, g, p, t);
  g.handF = drawArm(P, a, p.armF, g, false);
  return g;
}

// ---------- props (hx, hy is the middle of the hand holding it) ----------

// A round lens in a brass rim, 7 across, its middle at (cx, cy).
function propLens(P, cx, cy, glint) {
  const rows = [1, 2, 3, 3, 3, 2, 1];
  for (let i = 0; i < 7; i++) {
    const w = rows[i], y = cy + 3 - i;
    P(cx - w, y, 2 * w + 1, 1, i < 2 ? "#f2c94c" : i > 4 ? "#a8780f" : "#d9a520");
    if (i > 0 && i < 6) P(cx - w + 1, y, 2 * w - 1, 1, glint ? "#ffffff" : i < 3 ? "#d6f3ff" : i > 3 ? "#7cc4ee" : "#a9e1fb");
  }
  P(cx - 1, cy + 1, 1, 1, "#ffffff"); P(cx - 2, cy, 1, 1, "#ffffff");
}
const PROPS = {
  tablet(P, a, hx, hy) {                        // a slate, its screen lit: a chart and a line of text
    box(P, hx - 1, hy - 3, 8, 6, "#4a5266"); P(hx - 1, hy + 2, 8, 1, "#7a849c"); P(hx - 1, hy - 3, 8, 1, "#363c4d");
    P(hx, hy - 2, 6, 4, "#4fb8ff"); P(hx, hy + 1, 6, 1, "#a8e2ff"); P(hx, hy - 2, 6, 1, "#2f8fe0");
    P(hx + 2, hy, 3, 1, "#ffffff"); P(hx + 2, hy - 1, 1, 1, "#ffe066"); P(hx + 3, hy - 1, 1, 1, "#7ee787"); P(hx + 5, hy - 1, 1, 2, "#ff8fa3");
  },
  laptop(P, a, hx, hy) {                        // open, tilted toward the viewer: an editor full of code
    box(P, hx - 3, hy - 1, 12, 2, "#b9c0cc"); P(hx - 3, hy - 1, 12, 1, "#8b93a3"); for (let x = hx - 2; x < hx + 8; x += 2) P(x, hy, 1, 1, "#6b7488");
    box(P, hx - 1, hy + 1, 10, 7, "#8b93a3"); P(hx - 1, hy + 7, 10, 1, "#c9ced8");
    P(hx, hy + 2, 8, 5, "#1f2a4d"); P(hx, hy + 6, 8, 1, "#33416b"); P(hx, hy + 6, 1, 1, "#ff6b6b"); P(hx + 1, hy + 6, 1, 1, "#ffd43b");
    P(hx + 1, hy + 5, 3, 1, "#7ee787"); P(hx + 5, hy + 5, 2, 1, "#ff9ec4"); P(hx + 2, hy + 4, 4, 1, "#79c0ff"); P(hx + 1, hy + 3, 2, 1, "#ffd43b"); P(hx + 4, hy + 3, 3, 1, "#7ee787"); P(hx + 6, hy + 2, 1, 1, "#ffffff");
  },
  phone(P, a, hx, hy) {
    box(P, hx, hy - 1, 3, 5, "#2f3440"); P(hx, hy, 3, 3, "#4fb8ff"); P(hx, hy + 2, 3, 1, "#a8e2ff");
    P(hx, hy + 1, 1, 1, "#ff8fa3"); P(hx + 2, hy + 1, 1, 1, "#ffe066"); P(hx + 1, hy, 1, 1, "#7ee787"); P(hx + 1, hy + 3, 1, 1, "#5a6275");
  },
  book(P, a, hx, hy) {                          // a hardback: spine, page edges, a gold title and a ribbon
    const c = a.book;
    box(P, hx - 1, hy - 3, 6, 8, c); P(hx - 1, hy - 3, 1, 8, shade(c, 0.6)); P(hx, hy - 3, 1, 8, shade(c, 1.25)); P(hx, hy + 4, 5, 1, shade(c, 1.25));
    P(hx + 4, hy - 2, 1, 6, "#fff4d6"); P(hx + 4, hy - 2, 1, 1, "#d9c9a0"); P(hx + 4, hy, 1, 1, "#d9c9a0"); P(hx + 4, hy + 2, 1, 1, "#d9c9a0");
    P(hx + 1, hy + 2, 3, 1, "#ffd43b"); P(hx + 1, hy, 2, 1, "#ffd43b"); P(hx + 2, hy - 5, 1, 3, "#e03131");
  },
  briefcase(P, a, hx, hy) {                     // leather, brass at the corners and the lock
    P(hx - 2, hy - 3, 5, 1, "#5a3418"); P(hx - 2, hy - 2, 1, 1, "#5a3418"); P(hx + 2, hy - 2, 1, 1, "#5a3418");
    box(P, hx - 4, hy - 9, 9, 6, "#8a5226"); P(hx - 4, hy - 4, 9, 1, "#b0713a"); P(hx - 4, hy - 9, 9, 1, "#633815"); P(hx - 4, hy - 6, 9, 1, "#633815");
    P(hx, hy - 6, 1, 2, "#ffd43b"); P(hx - 4, hy - 9, 1, 1, "#e0b64a"); P(hx + 4, hy - 9, 1, 1, "#e0b64a"); P(hx - 4, hy - 4, 1, 1, "#e0b64a"); P(hx + 4, hy - 4, 1, 1, "#e0b64a");
    P(hx - 2, hy - 5, 1, 1, "#e0b64a"); P(hx + 2, hy - 5, 1, 1, "#e0b64a");
  },
  camera(P, a, hx, hy) {                        // a silver top plate, a glass lens, a flash and the red shutter
    box(P, hx - 1, hy - 2, 7, 5, "#343a4a"); P(hx - 1, hy + 2, 7, 1, "#c9ced8"); P(hx - 1, hy - 2, 7, 1, "#232733"); P(hx - 1, hy - 1, 2, 3, "#4a5266");
    box(P, hx + 6, hy - 1, 2, 3, "#5a6275"); P(hx + 7, hy - 1, 1, 3, "#4fb8ff"); P(hx + 7, hy + 1, 1, 1, "#d6f3ff");
    P(hx + 3, hy + 3, 2, 1, "#e9ecf2"); P(hx, hy + 3, 1, 1, "#ff4d4d"); P(hx + 4, hy + 1, 1, 1, "#ffe066"); P(hx + 2, hy, 2, 1, "#ff9f1c");
  },
  magnifier(P, a, hx, hy, glint) {
    limb(P, hx + 1, hy - 1, hx + 3, hy - 3, 2, "#a0622d"); P(hx + 1, hy - 1, 1, 1, "#c98646");
    propLens(P, hx + 6, hy - 7, glint);
  },
  magnifierUp(P, a, hx, hy) {                   // carried at the ready, lens up
    limb(P, hx + 1, hy + 1, hx + 2, hy + 3, 2, "#a0622d"); P(hx + 1, hy + 2, 1, 1, "#c98646");
    propLens(P, hx + 4, hy + 7, false);
  },
  mug(P, a, hx, hy) {                           // a favorite mug, full
    P(hx - 3, hy - 1, 2, 3, "#c9ced8"); P(hx - 2, hy, 1, 1, "#8b93a3");
    box(P, hx - 1, hy - 2, 5, 5, "#ffffff"); P(hx + 3, hy - 2, 1, 4, "#d5dae3"); P(hx - 1, hy - 2, 5, 1, "#d5dae3");
    P(hx - 1, hy, 5, 1, "#ff5fa2"); P(hx + 1, hy - 1, 1, 1, "#ff5fa2"); P(hx - 1, hy + 2, 5, 1, "#7a4a22"); P(hx, hy + 2, 2, 1, "#c89b6a");
  },
};
function propClipboard(P, hx, hy, lines) {
  box(P, hx - 1, hy - 4, 8, 10, "#b9793a"); P(hx - 1, hy - 4, 8, 1, "#8a5226"); P(hx - 1, hy - 4, 1, 10, "#8a5226");
  P(hx, hy - 3, 6, 8, "#ffffff"); P(hx, hy - 3, 6, 1, "#d5dae3");
  P(hx + 1, hy + 5, 4, 1, "#8b93a3"); P(hx + 2, hy + 5, 2, 1, "#e9ecf2");
  for (let i = 0; i < Math.min(lines, 4); i++) { P(hx + 2, hy + 2 - i * 2, 2 + ((i * 7) % 3), 1, "#5a6275"); P(hx, hy + 2 - i * 2, 1, 1, "#2fb344"); }
}
function propPencil(P, hx, hy) { P(hx, hy + 1, 1, 3, "#ffd43b"); P(hx, hy + 4, 1, 1, "#c9ced8"); P(hx, hy + 5, 1, 1, "#ff8fa3"); P(hx, hy, 1, 1, "#3d3d45"); }
function propShovel(P, hx, hy, down) {
  const by = down ? 1 : 4;
  limb(P, hx, hy, hx + 8, by + 4, 2, "#b0713a"); P(hx - 1, hy + 1, 3, 1, "#e03131");
  box(P, hx + 7, by, 5, 5, "#aab2bd"); P(hx + 7, by + 4, 5, 1, "#e9ecf2"); P(hx + 7, by, 5, 1, "#6b7488"); P(hx + 8, by + 1, 1, 3, "#d5dae3");
}
function propSpyglass(P, g, ext) {               // brass, a band at every joint, glass at the end
  const y = g.head + 4, n = Math.round(ext * 3);
  const tube = (x, w, c) => { box(P, x, y, w, 3, c); P(x, y + 2, w, 1, shade(c, 1.35)); P(x, y, w, 1, shade(c, 0.72)); P(x + w - 1, y, 1, 3, "#7a5a10"); };
  tube(7, 6, "#c99a1c");
  if (n > 0) tube(13, 6, "#dcae2c");
  if (n > 1) tube(19, 5, "#ecc64a");
  if (n > 2) { P(24, y, 1, 3, "#7fd0ff"); P(24, y + 2, 1, 1, "#ffffff"); }
}
function propLapLaptop(P, x, glow) {               // on the knees, the screen tipped back toward them
  box(P, x, 8, 10, 2, "#b9c0cc"); P(x + 1, 9, 8, 1, "#e9ecf2"); for (let i = 1; i < 9; i += 2) P(x + i, 9, 1, 1, "#8b93a3");
  limb(P, x + 10, 9, x + 12, 17, 2, "#6b7488"); P(x + 10, 11, 1, 5, glow ? "#d6f8ff" : "#4fb8ff"); P(x + 10, 15, 1, 1, "#ffffff");
}
function propScroll(P, x, hy, len) {               // hangs from the hand to the floor, then rolls away along it
  const paper = "#fbf1cf", ink = "#a8895a";
  if (len > 1) {
    box(P, x, 1, 3, hy - 2, paper); for (let i = 3; i < hy - 4; i += 3) P(x + 1, i, 1, 1, ink);
    box(P, x, 1, len, 2, paper); P(x, 1, len, 1, "#e6d5a3"); for (let i = 5; i < len - 3; i += 4) P(x + i, 2, 2, 1, ink);
  }
  box(P, x + len, 1, 4, 4, "#ecd99f"); P(x + len + 1, 3, 2, 1, "#c9b06a"); P(x + len, 1, 4, 1, "#c9b06a"); P(x + len + 1, 2, 1, 1, "#e03131");   // the roll, and its wax seal
}
function propStack(P, hx, hy, n, wob, colors) {   // books, spines out: a band on each, pages at the end
  for (let i = 0; i < n; i++) {
    const dx = Math.round(Math.sin(wob + i * 0.7) * i * 0.6), w = 9 + (i % 2), c = colors[i % colors.length], x = hx - 3 + dx, y = hy + i * 4;
    box(P, x, y, w, 3, c); P(x, y + 2, w, 1, shade(c, 1.3)); P(x, y, w, 1, shade(c, 0.7));
    P(x + 1, y, 1, 3, "#ffd43b"); P(x + 3, y + 1, 3, 1, shade(c, 1.5)); P(x + w - 1, y, 1, 3, "#fff4d6");
  }
}
function propPaper(P, hx, hy) { box(P, hx, hy, 5, 6, "#ffffff"); P(hx, hy, 5, 1, "#d5dae3"); P(hx + 1, hy + 4, 3, 1, "#5a6275"); P(hx + 1, hy + 3, 2, 1, "#aab2bd"); P(hx + 1, hy + 1, 3, 1, "#e03131"); P(hx + 4, hy + 5, 1, 1, "#d5dae3"); }

// What each signature prop does to the pose while walking or standing about.
const CARRY = {
  tablet: ["forward", 0], laptop: ["forward", -1], phone: ["high", 0], book: ["forward", 0],
  briefcase: null, camera: ["forward", 0], magnifier: ["forward", 0], mug: ["forward", 0],
};

// ---------- icons and particles (drawn straight onto the stage) ----------

const ICONS = {
  bulb: ["..kkk..", ".kyyyk.", "kywyyyk", "kyyyyyk", "kyyyyyk", ".kyyyk.", "..kgk..", "..kgk..", "...k..."],
  q: [".kkkk.", "kqqqqk", "kqkkqk", ".kkqqk", "..kqk.", "..kkk.", "..kqk.", "..kkk."],
  bang: ["kkk", "kek", "kek", "kek", "kek", "kkk", "...", "kkk", "kek", "kkk"],
  heart: [".kk.kk.", "kppkppk", "kpppppk", ".kpppk.", "..kpk..", "...k..."],
  note: ["...kk.", "...kqk", "...k.k", "...k..", ".kkk..", "kqqk..", "kqqk..", ".kk..."],
  check: ["......kk", ".....kmk", "kk..kmk.", "kmkkmk..", ".kmmk...", "..kk...."],
};
const ICON_COLORS = { k: INK, y: "#ffe066", w: "#ffffff", g: "#9aa0a6", q: "#5fa8ff", e: "#ff5a5a", p: "#ff6b9a", m: "#51cf66" };
function drawIcon(ctx, map, x, y, s = 2) {
  for (let r = 0; r < map.length; r++)
    for (let c = 0; c < map[r].length; c++) {
      const ch = map[r][c];
      if (ch !== ".") { ctx.fillStyle = ICON_COLORS[ch]; ctx.fillRect(x + c * s, y + r * s, s, s); }
    }
}
const Z = ["zzz", "..z", ".z.", "z..", "zzz"];

// ---------- actions ----------
// Each action has init (sets up its own state) and run, which moves the researcher and returns a pose:
// legs, arms, eyes, mouth, plus an optional props(P, g) drawn in front of the body. `carry: true` lets the
// researcher keep holding their signature prop.

const stand = extra => Object.assign({ armF: ["swing", 0], armB: ["swing", 0] }, extra);
const breath = (r, t) => (Math.sin(t * 2.3 + r.a.phase) > 0.45 ? 1 : 0);   // a slow breath: the shoulders rise a pixel
function walkPose(r, dist) {
  const ph = dist / (1.1 + r.a.legs * 0.12), s = Math.sin(ph), c = Math.cos(ph), off = Math.round(4 * s);
  return { legF: off, legB: -off, liftF: c > 0.6 ? 1 : 0, liftB: c < -0.6 ? 1 : 0, bob: Math.abs(s) < 0.4 ? 1 : 0,
           armF: ["swing", -Math.round(2 * s)], armB: ["swing", Math.round(2 * s)] };
}
function stepToward(r, s, tx, dt, speed) {
  const d = tx - r.x;
  if (Math.abs(d) < 1) { r.x = tx; return true; }   // close enough: no turning back and forth over a pixel
  r.face = Math.sign(d);
  const m = Math.min(Math.abs(d), speed * dt);
  r.x += r.face * m; s.dist = (s.dist || 0) + m;
  return false;
}
function roomAhead(r, need) {                     // turn around if there's no room for the bit
  const [lo, hi] = r.stage.range();
  if (r.face > 0 && r.x + need > hi) r.face = -1;
  else if (r.face < 0 && r.x - need < lo) r.face = 1;
}
const QUOTES = Object.assign({
  intro: ["On it!", "Reporting in.", "Who funded this?", "Let's dig.", "Facts, please.", "Hello, sources."],
  read: ["hm.", "fascinating", "p. 412...", "a footnote!", "wait, what", "...interesting"],
  search: ["a clue!", "evidence?", "aha, a URL", "hmmmm"],
  sniff: ["sniff sniff", "smells like spin"],
  eureka: ["AHA!", "EUREKA!", "it all connects!", "It is possible that..."],
  confused: ["says who?", "huh?", "source??", "that's spin"],
  citation: ["[citation needed]", "who funded this?", "follow the money", "primary source!", "is that a fact?"],
  coffee: ["coffee #7", "*slurp*", "ahh."],
  notes: ["noted.", "*scribble*", "very suspicious"],
  dig: ["digging deeper", "found a PDF!", "buried on p. 90!"],
  typing: ["ENHANCE", "Ctrl+F", "47 tabs open", "404?!"],
  papers: ["too many sources!", "WHEE", "peer review!"],
  telescope: ["zoom.", "land ho?", "I see bias"],
  scroll: ["the full report", "terms & conditions", "appendix Q..."],
  trip: ["oof", "I'm OK!"],
  wave: ["hi!", "o/", "hello!", "busy busy"],
  stack: ["light reading", "just a few books"],
  topple: ["NOOO"],
}, LINES.quotes);


// The general library (500+ lines): academic nagging, grad-school and peer-review memes, stats and LaTeX pain,
// archive and newsroom jokes, logical fallacies, bad Latin and literary misquotes. Dealt from a shuffled deck shared by the
// whole page, so a line comes round again only after all the others have been said.
const QUIPS = LINES.quips || [
  // the classics of the margin
  "[citation needed]", "Show your work!", "Where is your bibliography?", "Don't forget logos!",
  "Ethos, pathos... LOGOS.", "Cite your sources!", "Says who, exactly?", "Source?", "Source??",
  "Is that peer-reviewed?", "According to whom?", "Primary or secondary?", "MLA or APA?",
  "Chicago style, obviously.", "Footnote it!", "Define your terms.", "Where's the thesis?",
  "Needs more sources.", "Wikipedia is not a source.", "Cite the cite.", "Who wrote this?",
  "Check the date!", "Page number, please.", "Paraphrase, don't plagiarize.", "Quotation marks!",
  "[sic]", "Allegedly.", "Reportedly...", "n = ?", "p < 0.05?", "Methodology??",
  "Show me the receipts.", "Follow the money.", "Conflict of interest?", "Is this a press release?",
  "Spin detected.", "Fact, or possibility?", "It is possible that...", "Hedge your claims!",
  "Burden of proof!", "Extraordinary claims need extraordinary evidence.", "Occam's razor!",
  "Straw man!", "Ad hominem!", "Slippery slope!", "That's begging the question.", "Red herring!",
  "Anecdote is not data.", "Cherry-picked!", "Is it reproducible?", "Retracted?!",
  "Read past the abstract.", "Fine print time.", "Check the Wayback Machine.", "Ctrl+F 'funding'",
  "Who is the source's source?", "Two sources, minimum.", "Triangulate!", "Correlation is not causation!",
  "Ibid.", "Op. cit.", "See appendix B.", "Et al. al. al.", "Per my last footnote...",
  "Reviewer 2 strikes again.", "Publish or perish!", "The margin is too small for this proof.",
  "Q.E.D.", "Lit review time!", "Annotated bibliography!", "Works cited, please.", "Vide infra.",
  "Cf. literally everything.", "Ergo...", "A priori!", "Post hoc, ergo propter hoc!", "Caveat lector.",
  "Where's the DOI?", "Paywalled. Again.", "Interlibrary loan!", "Shh! This is a library.",
  "Overdue since 1987.", "To the card catalog!", "Microfiche, anyone?", "Footnote 47b...",
  "Endnotes are a crime.", "Oxford comma, please.", "Mistakes were made. (passive voice)",
  "Too many adverbs, really.", "Kill your darlings.", "Show, don't tell.", "Word count: 3.",
  "14pt font is cheating.", "Double spaced!", "Times New Roman only.", "Margins: one inch.",
  "Rough draft #12.", "See me after class.", "Needs a counterargument.", "Steelman it!",
  "Nuance, people!", "Context matters.", "Data, or it didn't happen.", "Trust, but verify.",
  "Verify, then trust.", "Rigor!", "A footnote to a footnote.", "The plot thickens...",
  "Curiouser and curiouser.", "Office hours are now!", "Grant deadline!", "Tenure track, baby.",
  "Hypothesis: more coffee.", "Sample size of one?", "Who funded the study?", "Check the methods section.",
  "That graph has no axes!", "Label your axes!", "Units?!", "Error bars, please.", "Outlier!",
  "Statistically significant? Maybe.", "This needs a control group.", "Double-blind it!",
  "Is that a primary source?", "Quote it exactly.", "Out of context!", "Read the whole thing.",
  "Who benefits?", "Cui bono?", "Find the original.", "Screenshot or it didn't happen.",
  "That's an op-ed.", "Opinion is not evidence.", "Sounds like a press release.",
  "Thesis, antithesis, synthesis!", "Peer review incoming!", "Bold claim. Bold font?",
  // literary misquotes
  "O Romeo, wherefore art thou citations?", "To cite, or not to cite?", "Something is rotten in the footnotes.",
  "A source! A source! My kingdom for a source!", "Et tu, Reviewer 2?", "The lady doth cite too much.",
  "All the world's a peer review.", "Friends, Romans, cite your sources!", "Brevity is the soul of abstracts.",
  "Out, damned typo!", "Double, double, toil and trouble; footnote burn and draft bubble.",
  "What's in a name? A byline.", "Is this a citation I see before me?",
  "Now is the winter of our deadline.", "Parting is such sweet sorrow. Submit!",
  "It was the best of sources, it was the worst of sources.", "Call me Ishmael. Cite me properly.",
  "It is a truth universally acknowledged that a claim must want a source.",
  "All happy footnotes are alike.", "Reader, I cited him.", "So we beat on, footnotes against the current.",
  "Elementary, my dear Watson: check the source.", "The game is afoot!", "Quoth the raven: citation?",
  "Nevermore shall I trust an unsourced claim.", "I think, therefore I cite.", "Veni, vidi, citavi.",
  "Know thyself. Cite thyself.", "The unexamined source is not worth citing.",
  "Not all who wander are lost. Some are in the stacks.", "Hope is the thing with footnotes.",
  "Two roads diverged; I took the one with sources.", "Do not go gentle into that bad draft.",
  "Water, water everywhere, nor any source to cite.", "Big Brother is fact-checking you.",
  "So it goes. (citation needed)", "Don't panic. Cite.", "We are such stuff as drafts are made on.",
  "Lord, what fools these sources be!", "The course of true research never did run smooth.",
  "Cry havoc, and let slip the footnotes!", "Alas, poor Yorick! He had no sources.",
  "Once more unto the library, dear friends!", "A rose by any other name would still need a citation.",
  "Frankly, my dear, I need a DOI.", "I came, I saw, I peer-reviewed.", "Ask not what your source can do for you.",
  "Tomorrow, and tomorrow, and tomorrow: the deadline.", "Neither a borrower nor a plagiarist be.",
  "Though this be madness, yet there is method(ology) in it.", "Exit, pursued by Reviewer 2.",
  "The fault, dear Brutus, is in our sources.", "Get thee to a library!", "Beware the Ides of Deadlines.",
  "I have measured out my life with footnotes.", "April is the cruellest month. Finals.",
  "Happy families are all alike; every unsourced claim is unsourced in its own way.",
  "Whose source is this? I think I know.", "Yes, Virginia, there is a bibliography.",
  // grad school and the thesis
  "Chapter 3 is 'nearly done'.", "My thesis is 80% done. Since 2019.", "ABD: all but done.",
  "Year 6 of a 5-year PhD.", "My advisor said 'interesting'. Bad sign.", "'Interesting' is advisor for 'no'.",
  "Just one more experiment.", "I'll write it up this weekend. (narrator: no)",
  "Procrastination is a research method.", "Writing the acknowledgments first.",
  "The dedication page is done!", "Defending in 3 days. Slides: 0%.", "Committee meeting = boss fight.",
  "Advisor email at 11:58 pm.", "Quick question (it is not quick).", "Per my last email...",
  "Circling back on my prior footnote.", "Gentle reminder: the deadline was yesterday.",
  "Free pizza at the seminar!", "Will attend any talk with snacks.", "Stipend: three packs of ramen.",
  "Fieldwork means no Wi-Fi.", "My office used to be a broom closet.", "Impostor syndrome, party of one.",
  "Everyone here is smarter than me. (they all think this)", "Lab meeting moved to 8 am. Why.",
  "Dissertation: 300 pages of 'it depends'.", "It depends.", "Well... it's complicated.",
  "Sleep is for the tenured.", "Tenure: the final boss.", "Postdoc number four, here we go.",
  "My CV has a CV.", "Teaching load: yes.", "Grading 200 essays on the same prompt.",
  "Office hours: nobody. Night before exam: everyone.", "The syllabus answers that question.",
  "It's in the syllabus!", "Extra credit? In this economy?", "My dog ate my dataset.",
  // papers, hedges and results
  "Further research is needed.", "This study has limitations.", "Results were mixed.",
  "Promising preliminary results!", "Preliminary means 'we tried once'.", "Future work: everything else.",
  "Left as an exercise to the reader.", "Proof omitted for brevity.", "Trivially true. (took me 3 weeks)",
  "It is easy to see that... (it is not)", "Clearly... (not clear)", "Obviously... (not obvious)",
  "Without loss of generality!", "Assume a spherical cow.", "In a vacuum, sure.", "Works on my dataset.",
  "Data available upon reasonable request.", "No request is reasonable enough.", "Code available soon.",
  "The supplement is 400 pages.", "See supplementary figure S47.", "Figure 3 is doing a lot of work.",
  "Figure not to scale. Or legible.", "Log scale fixes everything.", "Just log-transform it.",
  "Y-axis starts at 98. Suspicious.", "Truncated axis alert!", "Pie chart? In this economy?",
  "A 3D pie chart. Absolutely not.", "Comic Sans on a poster?!", "Poster session: stand and smile.",
  "Conference Wi-Fi: theoretical.", "Abstract due in 2 hours.", "Deadline extended! (I was already late)",
  "Camera-ready means 'still editing'.", "Rebuttal letter: polite fury.",
  "We thank Reviewer 2 for their... feedback.", "Reviewer 2 wants a different paper.",
  "Reviewer 2: 'Have you considered citing me?'", "Please cite these 14 papers (all mine).",
  "Reviewer 3 just wrote 'good'.", "Major revisions. Again.", "Desk rejected in 4 minutes.",
  "Minor revisions! (they are major)", "Under review since the Bronze Age.", "Revise and resubmit, forever.",
  "Impact factor: vibes.", "h-index go brrr.", "Citation count: my mom.", "Self-citation is self-care.",
  "'Dear Esteemed Doctor, submit to our journal...'", "Invited to a conference on Everything.",
  "Open access or open wallet?", "Paywall: $39.95 for 4 pages.", "Emailing the author directly. Bold.",
  "Authors respond in 3-5 business years.", "Preprint or it didn't happen.",
  "Negative results deserve love too.", "Null result, full heart.", "That's not a bug, it's a finding.",
  "Unexpected result = new paper.", "The discussion section is where hope lives.",
  "Abstract: overpromise. Results: underdeliver.", "Novel! (it was done in 1974)",
  "To the best of our knowledge... (we didn't look)", "Title: a pun, then a colon.",
  "Every title needs a colon: and a subtitle.",
  // LaTeX, files and coauthors
  "LaTeX error on line 1. The file is one line.", "Overfull hbox, again.", "Undefined control sequence!",
  "BibTeX ate my references.", "Where did my figures float to?", "Figure 2 ended up on page 47.",
  "final_v2_FINAL_really_final.docx", "Track changes: 1,204.", "Six coauthors, six conflicting comments.",
  "Author order negotiations: ongoing.", "Corresponding author: whoever answers.",
  "Et al. is doing heavy lifting.", "Who even is 'Smith et al.'?", "Ibid. ibid. ibid. ibid.",
  "Research is 90% looking for the file.", "Where's that PDF from 2021?", "Folder 'to read': 3,000 PDFs.",
  "I'll read it later. (never)", "Highlighted the whole page. Helpful.", "Sticky notes are a lifestyle.",
  "Index cards never go out of style.", "My bibliography has a bibliography.",
  "Citation manager crashed. Weep.", "Ctrl+S. Ctrl+S. Ctrl+S.", "The autosave did not save.",
  "Shared drive, nobody's folder.", "'Untitled document (47)'",
  // statistics
  "p = 0.051. So close.", "p-hacking? I would never.", "The garden of forking paths!", "Bonferroni, please.",
  "Correct for multiple comparisons!", "Bayesian, actually.", "My prior says no.", "Update your priors!",
  "Regression to the mean!", "Survivorship bias!", "Selection bias!", "Confounder spotted.",
  "Simpson's paradox lurks.", "Base rate fallacy!", "Margin of error?", "Weighted how, exactly?",
  "Confidence interval wider than my hopes.", "Effect size: tiny.", "Underpowered study!",
  "Overfit and proud.", "All models are wrong.", "Some models are useful.",
  "Torture the data long enough and it confesses.", "The data spoke. It mumbled.",
  "Excel turned my genes into dates.", "Who put a merged cell here?", "A CSV with commas in the data. Pain.",
  "N/A is not zero!", "Mean or median? It matters!", "Averages lie politely.",
  "Dropping outliers until it works...", "Replication crisis? What crisis?", "Pre-register it!",
  "HARKing detected.", "One weird chart statisticians hate.", "Spurious correlation of the day.",
  "Cheese consumption predicts bedsheet deaths.", "Lies, damned lies, and bar charts.",
  // libraries and archives
  "Ask a librarian. They know everything.", "Librarians: the original search engine.",
  "Book returned 31 years late.", "The stacks after dark: spooky.", "Quiet floor. Loud thoughts.",
  "Microfilm reader warming up...", "The archive is in a basement. Of course.", "Rare books room: gloves on.",
  "Pencils only in the archive!", "Found it in a box labeled 'misc'.", "Finding aid: no aid.",
  "Box 47, folder 'other'.", "The answer is in a 1974 memo.", "FOIA filed. See you in 2031.",
  "Redacted. Redacted. 'the'. Redacted.", "Page 3 of 2?", "Scanned upside down. Of course.",
  "The PDF is a photo of a printout.", "OCR thinks 'Senate' says 'Sonata'.", "The footnote is a dead link.",
  "404: source not found.", "Link rot!", "Archived copy, thank goodness.", "Card catalog nostalgia.",
  "Due date stamped 1962.", "Someone wrote 'WRONG' in the margin. Hero.", "Marginalia from 1890 > the book.",
  "Interlibrary loan: 6-8 weeks of hope.",
  // newsroom and fact-checking
  "Who said it, and when?", "On the record, or off?", "Anonymous sources say... hmm.",
  "One source is a rumor.", "Two sources is a story.", "Read the filing, not the post.",
  "Read the bill, not the summary.", "Check the meeting minutes!", "Meeting minutes: actually hours.",
  "The appendix is where secrets live.", "Don't bury the lede!",
  "That headline wrote a check the story can't cash.", "Clickbait. Close tab.",
  "Press release wearing a news costume.", "Astroturf detected.", "Think tank? Thinking about funding.",
  "Funded by 'Citizens for Good Things'.", "A shell company in a shell company.", "Follow the LLC.",
  "Annual report, page 212: the good stuff.", "The quiet part, said loud.",
  "Spokesperson declined to comment. Classic.", "'No comment' is a comment.", "Hedging: may, might, could.",
  "Weasel words!", "'Experts say.' Which experts?", "'Studies show.' Which studies?",
  "'Many people are saying.' Who?", "'Sources familiar with the matter.' Hmm.",
  "Allegedly, allegedly, allegedly.", "Corrections appended below.", "Updated at 3:47 am. Why?",
  "Embargoed until Tuesday.", "The lobbyist wrote the bill. Literally.", "Check the metadata!",
  "Who registered the domain?", "Reverse image search time.", "That photo is from 2014.",
  // logic and laws of nature
  "Is-ought gap!", "Category error!", "No true Scotsman!", "Tu quoque!", "Appeal to authority!",
  "Appeal to nature!", "False dichotomy!", "Moving the goalposts!", "Motte and bailey!",
  "Gish gallop incoming.", "Texas sharpshooter!", "Sunk cost, but for drafts.", "Hume would ask for evidence.",
  "Descartes doubted this too.", "Socrates would ask six more questions.", "Epistemology hours: open.",
  "How do we know what we know?", "Define 'know'.", "Ship of Theseus, but it's my draft.",
  "Schrödinger's citation: real and fake.", "Heisenberg's deadline: certainly late.",
  "Murphy's law of footnotes.", "Hanlon's razor, maybe.", "Chesterton's fence: ask first.",
  "Goodhart's law strikes!", "Debunking costs ten times more.", "Peak of Mount Stupid.",
  "Streisand effect incoming.", "Occam's razor needs sharpening.", "Russell's teapot of evidence.",
  "Bayes would want a base rate.",
  // coffee, time and rabbit holes
  "Coffee is a research grant.", "Fueled by caffeine and spite.", "Espresso: the true peer reviewer.",
  "It's 3 am. Perfect time for a footnote.", "Golden hour: 2 am in the library.", "Deadline-driven research.",
  "Five more minutes of reading. (3 hours)", "Just checking one thing. (47 tabs)", "Rabbit hole: entered.",
  "How did I get to this Wikipedia page?", "Wikipedia's citations are the good part.",
  "The rabbit hole has footnotes.", "Hold my beaker.", "I'm not arguing, I'm citing.",
  "Trust me, I'm a researcher. (don't)", "Correlation, causation, and their cousin coincidence.",
  "Science! (results may vary)",
  // Latin, badly
  "Lorem ipsum dolor sit cite.", "Carpe datum.", "In vino veritas, in data dubitas.",
  "Quis custodiet ipsos reviewers?", "Sapere aude: dare to check.", "Res ipsa loquitur. It doesn't.",
  "Mea culpa: wrong citation.", "Nota bene!", "Ad nauseam.", "Sic transit gloria deadline.",
  "Errare humanum est. Errata too.", "E pluribus footnotes.", "Tempus fugit. The deadline approacheth.",
  // more literary misquotes
  "Hell is other people's footnotes.", "Abandon all hope, ye who enter page 300.",
  "In the beginning was the draft.", "It was a dark and stormy deadline.",
  "Last night I dreamt I went to the archives again.", "Brave new bibliography.", "Of mice and methods.",
  "The old man and the citation.", "Pride and peer review.", "Crime and publication.", "War and peer review.",
  "Great expectations, mixed results.", "One hundred years of revisions.",
  "Infinite jest, infinite footnotes.", "A tale of two datasets.", "The importance of being cited.",
  "Waiting for Reviewer 2.", "The catcher in the citations.", "Moby-Dick: 600 pages of whale methods.",
  "Gatsby believed in the green footnote.", "Not with a bang but a footnote.", "Frankenstein's dataset lives!",
  "The Count of Monte Footnote.", "Around the world in 80 citations.",
  "Twenty thousand leagues under the paywall.",
];
const QUIP_DECK = "researcher:quips:" + QUIPS.length;   // a bigger library deals a fresh deck
function nextQuip() {
  let deck = memory.get(QUIP_DECK);
  if (!Array.isArray(deck) || !deck.length) deck = shuffle(QUIPS.map((_, i) => i));
  const i = deck.pop();
  memory.set(QUIP_DECK, deck);
  return QUIPS[i] || QUIPS[0];
}
// A Chinese character carries about as much as a short word, so it counts for more reading time.
const WIDE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/g;
const readTime = text => clamp(1.6 + (text.length + 2 * (text.match(WIDE) || []).length) * 0.055, 1.8, 5);

// ---------- little bits of everyday research life: pixel maps, props and helpers ----------
// A pixel map is a list of rows, top to bottom, drawn facing right; "." is empty and each letter a color.
// "L" is left for the caller to choose (a flower's petals, a flask's liquid).
const PAL = Object.assign({}, ICON_COLORS, { r: "#e03131", o: "#f08c00", G: "#2b8a3e", m: "#8ce99a", M: "#2f9e44",
  b: "#4dabf7", B: "#8d5a2b", n: "#ced4da", N: "#495057", t: "#e9c46a", v: "#b197fc", h: "#fff3bf", c: "#ffa94d",
  C: "#e8590c", W: "#fff4e6", D: "#1c7ed6", R: "#a61e1e", Y: "#f59f00" });
const BILL = ["mmmmmmmm", "mMmMMmMm", "mmmmmmmm"];
const FLOWER = [".LLL.", "LLyLL", ".LLL.", "..G..", ".GG..", "..GG.", "..G.."];
const FLOWER_HELD = [".L.", "LyL", ".G.", ".G."];
const BIRD_UP = ["D....D..", ".b..b...", "..bbkbo.", "..bWWb.."];
const BIRD_DOWN = ["........", "..bbkbo.", ".bbWWb..", "D....D.."];
const BIRD_SIT = ["...bb...", "..bkbo..", ".DDbW...", "..o.o..."];
const CAT_A = ["........c.c.", "C.......cccc", ".c......cckW", ".cCccCccCccc", "..cWWWWWWcc.", "..c.c...c.c.", "..W.W...W.W."];
const CAT_B = ["........c.c.", "C.......cccc", ".c......cckW", ".cCccCccCccc", "..cWWWWWWcc.", "...c.c..c.c.", "..W...W.W..W"];
const CAT_SIT = [".....c.c", ".....ccc", ".....ckW", "..cCcccc", ".cCccWWc", "CcccCWWc", "C.cc.WW."];
const ROCKET = ["..r..", ".rrR.", ".wbn.", ".wDn.", ".wwn.", "rwwnR", "r.N.R"];
const PLANE = ["ww.......", ".wwwww...", "..wwwwwww", "..nnnn..."];
const APPLE = ["..B..", ".rGm.", "rWrrR", "rrrrR", ".rRR."];
const DUCK = ["...yy.", "...yko", "yyYyy.", "yyyYy.", ".YYY.."];
const GERM_A = [".m.m.", "mmmmm", "mkmkm", "mmmmm", "m.m.m"];
const GERM_B = ["m.m.m", "mmmmm", "mkmkm", "mmmmm", ".m.m."];
const BFLY_A = ["v.k.v", "vvkvv", "vpkpv", "v.k.v"];
const BFLY_B = ["..k..", ".vkv.", ".vkv.", "..k.."];
const CAP_FLAT = ["NNNNNNNNN", "...NNN..y", "...NNN..y"];
const CAP_EDGE = ["NNN", "NNN", ".Ny"];
const BALL = [".w.", "www", ".w."];
const FLASK = ["..n..", ".nwn.", ".nLn.", "nLLLn", "nLLLn", ".nnn."];

// A pixel map held or set down, in the researcher's frame: (x, y) is its bottom-left corner.
function pmap(P, map, x, y, pal) {
  const h = map.length;
  for (let i = 0; i < h; i++)
    for (let j = 0; j < map[i].length; j++) {
      const ch = map[i][j];
      if (ch !== ".") P(x + j, y + h - 1 - i, 1, 1, (pal && pal[ch]) || PAL[ch]);
    }
}
// A pixel map straight on the stage, outlined like the researchers: (cx, by) is its bottom middle.
function drawMap(ctx, map, cx, by, flip, rot, pal) {
  const h = map.length, w = map[0].length, ox = -(w >> 1), oy = -h + 1;
  ctx.save();
  ctx.translate(cx, by);
  if (rot) { ctx.translate(0, -h / 2); ctx.rotate(rot); ctx.translate(0, h / 2); }
  for (const pass of [0, 1])
    for (let i = 0; i < h; i++)
      for (let j = 0; j < w; j++) {
        const ch = map[i][j];
        if (ch === ".") continue;
        const x = ox + (flip < 0 ? w - 1 - j : j), y = oy + i;
        if (pass === 0) { ctx.fillStyle = darkOf((pal && pal[ch]) || PAL[ch] || INK); ctx.fillRect(x - 1, y - 1, 3, 3); }
        else { ctx.fillStyle = (pal && pal[ch]) || PAL[ch]; ctx.fillRect(x, y, 1, 1); }
      }
  ctx.restore();
}
function thin(P, x0, y0, x1, y1, c, skip) {      // a one-pixel line; skip(i) leaves gaps for a pour or a dash
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) if (!skip || !skip(i)) P(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), 1, 1, c);
}
const ahead = (r, d) => r.x + r.face * d;                        // a stage x this far in front of the researcher
const near = (r, d) => (r.stage.kind === "flow" ? Math.min(d, 8) : d);   // steps on the strip are short
function item(r, map, d, extra) {                                // something lying on the floor in front of them
  const [lo, hi] = r.stage.range();
  const p = Object.assign({ kind: "map", map, x: clamp(ahead(r, d), lo, hi), y: 0, life: 30, flip: r.face }, extra || {});
  return r.stage.add(p) || p;
}
function vanish(p) { if (p && p.life > 0.4) { p.life = 0.4; p.max = 0.4; p.fade = true; } }
// Walk over to stage x `tx`, stopping just short so it ends up at their feet. A walking pose, or null once there.
function walkTo(r, s, dt, tx, gap = 9) {
  if (s.there) return null;
  const dir = Math.sign(tx - r.x) || r.face;
  if (stepToward(r, s, tx - dir * gap, dt, r.a.speed)) { s.there = s.t; r.face = dir; return null; }
  r.y = r.stage.hop(r.x);
  return stand(Object.assign(walkPose(r, s.dist || 0), { carry: true }));
}

function propBoard(P, x, rows, prog, q) {           // a chalkboard on an easel, filling with chalk "math"
  const wood = "#a0622d", woodD = "#70401a", woodL = "#c98646";
  thin(P, x + 3, 0, x + 5, 8, woodD); thin(P, x + 19, 0, x + 17, 8, woodD); thin(P, x + 11, 0, x + 11, 6, woodD);
  P(x - 1, 7, 24, 17, wood); P(x - 1, 23, 24, 1, woodL); P(x - 1, 7, 1, 17, woodD); P(x + 22, 7, 1, 17, woodD);
  P(x, 8, 22, 15, "#2f6f55"); P(x, 22, 22, 1, "#3f8a6c"); P(x, 8, 22, 1, "#22523f"); P(x + 16, 9, 5, 2, "#3a7f63");
  P(x - 2, 6, 26, 1, woodL); P(x - 2, 5, 26, 1, woodD);                             // the ledge, with chalk and a duster
  P(x + 2, 7, 3, 1, "#ffffff"); P(x + 6, 7, 2, 1, "#ff9ec4"); P(x + 15, 7, 4, 1, "#5a6275"); P(x + 15, 8, 4, 1, "#e9ecf2");
  const total = rows.reduce((a, b) => a + b, 0);
  let left = Math.round(prog * total);
  rows.forEach((len, i) => {
    const y = 20 - i * 3, n = Math.min(len, left), chalk = ["#ffffff", "#ffe066", "#a8e2ff", "#ffb3c7"][i % 4];
    left -= n;
    for (let c = 0; c < n; c++) {
      if (c % 4 === 3) continue;
      P(x + 2 + c, y, 1, 1, chalk);
      if ((c * 7 + i * 3) % 5 === 0) P(x + 2 + c, y + 1, 1, 1, chalk);
    }
  });
  if (prog >= 1) {
    if (q) { P(x + 17, 18, 3, 1, "#ffe066"); P(x + 19, 15, 1, 3, "#ffe066"); P(x + 18, 14, 1, 1, "#ffe066"); P(x + 18, 11, 1, 1, "#ffe066"); }
    else { const y = 20 - (rows.length - 1) * 3; P(x + 1, y - 1, rows[rows.length - 1] + 2, 1, "#ff6b6b"); P(x + 1, y + 2, rows[rows.length - 1] + 2, 1, "#ff6b6b"); }
  }
}
function propCork(P, x, pts, notes) {                 // a corkboard with sticky notes and red string
  const wood = "#a0622d", woodD = "#70401a", woodL = "#c98646", NOTE = ["#ffe066", "#ff9ec4", "#8fd3ff", "#b2f2bb", "#ffc078"];
  thin(P, x + 3, 0, x + 5, 7, woodD); thin(P, x + 19, 0, x + 17, 7, woodD);
  P(x - 1, 6, 24, 19, wood); P(x - 1, 24, 24, 1, woodL); P(x - 1, 6, 1, 19, woodD); P(x + 22, 6, 1, 19, woodD);
  P(x, 7, 22, 17, "#d9a868"); P(x, 7, 22, 1, "#b98748");
  for (let i = 0; i < 22; i += 3) for (let j = 0; j < 17; j += 4) P(x + (i + j * 2) % 22, 8 + j, 1, 1, (i + j) % 2 ? "#c39355" : "#e8bd80");   // the cork's grain
  for (let i = 1; i < notes; i++) thin(P, x + pts[i - 1][0] + 2, 9 + pts[i - 1][1], x + pts[i][0] + 2, 9 + pts[i][1], "#e03131");
  for (let i = 0; i < notes; i++) {
    const [px, py] = pts[i], c = NOTE[i % NOTE.length];
    P(x + px, 7 + py, 4, 4, c); P(x + px, 7 + py, 4, 1, shade(c, 0.78)); P(x + px + 1, 8 + py, 2, 1, shade(c, 0.6)); P(x + px + 2, 10 + py, 1, 1, "#e03131");
  }
}
function propChart(P, x, y, n, crash) {               // a hand-held chart whose bars grow
  const BAR = ["#4dabf7", "#51cf66", "#ffd43b", "#ff922b", "#e64980"];
  P(x - 1, y - 1, 16, 13, INK); P(x, y, 14, 11, "#ffffff"); P(x, y + 10, 14, 1, "#4263eb"); P(x + 1, y + 10, 4, 1, "#bac8ff"); P(x, y, 14, 1, "#e9ecf2");
  P(x + 1, y + 1, 1, 8, "#5a6275"); P(x + 1, y + 1, 12, 1, "#5a6275");
  [2, 3, 5, 6, 8].forEach((h, i) => { if (i < n) { const hh = crash && i === 4 ? 1 : Math.min(h, 7); P(x + 3 + i * 2, y + 2, 1, hh, crash && i === 4 ? "#e03131" : BAR[i]); } });
  if (n >= 5 && !crash) { thin(P, x + 3, y + 4, x + 12, y + 9, "#2f9e44"); P(x + 11, y + 9, 2, 1, "#2f9e44"); P(x + 12, y + 8, 1, 1, "#2f9e44"); }
}
function propNotebook(P, hx, hy, lines) {            // spiral-bound, a red margin, lines in blue ink
  box(P, hx - 1, hy - 3, 7, 8, "#fffdf2"); P(hx - 1, hy - 3, 7, 1, "#e6dfc4"); P(hx - 1, hy - 3, 1, 8, "#ff8fa3");
  for (let i = 0; i < 3; i++) { P(hx + i * 2, hy + 5, 1, 1, "#8b93a3"); P(hx + i * 2, hy + 4, 1, 1, "#d5dae3"); }
  for (let i = 0; i < Math.min(lines, 3); i++) P(hx + 1, hy + 2 - i * 2, 2 + (i % 2) * 2, 1, "#3b82f6");
}
function propMicroscope(P, x) {                       // a heavy base, a stage with a slide, a brass focus knob
  box(P, x, 1, 8, 2, "#3d4558"); P(x, 2, 8, 1, "#5a6275"); P(x + 1, 6, 6, 1, "#aab2bd"); P(x + 2, 7, 3, 1, "#8fd3ff");
  P(x + 6, 3, 2, 9, "#3d4558"); P(x + 7, 3, 1, 9, "#5a6275"); P(x + 8, 8, 1, 2, "#ffd43b");
  limb(P, x + 6, 12, x + 3, 16, 2, "#e9ecf2"); P(x + 3, 7, 2, 3, "#c9ced8"); P(x + 3, 7, 2, 1, "#4fb8ff"); P(x + 2, 17, 2, 1, "#3d4558");
}
function propRocket(P, lx) { pmap(P, ROCKET, lx - 2, 0); }
function propMortar(P, g) { const y = g.crown; box(P, -3, y - 1, 7, 2, "#2b2f3d"); P(-7, y + 1, 15, 1, "#2b2f3d"); P(-6, y + 1, 6, 1, "#4a5266"); P(6, y - 2, 1, 3, "#ffd43b"); P(6, y - 3, 1, 1, "#f59f00"); P(0, y + 1, 1, 1, "#ffd43b"); }
function propSheet(P, x, mark) { box(P, x, 1, 9, 2, "#ffffff"); P(x, 1, 9, 1, "#d5dae3"); if (mark) P(x + 3, 2, 3, 1, mark); }
function propStamp(P, hx, hy) { box(P, hx - 2, hy - 4, 5, 2, "#5a6275"); P(hx - 2, hy - 3, 5, 1, "#8b93a3"); P(hx - 2, hy - 5, 5, 1, "#e03131"); box(P, hx - 1, hy + 1, 3, 2, "#a0622d"); P(hx - 1, hy + 2, 3, 1, "#c98646"); }
function propNet(P, hx, hy, swing) {                 // a butterfly net; returns the middle of its hoop
  const ex = swing ? hx + 12 : hx + 6, ey = swing ? hy + 2 : hy + 11;
  limb(P, hx, hy, ex, ey, 1, "#a0622d");
  P(ex - 2, ey, 5, 1, "#ffffff"); P(ex - 2, ey + 4, 5, 1, "#ffffff"); P(ex - 3, ey + 1, 1, 3, "#ffffff"); P(ex + 3, ey + 1, 1, 3, "#ffffff");
  for (let i = 0; i < 3; i++) P(ex - 1 + i, ey + 1 + ((i + 1) % 2) * 2, 1, 1, "#d5dae3"); P(ex, ey + 2, 1, 1, "#d5dae3");   // the mesh
  return [ex, ey + 2];
}
function propPizza(P, hx, hy, bites) {               // a slice: crust, cheese, pepperoni and a leaf of basil
  const rows = Math.max(1, 6 - bites * 2);
  box(P, hx - 2, hy - 2, 6, 1, "#d08a3e"); P(hx - 2, hy - 2, 2, 1, "#e8a85a");
  for (let i = 1; i < rows; i++) {
    P(hx - 2, hy - 2 + i, Math.max(1, 6 - i), 1, i % 2 ? "#ffd43b" : "#ffc21a");
    if (i === 2 || i === 4) P(hx - 1 + (i % 3), hy - 2 + i, 1, 1, "#e03131");
    if (i === 3) P(hx - 2, hy + 1, 1, 1, "#2fb344");
  }
}
function propPlant(P, x, grow, petal) {               // a seedling in a terracotta pot that grows into a flower
  P(x - 1, 2, 7, 1, "#e07a4a"); P(x, 0, 5, 2, "#c2623a"); P(x, 0, 1, 2, "#9a4a28"); P(x + 3, 1, 1, 1, "#e8946a"); P(x, 3, 5, 1, "#5a3418");
  if (grow <= 0) return;
  const h = Math.round(grow * 7) + 3;
  thin(P, x + 2, 4, x + 2, h, "#2b8a3e");
  if (grow > 0.4) { P(x + 3, 6, 2, 1, "#40c057"); P(x, 7, 2, 1, "#40c057"); P(x + 4, 6, 1, 1, "#8ce99a"); }
  if (grow >= 1) { P(x + 1, h + 1, 3, 3, petal); P(x + 1, h + 1, 1, 1, shade(petal, 0.75)); P(x + 3, h + 3, 1, 1, shade(petal, 1.3)); P(x + 2, h + 2, 1, 1, "#ffe066"); }
  else if (grow > 0.7) P(x + 2, h + 1, 1, 2, "#40c057");
}
function propCan(P, hx, hy) { box(P, hx - 1, hy - 3, 6, 5, "#4dabf7"); P(hx - 1, hy + 1, 6, 1, "#a5d8ff"); P(hx - 1, hy - 3, 6, 1, "#1c7ed6"); P(hx + 3, hy - 2, 1, 3, "#74c0fc"); thin(P, hx + 5, hy, hx + 8, hy + 2, "#1c7ed6"); P(hx + 8, hy + 3, 1, 1, "#a5d8ff"); P(hx - 2, hy - 1, 1, 3, "#1c7ed6"); }
function propGlobe(P, hx, hy, off) {                 // on a brass stand, lit from the upper left
  P(hx + 1, hy - 2, 5, 1, "#d9a520"); P(hx + 1, hy - 2, 2, 1, "#f2c94c"); P(hx + 3, hy - 1, 1, 2, "#a8780f");
  const cx = hx + 3, cy = hy + 5;
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      if (dx * dx + dy * dy > 18) continue;
      const land = ((dx + off + 90) % 9 < 3 && (dy + 9) % 4 !== 0) || ((dx + off + 94) % 9 === 6 && dy > -2);
      const dim = dx - dy > 3, lit = dy - dx > 3;
      P(cx + dx, cy + dy, 1, 1, land ? (dim ? "#2b8a3e" : lit ? "#8ce99a" : "#40c057") : (dim ? "#1c7ed6" : lit ? "#a5d8ff" : "#4dabf7"));
    }
  P(cx - 2, cy + 2, 1, 1, "#ffffff");
}

// Lines for the bits. They're said at the bit's big moment and replace whatever bubble was up.
const BIT_LINES = Object.assign({
  beaker_boom: ["That's... a result.", "Note to self: not that one.", "*cough* Noted.", "Hypothesis: rejected.", "Science!"],
  beaker_ok: ["Hypothesis: confirmed?", "Ooh, pretty.", "Reproducible? Let's not.", "It fizzes!"],
  rocket_crash: ["Peer review: failed.", "Back to the drawing board.", "It's a learning experience.", "Rocket science is hard."],
  rocket_ok: ["Ad astra!", "Houston, we have a citation.", "To the stars!"],
  dollar: ["Grant funding!", "Funding secured!", "A whole dollar!", "Lunch is covered.", "Overhead: 60%."],
  flower: ["Field sample!", "How lovely.", "Botany break.", "A peer-reviewed petal."],
  bird: ["Hello, colleague.", "A peer reviewer!", "Tweet tweet.", "Field observation!"],
  notebook: ["Draft #47.", "Nope.", "Start over.", "Brilliant. No, terrible."],
  chalkboard: ["Q.E.D.", "That checks out.", "Elegant!", "Proof by chalk."],
  chalk_q: ["...hm.", "Where did it go wrong?", "Carry the one?"],
  chart_up: ["Up and to the right!", "Look at that trend!", "Significant!"],
  chart_down: ["...about that.", "Outlier. Definitely an outlier.", "Nobody saw that."],
  apple: ["Gravity! Noted.", "Ow. But also: eureka.", "Newton was right."],
  microscope: ["It moved!", "Ew, it's alive!", "Fascinating little guy.", "Enhance!"],
  gradcap: ["Doctor Me!", "Finally graduated!", "Hat trick!"],
  plane: ["Submitted!", "Sent to the journal.", "Fly, my manuscript!", "Off to Reviewer 2."],
  corkboard: ["It's all connected.", "Follow the red string.", "The string never lies.", "I KNEW it."],
  stamp_ok: ["Approved!", "Accepted!", "Minor revisions!"],
  stamp_no: ["Rejected!", "Reviewer 2 has spoken.", "Major revisions!"],
  cat: ["Who's a good reviewer?", "Office cat!", "You can't sit there. OK, you can."],
  butterfly: ["Field specimen!", "Got one! Okay, bye.", "Lepidoptera!"],
  juggle_ok: ["Multitasking!", "Three deadlines at once!", "Juggling three grants."],
  juggle_drop: ["Oops.", "That one was overdue anyway.", "Ow. Footnotes."],
  pizza: ["Free seminar pizza!", "Brain food.", "This is why I go to talks."],
  sprout: ["Longitudinal study complete.", "It grows!", "Results: a flower."],
  dance: ["Paper accepted!!", "It compiled!", "No revisions!"],
  sneeze_after: ["Archives are dusty.", "Excuse me, 1890.", "Bless this footnote."],
  duck_talk: ["So this function...", "...and then the loop...", "Okay duck, listen."],
  duck_done: ["Oh! It was a typo.", "Thanks, duck.", "Duck solves it again."],
  globe: ["Fieldwork, anywhere?", "Let's go... there!", "Somewhere, a source."],
}, LINES.bits);

const ACTIONS = {
  spawn: {                                       // walk in from one side
    init(r) {
      const [lo, hi] = r.stage.range();
      let side = r.rand() < 0.5 ? -1 : 1, tx;
      if (r.stage.kind === "flow") {             // straight to the lit step, from the nearer end of the strip
        tx = r.stage.spawnX(r.rand);
        side = tx - lo < hi - tx ? -1 : 1;
      } else tx = side < 0 ? lo + between(r.rand, 10, 140) : hi - between(r.rand, 10, 140);
      r.x = side < 0 ? lo - EDGE : hi + EDGE;
      return { tx: clamp(tx, lo, hi) };
    },
    run(r, s, dt) {
      r.alpha = r.stage.edgeFade(r.x); r.y = r.stage.hop(r.x);
      if (stepToward(r, s, s.tx, dt, r.a.speed * (r.stage.kind === "flow" ? 1.5 : 1))) {
        r.alpha = 1; r.y = 0; s.done = true;
        if (r.stage.kind === "flow") r.arrive();
        else if (r.greet) { r.say(r.greet, Math.max(3.5, readTime(r.greet) + 1.5)); r.greet = null; }
        else if (r.rand() < GREET) r.say(r.rand() < 0.35 ? fill(LINES.reporting || "{name}, reporting in.", { name: r.a.name }) : nextQuip());
        return stand({ carry: true });
      }
      return stand(Object.assign(walkPose(r, s.dist || 0), { carry: true }));
    },
  },
  despawn: {                                     // and walk off the nearer side
    init(r, o) {
      const [lo, hi] = r.stage.range();
      if (!(o && o.quiet) && r.rand() < 0.25) r.say(pick(r.rand, ["Bye!", "Off to the archives!", "Lunch break!", "brb, library",
        "Exit, pursued by a deadline.", "To the stacks!", "My work here is cited.", "Fin."]));
      return { tx: r.x - lo < hi - r.x ? lo - EDGE : hi + EDGE };
    },
    run(r, s, dt) {
      r.alpha = r.stage.edgeFade(r.x); r.y = r.stage.hop(r.x);
      if (stepToward(r, s, s.tx, dt, r.a.speed * 1.2) || r.alpha <= 0) r.gone = true;
      return stand(Object.assign(walkPose(r, s.dist || 0), { carry: true }));
    },
  },
  farewell: {                                    // a closing line and a wave before walking off
    init(r, o) {
      r.say(o.text, Math.max(2.6, readTime(o.text) + 1.2));
      return { dur: clamp(readTime(o.text) * 0.5, 0.9, 1.6) };
    },
    run(r, s) {
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: ["up", Math.floor(s.t * 5) % 2 ? 2 : 0], mouth: "smile" });
    },
  },
  chase: {                                       // the mission moved on to the next step: run after it
    init(r) {
      if (r.rand() < 0.25) r.say(pick(r.rand, ["Next!", "Onward!", "Wait for me!", "Coming!", "Follow that mission!"]), 1.4);
      return { tx: r.stage.spawnX(r.rand) };
    },
    run(r, s, dt) {
      r.y = r.stage.hop(r.x);
      if (stepToward(r, s, s.tx, dt, r.a.speed * 2.2)) { r.y = 0; s.done = true; r.arrive(); return stand({ carry: true }); }
      return stand(Object.assign(walkPose(r, s.dist || 0), { carry: true }));
    },
  },
  walk: {
    init(r, o) {
      const tx = r.stage.pickTarget(r), far = Math.abs(tx - r.x) > 80;
      if (Math.abs(tx - r.x) < 12) return { tx: r.x, fast: 1, tripAt: null };   // not worth a walk: stay put
      return { tx, fast: (o && o.fast) || 1, tripAt: r.mood === "busy" && far && r.rand() < 0.15 ? between(r.rand, 0.8, 2) : null };
    },
    run(r, s, dt) {
      const speed = r.a.speed * s.fast * (r.caffeine > 0 ? 1.4 : 1);
      if (stepToward(r, s, s.tx, dt, speed)) { s.done = true; return stand({ carry: true }); }
      if (s.tripAt && s.t > s.tripAt) { s.tripAt = null; r.next = ["walk"]; r.begin("trip"); return stand(); }
      r.y = r.stage.hop(r.x);
      return stand(Object.assign(walkPose(r, s.dist), { carry: true }, r.caffeine > 0 ? { eyes: "wide" } : {}));
    },
  },
  rest: {                                        // a breather between bits: stand about, now and then a step or two
    init(r) {
      const crew = r.mood === "crew";
      const s = { dur: between(r.rand, crew ? REST_MIN + 1 : REST_MIN, crew ? REST_MAX + 3 : REST_MAX),
                  turn: r.rand() < 0.35 ? between(r.rand, 1, 3) : -1, tap: r.rand() < 0.2 };
      const span = r.stage.kind === "flow" ? r.stage.home : r.stage.range();   // on the strip, stay on the step
      if (span && r.rand() < 0.45) {
        const steps = r.rand() < 0.5 ? 1 : 2, dir = r.rand() < 0.5 ? -1 : 1;
        s.tx = clamp(r.x + dir * steps * between(r.rand, 4, 5), span[0], span[1]);
        s.at = between(r.rand, 0.6, s.dur * 0.6);
      }
      return s;
    },
    run(r, s, dt) {
      if (s.tx != null && s.t > s.at && !s.stepped) {
        if (stepToward(r, s, s.tx, dt, r.a.speed * 0.45)) s.stepped = true;
        else return stand(Object.assign(walkPose(r, s.dist || 0), { carry: true }));
      }
      if (s.turn > 0 && s.t > s.turn) { r.face *= -1; s.turn = -1; }
      if (s.t >= s.dur) s.done = true;
      return stand({ carry: true, liftF: s.tap && Math.floor(s.t * 3) % 2 ? 1 : 0, bob: breath(r, s.t) });
    },
  },
  idle: {
    init(r) { return { dur: between(r.rand, 1.2, 3.5), turn: r.rand() < 0.5 ? between(r.rand, 0.4, 1) : -1, tap: r.rand() < 0.4 }; },
    run(r, s) {
      if (s.turn > 0 && s.t > s.turn) { r.face *= -1; s.turn = -1; }
      if (s.t >= s.dur) s.done = true;
      return stand({ carry: true, liftF: s.tap && Math.floor(s.t * 4) % 2 ? 1 : 0, bob: breath(r, s.t) });
    },
  },
  read: {
    init(r) { return { dur: between(r.rand, 3, 6), slam: r.rand() < 0.35 }; },
    run(r, s) {
      if (s.t > 1.2 && !s.said && r.rand() < 0.02) { s.said = true; r.quip("read"); }
      if (s.t >= s.dur) { if (s.slam) r.stage.dust(r.x + r.face * 8, 10); s.done = true; }
      const flip = s.t % 1.1 < 0.25;
      return stand({
        armF: ["high", 0], armB: ["high", -1], eyes: "down", nod: Math.floor(s.t * 1.5) % 2,
        props: (P, g) => {
          PROPS.book(P, r.a, g.handF[0], g.handF[1]);
          if (flip) box(P, g.handF[0] + 1 + Math.floor((s.t % 1.1) / 0.06) % 4, g.handF[1] + 6, 2, 2, "#ffffff");
        },
      });
    },
  },
  search: {
    init(r) {
      roomAhead(r, 40);
      const sniff = r.rand() < 0.3;
      const tx = r.stage.kind === "flow" ? r.x : r.x + r.face * between(r.rand, 16, 36);  // pills are too short to roam
      return { dur: between(r.rand, 3.5, 6), sniff, tx, found: r.rand() < 0.55 };
    },
    run(r, s, dt) {
      const pause = Math.floor(s.t / 0.9) % 3 === 2;
      const moving = !pause && !stepToward(r, s, s.tx, dt, r.a.speed * 0.4);
      const end = s.t >= s.dur - 0.9;
      if (end && s.found && !s.cheered) { s.cheered = true; r.icon("bang"); r.quip("search"); }
      if (s.sniff && Math.floor(s.t * 3) !== Math.floor((s.t - 0.016) * 3)) r.stage.puff(r.x + r.face * 10, r.headTop - 12, r.face);
      if (s.sniff && !s.saidSniff && s.t > 1) { s.saidSniff = true; r.quip("sniff"); }
      if (s.t >= s.dur) s.done = true;
      const walk = moving && !end ? walkPose(r, s.dist || 0) : {};
      if (s.sniff) return stand(Object.assign({}, walk, { crouch: 2, nod: 1, eyes: "closed", armF: ["low", 0], armB: ["low", 0] }));
      return stand(Object.assign({}, walk, {
        crouch: 1, armF: end && s.found ? ["up", 0] : ["low", 0], eyes: "down",
        props: (P, g) => end && s.found ? propPaper(P, g.handF[0] - 2, g.handF[1] + 1)
          : PROPS.magnifier(P, r.a, g.handF[0], g.handF[1], Math.floor(s.t * 2) % 4 === 0),
      }));
    },
  },
  eureka: {
    init(r) { r.icon("bulb", 1.6); return { dur: 1.8 }; },
    run(r, s) {
      if (s.t > 0.35 && !s.said) { s.said = true; r.quip("eureka"); r.stage.sparkle(r.x, r.headTop, 8); }
      const j = s.t > 0.35 ? Math.abs(Math.sin((s.t - 0.35) * 7)) : 0;
      r.y = j * 10;
      if (s.t >= s.dur) { r.y = 0; s.done = true; }
      return stand({ armF: s.t > 0.35 ? ["up", 0] : ["swing", 0], armB: s.t > 0.35 ? ["up", 0] : ["swing", 0],
                     eyes: "wide", mouth: "o", blush: true, liftF: j > 0.2, liftB: j > 0.2 });
    },
  },
  confused: {
    init(r) { r.icon("q", 2.2); return { dur: 2.4 }; },
    run(r, s) {
      if (s.t > 0.6 && !s.turned) { s.turned = true; r.face *= -1; }
      if (s.t > 1.2 && !s.turned2) { s.turned2 = true; r.face *= -1; if (r.rand() < 0.6) r.quip("confused"); }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: ["head", Math.floor(s.t * 8) % 2], mouth: "flat" });
    },
  },
  citation: {
    init(r) { roomAhead(r, 20); r.quip("citation"); return { dur: 2.4 }; },
    run(r, s) {
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: ["high", 2 + Math.floor(s.t * 3) % 2], mouth: Math.floor(s.t * 8) % 2 ? "o" : "flat", liftF: s.t < 0.3 ? 1 : 0 });
    },
  },
  coffee: {
    init(r) { return { dur: 3.2 }; },
    run(r, s) {
      const sip = s.t > 0.7 && s.t < 2.2;
      if (sip && Math.random() < 0.12) r.stage.steam(r.x + r.face * 8, r.headTop - 8);
      if (s.t > 2.3 && !s.said) { s.said = true; r.quip("coffee"); r.caffeine = 8; }
      if (s.t >= s.dur) s.done = true;
      return stand({
        armF: sip ? ["mouth", 0] : ["forward", 0], eyes: sip ? "closed" : s.t > 2.3 ? "wide" : "open",
        props: (P, g) => PROPS.mug(P, r.a, g.handF[0] + 1, g.handF[1] + (sip ? -1 : 2)),
      });
    },
  },
  notes: {
    init(r) { return { dur: between(r.rand, 3, 4.5), toss: r.rand() < 0.5 }; },
    run(r, s) {
      const lines = Math.floor(s.t * 1.5);
      if (s.t >= s.dur) {
        if (s.toss) { r.stage.paper(r.x - r.face * 4, r.headTop - 12, -r.face * 24, 36); r.quip("notes"); }
        s.done = true;
      }
      const wiggle = Math.floor(s.t * 10) % 2;
      return stand({
        armB: ["forward", 2], armF: ["forward", wiggle - 1], eyes: "down", nod: 1,
        props: (P, g) => { propClipboard(P, g.handB[0], g.handB[1], lines); propPencil(P, g.handF[0], g.handF[1] + wiggle); },
      });
    },
  },
  sleep: {
    init(r) { return { dur: between(r.rand, 4, 8) }; },
    run(r, s) {
      if (Math.floor(s.t / 0.9) !== Math.floor((s.t - 0.017) / 0.9)) r.stage.z(r.x + r.face * 4, r.headTop - 4);
      const wake = s.t > s.dur - 0.6;
      if (wake && !s.woke) { s.woke = true; r.icon("bang", 0.6); }
      if (s.t >= s.dur) s.done = true;
      r.y = wake ? Math.sin((s.t - (s.dur - 0.6)) / 0.6 * Math.PI) * 8 : 0;
      return wake ? stand({ eyes: "wide", mouth: "o", armF: ["up", 0], armB: ["up", 0] })
        : stand({ sit: true, eyes: "closed", nod: 1, armF: ["low", -2], mouth: Math.floor(s.t) % 3 === 0 ? "o" : "none" });
    },
  },
  dig: {
    init(r) { roomAhead(r, 28); return { dur: between(r.rand, 3.5, 5), hole: 0 }; },
    run(r, s) {
      const cycle = s.t % 0.7, down = cycle < 0.35, end = s.t > s.dur - 1;
      if (!end && cycle < 0.02) { r.stage.dirt(r.x + r.face * 18, r.face); s.hole = Math.min(10, s.hole + 2); }
      if (end && !s.found) { s.found = true; r.quip("dig"); r.stage.sparkle(r.x + r.face * 4, r.headTop, 6); }
      if (s.t >= s.dur) s.done = true;
      r.stage.hole(r.x + r.face * 18, s.hole);
      if (end) return stand({ armF: ["up", 0], eyes: "wide", mouth: "smile", props: (P, g) => propPaper(P, g.handF[0] - 2, g.handF[1] + 1) });
      return stand({ crouch: down ? 1 : 0, armF: ["low", down ? 1 : 0], armB: ["low", -1], eyes: "down",
                     props: (P, g) => propShovel(P, g.handF[0], g.handF[1], down) });
    },
  },
  telescope: {
    init(r) { roomAhead(r, 32); return { dur: between(r.rand, 2.8, 4), turn: r.rand() < 0.5 }; },
    run(r, s) {
      const ext = clamp(s.t / 0.6, 0, 1) * clamp((s.dur - s.t) / 0.4, 0, 1);
      if (s.turn && s.t > s.dur / 2 && !s.turned) { s.turned = true; r.face *= -1; }
      if (s.t > 1.2 && !s.said) { s.said = true; r.quip("telescope"); }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: ["high", 1], armB: ["high", 0], liftB: 1, props: (P, g) => propSpyglass(P, g, ext) });
    },
  },
  typing: {
    init(r) { roomAhead(r, 28); return { dur: between(r.rand, 3.5, 5.5), phone: r.a.prop === "phone" }; },
    run(r, s) {
      if (s.t > 1.5 && !s.said) { s.said = true; r.quip("typing"); }
      if (s.t >= s.dur) s.done = true;
      const k = Math.floor(s.t * 14) % 2;
      if (s.phone) {                              // thumbs a-blur on a phone
        if (Math.random() < 0.15) r.stage.bit(r.x + r.face * 12, r.headTop - 14);
        return stand({ armF: ["high", k], armB: ["forward", 3 - k], eyes: "down", nod: 1,
                       props: (P, g) => PROPS.phone(P, r.a, g.handF[0], g.handF[1]) });
      }
      if (s.t > 2 && Math.random() < 0.08) r.stage.smoke(r.x + r.face * 14, 18);
      if (Math.random() < 0.25) r.stage.bit(r.x + r.face * 10, 16);
      return stand({ sit: true, armF: ["low", 1 + k], armB: ["low", 2 - k], eyes: "down", props: P => propLapLaptop(P, 2, k) });
    },
  },
  papers: {
    init(r) { return { dur: 1.6 }; },
    run(r, s) {
      if (s.t > 0.25 && !s.thrown) {
        s.thrown = true; r.quip("papers");
        for (let i = 0; i < 9; i++) r.stage.paper(r.x, r.headTop - 4, between(r.rand, -28, 28), between(r.rand, 28, 52));
      }
      if (s.t >= s.dur) { s.done = true; r.next = ["walk", { fast: 2.2 }]; }
      return stand({ armF: s.t > 0.25 ? ["up", 0] : ["low", 0], armB: s.t > 0.25 ? ["up", 0] : ["low", 0],
                     mouth: "o", eyes: s.t > 0.25 ? "wide" : "open", crouch: s.t < 0.25 ? 1 : 0 });
    },
  },
  scroll: {
    init(r) { roomAhead(r, 48); return { dur: between(r.rand, 3.5, 5) }; },
    run(r, s) {
      const out = clamp(s.t / 1.3, 0, 1) * clamp((s.dur - s.t) / 0.25, 0, 1);
      if (s.t > 1.4 && !s.said) { s.said = true; r.quip("scroll"); }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: ["forward", 0], armB: ["forward", 1], eyes: "down", nod: 1,
                     props: (P, g) => { propScroll(P, g.handF[0], g.handF[1], Math.round(out * 34)); box(P, g.handF[0] - 1, g.handF[1] - 2, 5, 3, "#e2d2a0"); } });
    },
  },
  stack: {
    init(r) {
      const n = 4 + Math.floor(r.rand() * 4);
      return { tx: r.stage.pickTarget(r, 100), n, colors: Array.from({ length: n }, () => pick(r.rand, BOOKS)), topple: r.rand() < 0.3 };
    },
    run(r, s, dt) {
      if (!s.arrived && stepToward(r, s, s.tx, dt, r.a.speed * 0.6)) { s.arrived = s.t; }
      r.y = r.stage.hop(r.x);
      if (s.t > 0.8 && !s.said) { s.said = true; r.quip("stack"); }
      if (s.arrived && s.topple && !s.fell) {
        s.fell = true; r.say(QUOTES.topple[0], 1); r.icon("bang", 0.8);
        for (let i = 0; i < s.n; i++) r.stage.book(r.x + r.face * 6, r.headTop - 6 + i * 4, r.face * between(r.rand, 8, 28), between(r.rand, 8, 24), s.colors[i]);
      }
      if (s.arrived && s.t - s.arrived > 0.8) s.done = true;
      const walking = !s.arrived;
      return stand(Object.assign(walking ? walkPose(r, s.dist || 0) : {}, {
        armF: ["high", -1], armB: ["high", -2], eyes: s.fell ? "wide" : "open", mouth: s.fell ? "o" : "none",
        props: s.fell ? null : (P, g) => propStack(P, g.handF[0], g.handF[1] + 2, s.n, s.t * 5, s.colors),
      }));
    },
  },
  // ---------- little bits of everyday research life ----------
  beaker: {                                      // pour one flask into another; usually it goes poof
    init(r) {
      return { dur: 5.4, a: pick(r.rand, ["#74c0fc", "#ff922b"]), mix: pick(r.rand, ["#b197fc", "#69db7c", "#ff8787", "#ffd43b"]),
               boom: r.rand() < 0.7 };
    },
    run(r, s) {
      const pour = s.t > 0.6 && s.t < 2.4, shake = s.t >= 2.4 && s.t < 3.2, after = s.t >= 3.2;
      if (after && !s.popped) {
        s.popped = true;
        const at = s.g ? { x: ahead(r, s.g.handB[0]), y: s.g.handB[1] + 3 + r.y } : { x: ahead(r, 4), y: 20 };
        if (s.boom) {
          for (let i = 0; i < 10; i++) r.stage.add({ kind: "smoke", c: i % 3 ? s.mix : "#f1f3f5", x: at.x, y: at.y,
            vx: (Math.random() - 0.5) * 50, vy: Math.random() * 30, life: 0.9 + Math.random() * 0.5, size: 4 });
          r.soot = 6; r.icon("bang", 0.6); r.line("beaker_boom", 0.8);
        } else {
          for (let i = 0; i < 8; i++) r.stage.add({ kind: "px", c: s.mix, x: at.x + (Math.random() - 0.5) * 4, y: at.y + 5,
            vy: 14 + Math.random() * 14, life: 1, fade: true });
          r.icon("bulb", 1.2); r.line("beaker_ok", 0.7);
        }
      }
      if (s.t >= s.dur) s.done = true;
      const j = shake ? (Math.floor(s.t * 16) % 2 ? 1 : -1) : 0, burnt = after && s.boom;
      return stand({
        armF: pour ? ["high", 0] : burnt ? ["up", 0] : ["forward", 0], armB: burnt ? ["up", 0] : ["forward", 7 + j],
        eyes: after ? (burnt && s.t > 4.2 ? "closed" : "wide") : "down", mouth: after ? (burnt ? "o" : "smile") : "none",
        props: (P, g) => {
          s.g = g;
          if (burnt) return;
          const fill = clamp((s.t - 0.6) / 1.8, 0, 1);
          pmap(P, FLASK, g.handB[0] - 2, g.handB[1] - 3, { L: fill > 0.5 ? s.mix : "#ffe066" });
          pmap(P, FLASK, g.handF[0] - 2, g.handF[1] - 3, { L: after ? "#e9ecef" : s.a });
          if (pour) thin(P, g.handF[0] + 1, g.handF[1] - 3, g.handB[0], g.handB[1] + 3, s.a, i => (i + Math.floor(s.t * 14)) % 3 === 0);
        },
      });
    },
  },
  rocket: {                                      // set it down, light it, back away... and up it goes
    init(r) {
      roomAhead(r, 30);
      return { dur: 10, ok: r.rand() < 0.3, rx: ahead(r, 14), backX: ahead(r, -10) };
    },
    run(r, s, dt) {
      const lx = (s.rx - r.x) * r.face;
      if (s.t < 0.8) return stand({ crouch: 3, armF: ["low", 3], eyes: "down", props: P => propRocket(P, lx) });
      if (s.t < 1.6) {
        if (Math.random() < 0.4) r.stage.add({ kind: "px", c: Math.random() < 0.5 ? "#ffd43b" : "#ff922b", x: s.rx, y: 9,
          vx: (Math.random() - 0.5) * 20, vy: 20, life: 0.4, fade: true });
        return stand({ crouch: 2, armF: ["low", 4], eyes: "wide", props: P => propRocket(P, lx) });
      }
      if (s.t < 2.2) {
        const [lo, hi] = r.stage.range();
        stepToward(r, s, clamp(s.backX, lo, hi), dt, r.a.speed * 1.5);
        r.face = Math.sign(s.rx - r.x) || r.face;
        return stand({ armF: ["head", 0], armB: ["head", 0], eyes: "closed", mouth: "o", props: P => propRocket(P, (s.rx - r.x) * r.face) });
      }
      if (!s.launched) {
        s.launched = true; r.stage.dust(s.rx, 6);
        const f = Math.sign(s.rx - r.x) || r.face, up = r.stage.kind === "flow" ? 90 : 112;
        r.stage.add({ kind: "map", map: ROCKET, x: s.rx, y: 2, vx: f * (s.ok ? 6 : 34), vy: up, g: s.ok ? 70 : up, floor: !s.ok, life: 6, rot: 0,
          trail: p => {
            p.rot = Math.atan2(p.vx, p.vy);
            if (Math.random() < 0.7) r.stage.add({ kind: "px", c: Math.random() < 0.5 ? "#ffd43b" : "#ff922b", x: p.x, y: p.y, vy: -10, life: 0.35, fade: true });
            if (Math.random() < 0.15) r.stage.smoke(p.x, p.y);
            if (s.ok && p.vy < 0) { p.life = 0; p.trail = null; r.stage.sparkle(p.x, p.y, 14); s.popped = true; }
          },
          land: p => { p.rot = f * Math.PI / 2; p.life = 2.5; p.fade = true; p.trail = null; r.stage.dust(p.x, 10); for (let i = 0; i < 4; i++) r.stage.star(p.x, 10); s.crashed = true; },
        });
      }
      if (s.crashed && !s.reacted) { s.reacted = s.t; r.line("rocket_crash", 0.8); }
      if (s.popped && !s.reacted) { s.reacted = s.t; r.line("rocket_ok", 0.8); r.icon("heart", 1); }
      if ((s.reacted && s.t - s.reacted > 2) || s.t > s.dur) s.done = true;
      if (!s.reacted) return stand({ eyes: "up", mouth: "o" });
      return s.crashed ? stand({ armF: ["head", 0], eyes: "closed", mouth: "flat" })
        : stand({ armF: ["up", 0], armB: ["up", 0], mouth: "smile", eyes: "closed", blush: true });
    },
  },
  dollar: {                                      // a dollar on the floor!
    init(r) {
      roomAhead(r, 50);
      const st = { dur: 9 };
      st.bill = item(r, BILL, near(r, between(r.rand, 26, 44)), { life: 14 });
      st.cleanup = () => vanish(st.bill);
      return st;
    },
    run(r, s, dt) {
      if (s.t > s.dur) s.done = true;
      if (s.t < 0.8) { if (!s.seen) { s.seen = true; r.icon("bang", 0.7); } return stand({ eyes: "wide", carry: true }); }
      const w = walkTo(r, s, dt, s.bill.x);
      if (w) return w;
      const k = s.t - s.there;
      if (k < 0.7) return stand({ crouch: 3, armF: ["low", 2], eyes: "down" });
      if (!s.got) { s.got = true; s.bill.life = 0; r.stage.sparkle(ahead(r, 4), r.headTop, 6); r.icon("heart", 1.2); r.line("dollar", 0.8); }
      if (k > 3.4) s.done = true;
      const hop = k < 2.2 ? Math.abs(Math.sin(k * 7)) : 0;
      r.y = hop * 6;
      return stand({ armF: ["up", 0], mouth: "smile", blush: true, liftF: hop > 0.2, liftB: hop > 0.2,
                     props: (P, g) => pmap(P, BILL, g.handF[0] - 4, g.handF[1] + 1) });
    },
  },
  flower: {                                      // pick a flower and tuck it behind an ear
    init(r) {
      roomAhead(r, 50);
      const st = { dur: 10, petal: pick(r.rand, ["#ff6b9a", "#ffd43b", "#b197fc", "#ff8787", "#f8f9fa"]) };
      st.f = item(r, FLOWER, near(r, between(r.rand, 24, 42)), { life: 14, pal: { L: st.petal } });
      st.cleanup = () => vanish(st.f);
      return st;
    },
    run(r, s, dt) {
      if (s.t > s.dur) s.done = true;
      if (s.t < 0.7) return stand({ carry: true, eyes: "wide", mouth: "o" });
      const w = walkTo(r, s, dt, s.f.x);
      if (w) return w;
      const k = s.t - s.there, held = (P, g) => pmap(P, FLOWER_HELD, g.handF[0] - 1, g.handF[1] - 1, { L: s.petal });
      if (k < 0.7) return stand({ crouch: 3, armF: ["low", 2], eyes: "down" });
      if (!s.got) { s.got = true; s.f.life = 0; }
      if (k < 2.2) { if (!s.sniffed && k > 1) { s.sniffed = true; r.icon("heart", 1); } return stand({ armF: ["mouth", 0], eyes: "closed", mouth: "smile", props: held }); }
      if (k < 3) return stand({ armF: ["head", 0], eyes: "up", mouth: "smile", props: held });
      if (!s.worn) { s.worn = true; r.flower = s.petal; r.line("flower", 0.7); r.stage.sparkle(r.x, r.headTop, 4); }
      if (k > 4.4) s.done = true;
      return stand({ mouth: "smile", blush: true, eyes: "closed" });
    },
  },
  bird: {                                        // a bird lands on their head, chirps, and flies off
    init(r) {
      const side = r.rand() < 0.5 ? -1 : 1, st = { dur: 12 };
      st.b = r.stage.add({ kind: "map", frames: [BIRD_UP, BIRD_DOWN], fps: 10, x: r.x + side * 90, y: 70, life: 14, flip: -side, fadeIn: true }) || {};
      st.cleanup = () => { if (st.b.life > 1.5) { st.b.frames = [BIRD_UP, BIRD_DOWN]; st.b.vx = 45; st.b.vy = 35; st.b.flip = 1; st.b.life = 1.5; st.b.max = 1.5; st.b.fade = true; } };
      return st;
    },
    run(r, s, dt) {
      const b = s.b, hx = r.x + r.face, hy = r.topY;
      if (s.t > s.dur) s.done = true;
      if (!s.landed) {
        const dx = hx - b.x, dy = hy - b.y, d = Math.hypot(dx, dy);
        if (d < 2 || s.t > 5) { s.landed = s.t; b.frames = [BIRD_SIT]; b.flip = -r.face; r.line("bird", 0.6); }
        else { const m = Math.min(d, 60 * dt); b.x += dx / d * m; b.y += dy / d * m; b.flip = Math.sign(dx) || b.flip; }
        return stand({ carry: true, eyes: d < 60 ? "up" : "open" });
      }
      const k = s.t - s.landed;
      if (k < 3) {
        b.x = hx; b.y = hy;
        const c = Math.floor(k / 0.9);
        if (c !== s.chirp) { s.chirp = c; if (c > 0) r.stage.add({ kind: "icon", map: ICONS.note, x: b.x + 4, y: b.y + 8, vx: 4, vy: 12, life: 0.9, fade: true }); }
        return stand({ eyes: "up", mouth: "smile", blush: k > 1 });
      }
      if (!s.off) { s.off = true; const dir = r.rand() < 0.5 ? -1 : 1; b.frames = [BIRD_UP, BIRD_DOWN]; b.vx = dir * 45; b.vy = 35; b.flip = dir; b.life = 2.5; b.max = 2.5; b.fade = true; }
      if (k > 4.5) s.done = true;
      return stand({ armF: ["up", Math.floor(k * 6) % 2 ? 2 : 0], mouth: "smile" });
    },
  },
  notebook: {                                    // scribble in a spiral notebook; sometimes rip the page out
    init(r) { return { dur: between(r.rand, 3.5, 5), rip: r.rand() < 0.45 }; },
    run(r, s) {
      const end = s.dur - (s.rip ? 1.2 : 0.3), writing = s.t < end, wig = Math.floor(s.t * 10) % 2;
      if (s.rip && !writing && !s.ripped) {
        s.ripped = true; r.line("notebook", 0.6);
        r.stage.add({ kind: "map", map: BALL, x: ahead(r, 4), y: r.headTop - 10, vx: -r.face * between(r.rand, 30, 50), vy: 50, g: 160,
                      floor: true, bounce: 0.45, life: 2.5, fade: true });
      }
      if (s.t >= s.dur) s.done = true;
      return stand({
        armB: ["forward", 3], armF: writing ? ["forward", wig] : ["up", 0], eyes: writing ? "down" : "closed", nod: writing ? 1 : 0,
        mouth: s.ripped ? "flat" : "none",
        props: (P, g) => { propNotebook(P, g.handB[0], g.handB[1], writing ? Math.floor(s.t * 2) : 0); if (writing) propPencil(P, g.handF[0], g.handF[1] + wig); },
      });
    },
  },
  chalkboard: {                                  // fill a chalkboard, step back, and box the answer (or not)
    init(r) { roomAhead(r, 36); return { dur: between(r.rand, 5, 6.5), q: r.rand() < 0.3, rows: Array.from({ length: 4 }, () => 8 + Math.floor(r.rand() * 10)) }; },
    run(r, s) {
      const writeEnd = s.dur - 1.6, prog = clamp(s.t / writeEnd, 0, 1), back = s.t > writeEnd;
      if (!back && Math.random() < 0.08) r.stage.add({ kind: "px", c: "#f1f3f5", x: ahead(r, 12), y: 16 + r.y, vy: -8, life: 0.6, fade: true });
      if (back && !s.said) { s.said = true; r.icon(s.q ? "q" : "bulb", 1.1); r.line(s.q ? "chalk_q" : "chalkboard", 0.7); }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: back ? ["swing", 0] : [Math.floor(s.t * 3) % 2 ? "high" : "forward", 1], liftB: back ? 1 : 0,
                     mouth: back && !s.q ? "smile" : "none", props: P => propBoard(P, 9, s.rows, prog, s.q) });
    },
  },
  corkboard: {                                   // sticky notes, red string: it's all connected
    init(r) { roomAhead(r, 36); return { dur: 6, pts: shuffle([[2, 12], [15, 12], [8, 7], [16, 3], [2, 2]], r.rand) }; },
    run(r, s) {
      const n = clamp(Math.floor(s.t * 1.2) + 1, 1, 5), solved = s.t > 4.3;
      if (solved && !s.said) { s.said = true; r.icon("bang", 0.6); r.line("corkboard", 0.8); }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: [solved ? "high" : "forward", Math.floor(s.t * (solved ? 8 : 3)) % 2 + 1], eyes: solved ? "wide" : "open",
                     mouth: solved ? "o" : "none", props: P => propCork(P, 9, s.pts, n) });
    },
  },
  chart: {                                       // hold up a chart; up and to the right, or not
    init(r) { return { dur: 4.6, up: r.rand() < 0.65 }; },
    run(r, s) {
      const bars = Math.min(5, Math.floor(s.t * 2)), crash = !s.up && s.t > 2.8;
      if (s.t > 2.8 && !s.said) { s.said = true; r.line(s.up ? "chart_up" : "chart_down", 0.8); if (s.up) r.stage.sparkle(ahead(r, 10), r.headTop, 5); }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: ["high", 1], armB: ["high", 0], mouth: s.t > 2.8 ? (s.up ? "smile" : "o") : "none", eyes: crash ? "wide" : "open",
                     props: (P, g) => propChart(P, g.handF[0] - 2, g.handF[1] + 1, bars, crash) });
    },
  },
  apple: {                                       // an apple falls on their head. Eureka.
    init(r) {
      const st = { dur: 5 };
      st.a = r.stage.add({ kind: "map", map: APPLE, x: r.x + r.face, y: r.stage.ground + 6, g: 260, life: 8 }) || { y: 0 };
      st.cleanup = () => vanish(st.a);
      return st;
    },
    run(r, s) {
      const a = s.a;
      if (!s.bonk && (a.y <= r.topY + 1 || s.t > 3)) {
        s.bonk = s.t; a.vy = 70; a.vx = -r.face * 30; a.floor = true; a.bounce = 0.4; a.life = 3; a.max = 3; a.fade = true;
        for (let i = 0; i < 3; i++) r.stage.star(r.x, r.headTop);
        r.squash = 0.85;
      }
      if (!s.bonk) return stand({ carry: true });
      const k = s.t - s.bonk;
      if (k > 0.25) r.squash = 1;
      if (k > 0.7 && !s.aha) { s.aha = true; r.icon("bulb", 1.4); r.line("apple", 0.8); }
      if (k > 3) { r.squash = 1; s.done = true; }
      return k < 0.7 ? stand({ eyes: "closed", mouth: "o", armF: ["head", 0] }) : stand({ eyes: "wide", mouth: "smile", armF: ["up", 0] });
    },
  },
  microscope: {                                  // peer in... and jump back
    init(r) { roomAhead(r, 26); return { dur: 5.5, germ: r.rand() < 0.6 }; },
    run(r, s) {
      const peer = s.t < 3, k = s.t - 3;
      if (!peer && !s.jumped) {
        s.jumped = true; r.icon("bang", 0.7); r.line("microscope", 0.7);
        if (s.germ) r.stage.add({ kind: "map", frames: [GERM_A, GERM_B], fps: 5, x: ahead(r, 13), y: 16, vx: r.face * 14, vy: 10, life: 3, fade: true });
      }
      r.y = !peer && k < 0.5 ? Math.sin(k / 0.5 * Math.PI) * 8 : 0;
      if (s.t >= s.dur) { r.y = 0; s.done = true; }
      const scope = P => propMicroscope(P, 9);
      return peer ? stand({ crouch: 2, nod: 1, eyes: Math.floor(s.t * 1.3) % 3 ? "down" : "closed", armF: ["low", 2 + (Math.floor(s.t * 2) % 2)], props: scope })
        : stand({ eyes: "wide", mouth: "o", armF: ["up", 0], armB: ["up", 0], props: scope });
    },
  },
  gradcap: {                                     // toss the mortarboard, catch it on the way down
    init(r) { return { dur: 5 }; },
    run(r, s) {
      if (s.t > 0.6 && !s.thrown) {
        s.thrown = true;
        s.cap = r.stage.add({ kind: "map", frames: [CAP_FLAT, CAP_EDGE], fps: 9, x: r.x, y: r.topY + 2, vy: 120, g: 150, life: 4 }) || { vy: -1, y: 0 };
      }
      if (s.cap && !s.caught && s.cap.vy < 0 && s.cap.y <= r.headTop) { s.caught = true; s.cap.life = 0; r.line("gradcap", 0.7); r.stage.sparkle(r.x, r.headTop + 6, 8); }
      if (s.t >= s.dur) s.done = true;
      const up = s.thrown && !s.caught;
      return stand({ armF: s.t < 0.6 ? ["head", 0] : up ? ["up", 0] : ["swing", 0], armB: up ? ["up", 0] : ["swing", 0],
                     eyes: up ? "up" : s.caught ? "closed" : "open", mouth: s.caught ? "smile" : up ? "o" : "none", blush: !!s.caught,
                     props: (P, g) => { if (!s.thrown || s.caught) propMortar(P, g); } });
    },
  },
  plane: {                                       // fold a paper airplane and send it off
    init(r) { roomAhead(r, 60); return { dur: 4.5 }; },
    run(r, s) {
      const fold = s.t < 1.2;
      if (!fold && !s.thrown) {
        s.thrown = true; r.line("plane", 0.6);
        const f = r.face;
        r.stage.add({ kind: "map", map: PLANE, x: ahead(r, 10), y: r.headTop - 8, vx: f * 55, vy: 18, g: 14, floor: true, life: 5, fade: true, flip: f,
                      trail: p => { p.vy += Math.sin(p.life * 6) * 0.8; } });
      }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: fold ? ["forward", Math.floor(s.t * 6) % 2] : s.t < 1.6 ? ["up", 3] : ["swing", 0], armB: fold ? ["forward", 2] : ["swing", 0],
                     eyes: fold ? "down" : "open", mouth: s.thrown ? "smile" : "none",
                     props: fold ? (P, g) => propPaper(P, g.handF[0] - 2, g.handF[1] - 2) : null });
    },
  },
  stamp: {                                       // APPROVED. Or, Reviewer 2 style, not.
    init(r) { roomAhead(r, 20); return { dur: 3.6, ok: r.rand() < 0.5 }; },
    run(r, s) {
      if (s.t > 1.15 && !s.hit) { s.hit = true; r.stage.dust(ahead(r, 13), 4); r.line(s.ok ? "stamp_ok" : "stamp_no", 0.75); }
      if (s.t >= s.dur) s.done = true;
      const raised = s.t < 1;
      return stand({ crouch: s.hit && s.t < 1.7 ? 2 : 0, armF: [raised ? "up" : "low", raised ? 1 : 3], eyes: s.hit ? "closed" : "open",
                     mouth: s.hit ? (s.ok ? "smile" : "flat") : "none",
                     props: (P, g) => { propSheet(P, 9, s.hit ? (s.ok ? "#2f9e44" : "#e03131") : null); propStamp(P, g.handF[0], g.handF[1]); } });
    },
  },
  cat: {                                         // the office cat drops by for a pat
    init(r) {
      const side = r.rand() < 0.5 ? -1 : 1, st = { dur: 12, side };
      st.c = r.stage.add({ kind: "map", frames: [CAT_A, CAT_B], fps: 6, x: r.x + side * 110, y: 0, life: 16, flip: -side, fadeIn: true }) || {};
      st.cleanup = () => vanish(st.c);
      return st;
    },
    run(r, s, dt) {
      const c = s.c, spot = ahead(r, 14);
      if (s.t > s.dur) s.done = true;
      if (!s.sat) {
        const d = spot - c.x;
        if (Math.abs(d) < 1.5) { s.sat = s.t; c.frames = [CAT_SIT]; c.flip = -r.face; r.icon("heart", 1); }
        else { c.x += Math.sign(d) * Math.min(Math.abs(d), 32 * dt); c.flip = Math.sign(d); }
        return stand({ carry: true, eyes: Math.abs(d) < 50 ? "wide" : "open" });
      }
      const k = s.t - s.sat;
      if (k > 1 && !s.said) { s.said = true; r.line("cat", 0.7); }
      if (k > 1 && k < 4 && Math.random() < 0.03) r.stage.add({ kind: "icon", map: ICONS.heart, x: c.x, y: 12, vy: 10, life: 1, fade: true });
      if (k >= 4.5 && !s.left) { s.left = true; c.frames = [CAT_A, CAT_B]; c.flip = s.side; c.vx = s.side * 30; c.life = 4; c.max = 4; c.fade = true; }
      if (k >= 6) s.done = true;
      if (k < 4.5) return stand({ crouch: 2, armF: ["low", 3 + (Math.floor(k * 4) % 2)], eyes: "closed", mouth: "smile", blush: true });
      return stand({ armF: ["up", Math.floor(k * 6) % 2 ? 2 : 0], mouth: "smile" });
    },
  },
  butterfly: {                                   // chase a butterfly with a net, catch it, let it go
    init(r) {
      roomAhead(r, 30);
      const st = { dur: 8, ox: ahead(r, near(r, 30)) };
      st.b = r.stage.add({ kind: "map", frames: [BFLY_A, BFLY_B], fps: 8, x: st.ox, y: 34, life: 12, fadeIn: true }) || {};
      st.cleanup = () => { if (st.b.life > 1.5) { st.b.vy = 25; st.b.vx = 20; st.b.life = 1.5; st.b.max = 1.5; st.b.fade = true; } };
      return st;
    },
    run(r, s) {
      const b = s.b;
      if (s.t < 3.3) { b.x = s.ox + Math.sin(s.t * 2.3) * 14; b.y = 30 + Math.sin(s.t * 5.1) * 7; r.face = Math.sign(b.x - r.x) || r.face; }
      const swing = [1.2, 2.3, 3.3].some(t0 => s.t > t0 && s.t < t0 + 0.3);
      if (s.t >= 3.3 && !s.caught) { s.caught = true; r.line("butterfly", 0.7); r.stage.sparkle(b.x, b.y, 4); }
      if (s.caught && !s.freed && s.hoop) { b.x = s.hoop.x; b.y = s.hoop.y - 2; }
      if (s.t >= 5.4 && !s.freed) { s.freed = true; b.vx = r.face * 18; b.vy = 22; b.life = 3; b.max = 3; b.fade = true; }
      if (s.t >= s.dur) s.done = true;
      const holding = s.caught && !s.freed;
      return stand({
        armF: s.freed ? ["up", Math.floor(s.t * 6) % 2 ? 2 : 0] : holding ? ["up", 0] : swing ? ["forward", 3] : ["high", 0],
        eyes: holding ? "wide" : s.freed ? "open" : "up", mouth: s.caught ? "smile" : "none",
        props: s.freed ? null : (P, g) => { const [hx, hy] = propNet(P, g.handF[0], g.handF[1], swing); s.hoop = { x: ahead(r, hx), y: hy + r.y }; },
      });
    },
  },
  juggle: {                                      // juggle three books; sometimes one comes down on the head
    init(r) { return { dur: between(r.rand, 3.5, 4.5), drop: r.rand() < 0.35, colors: [pick(r.rand, BOOKS), pick(r.rand, BOOKS), pick(r.rand, BOOKS)] }; },
    run(r, s) {
      const end = s.t > s.dur - 1;
      if (end && !s.ended) {
        s.ended = true; r.line(s.drop ? "juggle_drop" : "juggle_ok", 0.7);
        if (s.drop) { r.stage.book(r.x, r.headTop + 2, -r.face * 20, 20, s.colors[2]); for (let i = 0; i < 3; i++) r.stage.star(r.x, r.headTop); }
      }
      if (s.t >= s.dur) s.done = true;
      const k = Math.floor(s.t * 3.2) % 2;
      return stand({
        armF: end ? ["forward", 0] : ["high", k], armB: end ? (s.drop ? ["head", 0] : ["swing", 0]) : ["high", 1 - k],
        eyes: end ? (s.drop ? "closed" : "open") : "up", mouth: end ? (s.drop ? "o" : "smile") : "o",
        props: (P, g) => {
          if (end) return propStack(P, g.handF[0], g.handF[1] + 1, s.drop ? 2 : 3, 0, s.colors);
          for (let i = 0; i < 3; i++) {
            const t = s.t * 1.6 + i / 3, ph = t % 1, fwd = Math.floor(t) % 2 === 0;
            const [x0, y0] = fwd ? g.handB : g.handF, [x1, y1] = fwd ? g.handF : g.handB;
            box(P, Math.round(x0 + (x1 - x0) * ph) - 1, Math.round(Math.max(y0, y1) + 2 + Math.sin(ph * Math.PI) * 21), 3, 2, s.colors[i]);
          }
        },
      });
    },
  },
  pizza: {                                       // free seminar pizza, in three bites
    init(r) { return { dur: 4.2 }; },
    run(r, s) {
      const bites = s.t < 0.4 ? 0 : Math.min(3, Math.floor((s.t - 0.4) / 1.1) + 1);
      const biting = s.t > 0.4 && s.t < 3.7 && (s.t - 0.4) % 1.1 < 0.35;
      if (biting && Math.random() < 0.2) r.stage.add({ kind: "px", c: "#e9c46a", x: ahead(r, 6), y: r.headTop - 12, vx: r.face * 10, vy: 10, g: 80, floor: true, life: 1, fade: true });
      if (s.t > 0.6 && !s.said) { s.said = true; r.line("pizza", 0.6); }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: biting ? ["mouth", 0] : ["forward", 0], eyes: biting ? "closed" : "open", mouth: biting ? "o" : "smile",
                     props: (P, g) => propPizza(P, g.handF[0], g.handF[1] + (biting ? -1 : 1), bites) });
    },
  },
  sprout: {                                      // plant a seed, water it, watch it grow into a flower
    init(r) { roomAhead(r, 24); return { dur: 7, petal: pick(r.rand, ["#ff6b9a", "#ffd43b", "#b197fc", "#ff8787", "#74c0fc"]) }; },
    run(r, s) {
      const plant = s.t < 1, water = s.t >= 1 && s.t < 3.4, grow = clamp((s.t - 1.4) / 2.6, 0, 1), admire = s.t >= 4.2;
      if (water && s.spout && Math.random() < 0.5) r.stage.add({ kind: "px", c: "#74c0fc", x: s.spout.x, y: s.spout.y, vy: -10, g: 120, floor: true, life: 0.7, fade: true });
      if (admire && !s.said) { s.said = true; r.icon("heart", 1.1); r.line("sprout", 0.7); }
      if (s.t >= s.dur) { s.done = true; item(r, FLOWER, 13, { life: 8, fade: true, pal: { L: s.petal } }); }
      return stand({
        crouch: plant ? 3 : water ? 1 : 0, armF: plant ? ["low", 3] : water ? ["forward", 2] : ["swing", 0],
        eyes: admire ? "closed" : "down", mouth: admire ? "smile" : "none", blush: admire,
        props: (P, g) => {
          if (!s.done) propPlant(P, 11, grow, s.petal);
          if (water) { propCan(P, g.handF[0], g.handF[1]); s.spout = { x: ahead(r, g.handF[0] + 8), y: g.handF[1] + 2 + r.y }; }
        },
      });
    },
  },
  dance: {                                       // a little victory dance
    init(r) { r.line("dance", 0.8); return { dur: 3.2 }; },
    run(r, s) {
      const beat = Math.floor(s.t * 4) % 4, hb = Math.floor(s.t * 2);
      r.y = Math.abs(Math.sin(s.t * Math.PI * 2)) * 6;
      if (hb !== s.hb) { s.hb = hb; if (hb > 0) r.face *= -1; r.stage.sparkle(r.x, r.headTop, 3); }
      if (s.t >= s.dur) { r.y = 0; s.done = true; }
      return stand({ armF: [beat % 2 ? "up" : "high", beat % 2], armB: [beat % 2 ? "high" : "up", 0], mouth: "smile", eyes: "closed", blush: true,
                     liftF: beat === 1 ? 1 : 0, liftB: beat === 3 ? 1 : 0 });
    },
  },
  sneeze: {                                      // a dusty old book... ACHOO
    init(r) { roomAhead(r, 20); return { dur: 4.4 }; },
    run(r, s, dt) {
      const open = s.t > 0.4, tickle = s.t > 1 && s.t < 2.2, achoo = s.t >= 2.2;
      if (open && !achoo && Math.random() < 0.15) r.stage.add({ kind: "smoke", c: "#d8c9a3", x: ahead(r, 9), y: r.headTop - 14, vx: r.face * 4, vy: 6, life: 1, size: 2 });
      if (achoo && !s.boom) {
        s.boom = true; r.say(LINES.achoo || "ACHOO!", 1.3); r.stage.dust(ahead(r, 10), 8);
        for (let i = 0; i < 4; i++) r.stage.paper(ahead(r, 8), r.headTop - 10, r.face * between(r.rand, 10, 40), between(r.rand, 20, 50));
      }
      if (achoo && s.t < 2.5) { const [lo, hi] = r.stage.range(); r.x = clamp(r.x - r.face * 30 * dt, lo, hi); }
      if (s.t > 3.2 && !s.said) { s.said = true; r.line("sneeze_after", 0.7); }
      if (s.t >= s.dur) s.done = true;
      if (achoo) return stand({ eyes: s.t < 2.6 ? "closed" : "wide", mouth: "o", armF: ["up", 1], armB: ["up", 0], liftF: s.t < 2.5 ? 1 : 0 });
      return stand({ armF: ["forward", 0], armB: ["forward", 1], eyes: tickle ? "closed" : "down", nod: tickle ? Math.floor(s.t * 5) % 2 : 1,
                     mouth: tickle ? (Math.floor(s.t * 6) % 2 ? "o" : "flat") : "none",
                     props: open ? (P, g) => PROPS.book(P, r.a, g.handF[0], g.handF[1]) : null });
    },
  },
  duck: {                                        // rubber duck debugging
    init(r) {
      roomAhead(r, 22);
      const st = { dur: 6.4 };
      st.d = item(r, DUCK, near(r, 14), { life: 10, flip: -r.face });
      st.cleanup = () => vanish(st.d);
      return st;
    },
    run(r, s) {
      const talk = s.t > 0.6 && s.t < 3.6;
      if (s.t > 0.8 && !s.said) { s.said = true; r.line("duck_talk", 0.8); }
      for (const t0 of [2, 3]) if (s.t > t0 && !s["q" + t0]) { s["q" + t0] = true; r.stage.add({ kind: "icon", map: ICONS.note, x: s.d.x, y: 12, vy: 14, life: 1, fade: true }); }
      if (s.t > 3.8 && !s.aha) { s.aha = true; r.icon("bulb", 1.3); r.line("duck_done", 0.9); }
      if (s.t > 5.2 && !s.got) { s.got = true; vanish(s.d); }
      if (s.t >= s.dur) s.done = true;
      if (s.t < 0.6 || (s.t > 4.8 && s.t < 5.4)) return stand({ crouch: 3, armF: ["low", 3], eyes: "down" });
      return stand({ crouch: talk ? 1 : 0, armF: talk ? ["forward", Math.floor(s.t * 3) % 3] : s.aha ? ["up", 0] : ["swing", 0],
                     eyes: s.aha ? "wide" : "down", mouth: talk ? (Math.floor(s.t * 7) % 2 ? "o" : "flat") : s.aha ? "smile" : "none" });
    },
  },
  globe: {                                       // spin the globe, stop it with a finger
    init(r) { return { dur: between(r.rand, 3.5, 4.5) }; },
    run(r, s) {
      const stop = s.t > s.dur - 1;
      if (!stop) s.off = Math.floor(s.t * 7);
      if (stop && !s.said) { s.said = true; r.line("globe", 0.7); }
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: ["forward", 0], armB: stop ? ["forward", 6] : ["forward", 3 + (Math.floor(s.t * 6) % 2)], eyes: "down",
                     mouth: stop ? "smile" : "none", props: (P, g) => propGlobe(P, g.handF[0] + 1, g.handF[1] + 1, s.off || 0) });
    },
  },
  trip: {
    init(r) { r.quip("trip"); return { dur: 1.9 }; },
    run(r, s) {
      r.tilt = s.t < 0.18 ? s.t / 0.18 : s.t < 1.3 ? 1 : clamp(1 - (s.t - 1.3) / 0.3, 0, 1);
      if (s.t > 0.18 && !s.thud) { s.thud = true; r.stage.dust(r.x + r.face * 20, 10); }
      if (s.t > 0.3 && s.t < 1.3 && Math.random() < 0.15) r.stage.star(r.x + r.face * 38, 12);
      if (s.t >= s.dur) { r.tilt = 0; s.done = true; }
      return stand({ eyes: s.t < 1.3 ? "closed" : "open", armF: ["up", 0], armB: ["up", 0], mouth: "o" });
    },
  },
  quirk: {
    init(r) { const q = quirkOf(r.a); return { q, dur: q ? q.dur : 0 }; },
    run(r, s, dt) {
      if (!s.q || s.t >= s.dur) { r.y = 0; s.done = true; return stand({ carry: true }); }
      return s.q.run(r, s, dt);
    },
  },
  wave: {
    init(r) { r.quip("wave"); if (r.rand() < 0.35) r.icon("heart", 1.2); return { dur: 1.5 }; },
    run(r, s) {
      if (s.t >= s.dur) s.done = true;
      return stand({ armF: ["up", Math.floor(s.t * 6) % 2 ? 2 : 0], mouth: "smile", blush: true });
    },
  },
};


// Each character's own habit, done now and then between bits: their attitude in a couple of seconds.
const GUM = "#ff8fc7";
const glasses = line => ({ dur: 1.9, run(r, s) {   // push the glasses up the nose; the lenses flash
  if (s.t > 0.7 && !s.said) { s.said = true; if (line && r.rand() < 0.3) r.say(pick(r.rand, line)); }
  return stand({ armF: s.t < 0.9 ? ["face", 0] : ["swing", 0], glint: s.t > 0.45 && s.t < 1.3, mouth: "smirk", carry: s.t >= 0.9 });
} });
// A custom sprite's quirk is data: keyframes of the same pose words every bit uses (SPRITES.md). Each key holds
// until the next one; its icon or sparkle fires once as it is reached.
const KEY_POSE = ["armF", "armB", "eyes", "mouth", "brow", "blush", "glint", "crouch", "nod"];
function scriptQuirk(q) {
  return { dur: q.dur, run(r, s) {
    let k = q.keys[0];
    s.fired = s.fired || new Set();
    q.keys.forEach((key, i) => {
      if (key.t > s.t) return;
      k = key;
      if (s.fired.has(i)) return;
      s.fired.add(i);
      if (key.icon) r.icon(key.icon, 1);
      if (key.sparkle) r.stage.sparkle(r.x, r.headTop, 4);
    });
    if (q.say && !s.said && s.t >= (q.sayAt ?? 0.6)) { s.said = true; if (r.rand() < 0.5) r.say(pick(r.rand, q.say)); }
    r.y = k.hop || 0;
    const pose = { carry: !k.armF };
    for (const f of KEY_POSE) if (k[f] !== undefined) pose[f] = k[f];
    if (k.liftF) pose.liftF = 1;
    if (k.liftB) pose.liftB = 1;
    return stand(pose);
  } };
}
const quirkOf = a => QUIRKS[a.kind] || (a.quirk ? scriptQuirk(a.quirk) : QUIRKS[a.base]) || null;
const QUIRKS = {
  aris: { dur: 2.8, run(r, s) {                    // strokes the mustache, one eyebrow up
    if (s.t > 0.8 && !s.said) { s.said = true; if (r.rand() < 0.35) r.say(pick(r.rand, ["Hmm.", "Curious.", "Indeed..."])); }
    return stand({ armF: ["mouth", Math.floor(s.t * 3) % 2], brow: "skeptic", eyes: s.t < 1.4 ? "down" : "open" });
  } },
  aisha: { dur: 3, run(r, s) {                     // ticks something off on the tablet
    if (s.t > 1.9 && !s.done1) { s.done1 = true; r.icon("check", 1); }
    const tap = Math.floor(s.t * 5) % 2;
    return stand({ armF: ["forward", 0], armB: ["forward", 4 + (s.t < 1.9 ? tap : 0)], eyes: s.t < 1.9 ? "down" : "closed",
                   mouth: s.t < 1.9 ? "none" : "smile", props: (P, g) => { PROPS.tablet(P, r.a, g.handF[0], g.handF[1]); if (s.t < 1.9) propPencil(P, g.handB[0], g.handB[1] + tap); } });
  } },
  ben: { dur: 2.6, run(r, s) {                     // can't stand still: two bounces and a thumbs up
    const hop = s.t < 1.2 ? Math.abs(Math.sin(s.t / 0.6 * Math.PI)) : 0;
    r.y = hop * 4;
    if (s.t > 1.3 && !s.up) { s.up = true; r.stage.sparkle(ahead(r, 8), r.headTop - 8, 3); }
    if (s.t < 1.2) return stand({ liftF: hop > 0.2, liftB: hop > 0.2, eyes: "wide", mouth: "smile" });
    return stand({ armF: ["forward", -3], eyes: "closed", mouth: "smile", blush: true,
                   props: (P, g) => { P(g.handF[0], g.handF[1] + 2, 1, 2, r.a.skin); } });
  } },
  mei: glasses(null),
  kenji: glasses(["Interesting.", "As expected.", "Precisely."]),
  sam: { dur: 4.4, run(r, s) {                     // a bubblegum bubble, bigger, bigger... pop
    const pop = 2.8, rr = s.t < 0.5 ? 0 : Math.min(4, (s.t - 0.5) * 1.9);
    if (s.t >= pop && !s.popped) {
      s.popped = true; r.icon("bang", 0.6);
      for (let i = 0; i < 7; i++) r.stage.add({ kind: "px", c: GUM, x: ahead(r, 9), y: r.headTop - 10, vx: (Math.random() - 0.5) * 40, vy: Math.random() * 30, g: 90, life: 0.6, fade: true });
    }
    if (s.t < pop) return stand({ carry: true, eyes: "down", mouth: "o", props: rr < 1 ? null : (P, g) => {
      const R = Math.round(rr), cx = 6 + R, cy = g.head + 2;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= R * R + R) P(cx + dx, cy + dy, 1, 1, GUM);
      P(cx + Math.max(1, R - 2), cy + Math.max(1, R - 2), 1, 1, WHITE);
    } });
    return stand({ carry: true, eyes: s.t < pop + 0.8 ? "wide" : "down", mouth: s.t < pop + 0.8 ? "o" : "smirk", blush: s.t < pop + 0.8,
                   props: s.t < pop + 0.8 ? (P, g) => { P(3, g.head + 2, 4, 1, GUM); P(7, g.head + 3, 1, 1, GUM); } : null });
  } },
  evelyn: { dur: 2.6, run(r, s) {                  // peers over her reading glasses
    if (s.t > 0.8 && !s.said) { s.said = true; if (r.rand() < 0.3) r.say(pick(r.rand, ["Hmm?", "Says who, dear?", "Go on..."])); }
    return stand({ armF: s.t < 0.7 ? ["face", -1] : ["swing", 0], eyes: "up", brow: "raise", mouth: "smirk", carry: s.t >= 0.7 });
  } },
  david: { dur: 2.8, run(r, s) {                   // checks his watch and taps a foot
    if (s.t > 1.2 && !s.said) { s.said = true; if (r.rand() < 0.3) r.say(pick(r.rand, ["Time is money.", "Running late.", "Tick tock."])); }
    return stand({ armF: ["high", -3], eyes: "down", brow: "stern", mouth: "flat", liftF: s.t > 1 && Math.floor(s.t * 4) % 2 ? 1 : 0,
                   props: (P, g) => { P(g.handF[0] - 2, g.handF[1] - 2, 2, 2, "#d4a017"); P(g.handF[0] - 2, g.handF[1] - 1, 1, 1, "#fff3bf"); } });
  } },
  javier: { dur: 2.2, run(r, s) {                  // wipes his brow: phew
    if (s.t > 0.9 && !s.drop) {
      s.drop = true; r.stage.add({ kind: "px", c: "#74c0fc", x: ahead(r, 4), y: r.headTop - 6, vx: -r.face * 22, vy: 26, g: 120, floor: true, life: 0.9, fade: true });
      if (r.rand() < 0.35) r.say(pick(r.rand, ["Phew!", "Hard work!", "Almost there!"]));
    }
    return stand({ armF: s.t < 1.1 ? ["head", Math.floor(s.t * 6) % 2] : ["swing", 0], eyes: "closed", mouth: "smile" });
  } },
  hanna: { dur: 2.6, run(r, s) {                   // a big stretch and a yawn
    const up = s.t < 1.7;
    return stand({ armF: up ? ["up", 0] : ["swing", 0], armB: up ? ["up", 0] : ["swing", 0], eyes: "closed", mouth: up ? "o" : "smile",
                   liftF: up && s.t > 0.4 ? 1 : 0, liftB: up && s.t > 0.4 ? 1 : 0 });
  } },
  quill: { dur: 3.2, run(r, s) {                   // the magnifying glass up to one eye: a giant eye
    if (s.t > 1 && !s.said) { s.said = true; if (r.rand() < 0.35) r.say(pick(r.rand, ["Elementary.", "Most suspicious.", "I see..."])); }
    const scan = Math.round(Math.sin(s.t * 2.2));
    return stand({ armF: ["mouth", 1], brow: "skeptic", mouth: "smirk", props: (P, g) => {
      const cx = g.handF[0] + 1, cy = g.head + 6 + scan;
      limb(P, g.handF[0], g.handF[1], cx, cy - 4, 2, "#6d4c41");
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 <= 13) P(cx + dx, cy + dy, 1, 1, "#d8f1ff"); else if (d2 <= 20) P(cx + dx, cy + dy, 1, 1, INK);
      }
      P(cx - 2, cy + 2, 4, 1, INK); P(cx - 2, cy - 1, 4, 3, r.a.eye); P(cx - 2, cy + 1, 2, 1, WHITE); P(cx + 1, cy - 1, 1, 1, WHITE);
    } });
  } },
  pip: { dur: 3.2, run(r, s) {                     // the propeller works! for a second or so
    const lift = s.t < 0.4 ? 0 : s.t < 2.4 ? Math.min(1, (s.t - 0.4) / 0.6) : Math.max(0, 1 - (s.t - 2.4) / 0.25);
    r.y = lift * (7 + Math.sin(s.t * 9) * 1.5);
    if (s.t > 0.6 && !s.said) { s.said = true; if (r.rand() < 0.4) r.say(pick(r.rand, ["Wheee!", "Look, no hands!", "Intern power!"])); }
    if (s.t > 2.65 && !s.landed) { s.landed = true; r.y = 0; r.stage.dust(r.x, 4); }
    const flap = Math.floor(s.t * 8) % 2;
    return stand({ spin: 4, armF: lift > 0 ? ["forward", flap * 2 - 2] : ["swing", 0], armB: lift > 0 ? ["forward", 2 - flap * 2] : ["swing", 0],
                   liftF: lift > 0 ? flap : 0, liftB: lift > 0 ? 1 - flap : 0, eyes: s.landed ? "closed" : "wide", mouth: s.landed ? "smile" : "o" });
  } },
};

// How likely each bit is, by mood. Every table mixes real work with the little things that happen around it.
const LIFE = { bird: 0.5, cat: 0.4, butterfly: 0.4, dollar: 0.35, flower: 0.4, pizza: 0.4, juggle: 0.4, plane: 0.4,
               sprout: 0.4, gradcap: 0.2, dance: 0.25, globe: 0.4, sneeze: 0.4, apple: 0.3 };
const LAB = { beaker: 0.8, rocket: 0.4, microscope: 0.8, chalkboard: 0.8, corkboard: 0.8, chart: 0.6, duck: 0.5, stamp: 0.5 };
const MOODS = {
  // the mission an agent is working on right now
  busy: Object.assign({ read: 2, search: 3, notes: 2.2, notebook: 1.5, dig: 2, typing: 2, eureka: 1.2, confused: 1,
                        citation: 1.5, telescope: 1, papers: 1, stack: 1.2, coffee: 1.6, scroll: 1.2, idle: 0.6 }, LAB, LIFE),
  // standing by their worker's card on the Settings page: mostly still, now and then a little bit of business
  crew: { idle: 6, read: 1.2, notes: 1, notebook: 0.8, coffee: 1.2, typing: 0.8, citation: 0.6, scroll: 0.6, confused: 0.4,
          eureka: 0.4, telescope: 0.4, sleep: 0.3, globe: 0.3, pizza: 0.3, bird: 0.25 },
};

// On the pipeline strip the mood is the lit step, so the researcher does that step's kind of work.
Object.assign(MOODS, {
  theorist: { chalkboard: 4, corkboard: 3.5, eureka: 2, notebook: 1.5, telescope: 1.5, globe: 1, coffee: 1.2, idle: 0.8,
              read: 1, chart: 1 },
  finder: { telescope: 4, search: 3, read: 1, eureka: 1.5, notes: 1, idle: 0.5, globe: 2, butterfly: 1.5, corkboard: 1.5, coffee: 0.8 },
  sources: { search: 3, dig: 3, typing: 2, read: 2, scroll: 1.5, telescope: 1, confused: 1, coffee: 1, microscope: 1.5,
             corkboard: 1.5, sneeze: 1, notebook: 1, beaker: 0.8, apple: 0.4, bird: 0.4 },
  outreach: { typing: 3, notes: 2, search: 2, read: 1, idle: 0.6 },
  replies: { read: 2, idle: 1.5, notes: 1 },
  brief: { notes: 3, typing: 3, read: 1.5, eureka: 1.2, coffee: 1.5, papers: 1, stack: 0.8, notebook: 2.5, chalkboard: 1.5,
           chart: 1, juggle: 0.5, pizza: 0.4 },
  source_check: { search: 3, citation: 3, read: 2, confused: 1.5, notes: 1.2, stamp: 2.5, microscope: 1.5, duck: 1.5, beaker: 0.8 },
  writer: { typing: 3.5, notes: 2, coffee: 2, scroll: 1, eureka: 1, papers: 0.8, notebook: 2.5, chalkboard: 1, pizza: 0.6,
            juggle: 0.5, bird: 0.4 },
  article_check: { citation: 3, read: 2.5, search: 2, confused: 1.5, notes: 1, stamp: 2.5, duck: 1.5, chart: 1 },
  article_rating: { read: 3.5, notes: 2, stamp: 2, chart: 2, coffee: 1, eureka: 0.8, duck: 1, confused: 1 },
  publisher: { papers: 3, stack: 2, eureka: 1.5, typing: 1, dance: 2, gradcap: 1.5, rocket: 1.5, plane: 1.5 },
  "1f916": { typing: 3, idle: 1, eureka: 1, plane: 2, rocket: 1, dance: 1 },
  github: { typing: 3, idle: 1, eureka: 1, papers: 1.5, rocket: 1, dance: 1 },
  bluesky: { typing: 3, idle: 1, eureka: 1, plane: 2, bird: 1.5, dance: 1 },
});
const STEP_LINES = Object.assign({                             // said on reaching a step
  theorist: ["Connecting the dots.", "What ties these together?", "Big picture time.", "Red string, please."],
  finder: ["Scanning the horizon.", "Any new leads?", "Mission hunting."],
  sources: ["To the sources!", "Let's dig.", "Who funded this?", "Opening 47 tabs."],
  outreach: ["Who can we ask?", "Finding the experts.", "One question, short and sharp."],
  replies: ["Any answers yet?", "Checking the inbox."],
  brief: ["Writing it up.", "Brief time.", "Facts first."],
  source_check: ["Every quote, checked.", "Show me the source.", "Ctrl+F time."],
  writer: ["Drafting!", "Once upon a fact...", "Words, assemble!"],
  article_check: ["Checking the draft.", "Possibility or fact?", "Red pen out."],
  article_rating: ["Out of ten...", "Would I keep reading?", "Grading time."],
  publisher: ["Stop the presses!", "Going to print!"],
  "1f916": ["Posting to 1F916.", "One post a day!"],
  github: ["Pushing the site.", "git push, basically."],
  bluesky: ["Posting to Bluesky.", "Telling the timeline."],
}, LINES.steps);
// The closing line when a step's work ends: where the mission went (its state now), or why nobody is
// working any more. Human reviews get named, since that's where the work waits.
const CLOSERS = Object.assign({
  BRIEF_READY: ["Brief's on your desk!", "Over to you: review the brief.", "Brief filed. Your call, boss."],
  ARTICLE_READY: ["Article's ready for your red pen!", "Draft's on your desk!", "Over to you: publish it?"],
  PARKED: ["Three strikes. Parked it for you.", "Stuck. Needs a human.", "Parked. Sorry!"],
  DONE: ["Published! Next!", "Hot off the press!", "Out the door!"],
  RESEARCHING: ["Didn't pass. Back to the sources.", "Check said no. Another try soon."],
  WRITING: ["Didn't pass. Rewrite coming.", "Check said no. New draft soon."],
  AWAITING_COMMENTS: ["Now we wait for replies."],
  finder: ["New missions on the board!", "Leads found. Go get 'em!", "That's the hunt done."],
  theorist: ["New questions on the board.", "The pattern is clearer now.", "Theory filed. Finder, you're up."],
  posted: ["Posted!", "Out in the world!", "Told the world."],
  handoff: ["Passing the baton.", "Over to my colleague!", "Your turn, colleague."],
  gathered: ["Sources gathered. PI's turn!", "Over to you, Professor.", "Notes are on your desk, Prof."],
  off: ["Clocking out.", "Loop's off. Nap time.", "Shift's over!"],
  other: ["Done here!", "That's a wrap.", "My work here is cited.", "Fin."],
}, LINES.closers);
function closer(c) {
  const key = !c.running ? "off" : c.handoff ? (crewKey(c.worker) === "assistant" ? "gathered" : "handoff")
    : c.from.step === "finder" || c.from.step === "theorist" ? c.from.step
    : ["1f916", "github", "bluesky"].includes(c.from.step) && c.outcome === "DONE" ? "posted"
    : CLOSERS[c.outcome] ? c.outcome : "other";
  return pick(Math.random, CLOSERS[key]);
}

// ---------- who visits next: a shuffled roster, so everyone gets a turn ----------

// Nobody is ever on the page twice at once: `busy` is everyone out now (walking off included). The latest
// few arrivals (RECENT) are skipped too while anyone else can come, so nobody walks straight back in.
const BAG = "researcher:bag", RECENT = "researcher:recent";
function nextCharacter(busy, worker, favor = 1) {   // worker: that crew (share `favor`, else the other); none: anyone
  if (worker && Math.random() >= favor) {        // now and then, a visitor from the other crew
    const others = [...new Set(CAST.map(k => ROSTER[k].worker))].filter(w => w !== worker);
    if (others.length) worker = pick(Math.random, others);
  }
  const key = BAG + (worker ? ":" + worker : ""), crew = crewOf(worker);
  const recent = memory.get(RECENT) || [], free = k => !busy.has(k), fresh = k => free(k) && !recent.includes(k);
  let bag = (memory.get(key) || []).filter(k => crew.includes(k));
  if (!bag.some(free)) bag = shuffle(crew);      // the rest of the bag is all out: deal the crew again
  let i = bag.findIndex(fresh);
  if (i < 0) i = bag.findIndex(free);
  let kind;
  if (i >= 0) [kind] = bag.splice(i, 1);
  else kind = shuffle(enabled()).find(fresh) || shuffle(enabled()).find(free) || bag.shift() || crew[0];   // the whole crew is out: borrow
  memory.set(key, bag);
  memory.set(RECENT, [kind].concat(recent.filter(k => k !== kind)).slice(0, 3));
  return kind;
}
const onStage = () => new Set(stages.concat(guides).flatMap(s => s.cast().map(r => r.a.kind).concat(s.want ? [s.want.kind] : [])));

// ---------- a researcher ----------

class Researcher {
  constructor(stage, rec, carry) {
    this.stage = stage; this.mood = stage.mood;
    this.a = makeLook(rec.kind, rec.seed);
    this.rand = rng(rec.seed ^ 0x5bd1e995);
    const [lo, hi] = stage.range();
    this.x = carry && carry.x != null ? clamp(carry.x, lo, hi) : stage.spawnX(this.rand);
    this.face = carry && carry.face ? carry.face : (this.rand() < 0.5 ? 1 : -1);
    this.y = 0; this.alpha = 1; this.squash = 1; this.tilt = 0; this.caffeine = 0;
    this.bubble = null; this.badge = null; this.headTop = 48; this.topY = 52; this.prev = null; this.clock = 0;
    this.quipIn = stage.mood === "crew" ? between(this.rand, 6, 40) : between(this.rand, 8, 18);
    this.begin(carry ? "idle" : "spawn");
  }
  say(text, dur) {
    if (this.stage.kind === "crew" && this.stage.talking(this)) return;   // a crew takes turns to speak
    this.bubble = { text, t: 0, dur: dur || readTime(text), y: null, lines: null }; }
  quip(key) {                                    // a line for the bit, or one from the big library
    if (this.rand() < 0.65) return;              // most bits go by without a word
    const own = QUOTES[key];
    this.say(own && this.rand() < 0.4 ? pick(this.rand, own) : nextQuip());
  }
  icon(kind, dur = 1.2) { this.badge = { kind, t: 0, dur }; }
  line(key, chance = 0.6) {                      // a bit's own line, said over whatever bubble is up
    const lines = BIT_LINES[key];
    if (lines && this.rand() < chance * 0.55) this.say(pick(this.rand, lines));   // even a bit's own line is said only now and then
  }
  begin(name, opts) {
    if (this.act && this.act.cleanup) this.act.cleanup();   // a bit cut short tidies away its bird, cat or dollar
    this.y = 0;
    this.prev = this.act && this.act.name;
    this.act = Object.assign({ name, t: 0 }, ACTIONS[name].init ? ACTIONS[name].init(this, opts) : {});
  }
  chooseNext() {
    if (this.next) { const [n, o] = this.next; this.next = null; return this.begin(n, o); }
    if (this.act.name !== "rest") {              // every bit, walk or arrival is followed by a breather
      if (this.act.name !== "spawn" && this.act.name !== "chase") this.lastBit = this.act.name;
      return this.begin("rest");
    }
    const after = this.lastBit;
    if (after !== "walk" && after !== "stack" && this.rand() < (this.mood === "crew" ? 0.12 : 0.3)) return this.begin("walk");
    const table = Object.assign({}, MOODS[this.mood] || MOODS.busy);
    for (const k in this.a.fav) if (k in table || this.mood !== "crew") table[k] = (table[k] || 0.5) * this.a.fav[k];
    table.quirk = (table.quirk || 0) + (this.mood === "crew" ? 1.6 : 0.8);   // everyone's own habit
    delete table[after];
    if (this.mood !== "crew") delete table.idle;   // the rest already was the idle bit (a crew may stand on)
    this.begin(weighted(this.rand, table));
  }
  settle() { this.tilt = 0; this.y = 0; this.squash = 1; this.badge = null; this.caffeine = 0; this.next = null; }
  leave(text) {
    if (this.leaving) return;
    this.leaving = true; this.settle();
    if (text && !REDUCE) { this.next = ["despawn", { quiet: true }]; this.begin("farewell", { text }); }
    else this.begin("despawn");
  }
  chase() {                                      // the mission moved on: follow it to its next step
    if (this.leaving) return;
    this.settle(); this.mood = this.stage.mood;
    this.begin("chase");
  }
  arrive() {
    const lines = STEP_LINES[this.stage.mood];
    if (lines && this.rand() < 0.35) this.say(pick(this.rand, lines));
  }
  poke() {
    if (this.leaving || ["spawn", "trip", "wave", "despawn", "sleep"].includes(this.act.name)) return;
    this.y = 0; this.begin("wave");
  }
  update(dt) {
    this.clock += dt;
    this.caffeine = Math.max(0, this.caffeine - dt);
    if (this.bubble && (this.bubble.t += dt) > this.bubble.dur) this.bubble = null;
    if (this.badge && (this.badge.t += dt) > this.badge.dur) this.badge = null;
    if ((this.quipIn -= dt) <= 0) {               // now and then, an unprompted remark
      this.quipIn = this.mood === "crew" ? between(this.rand, 35, 75) : between(this.rand, 28, 50);
      if (!this.bubble && !this.badge && !this.leaving && ["rest", "idle"].includes(this.act.name)) this.say(nextQuip());
    }
    const act = this.act;
    act.t += dt;
    let pose = ACTIONS[act.name].run(this, act, dt);
    const prop = this.a.prop;
    if (pose.carry && prop && !pose.props) {      // keep holding the signature prop
      pose = Object.assign({}, pose);
      const pm = this.a.propMap, clock = this.clock;
      if (pm) {                                   // a custom sprite's own prop, pinned to the hand
        pose.armF = [pm.arm || "forward", 0];
        pose.props = (P, g) => paintMap(P, this.a, mapRows(pm, clock), g.handF[0] + pm.at[0], g.handF[1] + pm.at[1], pm.pal);
      } else {
        if (CARRY[prop]) pose.armF = CARRY[prop];
        const draw = PROPS[prop === "magnifier" ? "magnifierUp" : prop];
        pose.props = (P, g) => draw(P, this.a, g.handF[0], g.handF[1]);
      }
    }
    if (this.soot > 0) { this.soot -= dt; pose = Object.assign({}, pose, { soot: true }); }   // after a lab mishap
    const b = this.bubble;                       // chatter while a bubble is up, unless the bit has its own mouth
    if (b && b.t < Math.min(1.8, b.dur * 0.6) && !pose.mouth && pose.eyes !== "closed")
      pose = Object.assign({}, pose, { mouth: Math.floor(b.t * 7) % 3 === 1 ? "o" : "none" });
    if (!pose.eyes && (this.clock + this.a.phase) % 3.7 < 0.13) pose = Object.assign({}, pose, { eyes: "closed" });   // everyone blinks
    this.pose = pose;
    if (this.act === act && act.done && !this.gone) this.chooseNext();
  }
}

// ---------- stages: a canvas laid over a card or the pipeline strip ----------

// A one-pixel dark outline around the silhouette, like hand-drawn sprites: every empty pixel next to a colored
// one goes dark, unless the part there already has its own dark edge, so no edge is ever drawn twice as thick.
const INK_RGB = [0x1d, 0x1b, 0x22];
let mask = null;
function outline(off, comp) {
  const img = off.getImageData(0, 0, OFF_W, OFF_H), d = img.data, n = OFF_W * OFF_H, W = OFF_W;
  if (!mask) mask = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4)                      // 0 empty, 1 ink, 2 color, 3 a soft line
    mask[i] = !d[o + 3] ? 0 : d[o] === INK_RGB[0] && d[o + 1] === INK_RGB[1] && d[o + 2] === INK_RGB[2] ? 1
      : d[o] < 140 && SOFT.has((d[o] << 16) | (d[o + 1] << 8) | d[o + 2]) ? 3 : 2;
  // The line takes the deep shade of the color it edges (the one below it, else beside, else above), so a white
  // coat is edged in slate and a red cap in maroon; pure ink is kept for where there is no color to take.
  const edits = [];
  for (let yy = 0, i = 0; yy < OFF_H; yy++)
    for (let xx = 0; xx < W; xx++, i++) {
      const m = mask[i];
      if (m === 2) continue;
      const dn = yy < OFF_H - 1 && mask[i + W] === 2 ? i + W : -1, rt = xx < W - 1 && mask[i + 1] === 2 ? i + 1 : -1,
            lf = xx > 0 && mask[i - 1] === 2 ? i - 1 : -1, up = yy > 0 && mask[i - W] === 2 ? i - W : -1;
      const from = dn >= 0 ? dn : rt >= 0 ? rt : lf >= 0 ? lf : up;
      if (m === 0) { if (from >= 0) edits.push(i, from); }
      else if (m === 1) { if (from >= 0) edits.push(i, from); }   // drawn ink takes its neighbor's shade too
      else if (xx === 0 || xx === W - 1 || yy === 0 || yy === OFF_H - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W])
        edits.push(i, from >= 0 ? from : i);                      // a soft line on the edge of the figure is its outline
    }
  for (let k = 0; k < edits.length; k += 2) pending[k >> 1] = tintOf(d[edits[k + 1] * 4], d[edits[k + 1] * 4 + 1], d[edits[k + 1] * 4 + 2]);
  for (let k = 0; k < edits.length; k += 2) { const o = edits[k] * 4, c = pending[k >> 1]; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
  comp.putImageData(img, 0, 0);
}
const pending = [];

const OFF_W = 120, OFF_H = 96, OX = 60, OY = 86;   // the offscreen sprite canvas and the feet's place in it
const stages = [];

class Stage {
  constructor(host, kind) {
    this.host = host; this.kind = kind;
    this.key = "researcher:" + (kind === "flow" ? "flow" : kind === "crew" ? "crew:" + host.dataset.crew
      : host.getAttribute("href") || (host.dataset.id ? "note:" + host.dataset.id : "#" + host.id));   // a board note has no link
    this.mood = kind === "crew" ? "crew" : host.dataset.lab || "busy";
    this.worker = host.dataset.worker || null;   // whose crew visits a card
    this.canvas = document.createElement("canvas");
    this.canvas.className = "lab-stage";
    this.canvas.setAttribute("aria-hidden", "true");
    host.appendChild(this.canvas);
    host.classList.add("lab-host");              // keeps the card's stage room while a visitor walks off an idle card
    this.ctx = this.canvas.getContext("2d");
    this.off = this.layer(); this.comp = this.layer();
    this.fx = []; this.marks = [];
    this.layout();
    this.ro = "ResizeObserver" in window ? new ResizeObserver(() => this.layout()) : null;
    if (this.ro) this.ro.observe(host);
    this.poke = () => this.resident && this.resident.poke();
    host.addEventListener("mouseenter", this.poke);
    this.schedule();
  }
  layer() { const c = document.createElement("canvas"); c.width = OFF_W; c.height = OFF_H; return c.getContext("2d", { willReadFrequently: true }); }
  // The page swapped in a fresh copy of this stage's card: move the canvas and whoever is on it across.
  adopt(host) {
    if (this.ro) { this.ro.unobserve(this.host); this.ro.observe(host); }
    this.host.removeEventListener("mouseenter", this.poke);
    this.host = host; host.appendChild(this.canvas); host.classList.add("lab-host");
    host.addEventListener("mouseenter", this.poke);
    if (this.kind === "card") {                  // the fresh copy may name a new worker running it
      this.mood = host.dataset.lab || "busy"; this.worker = host.dataset.worker || null;
      if (this.resident) this.resident.mood = this.mood;
    }
    this.layout();
  }
  kill() { if (this.ro) this.ro.disconnect(); this.canvas.remove(); this.host.classList.remove("lab-host"); }
  // Nobody works on this card any more: its visitor walks off, nobody new comes, and the stage goes.
  retire() {
    this.retired = true; this.nextAt = null;
    memory.delete(this.key);
    if (!this.resident) this.dead = true;
    else if (!this.resident.leaving) this.resident.leave();
  }
  revive() {                                       // the card is busy again before its stage went
    this.retired = this.dead = false;
    this.mood = this.host.dataset.lab || "busy"; this.worker = this.host.dataset.worker || null;
    if (!this.resident) this.nextAt = now() + GAP_MIN;
  }
  cast() { return this.resident ? [this.resident] : []; }
  size(cssW, cssH, ground) {
    const dpr = window.devicePixelRatio || 1;
    this.cssW = cssW; this.cssH = cssH;
    this.W = Math.floor(cssW); this.H = Math.floor(cssH);
    this.ground = ground;                                            // the row the soles stand on
    this.canvas.width = Math.round(cssW * dpr); this.canvas.height = Math.round(cssH * dpr);
    this.dpr = dpr;
    const [lo, hi] = this.range();
    for (const r of this.cast()) if (!r.leaving) r.x = clamp(r.x, lo - 40, hi + 40);
    if (REDUCE) this.draw();
  }
  layout() {
    if (!this.host.isConnected || !this.host.clientWidth) return;   // detached or hidden: keep the last layout
    const h = this.canvas.clientHeight || 100;
    this.size(this.host.clientWidth, h, Math.floor(h) - 9);
  }
  range() { return [20, this.W - 20]; }
  edgeFade(x) {                                  // fade in and out over the last stretch off-stage
    const [lo, hi] = this.range();
    return clamp(Math.min(x - (lo - EDGE), hi + EDGE - x) / 26, 0, 1);
  }
  spawnX(r) {
    const [lo, hi] = this.range();
    return between(r, lo + 20, hi - 20);
  }
  pickTarget(r, max = 140) {
    const [lo, hi] = this.range();
    let x = between(r.rand, lo, hi);
    if (Math.abs(x - r.x) < 24) x = r.x + (r.rand() < 0.5 ? -1 : 1) * between(r.rand, 30, 80);
    return clamp(clamp(x, r.x - max, r.x + max), lo, hi);   // a stroll, not a cross-country hike
  }
  hop() { return 0; }                              // cards are flat
  schedule() {
    const t = now();
    let rec = memory.get(this.key);
    if (rec && (!(rec.life <= LIFE_MAX) || !ROSTER[rec.kind])) rec = null;
    if (rec && rec.kind && this.worker && rec.worker !== this.worker) rec = null;   // the step changed hands
    if (rec && rec.kind && onStage().has(rec.kind)) rec = null;                       // already out on another stage
    const out = stages.filter(s => s !== this && s.resident).length;
    if (rec && t < rec.born + rec.life - 1 && out < MAX_ON_STAGE) this.spawn(rec, true);
    else if (rec && rec.next && t < rec.next) this.nextAt = rec.next;
    else this.nextAt = t + between(Math.random, FIRST_MIN, FIRST_MAX);
  }
  spawn(rec, resume) {
    if (!rec) {
      rec = { kind: nextCharacter(onStage(), this.worker, FAVOR), seed: Math.floor(Math.random() * 2 ** 31), born: now(), worker: this.worker,
              life: between(Math.random, LIFE_MIN, LIFE_MAX) };
      memory.set(this.key, rec);
    }
    this.rec = rec; this.nextAt = null;
    this.resident = new Researcher(this, rec, resume ? rec : null);
  }
  save() {
    if (this.resident && this.rec) memory.set(this.key, Object.assign({}, this.rec, { x: this.resident.x, face: this.resident.face }));
    else if (this.nextAt) memory.set(this.key, { next: this.nextAt, life: 0 });
  }
  update(dt) {
    const t = now(), r = this.resident;
    if (r) {
      if (!r.leaving && t >= this.rec.born + this.rec.life) r.leave();
      r.update(dt);
      if (r.gone) {
        this.resident = null; this.fx.length = 0;
        if (this.retired) this.dead = true; else this.nextAt = t + between(Math.random, GAP_MIN, GAP_MAX);
      }
    }
    this.tick(dt);
  }
  tick(dt) {
    for (const p of this.fx) {
      p.life -= dt; p.vy -= (p.g || 0) * dt;
      p.x += p.vx * dt + (p.sway ? Math.sin(p.life * p.sway) * 0.6 : 0); p.y += p.vy * dt;
      if (p.trail) p.trail(p, dt);
      if (p.floor && p.y <= 0) {
        p.y = 0;
        if (p.land && !p.landed) { p.landed = true; p.land(p); }
        if (p.bounce && Math.abs(p.vy) > 25) { p.vy = -p.vy * p.bounce; p.vx *= 0.7; }
        else { p.vx *= 0.5; p.vy = 0; p.g = 0; }
      }
    }
    this.fx = this.fx.filter(p => p.life > 0);
    this.marks = this.marks.filter(m => (m.life -= dt) > 0);
  }

  // effects; x is in pixels from the left, y in pixels up from the floor
  add(p) {
    if (this.fx.length >= 140) return null;
    const q = Object.assign({ vx: 0, vy: 0, size: 2, max: p.life, ground: this.ground }, p);   // the adder's floor
    this.fx.push(q);
    return q;                                    // so a bit can steer its bird, cat or rocket
  }
  dust(x, n) { for (let i = 0; i < n; i++) this.add({ kind: "smoke", x, y: 2, vx: (Math.random() - 0.5) * 60, vy: Math.random() * 16, life: 0.5, size: 4 }); }
  dirt(x, face) { for (let i = 0; i < 6; i++) this.add({ kind: "px", c: "#7a5230", x, y: 2, vx: -face * (12 + Math.random() * 28), vy: 36 + Math.random() * 20, g: 120, life: 0.9, floor: true }); }
  steam(x, y) { this.add({ kind: "px", c: "#d5d8dc", x: x + (Math.random() - 0.5) * 4, y, vy: 12, life: 1, sway: 6, fade: true }); }
  smoke(x, y) { this.add({ kind: "smoke", x, y, vx: (Math.random() - 0.5) * 8, vy: 16, life: 1.2, size: 4 }); }
  bit(x, y) { this.add({ kind: "px", c: Math.random() < 0.5 ? "#2fc48d" : "#5fa8ff", x: x + (Math.random() - 0.5) * 8, y, vx: (Math.random() - 0.5) * 12, vy: 24, life: 0.6, fade: true }); }
  puff(x, y, face) { this.add({ kind: "px", c: "#c8ccd2", x, y, vx: face * 12, vy: 6, life: 0.4, fade: true }); }
  z(x, y) { this.add({ kind: "z", x, y, vx: 6, vy: 10, life: 2.2, sway: 3, fade: true }); }
  star(x, y) { this.add({ kind: "star", x: x + (Math.random() - 0.5) * 16, y: y + Math.random() * 6, vy: 8, life: 0.6, fade: true }); }
  sparkle(x, y, n) { for (let i = 0; i < n; i++) this.add({ kind: "star", x: x + (Math.random() - 0.5) * 36, y: y + (Math.random() - 0.5) * 20, vy: 12, life: 0.5 + Math.random() * 0.5, fade: true }); }
  paper(x, y, vx, vy) { this.add({ kind: "paper", x, y, vx, vy, g: 60, life: 2.6, sway: 8, floor: true, fade: true }); }
  book(x, y, vx, vy, c) { this.add({ kind: "book", c, x, y, vx, vy, g: 140, life: 2.2, floor: true, fade: true }); }
  hole(x, n) { this.marks.push({ kind: "hole", x, n, life: 0.05, ground: this.ground }); }

  // ---------- drawing ----------
  draw() {
    const ctx = this.ctx, k = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const G = this.ground;
    for (const m of this.marks) {
      if (m.kind === "hole") { ctx.fillStyle = "rgba(60,40,25,.55)"; ctx.fillRect(Math.round(m.x - m.n), (m.ground ?? G) - 1, m.n * 2 + 1, 3); }
    }
    const cast = this.cast();
    for (const r of cast) if (r.pose) this.drawResearcher(ctx, r);
    for (const p of this.fx) this.drawFx(ctx, p);
    for (const r of cast) this.drawOverlay(ctx, r);
  }
  drawResearcher(ctx, r) {
    const { off, comp } = this, p = r.pose;
    off.clearRect(0, 0, OFF_W, OFF_H);
    const paint = painter(off, OX, OY, r.face);
    let peak = 0;
    const P = (x, y, w, h, c) => { if (c && w > 0 && h > 0 && y + h > peak) peak = y + h; paint(x, y, w, h, c); };
    const g = drawBody(P, r.a, p, r.clock);
    if (r.flower) {                              // tucked behind an ear: a little cross of petals
      const fx = -6, fy = g.head + 7;
      P(fx + 1, fy, 1, 3, r.flower); P(fx, fy + 1, 3, 1, r.flower);
      P(fx + 1, fy + 1, 1, 1, r.flower === "#ffd43b" ? "#e8590c" : "#ffd43b");
    }
    if (p.props) {
      p.props(P, g);
      const [hx, hy] = g.handF; P(hx - 1, hy - 1, 3, 3, r.a.skin);   // fingers in front of what they hold
    }
    r.headTop = g.crown + 2 + Math.round(r.y);
    r.topY = peak + 1 + Math.round(r.y);                        // the highest pixel, props and raised arms included
    outline(off, comp);
    const x = Math.round(r.x), y = r.stage.ground - Math.round(r.y);   // a flow slot has its own row's floor
    ctx.save();
    ctx.globalAlpha = clamp(r.alpha, 0, 1);
    if (r.tilt < 0.5) {                          // a soft shadow on the floor, smaller the higher they jump
      const sw = Math.max(4, (p.sit ? 18 : 12) - Math.round(r.y / 3)), gy = r.stage.ground + 1, sx = x + (p.sit ? r.face * 4 : 0);
      ctx.fillStyle = "rgba(20,18,30,.14)";
      ctx.fillRect(sx - (sw >> 1), gy, sw, 1); ctx.fillRect(sx - (sw >> 1) + 2, gy + 1, sw - 4, 1);
    }
    ctx.translate(x, y + 1);
    if (r.tilt) { ctx.translate(0, -Math.round(r.tilt * 8)); ctx.rotate(r.face * r.tilt * Math.PI / 2); }
    if (r.squash !== 1) ctx.scale(1, r.squash);
    ctx.drawImage(comp.canvas, -OX, -OY - 1);
    ctx.restore();
    if (r.tilt > 0.9) { r.headTop = 16; r.topY = 18; }
  }
  drawFx(ctx, p) {
    const x = Math.round(p.x), y = (p.ground ?? this.ground) - Math.round(p.y);
    ctx.globalAlpha = (p.fade ? clamp(p.life / p.max * 1.5, 0, 1) : 1) * (p.fadeIn ? clamp((p.max - p.life) / 0.6, 0, 1) : 1);
    switch (p.kind) {
      case "map": {
        const map = p.frames ? p.frames[Math.floor((p.max - p.life) * (p.fps || 8)) % p.frames.length] : p.map;
        drawMap(ctx, map, x, y, p.flip || 1, p.rot || 0, p.pal);
        break;
      }
      case "icon": drawIcon(ctx, p.map, x - (p.map[0].length >> 1), y - p.map.length, 1); break;
      case "px": ctx.fillStyle = p.c; ctx.fillRect(x, y, p.size, p.size); break;
      case "smoke": {
        const s = Math.round(p.size + (1 - p.life / p.max) * 6);
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1) * 0.8;
        ctx.fillStyle = p.c || "#e4e6ea"; ctx.fillRect(x - (s >> 1), y - (s >> 1), s, s);
        ctx.fillStyle = p.c ? shade(p.c, 0.8) : "#b8bcc4"; ctx.fillRect(x - (s >> 1), y + s - (s >> 1) - 2, s, 2);
        break;
      }
      case "z": { ctx.fillStyle = "#7aa7ff"; for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (Z[r][c] === "z") ctx.fillRect(x + c * 2, y + r * 2 - 10, 2, 2); break; }
      case "star": ctx.fillStyle = "#ffd43b"; ctx.fillRect(x, y - 2, 2, 6); ctx.fillRect(x - 2, y, 6, 2); break;
      case "paper": {
        const flat = Math.floor(p.life * 6) % 2;
        ctx.fillStyle = INK; ctx.fillRect(x - 1, y - 1, flat ? 8 : 5, flat ? 5 : 8);
        ctx.fillStyle = "#ffffff"; ctx.fillRect(x, y, flat ? 6 : 3, flat ? 3 : 6);
        break;
      }
      case "book": ctx.fillStyle = darkOf(p.c); ctx.fillRect(x - 1, y - 5, 12, 6); ctx.fillStyle = p.c; ctx.fillRect(x, y - 4, 10, 4);
        ctx.fillStyle = "#fff4d6"; ctx.fillRect(x + 9, y - 4, 1, 4); ctx.fillStyle = "#ffd43b"; ctx.fillRect(x + 1, y - 4, 1, 4); break;
    }
    ctx.globalAlpha = 1;
  }
  drawOverlay(ctx, r) {
    const top = r.stage.ground - r.topY;
    if (r.badge) {
      const map = ICONS[r.badge.kind], bounce = Math.round(Math.abs(Math.sin(r.badge.t * 6)) * 3);
      const blink = r.badge.kind === "bulb" && Math.floor(r.badge.t * 8) % 2 && r.badge.t < 0.5;
      if (!blink) drawIcon(ctx, map, Math.round(r.x - map[0].length), top - map.length * 2 - 6 - bounce);
    }
    if (r.bubble && !r.badge) this.drawBubble(ctx, r, top);
  }
  drawBubble(ctx, r, top) {
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue("--bg").trim() || "#fff", fg = css.getPropertyValue("--fg").trim() || "#111";
    const b = r.bubble, LH = 12;
    ctx.font = BUBBLE_FONT;
    if (!b.lines) b.lines = wrapText(ctx, b.text, Math.min(BUBBLE_MAX, this.cssW - 16));
    const tw = Math.max(...b.lines.map(l => Math.ceil(ctx.measureText(l).width)));
    const w = Math.min(this.cssW - 2, Math.ceil((tw + 12) / 2) * 2), h = b.lines.length * LH + 6;
    // Sit clear above the highest pixel of the researcher, and only ever drift up, never down onto the head.
    const want = top - h - 10;
    b.y = b.y == null ? want : Math.min(b.y, want);
    const ty = Math.max(1, Math.round(b.y));
    const cx = Math.round(r.x), x = Math.round(clamp(cx - w / 2, 1, this.cssW - w - 1));
    ctx.globalAlpha = Math.min(1, b.t / 0.12) * Math.min(1, (b.dur - b.t) / 0.2 + 0.2);
    ctx.fillStyle = fg;
    ctx.fillRect(x + 2, ty, w - 4, h); ctx.fillRect(x, ty + 2, w, h - 4);
    ctx.fillStyle = bg;
    ctx.fillRect(x + 2, ty + 2, w - 4, h - 4);
    const tx = Math.round(clamp(cx, x + 6, x + w - 8) / 2) * 2;   // the tail points down at the speaker
    ctx.fillStyle = fg; ctx.fillRect(tx - 2, ty + h, 6, 2); ctx.fillRect(tx, ty + h + 2, 2, 2);
    ctx.fillStyle = bg; ctx.fillRect(tx, ty + h - 2, 2, 2);
    ctx.fillStyle = fg; ctx.textBaseline = "middle";
    b.lines.forEach((line, i) => ctx.fillText(line, x + 6, ty + 3 + LH * i + LH / 2 + 0.5));
    ctx.globalAlpha = 1;
  }
}

// The pipeline strip. Each busy worker's lit step gets its own researcher, from that worker's crew, who stays
// as long as the step is lit, runs after the worker's mission when it moves on, and hands off to a newcomer
// (a closing line, a walk off the nearer end) when the work ends, moves to another mission or passes to the
// other worker. Each researcher stands on a slot: the stage with its own home step and mood.
// A seat is a copy of a worker ("assistant-2" works for "assistant"), so its crew is that worker's.
const crewKey = seat => { const w = String(seat || "").split("-")[0]; return CAST.some(k => ROSTER[k].worker === w) ? w : null; };   // "desk" work: anyone
const fits = (kind, w) => !crewKey(w) || ROSTER[kind].worker === w;
class FlowStage extends Stage {
  constructor(host) { super(host, "flow"); }
  lit() {                                        // [{worker, step, slug}], from the strip's data-working
    const f = this.host.closest("#flow");
    try { return JSON.parse((f && f.dataset.working) || "[]"); } catch (e) { return []; }
  }
  // The strip is a snake of lanes, so the tiles stand in rows: each row is its own floor, and a researcher stands
  // on the row of its own step (slot.ground, slot.platforms), walking and hopping along that row only.
  row(el) {
    const top = el.offsetTop;
    return [...this.host.querySelectorAll(".step, .check")].filter(n => Math.abs(n.offsetTop - top) < 4)
      .map(n => [n.offsetLeft, n.offsetLeft + n.offsetWidth]).sort((a, b) => a[0] - b[0]);
  }
  layout() {
    if (!this.host.isConnected || !this.host.clientWidth) return;
    const nodes = [...this.host.querySelectorAll(".step, .check")];
    if (!nodes.length) return;
    this.platforms = this.row(nodes[0]);
    this.size(this.host.clientWidth, this.host.clientHeight, nodes[0].offsetTop - 1);
    for (const c of Object.values(this.crew || {})) this.aim(c.slot, c.step);
  }
  aim(slot, step) {                              // point a slot at a step: where to stand, what kind of work
    const el = step && this.host.querySelector(`.step[data-step="${step}"], .check[data-step="${step}"]`);
    slot.home = el ? this.span(el) : null;
    if (el) { slot.ground = el.offsetTop - 1; slot.platforms = this.row(el); }
    slot.mood = step || "busy";
  }
  span(el) {                                     // where a researcher can stand on a step; a check is just a post
    const a = el.offsetLeft, b = a + el.offsetWidth, c = (a + b) / 2;
    return el.classList.contains("check") ? [c - 3, c + 3] : [a + 8, Math.max(a + 9, b - 8)];
  }
  range() {
    const p = this.platforms || [[8, (this.W || 200) - 8]];
    return [p[0][0] + 6, p[p.length - 1][1] - 6];
  }
  // On a slot, `this.home` is that researcher's own step.
  spawnX(r) { return this.home ? between(r, this.home[0], this.home[1]) : super.spawnX(r); }
  pickTarget(r) { return this.home ? between(r.rand, this.home[0], this.home[1]) : r.x; }   // stay with the work
  hop(x) {                                       // jump the gaps between steps, higher over a wide one
    const p = this.platforms;
    if (!p) return 0;
    for (let i = 0; i + 1 < p.length; i++) {
      const a = p[i][1] - 2, b = p[i + 1][0] + 2;
      if (x > a && x < b) return Math.sin((x - a) / (b - a) * Math.PI) * clamp((b - a) * 0.3, 5, 26);
    }
    return 0;
  }
  cast() { return (this.leavers || []).concat(Object.values(this.crew || {}).map(c => c.r).filter(Boolean)); }
  slot(step, slug, pending) {
    const c = { step, slug, slot: Object.create(this), pending };
    this.aim(c.slot, step);
    return c;
  }
  schedule() {
    this.leavers = []; this.crew = {};
    const saved = memory.get(this.key) || {};
    for (const e of this.lit()) {
      const rec = saved[e.worker];
      this.crew[e.worker] = this.slot(e.step, e.slug, now() + 0.4);
      if (rec && rec.step === e.step && rec.slug === e.slug && ROSTER[rec.kind] && fits(rec.kind, e.worker) && !onStage().has(rec.kind))
        this.spawn(e.worker, rec, true);
    }
  }
  spawn(worker, rec, resume) {
    const c = this.crew[worker];
    if (!c) return;
    if (!rec) {
      rec = { kind: nextCharacter(onStage(), crewKey(worker)), seed: Math.floor(Math.random() * 2 ** 31) };
    }
    c.rec = Object.assign({}, rec, { step: c.step, slug: c.slug });
    c.r = new Researcher(c.slot, c.rec, resume ? rec : null);
    c.pending = null;
    if (REDUCE) return;
    // Still at most MAX_ON_STAGE on the page: the card visitors who have stayed longest head off to make room.
    const cards = stages.filter(s => s.kind === "card" && s.resident && !s.resident.leaving).sort((a, b) => a.rec.born - b.rec.born);
    let over = this.cast().filter(r => !r.leaving).length + cards.length - MAX_ON_STAGE;
    for (const s of cards) if (over-- > 0) s.resident.leave();
  }
  save() {
    const out = {};
    for (const [w, c] of Object.entries(this.crew || {})) if (c.r) out[w] = Object.assign({}, c.rec, { x: c.r.x, face: c.r.face });
    memory.set(this.key, out);
  }
  // assets/flow.js says one worker's step changed: chase, hand off, or clear its slot.
  change(c) {
    this.layout();
    const w = c.worker, cur = this.crew[w], r = cur && cur.r;
    if (!c.to.step) {
      if (r) this.dismiss(r, closer(c));
      delete this.crew[w];
    } else if (r && c.from.step && c.to.slug && c.from.slug === c.to.slug) {
      cur.step = c.to.step; cur.rec.step = c.to.step;
      this.aim(cur.slot, c.to.step);
      if (REDUCE) r.x = cur.slot.spawnX(r.rand); else r.chase();
    } else {
      if (r) this.dismiss(r, closer(c));
      this.crew[w] = this.slot(c.to.step, c.to.slug, now() + (r ? GAP_MIN : 0.2));   // the spot rests after the one leaving
    }
    if (REDUCE) still();
  }
  dismiss(r, text) {
    if (REDUCE) return;
    this.leavers.push(r);
    r.leave(text);
  }
  // admit() asks when it is someone's turn to walk in: the lit step that has waited longest gets them.
  admit(t) {
    let next = null;
    for (const [w, c] of Object.entries(this.crew)) {
      if (!c.pending || c.r || t < c.pending) continue;
      if (!c.slot.home) { c.pending = null; continue; }
      if (!next || c.pending < this.crew[next].pending) next = w;
    }
    if (next) this.spawn(next);
    return !!next;
  }
  update(dt) {
    for (const r of this.cast()) r.update(dt);
    for (const c of Object.values(this.crew)) if (c.r && c.r.gone) c.r = null;
    this.leavers = this.leavers.filter(r => !r.gone);
    this.tick(dt);
  }
}

// ---------- a crew: a worker's whole cast standing about on its Settings card ----------

class Crew extends Stage {
  constructor(host) {
    super(host, "crew");
    const crew = crewOf(host.dataset.crew);
    this.slots = crew.map((kind, i) => {
      const slot = Object.create(this);          // each researcher keeps to its own patch of floor
      slot.range = () => { const w = (this.W || 320) / crew.length; return [w * i + 10, w * (i + 1) - 10]; };
      const seed = [...kind].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
      const [lo, hi] = slot.range();
      const r = new Researcher(slot, { kind, seed }, { x: (lo + hi) / 2, face: i < crew.length / 2 ? 1 : -1 });
      r.act.t = -Math.random() * 3;               // so they don't all fidget in step
      return r;
    });
    host.addEventListener("mouseenter", () => this.slots.length && pick(Math.random, this.slots).poke());
  }
  schedule() {}                                   // always on stage: nobody visits, nobody leaves
  talking(who) { return (this.slots || []).some(r => r !== who && (r.bubble || r.badge)); }
  layout() {
    super.layout();
    for (const r of this.slots || []) { const [lo, hi] = r.stage.range(); r.x = clamp(r.x, lo, hi); }
  }
  update(dt) {
    for (const r of this.slots) r.update(dt);
    this.resident = null;
    super.update(dt);                             // effects and marks
  }
  draw() {
    const ctx = this.ctx, k = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    for (const r of this.slots) if (r.pose) this.drawResearcher(ctx, r);
    for (const p of this.fx) this.drawFx(ctx, p);
    for (const r of this.slots) this.drawOverlay(ctx, r);
  }
}

// ---------- a guide: the researcher for Researcher Chat's model, at the top of its panel ----------

const hash = text => [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
// The same model always brings the same person: its crew, then its family picks who in that crew.
function guideFor(crew, family) {
  const cast = crewOf(crewKey(crew)).sort();
  return cast[hash(family || "") % cast.length];
}

class Guide extends Stage {
  constructor(host) {
    super(host, "guide");
    this.key = "researcher:guide"; this.mood = "crew"; this.leavers = [];
  }
  schedule() {}                                   // nobody visits on a timer: the model picker sends them
  save() {}
  cast() { return (this.leavers || []).concat(this.resident ? [this.resident] : []); }
  // A model was picked: whoever stands here walks off and that model's researcher walks in. The same model
  // as the last one shown in this tab (a page change) is simply standing there already.
  show(d) {
    if (!d || !d.model) return;
    const kind = guideFor(d.crew, d.family), seed = hash(d.model);
    const line = fill(LINES.guide || "{name} here, on {model}.", { name: (LINES.names || {})[kind] || ROSTER[kind].name, model: d.model });
    const r = this.resident;
    if (r && r.a.kind === kind && this.model === d.model) return;
    const same = !r && memory.get(this.key) === d.model;
    this.model = d.model; memory.set(this.key, d.model);
    if (r) { r.leave(); this.leavers.push(r); }
    this.resident = null;
    if (REDUCE || same) {
      const [lo, hi] = this.range();
      this.resident = new Researcher(this, { kind, seed }, { x: (lo + hi) / 2, face: 1 });
      if (REDUCE) { this.leavers = []; this.resident.update(0); this.draw(); }
      return;
    }
    this.want = { kind, seed, line, at: now() + (r ? 0.8 : 0.2) };
    for (const s of stages) if (s.kind === "card" && s.resident && s.resident.a.kind === kind && !s.resident.leaving) s.resident.leave();
  }
  update(dt) {
    if (this.want && now() >= this.want.at) {
      const w = this.want;
      this.want = null;
      this.resident = new Researcher(this, w);
      this.resident.greet = w.line;
    }
    for (const r of this.leavers) r.update(dt);
    this.leavers = this.leavers.filter(r => !r.gone);
    if (this.resident) this.resident.update(dt);
    this.tick(dt);
  }
}

const BUBBLE_FONT = "700 10px ui-monospace, SFMono-Regular, Menlo, monospace", BUBBLE_MAX = 232;
// Greedy word wrap; a word too long for a line gets broken rather than spilling out of the bubble. Chinese has no
// spaces: each character may start a line, joined to its neighbours with nothing between, and closing punctuation
// never starts one.
const CJK = "\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f";
const TOKENS = new RegExp(`[${CJK}]|[^\\s${CJK}]+|\\s+`, "g"), CLOSING = /^[，。！？、：；」』）》…%]$/;
function wrapText(ctx, text, max) {
  const lines = [];
  let line = "", space = false;
  for (let word of text.match(TOKENS) || []) {
    if (/^\s+$/.test(word)) { space = true; continue; }
    const glue = space && line ? " " : "";
    space = false;
    while (ctx.measureText(word).width > max) {
      let k = word.length - 1;
      while (k > 1 && ctx.measureText(word.slice(0, k) + "-").width > max) k--;
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, k) + "-"); word = word.slice(k);
    }
    const next = line + (line ? glue : "") + word;
    if (line && !CLOSING.test(word) && ctx.measureText(next).width > max) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// ---------- start ----------

// Let waiting stages in while fewer than MAX_ON_STAGE researchers are out: a lit step on the strip first,
// then the card stages, longest-waiting first. Arrivals come one at a time, a random 12-20 s apart, so two
// never walk in together and a full page fills up over about a minute.
let nextEntry = 0;
function entered() { nextEntry = Math.max(nextEntry, now() + between(Math.random, ENTRY_MIN, ENTRY_MAX)); }
function admit() {
  const t = now();
  if (t < nextEntry || stages.reduce((n, s) => n + s.cast().length, 0) >= MAX_ON_STAGE) return;
  const flow = stages.find(s => s.kind === "flow");
  if (flow && flow.admit(t)) { entered(); return; }
  const ready = stages.filter(s => s.kind === "card" && !s.resident && !s.retired && s.nextAt && t >= s.nextAt)
    .sort((a, b) => a.nextAt - b.nextAt);
  if (ready.length) { ready[0].spawn(); entered(); }
}

// Reduced motion: still figures only, one on each lit step and the rest on cards while there's room.
function still() {
  const flow = stages.find(s => s.kind === "flow");
  if (flow) for (const [w, c] of Object.entries(flow.crew || {})) if (!c.r && c.slot.home) flow.spawn(w, null, true);
  let room = MAX_ON_STAGE - stages.reduce((n, s) => n + s.cast().length, 0);
  for (const s of stages) if (s.kind === "card" && !s.resident && room-- > 0) s.spawn(null, true);
  for (const s of stages) { for (const r of s.cast()) r.update(0); s.draw(); }
  for (const c of crews) { c.slots.forEach(r => r.update(0)); c.draw(); }
  for (const g of guides) { for (const r of g.cast()) r.update(0); g.draw(); }
}

// Find the stages on the page. After the page swaps in fresh HTML, a stage whose card (or strip) came
// back keeps its researcher on the new copy; one whose card went away saves where it was and goes. A card
// that lost its data-lab (assets/flow.js takes it off when nobody works on it) sends its visitor off.
// A worker's crew on the Settings page is its own kind of stage (Crew), found here too.
const crews = [], guides = [];
function rescan() {
  for (const s of stages.slice()) {
    if (!s.host.isConnected) {
      const sel = s.kind === "flow" ? ".flow-track[data-lab]" : s.host.dataset.id
        ? `.note[data-id="${CSS.escape(s.host.dataset.id)}"]` : `.card[href="${CSS.escape(s.host.getAttribute("href"))}"]`;
      const next = document.querySelector(sel);
      if (!next || stages.some(o => o.host === next)) { s.save(); s.kill(); stages.splice(stages.indexOf(s), 1); continue; }
      s.adopt(next);
    }
    if (s.kind !== "card") continue;
    if (!s.host.dataset.lab) { if (!s.retired) s.retire(); }
    else if (s.retired) s.revive();
    else s.worker = s.host.dataset.worker || null;   // the card changed hands: its next visitor is from that crew
  }
  for (let i = stages.length - 1; i >= 0; i--) if (stages[i].dead) { stages[i].kill(); stages.splice(i, 1); }
  document.querySelectorAll(".card[data-lab], .note[data-lab]").forEach(c => { if (!stages.some(s => s.host === c)) stages.push(new Stage(c, "card")); });
  const track = document.querySelector(".flow-track[data-lab]");
  if (track && !stages.some(s => s.host === track)) stages.push(new FlowStage(track));
  document.querySelectorAll(".crew[data-crew]").forEach(c => { if (!crews.some(o => o.host === c)) crews.push(new Crew(c)); });
  document.querySelectorAll(".chat-guide").forEach(c => {
    if (guides.some(o => o.host === c)) return;
    const g = new Guide(c);
    guides.push(g);
    if (window.chatGuide) g.show(window.chatGuide);   // the chat picked a model before this script ran
  });
  start();
}

function tick(dt) {
  admit();
  for (const s of stages) { s.update(dt); s.draw(); }
  for (let i = stages.length - 1; i >= 0; i--) if (stages[i].dead) { stages[i].kill(); stages.splice(i, 1); }
  for (const c of crews) { c.update(dt); c.draw(); }
  for (const g of guides) { g.update(dt); g.draw(); }
}
let started = false;
function start() {
  if (REDUCE) { still(); return; }
  if (started || !(stages.length || crews.length || guides.length)) return;
  started = true;
  let last = performance.now();
  const frame = t => {
    tick(clamp((t - last) / 1000, 0, 0.05)); last = t;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------- sprite specs: check, register, render (the rules are in SPRITES.md) ----------

// Everything a sprite spec may name. A spec is data only: a starting sprite plus overrides from these lists,
// colors, pinned pixel maps and keyframes. Nothing in it runs as code, so a model can write one safely.
const PARTS = {
  worker: ["assistant", "pi"],
  style: ["short", "tousled", "receding", "bob", "bigcurly", "long", "crop", "neat", "spiky"],
  head: [null, "hijab", "cap", "beanie", "hardhat", "deerstalker", "propeller"],
  outfit: ["labcoat", "suit", "hoodie", "sweater", "cardigan", "vest", "overalls", "jacket", "abaya", "trench", "tshirt"],
  face: [null, "round", "browline", "halfmoon"],
  facial: [null, "walrus", "mustache"],
  legs: ["pants", "skirt"],
  prop: [null, "tablet", "laptop", "phone", "book", "briefcase", "camera", "magnifier", "mug"],
  brow: ["flat", "raise", "stern", "worry", "skeptic"],
  mouth: ["none", "smile", "grin", "o", "flat", "smirk"],
  eyes: ["open", "closed", "happy", "down", "wide", "up"],
  arm: ["swing", "forward", "high", "low", "up", "head", "mouth", "face"],
  layer: ["back", "body", "behindHead", "head"],
  icon: Object.keys(ICONS),
};
const COLOR_KEYS = ["hair", "top", "shirt", "pants", "shoes", "pack", "tie", "bow", "hijab", "cap", "beanie", "pom", "skirt", "frame"];
const FLAG_KEYS = ["lash", "lids", "bushy", "ahoge", "grin", "freckles", "pencil", "rolled"];
const ENUM_KEYS = ["worker", "style", "head", "outfit", "face", "facial", "legs", "brow", "mouth"];
const SPEC_KEYS = new Set(["base", "name", "skin", "prop", "fav", "maps", "propMap", "quirk", ...COLOR_KEYS, ...FLAG_KEYS, ...ENUM_KEYS]);
const FAV_ACTIONS = () => Object.keys(ACTIONS).filter(k => !["spawn", "despawn", "farewell", "chase", "walk", "rest", "quirk"].includes(k));
// Where a map may reach from its anchor, as [left, bottom, right, top] in pixels (x toward the face, y up).
// One size only: these boxes keep every sprite inside the body the animations were drawn for.
const MAP_BOX = { head: [-9, -3, 10, 22], behindHead: [-9, -3, 10, 22], body: [-12, -9, 10, 16], back: [-12, -9, 10, 16] };
const PROP_BOX = [-6, -10, 12, 12];
const FACE_BOX = [-1, 1, 6, 8];                    // eyes, brows-to-mouth: drawn by code so faces can act; maps stay off
const SPRITE_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

function checkMap(m, where, box, errors, face) {
  if (!m || typeof m !== "object") return errors.push(`${where}: should be an object`);
  const frames = m.frames || (m.rows ? [m.rows] : null);
  if (!Array.isArray(frames) || !frames.length || frames.length > 4) return errors.push(`${where}: needs rows, or 1 to 4 frames of rows`);
  if (m.frames && m.rows) errors.push(`${where}: give rows or frames, not both`);
  if (m.fps !== undefined && !(Number.isFinite(m.fps) && m.fps >= 1 && m.fps <= 12)) errors.push(`${where}.fps: 1 to 12`);
  if (!Array.isArray(m.at) || m.at.length !== 2 || !m.at.every(Number.isInteger)) return errors.push(`${where}.at: [x, y] whole numbers`);
  const pal = m.pal || {};
  if (typeof pal !== "object" || Array.isArray(pal)) return errors.push(`${where}.pal: letters to #rrggbb colors`);
  for (const [ch, c] of Object.entries(pal)) {
    if (!/^[A-Za-z0-9]$/.test(ch) || ch in SLOTS) errors.push(`${where}.pal: "${ch}" can't be defined (one letter or digit, not a color slot: ${Object.keys(SLOTS).join(" ")})`);
    if (!HEX.test(c)) errors.push(`${where}.pal.${ch}: "${c}" is not #rrggbb`);
  }
  frames.forEach((rows, f) => {
    const at = m.frames ? `${where}.frames[${f}]` : `${where}.rows`;
    if (!Array.isArray(rows) || !rows.length || rows.length > 24 || !rows.every(r => typeof r === "string"))
      return errors.push(`${at}: 1 to 24 strings`);
    const w = rows[0].length;
    if (!w || w > 24 || rows.some(r => r.length !== w)) return errors.push(`${at}: every row the same width, 1 to 24`);
    rows.forEach((row, i) => [...row].forEach((ch, j) => {
      if (ch === ".") return;
      if (!(ch in SLOTS) && !(ch in pal)) return errors.push(`${at}[${i}]: "${ch}" isn't in pal or a color slot`);
      const x = m.at[0] + j, y = m.at[1] + rows.length - 1 - i;
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) errors.push(`${at}[${i}]: pixel (${x}, ${y}) is outside [${box}]`);
      else if (face && x >= FACE_BOX[0] && x <= FACE_BOX[2] && y >= FACE_BOX[1] && y <= FACE_BOX[3])
        errors.push(`${at}[${i}]: pixel (${x}, ${y}) covers the face; eyes, mouth and brows are drawn by code`);
    }));
  });
}

function checkQuirk(q, errors) {
  if (!q || typeof q !== "object") return errors.push("quirk: should be an object");
  if (!(Number.isFinite(q.dur) && q.dur >= 0.5 && q.dur <= 6)) errors.push("quirk.dur: 0.5 to 6 seconds");
  if (!Array.isArray(q.keys) || !q.keys.length || q.keys.length > 12) return errors.push("quirk.keys: 1 to 12 keyframes");
  if (q.say !== undefined && !(Array.isArray(q.say) && q.say.length <= 5 && q.say.every(t => typeof t === "string" && t.length >= 1 && t.length <= 40)))
    errors.push("quirk.say: up to 5 lines of 1 to 40 characters");
  if (q.sayAt !== undefined && !(Number.isFinite(q.sayAt) && q.sayAt >= 0 && q.sayAt <= q.dur)) errors.push("quirk.sayAt: within dur");
  const known = new Set(["t", "hop", "liftF", "liftB", "icon", "sparkle", ...KEY_POSE]);
  let last = -1;
  q.keys.forEach((k, i) => {
    const at = `quirk.keys[${i}]`;
    if (!k || typeof k !== "object") return errors.push(`${at}: should be an object`);
    for (const f of Object.keys(k)) if (!known.has(f)) errors.push(`${at}.${f}: unknown (use ${[...known].join(", ")})`);
    if (!(Number.isFinite(k.t) && k.t >= 0 && k.t <= q.dur)) errors.push(`${at}.t: 0 to dur`);
    else if (k.t < last) errors.push(`${at}.t: keys go in time order`);
    else last = k.t;
    for (const f of ["armF", "armB"]) if (k[f] !== undefined && !(Array.isArray(k[f]) && PARTS.arm.includes(k[f][0]) && Number.isInteger(k[f][1] ?? 0) && Math.abs(k[f][1] ?? 0) <= 4))
      errors.push(`${at}.${f}: [mode, nudge] with mode one of ${PARTS.arm.join(", ")} and nudge -4 to 4`);
    for (const f of ["eyes", "mouth", "brow", "icon"]) if (k[f] !== undefined && !PARTS[f].includes(k[f])) errors.push(`${at}.${f}: one of ${PARTS[f].join(", ")}`);
    for (const f of ["blush", "glint", "sparkle", "liftF", "liftB", "nod"]) if (k[f] !== undefined && typeof k[f] !== "boolean") errors.push(`${at}.${f}: true or false`);
    if (k.hop !== undefined && !(Number.isFinite(k.hop) && k.hop >= 0 && k.hop <= 10)) errors.push(`${at}.hop: 0 to 10 pixels`);
    if (k.crouch !== undefined && !(Number.isInteger(k.crouch) && k.crouch >= 0 && k.crouch <= 3)) errors.push(`${at}.crouch: 0 to 3`);
  });
}

// Checks a spec against the rules and returns { ok, errors, sprite }: sprite is the spec laid over its starting
// sprite, ready for registerSprite or renderSprite. Errors say what to change, so a model can fix its own spec.
function validateSprite(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, errors: ["a sprite spec is a JSON object"] };
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) errors.push(`${k}: not a sprite field (see SPRITES.md)`);
  if (!BUILT_IN.has(spec.base)) errors.push(`base: start from one of ${[...BUILT_IN].join(", ")}`);
  if (typeof spec.name !== "string" || !/^[\p{L}\p{N} .'\-]{1,24}$/u.test(spec.name)) errors.push("name: 1 to 24 letters, digits, spaces, . ' -");
  for (const k of ENUM_KEYS) {                    // facial may be a list too: one is picked per visit
    const v = k === "facial" && Array.isArray(spec[k]) ? spec[k] : [spec[k]];
    if (k in spec && !(v.length && v.every(x => PARTS[k].includes(x)))) errors.push(`${k}: one of ${PARTS[k].map(String).join(", ")}`);
  }
  for (const k of FLAG_KEYS) if (k in spec && typeof spec[k] !== "boolean") errors.push(`${k}: true or false`);
  for (const k of COLOR_KEYS) if (k in spec) {
    const v = Array.isArray(spec[k]) ? spec[k] : [spec[k]];
    if (!v.length || v.length > 8 || !v.every(c => HEX.test(c))) errors.push(`${k}: a #rrggbb color or a list of up to 8 (one is picked per visit)`);
  }
  if ("skin" in spec && !(Array.isArray(spec.skin) && spec.skin.length && spec.skin.every(i => Number.isInteger(i) && i >= 0 && i < SKIN.length)))
    errors.push(`skin: a list of tones 0 to ${SKIN.length - 1}`);
  if ("prop" in spec) {
    const v = Array.isArray(spec.prop) ? spec.prop : [spec.prop];
    if (!v.length || !v.every(x => PARTS.prop.includes(x))) errors.push(`prop: one of ${PARTS.prop.map(String).join(", ")}, or a list`);
  }
  if ("fav" in spec) {
    const acts = FAV_ACTIONS();
    if (!spec.fav || typeof spec.fav !== "object") errors.push("fav: action names to weights");
    else for (const [k, w] of Object.entries(spec.fav)) {
      if (!acts.includes(k)) errors.push(`fav.${k}: not an action (${acts.join(", ")})`);
      if (!(Number.isFinite(w) && w >= 0 && w <= 5)) errors.push(`fav.${k}: a weight 0 to 5`);
    }
  }
  if ("maps" in spec) {
    if (!Array.isArray(spec.maps) || spec.maps.length > 8) errors.push("maps: a list of up to 8");
    else spec.maps.forEach((m, i) => {
      if (!m || !PARTS.layer.includes(m.layer)) return errors.push(`maps[${i}].layer: one of ${PARTS.layer.join(", ")}`);
      for (const f of Object.keys(m)) if (!["layer", "at", "rows", "frames", "fps", "pal"].includes(f)) errors.push(`maps[${i}].${f}: unknown`);
      checkMap(m, `maps[${i}]`, MAP_BOX[m.layer], errors, m.layer === "head");
    });
  }
  if ("propMap" in spec) {
    const m = spec.propMap;
    if (m && m.arm !== undefined && !PARTS.arm.includes(m.arm)) errors.push(`propMap.arm: one of ${PARTS.arm.join(", ")}`);
    if (m) for (const f of Object.keys(m)) if (!["arm", "at", "rows", "frames", "fps", "pal"].includes(f)) errors.push(`propMap.${f}: unknown`);
    checkMap(m, "propMap", PROP_BOX, errors, false);
  }
  if ("quirk" in spec) checkQuirk(spec.quirk, errors);
  if (errors.length) return { ok: false, errors };
  const sprite = Object.assign({}, ROSTER[spec.base], JSON.parse(JSON.stringify(spec)));
  return { ok: true, errors: [], sprite };
}

// Adds a checked sprite to the cast under `key` (custom-sprite-1, or any name: lowercase, digits, dashes).
// It joins its worker's crew straight away; built-in names can't be replaced.
function registerSprite(key, spec) {
  if (!SPRITE_KEY.test(String(key))) return { ok: false, errors: ["key: lowercase letters, digits and dashes, up to 32"] };
  if (BUILT_IN.has(key)) return { ok: false, errors: [`key: ${key} is a built-in sprite`] };
  const v = validateSprite(spec);
  if (!v.ok) return v;
  ROSTER[key] = v.sprite;
  if (!CAST.includes(key)) CAST.push(key);
  return v;
}
function setSpriteEnabled(key, on) { if (on) OFF.delete(key); else OFF.add(key); }

// Draws one still of a sprite (a key, or a spec to preview without registering it) into a canvas, feet at the
// bottom middle. opts: scale (whole number, default 1), action (default "rest"), t (seconds into it), seed, face
// (1 right, -1 left), width/height (sprite pixels, default 44 x 60), effects (also run and draw the bit's sparkles,
// steam and icons, for a live preview). Returns { ok, errors }.
function renderSprite(canvas, sprite, opts = {}) {
  let kind = sprite, temp = false;
  if (typeof sprite !== "string") {
    const v = validateSprite(sprite);
    if (!v.ok) return v;
    kind = "__preview"; temp = true; ROSTER[kind] = v.sprite;
  }
  if (!ROSTER[kind]) return { ok: false, errors: [`no sprite called ${kind}`] };
  const action = opts.action || "rest";
  if (!ACTIONS[action]) { if (temp) delete ROSTER[kind]; return { ok: false, errors: [`no action called ${action}`] }; }
  const W = opts.width || 44, H = opts.height || 60, k = Math.max(1, Math.round(opts.scale || 1));
  const st = Object.create(Stage.prototype);
  Object.assign(st, { kind: "card", mood: "busy", fx: [], marks: [], W, H, cssW: W, cssH: H, ground: H - 4, dpr: 1 });
  st.off = st.layer(); st.comp = st.layer(); st.range = () => [-999, 999]; st.talking = () => false;
  try {
    const r = new Researcher(st, { kind, seed: opts.seed ?? 7 }, { x: W / 2, face: opts.face || 1 });
    r.say = r.quip = r.line = () => {};
    r.begin(action);
    if (action === "rest") { r.act.tx = null; r.act.turn = -1; }
    if (!opts.effects) r.icon = () => {};
    for (let t = 0; t < (opts.t ?? 0.5) && r.act.name === action; t += 1 / 60) {
      r.update(1 / 60); r.x = W / 2;
      if (opts.effects) st.tick(1 / 60);   // the researcher times its own icon; the stage moves the sparkles
    }
    if (!r.pose) r.update(0);
    const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext("2d");
    st.drawResearcher(tctx, r);
    if (opts.effects) { for (const p of st.fx) st.drawFx(tctx, p); if (r.badge) st.drawOverlay(tctx, r); }
    canvas.width = W * k; canvas.height = H * k;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tmp, 0, 0, W * k, H * k);
  } finally { if (temp) delete ROSTER[kind]; }
  return { ok: true, errors: [] };
}

for (const [key, spec] of Object.entries(SPRITE_CONFIG.add || {})) {   // sprites the page asked for
  const v = registerSprite(key, spec);
  if (!v.ok) console.warn(`researchers: sprite ${key} skipped:`, v.errors.join("; "));
}

function boot() {
  addEventListener("pagehide", () => stages.forEach(s => s.save()));
  document.addEventListener("flowchange", e => { const f = stages.find(s => s.kind === "flow"); if (f) f.change(e.detail); });
  document.addEventListener("chatguide", e => guides.forEach(g => g.show(e.detail)));
  rescan();
}
window.Researchers = { stages, crews, guides, guideFor, ROSTER, makeLook, ACTIONS, Stage, FlowStage, Crew, Researcher, rescan, tick, QUIPS,
  PARTS, SLOTS, MAP_BOX, PROP_BOX, FACE_BOX, CAST, SKIN, BUILT_IN: [...BUILT_IN], FLAG_KEYS, COLOR_KEYS, enabled, crewOf, validateSprite, registerSprite, renderSprite, setSpriteEnabled };   // see SPRITES.md
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
