# Poster Meteor runbook

Poster Meteor is the storefront and the API that serves it. This is how the service is put together, where its config lives, how a release ships, and how to roll one back.

## Architecture

Customers use the storefront (`web`). It is a static React app served by nginx on port 8080.

| Path | What the customer is doing |
| --- | --- |
| `/` | Browsing the catalog |
| `/products/:sku` | Looking at one poster |
| `/cart`, `/checkout` | Reviewing the cart and placing an order |
| `/orders/:number` | Reading the confirmation |

The cart stays in the browser. nginx sends `/api` to the API and every other path to the storefront.

The API (`api`) is a Node process on port 3000. Product data is compiled into the image from `apps/api/src/catalog.ts`. Catalog routes do not query Postgres. `POST /api/orders` and `GET /api/orders/:number` do.

Postgres is one CloudNativePG instance, version 16, database `poster_meteor`, owner `poster`. The operator writes `DATABASE_URL` into secret `poster-meteor-app` under the key `uri`.

What a failure looks like to a customer:

| What failed | Browse the catalog | Place or look up an order |
| --- | --- | --- |
| `web` | The site does not load | The site does not load |
| `api` | Product pages do not load | Checkout does not complete |
| Postgres | The catalog still loads | `POST /api/orders` and `GET /api/orders/:number` return 503, `Orders are unavailable` |

`GET /healthz` and `GET /readyz` report process health only. They do not check Postgres, so an API pod can be Ready while checkout is unavailable.

A checkout that returns an order number (`PM-…`, status `received`) means the storefront, the API, and Postgres all served that request. Payment fields are required and then discarded. They are not stored.

### Workload names

Names are unqualified. The chart is `deploy/chart` (`poster-meteor`).

| Kind | Name |
| --- | --- |
| CNPG Cluster | `poster-meteor` |
| App secret (`uri` is `DATABASE_URL`) | `poster-meteor-app` |
| API Deployment and Service | `api` (port 3000) |
| API HorizontalPodAutoscaler | `api` |
| Web Deployment and Service | `web` (port 8080) |
| Ingress | `poster-meteor` |
| Migrate Job | `poster-meteor-migrate` |
| Seed Job | `poster-meteor-seed` |

The chart renders `api` and `web`. It does not render a worker. The `worker` keys in `deploy/values.yaml` are unused by the templates.

The ingress host is `<pack.hostnamePrefix>-<slot.number>.<domain>`. The values in this repo render `poster-meteor-01.backlot.plural.sh`. Class is `nginx`. TLS secret is `ingress.tlsSecretName` (`backlot-wildcard-tls`). `/api` routes to `api`. Every other path routes to `web`.

Images are `ghcr.io/pluralsh-demos/poster-meteor` (API, from `Dockerfile`) and `ghcr.io/pluralsh-demos/poster-meteor-web` (storefront, from `Dockerfile.web`). Tags come from `api.image.tag` and `web.image.tag`.

## Where config lives

`deploy/values.yaml` is the file we edit: image tags, API autoscaling, `api.db.poolMax`, Postgres, and ingress.

`deploy/chart` is the Helm chart. Its own `values.yaml` repeats the defaults with image tag `dev` so `helm template` works with no extra file. Releases do not deploy that tag.

`deploy/chart/release-values.yaml` is the same bytes as `deploy/values.yaml`. Continuous delivery packages only the chart folder and reads `release-values.yaml`. Change image tags in both files in the same commit. Editing only one of them ships a different revision than the pull request shows.

Migrations are `apps/api/migrations/*.sql`. `node apps/api/dist/migrate.js` applies them in filename order and records each filename in `schema_migrations`. A file already recorded is skipped. The command holds an advisory lock.

`poster-meteor-migrate` is a `pre-install,pre-upgrade` hook. On a first install, before `poster-meteor-app` exists, the hook exits 0. When the secret exists it waits until Postgres accepts a connection, then migrates, before API pods roll. The `api` initContainer runs the same command, and the server does not listen until that container exits. The lock lets the hook and the initContainer overlap.

`poster-meteor-seed` is a `post-install,post-upgrade` hook. It waits for Postgres, migrates, then runs `node apps/api/dist/seed.js`. Seed inserts 2000 historical orders only when `orders` is empty. A later upgrade leaves those rows in place.

Both Jobs delete themselves on success (`before-hook-creation,hook-succeeded`).

Checkout capacity follows `api.autoscaling.minReplicas` and `api.autoscaling.maxReplicas` (3 and 6). The Deployment replica count is the HPA minimum. The API container requests 100m CPU and 256Mi memory, and the HPA targets 70% CPU. `POOL_MAX` on the API is `api.db.poolMax` (8). Postgres `max_connections` is the string `postgres.maxConnections` (`"60"`). Changing these is a values change. It does not build an image and it does not create worker pods.

## How a release ships

Pull requests run `.github/workflows/ci.yml`: install, test, build the API and the storefront, and `helm lint deploy/chart -f deploy/values.yaml`.

A push to `main` that changes `apps/**`, `package.json`, `package-lock.json`, `Dockerfile`, `Dockerfile.web`, or `deploy/web/**` runs `.github/workflows/release.yml`.

The image tag is the first 12 hex characters from `scripts/image-tag.sh`, a hash of the files that go into the images. Both values files sit outside that hash, so the commit that records the tag does not change the tag. If `ghcr.io/pluralsh-demos/poster-meteor:<tag>` or the web image already exists, the workflow reuses it. Otherwise it builds and pushes. The API image receives `GIT_SHA` from that commit.

The workflow then sets `api.image.tag`, `web.image.tag`, and `worker.image.tag` to that tag in `deploy/values.yaml` and writes the same bytes to `deploy/chart/release-values.yaml`. It commits and pushes that change.

Plural syncs `deploy/chart` with `release-values.yaml`. The deployment supplies `slot.number` and `domain`. `pack.hostnamePrefix` stays `poster-meteor` in the values file.

A commit that changes only the values files does not run `release.yml`. The tags in that commit are the tags that deploy.

## Rolling back

To undo a release, open a pull request that sets `api.image.tag`, `web.image.tag`, and `worker.image.tag` back to the previous tag, in both `deploy/values.yaml` and `deploy/chart/release-values.yaml`. That tag is already in the registry. Do not rebuild, and do not edit the chart's `values.yaml`.

This is safe when the release applied no new SQL file. Compare `apps/api/migrations` in the two commits with the filenames in `schema_migrations`. If the newer commit added a file and that filename is already recorded, the schema is ahead of the older image. Reverting the tags is the wrong fix. Ship a forward change instead.

When no new file was applied, the previous tag restores the previous API and storefront. The migrate hook runs again and skips every file already recorded. The seed hook does not insert orders that are already there.

Merging that pull request does not start an image build. The values files are not inputs to `release.yml`.
