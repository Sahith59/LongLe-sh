# Owner field test — rc.17 / VS Code 0.0.3

Use this in order. Do not mark an untested step as passed. Current deployed build: `e4d827d`.
The laptop CLI and extension are already installed. These are manual acceptance instructions, not a claim that the phone tests have passed.

## Retest the missing-message report first

Before starting any new test conversations:

1. Keep the existing Test-A native Codex conversation open on the laptop.
2. Refresh the phone app and accept **Update** if offered. Reopen it if installed on the Home Screen.
3. Open the same “sample test files” conversation. Existing user and assistant messages must appear.
4. Send one more message from that same native Codex panel. Confirm the response appears in the same phone card.
5. Do not clear browser storage, delete the chat, or pair again. If history is still empty, record the time and send a screenshot.

Read-only observation limits sending/stopping; it must still show saved conversation content. Messages written while the daemon is stopped are a separate open recovery limitation; keep the service running for this acceptance test.

## What each component does

- The laptop daemon discovers supported Claude/Codex sessions using hooks and transcripts, keeps conversation identity stable, and serves the paired phone.
- The LongLeash extension connects the current trusted local VS Code workspace to that daemon and provides the Sessions tree and LongLeash conversation editor.
- The phone displays the daemon's inventory. An extension installation alone cannot expose every private vendor-panel API or make an unsupported session controllable.

The primary test is your actual Claude/Codex vendor chat panel appearing once on the phone and updating across multiple turns. A successful LongLeash-editor test does not substitute for it. Read-only can be expected for observed-only sessions; missing, stale or duplicate conversation cards are failures to record.

## A. Prepare the laptop

1. Save your work. Keep the laptop awake, with its lid open and internet connected.
2. In macOS Terminal run:

   ```sh
   longleash --version
   longleash service status
   longleash doctor
   ```

   Expect `0.1.0-rc.17`, active/healthy service, reachable daemon, both build comparisons `match`, pairing `verified v2`, and provider hooks configured. If the service is stopped, run `longleash service start` and repeat doctor. Stop here if health/build checks still fail.
3. Prepare two harmless projects:

   ```sh
   mkdir -p ~/LongLeash-Test-A ~/LongLeash-Test-B
   git -C ~/LongLeash-Test-A init
   git -C ~/LongLeash-Test-B init
   code -n ~/LongLeash-Test-A
   ```

   These folders must be within the daemon's configured allowed roots. If not, choose two disposable folders within your allowed project directory; do not widen access to your whole home just for this test.
4. In VS Code press Cmd+Shift+X, search installed extensions for LongLeash, and confirm version0.0.3 is enabled. It is installed from VSIX; a Marketplace search is not the installation check.
5. Cmd+Shift+P → `Developer: Reload Window`. Trust the test folder if prompted. Use a local desktop window, not SSH/dev-container/browser VS Code.
6. Open the LongLeash icon in the left Activity Bar. If missing, use Cmd+Shift+P → `LongLeash: Show Connection Diagnostics`. Check connectivity and workspace scope. An empty tree before creating a session is not itself a failure.
7. Start fresh provider sessions after the reload. Accept Codex's hook-review and workspace-trust prompts. Do not reuse a process started before hook installation.

## B. Connect the phone

1. Use Safari for this first pass. Open https://app.longleash.dev and sign in. Refresh/accept any offered app update.
2. If this Safari instance is already linked to this laptop, use that connection. Do not pair repeatedly just because old cards exist.
3. Otherwise run `longleash pair` in laptop Terminal. Scan the fresh QR, open the link, compare all eight digits, tap **Codes match** on the phone and type **yes** + Enter on the laptop.
4. Require confirmation on both devices and a linked state. Hosted connectivity normally shows `linked · relay`.
5. Keep Safari visible during the first tests. Do not clear browser storage or delete existing history to make a duplicate test pass.

## C. Native VS Code panel discovery — test first

1. In Test-A open the actual **Claude Code extension panel**, then create one new conversation. This is different from VS Code's integrated terminal and the LongLeash editor.
2. Send:

   ```text
   Remember the marker LL-A-CLAUDE-01 for this conversation. Reply with it. Do not edit files.
   ```

3. On the phone locate the new Claude conversation for Test-A. Open it and confirm the marker/reply. Check the LongLeash Sessions tree too.
4. In that same Claude chat send four separate messages, waiting for each reply:

   ```text
   What marker did I give you?
   Reply exactly TURN THREE.
   Reply exactly TURN FOUR.
   Reply exactly TURN FIVE.
   ```

