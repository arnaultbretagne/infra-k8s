// Two touches the PDF cannot have: a print button, and the repositories' numbers refreshed from
// GitHub's public API. The page is whole without this script; each failure leaves the numbers
// written in the HTML.

const print = document.querySelector(".print");
print.hidden = false;
print.addEventListener("click", () => window.print());

const ago = new Intl.RelativeTimeFormat("fr", { numeric: "auto", style: "short" });

function since(date) {
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 60) return ago.format(-Math.max(minutes, 1), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ago.format(-hours, "hour");
  return ago.format(-Math.round(hours / 24), "day");
}

async function github(path) {
  const key = `gh:${path}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key));
    if (cached && Date.now() - cached.at < 10 * 60000) return cached.body;
  } catch {}
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  const body = await response.json();
  try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), body })); } catch {}
  return body;
}

for (const el of document.querySelectorAll("[data-pushed]")) {
  github(`repos/${el.dataset.pushed}`)
    .then((repo) => { el.textContent = ` · actif ${since(new Date(repo.pushed_at))}`; })
    .catch(() => {});
}

for (const el of document.querySelectorAll("[data-prs]")) {
  github(`search/issues?q=${encodeURIComponent(`repo:${el.dataset.prs} is:pr is:merged`)}&per_page=1`)
    .then((result) => {
      if (Number.isInteger(result.total_count) && result.total_count > 0) {
        el.textContent = result.total_count.toLocaleString("fr-CH");
      }
    })
    .catch(() => {});
}
