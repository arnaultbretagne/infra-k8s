// The Obsidian vault backup (apps/obsidian/vault-backup.yaml), its own script run as deployed.
//
// `kubectl kustomize apps/obsidian` is rendered as Flux applies it. From the render: the script (the
// ConfigMap the CronJobs mount), and each CronJob's image, command, environment, mounts and security
// context. The restore Job is apps/obsidian/backup/restore-job.yaml, as RESTORE.md has it applied.
// Each run starts that image (docker) with that command, that environment and those mounts: the PVC
// is a directory with its vault/ subPath, the Secret a set of test values under the keys of the SOPS
// file. One thing differs from the cluster: the `r2` remote is rclone's local backend, a directory,
// instead of s3, so the crypt remote `backup` is real and its storage readable by the test.
//
//   RUNNER=docker (default): docker run <the manifests' rclone image>, read-only root, the caller's
//     uid (the pod runs 1000; the script does not depend on it), no capabilities.
//   RUNNER=local: `sh` and `rclone` from PATH, whose version must be the manifests' one.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const kubectl = process.env.KUBECTL ?? 'kubectl';
const runner = process.env.RUNNER ?? 'docker';

const render = (dir) =>
  parseAllDocuments(execFileSync(kubectl, ['kustomize', join(repo, dir)], { encoding: 'utf8' })).map((d) => d.toJSON());
const objects = render('apps/obsidian');
const find = (kind, name) => {
  const found = objects.filter((o) => o.kind === kind && o.metadata.name === name);
  assert.equal(found.length, 1, `one ${kind} ${name} in the render`);
  return found[0];
};
const backupJob = find('CronJob', 'obsidian-vault-backup');
const verifyJob = find('CronJob', 'obsidian-vault-verify');
const restoreJob = parse(readFileSync(join(repo, 'apps/obsidian/backup/restore-job.yaml'), 'utf8'));
const podOf = (cronJob) => cronJob.spec.jobTemplate.spec.template;
const sopsFile = parse(readFileSync(join(repo, 'apps/obsidian/vault-backup.secrets.yaml'), 'utf8'));

// The Secret, for the test: the SOPS file's keys, test values.
const secretValues = {
  RCLONE_CONFIG_R2_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  RCLONE_CONFIG_R2_ACCESS_KEY_ID: 'test-access-key',
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: 'test-secret-key',
  CRYPT_PASSWORD: 'test crypt password, long enough',
  CRYPT_PASSWORD2: 'test crypt salt, also long',
};

const image = podOf(backupJob).spec.containers[0].image;
const imageTag = image.split(':')[1];

const work = mkdtempSync(join(tmpdir(), 'vault-backup-'));
const pvc = join(work, 'pvc'); // obsidian-data; the vault is its vault/ subPath
const vault = join(pvc, 'vault');
const r2 = join(work, 'r2'); // the `r2` remote's root: the bucket is r2/<bucket>
mkdirSync(vault, { recursive: true });
mkdirSync(r2);

// ---------------------------------------------------------------------------------------------
// Running a pod template's container.

// MUTATE=<name> breaks the script on purpose: the run must then fail (the workflow checks it does).
const SYNC_EXCLUDE = '      --exclude "$EXCLUDE" \\\n';
const SYNC_BACKUP_DIR = '      --backup-dir "backup:history/$ts" \\\n';
const MUTATIONS = {
  exclude: [[SYNC_EXCLUDE, '']],
  'backup-dir': [[SYNC_BACKUP_DIR, '']],
  cryptcheck: [['--exclude "$EXCLUDE" -v\n    echo "==> verify DONE', '--exclude "$EXCLUDE" -v || true\n    echo "==> verify DONE']],
  retention: [['RETENTION_DAYS=7\n', 'RETENTION_DAYS=5\n']],
  // rclone's defaults and no check of R2 first: the script as it hung on the cluster.
  silent: [['export RCLONE_CONTIMEOUT=', 'true RCLONE_CONTIMEOUT='], ['reach_r2() {\n', 'reach_r2() {\n  return 0\n']],
  // The sync without its budget; with a hard one, which cuts the transfer running.
  budget: [['      --max-duration "$PASS_BUDGET" --cutoff-mode soft \\\n', '']],
  hard: [['--max-duration "$PASS_BUDGET" --cutoff-mode soft', '--max-duration "$PASS_BUDGET" --cutoff-mode hard']],
};
const replaceAll = (content, pairs, what) => pairs.reduce((c, [from, to]) => {
  assert.ok(c.includes(from), `${what}: the script no longer has ${JSON.stringify(from)}`);
  return c.replace(from, to);
}, content);
function mutate(file, content) {
  const name = process.env.MUTATE;
  if (!name || file !== 'vault-backup.sh') return content;
  return replaceAll(content, MUTATIONS[name] ?? assert.fail(`unknown MUTATE=${name}`), `MUTATE=${name}`);
}

const configMapFiles = new Map(); // ConfigMap name (and rewrite) -> host directory with its data
function configMapDir(name, rewrite = []) {
  const key = JSON.stringify([name, rewrite]);
  if (!configMapFiles.has(key)) {
    const dir = join(work, `configmap-${name}-${configMapFiles.size}`);
    mkdirSync(dir);
    for (const [file, content] of Object.entries(find('ConfigMap', name).data)) {
      const mutated = mutate(file, content);
      writeFileSync(join(dir, file), file === 'vault-backup.sh' ? replaceAll(mutated, rewrite, 'rewrite') : mutated);
    }
    configMapFiles.set(key, dir);
  }
  return configMapFiles.get(key);
}

