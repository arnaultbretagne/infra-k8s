// The tests must bite: playground.test.mjs runs once per mutation of server.mjs (targets.mjs, MUTATIONS), and must
// fail exactly on the tests that guard what that mutation breaks, and pass the others. Exit code: the mutations
// whose failures differ from the expected ones (0 when each fails as it must).
//
//   npm run test:mutations
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUTATIONS } from './targets.mjs'

const LEAK = 'no answer sent to the browser holds the key'
const EXPECTED = {
  'no-scrub': [
    'an upstream error that echoes the key reaches the browser with the key scrubbed',
    'a key rotated or removed while a request is in flight is still scrubbed from its answer',
    LEAK,
  ],
  'scrub-current-only': ['a key rotated or removed while a request is in flight is still scrubbed from its answer', LEAK],
  'stream-cut-swallowed': ['an audio stream the service breaks off reaches the browser broken off, not as a complete answer'],
}

let wrong = 0
for (const name of Object.keys(MUTATIONS)) {
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', 'playground.test.mjs'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, MUTATE: name },
    encoding: 'utf8',
  })
  const out = run.stdout + run.stderr
  // The spec reporter's summary lists the failing tests after "✖ failing tests:".
  const summary = out.slice(out.lastIndexOf('✖ failing tests:'))
  const failed = out.includes('✖ failing tests:')
    ? [...summary.matchAll(/^✖ (.+?) \(\d+(?:\.\d+)?ms\)$/gm)].map((m) => m[1]).filter((n) => n !== 'failing tests:')
    : []
  const expected = EXPECTED[name] ?? []
  const ok = run.status !== 0 && JSON.stringify([...new Set(failed)].sort()) === JSON.stringify([...expected].sort())
  console.log(`${ok ? 'PASS' : 'FAIL'} MUTATE=${name}: exit ${run.status}, failed ${failed.length}:`)
  for (const f of new Set(failed)) console.log(`       ✖ ${f}`)
  if (!ok) {
    console.log(`     expected exactly: ${expected.join(' | ')}`)
    console.log(out.split('\n').filter((l) => /Error|expected|actual/.test(l)).slice(0, 20).join('\n'))
    wrong++
  }
}
process.exit(wrong)
