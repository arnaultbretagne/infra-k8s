// The sandbox admission policies (infrastructure/configs/policies) on a real API server: kind, the
// policies and RuntimeClasses applied as Flux applies them (`kubectl apply -k`), the namespaces from this
// repository's own manifests. Every Pod is a real CREATE, made by kubectl as a given principal
// (`--as`, impersonation by kind's admin): what the API server answers is what the cluster would.
//
// What it proves (README.md): a Pod in an untrusted-compute namespace runs sandboxed whoever creates it and
// whatever its labels — a `cnpg.io/cluster` label no longer exempts it — while Pods CNPG creates where its
// databases live (a trusted namespace, as preview-system) are admitted, its Jobs' Pods included.
//
// POLICIES: the kustomization to apply, this repository's by default. The workflow runs the test a second
// time with the policies as they were before the fix, which must fail.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICIES = process.env.POLICIES ?? path.join(repo, 'infrastructure/configs/policies');

// Who creates Pods in the cases below. None is CNPG's, except CNPG_OPERATOR.
const INTRUDER = 'system:serviceaccount:agora-runs:intruder'; // a principal granted Pod create, nothing else
const ADMIN = null; // kind's own admin, as kubectl is configured
const JOB_CONTROLLER = 'system:serviceaccount:kube-system:job-controller'; // who creates a Job's Pods
// The operator's ServiceAccount: the chart's fullname for the release `cloudnative-pg` in `cnpg-system`
// (infrastructure/controllers/cloudnativepg/release.yaml).
const CNPG_OPERATOR = 'system:serviceaccount:cnpg-system:cloudnative-pg';

const UNTRUSTED = ['agora-runs', 'agora-sandboxes']; // apps/*/namespace.yaml
const PREVIEW = 'pv-demo-pr1'; // as infrastructure/configs/previews/resourceset.yaml renders one
const TRUSTED = 'preview-system'; // infrastructure/configs/previews/namespace.yaml: where preview databases live

function kubectl(args, input) {
  const r = spawnSync('kubectl', args, { input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function must(args, input) {
  const r = kubectl(args, input);
  assert.equal(r.code, 0, `kubectl ${args.join(' ')}: ${r.err}`);
  return r.out;
}

// Names unique to the run: a second run's Pods do not meet the first's, still terminating.
const run = Date.now().toString(36);
let serial = 0;

// A Pod as CNPG writes an instance (labels cnpg.io/cluster, cnpg.io/instanceName, cnpg.io/podRole), compliant
// with PSA restricted so that only the sandbox policies can refuse it.
function pod(namespace, { cnpg = true, runtimeClassName, extraLabels = {} } = {}) {
  const name = `case-${run}-${++serial}`;
  const labels = cnpg
    ? { 'cnpg.io/cluster': 'pg', 'cnpg.io/instanceName': 'pg-1', 'cnpg.io/podRole': 'instance', role: 'primary' }
    : {};
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels: { ...labels, ...extraLabels } },
    spec: { ...(runtimeClassName ? { runtimeClassName } : {}), ...podSpec() },
  };
}

function podSpec() {
  return {
    automountServiceAccountToken: false,
    securityContext: { runAsNonRoot: true, runAsUser: 65535, seccompProfile: { type: 'RuntimeDefault' } },
    containers: [
      {
        name: 'pause',
        image: 'registry.k8s.io/pause:3.10',
        resources: { requests: { cpu: '1m', memory: '64Mi' }, limits: { memory: '64Mi' } },
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
      },
    ],
  };
}

function create(t, object, as) {
  const args = ['create', '-o', 'name', '-f', '-', ...(as ? [`--as=${as}`] : [])];
  const r = kubectl(args, JSON.stringify(object));
  const { namespace, name } = object.metadata;
  t.diagnostic(
    `${namespace}/${name} as ${as ?? 'kind admin'}, runtimeClassName ${object.spec.runtimeClassName ?? '(none)'}, ` +
      `labels ${JSON.stringify(object.metadata.labels)} -> exit ${r.code}: ${r.code === 0 ? r.out : r.err}`,
  );
  return r;
}

function denied(t, object, as, policy) {
  const r = create(t, object, as);
  assert.notEqual(r.code, 0, `${object.metadata.namespace}/${object.metadata.name} was admitted`);
  assert.match(r.err, new RegExp(`ValidatingAdmissionPolicy '${policy}' with binding '${policy}' denied request`));
}

function admitted(t, object, as) {
  const r = create(t, object, as);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `pod/${object.metadata.name}`);
}