// The container's environment, as the kubelet builds it: envFrom first, then env.
function environment(container) {
  const env = {};
  for (const from of container.envFrom ?? []) {
    if (from.configMapRef) Object.assign(env, find('ConfigMap', from.configMapRef.name).data);
    else if (from.secretRef) {
      assert.equal(from.secretRef.name, sopsFile.metadata.name);
      for (const key of Object.keys(sopsFile.stringData)) env[key] = secretValues[key];
    } else throw new Error(`unexpected envFrom ${JSON.stringify(from)}`);
  }
  for (const { name, value, valueFrom } of container.env ?? []) {
    assert.equal(valueFrom, undefined, `${name}: only plain env values are expected`);
    env[name] = value ?? '';
  }
  return env;
}

// Runs `args` (the container's command by default) in the container of a pod template. `timeout` (s):
// killed then, as the Job's deadline would; `network: 'host'`: the host's network, to reach a port
// of the test (127.0.0.1) instead of none; `rewrite`: [from, to] replaced in the script.
let runs = 0;
function run(template, { args, env: extra = {}, pvcDir = pvc, mounts = [], timeout, network = 'none', rewrite } = {}) {
  const pod = template.spec;
  const container = pod.containers[0];
  const command = args ?? container.command;
  const env = { ...environment(container), RCLONE_CONFIG_R2_TYPE: 'local', ...extra };
  const volumes = new Map(pod.volumes.map((v) => [v.name, v]));
  const binds = []; // [host, container path, readOnly]
  const tmpfs = [];
  for (const m of container.volumeMounts) {
    const v = volumes.get(m.name);
    if (v.persistentVolumeClaim) {
      assert.equal(v.persistentVolumeClaim.claimName, 'obsidian-data');
      binds.push([join(pvcDir, m.subPath ?? ''), m.mountPath, Boolean(m.readOnly || v.persistentVolumeClaim.readOnly)]);
    } else if (v.configMap) binds.push([configMapDir(v.configMap.name, rewrite), m.mountPath, true]);
    else if (v.emptyDir) tmpfs.push(m.mountPath);
    else throw new Error(`unexpected volume ${m.name}`);
  }
  binds.push(...mounts);
  let result;
  if (runner === 'docker') {
    const sc = container.securityContext ?? {};
    const name = `vault-backup-test-${process.pid}-${runs++}`;
    const argv = ['run', '--rm', '--name', name, '--network', network, '--user', `${process.getuid()}:${process.getgid()}`, '-w', '/r2',
      '-v', `${r2}:/r2`];
    if (sc.readOnlyRootFilesystem) argv.push('--read-only');
    if (sc.allowPrivilegeEscalation === false) argv.push('--security-opt', 'no-new-privileges');
    if (sc.capabilities?.drop?.includes('ALL')) argv.push('--cap-drop', 'ALL');
    for (const path of tmpfs) argv.push('--tmpfs', path);
    for (const [host, path, ro] of binds) argv.push('-v', `${host}:${path}${ro ? ':ro' : ''}`);
    for (const [k, v] of Object.entries(env)) argv.push('-e', `${k}=${v}`);
    argv.push('--entrypoint', command[0], container.image, ...command.slice(1));
    // SIGKILL: the docker CLI only forwards a SIGTERM to the container, whose sh ignores it as PID 1.
    result = spawnSync('docker', argv, { encoding: 'utf8', timeout: timeout && timeout * 1000, killSignal: 'SIGKILL' });
    if (result.error?.code === 'ETIMEDOUT') spawnSync('docker', ['rm', '-f', name]);
  } else {
    // The container's paths, moved to their host directories.
    const host = (s) => {
      for (const [h, path] of binds) if (s === path || s.startsWith(`${path}/`)) return h + s.slice(path.length);
      return s;
    };
    const [bin, ...rest] = command.map(host);
    const localEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, host(v)]));
    const argv = [bin === '/bin/sh' ? (process.env.SH ?? 'sh') : bin, ...rest];
    // coreutils timeout signals the whole process group: the script and its rclone.
    if (timeout) argv.unshift('timeout', '-k', '5', String(timeout));
    result = spawnSync(argv[0], argv.slice(1), { cwd: r2, encoding: 'utf8', env: { PATH: process.env.PATH, ...localEnv } });
    if (timeout && result.status === 124) result.error = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  }
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (result.error && !timedOut) throw result.error;
  return { code: result.status, out: `${result.stdout}${result.stderr}`, timedOut };
}

const backup = (opts) => run(podOf(backupJob), opts);
const verify = (opts) => run(podOf(verifyJob), opts);

// RESTORE.md's own commands: each `job=$(... restore-job.yaml ... | kubectl -n obsidian create -f - -o name)` is
// run up to that last pipe (`kubectl set env --local` needs no cluster), with its variables, and the Job it
// prints is the one run.
const procedure = [...readFileSync(join(repo, 'apps/obsidian/RESTORE.md'), 'utf8')
  .matchAll(/job=\$\(([^()]*?apps\/obsidian\/backup\/restore-job\.yaml[^()]*?) *\| *\n? *kubectl -n obsidian create -f - -o name\)/g)]
  .map((m) => m[1]);
