/* The published site's About page: the pipeline strip plays made-up missions running the line (#139, #155),
 * through the same relighting the UI uses (assets/flow.js, Flow.apply). Each agent's box has a researcher, and each
 * mission is a sheet of paper they pass along (assets/researchers.js, Tour); every time a paper reaches a box or
 * leaves it, a "tourstep" event says so (who: that paper) and the box lights or goes dark here, so the lights
 * follow the paper. Several papers are on the line at once and the strip shows them all. With no scene (reduced
 * motion), the boxes light in turn on a timer instead, and a "tourframe" event tells researchers.js which box's
 * researcher to stand there, still.
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
                 finder_check: "Finder check", rating_check: "Rating check", outreach: "Outreach",
                 outreach_check: "Outreach check", replies: "Reply check" };
const DOING = { theorist: "is looking across every mission for patterns", finder: "is searching for new missions",
                sources: "is searching and reading sources for", brief: "is writing the brief for",
                source_check: "is checking every quote in the brief for", writer: "is writing the article for",
                article_check: "is checking the article's citations for", article_rating: "is rating the article for",
                publisher: "is publishing", theorist_check: "is holding the Theorist to its rules",
                finder_check: "is checking each new lead rests on a real page",
                rating_check: "is adding up the rating for", outreach: "is asking people about",
                outreach_check: "is checking each question for", replies: "is reading the replies for" };
const REVIEWS = { epic_review: ["new epic", "new epics"], brief_review: ["brief", "briefs"],
                  article_review: ["article", "articles"] };
// Whose box it is: the Research Assistant searches and rates, code publishes, the Principal Investigator does the rest.
const WHO = { sources: "assistant", article_rating: "assistant", publisher: "desk" };
const CODE = new Set(["theorist_check", "finder_check", "source_check", "article_check", "rating_check",
                      "outreach_check", "replies"]);

// Every lit box, in strip order: the boxes at work, each once, and each review with how many wait on it.
function frame(list) {
  const order = steps(), at = k => order.indexOf(k), working = [], waiting = {}, lines = [];
  const lit = list.filter(d => d && d.step).sort((a, b) => at(a.step) - at(b.step));
  for (const d of lit) {
    const step = d.step;
    if (step in REVIEWS) {
      const first = !(step in waiting);
      waiting[step] = (waiting[step] || 0) + (d.waiting ? 1 : 0);
      if (first) lines.push(step);
    } else if (!working.some(e => e.step === step)) {
      const worker = CODE.has(step) ? "desk" : WHO[step] || "pi";    // whose step it is, whoever carried the work there
      working.push({ worker, step, slug: "m", name: AGENTS[step] || step });
      lines.push(step);
    }
  }
  const line = step => {
    if (step in REVIEWS) {
      const n = waiting[step], [one, many] = REVIEWS[step];
      return `<span class="who">You</span> · ${n ? `${n} ${n > 1 ? many : one} waiting on you` : "approved"}`;
    }
    const worker = working.find(e => e.step === step).worker;
    return `<span class="who">${WORKERS[worker]}</span> · <strong>${AGENTS[step] || step}</strong> ` +
           `${DOING[step] || ""}${DOING[step] && / (for|about)$/.test(DOING[step]) ? " a mission" : ""}`;
  };
  return { running: true, working, waiting, parked: {}, states: {}, now: lines.map(line).join("<br>") };
}

function show(list) { if (window.Flow && document.getElementById("flow")) window.Flow.apply(frame(list)); }

// No scene: light each box in turn, and tell researchers.js which so a still figure stands on it.
let timer = null;
function steps() { return [...document.querySelectorAll("#flow .flow-track [data-step]")].map(e => e.dataset.step); }
function play() {
  const keys = steps();
  let i = 0;
  const next = () => {
    if (document.hidden) return;
    const step = keys[i], d = { step, worker: WHO[step] || "pi", waiting: 1 };
    show([d]);
    document.dispatchEvent(new CustomEvent("tourframe", { detail: d }));
    i = (i + 1) % keys.length;
  };
  next();
  timer = setInterval(next, EVERY);
}

// Each paper's box (who -> its latest tourstep); one with no paper darkens the whole strip.
let driven = false;
const lit = new Map();
document.addEventListener("tourstep", e => {
  driven = true;
  if (timer) { clearInterval(timer); timer = null; }
  const d = e.detail || {};
  if (!d.who) lit.clear();
  else if (d.step) lit.set(d.who, d);
  else lit.delete(d.who);
  show([...lit.values()]);
});
function boot() {
  if (window.Flow) window.Flow.attach();
  show([]);
  setTimeout(() => { if (!driven && !timer) play(); }, NO_SCENE);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
