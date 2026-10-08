#!/usr/bin/env node
// Replays the generated template against a running AIOStreams and checks the selection.
// For each title it searches twice through /api/v1/search: once without our two selection
// expressions (the list they act on) and once with the full template. From the first list
// it computes what "3 VF + 2 VO-STFR" must return, and compares with the second.
//
//   TORBOX_API_KEY=... node check-live.mjs http://<aiostreams>:3000
//
// Call the AIOStreams container directly (port 3000): the template is sent in a request
// header larger than the HEAD shim's nginx accepts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const overlay = JSON.parse(readFileSync(join(here, 'overlay.json'), 'utf8'));
const template = JSON.parse(readFileSync(join(here, '..', overlay.output), 'utf8'));
const base = process.argv[2];
const key = process.env.TORBOX_API_KEY;
if (!base || !key) throw new Error('usage: TORBOX_API_KEY=... node check-live.mjs <aiostreams base url>');

const titles = [
  ['movie', 'tt26657236', 'Backrooms (2026)'], ['movie', 'tt0317219', 'Cars (2006)'],
  ['movie', 'tt0092890', 'Dirty Dancing (1987)'], ['movie', 'tt2820852', 'Furious 7 (2015)'],
  ['movie', 'tt15239678', 'Dune: Part Two (2024)'], ['movie', 'tt0816692', 'Interstellar (2014)'],
  ['movie', 'tt15398776', 'Oppenheimer (2023)'], ['series', 'tt2788316:1:1', 'Shōgun S01E01'],
];
const vfNames = /\b(VFF|VFQ|VFI|VF[2-9]|VOF|VOQ|VQ|VFB|TRUEFRENCH)\b/i;

function config(withSelection) {
  const cfg = structuredClone(template.config);
  cfg.services = [{ id: 'torbox', enabled: true, credentials: { apiKey: key } }];
  if (!withSelection) cfg.excludedStreamExpressions = cfg.excludedStreamExpressions.slice(0, -2);
  return Buffer.from(JSON.stringify(cfg)).toString('base64');
}

async function search(type, id, withSelection) {
  const url = `${base}/api/v1/search?${new URLSearchParams({ type, id })}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'x-aiostreams-user-data': config(withSelection) } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 10000)); continue; }
    const body = await res.json();
    if (!body.success) throw new Error(`${id}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
    return body.data.results;
  }
  throw new Error(`${id}: rate limited`);
}

const isFrench = (r) => (r.parsedFile?.languages ?? []).includes('French') || vfNames.test(`${r.folderName ?? ''} ${r.filename ?? ''}`);
// Torz reports subtitle languages without per-track detail, so forced tracks cannot be told apart.
const hasFrenchSubs = (r) => (r.parsedFile?.subtitles ?? []).includes('French');
const best = (list) => {
  for (const res of ['2160p', '1080p']) {
    const at = list.filter((r) => r.parsedFile?.resolution === res);
    if (at.length) return at;
  }
  return list;
};
const idOf = (r) => `${r.infoHash}:${r.fileIdx}:${r.filename}`;

let failures = 0;
for (const [type, id, title] of titles) {
  const pool = await search(type, id, false);
  await new Promise((r) => setTimeout(r, 2500));
  const got = await search(type, id, true);
  await new Promise((r) => setTimeout(r, 2500));

  const vf = best(pool.filter(isFrench)).slice(0, overlay.selection.frenchCount);
  const vo = best(pool.filter((r) => !isFrench(r) && hasFrenchSubs(r))).slice(0, overlay.selection.originalCount);
  const expected = [...vf, ...vo].map(idOf);
  const actual = got.map(idOf);
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${title.padEnd(22)} ${vf.length} VF + ${vo.length} VO-STFR` +
    ` (sur ${pool.length} candidats) | ${got.map((r) => `${isFrench(r) ? 'VF' : 'VO'} ${r.parsedFile?.resolution}`).join(', ')}`);
  if (!ok) {
    console.log('     attendu:', expected.map((x) => x.split(':').slice(2).join(':').slice(0, 50)));
    console.log('     obtenu :', actual.map((x) => x.split(':').slice(2).join(':').slice(0, 50)));
  }
}
process.exit(failures ? 1 : 0);
