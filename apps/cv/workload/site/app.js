// Two touches the PDF cannot have: a print button, and each repository's last activity, asked of
// GitHub's public API. The page is whole without this script; a failure leaves the chip as it is.

const print = document.querySelector(".print");
print.hidden = false;
print.addEventListener("click", () => window.print());

const lang = document.documentElement.lang;
const ago = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" });
const active = lang === "fr" ? "actif" : "active";

function since(date) {
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 60) return ago.format(-Math.max(minutes, 1), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ago.format(-hours, "hour");
  return ago.format(-Math.round(hours / 24), "day");
}

// One request per repository, however many chips show it.
const asked = new Map();
function repo(name) {
  if (!asked.has(name)) asked.set(name, fetchRepo(name));
  return asked.get(name);
}

async function fetchRepo(name) {
  const key = `gh:${name}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key));
    if (cached && Date.now() - cached.at < 10 * 60000) return cached.body;
  } catch {}
  const response = await fetch(`https://api.github.com/repos/${name}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`${response.status} ${name}`);
  const body = await response.json();
  try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), body })); } catch {}
  return body;
}

for (const el of document.querySelectorAll("[data-pushed]")) {
  repo(el.dataset.pushed)
    .then((r) => { el.textContent = ` · ${active} ${since(new Date(r.pushed_at))}`; })
    .catch(() => {});
}

// Each job's and project's length, counted in months with both ends included, as LinkedIn does.
const now = new Date();
for (const el of document.querySelectorAll(".dur[data-from]")) {
  const [y1, m1] = el.dataset.from.split("-").map(Number);
  const [y2, m2] = el.dataset.to ? el.dataset.to.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
  const months = y2 * 12 + m2 - (y1 * 12 + m1) + 1;
  const y = Math.floor(months / 12), m = months % 12;
  const parts = lang === "fr"
    ? [y && `${y} an${y > 1 ? "s" : ""}`, m && `${m} mois`]
    : [y && `${y} yr${y > 1 ? "s" : ""}`, m && `${m} mo${m > 1 ? "s" : ""}`];
  el.textContent = ` · ${parts.filter(Boolean).join(" ")}`;
}

// The review bar (temporary): switches the entries' layout and remembers it across both pages.
const review = document.querySelector(".review");
if (review) {
  review.hidden = false;
  const current = () => document.documentElement.dataset.layout || "a";
  const mark = () => review.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layout === current())));
  review.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-layout]");
    if (!button) return;
    document.documentElement.dataset.layout = button.dataset.layout;
    try { localStorage.setItem("cv-layout", button.dataset.layout); } catch {}
    mark();
  });
  mark();
}