const kubectlDir = process.env.KUBECTL ? dirname(resolve(process.env.KUBECTL)) : null;
function documentedJob(which, vars) {
  const commands = procedure.filter((c) => (which === 'versions') === c.includes('"versions"'));
  assert.equal(commands.length, 1, `one ${which} command in RESTORE.md`);
  const PATH = kubectlDir ? `${kubectlDir}:${process.env.PATH}` : process.env.PATH;
  const job = parse(execFileSync('sh', ['-c', commands[0]], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH, ...vars } }));
  assert.equal(job.kind, 'Job');
  return job.spec.template;
}

// rclone itself, in the backup's container, with the crypt remote configured as the script does.
let obscured;
function rclone(args, opts = {}) {
  obscured ??= Object.fromEntries(['CRYPT_PASSWORD', 'CRYPT_PASSWORD2'].map((k) => {
    const r = run(podOf(backupJob), { args: ['rclone', 'obscure', secretValues[k]] });
    assert.equal(r.code, 0, r.out);
    return [k.replace('CRYPT_', 'RCLONE_CONFIG_BACKUP_'), r.out.trim()];
  }));
  return run(podOf(backupJob), { ...opts, args: ['rclone', ...args], env: { ...obscured, ...opts.env } });
}
// The history/<ts> folders; none before the first pass that replaces or deletes a file (exit 3).
function historyDirs() {
  const r = rclone(['lsf', '--dirs-only', 'backup:history']);
  if (r.code === 3) return [];
  assert.equal(r.code, 0, r.out);
  return r.out.trim().split('\n').map((d) => d.replace(/\/$/, '')).sort();
}
function rcloneOk(args, opts) {
  const r = rclone(args, opts);
  assert.equal(r.code, 0, `rclone ${args.join(' ')}:\n${r.out}`);
  return r.out;
}

// ---------------------------------------------------------------------------------------------
// The vault and the bucket, seen from the host.

const bucket = join(r2, find('ConfigMap', 'obsidian-vault-backup-env').data.RCLONE_CONFIG_BACKUP_REMOTE.replace(/^r2:/, ''));
const MONTH_AGO = Date.now() / 1000 - 30 * 86400;

function write(path, content, mtime = MONTH_AGO) {
  const file = join(vault, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, mtime, mtime);
}

function walk(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    out.push({ path: relative(base, full), dir: entry.isDirectory() });
    if (entry.isDirectory()) out.push(...walk(full, base));
  }
  return out;
}

// Every stored object: path, size, modification time, content hash.
function snapshot() {
  return walk(bucket).filter((e) => !e.dir).map(({ path }) => {
    const s = statSync(join(bucket, path));
    return `${path} ${s.size} ${s.mtimeMs} ${createHash('sha256').update(readFileSync(join(bucket, path))).digest('hex')}`;
  }).sort();
}

const tsOf = (out) => {
  const m = out.match(/==> backup DONE \((\d{8}T\d{6}Z)\)/);
  assert.ok(m, `no pass timestamp in:\n${out}`);
  return m[1];
};
const passTs = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One pass per second at most: a pass's history folder is named after its second.
async function pass(opts) {
  await sleep(1100);
  const before = passTs(new Date());
  const r = backup(opts);
  const after = passTs(new Date());
  assert.equal(r.code, 0, `backup failed:\n${r.out}`);
  const ts = tsOf(r.out);
  assert.ok(before <= ts && ts <= after, `pass timestamp ${ts} outside ${before}..${after}`);
  return { ...r, ts };
}

// The vault: notes, a non-ASCII name, an attachment, Obsidian's own settings and its two
// workspace files.
const NOTES = {
  'Daily/2026-11-19.md': '# 19 November\n\nmarker-daily-19: called the plumber.\n',
  'Daily/2026-11-20.md': '# 20 November\n\nmarker-daily-20: wrote the backup.\n',
  'Projects/Idée été.md': '# Summer idea\n\nmarker-idea-v1: a garden.\n',
  'Inbox.md': 'marker-inbox: nothing yet.\n',
  '.obsidian/app.json': '{"marker-app-json": true}\n',
  // A name with every character a shell or YAML could take for its own.
  [`Projects/R&D $HOME 'q' "d" | a\\b: c #h & z.md`]: 'marker-odd-name: R&D notes.\n',
};
const WORKSPACE = ['.obsidian/workspace.json', '.obsidian/workspace-mobile.json'];
const ATTACHMENT = 'attachments/photo.png';
const attachment = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256));
const IDEA = 'Projects/Idée été.md';
const ODD = Object.keys(NOTES).find((p) => p.includes('R&D'));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IDEA_V2 = '# Summer idea\n\nmarker-idea-v2: a garden, and a pond. Rewritten.\n';
const DELETED = 'Daily/2026-11-19.md';
const passes = {};

function touchWorkspace(i) {
  for (const w of WORKSPACE) write(w, `{"marker-workspace": ${i}}\n`, Date.now() / 1000);
}

// ---------------------------------------------------------------------------------------------

