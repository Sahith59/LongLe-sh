# @longleash/cli

LongLeash keeps Claude Code and Codex running on your laptop while you review, reply, approve, and
stop work from your phone. Repositories, provider credentials, agent processes, transcripts, and
durable audit data remain on the laptop.

This package supports macOS and Linux with Node.js 22.14 or newer.

## Release-candidate setup

```sh
npx --registry=https://registry.npmjs.org/ @longleash/cli@rc setup
```

Setup shows the exact folders agents may use and the selected connectivity mode before it changes
configuration. It installs the verified package into a versioned directory owned by your user,
creates `~/.local/bin/longleash`, and connects only the provider hooks you approve. It does not use
`sudo`, start a root service, clone a mutable Git branch, or start LongLeash automatically.

If `~/.local/bin` is not already on your shell path, setup prints the exact profile line and the
absolute executable path. It never edits a shell startup file without asking.

```sh
longleash --help
longleash doctor
longleash run ~/code
```

Setup recommends a per-user background service, so the setup terminal may close after installation.
Use `longleash service status` to verify it, and `longleash pair` to print a fresh QR. Explicit
`longleash run` remains available for foreground diagnosis and requires that terminal to stay open.
See the [first-party setup guide](https://longleash.dev/docs/getting-started),
[background-service guide](https://longleash.dev/docs/background-service), and
[connectivity comparison](https://longleash.dev/docs/connectivity) before pairing.

## Security notes

- Pairing URLs are single-use secrets. Do not paste them into issues, chat, or screenshots.
- Setup defaults to the current directory, never the entire filesystem.
- Updates are staged and verified before the active version changes.
- Uninstall removes the managed executable and hooks but preserves devices, settings, and audit data.
- npm provenance is required for public releases from the official repository workflow.

LongLeash is licensed under the MIT License.
