# Voice-call evidence (2026-09-27)

Three live voice calls on the Trial account (web calls; the account has no phone number — DEBUGLOG #1). All numbers are copied from the SDD ledger (`.superpowers/sdd/2026-09-26-plan-1-core/progress.md`); none are invented.

| Call | UTC time | trace_id | Route | verify_site (ms) | join/open (ms) | Outcome |
|---|---|---|---|---|---|---|
| #1 | 17:10 | `t-5d419f3a98a3240f` | DV fell back at 2200 ms (`kv` 2195) → generic greeting → `n_verify` → `t_verify` → default edge → escalation: transfer (unanswered) → take message → `t_callback` | 7869 — ok, but > 5000 ms tool timeout → treated as failure | — (no ticket; `log_callback` 2800 ms, `page.raised`) | Escalation/fallback paths proven live; happy path blocked by KV latency (DEBUGLOG #6) |
| #2 | 18:05 | `t-128d0766…` | `n_verify` → `t_verify` ok → join path; staged reports were pruned by the 6 h staleness cap, so the incident stayed P2/1 site — by design | 3579 | `join_incident` 2638 → NJD-1401 | Concurrent-KV fix live: verify 7869→3579 ms; demo lesson: pre-flight `/ops/reset` → `/ops/stage-incident` (spec §16) |
| #3 | 18:14 | `t-c01949fafca2a42e` | `n_verify` → `t_verify` ok → `join_incident` on the freshly staged INC-1002 (2 sites: NJD-2102, NJD-3302) | 3646 | `join_incident` 2559 → NJD-1402 → INC-1002 upgraded P2→P1 at 3 sites | Core demo path proven live over voice; P1 upgrade confirmed on `/ops/status` |

## Chat smoke (conversation `cad930bd…`)

The chat smoke disclosed, greeted and prompted for "site ID and PIN" correctly, but `capture_details` (`update_dynamic_variables`) is **"not available on this channel"** in `/chat` — the flow cannot reach `t_verify` in chat. The LLM then improvised MCP `get_site_status`/`check_known_incidents` calls with no session → `SESSION_FALLBACK`. DV fired on every chat turn at 1.5–2.2 s (`kv_ms` ≈ total; DEBUGLOG #6). Conclusion: voice is the only valid test channel for this flow (DEBUGLOG #9).