test('the manifests: what is tested is what is deployed', () => {
  const ha = render('apps/home-assistant').find((o) => o.kind === 'CronJob' && o.metadata.name === 'ha-config-backup');
  const haImage = podOf(ha).spec.containers[0].image;
  assert.match(image, /^rclone\/rclone:\d+\.\d+\.\d+$/);
  for (const t of [podOf(backupJob), podOf(verifyJob), restoreJob.spec.template]) {
    assert.equal(t.spec.containers.length, 1);
    assert.equal(t.spec.initContainers, undefined);
    assert.equal(t.spec.containers[0].image, haImage, 'the image of ha-config-backup');
  }
  assert.equal(backupJob.spec.schedule, '*/15 * * * *');
  assert.equal(backupJob.spec.concurrencyPolicy, 'Forbid');
  assert.deepEqual(podOf(backupJob).spec.containers[0].command, ['/bin/sh', '/scripts/vault-backup.sh', 'backup']);
  assert.match(verifyJob.spec.schedule, /^\d+ \d+ \* \* \d$/, 'weekly');
  assert.equal(verifyJob.spec.concurrencyPolicy, 'Forbid');
  assert.deepEqual(podOf(verifyJob).spec.containers[0].command, ['/bin/sh', '/scripts/vault-backup.sh', 'verify']);
  // The restore Job is the backup's pod, the vault writable, and the same script.
  const r = restoreJob.spec.template.spec;
  const b = podOf(backupJob).spec;
  assert.deepEqual(r.containers[0].envFrom, b.containers[0].envFrom);
  assert.deepEqual(r.containers[0].securityContext, b.containers[0].securityContext);
  assert.deepEqual(r.securityContext, b.securityContext);
  assert.deepEqual(r.containers[0].command, ['/bin/sh', '/scripts/vault-backup.sh', 'restore']);
  assert.deepEqual(restoreJob.spec.template.metadata.labels, podOf(backupJob).metadata.labels);
  assert.deepEqual(podOf(verifyJob).spec, { ...b, containers: [{ ...b.containers[0], name: 'verify', command: podOf(verifyJob).spec.containers[0].command }] },
    'verify runs the backup pod, its command aside');

  for (const t of [podOf(backupJob), podOf(verifyJob)]) {
    const pod = t.spec;
    const c = pod.containers[0];
    // Criterion 2: obsidian-data, subPath vault, read-only.
    const pvcVolume = pod.volumes.find((v) => v.persistentVolumeClaim);
    assert.deepEqual(pvcVolume.persistentVolumeClaim, { claimName: 'obsidian-data', readOnly: true });
    assert.deepEqual(c.volumeMounts.find((m) => m.name === pvcVolume.name), {
      name: pvcVolume.name, mountPath: '/vault', subPath: 'vault', readOnly: true,
    });
    // Criterion 7.
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.securityContext.runAsNonRoot, true);
    assert.equal(pod.securityContext.runAsUser, 1000);
    assert.deepEqual(pod.securityContext.seccompProfile, { type: 'RuntimeDefault' });
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(c.securityContext.capabilities, { drop: ['ALL'] });
    assert.equal(c.securityContext.runAsUser ?? 1000, 1000);
    assert.equal(c.securityContext.runAsNonRoot ?? true, true);
  }

  // Criterion 6: the Secret is SOPS-encrypted for .sops.yaml's recipient, no value in clear.
  const recipient = readFileSync(join(repo, '.sops.yaml'), 'utf8').match(/age: (age1\w+)/)[1];
  assert.deepEqual(sopsFile.sops.age.map((a) => a.recipient), [recipient]);
  assert.deepEqual(Object.keys(sopsFile.stringData).sort(), Object.keys(secretValues).sort());
  for (const [k, v] of Object.entries(sopsFile.stringData)) assert.match(v, /^ENC\[AES256_GCM,data:/, `${k} encrypted`);
  assert.equal(sopsFile.data, undefined);
  const secret = find('Secret', 'obsidian-vault-backup');
  assert.equal(secret.metadata.namespace, 'obsidian');

  // Criterion 8: DNS and R2's 443 out, nothing in.
  const cnp = find('CiliumNetworkPolicy', 'obsidian-vault-backup');
  assert.deepEqual(cnp.spec.endpointSelector.matchLabels, podOf(backupJob).metadata.labels);
  assert.deepEqual(cnp.spec.enableDefaultDeny, { ingress: true, egress: true });
  assert.deepEqual(cnp.spec.ingress ?? [], []);
  assert.equal(cnp.spec.egress.length, 2);
  const [dns, out] = cnp.spec.egress;
  assert.deepEqual(dns.toEndpoints, [{ matchLabels: { 'k8s:io.kubernetes.pod.namespace': 'kube-system', 'k8s:k8s-app': 'kube-dns' } }]);
  assert.deepEqual(dns.toPorts[0].ports, [{ port: '53', protocol: 'UDP' }, { port: '53', protocol: 'TCP' }]);
  assert.deepEqual(Object.keys(out).sort(), ['toFQDNs', 'toPorts']);
  assert.deepEqual(out.toFQDNs, [{ matchPattern: '*.r2.cloudflarestorage.com' }]);
  assert.deepEqual(out.toPorts, [{ ports: [{ port: '443', protocol: 'TCP' }] }]);
  // That DNS rule sends the pod's queries through Cilium's DNS proxy, in the host's network: the host
  // firewall (bootstrap.sh, input policy drop) must accept what Cilium marks for its proxies
  // (MagicMarkIsToProxy, 0x200/0xf00), or every query is dropped unanswered (seen live 2026-11-21).
  assert.deepEqual(dns.toPorts[0].rules, { dns: [{ matchPattern: '*' }] });
  const nftables = readFileSync(join(repo, 'bootstrap/bootstrap.sh'), 'utf8').match(/cat > \/etc\/nftables\.conf <<'NFTEOF'\n([\s\S]*?)\nNFTEOF/)[1];
  assert.match(nftables, /chain input \{\n\s*type filter hook input priority 0; policy drop;/);
  assert.match(nftables, /^\s*ip saddr 10\.244\.0\.0\/16 meta mark & 0x00000f00 == 0x00000200 accept$/m);

  // The bucket is dedicated: not cnpg-s3-creds's.
  const env = find('ConfigMap', 'obsidian-vault-backup-env').data;
  assert.equal(env.RCLONE_CONFIG_BACKUP_TYPE, 'crypt');
  assert.match(env.RCLONE_CONFIG_BACKUP_REMOTE, /^r2:obsidian-backup$/);
  assert.ok(!JSON.stringify(objects).includes('cnpg-s3-creds'));
});

test(`the runner runs rclone ${imageTag}, the manifests' version`, () => {
  const r = run(podOf(backupJob), { args: ['rclone', 'version'] });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.split('\n')[0], `rclone v${imageTag}`);
  console.log(`# ${runner}: ${r.out.split('\n')[0]}${runner === 'docker' ? ` (${image})` : ''}`);
});

