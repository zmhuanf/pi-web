import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { createJiti } from "jiti";
import * as hooks from "../../hooks/__fixtures__/react-hook-shim.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const protocol = await jiti.import("../../lib/zmhuanf/ask-user-protocol.ts");
const { AskUserPanel } = await jiti.import("./AskUserPanel.tsx");
const { createAskUserExtension } = await jiti.import("../../lib/zmhuanf/ask-user.ts");
const source = await readFile(new URL("./AskUserBatchPanel.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const componentModule = { exports: {} };
runInNewContext(outputText, {
  exports: componentModule.exports,
  require(name) {
    if (name === "react") return { ...hooks, useId: () => hooks.useRef("batch-heading").current };
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "@/lib/zmhuanf/ask-user-protocol") return protocol;
    throw new Error(`Unexpected import: ${name}`);
  },
});
const { AskUserBatchPanel } = componentModule.exports;
const questions = [
  { question: "选择主题", options: ["浅色", "深色"], recommendedOption: "深色" },
  { question: "选择部署", options: ["本机", "远程"] },
  { question: "选择日志", options: ["保留", "关闭"] },
];
const request = {
  type: "extension_ui_request", id: "batch-1", method: "input",
  title: `${protocol.ASK_USER_TITLE_PREFIX}3 个问题`,
  placeholder: `${protocol.ASK_USER_BATCH_PREFIX}${JSON.stringify(questions)}`,
};

/** 遍历组件返回的实际元素树 */
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !node.props) return [];
  return [node, ...elements(node.props.children)];
}

/** 读取元素内的可见文字 */
function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node == null || typeof node === "boolean") return "";
  return typeof node === "object" ? text(node.props?.children) : String(node);
}

/** 使用钩子模拟器驱动多题组件并收集统一提交 */
function setup(t, items = questions) {
  const responses = [];
  const props = { request, questions: items, waitingCount: 0, onRespond(current, response) { responses.push({ id: current.id, ...response }); } };
  const hook = hooks.renderHook((current) => AskUserBatchPanel(current), props);
  t.after(() => hook.unmount());
  return {
    responses, hook, props,
    get tree() { hook.flush(); return hook.result; },
    find(type) { return elements(this.tree).find((node) => node.type === type); },
    button(label) { return elements(this.tree).find((node) => node.type === "button" && text(node) === label); },
    click(label) {
      const button = this.button(label);
      assert.ok(button, `Button not found: ${label}`);
      assert.notEqual(button.props.disabled, true, `Button disabled: ${label}`);
      button.props.onClick();
      hook.flush();
    },
    type(value) { this.find("textarea").props.onChange({ target: { value } }); hook.flush(); },
    submit() { this.find("form").props.onSubmit({ preventDefault() {} }); hook.flush(); },
  };
}

test("batch starts unanswered with only previous and next navigation", (t) => {
  const panel = setup(t);
  assert.match(text(panel.tree), /第 1\/3 题 · 已回答 0\/3/);
  assert.equal(panel.button("提交").props.disabled, true);
  assert.equal(panel.button("上一题").props.disabled, true);
  assert.equal(panel.button("深色推荐").props["aria-pressed"], false);
  assert.equal(panel.find("nav"), undefined);
  assert.equal(elements(panel.tree).some((node) => node.props["aria-current"] === "step"), false);
  assert.match(panel.find("h3").props.className, /outline-none/);
  assert.equal(panel.find("h3").props.tabIndex, -1);
  assert.match(panel.button("其他：自己输入").props.className, /w-full/);
  assert.doesNotMatch(panel.button("其他：自己输入").props.className, /self-start/);
  panel.submit();
  assert.deepEqual(panel.responses, []);
});

test("choosing options advances and previous and next keep existing choices", (t) => {
  const panel = setup(t);
  panel.click("深色推荐");
  assert.equal(text(panel.find("h3")), "选择部署");
  panel.click("远程");
  assert.equal(text(panel.find("h3")), "选择日志");
  panel.click("上一题");
  assert.equal(panel.button("远程").props["aria-pressed"], true);
  panel.click("上一题");
  assert.equal(panel.button("深色推荐").props["aria-pressed"], true);
  panel.click("浅色");
  assert.equal(text(panel.find("h3")), "选择日志");
  panel.click("上一题");
  panel.click("上一题");
  assert.equal(panel.button("浅色").props["aria-pressed"], true);
  panel.click("下一题");
  assert.equal(panel.button("远程").props["aria-pressed"], true);
  assert.deepEqual(panel.responses, []);
});

