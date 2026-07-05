# TODO — auth MCP (obsidian vault)

Contexte : le durcissement **F-05** (audit 2026-07-03) est en place — le serveur MCP
valide déjà l'**audience** du token (un token émis pour une autre app est rejeté) et
**pinne l'algo** RS256. Réf : PR obsidian-stack#9, ADR 0002.

Restent **deux gardes optionnelles désactivées par défaut** (pour ne pas se verrouiller
dehors tant qu'on n'a pas inspecté un vrai token Pocket-ID) : **groupe** et **scope**.

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
