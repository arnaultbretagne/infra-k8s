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

async function repo(name) {
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