test('first pass: the vault goes to backup:current', async () => {
  for (const [path, content] of Object.entries(NOTES)) write(path, content);
  write(ATTACHMENT, attachment);
  touchWorkspace(1);
  passes.first = await pass();
  const listed = rcloneOk(['lsf', '-R', '--files-only', 'backup:current']).trim().split('\n').sort();
  assert.deepEqual(listed, [...Object.keys(NOTES), ATTACHMENT].sort());
});

test('(a) a second pass with nothing changed sends no file', async () => {
  const before = snapshot();
  const r = await pass();
  assert.match(r.out, /There was nothing to transfer/);
  assert.doesNotMatch(r.out, /Copied|Moved|Deleted/);
  assert.match(r.out, /Transferred:\s+0 B \/ 0 B/);
  assert.deepEqual(snapshot(), before, 'not one stored object written');
  assert.deepEqual(historyDirs(), [], 'no history/<ts> for a pass that replaced nothing');
});

test('(b) a modified note: the new version in current, the old one in history/<ts>', async () => {
  write(IDEA, IDEA_V2, Date.now() / 1000);
  passes.modified = await pass();
  const { ts } = passes.modified;
  assert.equal(rcloneOk(['cat', `backup:current/${IDEA}`]), IDEA_V2);
  assert.equal(rcloneOk(['cat', `backup:history/${ts}/${IDEA}`]), NOTES[IDEA]);
  assert.deepEqual(rcloneOk(['lsf', '-R', '--files-only', `backup:history/${ts}`]).trim().split('\n'), [IDEA]);
});

test('(c) a deleted note ends up in history/<ts>', async () => {
  rmSync(join(vault, DELETED));
  passes.deleted = await pass();
  const { ts } = passes.deleted;
  assert.equal(rcloneOk(['cat', `backup:history/${ts}/${DELETED}`]), NOTES[DELETED]);
  assert.doesNotMatch(rcloneOk(['lsf', '-R', 'backup:current']), new RegExp(DELETED));
});

test('(d) workspace.json is never sent', async () => {
  touchWorkspace(2);
  const r = await pass();
  assert.doesNotMatch(r.out, /workspace/);
  const everything = rcloneOk(['lsf', '-R', 'backup:']);
  assert.match(everything, /^current\/\.obsidian\/app\.json$/m, 'the rest of .obsidian is backed up');
  assert.doesNotMatch(everything, /workspace/);
  for (const w of WORKSPACE) assert.ok(existsSync(join(vault, w)));
});

test('(e) names and contents are encrypted in the bucket', () => {
  const entries = walk(bucket);
  assert.ok(entries.length > 10, 'objects stored');
  const plainNames = new Set(['current', 'history', ...Object.keys(passes).map((k) => passes[k].ts)]);
  for (const p of [...Object.keys(NOTES), ATTACHMENT, ...WORKSPACE]) for (const seg of p.split('/')) plainNames.add(seg);
  for (const p of [...Object.keys(NOTES), ATTACHMENT]) plainNames.add(p.split('/').pop().replace(/\.\w+$/, ''));
  const markers = [...Object.values(NOTES), IDEA_V2].map((c) => c.match(/marker-[\w-]+/)[0]);
  for (const { path, dir } of entries) {
    for (const seg of path.split('/')) {
      assert.ok(!plainNames.has(seg), `${path}: a plain name in the bucket`);
      for (const name of plainNames) assert.ok(name.length < 4 || !seg.includes(name), `${path} contains ${name}`);
    }
    if (dir) continue;
    const bytes = readFileSync(join(bucket, path));
    assert.equal(bytes.subarray(0, 8).toString('latin1'), 'RCLONE\0\0', `${path}: an rclone crypt object`);
    for (const m of markers) assert.ok(!bytes.includes(m), `${path} contains ${m} in clear`);
    assert.ok(!bytes.includes(attachment.subarray(0, 64)), `${path} contains the attachment in clear`);
  }
});

