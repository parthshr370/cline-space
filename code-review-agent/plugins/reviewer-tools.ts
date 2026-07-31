import { type AgentPlugin, createTool } from "@cline/core";

export type Severity = "blocker" | "warning" | "nit";
export type Side = "RIGHT" | "LEFT";
export type Category = "bug" | "security" | "perf" | "style" | "convention";

export interface Finding {
	path: string;
	line: number;
	side: Side;
	severity: Severity;
	category: Category;
	message: string;
	suggestion?: string;
}

export const findings: Finding[] = [];
export const keptIndices = new Set<number>();

export type Phase = "review" | "judge";
let phase: Phase = "review";
export function setPhase(next: Phase): void {
	phase = next;
}
export function isToolAllowed(tool: "record_finding" | "keep_finding"): boolean {
	return tool === "record_finding" ? phase === "review" : phase === "judge";
}

const SEVERITIES: Record<Severity, true> = { blocker: true, warning: true, nit: true };
const CATEGORIES: Record<Category, true> = {
	bug: true,
	security: true,
	perf: true,
	style: true,
	convention: true,
};

const plugin: AgentPlugin = {
	name: "reviewer-tools",
	manifest: { capabilities: ["tools"] },
	setup(api) {
		api.registerTool(
			createTool({
				name: "record_finding",
				description:
					"Record ONE code review finding tied to an exact changed line. " +
					"Call once per issue. Only record real, grounded problems, not praise.",
				inputSchema: {
					type: "object",
					properties: {
						path: { type: "string", description: "File path as it appears in the PR" },
						line: { type: "number", description: "Line number in the new file (the RIGHT side)" },
						side: { type: "string", enum: ["RIGHT", "LEFT"], description: "RIGHT for added/changed lines" },
						severity: { type: "string", enum: ["blocker", "warning", "nit"] },
						category: {
							type: "string",
							enum: ["bug", "security", "perf", "style", "convention"],
						},
						message: { type: "string", description: "What is wrong and why it matters" },
						suggestion: { type: "string", description: "Optional concrete fix" },
					},
					required: ["path", "line", "severity", "category", "message"],
				},
				execute: async (raw: unknown) => {
					if (!isToolAllowed("record_finding")) {
						return { ok: false, error: "record_finding only runs in the review pass" };
					}
					const input = (raw ?? {}) as Record<string, unknown>;
					const path = typeof input.path === "string" ? input.path.trim() : "";
					const line = Number(input.line);
					const message = typeof input.message === "string" ? input.message.trim() : "";
					const severity = input.severity as Severity;
					const category = input.category as Category;

					if (!path || !message || !Number.isFinite(line) || line <= 0) {
						return { ok: false, error: "path, message, and a positive line are required" };
					}
					if (!SEVERITIES[severity]) {
						return { ok: false, error: "severity must be blocker | warning | nit" };
					}
					if (!CATEGORIES[category]) {
						return { ok: false, error: "category must be bug | security | perf | style | convention" };
					}

					const finding: Finding = {
						path,
						line: Math.trunc(line),
						side: input.side === "LEFT" ? "LEFT" : "RIGHT",
						severity,
						category,
						message,
						suggestion: typeof input.suggestion === "string" ? input.suggestion.trim() : undefined,
					};
					const index = findings.push(finding) - 1;
					return { ok: true, index };
				},
			}),
		);

		api.registerTool(
			createTool({
				name: "keep_finding",
				description:
					"Mark a recorded finding (by index) as grounded and worth posting to the PR. " +
					"Only keep findings you can defend against the diff. Anything not kept is dropped.",
				inputSchema: {
					type: "object",
					properties: {
						index: { type: "number", description: "Index returned by record_finding" },
						reason: { type: "string", description: "Why this finding is grounded and worth posting" },
					},
					required: ["index", "reason"],
				},
				execute: async (raw: unknown) => {
					if (!isToolAllowed("keep_finding")) {
						return { ok: false, error: "keep_finding only runs in the judge pass" };
					}
					const input = (raw ?? {}) as Record<string, unknown>;
					const index = Number(input.index);
					if (!Number.isInteger(index) || index < 0 || index >= findings.length) {
						return { ok: false, error: `index out of range (have ${findings.length} findings)` };
					}
					keptIndices.add(index);
					return { ok: true };
				},
			}),
		);
	},
};

export default plugin;
