# pr-reviewer: code walkthrough

Read this before writing the blog. Everything below is grounded in the actual files in this folder.

## The shape in one line

One driver process (`main.ts`) runs Cline's agent loop **twice** against the same diff, and three plugins ride along on every run. Run 1 finds issues, run 2 filters them, then the driver (not the agent) posts. Everything the two runs share flows through **module-scope arrays**, not return values.

```
main.ts ── review run ──► agent calls record_finding ──► findings[]
   │                                                         │
   └───── judge run ──► agent calls keep_finding ──► keptIndices (Set)
   │                                                         │
   └───── driver reads findings.filter(kept) ──► builds one GitHub review ──► post or dry-run
```

## File map

```
main.ts                     the driver. owns argv, the two cline.start calls, and the GitHub post
plugins/reviewer-tools.ts   custom tools record_finding + keep_finding; owns findings[] + keptIndices
plugins/tool-guard.ts       beforeTool hook. read-only cage
plugins/review-journal.ts   afterTool + afterRun hooks. audit trail + cost line
skills/review-guidelines.md plain markdown, read into systemPrompt of run 1
test/guard-drive.ts         17 deterministic checks against the guard and phase separation, no model, no cost
```

## The key trick: module-scope state is the seam

This is the thing to be sure of before you write. `reviewer-tools.ts` exports two live collections at module scope:

```ts
export const findings: Finding[] = [];        // record_finding pushes here
export const keptIndices = new Set<number>(); // keep_finding adds indices here
```

Cline hooks and tools receive no shared context object you can thread state through, same constraint as the hooks blog (`journalPath`/`runStartedAt` lived in module scope for exactly this reason). So the tools write to these module arrays, and `main.ts` imports the same references and reads them back:

```ts
import reviewerTools, { findings, keptIndices, type Finding } from "./plugins/reviewer-tools.ts";
import journal, { auditLog } from "./plugins/review-journal.ts";
```

Because it's the same module instance, when the agent calls `record_finding` mid-run, the object it mutates is the one `main.ts` inspects after the run returns. That's the entire agent to driver channel. No IPC, no files, no return-value parsing.

Consequence the driver has to handle: state persists across runs in one process, so `main.ts:89-92` resets it at the top of `main()`:

```ts
findings.length = 0;
keptIndices.clear();
auditLog.length = 0;
```

## Execution flow, top to bottom (main.ts)

1. **Parse args (`parseArgs`, 41-54).** Two modes:
   - PR mode: `--repo owner/repo --pr N` gives `modeGh`
   - Local mode: `--base X --head Y` gives `modeLocal`
   - `--cwd` sets the workspace, `--post` flips off dry-run. If neither mode's flags are present, it exits 1.

2. **Pick the diff command (83-85).** The diff is never fetched by the driver, it's handed to the agent as a command to run:
   - PR: `gh pr diff N --repo owner/repo`
   - local: `git diff base..head`

3. **Load the guidelines file (87).** `readFileSync` of `skills/review-guidelines.md` into a string. This is a plain file read, not a Cline primitive.

4. **Create one core, one base config (94-103).**
   ```ts
   const cline = await ClineCore.create({ backendMode: "local" });
   const baseConfig = {
     providerId: PROVIDER, modelId: MODEL, cwd: args.cwd,
     enableTools: true,
     enableSpawnAgent: false, enableAgentTeams: false,   // no sub-agents; keep it one loop
     extensions: [reviewerTools, guard, journal],
   };
   ```
   `extensions` is the load-bearing line, same mechanism as `extensions: [journal, guard]` in the hooks post, now carrying three plugins.

5. **Review run (108-122).** `cline.start` with:
   - `systemPrompt` = the guidelines markdown + a short tools note ("record_finding once per issue; read_files/search_codebase/run_commands are read-only").
   - `prompt` = "get the diff with `<diffCmd>`, investigate surrounding context, call `record_finding` per issue, then reply with a one-line summary and stop."
   - The agent investigates with built-in tools (`run_commands`, `read_files`, `search_codebase`) and emits findings. Guard blocks any write. Journal logs each tool + the run cost.
   - After it returns: `findings[]` is populated. If empty, return early, nothing to post (125-128).

6. **Judge run (132-147).** A second `cline.start`, deliberately different:
   - Different `systemPrompt`: "strict reviewer of findings, keep only grounded ones, drop noise/dupes/praise, fewer higher-signal wins."
   - Different extensions: `[reviewerTools, journal]`, guard is dropped (139). The comment explains why: the judge only needs `keep_finding`, runs no shell, so no cage is needed.
   - `prompt` = the candidate `findings` serialized as JSON + "re-check each against the diff with `<diffCmd>`, call `keep_finding` with index + reason for the grounded ones."
   - After it returns: `keptIndices` holds the survivors.

