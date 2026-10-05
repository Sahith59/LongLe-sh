# Laptop and phone walkthrough — verified pairing

Updated 2026-10-05. This guide targets `@longleash/cli@0.1.0-rc.13` and the matching LongLeash VS Code companion `0.0.2`. **Check release status before following it:** the CLI must be published at that exact version and `https://app.longleash.dev/build.json` must match the release commit. The VSIX is an owner preview, not a Marketplace listing.

## 1. Before installation

- Use macOS or Linux with Node >=22.14 and npm >=10. The release CI covers Node 22/Linux and Node 24/macOS. Windows is not supported by this CLI package.
- Install and sign in to Claude Code and/or Codex independently. Confirm the provider works in a normal terminal first. LongLeash does not provide provider subscriptions. The hook installer enforces its known-working Codex minimum.
- Choose a disposable project for the first test. Only allow folders you intend agents to access; do not select your whole home directory just to make discovery work.
- Keep the laptop awake, connected and its lid open for the test. A sleeping laptop cannot run an agent. The background service survives closing a terminal; it does not defeat laptop sleep.
- Finish/save active work before an intentional daemon update. Updating restarts managed processes; native agent windows must also be restarted to load new hooks.

## 2. Install the approved release on the laptop

After rc.13 is confirmed published and the app build verified:

```sh
node --version
npm --version
npm exec --yes --registry=https://registry.npmjs.org/ --package=@longleash/cli@0.1.0-rc.13 -- longleash setup
```

Choose your allowed project folder, **hosted** connectivity, and the per-user background service. Review the settings before answering yes. Use the scoped `@longleash/cli` package; the unscoped npm name belongs to someone else.

For an existing managed installation, use `longleash update 0.1.0-rc.13` instead. It reuses configuration. Follow the installer's PATH instructions and open a fresh terminal if necessary.

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

For the owner preview, download `longleash-vscode-0.0.2.vsix` from the rc.13 GitHub release and install it in VS Code using **Extensions → … → Install from VSIX…**. Reload the window, open the allowlisted test project, and select the LongLeash Activity Bar icon. Its **Sessions** tree should show one live card per native conversation after a real prompt and should update within a few seconds. A transient Claude lifecycle ID with no matching transcript should not appear. Refresh or reload the phone once after updating the daemon to clear historical empty cards.

The companion tree is read-only. It does not send messages, approve, Stop, or perform exact phone ↔ IDE handoff yet. For this preview, test the existing explicit terminal/VS Code integrated-terminal transfer controls separately. Do not treat a vendor chat panel as handed off until a later exact-open acknowledgement exists.

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
| Read-only card | Observation has no verified process-control authority; use a freshly hooked provider session for control |
| Pairing expired/disconnected | Create a fresh QR; compare both devices again |
| Lost final pairing response | `longleash devices`; revoke an unintended device with `longleash revoke DEVICE_ID`, then pair again |
| Laptop unreachable on cellular | Confirm hosted connectivity, laptop internet and awake state; LAN-only does not work away from that network |

Before restarting to diagnose a failure, capture `longleash doctor --json`, the exact time, agent, origin and redacted screenshot. `longleash service logs` shows persistent service diagnostics. Never include QR URLs, hook endpoint secrets, tokens or private source/transcripts in a report.

## 7. Completion evidence

Record phone model/iOS, laptop OS, CLI version, deployed build, network, provider versions and pass/fail for each checklist item. Workstream D closes only after candidate CI/install checks and the physical-device/production acceptance matrix have evidence. A browser simulation or passing unit suite cannot fill in those results.
