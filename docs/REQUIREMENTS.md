# What LongLeash requires of you (and what it doesn't)

**Governing principle: LongLeash never asks you to weaken your security.** If a setting makes your machine less safe, it is not a requirement, and we will not ship a product that pressures you into it. Everything below is split honestly into three tiers.

## Tier 1 — Actually required

These are physics, not policy. Without them, nothing can work.

| Requirement | Why | Who does it |
|---|---|---|
| **Your laptop stays awake** while you're away | A sleeping machine cannot answer your phone. | The installer offers to configure it, with your consent. You can decline and wake the Mac manually instead. |
| **The daemon is running** | It is the thing your phone talks to. | Installed as a login item that restarts itself. |
| **Your phone can reach the daemon** | Same network (LAN mode) or through the relay (anywhere mode). | The app tells you which mode it's using and diagnoses failures in plain language. |
| **An agent CLI installed** (e.g. Claude Code) | LongLeash drives agents; it isn't one. | You already have it if you're the target user. |

## Tier 2 — Recommended for an always-on machine

Advice for anyone leaving a laptop running unattended. **LongLeash works fine without these** — it just means more ways for the machine to disappear while you're out.

| Recommendation | What happens if you skip it |
|---|---|
| Turn off *automatic installation* of OS updates | An update may reboot your machine mid-trip; you lose access until you're home. Keep automatic *downloads* on and install when you're back. |
| Enable auto-restart after power failure | A power blip leaves the machine off instead of recovering. |
| Keep the lid open (or disable clamshell sleep) | A closed lid sleeps most laptops regardless of other settings. |
| Set up a laptop-down alert | Without it, you find out your machine died by discovering nothing responds. LongLeash's own heartbeat covers this once installed. |

Every one of these is a *reliability* choice. None of them reduces your security.

## Tier 3 — Never required, your call alone

**Disk encryption (FileVault / BitLocker): keep it ON. We recommend it.**

LongLeash does not care whether it's on. The only interaction worth knowing: if your machine reboots while you're away, an encrypted disk waits at the unlock screen until you physically return. That is your disk encryption working correctly, and it is a good trade — you keep your data safe and lose remote access until you're home. The alternative (disabling encryption plus auto-login so the machine boots unattended) trades away real security for convenience on a machine whose entire purpose is running code remotely. **We will never recommend that trade, and the installer will never do it for you.**

Similarly never required: disabling your firewall, disabling SIP/Gatekeeper, running anything as root, opening ports on your router, or granting LongLeash access to anything beyond the project directories you allowlist.

## One honest caveat about approvals

Claude Code lets you pre-approve commands in your own settings (`~/.claude/settings.json`,
`permissions.allow`). Those rules take effect **before** LongLeash is consulted, so a matching
command runs without ever reaching your phone. We cannot override that, and we will not pretend
otherwise:

- The daemon **tells you at startup** how many such rules you have and shows examples.
- Anything that runs this way still appears in the **activity feed**, so nothing happens
  invisibly — you see it, you just were not asked first.
- If you want every action to come to you, remove those rules from your settings.

## What LongLeash does to protect you

- End-to-end encryption between your phone and your laptop; the relay routes ciphertext it cannot read.
- Pairing is a one-time-use QR code; device tokens are stored only as hashes and compared timing-safely.
- One tap revokes a device — and revocation severs its live connection immediately, not at next reconnect.
- There is no "run any command" endpoint. The API exposes specific typed operations only.
- Remote session start is restricted to project directories you allowlist.
- Push notifications carry IDs only, never your code or prompts.
- Every action that changes anything is written to an audit log you can read.