7. **Filter + sort (149-152).**
   ```ts
   const kept = findings.filter((_, i) => keptIndices.has(i));
   kept.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]); // blocker->warning->nit
   ```
   Then it prints the audit line: `auditLog.map(a => a.tool).join(", ")`.

8. **Build one batched review (155-159).**
   ```ts
   const review = {
     body: summaryBody(kept),          // "cline-reviewer found N issue(s): X blocker, Y warning, Z nit."
     event: "COMMENT",                 // never REQUEST_CHANGES, non-blocking on purpose
     comments: kept.map(f => ({ path: f.path, line: f.line, side: f.side, body: commentBody(f) })),
   };
   ```
   `commentBody` (58-62) formats each: `**[severity · category] cline-reviewer**` + message + optional suggestion.

9. **Post or dry-run (161-174).**
   - Dry-run (default, or any local run): pretty-print the review JSON and return. Local mode adds "(local mode has no PR to post to)".
   - Real post (PR mode + `--post`): `execFileSync("gh", ["api", "repos/.../pulls/N/reviews", "-X", "POST", "--input", "-"], { input: JSON.stringify(review) })`. The driver shells out to `gh`, the agent never does.

10. **`finally: cline.dispose()`** (175-176). Always tears down the core.

## The three plugins, precisely

**reviewer-tools.ts (capability: `tools`).** `setup(api)` registers two tools via `createTool`:
- `record_finding` (47-98): strict `inputSchema` (path, line, side RIGHT/LEFT, severity blocker/warning/nit, category bug/security/perf/style/convention, message, optional suggestion). `execute` validates in code, trims strings, checks `line > 0` and finite, checks severity/category against lookup maps, and returns `{ ok: false, error }` on bad input. On success it pushes to `findings` and returns `{ ok: true, index }`. That index is what the judge later references.
- `keep_finding` (101-124): schema is `{ index, reason }`. `execute` range-checks the index against `findings.length`, then `keptIndices.add(index)`. `reason` is required in the schema but note it's not stored, it forces the judge to justify, but the driver only reads the Set.

**tool-guard.ts (capability: `hooks`, `beforeTool`).** The read-only cage. Two blocks:
- `BLOCKED_TOOLS` = `{ apply_patch, editor }`, any file-write tool is skipped outright.
- `run_commands`: `extractShellCommands` flattens the input (string / array / `{command|commands|cmd}`), then tests each against `DANGEROUS` regexes: `rm -rf`, git mutations (push/commit/reset/checkout/clean/merge/rebase/tag/`branch -D`), `gh` write subcommands, `gh api` with POST/PATCH/PUT/DELETE or `-f/-F/--field`, `mkfs`, `dd if=`, `sudo`, fork bomb, `curl|wget ... | sh`. Match gives `{ skip: true, reason }`. This is the hooks-blog guard, widened for git/gh writes. Returns `undefined` (allow) otherwise.

**review-journal.ts (capability: `hooks`).**
- `afterTool`: pushes `{ tool, at }` to the exported `auditLog`, the explainability trail the driver prints.
- `afterRun`: logs one line, `run <status>, <iterations> iteration(s), in/out tokens, cost $...`. Same `result.usage` shape as the hooks post, no digging through logs.

## The GitHub-posting reality (be honest about this in the writeup)

- Comments post via the Reviews API as one batched review using `line` + `side` (the more reliable path than hunk-relative `position`).
- The model picks the line number. It can be off by 1-2. GitHub 422s if the line isn't inside a diff hunk. Dry-run is immune (nothing is sent). This is the single biggest v1 caveat and it's already in the README.
- `event: COMMENT` always, it never blocks a PR.

## What this is NOT (the honesty calls already made)

- `skills/review-guidelines.md` is markdown injected into `systemPrompt`, read with `readFileSync`. It is not Cline's Skills primitive (`config.skills` + the `skills` tool). Don't call it a "skill" in prose.
- No webhook, no GitHub App, no queue, this is a local/CI driver, not Tier 2.
- No persistent code graph; investigation is on-demand grep/ast-grep/read.
- The judge cuts noise, it doesn't guarantee correctness.

## Verified

- Guard test: `bun run test/guard-drive.ts` gives 17/17, blocks all writes/mutating shell, allows read/search/`gh` reads, and enforces tool separation. Deterministic, no model, no cost.

## Suggested read order

`reviewer-tools.ts` (the seam) -> `main.ts` (the flow) -> `tool-guard.ts` -> `review-journal.ts` -> `skills/review-guidelines.md`.
