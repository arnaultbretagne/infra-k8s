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
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
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
const MUTATIONS = {
  exclude: ['      --exclude "$EXCLUDE" \\\n      --fast-list -v', '      --fast-list -v'],
  'backup-dir': ['      --backup-dir "backup:history/$ts" \\\n', ''],
  cryptcheck: ['--exclude "$EXCLUDE" -v\n    echo "==> verify DONE', '--exclude "$EXCLUDE" -v || true\n    echo "==> verify DONE'],
  retention: ['RETENTION_DAYS=7\n', 'RETENTION_DAYS=5\n'],
};
function mutate(file, content) {
  const name = process.env.MUTATE;
  if (!name || file !== 'vault-backup.sh') return content;
  const [from, to] = MUTATIONS[name] ?? assert.fail(`unknown MUTATE=${name}`);
  assert.ok(content.includes(from), `MUTATE=${name}: the script no longer has what it breaks`);
  return content.replace(from, to);
}

const configMapFiles = new Map(); // ConfigMap name -> host directory with its data
function configMapDir(name) {
  if (!configMapFiles.has(name)) {
    const dir = join(work, `configmap-${name}`);
    mkdirSync(dir);
    for (const [file, content] of Object.entries(find('ConfigMap', name).data)) writeFileSync(join(dir, file), mutate(file, content));
    configMapFiles.set(name, dir);
  }
  return configMapFiles.get(name);
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

// Runs `args` (the container's command by default) in the container of a pod template.
function run(template, { args, env: extra = {}, pvcDir = pvc, mounts = [] } = {}) {
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
    } else if (v.configMap) binds.push([configMapDir(v.configMap.name), m.mountPath, true]);
    else if (v.emptyDir) tmpfs.push(m.mountPath);
    else throw new Error(`unexpected volume ${m.name}`);
  }
  binds.push(...mounts);
  let result;
  if (runner === 'docker') {
    const sc = container.securityContext ?? {};
    const argv = ['run', '--rm', '--network', 'none', '--user', `${process.getuid()}:${process.getgid()}`, '-w', '/r2',
      '-v', `${r2}:/r2`];
    if (sc.readOnlyRootFilesystem) argv.push('--read-only');
    if (sc.allowPrivilegeEscalation === false) argv.push('--security-opt', 'no-new-privileges');
    if (sc.capabilities?.drop?.includes('ALL')) argv.push('--cap-drop', 'ALL');
    for (const path of tmpfs) argv.push('--tmpfs', path);
    for (const [host, path, ro] of binds) argv.push('-v', `${host}:${path}${ro ? ':ro' : ''}`);
    for (const [k, v] of Object.entries(env)) argv.push('-e', `${k}=${v}`);
    argv.push('--entrypoint', command[0], container.image, ...command.slice(1));
    result = spawnSync('docker', argv, { encoding: 'utf8' });
  } else {
    // The container's paths, moved to their host directories.
    const host = (s) => {
      for (const [h, path] of binds) if (s === path || s.startsWith(`${path}/`)) return h + s.slice(path.length);
      return s;
    };
    const [bin, ...rest] = command.map(host);
    const localEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, host(v)]));
    result = spawnSync(bin === '/bin/sh' ? (process.env.SH ?? 'sh') : bin, rest, {
      cwd: r2, encoding: 'utf8', env: { PATH: process.env.PATH, ...localEnv },
    });
  }
  if (result.error) throw result.error;
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
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

test.after(() => rmSync(work, { recursive: true, force: true }));
