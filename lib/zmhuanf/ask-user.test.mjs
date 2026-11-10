import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createAskUserExtension } = await jiti.import("./ask-user.ts");
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const {
  ASK_USER_OTHER, ASK_USER_SKIP, ASK_USER_SKIP_ANSWER, ASK_USER_TITLE_PREFIX,
  ASK_USER_PLACEHOLDER, askUserOptions, isAskUserRequest,
} = await jiti.import("./ask-user-protocol.ts");
let tool;
createAskUserExtension().factory({ registerTool(definition) { tool = definition; } });
const params = { question: "选择方案", options: ["方案 A", "方案 B"], recommendedOption: "方案 B" };

/** 通过工具定义执行单次提问 */
function execute(ui, input = params, signal) {
  return tool.execute("ask-1", input, signal, undefined, { hasUI: true, ui });
}

/** 创建使用真实扩展交互通道的会话包装器 */
function setup(t) {
  const inner = {
    sessionId: "ask-user-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    sessionManager: { getCwd: () => process.cwd() },
    agent: { state: {} },
    extensionRunner: {},
    async abort() {},
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, events, ui: wrapper.createExtensionUiContext() };
}

/** 向真实交互通道回复当前问题 */
async function answer(wrapper, request, response) {
  await wrapper.send({ type: "extension_ui_response", id: request.id, ...response });
}

test("registers an active model-facing sequential question tool", () => {
  assert.equal(tool.name, "ask_user");
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.executionMode, "sequential");
  assert.notEqual(tool.defaultActive, false);
  assert.deepEqual(tool.parameters.required, ["question", "options"]);
});

test("marks only the recommendation and returns the original answer", async () => {
  const result = await execute({
    async select(title, choices) {
      assert.equal(title, `${ASK_USER_TITLE_PREFIX}${params.question}`);
      assert.deepEqual(choices, ["1. 方案 A", "★ 2. 方案 B", ASK_USER_OTHER, ASK_USER_SKIP]);
      return choices[1];
    },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "方案 B" }]);
  assert.deepEqual(result.details, { question: "选择方案", answer: "方案 B", source: "option", recommendedOption: "方案 B" });
});

test("recommendation schema prefers a 1-based integer and accepts legacy text", () => {
  const schema = tool.parameters.properties.recommendedOption;
  assert.equal(schema.anyOf[0].type, "integer");
  assert.equal(schema.anyOf[0].minimum, 1);
  assert.equal(schema.anyOf[1].type, "string");
});

for (const recommendation of [1, 2]) {
  test(`numeric recommendation ${recommendation} marks the matching option`, async () => {
    const result = await execute({
      async select(_title, choices) {
        assert.equal(choices[recommendation - 1], `★ ${recommendation}. ${params.options[recommendation - 1]}`);
        assert.equal(choices.filter((choice) => choice.startsWith("★ ")).length, 1);
        return choices[recommendation - 1];
      },
    }, { ...params, recommendedOption: recommendation });
    assert.equal(result.content[0].text, params.options[recommendation - 1]);
    assert.equal(result.details.recommendedOption, params.options[recommendation - 1]);
  });
}

test("numeric recommendation does not change the agreed Skip answer", async () => {
  const result = await execute({ async select() { return ASK_USER_SKIP; } }, { ...params, recommendedOption: 2 });
  assert.equal(result.content[0].text, ASK_USER_SKIP_ANSWER);
  assert.equal(result.details.source, "skipped");
  assert.equal(result.details.recommendedOption, "方案 B");
});

test("does not preselect or invent a recommendation", async () => {
  let resolve;
  let completed = false;
  const pending = execute({ select: () => new Promise((done) => { resolve = done; }) }, { question: "选一个", options: ["A"] });
  pending.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  resolve("1. A");
  const result = await pending;
  assert.equal(result.details.answer, "A");
  assert.equal("recommendedOption" in result.details, false);
  assert.deepEqual(askUserOptions(["A"]), ["1. A", ASK_USER_OTHER, ASK_USER_SKIP]);
});

test("custom input is returned without treating option-like text as a choice", async () => {
  const result = await execute({
    async select() { return ASK_USER_OTHER; },
    async input(title, placeholder) {
      assert.equal(title, `${ASK_USER_TITLE_PREFIX}${params.question}`);
      assert.equal(placeholder, ASK_USER_PLACEHOLDER);
      return "  自定义方案\n保留第二行  ";
    },
  });
  assert.equal(result.details.source, "custom");
  assert.equal(result.content[0].text, "自定义方案\n保留第二行");
});

for (const selected of [ASK_USER_SKIP, undefined]) {
  test(`skipping select with ${String(selected)} uses the exact agreed answer`, async () => {
    const result = await execute({ async select() { return selected; } });
    assert.equal(result.content[0].text, ASK_USER_SKIP_ANSWER);
    assert.equal(result.details.source, "skipped");
  });
}

test("skipping custom input also uses the exact agreed answer", async () => {
  const result = await execute({ async select() { return ASK_USER_OTHER; }, async input() { return undefined; } });
  assert.equal(result.content[0].text, "按你推荐的来");
  assert.equal(result.details.source, "skipped");
});

