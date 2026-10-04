# Competitive landscape — 4 October 2026

## Brief and evidence limits

LongLeash serves developers supervising Claude Code and Codex on their own computers, especially when they move between terminal, IDE and phone. Its proposed advantage is dependable cross-provider supervision, explicit ownership and reviewed handoffs. Local/self-hosted use remains complete and the hosted service is a free preview; monetization follows the evidence gates in `MONETIZATION-PLAN.md`.

This is a dated, representative landscape, not a claim to have found every competitor or run their products. Eleven candidates were screened; ten relevant alternatives are profiled below. Sources are official vendor documentation, product pages and repositories accessed on 2026-10-04. Vendor statements describe advertised capabilities, not independently proven reliability or security. Two source surfaces are linked where available; two vendor pages are not independent validation. No numerical scores or unsupported “only/best/most secure” claims.

## Alternatives and implications

| Product / category | Vendor-described offer and sources | Implication for LongLeash (our inference) |
| --- | --- | --- |
| Happy — direct | Open-source mobile/web control for Claude Code and Codex with encryption. [Product](https://happy.engineering/), [source repository](https://github.com/slopus/happy). | Cross-provider support and encryption already overlap. Prove recovery, permission fidelity and ownership clarity. |
| HAPI — direct | Self-operated hub, phone/browser access and QR/token pairing. [Quick start](https://hapi.run/docs/guide/quick-start), [auth contract](https://hapi.run/docs/api/client-contract/auth). | Self-hosting and QR onboarding are baseline alternatives. LongLeash should make short-lived per-device trust and revocation easy to understand. This is not a claim that HAPI lacks other protections. |
| Nimbalyst — direct | Visual workspace and mobile management for Claude Code/Codex, including review and notifications. [Mobile offer](https://nimbalyst.com/mobile-agent-management/), [quick start](https://nimbalyst.com/docs/getting-started/quickstart/). | “One interface for both providers” is insufficient positioning. Native-workflow continuity and dependable human decisions need evidence. |
| Claude Code Remote Control — provider-native substitute | Continue local Claude sessions through phone/browser; local execution and reconnect are documented. [Remote Control](https://code.claude.com/docs/en/remote-control), [security](https://code.claude.com/docs/en/security). | Installation friction competes with an existing provider relationship. Show why a mixed-provider developer benefits, with no requirement to change permission posture. |
| Codex remote/mobile — provider-native substitute | Mobile supervision across computers/remote environments. [Product announcement](https://openai.com/index/work-with-codex-from-anywhere/), [engineering workflow](https://developers.openai.com/blog/mastering-codex-remote-for-engineering). | Phone access is a provider baseline. “Codex is desktop-only” is outdated positioning. |
| Cursor — adjacent | Cloud agents accessible through mobile and desktop, with an iOS app. [Mobile](https://cursor.com/mobile), [cloud-agent docs](https://cursor.com/docs/cloud-agent). | Clear continuation and handoff matter. Do not imply LongLeash has equivalent cloud execution while its host must stay awake. |
| GitHub Copilot cloud agent — adjacent | Start/track cloud-agent sessions in GitHub Mobile. [Mobile workflow](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-mobile), [supported surfaces](https://docs.github.com/en/copilot/get-started/where-to-use-github-copilot). | Reviewable outcomes and visible task state are expected. LongLeash's reviewed returns should make changes understandable on a phone. |
| Replit — adjacent | Mobile software creation and Agent workflows. [Mobile product](https://replit.com/products/mobile), [Agent announcement](https://replit.com/blog/try-agent). | Time to first useful action matters. Optimize existing-repository onboarding; avoid expanding into a general app builder. |
| Devin — aspirational workflow reference | Agent work integrated with Slack and a hosted agent environment. [Introduction](https://docs.devin.ai/get-started/devin-intro), [Slack integration](https://docs.devin.ai/integrations/slack). | Useful asynchronous summaries and visible blockers are a stronger benchmark than more notification channels. |
| Termius + Tailscale — terminal/network substitute | Mobile SSH and policy-controlled remote access. [Termius](https://termius.com/), [Android client](https://www.termius.com/free-ssh-client-for-android), [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh), [CLI](https://tailscale.com/docs/reference/tailscale-cli). | Developers can already reach a terminal remotely. Purpose-built decisions should reduce interaction effort while preserving control. |

**Watch / not scored:** Omnara. Its [historical mobile comparison](https://www.omnara.com/blog/mobile-coding-landscape) now explicitly labels the previous product and describes a move to a managed-agent platform, while [another product surface](https://www.omnara.co/) still presents a coding-agent command center. Current positioning needs reconciliation before direct comparison. Old repository language saying Omnara “died” is not reliable current evidence.

## Decisions for the product

1. **Workstream D now:** explicit laptop/phone comparison, short-lived pending trust and actionable mismatch/expiry recovery. Pairing reliability must be demonstrated across LAN, hosted and self-hosted relay.
2. **Keep the core promise narrow:** supervise supported local agents, understand who owns each session/workspace, approve with context, and review returns. Cross-provider support, E2E transport and mobile access alone are not unique claims.
3. **Prove the daily loop:** install → pair → receive a real decision → respond → verify the result → resume at the laptop. Measure completion and failure reasons with consent; never count page traffic as adoption.
4. **Polish means predictable behavior:** visible pending/disconnected/stale-build states, accessible controls and recovery instructions. The existing Matte Graphite design remains the identity; no speculative redesign this phase.
5. **Market readiness after gates:** demonstrate the real mixed-provider workflow, publish an accurate support matrix and self-host guide, then seek first-user evidence. Customer outreach, publication and paid acquisition have not been performed. Existing monetization thresholds remain in force.

## Research still needed before public comparison claims

Hands-on onboarding and recovery trials on the same devices/networks; current pricing/plan eligibility if used in marketing; provider permission semantics; transparent comparison methodology; user interviews after P5; re-check current official pages before publishing. Vendor material cannot establish that LongLeash is more secure or more reliable.
