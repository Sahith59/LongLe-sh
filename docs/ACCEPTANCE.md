# LongLeash release acceptance

Use this checklist after every release. It deliberately exercises the real phone, the real
Claude and Codex processes, terminal and VS Code discovery, notifications, approvals, stopping,
completion, and stale-state cleanup. A green unit test is not a substitute for this pass.

## Before testing

1. On the laptop, run:

   ```sh
   longleash doctor
   ```

   Do not continue unless:

   - the daemon is reachable;
   - `code builds` says `match`;
   - `app builds` says `match`;
   - both Claude Code and Codex say `hook installed for this build`.

2. Open <https://app.longleash.dev> on the phone and sign in. If LongLeash is installed
   to the home screen, open that copy and pull down to refresh. Accept an offered **Update**.
3. Confirm the top bar says `linked · relay` (or `linked · direct` when using the laptop's LAN
   address) and that there is no build-mismatch banner.
4. Start new Claude and Codex terminal/VS Code processes for this test. A process that was already
   open before hooks were updated keeps its old hook configuration.
5. On Codex's first launch after an update, accept **Hooks need review** and trust the project
   directory. Refusing either intentionally prevents LongLeash from observing that session.

Use harmless, unmistakable approval prompts for the checks below:

```text
Run `printf CLAUDE_PHONE_OK > /tmp/longleash-claude-phone.txt` using Bash. Do not use another tool.
Run `printf CODEX_PHONE_OK > /tmp/longleash-codex-phone.txt` in the shell. Do not use another tool.
```

The `/tmp/longleash-*-phone.txt` files are only test markers and can be deleted afterward.

## 1. Phone agent picker and phone-started sessions

1. Tap **New session** before choosing a folder.
2. Confirm both **Claude** and **Codex** are visible and selectable.
3. Select **Codex**, choose a folder, send `Reply exactly CODEX STARTED`, and open the session.
4. Repeat with Claude and `Reply exactly CLAUDE STARTED`.

Pass when each response appears in its own transcript and every card/detail shows both its agent
(`Claude` or `Codex`) and origin (`from your phone`). A completed response must remain readable;
the session must not become an empty Codex card.

## 2. Terminal discovery, phone approval, and laptop handoff

### Claude

1. In a fresh laptop terminal, enter a trusted project and run `claude`.
2. Send the Claude test prompt above.
3. On the phone, confirm a live card appears with `Claude` and `in a terminal`.
4. Approve from the phone. Confirm Claude continues and this prints `CLAUDE_PHONE_OK`:

   ```sh
   cat /tmp/longleash-claude-phone.txt
   ```

5. Trigger a second Bash approval. While the phone approval is waiting, press **L once, without
   Enter**, in the laptop terminal.
6. Confirm Claude's native laptop approval appears immediately. Decide there.

### Codex

Repeat the same flow in a fresh `codex` process with the Codex prompt. The card must say `Codex`
and `in a terminal`; phone approval must create the marker file; **L** must return the decision to
Codex's native laptop prompt.

Pass when either device can make the decision, the agent receives it exactly once, and the phone's
approval card disappears after a phone decision or laptop handoff. Leaving an old approval card is
a failure.

## 3. VS Code discovery and labels

1. Start a new Claude Code session from VS Code and ask it to use a tool that needs approval.
2. Confirm the phone shows the session with `Claude` and `in VS Code`; approve once.
3. Start a new Codex session from VS Code and repeat.
4. Leave a VS Code session idle, refresh the phone, then make the agent use another tool.

Pass when the session is visible by its next lifecycle/tool event, has the correct agent and
`in VS Code` origin on both the list and detail screens, and is not duplicated as a terminal or
phone session.

## 4. Notification deep links — warm and cold

1. With LongLeash already open on the phone, trigger an approval from the laptop. Tap the
   notification.
2. Confirm the exact session detail opens with that exact approval in **Needs you**.
3. Close LongLeash completely (or lock the phone), trigger a different session's approval, and tap
   its notification.

Pass when both taps open the session that generated the notification. Landing on Home, Welcome, a
different session, or a stale approval is a failure.

## 5. Stop, including Codex

1. Start one Claude and one Codex session from the phone with:

   ```text
   Run `sleep 60` in the shell and wait for it to finish.
   ```

2. Approve the command if asked, then tap **Stop** while it is running.
3. Repeat from fresh terminal-started Claude and Codex sessions. A terminal-started session warns
   that Stop ends the local agent process; confirm the action.

Pass when Stop reacts immediately, the live process ends, the laptop terminal returns for external
sessions, the session leaves the active group, and the detail no longer offers Stop. Nothing should
report `connection refused` while `longleash doctor` still reports a reachable daemon.

## 6. Completion, transcript, and continuation

1. Start Codex from the phone and ask: `Reply exactly FIRST CODEX RESPONSE`.
2. Confirm the final response appears once, with no JSON-RPC/protocol noise.
3. Send `Reply exactly SECOND CODEX RESPONSE` in the same session.
4. Stop or finish it, open the session from **Earlier**, and tap **Reopen** if offered. Ask it what
   the first exact phrase was.
