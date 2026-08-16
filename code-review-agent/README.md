# pr-reviewer

A minimal code-review agent on the Cline SDK: it investigates a diff, a judge pass filters findings, and the driver posts them as one GitHub review. The agent is caged read-only and audited.

## What it demonstrates

- **Core loop for free.** The review engine is Cline's agent loop (`ClineCore.start`), not hand-rolled.
- **Beyond-the-diff review.** The agent uses `run_commands` (`git diff`, `grep`, `ast-grep`), `read_files`, and `search_codebase` to check context, not just the changed lines.
- **Custom tools.** `record_finding` and `keep_finding` (`plugins/reviewer-tools.ts`) are the structured seam between agent and driver.
- **Tool separation.** `record_finding` only runs in the review pass and `keep_finding` only in the judge pass (`reviewer-tools.ts` `setPhase` / `isToolAllowed`), so neither run can call the other's tool.
- **Judge pass.** A second run re-checks findings and keeps only grounded ones (false-positive control).
- **Read-only cage.** `plugins/tool-guard.ts` (`beforeTool`) blocks file writes (`apply_patch`, `editor`) and mutating shell (`rm -rf`, `git push/commit`, `gh` writes, `sudo`, ...). Both the review and judge runs attach it, so the reviewer physically cannot change your repo or post on its own.
- **Audit + cost.** `plugins/review-journal.ts` (`afterTool` + `afterRun`) logs every tool used and the tokens/cost per run.
- **Team rules without code.** `skills/review-guidelines.md` holds the severity bar, categories, and tone. It is injected into the system prompt (a guidelines file), edit it, no code change.
- **Non-blocking.** Posts as `event: COMMENT`, never blocks the PR.

## Layout

```
main.ts                     driver: review run -> judge run -> post/dry-run
plugins/reviewer-tools.ts   record_finding + keep_finding tools
plugins/tool-guard.ts       read-only guard (beforeTool)
plugins/review-journal.ts   cost + command audit (afterTool/afterRun)
skills/review-guidelines.md the review rules (editable)
test/guard-drive.ts         17 deterministic guard and phase checks (no model, no cost)
```

## Prerequisites

- `bun`, `@cline/sdk` installed (`bun install`)
- `cline auth` configured (uses `openai-codex` / `gpt-5.5` by default; override with `REVIEW_PROVIDER` / `REVIEW_MODEL`)
- `gh` authenticated (for PR mode and posting)

## Run

PR mode (dry-run by default, prints the review it would post):
```bash
bun run main.ts --repo owner/repo --pr 123 --cwd /path/to/checkout
```

PR mode, actually post the review:
```bash
bun run main.ts --repo owner/repo --pr 123 --cwd /path/to/checkout --post
```

Local mode (review a branch diff, dry-run only, no PR to post to):
```bash
bun run main.ts --base main --head feature --cwd /path/to/repo
```

Guard test (free):
```bash
bun run test/guard-drive.ts
```

## Flow

1. **Review run** — agent gets the diff (`gh pr diff` or `git diff`), investigates the repo, calls `record_finding` per issue, ends with a summary.
2. **Judge run** — a stricter agent re-checks each finding against the diff and calls `keep_finding` for the grounded ones. The rest are dropped.
3. **Post** — the driver builds one batched review (summary + inline comments) and either prints it (dry-run) or posts it via `gh api ... /pulls/{n}/reviews` as `COMMENT`. If the batched post 422s on a bad line, it retries with the summary alone and prints the inline comments that could not attach.

## Verified

- Deterministic guard checks run without a model or API call. See `test/guard-drive.ts`.

## Known limitations (v1)

- **Line mapping.** The model picks comment line numbers from the diff; they can be off by a line or two. GitHub's Reviews API needs the line inside the diff hunk or it returns 422. A production version would map findings to hunks in code (see the gotchas in the research doc). Dry-run is unaffected, and on a live post the driver degrades to a summary-only review plus a printout of the dropped inline comments, so one bad line no longer loses the whole review.
- **No queue / webhook.** This is a local/CI driver, not a GitHub App. Tier 2 (automation events) adds the event-driven trigger.
- **No persistent code graph or learnings.** Investigation is on-demand grep/ast-grep. Team learnings would be a guidelines file or a store.
- **"Guidelines file", not a Cline Skill.** `skills/review-guidelines.md` is read into `systemPrompt`. It does NOT use Cline's Skills primitive (`config.skills` + the `skills` tool). Call it a guidelines/rules file in any writeup. To legitimately advertise the Skills primitive, implement real Skills first (author a skill, gate with `config.skills`, let the agent pull it via the `skills` tool). Renaming the `skills/` dir to `guidelines/` would make this clearer.
