import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { AskUserPanel } = await jiti.import("./AskUserPanel.tsx");
const { ASK_USER_TITLE_PREFIX, ASK_USER_BATCH_PREFIX } = await jiti.import("../../lib/zmhuanf/ask-user-protocol.ts");
const questions = [{ question: "选择方案", options: ["方案 A", "方案 B"], recommendedOption: "方案 B" }];
const request = {
  type: "extension_ui_request", id: "ask-1", method: "input",
  title: `${ASK_USER_TITLE_PREFIX}1 个问题`,
  placeholder: `${ASK_USER_BATCH_PREFIX}${JSON.stringify(questions)}`,
};

/** 渲染实际底部提问组件 */
function render(value = request, waitingCount = 0) {
  return renderToStaticMarkup(React.createElement(AskUserPanel, { request: value, waitingCount, onRespond() {} }));
}

test("a one-item list shows options, recommendation, custom input and skip without default selection", () => {
  const html = render(request, 2);
  assert.match(html, /第 1\/1 题/);
  assert.match(html, /选择方案/);
  assert.match(html, /方案 A/);
  assert.match(html, /方案 B/);
  assert.match(html, />推荐<\/span>/);
  assert.match(html, /其他：自己输入/);
  assert.match(html, />跳过<\/button>/);
  assert.match(html, /另有 2 项等待处理/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, />收起<\/button>/);
  assert.doesNotMatch(html, /ask_user · |★ |role="dialog"|aria-modal|aria-pressed="true"/);
});

test("missing recommendation never marks a choice", () => {
  const placeholder = `${ASK_USER_BATCH_PREFIX}${JSON.stringify([{ question: "选择", options: ["A", "B"] }])}`;
  assert.doesNotMatch(render({ ...request, placeholder }), />推荐<\/span>/);
});

test("one-item and multi-item lists initially disable submission until answered", () => {
  for (const items of [questions, [...questions, { question: "下一题", options: ["A"] }]]) {
    const html = render({ ...request, placeholder: `${ASK_USER_BATCH_PREFIX}${JSON.stringify(items)}` });
    assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
    assert.match(html, />提交<\/button>/);
    assert.doesNotMatch(html, /<nav|aria-current|提交全部回答/);
    assert.doesNotMatch(html, /<textarea|ask_user:questions/);
  }
});

test("ordinary or old untagged extension requests keep their standard UI", () => {
  assert.equal(render(null), "");
  assert.equal(render({ ...request, title: "普通输入框" }), "");
  assert.equal(render({ ...request, method: "confirm" }), "");
  assert.equal(render({ ...request, method: "select", options: ["A"] }), "");
  assert.equal(render({ ...request, placeholder: "请输入你的回答" }), "");
});

test("question and option markup is displayed as text", () => {
  const placeholder = `${ASK_USER_BATCH_PREFIX}${JSON.stringify([{ question: "<script>alert(1)</script>", options: ["<img src=x onerror=alert(1)>"] }])}`;
  const html = render({ ...request, placeholder });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script|<img/);
});

test("panel spacing follows the composer gutters and configurable maximum width", () => {
  const html = render();
  assert.match(html, /px-4 min-\[641px\]:pr-\[52px\]/);
  assert.match(html, /max-width:var\(--chat-content-max-width, 820px\)/);
  assert.doesNotMatch(html, /width:calc\(100% - 32px\)/);
});

test("the bridge places questions above the composer and leaves normal dialogs intact", async () => {
  const source = await readFile(new URL("../ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(source, /extensionDialog && !isAskUserRequest\(extensionDialog\) && \(\s*<ExtensionDialog/);
  assert.match(source, /<AskUserPanel key=\{extensionDialog\?\.id\}[^\n]+\/>\s*\{chatInputElement\}/);
});
