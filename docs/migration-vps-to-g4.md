# Migration du VPS vers g4

## Statut

Plan figé le 2026-09-01. Ce document est le runbook de la migration du cluster `bretagne`
depuis le VPS `85.17.246.41` vers le serveur homelab `g4` (`10.10.20.10`, WAN
`188.61.65.22`).

## Invariants

- La migration est une coupure franche : aucun PostgreSQL ne tourne simultanément des deux côtés.
- Le système Kubernetes est réinstallé proprement ; les quatre bases CNPG sont restaurées depuis R2.
- Les `destinationPath` et `serverName` Barman existants sont conservés.
- La clé AGE officielle est fournie depuis la copie hors cluster de l'opérateur, jamais copiée du VPS.
- Une nouvelle clé AES Kubernetes est générée pour le datastore du nouveau cluster.
- Pocket-ID est restauré sans réinitialisation : utilisateurs, passkeys, groupes, clients OIDC et
  clés API restent identiques.
- Aucun transcript Claude/Codex et aucun PVC local ne sont restaurés. Obsidian se resynchronise
  depuis Obsidian Sync.
- Le WAN expose uniquement TCP/443. ACME utilise Cloudflare DNS-01 et ne dépend pas du port 80.

## Adressage

| Usage | Adresse |
|---|---|
| Ancien VPS et rollback DNS | `85.17.246.41` |
| Nœud g4, API k0s et `externalIPs` Traefik | `10.10.20.10` |
| Adresse WAN publiée dans Cloudflare | `188.61.65.22` |

Les trois enregistrements DNS à basculer sont `bretagne.dev`, `*.bretagne.dev` et
`*.preview.bretagne.dev`.

## Sources de recovery CNPG

`externalClusters` désigne ici un catalogue Barman dans R2, pas un PostgreSQL encore actif.
Chaque `Cluster` remplace son `bootstrap.initdb` par un `bootstrap.recovery` pointant vers le
catalogue existant. Après promotion, il continue d'archiver vers la même configuration
`backup.barmanObjectStore`.

| Namespace | Cluster | `destinationPath` | `serverName` |
|---|---|---|---|
| `pocket-id` | `pocket-id-pg` | `s3://bretagne-pg-backups/pocket-id` | `pocket-id-pg` |
| `stremio` | `aiostreams-pg` | `s3://bretagne-pg-backups/aiostreams` | `aiostreams-pg` |
| `agora-onecli` | `onecli-pg` | `s3://bretagne-pg-backups/onecli` | `onecli-pg` |
| `agora` | `agora-pg` | `s3://bretagne-pg-backups/agora` | `agora-product` |

La continuation volontaire d'une archive non vide exige
`cnpg.io/skipEmptyWalArchiveCheck: enabled`. Elle n'est autorisée qu'après l'arrêt complet du
producteur VPS. Une copie figée des arborescences Barman peut être prise avant la reprise comme
assurance, mais elle ne devient pas une nouvelle archive active.

## Préparation avant la coupure

1. Corriger et valider `bootstrap/bootstrap.sh` pour g4.
2. Préparer, sans le publier, le commit de migration :
   - IP Traefik et EndpointSlice terminal vers `10.10.20.10` ;
   - `bootstrap.recovery` et `externalClusters` pour les quatre CNPG ;
   - conservation des `destinationPath` et `serverName` ;
   - annotation de continuation de l'archive.
3. Installer la clé AGE officielle et une nouvelle deploy key Flux sur g4.
4. Confirmer que `10.10.20.10` est réservé de manière stable sur le DHCP/VLAN 20 et que le routeur
   transfère TCP/443 vers cette adresse.

## Coupure

1. Suspendre la source Flux du VPS pour qu'il ne puisse pas appliquer le commit destiné à g4.
2. Arrêter les workloads applicatifs qui écrivent dans les quatre PostgreSQL.
3. Déclencher un backup CNPG manuel pour chaque cluster et attendre quatre états `completed`.
4. Forcer une rotation WAL sur chaque primary et vérifier que le dernier WAL est archivé dans R2.
5. Arrêter complètement k0s puis le VPS. À partir de cet instant, l'archive R2 n'a plus aucun
   producteur.
6. Publier le commit de migration.
7. Bootstrapper g4 depuis un clone frais avec `PUBLIC_IP=10.10.20.10`.
8. Laisser Flux créer les quatre CNPG : restauration du dernier base backup, rejeu des WAL jusqu'au
   dernier disponible, promotion, puis reprise de l'archivage dans le même catalogue.

## Validation avant DNS

- k0s et toutes les Kustomizations Flux sont `Ready`.
- Les quatre clusters CNPG sont sains et les données applicatives sont présentes.
- Les passkeys Pocket-ID existantes fonctionnent ; les clients OIDC et oauth2-proxy restent valides.
- Les certificats cert-manager sont `Ready` via DNS-01.
- Un nouveau backup de chaque CNPG est `completed` et les restore-tests passent.
- Depuis un réseau extérieur, une requête SNI vers `188.61.65.22:443` atteint Traefik sur g4.

## Bascule DNS

Mettre les trois enregistrements Cloudflare DNS-only sur `188.61.65.22`, contrôler la propagation,
puis tester tous les endpoints HTTPS.

## Rollback

Avant toute écriture acceptée sur g4, le rollback consiste à arrêter g4, redémarrer le VPS, retirer
la suspension Flux et remettre les trois DNS sur `85.17.246.41`.

Après des écritures sur g4, un retour au VPS exige un failback PostgreSQL ; un simple retour DNS
perdrait les nouvelles écritures.

## Décommissionnement

Après validation et nouveaux backups testés : révoquer la deploy key du VPS, supprimer sa copie
temporaire du token Cloudflare, sauvegarder hors cluster la nouvelle clé AES de g4, puis détruire le
VPS.
