import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";

type NotifyLevel = "info" | "success" | "warning" | "error";

type AnchorRecord = {
	kind: "anchor";
	version: 1;
	name: string;
	entryId: string;
	createdAt: string;
	note?: string;
	sessionId?: string;
	usage?: {
		tokens: number | null;
		percent: number | null;
		contextWindow: number;
	};
};

type StoredAnchor = AnchorRecord & {
	recordEntryId: string;
	recordTimestamp: string;
};

const CUSTOM_TYPE = "anchor-return";
const LABEL_PREFIX = "anchor:";

const notify = (ctx: ExtensionCommandContext, message: string, level: NotifyLevel = "info") => {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	console.log(message);
};

const parseNameAndRest = (args: string): { name: string | undefined; rest: string } => {
	const trimmed = args.trim();
	if (!trimmed) return { name: undefined, rest: "" };
	const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	return {
		name: match?.[1],
		rest: match?.[2]?.trim() ?? "",
	};
};

const parseReturnArgs = (args: string): { name: string | undefined; withPath: string | undefined; summarize: boolean } => {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let name: string | undefined;
	let withPath: string | undefined;
	let summarize = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--with" || token === "-w") {
			withPath = tokens[i + 1];
			i++;
			continue;
		}
		if (token === "--summarize" || token === "--summary" || token === "-s") {
			summarize = true;
			continue;
		}
		if (!name) {
			name = token;
		}
	}

	return { name, withPath, summarize };
};

const parseDistillArgs = (args: string): { name: string | undefined; toPath: string | undefined; send: boolean } => {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let name: string | undefined;
	let toPath: string | undefined;
	let send = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--to" || token === "-t") {
			toPath = tokens[i + 1];
			i++;
			continue;
		}
		if (token === "--send") {
			send = true;
			continue;
		}
		if (!name) {
			name = token;
		}
	}

	return { name, toPath, send };
};

const isValidName = (name: string): boolean => /^[A-Za-z0-9._:-]+$/.test(name);

const isAnchorEntry = (entry: SessionEntry): entry is SessionEntry & { type: "custom"; customType: string; data: AnchorRecord } => {
	if (entry.type !== "custom") return false;
	if (entry.customType !== CUSTOM_TYPE) return false;
	const data = entry.data as Partial<AnchorRecord> | undefined;
	return data?.kind === "anchor" && typeof data.name === "string" && typeof data.entryId === "string";
};

const getLatestAnchors = (ctx: ExtensionCommandContext): StoredAnchor[] => {
	const byName = new Map<string, StoredAnchor>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (!isAnchorEntry(entry)) continue;
		byName.set(entry.data.name, {
			...entry.data,
			recordEntryId: entry.id,
			recordTimestamp: entry.timestamp,
		});
	}
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const findAnchor = (ctx: ExtensionCommandContext, name: string): StoredAnchor | undefined => {
	return getLatestAnchors(ctx).find((anchor) => anchor.name === name);
};

const formatUsage = (usage: AnchorRecord["usage"]): string => {
	if (!usage) return "usage unknown";
	const tokenText = usage.tokens === null ? "? tokens" : `${usage.tokens.toLocaleString("en-US")} tokens`;
	const percentText = usage.percent === null ? "?%" : `${usage.percent.toFixed(1)}%`;
	return `${tokenText}, ${percentText} of ${usage.contextWindow.toLocaleString("en-US")}`;
};

const buildReturnDraft = (name: string, withPath: string): string =>
	[
		`Die Exploration ab Anker \`${name}\` ist verdichtet in:`,
		"",
		`- \`${withPath}\``,
		"",
		"Bitte lies nur diese Verdichtung und arbeite von diesem schlanken Kontext weiter. Ziehe den verlassenen Explorationsast nicht als aktiven Kontext heran.",
	].join("\n");

const sanitizePathPart = (name: string): string => name.replace(/[^A-Za-z0-9._:-]+/g, "-");

const defaultDistillPath = (name: string): string =>
	`setup-paket/task-rueckmeldungen/${sanitizePathPart(name)}-rueckmeldung.md`;

const buildDistillPrompt = (name: string, toPath: string): string =>
	[
		`Bitte verdichte die aktuelle Exploration ab Anker \`${name}\` in:`,
		"",
		`- \`${toPath}\``,
		"",
		"Arbeite mit dem aktuellen Explorationsast, aber lies nicht breit neu, wenn es nicht zwingend nötig ist.",
		"Schreibe nur den wiederverwendbaren Befund in die Datei; Rohspuren, Tool-Rauschen und Nebendiskussionen nicht übernehmen.",
		"",
		"Empfohlenes Format:",
		"",
		`# Verdichtung | ${name}`,
		"",
		`Stand: ${new Date().toISOString().slice(0, 10)}`,
		"",
		"## Anlass",
		"## Ergebnis kurz",
		"## Geändert oder geprüft",
		"## Bewusst nicht gemacht",
		"## Offene Befunde",
		"## Empfohlener nächster Schritt",
		"## Rückkehr",
		"",
		"```text",
		`/return ${name} --with ${toPath}`,
		"```",
		"",
		"Danach antworte nur kurz, dass die Verdichtung geschrieben ist und der Return-Befehl bereitsteht. Führe `/return` nicht selbst aus.",
	].join("\n");

