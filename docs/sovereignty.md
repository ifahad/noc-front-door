# Data residency & PDPL — where the data lives

Najd Networks is a fictional KSA managed-services provider; the demo runs on a Telnyx **Trial** account whose compute, KV and storage regions are US-based. This file states where each class of data lives in the demo as shipped, the PDPL/residency position, and what production changes. Referenced from [README.md](../README.md) ("Production path", "Known limitations") and the spec.

## Where the data lives (demo as shipped)

| Data | Where | Notes |
|---|---|---|
| Business truth — tickets, PIN attempts/locks, per-call verification proof, incidents, escalation pages | **Stateful Actors** (`SiteState`/`RegionState`) on Telnyx Edge Compute | Actor state is platform-managed; currently the mux host instance (DEBUGLOG #4). The PIN itself never persists — only attempt counts, tier outcomes and a per-call proof record |
| Sessions (`call/*`, `conv/*`), feature flags (`flag/*`), the incident projection | **Telnyx KV** namespace `noc-kv` | TTL'd, best-effort cache/config — never an invariant (C5); values are strings, no PINs |
| Resolved-incident report JSON | **Telnyx Cloud Storage** bucket `noc-reports-fb8131`, region `us-central-1` | Written on resolve; read via ops-token routes + the board's `last_report` pointer (DEBUGLOG #13) |
| Call audio → **transcripts and conversation insights** | **Telnyx Voice AI** platform storage | Contains the **PIN as spoken** (and site IDs, names, fault descriptions); PII redaction is **not** enabled in the demo — a known limitation ([README](../README.md)) |
| Telephony metadata (from-number, call control ids, timestamps) | Telnyx voice platform | Caller numbers are logged masked (`+1312****309`); raw numbers only in the Portal |
| Secrets (PIN pepper, Ed25519 public key, ops/MCP bearers, seed/demo-guide values) | **Telnyx Edge secrets**, per function | Never printed, logged or committed; demo PINs exist only as runtime-assembled fixtures |

Our own log lines carry no PINs, tokens or keys (spec §11.1), so the residency surface that holds caller-sensitive content is: the actor state store, KV, the Cloud Storage reports, and above all the **Telnyx transcripts/insights**.

## PDPL / residency position

- The demo collects **no real customer PII**: sites, PINs and contacts are seeded fixtures for a fictional provider; callers are the project's own testers.
- As shipped, however, the data path is **not KSA-resident**: transcripts/insights, actor/KV state, reports and telephony metadata live in Telnyx US regions. For a real KSA customer this is the single biggest gap — under a strict PDPL residency reading, caller voice content and identifiers should remain in-Kingdom (or under an agreed cross-border basis with the customer).

## What production changes

- **Region:** host the data path in a KSA (or customer-agreed) region as soon as Telnyx offers one for Voice AI storage, Edge KV/actors and Cloud Storage; pin transcripts/insights to it.
- **PINs:** move to one-time per-call PINs so a transcript can never leak a reusable credential; enable Telnyx PII redaction where available; set a short retention/purge window for transcripts and insights.
- **Paging:** Telnyx SMS/voice paging to the on-call rota (the desktop notification is demo-only).
- **Access:** keep `require_pin=true` plus caller-ID trust for known branch numbers; put the board behind operator auth (SSO); review audit exports.
- **Reports:** align Cloud Storage retention with the customer's data-retention clause; encrypt at rest by default.

Related: [docs/decisions.md](decisions.md) (state → primitive map), [docs/architecture.md](architecture.md), DEBUGLOG #13 (reports), README "Known limitations" (PII in transcripts).
