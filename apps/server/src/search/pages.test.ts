import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPage, publicPageURL } from "./pages.js";
import { projectWebHistory, WEB_CONTEXT_CHARS } from "./context.js";

test("document extraction preserves table rows and strips scripts and navigation", () => {
	const text = extractPage(
		"<html><body><nav>menu</nav><main><h1>Version</h1><table><tr><th>Version</th><th>Java</th></tr><tr><td>9</td><td>8+</td></tr></table><script>secret</script></main></body></html>",
		"text/html",
	);
	assert.match(text, /Version \| Java/);
	assert.match(text, /9 \| 8\+/);
	assert.doesNotMatch(text, /menu|secret/);
});

test("public docs reject local addresses, credential URLs, protocols and ports", async () => {
	for (const url of [
		"http://127.0.0.1/",
		"http://10.2.3.4/",
		"http://[::1]/",
		"http://[::ffff:127.0.0.1]/",
		"https://user:pass@example.com",
		"file:///etc/hosts",
		"https://example.com:8787/",
	])
		await assert.rejects(publicPageURL(url));
});

test("request projection removes duplicate passages and search hits, survives repeated projection", () => {
	const message = (id: string, body: object) => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "web_read",
		isError: false,
		content: [{ type: "text", text: JSON.stringify(body) }],
		timestamp: 1,
	});
	const originals = [
		message("1", {
			url: "https://example.com",
			blocks: [{ id: "a", text: "identical paragraph" }],
		}),
		message("2", {
			url: "https://other.example",
			blocks: [{ id: "a", text: "identical paragraph" }],
		}),
	] as never;
	const projected = projectWebHistory(originals);
	assert.equal(
		JSON.stringify(projected).split("identical paragraph").length - 1,
		1,
	);
	assert.equal(
		JSON.stringify(originals).split("identical paragraph").length - 1,
		2,
	);
	assert.deepEqual(projectWebHistory(projected), projected);
	const lots = Array.from({ length: 30 }, (_, i) =>
		message(String(i), {
			url: "https://example.com/" + i,
			offset: 0,
			blocks: [{ id: String(i), text: String(i) + "字".repeat(3500) }],
		}),
	);
	const bounded = JSON.stringify(projectWebHistory(lots as never));
	assert.ok(bounded.includes("history_omitted"));
	assert.ok(bounded.split("字").length - 1 < WEB_CONTEXT_CHARS);
});

test("page tool supports pagination, caching, cancellation, private redirects and live revocation", async (t) => {
	const { webReadTool } = await import("../tools/web-search.js");
	const { runContext } = await import("../tools/context.js");
	const { publicTransport } = await import("./public-web.js");
	let enabled = true,
		calls = 0;
	const db = {
		platform: () => ({
			getBool: async () => enabled,
			getAgentByKey: async () => ({ enabled: true, webSearch: true }),
		}),
		query: async () => ({ rows: [] }),
	} as never;
	const mock = t.mock.method(publicTransport, "fetch", async () => {
		calls++;
		return new Response("正文 paragraph\n".repeat(600), {
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	});
	const tool = webReadTool(runContext(db, 0, 0, "planner"));
	const read = async (offset = 0) =>
		tool.execute("read", { url: "https://8.8.8.8/docs", offset });
	const parse = (r: Awaited<ReturnType<typeof read>>) =>
		JSON.parse((r.content[0] as { text: string }).text);
	const first = parse(await read());
	assert.equal(first.blocks.length, 3);
	assert.equal(first.next_offset, 3);
	assert.equal(parse(await read(3)).offset, 3);
	assert.equal(parse(await read()).cached, true);
	assert.equal(calls, 1);
	enabled = false;
	assert.equal((await read()).isError, true);
	assert.equal(calls, 1);
	enabled = true;
	assert.equal(
		(
			await tool.execute(
				"cancel",
				{ url: "https://8.8.8.8/docs" },
				AbortSignal.abort(),
			)
		).isError,
		true,
	);
	mock.mock.mockImplementation(
		async () =>
			new Response("", {
				status: 302,
				headers: { location: "http://127.0.0.1/private" },
			}),
	);
	const redirect = await webReadTool(runContext(db, 0, 0, "worker")).execute(
		"redirect",
		{ url: "https://8.8.8.8/docs" },
	);
	assert.equal(redirect.isError, true);
	assert.match(JSON.stringify(redirect), /公网/);
	const reporter = await webReadTool(runContext(db, 0, 0, "reporter")).execute(
		"deny",
		{ url: "https://8.8.8.8/docs" },
	);
	assert.equal(reporter.isError, true);
});

test("search duplicate metadata replaces old excerpts without modifying persisted records", () => {
	const row = { url: "https://example.com/a", summary: "summary text" };
	const message = (id: string) => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "web_search",
		isError: false,
		content: [{ type: "text", text: JSON.stringify({ results: [row] }) }],
		timestamp: 1,
	});
	const input = [message("a"), message("b")] as never;
	const projected = JSON.stringify(projectWebHistory(input));
	assert.equal(projected.split("summary text").length - 1, 1);
	assert.match(projected, /duplicate/);
});
