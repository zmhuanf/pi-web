import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { AskUserPanel } = await jiti.import("./AskUserPanel.tsx");
const { ASK_USER_TITLE_PREFIX, ASK_USER_PLACEHOLDER, askUserOptions } = await jiti.import("../../lib/zmhuanf/ask-user-protocol.ts");
const request = {
  type: "extension_ui_request", id: "ask-1", method: "select",
  title: `${ASK_USER_TITLE_PREFIX}选择方案`,
  options: askUserOptions(["方案 A", "方案 B"], "方案 B"),
};

/** 渲染实际底部提问组件 */
function render(value = request, waitingCount = 0) {
  return renderToStaticMarkup(React.createElement(AskUserPanel, { request: value, waitingCount, onRespond() {} }));
}

test("shows question, every option, a recommendation, custom input and skip", () => {
  const html = render(request, 2);
  assert.match(html, /选择方案/);
  assert.match(html, /方案 A/);
  assert.match(html, /方案 B/);
  assert.match(html, />推荐<\/span>/);
  assert.match(html, /其他：自己输入/);
  assert.match(html, />跳过<\/button>/);
  assert.match(html, /另有 2 项等待处理/);
  assert.equal(html.match(/<button/g).length, 5);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, />收起<\/button>/);
  assert.doesNotMatch(html, /ask_user · |★ |role="dialog"|aria-modal|aria-pressed="true"/);
});

test("missing recommendation never marks a choice", () => {
  assert.doesNotMatch(render({ ...request, options: askUserOptions(["A", "B"]) }), />推荐<\/span>/);
});

test("custom input has a labelled textarea, disabled empty submit and skip", () => {
  const html = render({ ...request, id: "input-1", method: "input", placeholder: ASK_USER_PLACEHOLDER });
  assert.match(html, /<textarea[^>]*aria-label="你的回答"/);
  assert.match(html, /placeholder="请输入你的回答"/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(html, /提交回答/);
  assert.match(html, /跳过/);
});

test("ordinary extension requests keep their original UI", () => {
  assert.equal(render(null), "");
  assert.equal(render({ ...request, title: "普通选择框" }), "");
  assert.equal(render({ ...request, method: "confirm" }), "");
});

test("question and option markup is displayed as text", () => {
  const html = render({ ...request, title: `${ASK_USER_TITLE_PREFIX}<script>alert(1)</script>`, options: askUserOptions(["<img src=x onerror=alert(1)>"]) });
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
