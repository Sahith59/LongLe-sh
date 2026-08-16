# LongLeash security policy

## Reporting a vulnerability

Please email **security@longleash.dev** with a clear description, affected version or build, and the
smallest safe reproduction. Do not include live pairing links, access tokens, provider credentials,
private repository content, or another user's data. If sensitive evidence is necessary, ask for a
secure transfer method first.

Do not open a public issue for an unpatched vulnerability. Public GitHub issues are appropriate for
redacted, non-sensitive reliability bugs.

We aim to acknowledge a report within three business days, assess severity and scope, preserve
evidence, and coordinate a fix and disclosure timeline. This is a response target, not a guarantee.

## Supported versions

The current hosted build and the latest release on the default branch receive security fixes. Older
installed daemons, app caches, extensions, and self-hosted deployments should update before filing a
compatibility report. Run `longleash doctor` and include its redacted build/status output.

## In scope

- authentication or cross-account isolation failures;
- pairing, device revocation, or authorization bypasses;
- relay ticket forgery, replay with material impact, room/role confusion, or cross-room leakage;
- end-to-end encryption, secret, transcript, notification, or approval-data exposure;
- remote command or workspace-boundary bypasses;
- supply-chain, installer, update, or extension-package integrity failures.

## Safety rules

Test only accounts, devices, and repositories you own or have explicit authorization to use. Avoid
privacy violations, persistence, denial of service, destructive actions, social engineering, or
accessing content beyond the minimum proof. Stop immediately if you encounter another person's data.

LongLeash does not promise a bug bounty. Good-faith reports that follow this policy will be handled
constructively and may be credited with permission.
