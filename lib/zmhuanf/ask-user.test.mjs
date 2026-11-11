import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createAskUserExtension } = await jiti.import("./ask-user.ts");
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const {
  ASK_USER_OTHER, ASK_USER_SKIP, ASK_USER_SKIP_ANSWER, ASK_USER_TITLE_PREFIX,
  ASK_USER_PLACEHOLDER, ASK_USER_BATCH_PREFIX, askUserOptions, isAskUserRequest, readAskUserBatch, normalizeAskUserQuestion,
} = await jiti.import("./ask-user-protocol.ts");
let tool;
createAskUserExtension().factory({ registerTool(definition) { tool = definition; } });
const question = { question: "选择方案", options: ["方案 A", "方案 B"], recommendedOption: "方案 B" };
const params = { questions: [question] };

/** 通过统一参数在指定交互模式执行工具 */
function execute(ui, input = params, signal, mode = "tui") {
  return tool.execute("ask-1", input, signal, undefined, { hasUI: true, mode, ui });
}

/** 创建使用真实扩展交互通道的会话包装器 */
function setup(t) {
  const wrapper = new AgentSessionWrapper({
    sessionId: "ask-user-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    sessionManager: { getCwd: () => process.cwd() }, agent: { state: {} }, extensionRunner: {},
    async abort() {}, abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
  });
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, events, ui: wrapper.createExtensionUiContext() };
}

/** 向真实交互通道统一提交当前问题列表 */
async function answer(wrapper, request, selection) {
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: JSON.stringify({ answers: [selection] }) });
}

test("registers an active sequential tool with one required question-list format", () => {
  assert.equal(tool.name, "ask_user");
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.executionMode, "sequential");
  assert.notEqual(tool.defaultActive, false);
  assert.deepEqual(tool.parameters.required, ["questions"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["questions"]);
  assert.equal(tool.parameters.properties.questions.minItems, 1);
  assert.equal(Check(tool.parameters, params), true);
  assert.equal(Check(tool.parameters, question), false);
  assert.doesNotMatch([tool.description, tool.promptSnippet, tool.parameters.properties.questions.items.properties.options.description].join(" "), /Skip|Skipping|custom|按你推荐的来/i);
});