test("each custom draft survives question changes, answer modes, collapse and replay", (t) => {
  const panel = setup(t);
  panel.click("其他：自己输入");
  panel.type("第一题草稿\n第二行");
  assert.match(text(panel.tree), /已回答 0\/3/);
  panel.click("下一题");
  panel.click("其他：自己输入");
  panel.type("第二题草稿");
  panel.click("上一题");
  assert.equal(panel.find("textarea").props.value, "第一题草稿\n第二行");
  panel.click("返回选项");
  panel.click("其他：自己输入");
  assert.equal(panel.find("textarea").props.value, "第一题草稿\n第二行");
  panel.click("收起");
  panel.hook.rerender({ ...panel.props, request: { ...request }, questions: structuredClone(questions), waitingCount: 2 });
  assert.equal(panel.find("section").props.children[2].props.hidden, true);
  panel.click("展开");
  assert.equal(panel.find("textarea").props.value, "第一题草稿\n第二行");
  panel.click("下一题");
  assert.equal(panel.find("textarea").props.value, "第二题草稿");
  assert.deepEqual(panel.responses, []);
});

test("empty custom input cannot advance and skip advances without discarding the draft", (t) => {
  const panel = setup(t);
  panel.click("其他：自己输入");
  panel.type(" \n ");
  assert.equal(panel.button("下一题").props.disabled, true);
  assert.equal(panel.button("提交").props.disabled, true);
  panel.click("跳过");
  assert.equal(text(panel.find("h3")), "选择部署");
  assert.match(text(panel.tree), /已回答 1\/3/);
  panel.click("上一题");
  assert.equal(panel.button("跳过").props["aria-pressed"], true);
  assert.equal(panel.find("textarea").props.value, " \n ");
  panel.type("有效回答");
  assert.equal(panel.button("跳过").props["aria-pressed"], false);
  assert.match(text(panel.tree), /已回答 0\/3/);
  panel.click("下一题");
  assert.match(text(panel.tree), /已回答 1\/3/);
});

test("the final option automatically submits every answer in order only once", (t) => {
  const panel = setup(t);
  panel.click("下一题");
  panel.click("其他：自己输入");
  panel.type("  容器\n第二行  ");
  panel.click("下一题");
  panel.click("跳过");
  assert.equal(text(panel.find("h3")), "选择主题");
  assert.deepEqual(panel.responses, []);
  const lastOption = panel.button("深色推荐");
  panel.click("深色推荐");
  lastOption.props.onClick();
  panel.submit();
  assert.equal(panel.responses.length, 1);
  assert.equal(panel.responses[0].id, request.id);
  assert.deepEqual(JSON.parse(panel.responses[0].value), { answers: [
    { source: "option", option: 2 }, { source: "custom", answer: "容器\n第二行" }, { source: "skipped" },
  ] });
});

test("the final skip automatically submits even without a recommendation", (t) => {
  const panel = setup(t);
  panel.click("浅色");
  panel.click("远程");
  panel.click("跳过");
  assert.equal(panel.responses.length, 1);
  assert.deepEqual(JSON.parse(panel.responses[0].value).answers, [
    { source: "option", option: 1 }, { source: "option", option: 2 }, { source: "skipped" },
  ]);
});

for (const confirmation of ["next", "submit"]) {
  test(`the final custom answer waits for explicit ${confirmation} confirmation`, (t) => {
    const panel = setup(t);
    panel.click("浅色");
    panel.click("远程");
    panel.click("其他：自己输入");
    panel.type("最后一题");
    panel.type("最后一题继续输入\n第二行");
    assert.match(text(panel.tree), /已回答 2\/3/);
    assert.equal(panel.button("提交").props.disabled, false);
    assert.equal(panel.button("下一题").props.disabled, false);
    assert.deepEqual(panel.responses, []);
    if (confirmation === "next") panel.click("下一题");
    else panel.submit();
    assert.equal(panel.responses.length, 1);
    assert.deepEqual(JSON.parse(panel.responses[0].value).answers[2], { source: "custom", answer: "最后一题继续输入\n第二行" });
  });
}

test("answering another question cannot submit an unconfirmed custom draft", (t) => {
  const panel = setup(t);
  panel.click("下一题");
  panel.click("其他：自己输入");
  panel.type("未确认草稿");
  panel.click("上一题");
  panel.click("浅色");
  assert.equal(text(panel.find("h3")), "选择部署");
  panel.click("返回选项");
  panel.click("下一题");
  panel.click("保留");
  assert.equal(text(panel.find("h3")), "选择部署");
  panel.click("其他：自己输入");
  assert.equal(panel.find("textarea").props.value, "未确认草稿");
  assert.deepEqual(panel.responses, []);
  panel.click("下一题");
  assert.equal(panel.responses.length, 1);
});