test('(f) cryptcheck passes, then fails once a stored file is altered', () => {
  let r = verify();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 differences found/);
  assert.match(r.out, /verify DONE/);

  // A bit flipped in a stored object: same size, same modification time.
  const object = join(bucket, rcloneOk(['cryptdecode', '--reverse', 'backup:', `current/${IDEA}`]).trim().split('\t').pop().trim());
  const original = readFileSync(object);
  const s = statSync(object);
  const altered = Buffer.from(original);
  altered[altered.length - 5] ^= 0x01;
  writeFileSync(object, altered);
  utimesSync(object, s.atime, s.mtime);
  r = verify();
  assert.notEqual(r.code, 0, `cryptcheck passed on an altered object:\n${r.out}`);
  assert.match(r.out, /1 differences found/);
  assert.doesNotMatch(r.out, /verify DONE/);

  writeFileSync(object, original);
  utimesSync(object, s.atime, s.mtime);
  assert.equal(verify().code, 0, 'passes again once the object is put back');

  // A note the last pass has not stored yet is a difference too.
  write('Unsent.md', 'marker-unsent\n', Date.now() / 1000);
  r = verify();
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Unsent\.md/);
  rmSync(join(vault, 'Unsent.md'));
  assert.equal(verify().code, 0);
});

test('(g) a note restored as RESTORE.md says is identical to the original', () => {
  // "One note": first the versions, then the restore, into a vault that lost the note; the others untouched.
  const lost = join(work, 'lost');
  cpSync(pvc, lost, { recursive: true });
  rmSync(join(lost, 'vault', IDEA));
  rmSync(join(lost, 'vault', ODD));
  writeFileSync(join(lost, 'vault', 'Inbox.md'), 'edited since\n');
  let r = run(documentedJob('versions', { NOTE: IDEA }), { pvcDir: lost });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`^current/${IDEA};${Buffer.byteLength(IDEA_V2)};`, 'm'));
  assert.match(r.out, new RegExp(`^history/${passes.modified.ts}/${IDEA};${Buffer.byteLength(NOTES[IDEA])};`, 'm'));

  r = run(documentedJob('restore', { NOTE: IDEA, FROM: 'current' }), { pvcDir: lost });
  assert.equal(r.code, 0, r.out);
  assert.ok(readFileSync(join(lost, 'vault', IDEA)).equals(readFileSync(join(vault, IDEA))), 'byte for byte');
  assert.equal(statSync(join(lost, 'vault', IDEA)).mtimeMs, statSync(join(vault, IDEA)).mtimeMs);
  assert.equal(readFileSync(join(lost, 'vault', 'Inbox.md'), 'utf8'), 'edited since\n');

  // A path holding & | " ' \\ $ : #, through the same two commands: listed, then restored byte for byte.
  r = run(documentedJob('versions', { NOTE: ODD }), { pvcDir: lost });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`^current/${escape(ODD)};${Buffer.byteLength(NOTES[ODD])};`, 'm'));
  r = run(documentedJob('restore', { NOTE: ODD, FROM: 'current' }), { pvcDir: lost });
  assert.equal(r.code, 0, r.out);
  assert.ok(readFileSync(join(lost, 'vault', ODD)).equals(readFileSync(join(vault, ODD))), 'byte for byte');

  // Its previous version, from history/<ts>: identical to the note as it was.
  r = run(documentedJob('restore', { NOTE: IDEA, FROM: `history/${passes.modified.ts}` }), { pvcDir: lost });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(lost, 'vault', IDEA), 'utf8'), NOTES[IDEA]);

  // "The whole vault": restore-job.yaml as it is, onto an empty volume.
  const empty = join(work, 'empty');
  mkdirSync(join(empty, 'vault'), { recursive: true });
  r = run(restoreJob.spec.template, { pvcDir: empty });
  assert.equal(r.code, 0, r.out);
  const tree = (root) => walk(root).filter((e) => !e.dir).map((e) => e.path)
    .filter((p) => !WORKSPACE.includes(p)).sort()
    .map((p) => `${p} ${createHash('sha256').update(readFileSync(join(root, p))).digest('hex')} ${statSync(join(root, p)).mtimeMs}`);
  assert.deepEqual(tree(join(empty, 'vault')), tree(vault));
  // ... which cryptcheck then finds identical to the backup (step 3).
  r = verify({ pvcDir: empty });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 differences found/);
});

test('retention: history/ older than 7 days is purged, by the pass time, not the files\' age', async () => {
  const seed = join(work, 'seed');
  mkdirSync(seed);
  writeFileSync(join(seed, 'note.md'), 'old\n');
  const eightDays = passTs(new Date(Date.now() - 8 * 86400e3));
  const sixDays = passTs(new Date(Date.now() - 6 * 86400e3));
  for (const ts of ['20200101T000000Z', eightDays, sixDays]) {
    rcloneOk(['copyto', '/seed/note.md', `backup:history/${ts}/Old/note.md`], { mounts: [[seed, '/seed', true]] });
  }
  // Not a pass's folder: left alone.
  rcloneOk(['copyto', '/seed/note.md', 'backup:history/not-a-pass/note.md'], { mounts: [[seed, '/seed', true]] });
  const r = await pass();
  const dirs = historyDirs();
  assert.ok(!dirs.includes('20200101T000000Z'), r.out);
  assert.ok(!dirs.includes(eightDays), r.out);
  assert.ok(dirs.includes(sixDays));
  assert.ok(dirs.includes('not-a-pass'));
  // The month-old note replaced today: today's version, kept.
  assert.ok(dirs.includes(passes.modified.ts));
  assert.ok(dirs.includes(passes.deleted.ts));
  assert.match(r.out, new RegExp(`purge backup:history/${eightDays}`));
});

