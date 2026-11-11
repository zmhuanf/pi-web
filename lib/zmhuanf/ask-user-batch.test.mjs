import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createAskUserExtension } = await jiti.import("./ask-user.ts");
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const {
  ASK_USER_BATCH_PREFIX, ASK_USER_TITLE_PREFIX, ASK_USER_OTHER, ASK_USER_SKIP,
  ASK_USER_SKIP_ANSWER, isAskUserRequest, readAskUserBatch,
} = await jiti.import("./ask-user-protocol.ts");
let tool;
createAskUserExtension().factory({ registerTool(definition) { tool = definition; } });
const questions = [
  { question: "主题", options: ["浅色", "深色"], recommendedOption: 2 },
  { question: "部署", options: ["本机", "远程"] },
  { question: "日志", options: ["保留", "关闭"], recommendedOption: "保留" },
];
const selections = [{ source: "option", option: 2 }, { source: "custom", answer: "  容器\n第二行  " }, { source: "skipped" }];

/** 执行使用网页交互通道的提问工具 */
function execute(ui, params = { questions }, signal, mode = "rpc") {
  return tool.execute("batch-1", params, signal, undefined, { hasUI: true, mode, ui });
}

/** 创建可回放请求的真实会话通道 */
function setup(t) {
  const wrapper = new AgentSessionWrapper({
    sessionId: "ask-user-batch-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    sessionManager: { getCwd: () => process.cwd() }, agent: { state: {} }, extensionRunner: {},
    async abort() {}, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
  });
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, events, ui: wrapper.createExtensionUiContext() };
}