const SANDBOX = 'untrusted-compute-requires-sandbox';
const KATA = 'preview-requires-kata';

const fixtures = [
  // A runtime that exists but is no sandbox: kind's own runc. A RuntimeClass that does not exist would be refused
  // before the policies run.
  { apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', metadata: { name: 'runc' }, handler: 'runc' },
  {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: PREVIEW,
      labels: {
        'platform.bretagne.dev/profile': 'untrusted-compute',
        'pod-security.kubernetes.io/enforce': 'restricted',
        'preview.bretagne.dev/preview': 'true',
        'preview.bretagne.dev/name': 'demo-pr1',
      },
    },
  },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'intruder', namespace: 'agora-runs' } },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: 'sandbox-policies-test-pod-creator' },
    rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['create', 'get', 'list', 'delete'] }],
  },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: 'sandbox-policies-test-pod-creator' },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'sandbox-policies-test-pod-creator' },
    subjects: [
      { kind: 'ServiceAccount', name: 'intruder', namespace: 'agora-runs' },
      { kind: 'ServiceAccount', name: 'cloudnative-pg', namespace: 'cnpg-system' },
    ],
  },
];

// The policies as the API server enforces them, not merely stored: first none (so that an earlier run's
// policy, still cached by the admission plugin, cannot answer for this one), then POLICIES.
async function until(what, probe) {
  for (let i = 0; i < 90; i++) {
    if (probe()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A dry-run CREATE (admission runs, nothing is stored) of a Pod with no label.
const probe = (namespace, runtimeClassName) =>
  kubectl(['create', '--dry-run=server', '-o', 'name', '-f', '-'], JSON.stringify(pod(namespace, { cnpg: false, runtimeClassName })));

before(async () => {
  for (const kind of ['validatingadmissionpolicybinding', 'validatingadmissionpolicy']) {
    must(['delete', kind, SANDBOX, KATA, '--ignore-not-found']);
  }
  must(['apply', '-k', path.join(repo, 'infrastructure/configs/sandboxed-runtime')]);
  must(['apply', '-f', path.join(repo, 'apps/agora-runs/namespace.yaml')]);
  must(['apply', '-f', path.join(repo, 'apps/agora-sandboxes/namespace.yaml')]);
  must(['apply', '-f', path.join(repo, 'infrastructure/configs/previews/namespace.yaml')]);
  must(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: fixtures }));
  await until('no sandbox policy enforced', () => probe('agora-runs').code === 0 && probe(PREVIEW, 'sandboxed').code === 0);
  must(['apply', '-k', POLICIES]);
  await until('both policies enforced', () =>
    probe('agora-runs').err.includes(SANDBOX) && probe(PREVIEW, 'sandboxed').err.includes(KATA));
});

after(() => {
  for (const ns of [...UNTRUSTED, PREVIEW, TRUSTED]) {
    kubectl(['delete', 'pods,jobs', '--all', '-n', ns, '--wait=false']);
  }
});

describe('untrusted-compute namespaces: a cnpg.io/cluster label exempts nobody', () => {
  for (const ns of UNTRUSTED) {
    test(`${ns}: a CNPG-labelled Pod without a sandbox, by a ServiceAccount granted Pod create`, (t) =>
      denied(t, pod(ns), INTRUDER, SANDBOX));
    test(`${ns}: the same Pod by kind's admin`, (t) => denied(t, pod(ns), ADMIN, SANDBOX));
    test(`${ns}: the same Pod as the job controller`, (t) => denied(t, pod(ns), JOB_CONTROLLER, SANDBOX));
    test(`${ns}: the same Pod as CNPG's operator — no CNPG cluster lives here`, (t) =>
      denied(t, pod(ns), CNPG_OPERATOR, SANDBOX));
    test(`${ns}: a CNPG-labelled Pod with runtimeClassName runc`, (t) =>
      denied(t, pod(ns, { runtimeClassName: 'runc' }), INTRUDER, SANDBOX));
    test(`${ns}: a Pod without label nor sandbox`, (t) => denied(t, pod(ns, { cnpg: false }), INTRUDER, SANDBOX));
    test(`${ns}: a sandboxed Pod (gVisor) is admitted`, (t) =>
      admitted(t, pod(ns, { cnpg: false, runtimeClassName: 'sandboxed' }), INTRUDER));
    test(`${ns}: a Kata Pod is admitted`, (t) =>
      admitted(t, pod(ns, { cnpg: false, runtimeClassName: 'kata' }), INTRUDER));
    test(`${ns}: a CNPG-labelled Pod is admitted once sandboxed: the label neither helps nor hurts`, (t) =>
      admitted(t, pod(ns, { runtimeClassName: 'sandboxed' }), INTRUDER));
  }

  test('agora-runs: a Job of CNPG-labelled Pods without a sandbox — the job controller cannot create them', async (t) => {
    const job = jobOf('agora-runs');
    must(['create', '-f', '-'], JSON.stringify(job));
    const events = await jobEvents(job, (es) => es.some((e) => e.reason === 'SuccessfulCreate' || e.reason === 'FailedCreate'));
    for (const e of events) t.diagnostic(`event ${e.reason}: ${e.message}`);
    const failed = events.filter((e) => e.reason === 'FailedCreate');
    assert.ok(!events.some((e) => e.reason === 'SuccessfulCreate'), 'the job controller created a Pod');
    assert.ok(failed.length > 0, 'no FailedCreate event');
    assert.match(failed[0].message, new RegExp(`ValidatingAdmissionPolicy '${SANDBOX}'.*denied request`));
    const pods = must(['get', 'pods', '-n', 'agora-runs', '-l', `job-name=${job.metadata.name}`, '-o', 'name']);
    t.diagnostic(`pods of the Job: ${pods || '(none)'}`);
    assert.equal(pods, '');
  });
});

describe('preview namespaces: Kata only, a cnpg.io/cluster label exempts nobody', () => {
  test('a CNPG-labelled Pod without a runtime is refused by both policies', (t) => {
    const r = create(t, pod(PREVIEW), INTRUDER);
    assert.notEqual(r.code, 0, 'admitted');
    assert.match(r.err, new RegExp(`'${SANDBOX}' with binding '${SANDBOX}' denied request`));
    assert.match(r.err, new RegExp(`'${KATA}' with binding '${KATA}' denied request`));
  });
  test('a CNPG-labelled Pod under gVisor is refused (Kata only)', (t) =>
    denied(t, pod(PREVIEW, { runtimeClassName: 'sandboxed' }), INTRUDER, KATA));
  test('the same as CNPG\'s operator', (t) =>
    denied(t, pod(PREVIEW, { runtimeClassName: 'sandboxed' }), CNPG_OPERATOR, KATA));
  test('a Kata Pod is admitted', (t) => admitted(t, pod(PREVIEW, { cnpg: false, runtimeClassName: 'kata' }), INTRUDER));
});

describe('where CNPG runs (preview-system, a trusted namespace): its Pods are admitted', () => {
  test('an instance Pod, created by CNPG\'s operator, no runtimeClassName', (t) => admitted(t, pod(TRUSTED), CNPG_OPERATOR));
  test('a Job Pod (initdb, join, recovery), created by the job controller', (t) =>
    admitted(t, pod(TRUSTED, { extraLabels: { 'cnpg.io/jobRole': 'initdb' } }), JOB_CONTROLLER));
  test('a CNPG-labelled Job: the job controller creates its Pod', async (t) => {
    const job = jobOf(TRUSTED);
    must(['create', '-f', '-'], JSON.stringify(job));
    const events = await jobEvents(job, (es) => es.some((e) => e.reason === 'SuccessfulCreate' || e.reason === 'FailedCreate'));
    for (const e of events) t.diagnostic(`event ${e.reason}: ${e.message}`);
    assert.ok(events.some((e) => e.reason === 'SuccessfulCreate'), 'no SuccessfulCreate event');
    assert.ok(!events.some((e) => e.reason === 'FailedCreate'), 'a FailedCreate event');
  });
});

// A Job as CNPG writes one (labels cnpg.io/cluster, cnpg.io/jobRole on its Pod template), no runtimeClassName.
function jobOf(namespace) {
  const name = `job-${run}-${++serial}`;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace, labels: { 'cnpg.io/cluster': 'pg', 'cnpg.io/jobRole': 'initdb' } },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: { 'cnpg.io/cluster': 'pg', 'cnpg.io/jobRole': 'initdb' } },
        spec: { restartPolicy: 'Never', ...podSpec() },
      },
    },
  };
}

async function jobEvents(job, done) {
  const { name, namespace } = job.metadata;
  let events = [];
  await until(`events of Job ${namespace}/${name}`, () => {
    const out = must(['get', 'events', '-n', namespace, '--field-selector', `involvedObject.kind=Job,involvedObject.name=${name}`, '-o', 'json']);
    events = JSON.parse(out).items;
    return done(events);
  });
  return events;
}
