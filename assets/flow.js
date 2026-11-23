/* The pipeline strip, kept live. Every two seconds it asks /api/flow what is happening and relights the
 * strip in place: the steps working right now (one per busy worker), the counts waiting at each human review
 * (none on the reviews auto mode does), parked at each check and held at each tile (missions there now), and the
 * lines underneath. It relights the mission cards below the same way, one
 * per busy worker, so they never wait on the page's own refresh (which holds off while you type or chat).
 * It never reloads the page, so the pixel researchers on the strip keep walking. When a worker's step changes it fires a "flowchange" event on #flow saying which
 * worker and where its work went, which assets/researchers.js turns into that worker's researcher chasing
 * the work or handing it off. On the published About page (data-demo) nothing is polled: assets/about.js plays
 * a made-up run through Flow.apply instead.
 */
(() => {
"use strict";
if (window.Flow) return;

const EVERY = 2000;
let root = null, timer = null, last = null, busy = false;

// The strip never scrolls sideways: it shrinks (--s) to fit the panel, and when that would make its labels too
// small to read it stacks instead (the .stack class): one column in flow order, each lane wrapping.
const MIN_SCALE = 0.72, STACK_SCALE = 0.95;

// How much too wide the strip is (1 = it fits): the whole track, and each lane against its own space. A lane can
// run under the review beside it while staying inside the track, so each lane adds up what it holds: its tiles
// and its arrows at their shortest (they only stretch while there is room).
function tooWide(track) {
  let need = track.scrollWidth / Math.max(track.clientWidth, 1);
  track.querySelectorAll(":scope > .lane").forEach(lane => {
    let w = 0;
    lane.querySelectorAll(":scope > .unit > *, :scope > .join").forEach(c => { w += c.getBoundingClientRect().width; });
    if (lane.clientWidth) need = Math.max(need, w / lane.clientWidth);
  });
  return need;
}

function fit() {
  const track = root && root.querySelector(".flow-track");
  if (!track) return;
  root.classList.remove("stack");
  track.style.setProperty("--s", "1");
  let s = 1;
  for (let i = 0, need = tooWide(track); i < 6 && need > 1.002; i++, need = tooWide(track)) {   // borders don't scale, so refine
    s /= need;
    if (s < MIN_SCALE) break;
    track.style.setProperty("--s", String(Math.floor(s * 1000) / 1000));
  }
  if (s < MIN_SCALE) {
    root.classList.add("stack");
    track.style.setProperty("--s", String(STACK_SCALE));
  }
}
let observer = null;

function attach() {
  const el = document.getElementById("flow");
  if (!el) return;
  if (el !== root) {
    root = el;
    if ("ResizeObserver" in window) {
      if (observer) observer.disconnect();
      observer = new ResizeObserver(() => requestAnimationFrame(fit));
      observer.observe(el);
    }
    fit();
    last = { working: byWorker(JSON.parse(el.dataset.working || "[]")), waiting: {} };
    el.querySelectorAll(".human[data-step]:not(.auto)").forEach(h => {
      last.waiting[h.dataset.step] = Number(h.querySelector(".count").textContent) || 0;
    });
  }
  if (!timer && !root.hasAttribute("data-demo")) {   // the About page's demo strip has no server to ask
    timer = setInterval(poll, EVERY);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  }
}

function byWorker(list) {                       // {worker: {step, slug}}
  const out = {};
  for (const e of list) out[e.worker] = { step: e.step, slug: e.slug };
  return out;
}

async function poll() {
  if (busy || document.hidden || !root || !root.isConnected) return;
  busy = true;
  try {
    const res = await fetch("/api/flow", { cache: "no-store" });
    if (res.ok) apply(await res.json());
  } catch (e) { /* the UI server is restarting; try again next time */ }
  busy = false;
}

function apply(d) {
  const shown = new Set([...root.querySelectorAll(".flow-track [data-step]")].map(e => e.dataset.step));
  const working = d.working.filter(e => shown.has(e.step)), lit = {};
  for (const e of working) lit[e.step] = e.worker.split("-")[0];   // a seat ("assistant-2") lights its worker's colours
  root.classList.toggle("off", !d.running);
  root.querySelectorAll(".step[data-step], .check[data-step]").forEach(e => {
    const w = lit[e.dataset.step];
    e.classList.toggle("on", !!w);
    if (w) { e.setAttribute("aria-current", "step"); e.dataset.worker = w; }
    else { e.removeAttribute("aria-current"); delete e.dataset.worker; }
  });
  root.querySelectorAll(".human[data-step]:not(.auto)").forEach(h => {   // auto mode's steps wait on nobody
    const key = h.dataset.step, n = d.waiting[key] || 0, count = h.querySelector(".count");
    count.textContent = n; count.hidden = !n;
    h.classList.toggle("waiting", n > 0);
    if (n > (last.waiting[key] || 0)) arrive(h);        // something just landed on your desk
    last.waiting[key] = n;
  });
  root.querySelectorAll(".check[data-step]").forEach(c => {
    const n = d.parked[c.dataset.step] || 0, b = c.querySelector(".parked-count");
    if (b) { b.textContent = n; b.hidden = !n; b.title = ((window.I18N || {})["{n} parked here"] || "{n} parked here").replace("{n}", n); }
  });
  const held = d.held || {}, heldTitle = (window.I18N || {})["Missions at this step: {n}"] || "Missions at this step: {n}";
  root.querySelectorAll(".held").forEach(b => {
    const n = held[b.parentElement.dataset.step] || 0;
    b.textContent = n; b.hidden = !n; b.title = heldTitle.replace("{n}", n);
  });
  relightCards(d.working);
  const now = root.querySelector(".now");
  if (now && now.dataset.html !== d.now) { now.innerHTML = d.now; now.dataset.html = d.now; }

  // One event per worker whose step changed. A mission another worker has just picked up was handed over.
  const atWork = byWorker(working), flipped = last.running !== undefined && last.running !== d.running;
  root.dataset.working = JSON.stringify(working.map(e => ({ worker: e.worker, step: e.step, slug: e.slug })));
  let moved = false;
  for (const w of new Set([...Object.keys(last.working), ...Object.keys(atWork)])) {
    const was = last.working[w] || {}, is = atWork[w] || {};
    const from = { step: was.step || null, slug: was.slug ?? null }, to = { step: is.step || null, slug: is.slug ?? null };
    if (from.step === to.step && from.slug === to.slug) continue;
    moved = true;
    const outcome = from.slug ? d.states[from.slug] || null : null;
    const handoff = !!from.slug && working.some(e => e.worker !== w && e.slug === from.slug);
    root.dispatchEvent(new CustomEvent("flowchange", { bubbles: true, detail: { worker: w, from, to, outcome, handoff, running: d.running } }));
  }
  last.working = atWork; last.running = d.running;
  if ((moved || flipped) && window.checkPage) setTimeout(window.checkPage, 300);   // bring the rest of the page up to date too
}

// Each mission card a worker is on gets the green outline, the "working on this now" line (ui.working_on
// writes the same words) and, in the In progress group, researcher visitors from that worker's crew. A card
// nobody works on goes back to its idle line and its visitor walks off.
function relightCards(working) {
  const on = {};
  for (const e of working) if (e.slug) on[e.slug] = e;
  let changed = false;
  document.querySelectorAll('a.card[href^="/m/"]').forEach(card => {
    const e = on[decodeURIComponent(card.getAttribute("href").slice(3))];
    card.classList.toggle("active", !!e);
    const doing = card.querySelector(".doing");
    if (doing) {
      const text = e ? `${e.name} working now` : doing.dataset.idle || "";
      const shown = text ? ` · ${text}` : "";
      if (doing.textContent !== shown) doing.textContent = shown;
    }
    if (!card.closest("[data-lab-ok]")) return;
    const lab = e ? "busy" : null, worker = e && e.worker !== "desk" ? e.worker.split("-")[0] : null;   // the seat's crew
    if ((card.dataset.lab || null) === lab && (card.dataset.worker || null) === worker) return;
    if (lab) card.dataset.lab = lab; else delete card.dataset.lab;
    if (worker) card.dataset.worker = worker; else delete card.dataset.worker;
    changed = true;
  });
  if (relightDesk(working) || changed) { if (window.Researchers) window.Researchers.rescan(); }
}

// The Inspiration box is the desk's card (ui.finder_panel): the Theorist and the mission finder work for the
// whole desk (no slug), so it lights while either does, and its visitor does that agent's kind of work.
const DESK = ["theorist", "finder"];
function relightDesk(working) {
  const box = document.querySelector("[data-desk]");
  if (!box) return false;
  const e = working.find(w => !w.slug && DESK.includes(w.step));
  box.classList.toggle("active", !!e);
  const hint = box.querySelector(".hint[data-idle]");
  if (hint) {
    const text = e ? `${e.name} working now` : hint.dataset.idle;
    if (hint.textContent !== text) hint.textContent = text;
  }
  if (!box.hasAttribute("data-lab-ok")) return false;   // animations off: no visitors
  const lab = e ? e.step : null, worker = e && e.worker !== "desk" ? e.worker.split("-")[0] : null;
  if ((box.dataset.lab || null) === lab && (box.dataset.worker || null) === worker) return false;
  if (lab) box.dataset.lab = lab; else delete box.dataset.lab;
  if (worker) box.dataset.worker = worker; else delete box.dataset.worker;
  return true;
}

function arrive(h) {
  h.classList.remove("arrived");
  void h.offsetWidth;                                     // restart the animation
  h.classList.add("arrived");
  setTimeout(() => h.classList.remove("arrived"), 3200);
}

window.addEventListener("resize", () => requestAnimationFrame(fit));
window.Flow = { attach, poll, fit, apply };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach); else attach();
})();
