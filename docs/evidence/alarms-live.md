# Live alarm test — INC-1004 (2026-09-27, 21:46–21:5x UTC; all times UTC with Z)

One staged incident, observed end to end, to answer the open question from DEBUGLOG #4: do actor alarms fire on this account, given that new actor instances cannot be created? Setup: host `1ac587dd` + edge `c6b945d2` live, `flag/actor_mode=mux`, the new prober (tick + paging) running.

| UTC | Event |
|---|---|
| 21:46:50Z | Pre-flight: `POST /ops/reset` → `POST /ops/stage-incident` — INC-1004 staged as P2 in Riyadh North, escalation due 21:51Z (P2 ack window 5 min). Alarm set on the mux host's storage. |
| 21:51:4xZ | The ladder escalates to **L1** in `RegionState` and mints page **INC-1004:p1** (monotonic per-incident counter). Escalation column on the board flips. |
| 21:51:51Z | A prober `POST /ops/tick` in that window reports **`fired:0`** — the tick fallback did not drive the escalation. |
| 21:51:53Z | The prober's paging cycle claims `INC-1004:p1` → **PAGE banner** + `notify-send` + `page.sent` log line → pending 0. |
| 21:5xZ | Operator acknowledges (`POST /ops/ack`) → the ladder stops. |

Every `/ops/tick` in the escalation window reported `fired:0` (including 21:51:51Z, 4 s before the claim), so the escalation could only have been driven by the **platform alarm** on the mux host (`Counter/demo`), whose `alarm()` fans the single real alarm out to the entities.

**Conclusion:** actor alarms work on this account even though new instances cannot be created (DEBUGLOG #4, #12). The host's own — pre-existing — alarm fires and the mux host fans it out; `/ops/tick` stays as a belt-and-braces fallback. Ladder: escalate one level per due window until acked or L3.
