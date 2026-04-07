# App Hardening Checklist

Guide pour deployer une app sans Helm chart dans ce cluster.
Les Helm charts upstream gerent leur propre hardening — ce document
concerne uniquement les manifests ecrits a la main (dossier `apps/`).

---

## 1. Investiguer l'image

Avant d'ecrire le Deployment, inspecter l'image :

```bash
# Quel user par defaut ?
docker inspect <image> --format '{{.Config.User}}'

# Lire l'entrypoint (souvent un script qui drop les privileges)
docker run --rm --entrypoint cat <image> <entrypoint-path>

# Tester en non-root + read-only
docker run --rm --user 1000:1000 --read-only \
  --tmpfs /tmp --tmpfs <data-dir> \
  -e ... <image>
```

Points a verifier :
- L'image supporte-t-elle un user non-root ? (chercher `USER` dans le Dockerfile ou un `su-exec`/`gosu` dans l'entrypoint)
- Quels repertoires l'app ecrit-elle ? (`/data`, `/tmp`, `/app/data`, etc.)
- L'app demarre-t-elle correctement en `--read-only` avec des tmpfs sur les chemins d'ecriture ?

---

## 2. securityContext obligatoire

Chaque Deployment doit avoir les deux niveaux :

```yaml
spec:
  template:
    spec:
      # --- Pod-level ---
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000      # adapter au USER de l'image
        runAsGroup: 1000
        fsGroup: 1000

      containers:
        - name: app
          # --- Container-level ---
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
```

Si `readOnlyRootFilesystem: true` bloque l'app, monter des `emptyDir`
sur les chemins d'ecriture necessaires — jamais desactiver le read-only.

```yaml
          volumeMounts:
            - name: data
              mountPath: /app/data
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: data
          emptyDir: {}
        - name: tmp
          emptyDir: {}
```

---

## 3. Probes

Toujours definir les trois types quand l'app expose un healthcheck :

| Probe | Role | Quand |
|-------|------|-------|
| `startupProbe` | Protege les demarrages lents | Empeche le liveness de tuer un pod qui boot |
| `readinessProbe` | Retire le pod du Service | L'app n'est pas prete a recevoir du trafic |
| `livenessProbe` | Restart le pod | L'app est plantee ou deadlockee |

```yaml
          startupProbe:
            httpGet:
              path: /health
              port: <port>
            failureThreshold: 10
            periodSeconds: 3
          readinessProbe:
            httpGet:
              path: /health
              port: <port>
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: <port>
            periodSeconds: 30
```

Ne pas utiliser `initialDelaySeconds` sur liveness — utiliser un
`startupProbe` a la place.

---

## 4. Resources

Toujours definir `requests` et `limits.memory`.
Ne pas mettre de `limits.cpu` (throttling est pire qu'un burst temporaire).

```yaml
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
```

---

## 5. Namespace label PSS

Chaque namespace applicatif doit avoir le label Pod Security Standards :

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: my-app
  labels:
    pod-security.kubernetes.io/enforce: restricted
```

Le niveau `restricted` est le defaut pour les apps.
Seuls les composants infra privilegies (CNI, LB) utilisent `privileged`.

---

## 6. Recap — avant de merge

- [ ] Image testee en `--user 1000:1000 --read-only`
- [ ] `securityContext` pod + container presents
- [ ] `readOnlyRootFilesystem: true` + `emptyDir` pour les chemins d'ecriture
- [ ] `capabilities: drop: [ALL]`
- [ ] `startupProbe` + `readinessProbe` + `livenessProbe`
- [ ] `resources` requests + memory limit
- [ ] Namespace avec label PSS `restricted`
- [ ] Secrets via SOPS (pas de valeurs en clair)