export default function (pi: ExtensionAPI) {
	pi.registerCommand("anchor", {
		description: "Set a named anchor at the current session leaf (usage: /anchor <name> [note])",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const { name, rest } = parseNameAndRest(args);
			if (!name) {
				notify(ctx, "Usage: /anchor <name> [note]", "warning");
				return;
			}
			if (!isValidName(name)) {
				notify(ctx, "Anchor names may only use letters, numbers, dot, underscore, colon and dash.", "warning");
				return;
			}

			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				notify(ctx, "Cannot set an anchor before the first session entry.", "warning");
				return;
			}

			const leafEntry = ctx.sessionManager.getEntry(leafId);
			if (!leafEntry) {
				notify(ctx, `Current leaf ${leafId} no longer exists.`, "error");
				return;
			}

			if (leafEntry.type === "message" && leafEntry.message.role === "user") {
				notify(
					ctx,
					"Current leaf is a user message. For reliable returns, set anchors after an assistant response or another complete turn.",
					"warning",
				);
				return;
			}

			const usage = ctx.getContextUsage();
			const record: AnchorRecord = {
				kind: "anchor",
				version: 1,
				name,
				entryId: leafId,
				createdAt: new Date().toISOString(),
				note: rest || undefined,
				sessionId: ctx.sessionManager.getSessionId(),
				usage: usage
					? {
							tokens: usage.tokens,
							percent: usage.percent,
							contextWindow: usage.contextWindow,
						}
					: undefined,
			};

			pi.setLabel(leafId, `${LABEL_PREFIX}${name}`);
			pi.appendEntry(CUSTOM_TYPE, record);
			notify(ctx, `Anchor '${name}' set at ${leafId} (${formatUsage(record.usage)}).`, "success");
		},
	});

	pi.registerCommand("anchors", {
		description: "List anchors in this session",
		handler: async (_args, ctx) => {
			const anchors = getLatestAnchors(ctx);
			if (anchors.length === 0) {
				notify(ctx, "No anchors in this session.", "info");
				return;
			}

			const lines = anchors.map((anchor) => {
				const exists = ctx.sessionManager.getEntry(anchor.entryId) ? "" : " [missing target]";
				const note = anchor.note ? ` — ${anchor.note}` : "";
				return `- ${anchor.name} -> ${anchor.entryId}${exists} (${formatUsage(anchor.usage)})${note}`;
			});
			notify(ctx, [`Anchors (${anchors.length}):`, ...lines].join("\n"), "info");
		},
	});

	pi.registerCommand("distill", {
		description: "Draft or send a distillation prompt for an anchor (usage: /distill <name> [--to file.md] [--send])",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const { name, toPath, send } = parseDistillArgs(args);
			if (!name) {
				notify(ctx, "Usage: /distill <name> [--to file.md] [--send]", "warning");
				return;
			}

			const anchor = findAnchor(ctx, name);
			if (!anchor) {
				notify(ctx, `No anchor named '${name}'. Use /anchors to list anchors.`, "warning");
				return;
			}

			const path = toPath ?? defaultDistillPath(name);
			const prompt = buildDistillPrompt(name, path);

			if (send) {
				if (!ctx.isIdle()) {
					notify(ctx, "Agent is busy; cannot send distill prompt now.", "warning");
					return;
				}
				pi.sendUserMessage(prompt);
				notify(ctx, `Sent distill prompt for '${name}' -> ${path}.`, "success");
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.setEditorText(prompt);
				notify(ctx, `Drafted distill prompt for '${name}' -> ${path}. Edit and send when ready.`, "success");
				return;
			}

			console.log(prompt);
		},
	});

	pi.registerCommand("return", {
		description: "Return to a named anchor (usage: /return <name> [--with file.md] [--summarize])",
		getArgumentCompletions: (prefix) => {
			const names = new Set<string>();
			// Argument completion currently has no context, so keep this intentionally empty.
			void prefix;
			return names.size > 0 ? Array.from(names).map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const { name, withPath, summarize } = parseReturnArgs(args);
			if (!name) {
				notify(ctx, "Usage: /return <name> [--with file.md]", "warning");
				return;
			}

			const anchor = findAnchor(ctx, name);
			if (!anchor) {
				notify(ctx, `No anchor named '${name}'. Use /anchors to list anchors.`, "warning");
				return;
			}

			const target = ctx.sessionManager.getEntry(anchor.entryId);
			if (!target) {
				notify(ctx, `Anchor '${name}' points to missing entry ${anchor.entryId}.`, "error");
				return;
			}

			const currentLeaf = ctx.sessionManager.getLeafId();
			if (currentLeaf === anchor.entryId) {
				notify(ctx, `Already at anchor '${name}'.`, "info");
				if (withPath && ctx.hasUI) {
					ctx.ui.setEditorText(buildReturnDraft(name, withPath));
				}
				return;
			}

			const result = await ctx.navigateTree(anchor.entryId, {
				summarize,
				customInstructions: summarize
					? [
							`Summarize the abandoned exploration branch after anchor '${name}'.`,
							"Keep only reusable decisions, findings, changed files, risks and next steps.",
							"Do not include raw tool noise or long transcripts.",
							withPath ? `The durable distillation file is: ${withPath}` : undefined,
						]
							.filter(Boolean)
							.join("\n")
					: undefined,
				label: summarize ? `return:${name}` : undefined,
			});
			if (result.cancelled) {
				notify(ctx, `Return to anchor '${name}' cancelled.`, "info");
				return;
			}

			if (withPath && ctx.hasUI) {
				ctx.ui.setEditorText(buildReturnDraft(name, withPath));
				notify(ctx, `Returned to '${name}'. Drafted continuation with ${withPath}.`, "success");
				return;
			}

			notify(ctx, `Returned to anchor '${name}' at ${anchor.entryId}${summarize ? " with branch summary" : ""}.`, "success");
		},
	});
}
