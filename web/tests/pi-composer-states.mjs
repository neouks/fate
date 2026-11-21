// UI fault injection only: no real compaction/model call reaches the server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
// The in-browser mock transport does not traverse HTTP routes, so use a real
// authenticated application page and replace only the selected control endpoints.
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const origin = "http://127.0.0.1:8787",
  id = process.env.FATE_TEST_CONVERSATION;
assert.ok(id);
const key = readFileSync(process.env.FATE_TEST_JWT_KEY_FILE, "utf8").trim(),
  now = Math.floor(Date.now() / 1000);
const payload = [
  { alg: "HS256", typ: "JWT" },
  { sub: "SERIES", iat: now, exp: now + 3600 },
]
  .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
  .join(".");
const token = payload + "." + createHmac("sha256", key).update(payload).digest("base64url");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "series_token", value: token, url: origin }]);
  await ctx.addInitScript((t) => localStorage.setItem("series_token", t), token);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  let release;
  let stopped = false;
  const pending = new Promise((r) => {
    release = r;
  });
  await page.route(`**/api/conversations/${id}/controls`, async (route) => {
    if (route.request().method() === "PATCH")
      return route.fulfill({ status: 500, json: { error: "fixture save failure" } });
    const response = await route.fetch(),
      data = await response.json();
    await route.fulfill({ json: { ...data, can_compact: true } });
  });
  await page.route(`**/api/conversations/${id}/controls/compact`, async (route) => {
    await pending;
    await route.fulfill({ status: 409, json: { error: "已停止压缩，原始会话已保留" } });
  });
  await page.route(`**/api/conversations/${id}/controls/compact/stop`, async (route) => {
    stopped = true;
    await route.fulfill({ json: { status: "stopping" } });
    release();
  });
  await page.goto(`${origin}/chat?c=${id}`);
  const input = page.getByRole("textbox", { name: "会话消息", exact: true }),
    thinking = page.getByRole("combobox", { name: "切换推理强度", exact: true });
  await input.fill("停止压缩后保留此草稿");
  await page.waitForFunction(() => !document.querySelector('[aria-label="切换推理强度"]')?.disabled);
  const before = await thinking.innerText();
  await thinking.click();
  const options = page.getByRole("option");
  let alternate;
  for (let n = 0; n < (await options.count()); n++) {
    if ((await options.nth(n).getAttribute("aria-selected")) !== "true") {
      alternate = options.nth(n);
      break;
    }
  }
  assert.ok(alternate);
  await alternate.click();
  await page
    .getByText(/保存会话配置读取或保存失败/)
    .waitFor()
    .catch(async (e) => {
      console.error((await page.locator("body").innerText()).slice(-5000));
      throw e;
    });
  assert.equal(await thinking.innerText(), before);
  await page.getByRole("button", { name: "压缩上下文", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.conversation-composer [data-slot="input-group"]')?.inert === true,
  );
  assert.equal(await thinking.isDisabled(), true);
  await page.getByRole("button", { name: "停止压缩", exact: true }).click();
  await page.getByText(/已停止压缩，原始会话已保留/).waitFor();
  await page.waitForFunction(
    () => document.querySelector('.conversation-composer [data-slot="input-group"]')?.inert === false,
  );
  assert.ok(stopped);
  assert.equal(await input.inputValue(), "停止压缩后保留此草稿");
  assert.equal(await page.getByText("上下文已压缩，下一次回复后校准占用", { exact: true }).count(), 0);
  console.log("PASS save failure, compaction input lock, stop, preserved draft and no false success");
} finally {
  await browser.close();
}
