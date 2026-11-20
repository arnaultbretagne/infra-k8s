// Unit tests of the bretagne-flux PrometheusRule (observability/rules.yaml).
//
// promtool reads plain rule files, not PrometheusRule objects: this renders the observability
// kustomization as Flux does (`kubectl kustomize`), takes the bretagne-flux object's `spec` out
// of it, then runs `promtool check rules` and `promtool test rules` on it. What is tested is
// what Flux applies. No dependency: the rendered YAML is cut by lines, which kustomize's stable
// output (top-level keys at column 0, `spec` indented by two spaces) allows.
//
//   node tests/flux-alerts/run.mjs
//
// KUBECTL and PROMTOOL override the binaries found on PATH.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const kubectl = process.env.KUBECTL ?? 'kubectl';
const promtool = process.env.PROMTOOL ?? 'promtool';
const ruleName = 'bretagne-flux';

const rendered = execFileSync(kubectl, ['kustomize', join(repo, 'observability')], { encoding: 'utf8' });
const docs = rendered.split(/^---$/m).filter(
  (doc) => /^kind: PrometheusRule$/m.test(doc) && new RegExp(`^  name: ${ruleName}$`, 'm').test(doc),
);
if (docs.length !== 1) throw new Error(`expected one PrometheusRule ${ruleName} in the render, found ${docs.length}`);

const lines = docs[0].split('\n');
const start = lines.indexOf('spec:');
if (start < 0) throw new Error(`${ruleName} has no spec`);
const spec = [];
for (const line of lines.slice(start + 1)) {
  if (/^\S/.test(line)) break;
  if (line !== '' && !line.startsWith('  ')) throw new Error(`unexpected indentation: ${line}`);
  spec.push(line.slice(2));
}

const dir = mkdtempSync(join(tmpdir(), 'flux-alerts-'));
writeFileSync(join(dir, 'rules.yaml'), `${spec.join('\n')}\n`);
copyFileSync(join(here, 'flux-alerts.test.yaml'), join(dir, 'flux-alerts.test.yaml'));

for (const args of [['check', 'rules', 'rules.yaml'], ['test', 'rules', 'flux-alerts.test.yaml']]) {
  console.log(`$ promtool ${args.join(' ')}`);
  execFileSync(promtool, args, { cwd: dir, stdio: 'inherit' });
}
