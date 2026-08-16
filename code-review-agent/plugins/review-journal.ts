import type { AgentPlugin } from "@cline/sdk";

export interface AuditEntry {
	tool: string;
	at: string;
}

export const auditLog: AuditEntry[] = [];

const plugin: AgentPlugin = {
	name: "review-journal",
	manifest: { capabilities: ["hooks"] },
	hooks: {
		async afterTool({ toolCall }) {
			auditLog.push({ tool: toolCall.toolName, at: new Date().toISOString() });
			return undefined;
		},

		async afterRun({ result }) {
			const { status, iterations, usage } = result;
			console.log(
				`[journal] run ${status}, ${iterations} iteration(s), ` +
					`in ${usage?.inputTokens ?? 0} / out ${usage?.outputTokens ?? 0} tokens, ` +
					`cost $${(usage?.totalCost ?? 0).toFixed(6)}`,
			);
		},
	},
};

export default plugin;
