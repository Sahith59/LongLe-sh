# Phase 1 phone test — quick guide

Use this guide for a clean, practical check of the fixes and Delegate Phase 1. It is intentionally
short. A public release still requires every case in [Release acceptance](ACCEPTANCE.md), plus the
20-delegation dogfood gate in [the Delegate roadmap](DELEGATION.md#release-quality-verification).

## 1. Prepare the laptop and phone

1. Leave one terminal running `longleash`.
2. In another terminal, run:

   ```sh
   longleash doctor
   ```

3. Continue only when the daemon is reachable, code/app builds match, and both provider hooks are
   current.
4. Open LongLeash from the iPhone home screen, refresh it, accept **Update** if offered, and confirm
   the header says `linked · relay` or `linked · direct`.
5. If pairing is required, press `n`, then Enter, in the LongLeash laptop terminal and scan that
   newly generated QR once. Do not reuse a QR from a screenshot.

## 2. Verify the fixed core flows

- **Phone launch:** tap **New session**. Confirm Claude and Codex are both selectable, folder search
  works with the keyboard open, model/reasoning controls stay on-screen, and each provider returns
  one clean response.
- **Clear labels:** every card and detail view must show provider (`Claude`/`Codex`) separately from
  origin (`from your phone`/`in a terminal`/`in VS Code`).
- **Laptop discovery:** start a fresh Claude session and a fresh Codex session from Terminal or VS
  Code. Trigger a harmless tool approval and confirm the correct phone card appears without reload.
- **Approval:** allow one request and deny another from the phone. Each card must disappear
  immediately and the correct laptop agent must receive exactly one answer.
- **Notification routing:** tap one notification while LongLeash is open and one after closing it.
  Both must open the exact originating session and approval—not Home or another session.
- **Stop:** run `sleep 60` through phone-started Claude and Codex sessions, approve if asked, then tap
  **Stop**. The process must end, pending approval must disappear, and Stop must no longer be shown.
- **Transcript and history:** send two messages to each provider. Final prose must be readable once,
  with no JSON-RPC/IDE wrapper noise. Closed work belongs under **Earlier**, not **Active**.
- **Handoff:** confirm every session with a native ID shows copyable Terminal and VS Code-workspace
  choices. Release a live writer before running a resume command. Today, Claude uses its CLI/IDE
  route and Codex resumes in a terminal; the exact-panel companion behavior is planned in
  [the VS Code roadmap](VSCODE-EXTENSION.md).
- **Safe parallel:** in a disposable clean Git project, keep one phone session live and start a
  second with **Safe parallel**. Both must remain usable in different worktrees/branches. **Same
  checkout** must refuse the second writer without breaking the first.
- **Stale cleanup:** decide an approval, Stop another session with a pending approval, refresh the
  app, and confirm neither approval returns and no dead session remains active.

## 3. Verify Delegate Phase 1

Run these four routes with small, harmless prompts:

- Claude → Claude
- Claude → Codex
- Codex → Claude
- Codex → Codex

For each route:

1. Open the parent and tap **Delegate**.
2. Select one message or the intended context scope, choose the child provider and role, then edit
   the briefing.
3. Confirm the exact reviewed briefing; verify exactly one child starts and remains independently
   controllable after refresh/reconnect.
4. Exercise one child approval and confirm the notification opens the child, not the parent.
5. Let the child finish, inspect and edit the Return draft, then explicitly send it to the parent.
6. Confirm the parent receives one attributed return with the edited bytes—not tool noise or an
   unreviewed message.
7. Repeat once with a Terminal- or VS Code-origin parent. Cancel the takeover once, then confirm it;
   the external provider process must exit before LongLeash resumes the parent.

Phase 1 passes this quick check only when no duplicate child/return, stale approval, lost context,
wrong notification destination, active-writer error, or workspace-loss event occurs.

## 4. Capture a failure before restarting

Write down the exact time, provider, origin, directory, and action. Take a phone screenshot, then run:

```sh
longleash doctor
tail -n 150 ~/.longleash/daemon.log
```

Do not delete LongLeash databases, worktrees, or provider transcripts. Use
[Troubleshooting](TROUBLESHOOTING.md), and keep the evidence so the failure can be reproduced rather
than hidden by a restart.

## 5. Release decision

This quick guide is a smoke/dogfood pass, not the final release verdict. Before declaring Phase 1
accepted, complete [all real-device acceptance flows](ACCEPTANCE.md), finish at least 20 real
delegations, and record any failure and rerun after its fix.
