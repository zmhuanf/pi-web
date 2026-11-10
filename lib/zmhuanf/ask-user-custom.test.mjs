import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createAskUserExtension } = await jiti.import("./ask-user.ts");
const { ASK_USER_CUSTOM_PREFIX, ASK_USER_SKIP, ASK_USER_OTHER } = await jiti.import("./ask-user-protocol.ts");
let tool;
createAskUserExtension().factory({ registerTool(definition) { tool = definition; } });
const params = { question: "原问题", options: ["A", "B"], recommendedOption: "B" };

/** 直接回复网页在原选择请求中提交的自定义回答 */
function execute(value, signal) {
  return tool.execute("ask-custom", params, signal, undefined, {
    hasUI: true,
    ui: {
      async select() { return `${ASK_USER_CUSTOM_PREFIX}${value}`; },
      input() { assert.fail("Web custom answers must not open a second input request"); },
    },
  });
}

for (const value of ["普通回答", "第一行\n第二行", ASK_USER_SKIP, ASK_USER_OTHER, `${ASK_USER_CUSTOM_PREFIX}原文`, "A"]) {
  test(`custom answer stays literal: ${JSON.stringify(value)}`, async () => {
    const result = await execute(value);
    assert.equal(result.content[0].text, value);
    assert.deepEqual(result.details, { question: "原问题", answer: value, source: "custom", recommendedOption: "B" });
  });
}

test("custom submission trims surrounding whitespace", async () => {
  assert.equal((await execute("  回答\n第二行  ")).content[0].text, "回答\n第二行");
});

test("empty custom submissions are rejected instead of silently skipping", async () => {
  await assert.rejects(execute(""), /must not be blank/);
  await assert.rejects(execute(" \n "), /must not be blank/);
});

test("Stop takes priority over a custom answer arriving at the same time", async () => {
  const controller = new AbortController();
  const pending = execute("不应采用的回答", controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