5. After each reply check the same phone conversation. Require fresh content without a new card per message. Note any delay; if nothing appears after roughly15seconds, record the time and refresh once. This is a diagnostic checkpoint, not a guaranteed latency SLA.
6. Refresh Safari once and reload the VS Code window. Require the same conversation/history with no resurrected duplicate cards.
7. Repeat with the **Codex extension panel**, using `LL-A-CODEX-01`. Record discovery/update separately from available controls. A read-only session is not a successful phone-control test.
8. Open Test-B in another VS Code window and repeat both providers. Test-A and Test-B must remain separate.
9. Finally create two independent chats with the same provider in Test-A. Both should have separate cards. “One per conversation” does not mean “one per repository.”

## D. Terminal discovery

Repeat the marker + five-turn test for each row. Start only one new session at a time so you can identify it.

| Surface | Command | Marker |
| --- | --- | --- |
| macOS Terminal in Test-A | `claude` | LL-TERMINAL-CLAUDE |
| macOS Terminal in Test-A | `codex` | LL-TERMINAL-CODEX |
| VS Code → Terminal → New Terminal in Test-A | `claude` | LL-VSC-TERM-CLAUDE |
| VS Code → Terminal → New Terminal in Test-A | `codex` | LL-VSC-TERM-CODEX |

Use `cd ~/LongLeash-Test-A` first. Expect correct provider, project and origin, current content, one card per conversation, and persistence after refresh.

## E. Exact phone ↔ LongLeash editor continuation

1. On the phone choose **New session**, Claude, and Test-A. Send `Remember LL-HANDOFF-CLAUDE. Reply with it.` Wait for the reply.
2. Choose **Open in VS Code**, then the Test-A window. Require the existing conversation to appear in the **LongLeash editor** and a confirmed success. Opening a folder alone is not enough.
3. From that editor send `What marker did I give you?` Verify the same history and reply on the phone, with no extra conversation card.
4. Keep the phone app visible, switch it to its session list, then click **Continue on phone** in the editor. Require the exact conversation to open on the phone before success is reported in VS Code.
5. Repeat in reverse order, starting by opening the conversation from the extension Sessions tree. Repeat the full flow with Codex and marker `LL-HANDOFF-CODEX`.
6. Reading an external session does not transfer ownership. On a disposable verified external session, exercise **Take control** separately and follow its confirmation. The old writer must stop before LongLeash sends; do not continue typing in the old vendor panel afterward. Observed-only sessions must stay read-only.

This test does not reopen the private Claude/Codex vendor panel. That is a separate, unsupported destination where an exact API has not been verified.

## F. Approvals, stop and recovery

1. In a disposable controllable session request:

   ```text
   Run printf LL_APPROVED > /tmp/longleash-approval-test.txt using the shell. Do not use another tool.
   ```

2. If an approval is requested, approve from the phone, then verify with `cat /tmp/longleash-approval-test.txt`. Repeat with a different filename and Deny; that new file must not exist. Do not weaken permissions to manufacture a prompt. If provider policy auto-approves, record “no prompt”; it is not an approval pass.
3. Repeat a pending approval in the LongLeash editor. Decide on one device only and confirm the other clears the request. Repeat a provider question when one is genuinely offered; reload while pending and verify current choices survive.
4. On a phone-started test session request `Run sleep 60 in the shell and wait for it.` Approve if needed, then **Stop** while running. Require it to stop. **Reopen**, ask for the earlier marker, and confirm retained context.
5. Turn phone Wi-Fi off while keeping laptop online. On cellular require reconnect, current history and one new reply in the same conversation.
6. Lock the phone for a minute, send another laptop message, then unlock. Require current content without duplicates. Test notifications separately in the home-screen PWA; Safari and the installed copy may need separate pairing.
7. Close a target VS Code window during handoff. Require unavailable/unconfirmed feedback, not false success. Reopen it and retry.

## G. Report results

On failure, stop that scenario and capture it before restarting/clearing anything. Other independent scenarios can continue. Use:

```text
Phone model / iOS:
Test section and step:
Provider and surface: Claude/Codex; native panel/integrated terminal/Terminal/LongLeash editor
Project: Test-A or Test-B
Expected:
Actually happened:
Time and network:
Extra cards after five turns:
Fresh content without manual refresh: yes/no
Read-only or controllable:
Screenshot attached: yes/no
```

For connection failures include `longleash doctor` output and LongLeash's connection diagnostics. Redact private transcript content and never send QR URLs, tokens or endpoint secrets.

Report C and D first: native panel and terminal discovery/currentness are the user's primary requirement. Then report E and F. Do not close Workstream D from editor tests alone.
