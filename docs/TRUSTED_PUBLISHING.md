# Trusted publishing

The npm trusted publisher for `@comput/pi-relay` must use:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `mbundgaard` |
| Repository | `pi-relay` |
| Workflow filename | `publish.yml` |
| Environment | blank |

The matching workflow is `.github/workflows/publish.yml`. It uses a GitHub-hosted
Ubuntu runner, Node 24, npm 11, and `id-token: write`. No npm token secret is
required. It runs when a GitHub release is published, verifies that its tag
matches the package version, checks the package, and publishes with provenance.
The network-dependent live tunnel test is not run by this workflow.

## Next release

1. Commit and push the workflow and package preparation changes.
2. Choose an unpublished version (0.1.1 has already been published).
3. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`; run checks.
4. Commit and push those changes.
5. Create a tag matching `v<package-version>` on that commit, and publish its
   GitHub release. For example, version 0.1.2 requires tag `v0.1.2`.
6. Watch the Publish npm package workflow, then verify the npm version and
   provenance. Do not blindly rerun a successful publication; versions are immutable.

The workflow publishes to npm's `latest` tag. Use it for normal releases, not
prereleases requiring a separate distribution tag.

Trusted publishing has not been verified end-to-end until a release succeeds.
If authentication fails, check all npm publisher fields exactly, the npm CLI
version, and the job's OIDC permission. Do not add the exposed token as a fallback.
Revoke that token independently of configuring trusted publishing.
