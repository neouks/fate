import test from "node:test";
import assert from "node:assert/strict";
import { systemSettingsURL, settingsSection, legacySettingsSection, SYSTEM_SETTING_KEYS } from "./system-settings.ts";
test("opening, switching and closing settings preserves task/session/graph locations", () => {
  const original =
    "/function/tasks/detail?id=4846&tab=sessions&intent=32366&session=intent%3A32366&activity=4#evidence";
  const open = systemSettingsURL(original, "agents", "worker");
  const switchTab = systemSettingsURL(open, "mcp");
  assert.equal(systemSettingsURL(switchTab, null), original);
  assert.equal(new URL(open, "http://local").searchParams.get("settingsAgent"), "worker");
  assert.equal(new URL(switchTab, "http://local").searchParams.has("settingsAgent"), false);
});
test("old system links have a modal destination; unrelated links are not intercepted", () => {
  for (const key of SYSTEM_SETTING_KEYS.filter((k) => k !== "appearance"))
    assert.equal(legacySettingsSection(`/system/${key}/`), key);
  assert.equal(legacySettingsSection("/system/agents/detail"), "agents");
  for (const p of ["/function/tasks", "https://remote/system/llm", "/system/unknown"])
    assert.equal(legacySettingsSection(p), null);
});
test("invalid categories fall back safely; model alias and encoded agent keys work", () => {
  assert.equal(settingsSection("model"), "llm");
  assert.equal(settingsSection("constructor"), "llm");
  assert.equal(settingsSection(null), "llm");
  const p = new URL(systemSettingsURL("/function/tasks", "agents", "custom & 中文"), "http://local").searchParams;
  assert.equal(p.get("settingsAgent"), "custom & 中文");
  assert.equal(p.getAll("settings").length, 1);
});