5. Repeat the basic two-message check with Claude.

Pass when final agent text is never blank or duplicated, both conversations retain context, and a
dormant conversation says `ready to reopen` instead of pretending an agent is still running.

## 7. Stale approvals and old sessions

1. Trigger and allow one approval; confirm it disappears immediately.
2. Trigger and deny another; confirm it disappears immediately and the agent sees the denial.
3. Trigger a third approval, then Stop the session; confirm the approval disappears with it.
4. Refresh/reopen the phone app.

Pass when no decided or closed-session approval returns. Old conversations may remain under
**Earlier** as history, but they must be visually inactive, offer **Reopen** only when resumable,
and never show Stop unless a real agent process exists.

## 8. Safe parallel sessions in one Git project

Use a disposable Git repository inside an allowlisted root. Do not run this test against valuable
uncommitted work.

1. Start a phone-managed Claude or Codex session there and leave it live/waiting.
2. Start a second session for the same directory with **Same checkout**. Confirm it does not start,
   names/links the controlling session without exposing an internal `ext_…` identifier, and leaves
   the first session usable.
3. Retry with **Safe parallel**. Confirm the second starts, shows its isolated branch/workspace, and
   both sessions can receive messages independently.
4. On the laptop, inspect without changing either checkout:

   ```sh
   git worktree list
   git branch --list 'longleash/*'
   ```

5. Have each agent create a differently named harmless file. Confirm each file exists only in the
   checkout owned by that agent and neither agent overwrote the other.
6. Repeat once with a dirty tracked file and an occupied checkout. Confirm isolation refuses with a
   useful explanation rather than silently starting from stale `HEAD`.

Pass when one physical checkout never has two writers, Safe parallel creates a separate worktree,
the first session remains controllable after a rejected launch, and no worktree is automatically
committed, merged, pushed, or removed.

## 9. Handoff and verified external takeover

1. For live phone-, Terminal-, and VS Code-origin Claude and Codex sessions, open the handoff panel.
2. Confirm Terminal and **VS Code workspace** choices produce visible, copyable commands whenever a
   provider conversation ID exists.
3. While a session is live, copy but do not run its command. Tap **Release current run**, wait for
   the session to become non-live, then run the command once and confirm context is retained.
4. From a fresh Terminal/VS Code session, send a phone message. Confirm the explicit
   **End there & continue here** sheet appears; cancel once and verify the original still works.
5. Confirm on a second attempt. Verify the original provider process exits before the phone-managed
   writer begins and that no “active writer” failure occurs.

Pass when no transfer happens without confirmation, a failed exit leaves the original owner intact,
and successful transfer preserves the conversation. A VS Code vendor panel may show exit 143 after
an explicitly confirmed transfer; LongLeash must never claim that it injected the resumed session
back into the sealed native chat panel.

## 10. Session settings and launch acknowledgement

1. Open **New session**, expand **Model & reasoning**, and confirm every control remains reachable at
   320 px width with the phone keyboard visible.
2. Start Claude with provider-default model, one supported effort, and adaptive thinking.
3. Start Codex with provider-default model and one supported effort; confirm no separate Claude
   thinking control is offered.
4. Confirm each launch sheet remains open and shows progress until the daemon acknowledges the
   session, then opens exactly one new session.
5. Stop/reopen a managed session and confirm its selected settings remain labeled and are reused.
6. While a managed Claude session is live, tap **Tune**, change model/effort/thinking, and confirm
   the current response is not interrupted and the next response uses the new controls. Repeat for
   Codex model/effort and confirm the same native thread is retained.
7. Tune a dormant conversation, reopen it, and confirm the saved settings are used.
8. Open a live Terminal/VS Code session, tap **Tune**, cancel the transfer once, then confirm it.
   Verify cancel changes nothing; confirm ends the original process, preserves the native
   conversation, and applies settings on the next phone turn.
9. In **Delegate**, choose explicit child controls and confirm only the attributed child receives
   them; the parent stays unchanged.
10. Try an intentionally invalid/unavailable custom model ID. Confirm a useful provider error appears
   and the UI does not spin forever or create duplicate sessions after one retry.

Pass when controls are mobile-safe, settings reach the correct provider, persisted values survive
wake/restart, failures settle visibly, and approval/filesystem safety cannot be disabled there.

## 11. Final release gate

Run again:

```sh
longleash doctor
```

The release passes only when all build identities still match, both hooks are current, all ten
flows above passed on real devices, and the phone shows no stale decisions. If anything fails,
capture the exact time, agent, origin, phone screenshot, and these diagnostics before restarting:

```sh
longleash doctor
tail -n 150 ~/.longleash/daemon.log
```

Do not call the release accepted from automated tests alone; this checklist is the real-device
acceptance layer.
