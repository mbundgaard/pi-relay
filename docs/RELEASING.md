# Packaging and releases

## Package format

This is a Pi extension package, not a standalone CLI. Pi loads `src/index.ts`
through the `pi.extensions` manifest. No compiled bundle is required.
Host-provided Pi and TypeBox packages remain peer dependencies; `cloudflared`
is a runtime dependency. The explicit `files` allowlist excludes tests,
local state, and development-only files from the tarball.

## Current release gates

- The package is configured for public publication; publish only with explicit approval.
- The selected npm name is `@comput/pi-relay`. Confirm publishing rights and
  version availability before release.
- The owner approved MIT; `LICENSE` is included in the package.
- The repeated stale-peer DNS error remains unfixed in the 0.1.1 prototype.
  Fix and regression-test it before a stable release; see [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
- Review the security limitations in [../SECURITY.md](../SECURITY.md).
- Verify supported Pi/Node versions and operating systems; do not claim an
  untested compatibility range.

## Local verification

```sh
npm ci
npm run check
npm run pack:check
npm pack
```

`prepack` runs the TypeScript check. `npm pack` produces a local `.tgz`. Inspect its file list for unintended content.
Do not commit the tarball.

The integration test is explicitly opt-in:

```sh
npm run test:live
```

It starts two isolated relays with real public tunnels, requires internet
access, and may download the Cloudflare binary. It is not a prepack hook.

Before publishing, extract the tarball into a temporary directory, install
its dependencies, and load that directory with `pi -e <directory>` in a
separate Pi session. Verify loading alone opens no tunnel, then test pairing,
bidirectional messaging, stale-peer failure handling, and shutdown. Avoid
running two relays against the same state directory; use `PI_RELAY_STATE_DIR`
for isolation.

## Trusted publishing (preferred)

See [TRUSTED_PUBLISHING.md](TRUSTED_PUBLISHING.md) for the token-free GitHub
release workflow. Version 0.1.1 is already published; use a new version for
the next release.

## Manual publish (maintainer action only)

1. Resolve all release gates, including package ownership and license.
2. Set the final package name/version and update the changelog.
3. Verify public publication is approved and the version is not already published.
4. Run `npm install --package-lock-only` to synchronize the lockfile.
5. Re-run verification and inspect `npm pack --dry-run`.
6. Confirm npm login, registry, and publishing permissions locally.
7. Run `npm publish --access public` only with explicit release approval.
8. Verify installation with `pi install npm:<final-package-name>` in a clean
   environment, then tag the release and publish release notes.

Never place npm credentials in repository files, chat, or release notes.