test('an empty vault (lost or unmounted volume) is refused, nothing touched', () => {
  const before = snapshot();
  const empty = join(work, 'empty-pvc');
  mkdirSync(join(empty, 'vault'), { recursive: true });
  const r = backup({ pvcDir: empty });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /refusing to back up/);
  assert.deepEqual(snapshot(), before);
});

test('a crypt password still the placeholder is refused', () => {
  const r = backup({ env: { CRYPT_PASSWORD: 'REPLACE-ME' } });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /CRYPT_PASSWORD is not set/);
});

// ---------------------------------------------------------------------------------------------
// R2 out of reach, or a pass that does not finish: rclone's error or progress in the log, before the
// Job's deadline. These runs use the manifests' own `r2` remote (s3, Cloudflare), its endpoint a port
// of the test's.

const deadline = backupJob.spec.jobTemplate.spec.activeDeadlineSeconds;
const r2Type = find('ConfigMap', 'obsidian-vault-backup-env').data.RCLONE_CONFIG_R2_TYPE;
// How long the test waits, at most: far inside the deadline, and the script as it was on the cluster
// (MUTATE=silent) still had not written a line there.
const QUICK = 90;
// The slow runs below, skipped in a MUTATE run that breaks something else (ci.sh runs one per part).
const unless = (...mutations) => ({ skip: Boolean(process.env.MUTATE) && !mutations.includes(process.env.MUTATE) });

// A port that never answers: a process of its own listens and never accepts, so a connection waits
// in the kernel's queue and its TLS never starts. With `full`, that queue is filled first: a new
// connection's SYN is then dropped, as Cilium drops a packet its policy denies.
async function deafPort({ full }) {
  const child = spawn(process.execPath, ['-e', `const s = require('net').createServer();
    s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
      console.log(s.address().port);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((ok, ko) => {
    child.stdout.once('data', (d) => ok(Number(String(d).trim())));
    child.once('exit', (code) => ko(new Error(`the deaf listener exited (${code})`)));
  });
  const held = [];
  const close = () => { for (const s of held) s.destroy(); child.kill('SIGKILL'); };
  const attempt = () => new Promise((ok) => {
    const s = connect(port, '127.0.0.1');
    held.push(s);
    s.once('connect', () => ok(true));
    s.once('error', () => ok(false));
    s.setTimeout(2000, () => ok(false));
  });
  if (full) {
    while (await attempt()); // backlog 1: two connections fill the queue, the third is dropped
  }
  return { port, close };
}

for (const [what, full, error] of [
  ['drops the connection, as the network policy does', true, /dial tcp 127\.0\.0\.1:\d+: i\/o timeout/],
  ['accepts it and never answers', false, /TLS handshake timeout/],
]) {
  test(`an R2 that ${what}: rclone's error is in the log within seconds, nothing synced`, unless('silent'), async () => {
    const listener = await deafPort({ full });
    try {
      const started = Date.now();
      const r = backup({
        network: 'host', timeout: QUICK,
        env: { RCLONE_CONFIG_R2_TYPE: r2Type, RCLONE_CONFIG_R2_ENDPOINT: `https://127.0.0.1:${listener.port}` },
      });
      const seconds = Math.round((Date.now() - started) / 1000);
      assert.ok(!r.timedOut, `still running after ${QUICK}s (the Job's deadline: ${deadline}s), its whole log:\n${r.out}`);
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /ERROR : .*ListObjectsV2/, 'rclone says what failed');
      assert.match(r.out, error);
      assert.match(r.out, /R2 did not answer/);
      assert.match(r.out, /WARNING: the R2 endpoint's host \(<id>\.0\.0\.1:\d+\) is not one label under r2\.cloudflarestorage\.com/);
      assert.doesNotMatch(r.out, /==> sync|backup DONE/);
      console.log(`# R2 that ${what}: the pass failed after ${seconds}s, with rclone's error (deadline: ${deadline}s)`);
    } finally {
      listener.close();
    }
  });
}

