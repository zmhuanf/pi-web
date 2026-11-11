import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createAskUserExtension } = await jiti.import("./ask-user.ts");
const { ASK_USER_SKIP, ASK_USER_OTHER, readAskUserBatch } = await jiti.import("./ask-user-protocol.ts");
let tool;
createAskUserExtension().factory({ registerTool(definition) { tool = definition; } });
const params = { questions: [{ question: "原问题", options: ["A", "B"], recommendedOption: "B" }] };

/** 在同一个列表请求中提交自定义回答 */
function execute(value, signal) {
  return tool.execute("ask-custom", params, signal, undefined, {
    hasUI: true, mode: "rpc",
    ui: {
      async input(title, placeholder) {
        assert.equal(readAskUserBatch({ method: "input", title, placeholder }).length, 1);
        return JSON.stringify({ answers: [{ source: "custom", answer: value }] });
      },
      select() { assert.fail("Web questions must use the unified list input"); },
    },
  });
}

for (const value of ["普通回答", "第一行\n第二行", ASK_USER_SKIP, ASK_USER_OTHER, "ask_user:custom:原文", "A"]) {
  test(`custom answer stays literal: ${JSON.stringify(value)}`, async () => {
    const result = await execute(value);
    assert.deepEqual(result.details, { answers: [{ questionIndex: 1, answer: value }] });
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  });
}

test("custom submission trims surrounding whitespace", async () => {
  assert.equal((await execute("  回答\n第二行  ")).details.answers[0].answer, "回答\n第二行");
});

test("empty custom submissions are rejected instead of silently skipping", async () => {
  await assert.rejects(execute(""), /Invalid question answer/);
  await assert.rejects(execute(" \n "), /Invalid question answer/);
});

test("Stop takes priority over a custom answer arriving at the same time", async () => {
  const controller = new AbortController();
  const pending = execute("不应采用的回答", controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
