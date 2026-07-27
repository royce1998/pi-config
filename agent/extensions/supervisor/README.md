# supervisor — run another pi agent to completion

Adds a tool and a command that launch **another pi agent as a child process
(RPC mode)** and keep re-prompting it until a **measurable goal** is reached.
This is how one pi session makes another agent "not stop until the job is
done": the child settles after each turn, the supervisor runs a *progress
command*, and if the target isn't met it nudges the worker to continue —
looping until success, a stall (human-only blocker), or a safety cap.

The worker keeps **one persistent session**, so its context carries across
rounds, and it inherits the same user-level extensions/skills as the parent
(e.g. the `browser` tools and the `job-search` skill).

## Tool: `supervise_agent`

| Param | Req | Meaning |
|-------|-----|---------|
| `task` | ✓ | Instruction given to the worker on round 1 (what to do, where files are, rules). |
| `progressCommand` | ✓ | Shell command whose stdout's first integer is the current count (e.g. `grep -c '\| Applied \|' applications.md`). Runs in `cwd`. |
| `target` | ✓ | Loop until count ≥ target. |
| `cwd` | | Working dir for worker + progress command (`~` expanded). Default: session cwd. |
| `model` | | Worker model pattern (default: your configured default). |
| `nudge` | | Message sent each round after the first to keep it going. |
| `maxCycles` | | Safety cap on rounds (default 40). |
| `stallLimit` | | Stop after this many consecutive no-progress rounds (default 4). |
| `cycleTimeoutMs` | | Max ms to wait for one round to settle (default 900000). |
| `sessionName` | | Display name for the worker session. |
| `resume` | | Session id/path to continue an existing worker session. |
| `saveSession` | | Persist worker session (default true). |
| `browserProfileDir` | | Sets `PI_BROWSER_PROFILE_DIR` so the worker drives its own Chrome profile. |

**Outcomes:** `reached`, `stalled` (likely a human-only blocker: email
verification / CAPTCHA / AI-attestation gate), `max-cycles`, `worker-exited`,
`aborted`, `bad-progress-command`.

### How it works
1. Baseline: run `progressCommand`; if already ≥ target, return immediately.
2. Spawn `pi --mode rpc` in `cwd` (JSONL over stdio, per `docs/rpc.md`).
3. Round 1 sends `task` + an explicit GOAL line; later rounds send `nudge`.
4. Wait for `agent_settled` each round, then re-check progress.
5. Stop on target reached, stall (no progress for `stallLimit` rounds),
   `maxCycles`, worker exit, or abort. Abort (Ctrl+C) is propagated to the
   child.

Extension UI dialogs raised by the worker are auto-cancelled so they can never
hang the loop; each is counted and noted in the per-cycle report.

## Command: `/supervise`

Human entry point. Pass a JSON object:

```
/supervise {"task":"…","progressCommand":"grep -c '| Applied |' applications.md","target":50,"cwd":"~/.pi/agent/job-search/arthur","browserProfileDir":"~/.pi/agent/job-search/browser-profile"}
```

## Example (the motivating case)

Keep an agent applying to jobs for Arthur until his tracker shows 50 submitted:

```json
{
  "task": "You are applying to jobs on Arthur Running Horse's behalf. Read profile.json and applications.md in this directory first, skip anything already applied, and apply to remote-eligible roles following the job-search skill rules. Append a row to applications.md only after a confirmed submission. If you hit a human-only gate (email verification, CAPTCHA, AI attestation), note it in applications.md and move on.",
  "progressCommand": "grep -c '| Applied |' applications.md",
  "target": 50,
  "cwd": "~/.pi/agent/job-search/arthur",
  "browserProfileDir": "~/.pi/agent/job-search/browser-profile",
  "stallLimit": 3
}
```

> **Browser concurrency:** the `browser` extension drives ONE Chrome profile
> per process. Don't run another live session against the same
> `browserProfileDir` at the same time, and don't use the parent session's
> browser while the worker is running.

## Notes / limits
- Cost/latency scale with rounds × the worker model. Use a cheaper `model` for
  long runs.
- `stalled` is expected when the remaining work needs a human (that is the
  honest stopping point — the loop won't fake progress).
- Requires a POSIX shell (`bash`/`sh`) for `progressCommand`; falls back to the
  platform shell otherwise.
