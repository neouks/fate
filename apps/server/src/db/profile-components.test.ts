import assert from "node:assert/strict";
import { test } from "node:test";
import { extractComponents, groupComponents, type ProfileAsset } from "./profile-components.js";

test("declared components keep product spelling and version and omit uncertain statements", () => {
  const text = "中间件 **InforSuiteAS V10.0.5.3.9**，数据库为 **Kingbase**。\n框架为 UnlistedStack";
  assert.deepEqual(
    extractComponents(text).map((m) => [m.name, m.version, m.references]),
    [
      ["InforSuiteAS", "V10.0.5.3.9", []],
      ["Kingbase", "", []],
      ["UnlistedStack", "", []],
    ],
  );
  for (const line of [
    "是否使用 MySQL 数据库？",
    "未发现 Kingbase 数据库",
    "计划验证数据库为 MySQL 的场景",
    "可能使用 Foo 中间件",
    "数据库为 MySQL？",
    "Error querying database.",
  ])
    assert.deepEqual(extractComponents(line), []);
});

test("asset assignments keep ambiguous, conflicting, and independent observations separate", () => {
  const assets: ProfileAsset[] = ["1", "2"].map((id) => ({
    id,
    domain: id + ".test",
    ip: "192.0.2.1",
    port: 443,
    url: null,
    type: "service",
  }));
  const record = (id: string, text: string, anchors: string[] = [], role = "用户") => ({
    source: { id, seen: "2026-11-0" + id, role, kind: "activity" as const, session: "main:0" },
    mentions: extractComponents(text),
    anchors,
  });
  const result = groupComponents(
    [
      record("1", "数据库为 MySQL", ["1"], "Worker"),
      record("2", "资产 #1 的数据库为 Kingbase"),
      record("3", "数据库为 MySQL", ["2"]),
      record("4", "框架为 NovelStack 1.2"),
      record("5", "框架为 NovelStack", ["1"]),
      record("6", "框架为 NovelStack", ["2"]),
      record("7", "资产 #999 的数据库为 OtherDB"),
      record("8", "服务 192.0.2.1:443 的数据库为 AmbiguousDB"),
    ],
    assets,
  );
  assert.deepEqual(
    result.filter((c) => c.name === "MySQL").map((c) => [c.asset_id, c.historical]),
    [
      ["2", false],
      ["1", true],
    ],
  );
  assert.equal(result.find((c) => c.name === "NovelStack" && c.version)?.asset_id, null);
  assert.equal(result.find((c) => c.name === "OtherDB")?.asset_id, null);
  assert.equal(result.find((c) => c.name === "AmbiguousDB")?.asset_id, null);
});
