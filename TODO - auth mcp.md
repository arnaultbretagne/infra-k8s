# TODO — auth MCP (obsidian vault)

Contexte : le durcissement **F-05** (audit 2026-07-03) est en place — le serveur MCP
valide déjà l'**audience** du token (un token émis pour une autre app est rejeté) et
**pinne l'algo** RS256. Réf : PR obsidian-stack#9, ADR 0002.

Restent **deux gardes optionnelles désactivées par défaut** (pour ne pas se verrouiller
dehors tant qu'on n'a pas inspecté un vrai token Pocket-ID) : **groupe** et **scope**.

## Mise à jour (2026-07-05) — clients MCP déclarés dans le reconciler

Les deux clients OIDC utilisés en pratique sont maintenant déclarés dans
`apps/pocket-id/oidc-reconciler/spec.json` (branche `audit/f05-mcp-oidc-clients`) :

- `claude_auth` — callbacks `https://claude.ai/api/mcp/auth_callback` +
  `http://localhost:9876/oauth/callback`
- `openai_auth` — callbacks `https://chatgpt.com/connector/oauth/b1u3srH76huV` +
  `http://localhost:9876/oauth/callback`

Les deux avec `allowedGroups: ["admin"]` et `pkceEnabled: true`. Ceci lève le
prérequis bloquant de l'étape 1 ci-dessous (avant, aucun client MCP n'existait côté
Pocket-ID, donc pas de token à inspecter).

**Reste à faire côté opérationnel, après merge + sync Flux du ConfigMap** :
1. Déclencher le reconciler manuellement plutôt que d'attendre 3:15 :
   `kubectl -n pocket-id create job --from=cronjob/oidc-reconciler oidc-reconciler-manual`
   puis vérifier les logs (`CREATE claude_auth`, `CREATE openai_auth`).
2. Le reconciler ne gère jamais les secrets : aller dans l'UI admin Pocket-ID récupérer
   (ou régénérer) le `client_secret` de chacun des deux clients.
3. **Différence importante avec les autres clients (agent, code-server, …)** : il n'y a
   pas d'app à nous ici pour stocker ce secret en SOPS — le client OAuth, c'est Claude.ai
   / ChatGPT eux-mêmes. Le `client_id` + `client_secret` doivent être saisis dans leur UI
   de configuration de connecteur MCP externe (« Add custom connector » côté Claude.ai,
   config du connector côté ChatGPT), pas dans notre repo.
4. Une fois connecté, un vrai token est émis → reprendre l'étape 1 ci-dessous.

## À faire pour activer la garde « groupe = admin »

1. Obtenir un vrai token d'accès émis par Pocket-ID pour le MCP (via un client MCP qui
   marche : Claude.ai / Claude Code connecté au vault `vault.bretagne.dev`).
2. Décoder le payload :
   ```
   echo <jwt> | cut -d. -f2 | base64 -d 2>/dev/null | jq .
   ```
3. Vérifier les claims :
   - `aud`    → doit déjà valoir `https://vault.bretagne.dev` (sinon l'audience échoue déjà).
   - `groups` → contient-il `["admin"]` ? (dépend du client Pocket-ID : `isGroupRestricted`
     + un scope/claim `groups` émis dans l'access token).
   - `scope`  → que contient-il exactement ?
4. Si `groups` contient bien `admin`, décommenter dans
   `apps/obsidian/mcp-server.yaml` :
   ```yaml
   - name: MCP_REQUIRED_GROUPS
     value: "admin"
   # et éventuellement, si un scope dédié existe :
   # - name: MCP_REQUIRED_SCOPES
   #   value: "openid"
   ```
5. Redéployer, puis tester : un membre `admin` passe, un non-admin est rejeté en **403**.

## Notes

- Tant que ce n'est pas activé : on est **déjà** protégé du risque principal (confusion
  cross-service / replay) par la validation d'audience. Le groupe = défense en profondeur.
- Ces variables n'ont d'effet que sur l'image `obsidian-mcp >= 0.3.0`.
- Lié au **point 2** : une fois le client MCP déclaré dans le reconciler Pocket-ID
  (`apps/pocket-id/oidc-reconciler/spec.json`) avec `allowedGroups: ["admin"]`, on sait
  que Pocket-ID applique bien la restriction de groupe pour ce client.
- Les env optionnelles (client/groupe/scope) et leur code sont dans
  `obsidian-stack/mcp-server/src/auth.ts` (+ tests `auth.test.ts`).
- Pourquoi le callback `localhost:9876` apparaît pour les deux clients : très probablement
  un outil/bridge local (type `mcp-remote`) utilisé pour tester/configurer la connexion
  MCP en local avant de finaliser côté hébergé (Claude.ai / ChatGPT) — un port fixe de ce
  type est typique de ces bridges OAuth loopback (RFC 8252 « native apps »). Sans risque à
  le garder dans `callbackURLs` : Pocket-ID vérifie une correspondance exacte de
  redirect_uri, et le flow reste protégé par PKCE + secret.
