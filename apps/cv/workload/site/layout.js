// Applies the entry layout chosen in the review bar before the page paints, so it never flickers;
// ?layout=b in the address picks one too. Temporary, while a layout is chosen.
try {
  const chosen = new URLSearchParams(location.search).get("layout") || localStorage.getItem("cv-layout");
  if (/^[abcd]$/.test(chosen ?? "")) document.documentElement.dataset.layout = chosen;
} catch {}