test("blank custom input asks again instead of silently choosing or skipping", async () => {
  let count = 0;
  const result = await execute({
    async select() { return ASK_USER_OTHER; },
    async input() { return ++count === 1 ? " \n " : "有效回答"; },
  });
  assert.equal(count, 2);
  assert.equal(result.content[0].text, "有效回答");
});

for (const input of [
  { ...params, question: " " },
  { ...params, options: [] },
  { ...params, options: [" "] },
  { ...params, options: ["A", " A "] },
  ...[-1, 0, 3, 1.5, NaN, Infinity].map((recommendedOption) => ({ ...params, recommendedOption })),
  { ...params, recommendedOption: "2" },
  { ...params, recommendedOption: "不存在" },
  { ...params, recommendedOption: " " },
]) {
  test(`rejects invalid arguments before opening UI: ${JSON.stringify(input)}`, async () => {
    await assert.rejects(execute({ select() { assert.fail("UI must not open"); } }, input));
  });
}

test("does not fabricate an answer without UI or for an unknown response", async () => {
  await assert.rejects(tool.execute("ask-1", params, undefined, undefined, { hasUI: false }), /interactive/);
  await assert.rejects(execute({ async select() { return "not a choice"; } }), /Invalid answer/);
});

test("literal reserved names, numbers and stars in user options are preserved", async () => {
  const options = [ASK_USER_SKIP, ASK_USER_OTHER, "★ 1. 原文", "2. 原文", "保留\n换行"];
  for (let index = 0; index < options.length; index++) {
    const result = await execute({ async select(_title, choices) { return choices[index]; } }, { question: "选择", options, recommendedOption: options[index] });
    assert.equal(result.details.source, "option");
    assert.equal(result.content[0].text, options[index]);
  }
});

for (const phase of ["before", "select", "input"]) {
  test(`aborting at ${phase} never becomes a skipped answer`, async () => {
    const controller = new AbortController();
    if (phase === "before") controller.abort();
    await assert.rejects(execute({
      async select() {
        if (phase === "before") assert.fail("Already aborted");
        if (phase === "select") controller.abort();
        return phase === "input" ? ASK_USER_OTHER : undefined;
      },
      async input() { controller.abort(); return undefined; },
    }, params, controller.signal), { name: "AbortError" });
  });
}

test("only tagged standard select/input requests use the bottom panel", () => {
  const request = { type: "extension_ui_request", id: "1", method: "select", title: `${ASK_USER_TITLE_PREFIX}问题`, options: askUserOptions(["A"]) };
  assert.equal(isAskUserRequest(request), true);
  assert.equal(isAskUserRequest(null), false);
  assert.equal(isAskUserRequest({ ...request, title: "普通扩展" }), false);
  assert.equal(isAskUserRequest({ ...request, options: ["A"] }), false);
  assert.equal(isAskUserRequest({ ...request, options: ["bad", ASK_USER_OTHER, ASK_USER_SKIP] }), false);
  assert.equal(isAskUserRequest({ ...request, method: "confirm" }), false);
  assert.equal(isAskUserRequest({ ...request, method: "input", placeholder: ASK_USER_PLACEHOLDER }), true);
  assert.equal(isAskUserRequest({ ...request, method: "input", placeholder: "其他输入" }), false);
});

test("reconnection replays the unanswered question and answering closes every subscriber", async (t) => {
  const { wrapper, events, ui } = setup(t);
  const pending = execute(ui);
  const request = events.at(-1);
  assert.equal(isAskUserRequest(request), true);
  assert.equal(wrapper.pendingUiRequests.size, 1);
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.ok(replay.some((event) => event.id === request.id));
  await answer(wrapper, request, { value: request.options[0] });
  assert.equal((await pending).content[0].text, "方案 A");
  assert.equal(wrapper.pendingUiRequests.size, 0);
  assert.ok(events.some((event) => event.type === "extension_ui_closed" && event.id === request.id));
  assert.ok(replay.some((event) => event.type === "extension_ui_closed" && event.id === request.id));
  const after = [];
  wrapper.onEvent((event) => after.push(event));
  assert.equal(after.some((event) => event.id === request.id), false);
});

test("custom input reconnects and consecutive questions keep separate request IDs", async (t) => {
  const { wrapper, events, ui } = setup(t);
  const first = execute(ui);
  const select = events.at(-1);
  await answer(wrapper, select, { value: ASK_USER_OTHER });
  const input = events.at(-1);
  assert.equal(input.method, "input");
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.ok(replay.some((event) => event.id === input.id));
  await answer(wrapper, input, { value: "自定义" });
  assert.equal((await first).content[0].text, "自定义");
  const second = execute(ui);
  const next = events.at(-1);
  assert.notEqual(next.id, select.id);
  assert.notEqual(next.id, input.id);
  await answer(wrapper, next, { value: ASK_USER_SKIP });
  assert.equal((await second).content[0].text, ASK_USER_SKIP_ANSWER);
});

for (const phase of ["select", "input"]) {
  test(`real Stop cancels a question in ${phase} without an answer`, async (t) => {
    const { wrapper, events, ui } = setup(t);
    const pending = execute(ui);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    if (phase === "input") await answer(wrapper, events.at(-1), { value: ASK_USER_OTHER });
    await wrapper.send({ type: "abort" });
    await rejected;
    assert.equal(wrapper.pendingUiRequests.size, 0);
    assert.equal(wrapper.pendingUiResponses.size, 0);
  });
}
