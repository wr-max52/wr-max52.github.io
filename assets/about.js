/* The published site's About page: the pipeline strip plays one made-up mission running the whole line (#139),
 * through the same relighting the UI uses (assets/flow.js, Flow.apply). The researchers on the strip carry it
 * (assets/researchers.js, Tour): each time the work reaches a box they send a "tourstep" event and the box lights
 * here, so the lights follow them. With no scene (reduced motion), the boxes light in turn on a timer instead,
 * and a "tourframe" event tells researchers.js where to stand a still figure.
 * Nothing here talks to a server; the loop and its missions never leave the machine that runs them.
 */
(() => {
"use strict";
const EVERY = 3000;                                      // ms per box when no scene drives the lights
const NO_SCENE = 2500;                                   // ms to wait for the scene before lighting on a timer
const WORKERS = { assistant: "Research Assistant", pi: "Principal Investigator", desk: "Code" };
const AGENTS = { theorist: "Theorist", finder: "Mission finder", sources: "Source finder", brief: "Brief writer",
                 source_check: "Source checker", writer: "Article writer", article_check: "Article checker",
                 article_rating: "Article rater", publisher: "Publisher", theorist_check: "Theorist check",
                 finder_check: "Finder check", rating_check: "Rating check" };
const DOING = { theorist: "is looking across every mission for patterns", finder: "is searching for new missions",
                sources: "is searching and reading sources for", brief: "is writing the brief for",
                source_check: "is checking every quote in the brief for", writer: "is writing the article for",
                article_check: "is checking the article's citations for", article_rating: "is rating the article for",
                publisher: "is publishing", theorist_check: "is holding the Theorist to its rules",
                finder_check: "is checking each new lead rests on a real page",
                rating_check: "is adding up the rating for" };
const REVIEWS = { epic_review: "1 new epic waiting on you", brief_review: "1 brief waiting on you",
                  article_review: "1 article waiting on you" };
// Whose box it is: the Research Assistant searches and rates, code publishes, the Principal Investigator does the rest.
const WHO = { sources: "assistant", article_rating: "assistant", publisher: "desk" };
const CODE = new Set(["theorist_check", "finder_check", "source_check", "article_check", "rating_check"]);

function frame(d) {
  const step = d && d.step, working = [], waiting = {}, lines = [];
  if (step in REVIEWS) {
    waiting[step] = d.waiting ? 1 : 0;
    lines.push(`<span class="who">You</span> · ${d.waiting ? REVIEWS[step] : "approved"}`);
  } else if (step) {
    const worker = CODE.has(step) ? "desk" : WHO[step] || "pi";    // whose step it is, whoever carried the work there
    working.push({ worker, step, slug: "m", name: AGENTS[step] || step });
    lines.push(`<span class="who">${WORKERS[worker]}</span> · <strong>${AGENTS[step] || step}</strong> ` +
               `${DOING[step] || ""}${DOING[step] && / for$/.test(DOING[step]) ? " the mission" : ""}`);
  }
  return { running: true, working, waiting, parked: {}, states: {}, now: lines.join("<br>") };
}

function show(d) { if (window.Flow && document.getElementById("flow")) window.Flow.apply(frame(d)); }

// No scene: light each box in turn, and tell researchers.js which so a still figure stands on it.
let timer = null;
function steps() { return [...document.querySelectorAll("#flow .flow-track [data-step]")].map(e => e.dataset.step); }
function play() {
  const keys = steps();
  let i = 0;
  const next = () => {
    if (document.hidden) return;
    const step = keys[i], d = { step, worker: WHO[step] || "pi", waiting: 1 };
    show(d);
    document.dispatchEvent(new CustomEvent("tourframe", { detail: d }));
    i = (i + 1) % keys.length;
  };
  next();
  timer = setInterval(next, EVERY);
}

let driven = false;
document.addEventListener("tourstep", e => {
  driven = true;
  if (timer) { clearInterval(timer); timer = null; }
  show(e.detail);
});
function boot() {
  if (window.Flow) window.Flow.attach();
  show(null);
  setTimeout(() => { if (!driven && !timer) play(); }, NO_SCENE);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
