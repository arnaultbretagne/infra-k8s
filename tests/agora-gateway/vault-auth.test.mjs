// Which tokens the vault's MCP server accepts, and what the revocation in PR #295 cuts: obsidian-mcp v0.4.0's own
// config.ts and auth.ts (OBSIDIAN_MCP_SRC, checked out at its tag), run on the environment apps/obsidian deploys
// (`kubectl kustomize apps/obsidian`). Tokens have the shape Pocket-ID v2.18.0 gives an access token (fosite's
// JWT claims: sub, iss, aud as a list, iat, exp, scp — never client_id nor azp), signed by a key made for the test.
//
// What `agora_gateway_vault` can obtain from Pocket-ID v2.18.0 (Client.GetGrantTypes; no per-client switch):
//   - client_credentials: sub "client-<id>", aud [<id>];
//   - device_code, then refresh_token: with the client's secret AND a user of its allowed group (admin) approving
//     the code; sub = that user, aud [<id>], no client identity in the token;
//   - authorization_code: impossible, the client has no callback URL.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { parseAllDocuments } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const SRC = resolve(process.env.OBSIDIAN_MCP_SRC ?? join(HERE, '.obsidian-stack/mcp-server/src'))
const GATEWAY = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(join(REPO, 'apps/pocket-id/oidc-reconciler/spec.json'))}).clients.find((c) => c.name === 'agora_gateway_vault')))`], { encoding: 'utf8' }))
const ID = GATEWAY.id

// The obsidian-mcp container's environment, as this repository deploys it.
const rendered = execFileSync(process.env.KUBECTL ?? 'kubectl', ['kustomize', join(REPO, 'apps/obsidian')], { encoding: 'utf8' })
const deployment = parseAllDocuments(rendered).map((d) => d.toJS()).find((o) => o.kind === 'Deployment' && o.metadata.name === 'obsidian-mcp')
const container = deployment.spec.template.spec.containers.find((c) => c.name === 'mcp-server')
const deployedEnv = Object.fromEntries(container.env.filter((e) => 'value' in e).map((e) => [e.name, e.value]))

const { loadConfig } = await import(pathToFileURL(join(SRC, 'config.ts')).href)
const { authenticate, policyFromConfig } = await import(pathToFileURL(join(SRC, 'auth.ts')).href)

/** obsidian-mcp's policy for this environment, loaded by its own loadConfig (which refuses a blank gate). */
function policy(env) {
  const saved = { ...process.env }
  try {
    for (const key of Object.keys(deployedEnv)) delete process.env[key]
    Object.assign(process.env, env)
    return policyFromConfig(loadConfig())
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

/** The documented revocation: the client's id taken out of both lists in apps/obsidian/mcp-server.yaml. */
const without = (csv, id) => csv.split(',').filter((v) => v.trim() !== id).join(',')
const revoked = { ...deployedEnv, MCP_ALLOWED_AUDIENCE: without(deployedEnv.MCP_ALLOWED_AUDIENCE, ID), MCP_ALLOWED_CLIENT_IDS: without(deployedEnv.MCP_ALLOWED_CLIENT_IDS, ID) }
const clientIdsOnly = { ...deployedEnv, MCP_ALLOWED_CLIENT_IDS: without(deployedEnv.MCP_ALLOWED_CLIENT_IDS, ID) }

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'pocket-id', alg: 'RS256', use: 'sig' }] })
const issuer = deployedEnv.POCKET_ID_ISSUER

/** An access token as Pocket-ID v2.18.0 signs it. */
const token = ({ sub, aud }) => new SignJWT({ scp: [] }).setProtectedHeader({ alg: 'RS256', kid: 'pocket-id' })
  .setIssuer(issuer).setSubject(sub).setAudience(aud).setJti(randomUUID()).setIssuedAt().setExpirationTime('1h').sign(privateKey)

const tokens = {
  'client_credentials (the gateway)': () => token({ sub: `client-${ID}`, aud: [ID] }),
  'device_code (a user of the admin group approved it)': () => token({ sub: randomUUID(), aud: [ID] }),
}
const verdict = async (make, env) => {
  const result = await authenticate(await make(), jwks, policy(env))
  return result.ok ? 200 : result.status
}

describe('obsidian-mcp v0.4.0 on the environment apps/obsidian deploys', () => {
  it('accepts every token agora_gateway_vault can obtain, the device_code one on its audience alone', async () => {
    assert.equal(await verdict(tokens['client_credentials (the gateway)'], deployedEnv), 200)
    assert.equal(await verdict(tokens['device_code (a user of the admin group approved it)'], deployedEnv), 200)
  })

  it('refuses another client\'s client_credentials token, its own audience or a forged one', async () => {
    const other = randomUUID()
    assert.equal(await verdict(() => token({ sub: `client-${other}`, aud: [other] }), deployedEnv), 401)
    assert.equal(await verdict(() => token({ sub: `client-${other}`, aud: [deployedEnv.MCP_SERVER_URL] }), deployedEnv), 403)
  })

  it('taking the id out of MCP_ALLOWED_CLIENT_IDS alone is not a revocation: the device_code token still passes', async () => {
    assert.equal(await verdict(tokens['client_credentials (the gateway)'], clientIdsOnly), 403)
    assert.equal(await verdict(tokens['device_code (a user of the admin group approved it)'], clientIdsOnly), 200)
  })

  it('the documented revocation (the id out of both lists) refuses every token the client can obtain, and still boots', async () => {
    assert.notEqual(revoked.MCP_ALLOWED_CLIENT_IDS, '', 'another id stays: a blank list would stop the server at start')
    for (const [name, make] of Object.entries(tokens)) assert.equal(await verdict(make, revoked), 401, name)
  })

  it('the client declares no callback URL: no authorization_code token exists for it', () => {
    assert.deepEqual(GATEWAY.callbackURLs, [])
  })
})
