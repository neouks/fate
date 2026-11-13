import type { Database } from "./index.js";
const untestedDescription = "列出范围内未测资产";
const artexUntestedDescription =
	"查询【本任务及直接关联任务】范围内、还没被事实锚点覆盖的资产（关联范围只读，供你自己判断要不要补测，不代替你决策）。\n" +
	"可选按资产类型过滤：root_domain/subdomain/service/app/endpoint/ip。\n" +
	"分页：page 从 1 起、page_size 默认 10。返回 {assets:[{id,type,label}], total, page, page_size}。仅任务上下文可用。";
/** Exact default migration; disabled/custom bindings remain intentional. */
export async function migrateAssetTools(db: Database) {
	await db.transaction(async (tx) => {
		if (
			(await tx.platform().getSetting("series_asset_tools_78ab23f_v1")) ===
			"done"
		)
			return;
		const old = (
			await tx.query(
				"SELECT * FROM tools WHERE key='list_assets' AND kind='builtin'",
			)
		).rows[0];
		const agents = old?.agents ?? ["planner", "worker", "mainagent"];
		for (const [key, description] of [
			["asset_search", "检索任务资产摘要，按 DSL 或未测条件分页"],
			["asset_get", "按资产 ID 和字段组读取详情"],
		])
			await tx.query(
				`INSERT INTO tools(key,system,description,schema,agents,enabled,kind) VALUES($1,true,$2,'{}',$3,$4,'builtin') ON CONFLICT(key) DO NOTHING`,
				[key, description, JSON.stringify(agents), old?.enabled !== false],
			);
		const before = (
			await tx.query(
				"SELECT * FROM tools WHERE key IN('list_assets','list_untested_assets')",
			)
		).rows;
		await tx
			.platform()
			.setSetting("series_asset_tools_previous", JSON.stringify(before));
		for (const r of before) {
			const expected =
				r.key === "list_assets" ? "查询资产库" : untestedDescription;
			const defaults =
				r.key === "list_assets"
					? [
							["planner", "worker", "mainagent"],
							["planner", "worker", "mainagent", "pentest", "retester", "auto"],
						]
					: [["planner", "mainagent"]];
			if (
				r.system &&
				r.description === expected &&
				defaults.some((a) => JSON.stringify(a) === JSON.stringify(r.agents))
			)
				await tx.query("UPDATE tools SET agents='[]' WHERE key=$1", [r.key]);
		}
		await tx.platform().setSetting("series_asset_tools_78ab23f_v1", "done");
	});
}

/** Repair only known legacy defaults. Retain the live coverage sub-capability switch. */
export async function migrateAssetCoverageBinding(db: Database) {
	await db.transaction(async (tx) => {
		if (!(await tx.platform().insertSettingIfAbsent("asset_search_worker_coverage_v1", "done"))) return;
		await tx.query(`UPDATE tools t SET agents='["planner","mainagent","worker"]'::jsonb
			WHERE t.key='list_untested_assets' AND t.kind='builtin' AND t.system AND t.enabled
			AND t.description=ANY($1::text[])
			AND (t.agents IN ('["planner","mainagent"]'::jsonb,'["mainagent","planner"]'::jsonb)
				OR (t.agents='[]'::jsonb AND t.description=$2 AND EXISTS (
					SELECT 1 FROM settings s WHERE s.key='series_asset_tools_78ab23f_v1' AND s.value='done' AND s.updated_at=t.updated_at
				)))
			AND EXISTS (SELECT 1 FROM tools c WHERE c.key='asset_search' AND c.kind='builtin' AND c.enabled AND c.agents ? 'worker')`,
		[[untestedDescription, artexUntestedDescription], untestedDescription]);
	});
}
