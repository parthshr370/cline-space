import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClineCore } from "@cline/core";
import reviewerTools, { findings, keptIndices, setPhase, type Finding } from "./plugins/reviewer-tools.ts";
import guard from "./plugins/tool-guard.ts";
import journal, { auditLog } from "./plugins/review-journal.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDER = process.env.REVIEW_PROVIDER ?? "openai-codex";
const MODEL = process.env.REVIEW_MODEL ?? "gpt-5.5";

interface Args {
  repo?: string;
  pr?: string;
  base?: string;
  head?: string;
  cwd: string;
  post: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cwd: process.cwd(), post: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        console.error(`flag ${flag} needs a value`);
        process.exit(1);
      }
      i += 1;
      return v;
    };
    switch (flag) {
      case "--repo": args.repo = value(); break;
      case "--pr": args.pr = value(); break;
      case "--base": args.base = value(); break;
      case "--head": args.head = value(); break;
      case "--cwd": args.cwd = value(); break;
      case "--post": args.post = true; break;
      default:
        console.error(`unknown flag: ${flag}`);
        process.exit(1);
    }
  }
  return args;
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = { blocker: 0, warning: 1, nit: 2 };

function commentBody(f: Finding): string {
  const head = `**[${f.severity} · ${f.category}] cline-reviewer**`;
  const suggestion = f.suggestion ? `\n\nSuggestion: ${f.suggestion}` : "";
  return `${head}\n\n${f.message}${suggestion}`;
}

function summaryBody(kept: Finding[]): string {
  const counts: Record<Finding["severity"], number> = { blocker: 0, warning: 0, nit: 0 };
  for (const f of kept) counts[f.severity] += 1;
  if (kept.length === 0) return "cline-reviewer: no issues found in this diff.";
  return (
    `cline-reviewer found ${kept.length} issue(s): ` +
    `${counts.blocker} blocker, ${counts.warning} warning, ${counts.nit} nit.`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (Boolean(args.repo) !== Boolean(args.pr)) {
    console.error("--repo and --pr go together");
    process.exit(1);
  }
  if (Boolean(args.base) !== Boolean(args.head)) {
    console.error("--base and --head go together");
    process.exit(1);
  }
  const modeGh = Boolean(args.repo && args.pr);
  const modeLocal = Boolean(args.base && args.head);
  if (modeGh && modeLocal) {
    console.error("pick one: --repo/--pr (PR mode) or --base/--head (local mode), not both");
    process.exit(1);
  }
  if (!modeGh && !modeLocal) {
    console.error("need either --repo owner/repo --pr N, or --base X --head Y");
    process.exit(1);
  }

  if (args.repo && !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) {
    console.error(`--repo must look like owner/repo, got: ${args.repo}`);
    process.exit(1);
  }
  if (args.pr && !/^\d+$/.test(args.pr)) {
    console.error(`--pr must be a number, got: ${args.pr}`);
    process.exit(1);
  }
  const REF = /^[\w./-]+$/;
  if (args.base && !REF.test(args.base)) {
    console.error(`--base is not a valid git ref: ${args.base}`);
    process.exit(1);
  }
  if (args.head && !REF.test(args.head)) {
    console.error(`--head is not a valid git ref: ${args.head}`);
    process.exit(1);
  }

  const diffCmd = modeGh
    ? `gh pr diff ${args.pr} --repo ${args.repo}`
    : `git diff ${args.base}...${args.head}`;

  const skill = readFileSync(join(HERE, "skills", "review-guidelines.md"), "utf8");

  findings.length = 0;
  keptIndices.clear();
  auditLog.length = 0;

  const cline = await ClineCore.create({ backendMode: "local" });
  const baseConfig = {
    providerId: PROVIDER,
    modelId: MODEL,
    cwd: args.cwd,
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    extensions: [reviewerTools, guard, journal],
  };

  try {
    setPhase("review");
    console.log(`\n=== review run (${PROVIDER} / ${MODEL}) ===`);
    await cline.start({
      config: {
        ...baseConfig,
        systemPrompt:
          `${skill}\n\n` +
          "Tools: record_finding (call once per issue). read_files, search_codebase, " +
          "run_commands are read-only. You cannot write files or run write commands.",
      },
      prompt:
        `Review this change. Get the diff with: ${diffCmd}\n` +
        "Investigate the changed files and their surrounding context in the working directory. " +
        "Call record_finding for each real, grounded issue. When you have recorded every " +
        "issue, reply with a one-line summary such as 'recorded N findings' and stop calling tools.",
      interactive: false,
    });
    console.log(`[review] recorded ${findings.length} finding(s)`);

    if (findings.length === 0) {
      console.log("no findings, nothing to post.");
      return;
    }

    console.log(`\n=== judge run ===`);
    setPhase("judge");
    await cline.start({
      config: {
        ...baseConfig,
        systemPrompt:
          "You are a strict reviewer of code-review findings. Keep only findings that are " +
          "grounded in the diff and genuinely worth a human's attention. Drop noise, " +
          "false positives, duplicates, and praise. Fewer, higher-signal findings win. " +
          "You can only read; investigate with run_commands and call keep_finding for the survivors.",
        extensions: [reviewerTools, guard, journal],
      },
      prompt:
        `Candidate findings (JSON):\n${JSON.stringify(findings, null, 2)}\n\n` +
        `Re-check each against the diff with: ${diffCmd}\n` +
        "For every finding that is grounded and worth posting, call keep_finding with its index and a reason. " +
        "Do not keep anything you cannot defend against the diff.",
      interactive: false,
    });

    const kept = findings.filter((_, i) => keptIndices.has(i));
    kept.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    console.log(`[judge] kept ${kept.length} of ${findings.length} finding(s)`);
    console.log(`[audit] tools used: ${auditLog.map((a) => a.tool).join(", ") || "(none)"}`);

    const review = {
      body: summaryBody(kept),
      event: "COMMENT" as const,
      comments: kept.map((f) => ({
        path: f.path,
        line: f.line,
        side: f.side,
        body: commentBody(f),
      })),
    };

    if (!modeGh || !args.post) {
      console.log(`\n=== DRY RUN (no post) ===`);
      console.log(JSON.stringify(review, null, 2));
      if (modeLocal && !modeGh) console.log("\n(local mode has no PR to post to)");
      return;
    }

    console.log(`\n=== posting review to ${args.repo} #${args.pr} ===`);
    const reviewsPath = `repos/${args.repo}/pulls/${args.pr}/reviews`;
    const postReview = (payload: unknown): void => {
      execFileSync("gh", ["api", reviewsPath, "-X", "POST", "--input", "-"], {
        input: JSON.stringify(payload),
        stdio: ["pipe", "inherit", "inherit"],
      });
    };

    try {
      postReview(review);
      console.log("posted.");
    } catch {
      console.error("batched review failed (usually a comment line outside the diff hunk).");
      try {
        postReview({ body: review.body, event: "COMMENT" as const });
        console.log("posted summary only. these inline comments could not be attached:");
        console.log(JSON.stringify(review.comments, null, 2));
      } catch {
        console.error("summary post also failed. full review we tried to post:");
        console.log(JSON.stringify(review, null, 2));
        process.exitCode = 1;
      }
    }
  } finally {
    await cline.dispose();
  }
}

await main();
