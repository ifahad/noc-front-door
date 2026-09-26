# DEBUGLOG.md

Blocking findings from the build, with evidence. One entry per finding.

## Entry template

```
## #<n> — <date> — <one-line title>
- Symptom: what is visibly wrong
- Signal: the exact message, code path or metric that surfaced it
- Evidence: where it can be reproduced (log line, portal screen, command)
- Hypothesis: best current explanation
- Fix: what was done, or the action in flight
- Verification: how the fix was proven, or what is still pending
```

## #1 — 2026-09-26 — No phone number can be ordered on the trial account (KSA origin)

- Symptom: The Telnyx Portal number search cannot order any number for the project; the account is trial with a Saudi Arabia origin.
- Signal: The Portal number search says: "Worldwide number coverage is only available to verified users. Your account is trial and only able to search and purchase local numbers in Saudi Arabia." Choosing Saudi Arabia returns "Telnyx does not have search coverage in this country." So no number can be ordered.
- Evidence: the Portal messages (screens seen by Fahad during the number search).
- Hypothesis: Trial accounts are limited to local numbers in Saudi Arabia, but Telnyx has no search coverage there, so ordering is impossible until the account is verified.
- Fix: Emailed Telnyx Team asking for Verified status on the account.
- Verification: Pending Telnyx Team's reply. Workaround in the meantime: web calls (the trial account supports web calls only anyway).
- Also: the brief's CLI URL (`telnyx-edge-linux-amd64`) does not match this aarch64 host; the v0.5.4 linux-arm64 asset was used instead.
