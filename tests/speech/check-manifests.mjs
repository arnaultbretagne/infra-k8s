// The static half of the acceptance criteria, on what kustomize renders for apps/speech (as a JSON List:
// `kubectl kustomize apps/speech | kubectl create --dry-run=client -o json -f -`, concatenated objects). Every failure is printed;
// the exit code is the number of failures.
import fs from 'node:fs';

// kubectl prints one JSON object per resource, back to back: split them at depth 0.
function parseConcatenated(text) {
  const out = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out.flatMap((o) => (o.kind === 'List' ? o.items : [o]));
}
const items = parseConcatenated(fs.readFileSync(process.argv[2], 'utf8'));
const failures = [];
const ok = [];
const check = (cond, msg) => (cond ? ok : failures).push(msg);
const of = (kind) => items.filter((i) => i.kind === kind);
const byName = (kind, name) => of(kind).find((i) => i.metadata.name === name);

// 2. Two Deployments and their Services, port 80, nothing that leaves the cluster.
for (const name of ['stt', 'tts']) {
  const d = byName('Deployment', name);
  const s = byName('Service', name);
  check(d, `Deployment ${name} exists`);
  check(s && s.spec.ports.some((p) => p.port === 80), `Service ${name} listens on port 80`);
  check(s && (s.spec.type ?? 'ClusterIP') === 'ClusterIP', `Service ${name} is ClusterIP`);
}
check(of('HTTPRoute').length === 0 && of('Ingress').length === 0, 'no HTTPRoute nor Ingress');

// 6. Namespace and pod security.
const ns = byName('Namespace', 'speech');
check(ns?.metadata.labels?.['pod-security.kubernetes.io/enforce'] === 'restricted', 'namespace speech enforces restricted');
for (const d of of('Deployment')) {
  const pod = d.spec.template.spec;
  const n = d.metadata.name;
  check(pod.priorityClassName === 'bretagne-low', `${n}: priorityClassName bretagne-low`);
  for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
    const id = `${n}/${c.name}`;
    const sc = c.securityContext ?? {};
    check((sc.runAsNonRoot ?? pod.securityContext?.runAsNonRoot) === true, `${id}: runAsNonRoot`);
    check(sc.readOnlyRootFilesystem === true, `${id}: readOnlyRootFilesystem`);
    check(sc.allowPrivilegeEscalation === false, `${id}: allowPrivilegeEscalation false`);
    check(sc.capabilities?.drop?.includes('ALL'), `${id}: drop ALL`);
    check((sc.seccompProfile?.type ?? pod.securityContext?.seccompProfile?.type) === 'RuntimeDefault', `${id}: seccomp RuntimeDefault`);
    const r = c.resources ?? {};
    check(r.requests?.cpu && r.requests?.memory, `${id}: cpu and memory requests`);
    check(r.limits?.memory, `${id}: memory limit`);
    check(!r.limits?.cpu, `${id}: no cpu limit`);
    // 8. Pinned by tag and digest.
    check(/^[^@\s]+:[^@:\s]+@sha256:[0-9a-f]{64}$/.test(c.image), `${id}: image pinned by tag and digest (${c.image})`);
  }
}

// 7. The network policy: in, the playground and the kubelet; out, DNS and named hosts on 443.
const cnps = of('CiliumNetworkPolicy');
const deny = cnps.find((p) => JSON.stringify(p.spec.endpointSelector) === '{}');
check(deny && JSON.stringify(deny.spec.ingress) === '[{}]' && JSON.stringify(deny.spec.egress) === '[{}]', 'default-deny for the namespace');
const text = JSON.stringify(cnps);
check(!/flux-system|kube-apiserver|"world"|"all"|"cluster"|toCIDR|toServices/.test(text), 'no flux-system, apiserver, world, cluster or CIDR anywhere');
for (const p of cnps.filter((p) => p !== deny)) {
  const n = p.metadata.name;
  for (const rule of p.spec.ingress ?? []) {
    const fromPlayground =
      rule.fromEndpoints?.length === 1 &&
      JSON.stringify(rule.fromEndpoints[0]) === JSON.stringify({ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'speech-playground' } });
    const fromKubelet = JSON.stringify(rule.fromEntities) === '["host"]' && !rule.fromEndpoints;
    check(fromPlayground || fromKubelet, `${n}: ingress rule from speech-playground or the kubelet only: ${JSON.stringify(rule)}`);
  }
  for (const rule of p.spec.egress ?? []) {
    const ports = (rule.toPorts ?? []).flatMap((t) => t.ports);
    const dns =
      JSON.stringify(rule.toEndpoints) ===
        JSON.stringify([{ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'kube-system', 'k8s:k8s-app': 'kube-dns' } }]) &&
      ports.length > 0 && ports.every((x) => x.port === '53');
    const named =
      rule.toFQDNs?.length > 0 && Object.keys(rule).sort().join() === 'toFQDNs,toPorts' &&
      ports.length > 0 && ports.every((x) => x.port === '443' && x.protocol === 'TCP');
    check(dns || named, `${n}: egress rule is DNS or named hosts on 443: ${JSON.stringify(rule)}`);
  }
}
const selected = cnps.filter((p) => p !== deny).map((p) => JSON.stringify(p.spec.endpointSelector)).join();
check(['stt', 'tts'].every((a) => selected.includes(`"${a}"`)), 'both Deployments are selected by an allow-list policy');

for (const m of ok) console.log(`ok   ${m}`);
for (const m of failures) console.log(`FAIL ${m}`);
process.exit(failures.length);
