# Laptop and phone walkthrough — verified pairing

Updated 2026-10-05. This guide targets the **released** `@longleash/cli@0.1.0-rc.16` and the matching LongLeash VS Code extension `0.0.3`. The public app serves build `d3267b7`; check `https://app.longleash.dev/build.json` and `longleash doctor` before testing. The VSIX is an installable prerelease extension, not a verified Marketplace listing. On the owner's laptop both are already installed; reload the VS Code window to activate the companion.

For a click-by-click test sequence and results template, use [the owner field test](OWNER-FIELD-TEST.md). It starts with native VS Code panel discovery, then terminal sessions and LongLeash editor handoff.

## 1. Before installation

- Use macOS or Linux with Node >=22.14 and npm >=10. The release CI covers Node 22/Linux and Node 24/macOS. Windows is not supported by this CLI package.
- Install and sign in to Claude Code and/or Codex independently. Confirm the provider works in a normal terminal first. LongLeash does not provide provider subscriptions. The hook installer enforces its known-working Codex minimum.
- Choose a disposable project for the first test. Only allow folders you intend agents to access; do not select your whole home directory just to make discovery work.
- Keep the laptop awake, connected and its lid open for the test. A sleeping laptop cannot run an agent. The background service survives closing a terminal; it does not defeat laptop sleep.
- Finish/save active work before an intentional daemon update. Updating restarts managed processes; native agent windows must also be restarted to load new hooks.

## 2. Install the approved release on the laptop

For a new laptop, after confirming the live app build:

The `rc` npm tag now resolves to rc.16 with provenance. The owner laptop already has that exact release installed and healthy; start with the version/doctor checks rather than reinstalling.

```sh
node --version
npm --version
npm exec --yes --registry=https://registry.npmjs.org/ --package=@longleash/cli@0.1.0-rc.16 -- longleash setup
```

Choose your allowed project folder, **hosted** connectivity, and the per-user background service. Review the settings before answering yes. Use the scoped `@longleash/cli` package; the unscoped npm name belongs to someone else.

For an existing managed installation, use `longleash update 0.1.0-rc.16` instead. It reuses configuration. Follow the installer's PATH instructions and open a fresh terminal if necessary.

```sh
longleash --version
longleash service status
longleash doctor
```

Expected: correct release version, reachable daemon, `code builds match`, `app builds match`, `pairing verified v2`, and configured hooks for each provider you use. `unknown` is missing evidence, not a pass. These build comparisons become authoritative only for a clean, committed release.

If hooks need attention:

```sh
longleash hooks
```

Then start fresh Claude/Codex windows. In Codex, review the installed hooks and trust your test project when prompted. Configuration checks cannot prove that you accepted provider trust or that an old process reloaded it.

Foreground alternative: stop the background service intentionally, then run `longleash run`. Keep that terminal open. Use one daemon at a time.

## 3. Pair the phone

1. On the iPhone, open Safari at `https://app.longleash.dev` and sign in. Starting signed in avoids spending the QR lifetime on account setup.
2. On the laptop run `longleash pair` in an interactive terminal. Keep the command open.
3. Scan the QR with the phone camera and open the link. Never share a screenshot of this QR or paste it into a support ticket.
4. Compare all eight digits on the phone and laptop. Both must show exactly the same code.
5. Tap **Codes match** on the phone and type **yes** at the laptop prompt. Either order works. The phone waits until both confirm.
6. Expect a paired confirmation and `linked · relay`. The CLI must also confirm completion.
7. If codes differ, choose **They do not match** and decline locally. If you cancel, background the phone too long, lose connectivity or the QR expires, run `longleash pair` again. Do not reuse the old QR.
8. If sign-in lost the pairing link, finish sign-in and scan a fresh QR. If a connection fails after final confirmation, inspect `longleash devices` before retrying; the daemon might have committed a device whose response the phone did not receive.

In foreground `longleash run`, the comparison prompt uses **y + Enter** to confirm and **x + Enter** to reject; **n + Enter** makes a fresh QR. The separate `longleash pair` command requires the full word **yes**.

