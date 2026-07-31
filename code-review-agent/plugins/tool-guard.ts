import type { AgentPlugin } from "@cline/core";

const BLOCKED_TOOLS: Record<string, true> = { apply_patch: true, editor: true };

const DANGEROUS: RegExp[] = [
	/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
	/\bgit\s+(push|commit|reset|checkout|clean|merge|rebase|tag|branch\s+-D)\b/i,
	/\bgh\s+(pr\s+(review|comment|merge|close|edit|create|ready)|issue\s+(create|comment|edit|close))\b/i,
	/\bgh\s+api\b[^\n]*(-X\s*(POST|PATCH|PUT|DELETE)|--method\s*(POST|PATCH|PUT|DELETE)|\s-f\s|\s-F\s|--field)/i,
	/\bmkfs(\.\w+)?\b/i,
	/\bdd\b[^\n]*\bif=/i,
	/\bsudo\b/i,
	/:\(\)\s*\{\s*:\s*\|\s*:/,
	/\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/i,
];

function asStringArray(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	return [];
}

function extractShellCommands(input: unknown): string[] {
	if (typeof input === "string") return [input];
	if (Array.isArray(input)) return input.flatMap(extractShellCommands);
	if (input && typeof input === "object") {
		const obj = input as Record<string, unknown>;
		return [
			...asStringArray(obj.command),
			...asStringArray(obj.commands),
			...asStringArray(obj.cmd),
		];
	}
	return [];
}

const plugin: AgentPlugin = {
	name: "review-guard",
	manifest: { capabilities: ["hooks"] },
	hooks: {
		async beforeTool({ toolCall, input }) {
			if (BLOCKED_TOOLS[toolCall.toolName]) {
				return {
					skip: true,
					reason: `Blocked: the reviewer is read-only and may not use "${toolCall.toolName}". Investigate and record findings instead.`,
				};
			}

			if (toolCall.toolName === "run_commands") {
				const commands = extractShellCommands(input);
				const blocked = commands.find((c) => DANGEROUS.some((re) => re.test(c)));
				if (blocked) {
					return {
						skip: true,
						reason: `Blocked run_commands: "${blocked}" would mutate the repo or GitHub. The reviewer only reads and comments.`,
					};
				}
			}

			return undefined;
		},
	},
};

export default plugin;
