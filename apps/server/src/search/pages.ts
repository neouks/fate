import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { load } from "cheerio";
import { publicTransport } from "./public-web.js";

const blocked = new BlockList();
for (const [address, bits] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
] as const)
	blocked.addSubnet(address, bits);
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");

export async function publicPageURL(raw: string): Promise<URL> {
	const url = new URL(raw);
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		(url.port && !["80", "443"].includes(url.port))
	)
		throw new Error("仅支持公开 HTTP(S) 文档");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host)
		? [{ address: host, family: isIP(host) }]
		: await lookup(host, { all: true });
	if (
		!addresses.length ||
		addresses.some(({ address, family }) =>
			family === 4
				? blocked.check(address)
				: !globalV6.check(address, "ipv6") || blocked.check(address, "ipv6"),
		)
	)
		throw new Error("文档地址必须是公网地址");
	return url;
}

export function extractPage(body: string, type: string) {
	if (!type.includes("html")) return body.trim();
	const $ = load(body);
	$("script,style,noscript,nav,footer,header,iframe,form,svg").remove();
	const main = $("main").first();
	const article = $("article").first();
	const root = main.length ? main : article.length ? article : $("body");
	root.find("tr").each((_, node) => {
		$(node).replaceWith(
			"\n" +
				$(node)
					.find("th,td")
					.toArray()
					.map((cell) => $(cell).text().replace(/\s+/g, " ").trim())
					.join(" | ") +
				"\n",
		);
	});
	root.find("br").replaceWith("\n");
	root.find("p,div,section,li,pre,h1,h2,h3,h4,h5,h6,table").append("\n\n");
	return root
		.text()
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export async function readPublicPage(raw: string, parent?: AbortSignal) {
	const timeout = AbortSignal.timeout(20_000);
	const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
	let url = await publicPageURL(raw);
	for (let hop = 0; hop < 4; hop++) {
		signal.throwIfAborted();
		const response = await publicTransport.fetch(url, {
			signal,
			redirect: "manual",
			headers: {
				"User-Agent": "PublicReferenceSearch/1.0",
				Accept: "text/html,text/plain,text/markdown",
			},
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error("正文跳转缺少地址");
			url = await publicPageURL(new URL(location, url).href);
			continue;
		}
		const type = response.headers.get("content-type") ?? "";
		if (!response.ok || !/text\/(html|plain|markdown)/i.test(type)) {
			await response.body?.cancel();
			throw new Error(
				"正文不可读取（HTTP " +
					response.status +
					"，仅支持 HTML、文本、Markdown）",
			);
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("正文为空");
		let bytes = 0;
		const chunks: Uint8Array[] = [];
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				bytes += part.value.length;
				if (bytes > 2 * 1024 * 1024) throw new Error("正文超过 2 MiB 下载限制");
				chunks.push(part.value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const charset = type.match(/charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
		const body = new TextDecoder(charset).decode(Buffer.concat(chunks));
		if (/安全验证|captcha|access denied/i.test(load(body)("title").text()))
			throw new Error("网页要求验证，未取得正文");
		const text = extractPage(body, type);
		if (!text) throw new Error("未取得可读正文");
		const version = createHash("sha256").update(text).digest("hex");
		// Paragraph boundaries let the same passage deduplicate across pages too.
		// Long paragraphs are split deterministically to bound each read.
		const blocks = [];
		for (const paragraph of text
			.split(/\n\s*\n/)
			.map((p) => p.trim())
			.filter(Boolean)) {
			const chars = Array.from(paragraph);
			for (let offset = 0; offset < chars.length; offset += 1200) {
				const content = chars.slice(offset, offset + 1200).join("");
				blocks.push({
					id: createHash("sha256").update(content).digest("hex"),
					text: content,
				});
			}
		}
		return { url: url.href, version, blocks };
	}
	throw new Error("正文跳转次数过多");
}
