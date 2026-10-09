#!/usr/bin/env node
// Builds the instance template described in overlay.json from Tam-Taro's latest
// "Complete SEL Setup". His template is resolved with our answers by AIOStreams' own
// template resolver (the module its web UI runs at import time, fetched at the tag of
// the image in ../../deployment.yaml), then our overlay is applied: sources, the strict
// French / original-with-French-subtitles selection, and metadata.
//
//   node apps/stremio/templates/tamtaro-fr/generate.mjs           write the template
//   node apps/stremio/templates/tamtaro-fr/generate.mjs --check   exit 1 if it is stale
//
// Needs Node 22.18+ (TypeScript type stripping) and network access to raw.githubusercontent.com.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const overlay = JSON.parse(readFileSync(join(here, 'overlay.json'), 'utf8'));
const outFile = join(here, '..', overlay.output);

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// One value per input, subsections nested: the state the import wizard starts from.
function defaults(inputs) {
  const values = {};
  for (const input of inputs) {
    if (!input.id || input.type === 'alert' || input.type === 'socials') continue;
    values[input.id] = input.type === 'subsection'
      ? defaults(input.subOptions ?? [])
      : input.default ?? null;
  }
  return values;
}

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const isObject = value && typeof value === 'object' && !Array.isArray(value);
    if (isObject && !(key in target)) throw new Error(`overlay answer for unknown input: ${key}`);
    target[key] = isObject ? merge(target[key] ?? {}, value) : value;
  }
  return target;
}

// The best resolution present in a set: 4K, else 1080p, else whatever is left.
const bestResolution = (set) =>
  `(count(resolution(${set}, '2160p')) > 0 ? resolution(${set}, '2160p') : ` +
  `(count(resolution(${set}, '1080p')) > 0 ? resolution(${set}, '1080p') : ${set}))`;

function selectionExpressions({ french, frenchSubtitles, frenchCount, originalCount }) {
  const fr = bestResolution(french);
  const vo = bestResolution(`negate(${french}, ${frenchSubtitles})`);
  return [
    {
      expression: `/*${frenchCount} VF en tête*/ pin(passthrough(slice(${fr}, 0, ${frenchCount}), 'excluded'), 'top')`,
      enabled: true,
    },
    {
      expression: `/*${frenchCount} VF + ${originalCount} VO-STFR, rien d'autre*/ ` +
        `negate(merge(slice(${fr}, 0, ${frenchCount}), slice(${vo}, 0, ${originalCount})), streams)`,
      enabled: true,
    },
  ];
}

async function build() {
  const deployment = readFileSync(join(here, '..', '..', 'deployment.yaml'), 'utf8');
  const aioTag = deployment.match(/viren070\/aiostreams:(v\d+\.\d+\.\d+)/)?.[1];
  if (!aioTag) throw new Error('AIOStreams image tag not found in deployment.yaml');

  const dir = mkdtempSync(join(tmpdir(), 'aio-resolver-'));
  try {
    const resolver = join(dir, 'conditionals.ts');
    writeFileSync(resolver, await get(
      `https://raw.githubusercontent.com/Viren070/AIOStreams/${aioTag}/packages/frontend/src/lib/templates/processors/conditionals.ts`));
    const { applyTemplateConditionals } = await import(pathToFileURL(resolver).href);

    const upstream = JSON.parse(await get(overlay.upstream));
    const answers = merge(defaults(upstream.metadata.inputs), overlay.answers);
    const config = applyTemplateConditionals(upstream.config, answers, overlay.services);

    config.presets = overlay.presets.map((type) => {
      const preset = (config.presets ?? []).find((p) => p.type === type);
      if (!preset) throw new Error(`preset ${type} not in the resolved template`);
      return { ...preset, enabled: true, options: { ...preset.options, services: overlay.services } };
    });
    // Tam-Taro asks each user for a TMDB key. "instance": the instance provides one
    // (TMDB_ACCESS_TOKEN or TMDB_API_KEY), so no question. "none": also turn off what
    // needs TMDB (title, year and digital-release checks, bitrate from runtime), so the
    // profile saves with the debrid key alone.
    for (const field of ['tmdbApiKey', 'tmdbAccessToken', 'tvdbApiKey']) delete config[field];
    if (overlay.tmdb === 'none') {
      for (const field of ['titleMatching', 'yearMatching', 'digitalReleaseFilter']) {
        if (config[field]) config[field].enabled = false;
      }
      if (config.bitrate) config.bitrate.useMetadataRuntime = false;
    } else if (overlay.tmdb !== 'instance') {
      throw new Error('overlay.tmdb must be "none" or "instance"');
    }

    config.excludedStreamExpressions = [
      ...(config.excludedStreamExpressions ?? []),
      ...selectionExpressions(overlay.selection),
    ];

    const leftover = JSON.stringify(config).match(/\{\{inputs\.[^}]*\}\}|"__(if|switch|value|remove)"|template_placeholder/);
    if (leftover) throw new Error(`unresolved template directive: ${leftover[0]}`);

    const [major, minor, patch] = upstream.metadata.version.split('.').map(Number);
    if (overlay.revision >= 100) throw new Error('overlay revision must stay below 100');
    const meta = overlay.metadata;
    return {
      metadata: {
        id: meta.id,
        name: meta.name,
        author: meta.author,
        source: 'external',
        version: `${major}.${minor}.${patch * 100 + overlay.revision}`,
        category: meta.category,
        description: meta.description.replace('{upstreamVersion}', upstream.metadata.version),
        services: overlay.services,
        serviceRequired: true,
        setToSaveInstallMenu: true,
        inputs: [{ id: 'notice', type: 'alert', intent: 'info', name: meta.name, description: meta.notice }],
      },
      config,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const text = `${JSON.stringify(await build(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(outFile, 'utf8'); } catch {}
  if (current !== text) {
    console.error(`${overlay.output} is stale: run generate.mjs`);
    process.exit(1);
  }
  console.log(`${overlay.output} is up to date`);
} else {
  writeFileSync(outFile, text);
  console.log(`wrote ${overlay.output}`);
}