test("schema requires one question-list format for every question count", () => {
  assert.deepEqual(tool.parameters.required, ["questions"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["questions"]);
  assert.equal(tool.parameters.oneOf, undefined);
  for (const params of [{ questions }, { questions: [questions[0]] }]) assert.equal(Check(tool.parameters, params), true);
  for (const params of [{}, questions[0], { questions: [] }, { question: "缺选项" }, { questions, ...questions[0] }, { questions, recommendedOption: 1 }]) {
    assert.equal(Check(tool.parameters, params), false, JSON.stringify(params));
  }
});

test("a batch opens one standard input request and returns authoritative answers in order", async () => {
  let calls = 0;
  const result = await execute({
    async input(title, placeholder) {
      calls++;
      assert.equal(title, `${ASK_USER_TITLE_PREFIX}3 个问题`);
      const request = { type: "extension_ui_request", id: "batch", method: "input", title, placeholder };
      assert.equal(isAskUserRequest(request), true);
      const decoded = readAskUserBatch(request);
      assert.equal(decoded.length, 3);
      assert.equal(decoded[0].recommendedOption, "深色");
      return JSON.stringify({ answers: selections });
    },
    select() { assert.fail("A batch must not create a chain of selectors"); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.details.answers, [
    { questionIndex: 1, answer: "深色" },
    { questionIndex: 2, answer: "容器\n第二行" },
    { questionIndex: 3, answer: ASK_USER_SKIP_ANSWER },
  ]);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

for (const invalid of [
  { questions: [] }, { questions: null }, { questions: "bad" },
  { questions, question: "混用" }, { questions, options: ["A"] }, { questions, recommendedOption: 1 },
  { questions: [questions[0], { question: " ", options: ["A"] }] },
  { questions: [questions[0], { question: "重复选项", options: ["A", " A "] }] },
  { questions: [questions[0], { question: "错误推荐", options: ["A"], recommendedOption: 2 }] },
  { questions: [questions[0], { question: "错误选项", options: [null] }] },
]) {
  test(`validates the whole batch before opening UI: ${JSON.stringify(invalid)}`, async () => {
    await assert.rejects(execute({ input() { assert.fail("Invalid batch must not open UI"); } }, invalid));
  });
}

for (const value of [
  undefined, "not json", "null", "[]", "{}", JSON.stringify({ answers: [] }),
  ...[null, {}, { source: "option", option: 0 }, { source: "option", option: 3 }, { source: "option", option: 1.5 }, { source: "option", option: "1" }, { source: "custom", answer: " \n " }, { source: "custom", answer: 1 }, { source: "unknown" }]
    .map((answer) => JSON.stringify({ answers: [answer, ...selections.slice(1)] })),
]) {
  test(`incomplete or invalid responses never become automatic skips: ${String(value)}`, async () => {
    await assert.rejects(execute({ async input() { return value; } }));
  });
}

test("custom answers preserve reserved labels and recommendation-like text", async () => {
  for (const answer of [ASK_USER_SKIP, ASK_USER_OTHER, "ask_user:custom:原文", "★ 1. 浅色", "1. 浅色"]) {
    const result = await execute({ async input() { return JSON.stringify({ answers: [{ source: "custom", answer }] }); } }, { questions: [questions[0]] });
    assert.deepEqual(result.details.answers[0], { questionIndex: 1, answer });
  }
});

test("one question uses the same request and answer-list shape as multiple questions", async () => {
  const result = await execute({
    async input(title, placeholder) {
      assert.equal(title, `${ASK_USER_TITLE_PREFIX}1 个问题`);
      assert.equal(readAskUserBatch({ method: "input", title, placeholder }).length, 1);
      return JSON.stringify({ answers: [selections[0]] });
    },
    select() { assert.fail("One question must use the same form as a batch"); },
  }, { questions: [questions[0]] });
  assert.deepEqual(result.details, { answers: [{ questionIndex: 1, answer: "深色" }] });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test("TUI batches use standard select/input without exposing the encoded payload", async () => {
  const titles = [];
  const result = await execute({
    async select(title, choices) {
      titles.push(title);
      return titles.length === 1 ? choices[0] : titles.length === 2 ? ASK_USER_OTHER : ASK_USER_SKIP;
    },
    async input(_title, placeholder) {
      assert.doesNotMatch(placeholder, /ask_user:questions/);
      return "CLI 自定义";
    },
  }, { questions }, undefined, "tui");
  assert.deepEqual(titles, questions.map(({ question }) => `${ASK_USER_TITLE_PREFIX}${question}`));
  assert.deepEqual(result.details.answers, [
    { questionIndex: 1, answer: "浅色" },
    { questionIndex: 2, answer: "CLI 自定义" },
    { questionIndex: 3, answer: ASK_USER_SKIP_ANSWER },
  ]);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test("tag detection rejects invalid JSON, empty batches and malformed questions", () => {
  const base = { type: "extension_ui_request", id: "batch", method: "input", title: `${ASK_USER_TITLE_PREFIX}多个问题` };
  for (const payload of ["bad", "null", "[]", "[null]", '[{"question":"Q","options":[]}]']) {
    const request = { ...base, placeholder: `${ASK_USER_BATCH_PREFIX}${payload}` };
    assert.equal(readAskUserBatch(request), null);
    assert.equal(isAskUserRequest(request), false);
  }
  assert.equal(readAskUserBatch({ ...base, title: "普通输入", placeholder: `${ASK_USER_BATCH_PREFIX}${JSON.stringify(questions)}` }), null);
});

test("reconnection replays one batch and submitting closes it for every subscriber", async (t) => {
  const { wrapper, events, ui } = setup(t);
  const pending = execute(ui);
  const request = events.at(-1);
  assert.equal(request.method, "input");
  assert.equal(wrapper.pendingUiRequests.size, 1);
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.ok(replay.some((event) => event.id === request.id && readAskUserBatch(event)?.length === 3));
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: JSON.stringify({ answers: selections }) });
  assert.equal((await pending).details.answers.length, 3);
  assert.equal(wrapper.pendingUiRequests.size, 0);
  assert.ok(events.some((event) => event.type === "extension_ui_closed" && event.id === request.id));
  assert.ok(replay.some((event) => event.type === "extension_ui_closed" && event.id === request.id));
});

test("Stop cancels the real batch request without returning answers", async (t) => {
  const { wrapper, ui } = setup(t);
  const pending = execute(ui);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await wrapper.send({ type: "abort" });
  await rejected;
  assert.equal(wrapper.pendingUiRequests.size, 0);
  assert.equal(wrapper.pendingUiResponses.size, 0);
});

for (const phase of ["before", "during"]) {
  test(`abort signal takes priority over batch answers: ${phase}`, async () => {
    const controller = new AbortController();
    if (phase === "before") controller.abort();
    await assert.rejects(execute({ async input() {
      assert.equal(phase, "during");
      controller.abort();
      return JSON.stringify({ answers: selections });
    } }, { questions }, controller.signal), { name: "AbortError" });
  });
}