test('the R2 endpoint is checked against the network policy, the check without the account id', () => {
  const env = { RCLONE_CONFIG_R2_TYPE: r2Type };
  const runs = {
    'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com': true,
    'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.net': false,
    'https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com': false,
    'https://r2.cloudflarestorage.com': false,
  };
  for (const [endpoint, matches] of Object.entries(runs)) {
    // No network: the check is printed, then R2 is unreachable at once.
    const r = backup({ timeout: QUICK, env: { ...env, RCLONE_CONFIG_R2_ENDPOINT: endpoint } });
    assert.ok(!r.timedOut, r.out);
    const check = r.out.split('\n').filter((l) => /R2 endpoint/.test(l));
    assert.equal(check.length, 1, r.out);
    assert.doesNotMatch(check[0], /0123456789abcdef/, 'the check does not print the account id');
    if (matches) assert.match(r.out, /==> R2 endpoint: <id>\.r2\.cloudflarestorage\.com, as the network policy allows/, endpoint);
    else assert.match(r.out, /WARNING: the R2 endpoint's host .* is not one label under r2\.cloudflarestorage\.com/, endpoint);
  }
  // The pattern checked is the policy's.
  assert.deepEqual(find('CiliumNetworkPolicy', 'obsidian-vault-backup').spec.egress[1].toFQDNs, [{ matchPattern: '*.r2.cloudflarestorage.com' }]);
});

// The budget: no transfer started after it, none cut (soft), and a pass's worst case inside the
// Job's deadline: 2 x PASS_BUDGET, plus what PR #397 accounts for.
const script = find('ConfigMap', 'obsidian-vault-backup-scripts').data['vault-backup.sh'];
const minutes = (name) => Number(script.match(new RegExp(`^${name}=(\\d+)m$`, 'm'))[1]) * 60;
test('the sync\'s budget: soft, one file at a time, the largest first, inside the deadline', () => {
  assert.match(script, /--check-first --order-by size,descending --transfers 1 \\\n\s+--max-duration "\$PASS_BUDGET" --cutoff-mode soft/);
  assert.doesNotMatch(script, /cutoff-mode hard/);
  assert.ok(2 * minutes('PASS_BUDGET') <= deadline - 120, `2 x PASS_BUDGET leaves 2 min of the ${deadline}s deadline`);
});

test('the history: one sync per pass, so one read of the vault per history/<ts>, and no size filter', () => {
  const pass = script.slice(script.indexOf('  backup)\n'), script.indexOf('\n  verify)\n'));
  assert.equal(pass.match(/rclone sync /g).length, 1, 'one sync writes backup:current and history/<ts>');
  assert.equal(pass.match(/--backup-dir /g).length, 1);
  // A size filter applies to the stored side too: a stored version outside it is overwritten unseen.
  assert.doesNotMatch(script, /--(max|min)-size|--max-age|--min-age/);
});

// The same script at 1/30 of its durations: its budget 12 s, the Job's deadline 28 s; R2 at a constant
// 32 KiB/s for every pass.
const SCALE = 30;
const scaled = {
  rewrite: [['PASS_BUDGET=6m\n', 'PASS_BUDGET=12s\n'], ['--stats 1m', '--stats 2s']],
  env: { RCLONE_BWLIMIT: '32K' },
  timeout: deadline / SCALE,
};
const KiB = 1024;
const stored = () => rcloneOk(['lsf', '-R', '--files-only', 'backup:current']).trim().split('\n');

test('under constant conditions, a file longer than the budget is sent whole, and the passes converge', unless('budget', 'hard'), async () => {
  // 16 s alone: longer than the budget, inside the deadline (the review's 100 MiB at 200 KiB/s, 512 s of 840).
  const BIG = ['attachments/lecture.mp4', 512 * KiB];
  const MEDIUM = [1, 2, 3].map((i) => [`attachments/scan-${i}.pdf`, 128 * KiB]); // 4 s each
  for (const [path, size] of [BIG, ...MEDIUM]) write(path, randomBytes(size), Date.now() / 1000);
  const wanted = [BIG, ...MEDIUM].map(([p]) => p);
  let done = false;
  for (let i = 1; i <= 5 && !done; i++) {
    const before = stored();
    await sleep(1100);
    const r = backup(scaled);
    assert.ok(!r.timedOut, `pass ${i} reached the Job's deadline (${scaled.timeout}s at this scale):\n${r.out}`);
    assert.ok([0, 10].includes(r.code), `pass ${i}:\n${r.out}`);
    assert.match(r.out, /Elapsed time:/, 'rclone\'s progress');
    const added = stored().filter((p) => !before.includes(p));
    assert.ok(added.length > 0 || r.code === 0, `pass ${i} stored nothing:\n${r.out}`);
    if (i === 1) assert.deepEqual(added.filter((p) => wanted.includes(p)), [BIG[0]], 'the largest first, longer than its budget, not cut');
    console.log(`# pass ${i}: exit ${r.code}, stored ${added.join(', ') || 'nothing new'}`);
    done = r.code === 0;
  }
  assert.ok(done, 'the passes converged to a complete pass');
  for (const p of wanted) assert.ok(stored().includes(p), p);
  const v = verify();
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /0 differences found/);
});

test('a file replaced by a smaller version, a large one by a small one: the old one in history/<ts>', async () => {
  // The review's case: a 5 MiB version stored, a 1 MiB one in the vault now.
  const DOC = 'attachments/document.pdf';
  const A = randomBytes(5 * 1024 * KiB);
  const B = randomBytes(1024 * KiB);
  write(DOC, A, Date.now() / 1000 - 60);
  await pass();
  write(DOC, B, Date.now() / 1000);
  const { ts } = await pass();
  const restored = join(work, 'restored-doc');
  mkdirSync(restored);
  rcloneOk(['copyto', `backup:history/${ts}/${DOC}`, '/out/document.pdf'], { mounts: [[restored, '/out', false]] });
  assert.ok(readFileSync(join(restored, 'document.pdf')).equals(A), 'history/<ts> holds version A, byte for byte');
  rcloneOk(['copyto', `backup:current/${DOC}`, '/out/current.pdf'], { mounts: [[restored, '/out', false]] });
  assert.ok(readFileSync(join(restored, 'current.pdf')).equals(B), 'current holds version B');
  const v = verify();
  assert.equal(v.code, 0, v.out);
});

test.after(() => rmSync(work, { recursive: true, force: true }));
