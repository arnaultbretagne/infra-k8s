// npm test's pretest: the tests render kustomizations with `kubectl kustomize`. Uses KUBECTL or the kubectl on the
// PATH if there is one; otherwise fetches kubectl v1.36.5 (the version of the repository's other jobs) into .bin/,
// checked against its sha256. linux-amd64 only; elsewhere, install kubectl or set KUBECTL.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOCAL = join(HERE, '.bin/kubectl')
const URL = 'https://dl.k8s.io/release/v1.36.5/bin/linux/amd64/kubectl'
const SHA256 = '33bc88a24c3b09cf55bfd59e6ca977881b61fc3f25ab65bc80c65b430248648e'

const works = (bin) => {
  try {
    execFileSync(bin, ['version', '--client'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (process.env.KUBECTL || existsSync(LOCAL) || works('kubectl')) process.exit(0)
if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.error('kubectl not found: install it, or set KUBECTL (this script only fetches linux-amd64)')
  process.exit(1)
}
console.log(`kubectl not found: fetching ${URL}`)
const r = await fetch(URL)
if (!r.ok) throw new Error(`${URL}: ${r.status}`)
const bin = Buffer.from(await r.arrayBuffer())
const sum = createHash('sha256').update(bin).digest('hex')
if (sum !== SHA256) throw new Error(`kubectl sha256 ${sum}, expected ${SHA256}`)
mkdirSync(dirname(LOCAL), { recursive: true })
writeFileSync(LOCAL, bin)
chmodSync(LOCAL, 0o755)
console.log(`kubectl v1.36.5 in ${LOCAL} (sha256 checked)`)