For home-screen use, use Safari Share → Add to Home Screen, then open that installed copy. If it has a separate browser/account storage context, sign in and pair that copy separately. Enable notifications there when offered. Do not assume Safari's pairing automatically transferred.

## 4. Prove terminal and VS Code discovery first

In the allowlisted disposable project, start one fresh session at a time:

| Agent | Where to start it | Expected phone label |
| --- | --- | --- |
| Claude | ordinary terminal, `claude` | Claude · in a terminal |
| Codex | ordinary terminal, `codex` | Codex · in a terminal |
| Claude | VS Code integrated terminal, `claude` | Claude · in VS Code |
| Codex | VS Code integrated terminal, `codex` | Codex · in VS Code |

Send a unique harmless prompt, such as `Reply exactly TERMINAL CLAUDE CHECK`, using a different phrase for each. Check that each card and transcript appears once. Refresh the phone: the same sessions must return without duplicates.

Test vendor chat panels separately. Their hook support differs; Codex's durable VS Code transcript can provide read-only observation even without a lifecycle/PID hook. **Read-only observation does not grant approval, Stop or takeover authority.** Existing sessions may require a new tool event or restart.

### Install the control extension (0.0.3)

The editor test targets CLI **rc.16**, VSIX **0.0.3**, and live build **d3267b7**. The matching [GitHub release](https://github.com/Sahith59/LongLe-sh/releases/tag/cli-v0.1.0-rc.16) contains the exact CI-tested VSIX and CLI tarball.

1. Download `longleash-vscode-0.0.3.vsix` from the [matching GitHub release](https://github.com/Sahith59/LongLe-sh/releases/tag/cli-v0.1.0-rc.16). A Marketplace listing is not yet verified.
2. In desktop VS Code choose **Extensions → … → Install from VSIX…**, select that file, then **Developer: Reload Window**. Alternatively run `code --install-extension /path/to/longleash-vscode-0.0.3.vsix --force`.
3. Open the allowlisted disposable project as a local folder and grant workspace trust only if you trust that project. Remote/SSH/container/browser workspaces are not supported in this release.
4. Open the LongLeash Activity Bar icon. Confirm the Sessions tree is connected and shows the expected provider conversations. Click a conversation to open its LongLeash editor. Startup registration also runs when the sidebar is hidden.
5. Send five messages in the same native conversation. Check both phone and extension: the conversation stays on one card. Repeat in a second repository and with two different folders sharing the same basename; independent conversations must remain separate.
6. Reload the phone and VS Code. Old suppressed cards must not reappear; no browser-storage reset should be required.

### Prove exact phone ↔ LongLeash editor handoff

1. Start a disposable conversation from the phone. Ask the provider to remember a unique marker, then wait for its reply.
2. On that session's phone screen choose **Open in VS Code**. Choose the target project window. The success message must wait until the LongLeash editor has rendered that exact conversation; merely launching a folder is not success.
3. Read the marker in the editor's existing history. Ask for it again from the editor, then check that the reply appears in the same phone conversation.
4. Keep the phone app visible. In the editor choose **Continue on phone**. The phone must open that same session. The editor reports success only after the visible phone confirms it rendered the session.
5. Repeat in the opposite direction: open the conversation from the Sessions tree first, then continue on the phone and return to the editor. The provider conversation ID and single card stay stable throughout.
6. Trigger a harmless approval and a provider question. Test Allow, Deny and question choices. An unanswered request must survive scrolling through a long history, reload and reconnect. Do not use production files for approval tests.
7. Stop and reopen a disposable session from the editor. A new message should retain earlier context. If a send fails, its draft must remain available.
8. Open a verified external terminal session in the editor. Reading does not transfer ownership. Use **Take control**, read the confirmation, and verify the old writer exits before the first LongLeash message. A transcript-only observed session remains read-only until the provider supplies verified control evidence.
9. Close the chosen VS Code window while the phone is opening it. Expect an unavailable/unconfirmed result, never a false success or another provider process. Disconnect the laptop, reconnect, and repeat once; an uncertain mutation must not be blindly sent again.
10. Repeat for Claude and Codex. This targets the **LongLeash conversation editor inside VS Code**, not the private Claude or Codex vendor chat panel. The existing exact Terminal resume command remains available separately.

## 5. Exercise normal work from the phone

1. Tap **New session**, select Claude or Codex, choose the test folder and ask for a short reply. Read the response and send a second message in the same conversation.
2. In a fresh laptop session using normal provider approval settings, ask it to write a harmless marker file outside its automatically allowed scope. Follow the exact prompts in [release acceptance](ACCEPTANCE.md). Do not weaken provider permissions to force a pass.
3. Approve once from the phone; confirm the file exists. Repeat with Deny and confirm that file was not created. The phone approval must disappear after either decision.
4. Trigger another approval and use the documented **L** laptop handoff. Confirm the native prompt returns and the phone's stale request disappears.
5. Start a disposable long-running operation, then Stop. A terminal-origin stop may end that local provider process; read the confirmation. Do not test Stop on valuable ongoing work.
6. Reopen a finished disposable conversation and confirm its previous context is retained.
7. Switch the phone from Wi-Fi to cellular. The laptop stays online; expect relay reconnection and a current session list with no duplicated decisions.
8. Lock/background the phone, trigger a new approval, reopen it and verify the current state. Test notification deep links separately in the installed PWA.
9. For simultaneous work in the same repository, use **Safe parallel**. Check separate worktrees before allowing two agents to edit.

Run the complete [acceptance checklist](ACCEPTANCE.md) for release sign-off, including handoff, delegation/settings, notification links, stale decisions and both providers.

## 6. When something is missing

| Symptom | Check / recovery |
| --- | --- |
| No sessions anywhere | `longleash service status`, then `longleash doctor`; check allowed project root and provider hooks |
| Only old sessions missing | Restart that provider window after installing hooks; send one new prompt/tool event |
| Wrong VS Code label | Test a fresh integrated-terminal process; record agent, terminal vs vendor panel and exact time |
| Codex hook configured but silent | Check Codex hook review and project trust; configuration alone cannot prove either |
| Phone UI differs from laptop version | Resolve doctor build mismatch; update/reload the phone app, then confirm the live build again |
| Update succeeded but service is unreachable | Run `longleash service status` and `longleash doctor --json`. An old macOS daemon may survive launchd bootout and keep the listener port; see the exact-process recovery note below. |
| Read-only card | Observation has no verified process-control authority; use a freshly hooked provider session for control |
| Pairing expired/disconnected | Create a fresh QR; compare both devices again |
| Lost final pairing response | `longleash devices`; revoke an unintended device with `longleash revoke DEVICE_ID`, then pair again |
| Laptop unreachable on cellular | Confirm hosted connectivity, laptop internet and awake state; LAN-only does not work away from that network |

Before restarting to diagnose a failure, capture `longleash doctor --json`, the exact time, agent, origin and redacted screenshot. `longleash service logs` shows persistent service diagnostics. Never include QR URLs, hook endpoint secrets, tokens or private source/transcripts in a report.

**Managed macOS recovery:** rc.15 handles asynchronous launchd shutdown using the former managed supervisor identity, then checks the new build and manager PID. The owner's rc.14 → rc.15 setup completed successfully on its first attempt. If an older release's setup reports an unreachable service, capture diagnostics, run `longleash service start`, then `longleash doctor`. If it still fails, investigate the exact process; never kill Claude/Codex by title. The earlier rc.13 → rc.14 failure and verified correction are recorded in [service lifecycle evidence](D-SERVICE-LIFECYCLE-2026-10.md).

## 7. Completion evidence

Record phone model/iOS, laptop OS, CLI version, deployed build, network, provider versions and pass/fail for each checklist item. Workstream D closes only after candidate CI/install checks and the physical-device/production acceptance matrix have evidence. A browser simulation or passing unit suite cannot fill in those results.