test("terminal marks only the recommendation and returns an answer list", async () => {
  const result = await execute({
    async select(title, choices) {
      assert.equal(title, `${ASK_USER_TITLE_PREFIX}${question.question}`);
      assert.deepEqual(choices, ["1. 方案 A", "★ 2. 方案 B", ASK_USER_OTHER, ASK_USER_SKIP]);
      return choices[1];
    },
  });
  assert.deepEqual(result.details, { answers: [{ questionIndex: 1, answer: "方案 B" }] });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test("recommendation schema prefers a 1-based integer and accepts matching text", () => {
  const schema = tool.parameters.properties.questions.items.properties.recommendedOption;
  assert.equal(schema.anyOf[0].type, "integer");
  assert.equal(schema.anyOf[0].minimum, 1);
  assert.equal(schema.anyOf[1].type, "string");
  assert.equal(schema.description, "Recommended option number (1-based).");
});

for (const recommendation of [1, 2, "1", "2", " 2 "]) {
  test(`recommendation ${JSON.stringify(recommendation)} marks the matching option`, async () => {
    const index = Number(recommendation) - 1;
    const result = await execute({
      async select(_title, choices) {
        assert.equal(choices[index], `★ ${index + 1}. ${question.options[index]}`);
        assert.equal(choices.filter((choice) => choice.startsWith("★ ")).length, 1);
        return choices[index];
      },
    }, { questions: [{ ...question, recommendedOption: recommendation }] });
    assert.deepEqual(result.details.answers[0], { questionIndex: 1, answer: question.options[index] });
  });
}

test("numeric option text stays authoritative across repeated normalization", () => {
  const input = { question: "选择数字", options: ["2", "1"], recommendedOption: 1 };
  const normalized = normalizeAskUserQuestion(input);
  assert.equal(normalized.recommendedOption, "2");
  assert.deepEqual(normalizeAskUserQuestion(normalized), normalized);
  assert.equal(normalizeAskUserQuestion({ ...input, recommendedOption: "1" }).recommendedOption, "1");
});

for (const recommendation of [1, "1"]) {
  test(`RPC recommendation ${JSON.stringify(recommendation)} survives request decoding and Skip`, async () => {
    const result = await execute({ async input(title, placeholder) {
      const decoded = readAskUserBatch({ method: "input", title, placeholder });
      assert.equal(decoded[0].recommendedOption, "方案 A");
      return JSON.stringify({ answers: [{ source: "skipped" }] });
    } }, { questions: [{ ...question, recommendedOption: recommendation }] }, undefined, "rpc");
    assert.deepEqual(result.details.answers[0], { questionIndex: 1, answer: "按你推荐的来" });
  });
}

test("numeric recommendation does not change the agreed Skip answer", async () => {
  const result = await execute({ async select() { return ASK_USER_SKIP; } }, { questions: [{ ...question, recommendedOption: 2 }] });
  assert.deepEqual(result.details.answers[0], { questionIndex: 1, answer: ASK_USER_SKIP_ANSWER });
});

test("does not preselect or invent a recommendation", async () => {
  let resolve;
  let completed = false;
  const pending = execute({ select: () => new Promise((done) => { resolve = done; }) }, { questions: [{ question: "选一个", options: ["A"] }] });
  pending.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  resolve("1. A");
  const result = await pending;
  assert.equal(result.details.answers[0].answer, "A");
  assert.equal("recommendedOption" in result.details.answers[0], false);
  assert.deepEqual(askUserOptions(["A"]), ["1. A", ASK_USER_OTHER, ASK_USER_SKIP]);
});

test("terminal custom input preserves option-like text and line breaks", async () => {
  const result = await execute({
    async select() { return ASK_USER_OTHER; },
    async input(title, placeholder) {
      assert.equal(title, `${ASK_USER_TITLE_PREFIX}${question.question}`);
      assert.equal(placeholder, ASK_USER_PLACEHOLDER);
      return "  自定义方案\n保留第二行  ";
    },
  });
  assert.deepEqual(result.details.answers[0], { questionIndex: 1, answer: "自定义方案\n保留第二行" });
});

for (const selected of [ASK_USER_SKIP, undefined]) {
  test(`terminal skipping select with ${String(selected)} uses the agreed answer`, async () => {
    const result = await execute({ async select() { return selected; } });
    assert.deepEqual(result.details.answers[0], { questionIndex: 1, answer: ASK_USER_SKIP_ANSWER });
  });
}

test("terminal skipping custom input also uses the exact agreed answer", async () => {
  const result = await execute({ async select() { return ASK_USER_OTHER; }, async input() { return undefined; } });
  assert.deepEqual(result.details.answers[0], { questionIndex: 1, answer: "按你推荐的来" });
});

test("blank terminal custom input asks again instead of silently choosing or skipping", async () => {
  let count = 0;
  const result = await execute({
    async select() { return ASK_USER_OTHER; },
    async input() { return ++count === 1 ? " \n " : "有效回答"; },
  });
  assert.equal(count, 2);
  assert.equal(result.details.answers[0].answer, "有效回答");
});

for (const item of [
  { ...question, question: " " }, { ...question, options: [] }, { ...question, options: [" "] },
  { ...question, options: ["A", " A "] },
  ...[-1, 0, 3, 1.5, NaN, Infinity].map((recommendedOption) => ({ ...question, recommendedOption })),
  ...["0", "3", "-1", "1.5", "1e0", "9007199254740993", "不存在", " "].map((recommendedOption) => ({ ...question, recommendedOption })),
]) {
  test(`rejects invalid questions before opening UI: ${JSON.stringify(item)}`, async () => {
    await assert.rejects(execute({ select() { assert.fail("UI must not open"); } }, { questions: [item] }));
  });
}

test("does not fabricate an answer without UI or for an unknown terminal response", async () => {
  await assert.rejects(tool.execute("ask-1", params, undefined, undefined, { hasUI: false }), /interactive/);
  await assert.rejects(execute({ async select() { return "not a choice"; } }), /Invalid answer/);
});

test("literal reserved names, numbers and stars in user options are preserved", async () => {
  const options = [ASK_USER_SKIP, ASK_USER_OTHER, "★ 1. 原文", "2. 原文", "保留\n换行"];
  for (let index = 0; index < options.length; index++) {
    const result = await execute({ async select(_title, choices) { return choices[index]; } }, { questions: [{ question: "选择", options, recommendedOption: options[index] }] });
    assert.deepEqual(result.details.answers[0], { questionIndex: 1, answer: options[index] });
  }
});

for (const phase of ["before", "select", "input"]) {
  test(`aborting terminal at ${phase} never becomes a skipped answer`, async () => {
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

test("only tagged input requests carrying a question list use the bottom panel", () => {
  const request = { type: "extension_ui_request", id: "1", method: "input", title: `${ASK_USER_TITLE_PREFIX}问题`, placeholder: `${ASK_USER_BATCH_PREFIX}${JSON.stringify(params.questions)}` };
  assert.equal(isAskUserRequest(request), true);
  assert.equal(isAskUserRequest(null), false);
  assert.equal(isAskUserRequest({ ...request, title: "普通扩展" }), false);
  assert.equal(isAskUserRequest({ ...request, method: "select", options: askUserOptions(["A"]) }), false);
  assert.equal(isAskUserRequest({ ...request, method: "confirm" }), false);
  assert.equal(isAskUserRequest({ ...request, placeholder: ASK_USER_PLACEHOLDER }), false);
  assert.equal(readAskUserBatch(request)[0].question, question.question);
});

test("reconnection replays a one-item list and submitting closes every subscriber", async (t) => {
  const { wrapper, events, ui } = setup(t);
  const pending = execute(ui, params, undefined, "rpc");
  const request = events.at(-1);
  assert.equal(isAskUserRequest(request), true);
  assert.equal(wrapper.pendingUiRequests.size, 1);
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.ok(replay.some((event) => event.id === request.id));
  await answer(wrapper, request, { source: "option", option: 1 });
  assert.equal((await pending).details.answers[0].answer, "方案 A");
  assert.equal(wrapper.pendingUiRequests.size, 0);
  assert.ok(events.some((event) => event.type === "extension_ui_closed" && event.id === request.id));
  assert.ok(replay.some((event) => event.type === "extension_ui_closed" && event.id === request.id));
  const after = [];
  wrapper.onEvent((event) => after.push(event));
  assert.equal(after.some((event) => event.id === request.id), false);
});

test("custom answers use the replayed list request and later lists get separate IDs", async (t) => {
  const { wrapper, events, ui } = setup(t);
  const first = execute(ui, params, undefined, "rpc");
  const request = events.at(-1);
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.ok(replay.some((event) => event.id === request.id));
  await answer(wrapper, request, { source: "custom", answer: "自定义" });
  assert.equal((await first).details.answers[0].answer, "自定义");
  const second = execute(ui, params, undefined, "rpc");
  const next = events.at(-1);
  assert.notEqual(next.id, request.id);
  await answer(wrapper, next, { source: "skipped" });
  assert.equal((await second).details.answers[0].answer, ASK_USER_SKIP_ANSWER);
});

test("real Stop cancels a one-item list without an answer", async (t) => {
  const { wrapper, ui } = setup(t);
  const pending = execute(ui, params, undefined, "rpc");
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await wrapper.send({ type: "abort" });
  await rejected;
  assert.equal(wrapper.pendingUiRequests.size, 0);
  assert.equal(wrapper.pendingUiResponses.size, 0);
});
