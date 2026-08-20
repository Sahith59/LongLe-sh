# npm release procedure

The public CLI package is `@longleash/cli`. The unscoped `longleash` name belongs to a different
maintainer and must never appear in a LongLeash install command.

Release lockfile generation and validation use npm `11.12.1`. User installations remain compatible
with the broader npm range declared by the package; pinning the release tool prevents different npm
versions from rewriting platform metadata in an otherwise identical dependency graph.

During prerelease testing, use
`npm exec --yes --registry=https://registry.npmjs.org/ --package=@longleash/cli@rc -- longleash setup`.
The public website must not use `@latest` until a stable version has passed the complete release
matrix and the `latest` dist-tag points to it.

This procedure deliberately separates building a release candidate from making it public. Running
the verification commands below does not publish anything.

## Security boundary

- npm organization: `@longleash`
- required maintainer control: account 2FA enabled
- required public repository: `Sahith59/LongLe-sh`
- trusted workflow: `.github/workflows/publish-cli.yml`
- GitHub environment: `npm-production`
- workflow permission: `contents: read` plus `id-token: write` only in the publish job
- prohibited: npm automation tokens, install-time scripts in this package, mutable Git clones, or
  publishing from an uncommitted local tree

Runtime dependency versions are exact, and the published npm shrinkwrap pins their transitive
closure. The tarball has an explicit file allowlist and is rejected if
it contains environment files, databases, logs, keys, tests, source maps, or an unexpected path.

## Build a local candidate without publishing

```sh
pnpm install --frozen-lockfile
pnpm --filter @longleash/cli typecheck
pnpm --filter @longleash/cli test
pnpm --filter @longleash/cli shrinkwrap:check
pnpm --filter @longleash/cli build
pnpm --filter @longleash/cli pack:verify
node packages/cli/scripts/smoke-tarball.mjs packages/cli/dist-pack/*.tgz
```

The last command installs the real tarball under a temporary HOME and exercises setup twice,
doctor, the managed wrapper, and uninstall. It does not start the daemon or touch the operator's
real configuration.

## Bootstrap the first package once

npm cannot attach a trusted publisher until the package exists. For the first release candidate
only, the organization owner must publish interactively from a clean, already-pushed commit and
complete the npm 2FA prompt. Do **not** create or push a `cli-v*` tag for this bootstrap version:
that tag is reserved for the trusted workflow, which cannot authenticate until the package exists.

The package manifest intentionally requires provenance for normal releases. A local terminal is not
a supported provenance provider, so the one bootstrap publish explicitly disables provenance. The
next release candidate must come from the trusted GitHub workflow and is the first release allowed
to claim provenance.

```sh
git status --short --untracked-files=no
git diff --quiet
git diff --cached --quiet
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
pnpm --filter @longleash/cli build
pnpm --filter @longleash/cli pack:verify
node packages/cli/scripts/smoke-tarball.mjs packages/cli/dist-pack/*.tgz
npm publish --provenance=false packages/cli/dist-pack/longleash-cli-0.1.0-rc.1.tgz --access public --tag rc
```

Replace the tarball filename with the exact version being bootstrapped. Never publish the package
directory after verifying a tarball; that would rebuild and publish different bytes.

npm may create `latest` automatically on the package's first publication even when `--tag rc` was
supplied. Verify the tags immediately and attempt to remove that premature stable promise with
fresh 2FA:

```sh
npm view @longleash/cli dist-tags --json
npm dist-tag rm @longleash/cli latest
```

The public registry can reject removal of `latest` with HTTP 400 while the prerelease is the
package's only published version. Authentication may still have completed successfully; verify the
registry response rather than repeatedly authenticating. If removal is rejected, keep every public
install command pinned to `@rc`, record the exception in the release evidence, and move `latest` to
the first fully verified stable version. The rejected removal does not change or republish the
tarball. Escalate to npm support if the stable release is not ready and an untagged install must be
disabled sooner.

Do not paste an OTP into a command argument, chat, issue, environment file, or repository secret.
Enter it only into npm's interactive prompt.

The two commit hashes printed above must match. Immediately after the first package exists:

1. Open `@longleash/cli` on npm and configure a GitHub Actions trusted publisher.
2. Set organization/repository to `Sahith59/LongLe-sh` and workflow filename to
   `publish-cli.yml`.
3. Confirm no npm token exists in the repository, organization, or `npm-production` environment.
4. Protect the GitHub `npm-production` environment and `cli-v*` tags according to repository policy.
5. Publish a new version through the trusted workflow and verify its provenance on npm.
6. Only after that proof succeeds, require 2FA and disallow traditional tokens in package publishing
   access. This avoids locking the maintainer out because of a mistyped publisher configuration.

Every later release is tag-driven and tokenless. The publish job downloads the exact tarball from
the completed clean-machine job; it does not rebuild different bytes after verification:

```sh
git tag --annotate cli-v0.1.0-rc.6 --message "Release @longleash/cli 0.1.0-rc.6"
git push origin cli-v0.1.0-rc.6
```

The tag must exactly match `packages/cli/package.json`. A prerelease publishes under the `rc`
dist-tag. A stable version publishes under `latest`. Trusted publishing supplies short-lived OIDC
credentials and npm generates provenance for the public package.

## Rollback

npm versions are immutable. Never overwrite or unpublish a version used by someone else.

1. Deprecate the bad version with a precise reason.
2. Move `latest` or `rc` back to the last verified version.
3. Publish a fixed new version.
4. Verify a clean tarball install on macOS and Linux again.

Users can move to an exact prior version with:

```sh
longleash update 0.1.0
```

The CLI stages and verifies that version before changing the active `current` symlink.
