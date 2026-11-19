import { createHash } from "node:crypto";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

// Per request, measured in Unicode characters, including titles, links and JSON.
// Projection is rebuilt from the retained session branch after restore/compaction.
export const WEB_CONTEXT_CHARS = 16_000;
export function projectWebHistory(
	messages: ContextEvent["messages"],
): ContextEvent["messages"] {
	const seen = new Set<string>();
	const urls = new Set<string>();
	let remaining = WEB_CONTEXT_CHARS;
	const output = [...messages];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (
			message.role !== "toolResult" ||
			message.isError ||
			!["web_search", "web_read"].includes(message.toolName) ||
			message.content.length !== 1
		)
			continue;
		const content = message.content[0];
		if (content?.type !== "text") continue;
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(content.text);
		} catch {
			continue;
		}
		if (!data || typeof data !== "object") continue;
		if (message.toolName === "web_read" && Array.isArray(data.blocks)) {
			data.blocks = data.blocks.map((block) => {
				if (!block || typeof block.text !== "string") return block;
				const id = createHash("sha256").update(block.text).digest("hex");
				if (seen.has(id)) return { id, duplicate: true };
				seen.add(id);
				return { ...block, id };
			});
		}
		if (message.toolName === "web_search" && Array.isArray(data.results)) {
			data.results = data.results.map((row) => {
				if (!row || typeof row.url !== "string") return row;
				if (urls.has(row.url)) return { url: row.url, duplicate: true };
				urls.add(row.url);
				return row;
			});
		}
		let text = JSON.stringify(data);
		const chars = Array.from(text).length;
		if (chars > remaining) {
			text = JSON.stringify({
				history_omitted: true,
				url: data.url,
				offset: data.offset,
				next_offset: data.next_offset,
				query: data.query,
				backend: data.backend,
				read_again: message.toolName,
				note: "较早的公开资料已从本次请求省略，需要原文时重新调用同一工具。",
			});
		} else remaining -= chars;
		output[i] = { ...message, content: [{ type: "text", text }] };
	}
	return output;
}
