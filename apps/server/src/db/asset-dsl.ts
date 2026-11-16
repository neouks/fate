/** SERIES 78ab23f asset_dsl.go: parameterized AND/OR asset queries. */
const strings: Record<string, string> = Object.fromEntries(
	"type domain root_domain ip url page_title icp service_name app_name bundle_id category app_icp method service_type record_type"
		.split(" ")
		.map((k) => [k, k]),
);
strings.title = "page_title";
const numbers: Record<string, string> = {
	port: "port",
	status: "status_code",
	status_code: "status_code",
};
const arrays: Record<string, string> = {
	technology: "technologies",
	technologies: "technologies",
	tech: "technologies",
};
const fields = new Set([...Object.keys(strings), ...Object.keys(numbers), ...Object.keys(arrays), 'task_id', 'company_id', 'tested']);
export class AssetQueryError extends Error {
	statusCode = 400;
}
export const ASSET_DSL_HELP = '字符串/数组：= 或 contains 包含匹配，== 精确匹配；字符串 != 为不包含，数组 != 为不含该精确元素。数值：=、==、!=、>、>=、<、<=。task_id/company_id 仅 =、==；tested 仅 =、==、!= true/false（任务覆盖状态）。支持空格、AND/OR、括号；值含空格时用双引号。例：url contains "sample" AND type==endpoint。常用字段：domain、ip、url、port、method、status_code、technology。';
type Token = { kind: string; field?: string; op?: string; value?: string };
export function compileAssetDSL(
	input: string,
	values: unknown[],
	alias = "a",
	coverage?: (tested: boolean) => string,
): string {
	if (!input.trim()) return "TRUE";
	const tokens: Token[] = [];
	let i = 0;
	const word = () => {
		if (input[i] === '"') {
			i++;
			let value = '';
			while (i < input.length) {
				const char = input[i++]!;
				if (char === '"') return value;
				if (char === '\\' && ['"', '\\'].includes(input[i] ?? '')) value += input[i++]!;
				else value += char;
			}
			throw new AssetQueryError("DSL 缺少结束引号");
		}
		const start = i;
		while (i < input.length && !/[\s()]/u.test(input[i]!)) i++;
		return input.slice(start, i);
	};
	while (i < input.length) {
		if (/\s/u.test(input[i]!)) {
			i++;
			continue;
		}
		if ("()".includes(input[i]!)) {
			tokens.push({ kind: input[i++]! });
			continue;
		}
		const m = /^([a-zA-Z_]\w*)(?:\s*(==|!=|>=|<=|=|>|<)|\s+(contains)\b)/i.exec(input.slice(i));
		if (m) {
			i += m[0].length;
			while (i < input.length && /\s/u.test(input[i]!)) i++;
			const value = word();
			if (!value) throw new AssetQueryError("DSL 表达式缺少值");
			tokens.push({
				kind: "value",
				field: m[1]!.toLowerCase(),
				op: (m[2] ?? m[3])!.toLowerCase(),
				value,
			});
		} else {
			const unsupported = /^([a-zA-Z_]\w*)\s+([a-zA-Z_]\w*)\b/.exec(input.slice(i));
			if (unsupported && fields.has(unsupported[1]!.toLowerCase()) && !/^(AND|OR)$/i.test(unsupported[2]!))
				throw new AssetQueryError(`DSL 不支持运算符 ${unsupported[2]}；包含匹配用 = 或 contains，精确匹配用 ==`);
			const value = word();
			tokens.push({
				kind: /^(AND|OR)$/i.test(value) ? value.toUpperCase() : "value",
				value,
			});
		}
	}
	let p = 0;
	const param = (v: unknown) => {
		values.push(v);
		return `$${values.length}`;
	};
	const integer = (v: string) => {
		if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
			throw new AssetQueryError("DSL 数值字段需要整数");
		return Number(v);
	};
	const leaf = (t: Token) => {
		const f = t.field ?? "",
			op = t.op === 'contains' ? '=' : t.op ?? "=",
			v = t.value ?? "";
		if (t.op === 'contains' && !Object.hasOwn(strings, f) && !Object.hasOwn(arrays, f))
			throw new AssetQueryError(`字段 ${f} 不支持 contains；仅字符串和数组支持包含匹配`);
		if (!f) {
			const q = param(`%${v}%`);
			return (
				"(" +
				[
					"domain",
					"root_domain",
					"ip",
					"url",
					"page_title",
					"icp",
					"service_name",
					"app_name",
					"app_description",
				]
					.map((c) => `${alias}.${c} ILIKE ${q}`)
					.concat(
						["technologies", "bound_domains"].map(
							(c) =>
								`EXISTS(SELECT 1 FROM unnest(${alias}.${c}) v WHERE v ILIKE ${q})`,
						),
					)
					.join(" OR ") +
				")"
			);
		}
		if (["task_id", "company_id"].includes(f) && !["=", "=="].includes(op))
			throw new AssetQueryError(`${f} 仅支持 =、==`);
		if (f === "task_id") return `${param(integer(v))}=ANY(${alias}.task_ids)`;
		if (f === "company_id") return `${alias}.company_id=${param(integer(v))}`;
		if (f === "tested" && coverage) {
			if (!["=", "==", "!="].includes(op) || !/^(true|false)$/i.test(v))
				throw new AssetQueryError("tested 仅支持 =、==、!=，值必须为 true 或 false");
			return coverage((v.toLowerCase() === "true") !== (op === "!="));
		}
		if (Object.hasOwn(numbers, f))
			return `${alias}.${numbers[f]} ${op === "==" ? "=" : op} ${param(integer(v))}`;
		if (Object.hasOwn(arrays, f)) {
			const col = `${alias}.${arrays[f]}`;
			if (op === "=")
				return `EXISTS(SELECT 1 FROM unnest(${col}) v WHERE v ILIKE ${param("%" + v + "%")})`;
			if (op === "==" || op === "!=")
				return `${op === "!=" ? "NOT " : ""}(${param(v)}=ANY(${col}))`;
			throw new AssetQueryError(`数组字段 ${f} 不支持 ${op}`);
		}
		if (Object.hasOwn(strings, f)) {
			if (!["=", "==", "!="].includes(op))
				throw new AssetQueryError(`字符串字段 ${f} 不支持 ${op}`);
			return `${alias}.${strings[f]} ${op === "==" ? "=" : op === "!=" ? "NOT ILIKE" : "ILIKE"} ${param(op === "==" ? v : "%" + v + "%")}`;
		}
		throw new AssetQueryError(`未知 DSL 字段: ${f}；支持字段: ${[
			...Object.keys(strings), ...Object.keys(numbers), ...Object.keys(arrays), "task_id", "company_id", ...(coverage ? ["tested"] : []),
		].join(", ")}`);
	};
	const atom = (): string => {
		const t = tokens[p++];
		if (t?.kind === "(") {
			const q = or();
			if (tokens[p++]?.kind !== ")")
				throw new AssetQueryError("DSL 缺少右括号");
			return `(${q})`;
		}
		if (t?.kind === "value") return leaf(t);
		throw new AssetQueryError("DSL 表达式不完整");
	};
	const and = (): string => {
		let q = atom();
		while (tokens[p]?.kind === "AND") {
			p++;
			q = `(${q}) AND (${atom()})`;
		}
		return q;
	};
	const or = (): string => {
		let q = and();
		while (tokens[p]?.kind === "OR") {
			p++;
			q = `(${q}) OR (${and()})`;
		}
		return q;
	};
	const sql = or();
	if (p !== tokens.length)
		throw new AssetQueryError("DSL 存在多余内容；条件之间请使用 AND/OR");
	return sql;
}