test("editing a confirmed custom answer requires confirmation again", (t) => {
  const panel = setup(t);
  panel.click("其他：自己输入");
  panel.type("初稿");
  panel.click("下一题");
  panel.click("上一题");
  panel.type("改稿");
  assert.match(text(panel.tree), /已回答 0\/3/);
  panel.click("下一题");
  panel.click("远程");
  panel.click("保留");
  assert.equal(JSON.parse(panel.responses[0].value).answers[0].answer, "改稿");
});

test("Ctrl Enter submits only a complete batch and ignores IME composition", (t) => {
  const panel = setup(t);
  panel.click("其他：自己输入");
  panel.type("自定义");
  let submissions = 0;
  const keydown = panel.find("textarea").props.onKeyDown;
  const event = { key: "Enter", ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, currentTarget: { form: { requestSubmit() { submissions++; panel.submit(); } } }, preventDefault() {} };
  keydown(event);
  keydown({ ...event, ctrlKey: true, nativeEvent: { isComposing: true } });
  assert.equal(submissions, 0);
  keydown({ ...event, ctrlKey: true });
  assert.equal(submissions, 1);
  assert.deepEqual(panel.responses, []);
  panel.click("返回选项");
  panel.click("下一题");
  panel.click("本机");
  panel.click("跳过");
  panel.click("其他：自己输入");
  panel.find("textarea").props.onKeyDown({ ...event, metaKey: true });
  assert.equal(panel.responses.length, 1);
});

for (const mode of ["option", "skip"]) {
  test(`a single ${mode} answer automatically submits only once`, (t) => {
    const panel = setup(t, [questions[0]]);
    const label = mode === "option" ? "浅色" : "跳过";
    assert.deepEqual(panel.responses, []);
    panel.click(label);
    assert.deepEqual(panel.responses, [{ id: request.id, value: JSON.stringify({ answers: [
      mode === "option" ? { source: "option", option: 1 } : { source: "skipped" },
    ] }) }]);
    assert.equal(panel.button("下一题").props.disabled, true);
    panel.click(label);
    panel.submit();
    assert.equal(panel.responses.length, 1);
  });
}

test("a single custom answer waits for manual submission", (t) => {
  const panel = setup(t, [questions[0]]);
  panel.click("其他：自己输入");
  panel.type("手动确认");
  assert.deepEqual(panel.responses, []);
  assert.equal(panel.button("下一题").props.disabled, true);
  assert.equal(panel.button("提交").props.disabled, false);
  panel.submit();
  panel.submit();
  assert.deepEqual(panel.responses, [{ id: request.id, value: JSON.stringify({ answers: [{ source: "custom", answer: "手动确认" }] }) }]);
});

test("the real panel routes automatic submission back through the real tool", async (t) => {
  const panel = setup(t);
  panel.click("浅色");
  panel.click("远程");
  panel.click("跳过");
  let tool;
  createAskUserExtension().factory({ registerTool(definition) { tool = definition; } });
  const result = await tool.execute("batch-ui", { questions }, undefined, undefined, {
    hasUI: true, mode: "rpc", ui: { async input() { return panel.responses[0].value; } },
  });
  assert.deepEqual(result.details.answers.map(({ answer }) => answer), ["浅色", "远程", "按你推荐的来"]);
});

test("parent routes batches without exposing transport data or numbered navigation", () => {
  const html = renderToStaticMarkup(React.createElement(AskUserPanel, { request, waitingCount: 0, onRespond() {} }));
  assert.match(html, /第 1\/3 题/);
  assert.match(html, /选择主题/);
  assert.match(html, />提交<\/button>/);
  assert.doesNotMatch(html, /ask_user:questions|recommendedOption|<textarea|<nav|aria-current|提交全部回答/);
  const single = { ...request, placeholder: `${protocol.ASK_USER_BATCH_PREFIX}${JSON.stringify([questions[0]])}` };
  const one = renderToStaticMarkup(React.createElement(AskUserPanel, { request: single, waitingCount: 0, onRespond() {} }));
  assert.match(one, /第 1\/1 题/);
  assert.match(one, />提交<\/button>/);
});

test("question and option markup stay escaped and layout follows the composer", () => {
  const tagged = { ...request, placeholder: `${protocol.ASK_USER_BATCH_PREFIX}${JSON.stringify([{ question: "<script>alert(1)</script>", options: ["<img src=x onerror=alert(1)>"] }])}` };
  const html = renderToStaticMarkup(React.createElement(AskUserPanel, { request: tagged, waitingCount: 0, onRespond() {} }));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /px-4 min-\[641px\]:pr-\[52px\]/);
  assert.match(html, /max-width:var\(--chat-content-max-width, 820px\)/);
});
