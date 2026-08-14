# Phase 2A / V0 — contract and security evidence

**Status:** V0 complete on 2026-08-12. The extension-host and bounded-provider matrix passed for
the trust boundary and Codex read path. Claude's documented native URI failed exact-history
verification on the tested build, so that capability is intentionally disabled and falls back to
an exact copyable Terminal/`--ide` resume command.

**Baseline:** LongLeash `86666bb`, evaluated 2026-08-12

This record separates facts established by public contracts, extension-host tests, and bounded
disposable provider probes. No production conversation or project was mutated for this matrix.

## Evidence sources

- Anthropic documents the VS Code handler, focused-window behavior, `session` parameter,
  already-open focus behavior, and the dangerous missing-session fallback in
  [Use Claude Code in VS Code](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools).
- OpenAI documents app-server as the rich-client interface, its stable stdio transport,
  initialization handshake, `thread/read`, `thread/resume`, streamed events, and approvals in
  [Codex app-server](https://learn.chatgpt.com/docs/app-server).
- VS Code documents encrypted, machine-local `SecretStorage` in the
  [VS Code API](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), partial
  Restricted Mode support in the
  [Workspace Trust extension guide](https://code.visualstudio.com/api/extension-guides/workspace-trust),
  and real extension-host testing in
  [Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension).

The reproducible read-only probe is:

```sh
pnpm --dir packages/vscode probe:v0
```

It starts no agent, opens no editor, reads no transcript, and emits no workspace path. On the
baseline machine it established:

| Capability | Observed evidence |
| --- | --- |
| VS Code | `1.131.0` |
| Claude extension | `2.1.229` |
| Claude CLI | `2.1.227` |
| Codex extension | `26.803.61601` (diagnostic only; not an integration dependency) |
| Codex CLI | `0.147.0` |
| Codex generated protocol | `initialize`, `thread/read`, `thread/resume`, `turn/start`, and the documented thread status family are present |

## Finding 1 — Claude's public URI is documented but unverified on the tested build

Anthropic's public handler is:

```text
vscode://anthropic.claude-code/open?session=<native-session-id>
```

Its contract has two consequences that the product must show honestly:

1. The handler opens in the currently focused VS Code window, and the session must belong to that
   window's workspace.
2. If the session is not found, Claude opens a fresh conversation. The URI returns no provider
   callback proving that the requested history rendered.

The live matrix created one disposable no-tools Claude conversation, opened its exact workspace,
and invoked the documented URI twice against Claude extension `2.1.229`. The Claude panel opened,
but it did not render the requested history. The screenshot also contained an unrelated local
draft, so the raw image is deliberately not retained in the repository or support artifacts.

LongLeash therefore does not dispatch this URI merely because a compatible extension is installed.
The build must also appear in a compatibility ledger backed by a passing exact-history matrix. No
Claude build currently has that capability. A valid request fails with
`provider-contract-unverified`; a missing or stale durable record still fails earlier with
`native-session-unverified`. The user receives the exact Terminal/`--ide` resume fallback instead
of a blank or wrong native chat.

The result vocabulary is deliberately asymmetric:

- Claude: `blocked` + `provider-contract-unverified` on the tested build
- Codex LongLeash editor: `opened` + `extension-owned`

The wire schema rejects a Claude result that claims `opened`. This keeps a successful operating
system dispatch from being reported as proof of an exact native conversation.

### Claude matrix result

| Case | Evidence | V0 result |
| --- | --- | --- |
| Same window | Real VS Code `1.131.0` host, installed Claude extension, canonical disposable root | Host boundary passed; native exact-history check failed closed |
| Multiple windows | Two simultaneous hosts observed one focused and one non-focused window | Passed; no native dispatch is allowed |
| Multi-root | Real `.code-workspace` with two roots | Passed containment and redaction |
| Worktree | Real Git worktree fixture | Passed canonical targeting |
| Missing session | Stale/unverified durable record | Blocked before URI construction |
| Already open | The same disposable URI was invoked twice | Requested history was not rendered; capability remains disabled |

Release copy must not say Claude native-panel continuation is supported until a later provider
build passes this same exact-history gate.

## Finding 2 — Codex keeps one app-server owner

OpenAI documents `thread/read` as reading stored thread data without resuming the thread, while
`thread/resume` loads it for later turns. The generated protocol for installed Codex `0.147.0`
confirms both methods and exposes `notLoaded`, `idle`, `active`, and `systemError` status.

LongLeash nevertheless does not give every VS Code window a direct app-server connection. The
daemon is the only app-server client and the only component allowed to send `turn/start`, answer an
approval, interrupt a turn, or resume a managed thread. Companion windows render the daemon's
cursor-addressed LongLeash mirror. Multiple read-only UI windows therefore do not become multiple
Codex writers.

The contract refuses a Codex editor when:

- the snapshot is absent or names another thread;
- it did not come from the daemon mirror;
- the daemon is not the app-server owner;
- the canonical workspace is different, untrusted, or remote in the V0 support tier.

A read-only editor may coexist with the daemon writer. A writable editor is exposed only after the
daemon issues an `ide-reserved` ownership instruction.

The bounded live probe created one disposable Codex turn, initialized one stdio app-server client,
called `thread/read(includeTurns: true)`, and observed the exact expected transcript. The thread
reported `notLoaded` before and after the read; `thread/loaded/list` never contained it, and the
probe sent zero mutation methods. Two simultaneous extension hosts independently accepted only a
read-only daemon-mirror plan while the external mutation sentinel remained unchanged.

## Companion authentication and revocation contract

The V1 transport will use a user-owned local socket: a Unix-domain socket inside the `0700`
LongLeash data directory on macOS/Linux, and a per-user named pipe when Windows support is enabled.
The ordinary LAN/relay phone socket is not reused.

Registration and connection rules:

1. `longleash vscode install` creates a 256-bit, single-use bootstrap secret in a `0600` local
   file with a ten-minute expiry. It is never placed in a URI, command argument, workspace setting,
   relay frame, or log.
2. The newly installed local extension reads that bootstrap only during explicit registration and
   exchanges it over the user-owned socket.
3. The daemon consumes the bootstrap once and issues a separate 256-bit companion credential. It
   stores only a high-entropy token hash and principal metadata.
4. VS Code stores the credential in `ExtensionContext.secrets`, not workspace/global state or a
   project file. It is not synchronized to another machine.
5. Every extension-host window authenticates as that principal and sends a fresh window instance
   ID, its protocol range, build, workspace roots, focus/trust state, and requested capabilities.
6. The daemon grants the intersection only. Revocation closes every connection for that principal
   immediately. Reinstallation or rotation never revives an old credential.

Threat boundary: software already running as the same operating-system user can read the user's
developer files and is outside the protection a local companion can provide. Malicious workspace
content, relay participants, browser pages, stolen phone tokens, stale extension builds, replayed
operations, and another local account remain inside the fail-closed threat model.

## Capability, operation, and audit contract

Capabilities are explicit strings. There is no generic RPC or shell capability. An unknown
capability is rejected by schema validation and never inferred from a version number.

Build/protocol behavior:

- no protocol-range intersection: close without session data;
- revoked credential: close immediately;
- build mismatch: authenticated session/transcript reads may remain, but all mutations are removed;
- untrusted workspace: diagnostics only;
- compatible and trusted: grant only the server/client/credential intersection.

Every daemon-to-window operation carries an unguessable operation ID, issue time, short expiry,
provider, LongLeash session ID, native ID, canonical workspace, verified native-record evidence,
destination kind, and ownership state. Duplicate operation IDs replay the durable result; they do
not repeat the action.

The local audit records request, dispatch, result, principal, provider, LongLeash session ID,
destination, timestamps, and machine-readable outcome. It never stores prompts, transcript text,
tool input, native provider IDs, credentials, or URI query strings. Support exports hash local
identifiers unless the user explicitly includes them.

## Workspace trust and logging contract

The extension declares `untrustedWorkspaces.supported: "limited"`. In Restricted Mode it exposes
only safe compatibility diagnostics. Transcript reads, provider dispatch, file/workspace
navigation, approvals, messages, Stop, Delegate, and Return remain unavailable even if a command
is invoked directly rather than through visible UI.

Remote extension hosts are explicitly unsupported in V0. The companion runs as a UI extension so
a remote workspace cannot silently turn `localhost` into the wrong machine. A future remote tier
requires its own authenticated routing and threat review.

Diagnostics are assembled from an allowlist rather than redacting arbitrary strings afterward.
The V0 report includes versions, build, trust/focus booleans, remote presence, provider-extension
presence, the exact-build Claude native-dispatch compatibility decision, and workspace-folder
count. It excludes paths, prompts, native IDs, tokens, URLs, query strings, raw errors, environment
variables, and workspace settings. Tests inject those values and verify they cannot cross the
serializer.

## Conservative support floors

| Component | V0 floor | Policy |
| --- | --- | --- |
| VS Code | `1.94.0` | Official Claude prerequisite and extension manifest floor |
| Claude VS Code extension | `2.1.229` diagnostics only | Exact-session URI failed the live history check; no build is dispatch-enabled |
| Codex CLI/app-server | `0.147.0` | First generated-schema baseline; runtime method probing still wins over version guessing |
| Codex VS Code extension | None | LongLeash does not call or inspect its private panel |

## Automated gates implemented in V0

- strict companion hello, capability, operation, destination, and result schemas;
- protocol incompatibility, revoked credential, untrusted workspace, and build-skew reduction;
- Claude expiry, focus, trust, remote, provider version, workspace containment, recent native
  record, ownership, and URI-injection checks;
- Codex exact-thread, daemon-mirror, ownership, workspace, read-only, and writable checks;
- safe diagnostics with hostile extra fields and secret-looking version labels;
- buildable VS Code UI extension with commands that show/copy only the safe diagnostic report;
- reproducible installed-capability probe with no agent/editor/transcript side effects.

The pre-live clean repository gate on 2026-08-12 was 765 automated tests: 54 protocol, 31 relay,
128 phone app, 531 daemon, and 21 companion tests. The live work added a real extension-host suite
and a Codex read-only probe; the final post-change repository gate is recorded in the completion
handoff rather than being implied by the earlier total.

## V0 live evidence and commands

The reproducible extension-host gate is:

```sh
pnpm --dir packages/vscode test:host:v0
```

The Codex read probe intentionally requires an explicitly created disposable thread and never
stores or prints its raw ID:

```sh
LONGLEASH_CODEX_THREAD_ID="<disposable-id>" pnpm --dir packages/vscode probe:live:codex-read
```

V0 exits with one supported exact read path (Codex), one explicitly unsupported native path
(Claude URI), a tested Terminal fallback requirement, and a fail-closed compatibility ledger.

The first V1 distribution gate packages this foundation as a locally installable VSIX, verifies its
identity and file allowlist, records its SHA-256, and exercises the install/update command in dry-run
mode. The artifact is unsigned and not yet a public release; signing, rollout, and rollback remain
Phase V5 gates.
