# CI/CD

Every push to `main` runs the normal suite: locked Bun installation, all
TypeScript/Bun tests outside `integration/`, workspace typechecks, web and API
build checks, and Go tests, race tests, vet, and node-binary compilation.
Nothing is deployed unless those jobs pass for that exact push.

`dorny/paths-filter` only controls expensive integrations and deployments; it
never skips normal validation. The five-node suite runs for API, D1 migration,
Go node, core, protocol, shared, storage, HTTP-integration, or lockfile/root
package changes. It starts local Wrangler/D1 plus five Go nodes. The Chromium
and Pion WebRTC suite runs for API, D1 migration, Go node, protocol, shared,
storage, WebRTC-integration, or lockfile/root package changes. A docs-only
push therefore runs normal CI but neither integration nor deployment.

Changes to the browser transport selector or WebRTC peer helper are treated as
transport changes, while ordinary UI-only changes are not.

Deployment is in the same `main` workflow and is downstream of every required
job. It is never triggered from a pull request or another workflow. API
deployment includes `apps/api`, `packages/protocol`, `packages/shared`, and
the Bun dependency state. Web deployment includes `apps/web`, `packages/core`,
`packages/storage`, `packages/shared`, and the Bun dependency state. The Go
node is not a hosted application, so node-only changes never deploy the Worker
or Pages site.

The Worker is deployed with the existing `apps/api/wrangler.jsonc` configuration.
The production site is the existing `horcruxfs.pages.dev` Pages project; CI
deploys its Vite output with Wrangler only after a web-affecting validated push.
The web deployment requires the existing Vite build variables `VITE_API_URL`
and `VITE_HORCRUX_STORAGE_MODE` as environment variables on `production-web`.
The latter must be `http` or `webrtc`; CI deliberately fails instead of
shipping a build pointed at the localhost or mock-storage defaults.

## GitHub configuration

Create these GitHub Environments to isolate deployment credentials:

- `production-d1-migrations`
- `production-api`
- `production-web`

Each needs the `CLOUDFLARE_API_TOKEN` secret accepted by Wrangler, scoped to
the least Cloudflare account/project permissions needed for that environment.
Set `VITE_API_URL` on `production-web` to the production Worker origin (the
current CSP permits `https://horcruxfs-api.jibinaaron.workers.dev`) and set
`VITE_HORCRUX_STORAGE_MODE` to `http` or `webrtc`. If Wrangler cannot infer
the Cloudflare account from the token, add the correct account ID to the
existing Wrangler configuration rather than adding it as a CI secret.

`JWT_SECRET` and `CAPABILITY_PRIVATE_KEY` are Worker runtime secrets. Keep them
in Cloudflare with `wrangler secret put`; do not place them in GitHub. Add a
random `AUTH_PEPPER` as a secret in `production-d1-migrations`; the API deploy
job copies it to the Worker before deployment. The
checked-in Worker configuration already supplies `WEB_ORIGIN` and
`CAPABILITY_PUBLIC_KEY`.

The workflow does not itself require an Environment approval: `environment:`
scopes secrets, while required reviewers and wait timers are optional GitHub
Environment protection rules. Leave those rules unset for these environments
to keep the normal `main` path fully automatic.

## D1 migrations

Migration changes run local Wrangler/D1 validation in the five-node suite and
WebRTC suite, then automatically execute the existing remote Wrangler migration
command. A migration failure fails its job, so the API deployment condition is
not met. D1 and Worker deployment are not one transaction; migrations must
remain forward-compatible with the currently deployed Worker.

## Local parity

Run the same normal checks with:

```sh
bun install --frozen-lockfile
bun test apps packages
bun run typecheck
bun run build:web
bun run build:api
cd apps/node && go test ./... && go test -race ./... && go vet ./... && go build ./cmd/horcrux-node
```

Run integrations with `bun run test:five-node` and `bun run test:webrtc`.
Both create local Wrangler/D1 state and temporary Go nodes; the WebRTC suite
also needs Chromium, optionally selected with `HORCRUX_CHROMIUM`.

## Node binaries

Use **Actions → build node binaries → Run workflow** to build validated native
CGO binaries for Linux amd64, Linux arm64, Windows amd64, and macOS arm64. The
workflow uploads each binary and a SHA-256 checksum as workflow artifacts. It
does not create tags, releases, versions, or published executables. Native
runners are used because `github.com/mattn/go-sqlite3` requires CGO; the
repository must have access to GitHub's `ubuntu-24.04-arm` runner for the
Linux arm64 artifact.
