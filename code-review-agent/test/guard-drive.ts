import guard from "../plugins/tool-guard.ts";
import { setPhase, isToolAllowed } from "../plugins/reviewer-tools.ts";

const beforeTool = guard.hooks?.beforeTool;
if (!beforeTool) throw new Error("guard has no beforeTool hook");

let failures = 0;

async function check(label: string, toolName: string, input: unknown, expectSkip: boolean): Promise<void> {
	const result = (await beforeTool({ toolCall: { toolName }, input } as never)) as { skip?: boolean } | undefined;
	const skipped = Boolean(result?.skip);
	const ok = skipped === expectSkip;
	if (!ok) failures += 1;
	console.log(`${ok ? "OK  " : "FAIL"} ${label} (skip=${skipped}, expected=${expectSkip})`);
}

await check("apply_patch (write)", "apply_patch", { path: "x" }, true);
await check("editor (write)", "editor", { path: "x" }, true);
await check("rm -rf", "run_commands", { command: "rm -rf /tmp/x" }, true);
await check("git push", "run_commands", { command: "git push origin main" }, true);
await check("git commit", "run_commands", { command: "git commit -m x" }, true);
await check("gh pr review", "run_commands", { command: "gh pr review 1 --approve" }, true);
await check("gh api POST", "run_commands", { command: "gh api repos/x/y/pulls/1/reviews -X POST" }, true);
await check("sudo", "run_commands", { command: "sudo rm x" }, true);

await check("gh pr diff (read)", "run_commands", { command: "gh pr diff 1 --repo x/y" }, false);
await check("gh api GET (read)", "run_commands", { command: "gh api repos/x/y/pulls/1/files" }, false);
await check("grep (read)", "run_commands", { command: "grep -rn foo ." }, false);
await check("read_files", "read_files", { paths: ["x"] }, false);
await check("search_codebase", "search_codebase", { query: "foo" }, false);

function checkPhase(label: string, allowed: boolean, expected: boolean): void {
	const ok = allowed === expected;
	if (!ok) failures += 1;
	console.log(`${ok ? "OK  " : "FAIL"} ${label} (allowed=${allowed}, expected=${expected})`);
}

setPhase("review");
checkPhase("record_finding in review", isToolAllowed("record_finding"), true);
checkPhase("keep_finding in review", isToolAllowed("keep_finding"), false);

setPhase("judge");
checkPhase("record_finding in judge", isToolAllowed("record_finding"), false);
checkPhase("keep_finding in judge", isToolAllowed("keep_finding"), true);

console.log(failures === 0 ? "\nALL CHECKS OK" : `\nCHECKS FAILED (${failures})`);
if (failures > 0) process.exit(1);
