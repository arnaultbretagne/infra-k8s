// The Google login's refresher finds its endpoint under the DNS its network policy allows, with the resolver of the
// image it runs (musl, node:24-alpine as the CronJob pins it), in Docker.
//
// The policy (CiliumNetworkPolicy antigravity-refresher) lets Cilium's DNS proxy answer the names it lists and refuse
// every other one (REFUSED, Cilium's default reject response). A stand-in for that proxy answers the same way; the
// Pod's /etc/resolv.conf is written as the kubelet writes it for ClusterFirst — the namespace's search domains, and
// ndots:5 unless the Pod's dnsConfig sets it. Then getaddrinfo (dns.lookup, musl's) is asked for Google's token
// endpoint. Needs Docker, as the tests workflow has it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseAllDocuments } from 'yaml'

const ROOT = new URL('../../', import.meta.url).pathname
const rendered = parseAllDocuments(execFileSync(process.env.KUBECTL ?? 'kubectl', ['kustomize', join(ROOT, 'apps/agora-gateway')], { encoding: 'utf8' })).map((d) => d.toJS())
const cronJob = rendered.find((o) => o.kind === 'CronJob' && o.metadata.name === 'antigravity-refresher')
const pod = cronJob.spec.jobTemplate.spec.template.spec
const image = pod.containers[0].image
const policy = rendered.find((o) => o.kind === 'CiliumNetworkPolicy' && o.metadata.name === 'antigravity-refresher')
const allowed = policy.spec.egress.flatMap((e) => e.toPorts ?? []).flatMap((p) => p.rules?.dns ?? []).map((r) => r.matchName)
// The host the script calls: its default TOKEN_URL, which the CronJob does not override.
const script = rendered.find((o) => o.kind === 'ConfigMap' && o.metadata.name === 'antigravity-refresher').data['refresh.mjs']
const HOST = new URL(script.match(/process\.env\.TOKEN_URL \?\? '([^']+)'/)[1]).hostname
assert.ok(!pod.containers[0].env.some((e) => e.name === 'TOKEN_URL'))

// Inside the container: the DNS proxy's stand-in on 127.0.0.1:53, then musl's getaddrinfo for HOST.
const PROBE = `
import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'
const allowed = new Set(JSON.parse(process.env.ALLOWED))
const asked = []
const server = dgram.createSocket('udp4')
server.on('message', (msg, rinfo) => {
  let i = 12; const labels = []
  while (msg[i]) { labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString()); i += msg[i] + 1 }
  const name = labels.join('.'); const qtype = msg.readUInt16BE(i + 1); const qend = i + 5
  const ok = allowed.has(name.toLowerCase())
  asked.push((qtype === 28 ? 'AAAA ' : 'A ') + name + (ok ? ' answered' : ' refused'))
  const header = Buffer.alloc(12); msg.copy(header, 0, 0, 2)
  header.writeUInt16BE(0x8180 | (msg.readUInt16BE(2) & 0x0100) | (ok ? 0 : 5), 2)
  header.writeUInt16BE(1, 4)
  const answer = ok && qtype === 1 ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 0, 2, 1]) : Buffer.alloc(0)
  header.writeUInt16BE(answer.length ? 1 : 0, 6)
  server.send(Buffer.concat([header, msg.subarray(12, qend), answer]), rinfo.port, rinfo.address)
})
await new Promise((ok) => server.bind(53, '127.0.0.1', ok))
let result
try { result = 'resolved ' + (await lookup(process.env.HOST)).address } catch (error) { result = 'failed ' + error.code }
console.log(JSON.stringify({ result, asked }))
server.close()
`

/** The kubelet's resolv.conf for a ClusterFirst Pod in agora-gateway, its dnsConfig options merged. */
function resolvConf(spec) {
  const options = new Map([['ndots', '5']])
  for (const o of spec.dnsConfig?.options ?? []) options.set(o.name, o.value)
  return [
    'search agora-gateway.svc.cluster.local svc.cluster.local cluster.local',
    'nameserver 127.0.0.1',
    `options ${[...options].map(([k, v]) => (v === undefined ? k : `${k}:${v}`)).join(' ')}`,
    '',
  ].join('\n')
}

function probe(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'refresher-dns-'))
  chmodSync(dir, 0o755)
  writeFileSync(join(dir, 'probe.mjs'), PROBE)
  writeFileSync(join(dir, 'resolv.conf'), resolvConf(spec))
  const out = execFileSync('docker', ['run', '--rm', '--network', 'none', '-e', `HOST=${HOST}`, '-e', `ALLOWED=${JSON.stringify(allowed)}`,
    '-v', `${dir}/probe.mjs:/probe/probe.mjs:ro`, '-v', `${dir}/resolv.conf:/etc/resolv.conf:ro`, image, 'node', '/probe/probe.mjs'], { encoding: 'utf8', timeout: 100_000 })
  return { conf: resolvConf(spec), ...JSON.parse(out.trim().split('\n').at(-1)) }
}

describe("the refresher's DNS, on its image's resolver, under its network policy", () => {
  it('the policy lets DNS answer the token endpoint alone, which the script calls', () => {
    assert.equal(HOST, 'oauth2.googleapis.com')
    assert.deepEqual(allowed, ['oauth2.googleapis.com'])
    assert.match(image, /^node:24-alpine@sha256:/)
  })

  it('as deployed (ndots:1): the token endpoint resolves, its own name asked first', () => {
    const r = probe(pod)
    console.log(`ℹ deployed: ${r.result}; asked: ${r.asked.join(', ')}`)
    assert.match(r.conf, /options ndots:1/)
    assert.equal(r.result, 'resolved 192.0.2.1')
    assert.match(r.asked[0], / oauth2\.googleapis\.com answered$/)
  })

  it("without the Pod's dnsConfig (the cluster's ndots:5): what musl does, said", () => {
    const r = probe({ ...pod, dnsConfig: undefined })
    console.log(`ℹ ndots:5: ${r.result}; asked: ${r.asked.join(', ')}`)
    assert.match(r.conf, /options ndots:5/)
  })
})
