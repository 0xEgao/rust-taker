# Portal container image

This folder builds the **Portal** container image: the web frontend, the Rust server
(`portal-web`) and embedded Tor. The desktop app is not built. The image is what the
Umbrel App Store package runs.

```text
umbrel/
  Dockerfile                Build recipe; the repository root is the build context
  Dockerfile.dockerignore   Keeps node_modules, target, .git and secrets out of the context
  compose.local.yaml        Builds the image and runs it on localhost for a smoke test
```

The Umbrel package itself (`umbrel-app.yml`, `docker-compose.yml`) is not kept here. It lives
in `getumbrel/umbrel-apps` under `portal/`, submitted in
[getumbrel/umbrel-apps#6125](https://github.com/getumbrel/umbrel-apps/pull/6125). Umbrel never
builds this Dockerfile: it pulls the published image named in that package.

## Try it locally

```sh
docker compose -f umbrel/compose.local.yaml up --build
```

Then open <http://localhost:3000>. If port 3000 is taken, set `PORTAL_LOCAL_PORT=3100` for
both the published port and the browser origin. This uses the same `trusted-http-proxy`
profile the Umbrel package runs under, so keep it bound to `127.0.0.1`: its session cookie is
not marked `Secure`.

## Publish a new image

Umbrel requires both `linux/amd64` and `linux/arm64`, pinned by the multi-architecture index
digest. From the repository root:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f umbrel/Dockerfile -t <image>:<version> --push .
docker buildx imagetools inspect <image>:<version>
```

Use the top-level `Digest:` from `inspect`, not a per-architecture one. The image must be
publicly pullable. Use a new tag for every release; never overwrite a published tag.

Then, in the `umbrel-apps` package:

1. Set `image:` in `portal/docker-compose.yml` to `<image>:<version>@sha256:<index digest>`.
2. Bump `version:` in `portal/umbrel-app.yml` to match, and fill `releaseNotes:` for updates.
   Umbrel only offers installed users an update when `version` changes.
3. Run `npm run lint:apps -- portal --check-images` and `git diff --check`.
4. Test through Umbrel (below), then push to the PR branch.

## Test on a local Umbrel

The containerized umbrelOS instance runs under OrbStack as `portal-umbrel-test`:

```sh
open -a OrbStack
docker --context orbstack start portal-umbrel-test
```

Copy the package from the `umbrel-apps` checkout into the instance's app-store source, as
Umbrel's UID/GID 1000:1000 (otherwise Portal cannot write its data directory). `docker cp`
cannot reach the runtime-mounted store path, so use tar:

```sh
COPYFILE_DISABLE=1 tar -C <umbrel-apps checkout> -cf - portal | \
  docker --context orbstack exec --user 1000:1000 -i portal-umbrel-test \
  tar --no-same-owner -xf - -C /home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447
docker --context orbstack exec portal-umbrel-test umbreld client apps.install.mutate --appId portal
```

For an existing install, use `apps.update.mutate` instead, which keeps its data.
`apps.uninstall.mutate` deletes the app's data, wallets included. A store refresh may replace
the copied package; this is a disposable test workflow, not a publication method.

Open Portal from the Umbrel home screen, normally `http://umbrel.local:3101`. Use the device
hostname, not `localhost` or an IP address: Portal accepts requests only from the configured
browser origin. Check the owner password setup, the chain connection, Tor, wallet setup, and
that data survives an app restart.

## Persistent data

`${APP_DATA_DIR}/data/portal` is mounted at `/data` and holds Portal's home directory and
`.openswap` state: wallets, the swap tracker, router state and the owner-password hash. The
image runs as UID/GID 1000:1000 to match Umbrel's data directory ownership. Take service
backups while Portal is stopped; an encrypted wallet export alone is not a full backup.

## References

- [Umbrel packaging requirements](https://github.com/getumbrel/umbrel-apps/blob/master/.claude/skills/umbrel-package-app/SKILL.md)
- [Umbrel testing workflow](https://github.com/getumbrel/umbrel-apps/blob/master/.claude/skills/umbrel-test-app/SKILL.md)
