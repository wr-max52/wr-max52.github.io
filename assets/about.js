/* The published site's About page: the pipeline strip plays a made-up run, a few seconds per stage, with both
 * workers busy at once, through the same relighting the UI uses (assets/flow.js, Flow.apply). Nothing here
 * talks to a server; the loop and its missions never leave the machine that runs them.
 */
(() => {
"use strict";
const EVERY = 3500;                                      // ms per frame
const WORKERS = { assistant: "Research Assistant", pi: "Principal Investigator", desk: "Code" };
const AGENTS = { theorist: "Theorist", finder: "Mission finder", sources: "Source finder", outreach: "Outreach agent",
                 brief: "Brief writer", source_check: "Source checker", writer: "Article writer",
                 article_check: "Article checker", article_rating: "Article rater", publisher: "Publisher" };
const DOING = { theorist: "is looking across every mission for patterns", finder: "is searching for new missions",
                sources: "is searching and reading sources for", outreach: "is asking people about",
                brief: "is writing the brief for", source_check: "is checking every quote in the brief for",
                writer: "is writing the article for", article_check: "is checking the article's citations for",
                article_rating: "is rating the article for", publisher: "is publishing" };
const NAMES = { a: "mission A", b: "mission B", c: "mission C" };

// One frame per step of the made-up run: who works on what, each mission's state, and who waits on you.
// [step, mission] per worker; a human approving or publishing happens between frames.
const F = (pi, assistant, desk, states, brief = 0, article = 0) => ({ pi, assistant, desk, states, brief, article });
const FRAMES = [
  F(["theorist", ""], ["sources", "a"], null, { a: "RESEARCHING" }),
  F(["finder", ""], ["sources", "a"], null, { a: "RESEARCHING", b: "QUEUED" }),
  F(["brief", "a"], ["sources", "b"], null, { a: "RESEARCHING", b: "RESEARCHING" }),
  F(["source_check", "a"], ["sources", "b"], null, { a: "RESEARCHING", b: "RESEARCHING", c: "QUEUED" }),
  F(["brief", "b"], ["sources", "c"], null, { a: "BRIEF_READY", b: "RESEARCHING", c: "RESEARCHING" }, 1),
  F(["source_check", "b"], ["sources", "c"], null, { a: "BRIEF_READY", b: "RESEARCHING", c: "RESEARCHING" }, 1),
  F(["writer", "a"], ["sources", "c"], null, { a: "WRITING", b: "BRIEF_READY", c: "RESEARCHING" }, 1),
  F(["article_check", "a"], ["sources", "c"], null, { a: "WRITING", b: "BRIEF_READY", c: "RESEARCHING" }, 1),
  F(["brief", "c"], ["article_rating", "a"], null, { a: "WRITING", b: "BRIEF_READY", c: "RESEARCHING" }, 1),
  F(["source_check", "c"], null, null, { a: "ARTICLE_READY", b: "BRIEF_READY", c: "RESEARCHING" }, 1, 1),
  F(["writer", "b"], null, ["publisher", "a"], { a: "DONE", b: "WRITING", c: "RESEARCHING" }),
  F(["article_check", "b"], null, null, { a: "DONE", b: "WRITING", c: "BRIEF_READY" }, 1),
  F(["writer", "c"], ["article_rating", "b"], null, { a: "DONE", b: "WRITING", c: "WRITING" }),
  F(["article_check", "c"], null, null, { a: "DONE", b: "ARTICLE_READY", c: "WRITING" }, 0, 1),
  F(null, ["article_rating", "c"], ["publisher", "b"], { a: "DONE", b: "DONE", c: "WRITING" }),
  F(null, null, ["publisher", "c"], { a: "DONE", b: "DONE", c: "DONE" }),
];

function frame(f) {
  const working = [];
  for (const w of ["pi", "assistant", "desk"]) {
    if (!f[w]) continue;
    const [step, slug] = f[w];
    working.push({ worker: w, step, slug, name: AGENTS[step] });
  }
  const lines = working.map(e => `<span class="who">${WORKERS[e.worker]}</span> · <strong>${AGENTS[e.step]}</strong> ` +
                                 `${DOING[e.step]}${e.slug ? " " + NAMES[e.slug] : ""}`);
  const waits = [];
  if (f.brief) waits.push(`${f.brief} brief waiting on you`);
  if (f.article) waits.push(`${f.article} article waiting on you`);
  if (waits.length) lines.push(`<span class="who">You</span> · ${waits.join(", ")}`);
  return { running: true, working, waiting: { brief_review: f.brief, article_review: f.article },
           parked: {}, states: f.states, now: lines.join("<br>") };
}

let i = 0;
function next() {
  if (!window.Flow || !document.getElementById("flow")) return;
  window.Flow.apply(frame(FRAMES[i]));
  i = (i + 1) % FRAMES.length;
}
function boot() {
  if (window.Flow) window.Flow.attach();
  next();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setInterval(() => { if (!document.hidden) next(); }, EVERY);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
