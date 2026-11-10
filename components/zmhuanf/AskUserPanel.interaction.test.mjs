import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { createJiti } from "jiti";
import * as hooks from "../../hooks/__fixtures__/react-hook-shim.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const protocol = await jiti.import("../../lib/zmhuanf/ask-user-protocol.ts");
const { ASK_USER_CUSTOM_PREFIX, ASK_USER_OTHER, ASK_USER_SKIP, ASK_USER_TITLE_PREFIX, askUserOptions } = protocol;
const source = await readFile(new URL("./AskUserPanel.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const componentModule = { exports: {} };
runInNewContext(outputText, {
  exports: componentModule.exports,
  require(name) {
    if (name === "react") return { ...hooks, useId: () => hooks.useRef("ask-heading").current };
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "@/lib/zmhuanf/ask-user-protocol") return protocol;
    throw new Error(`Unexpected import: ${name}`);
  },
});
const { AskUserPanel } = componentModule.exports;
const request = {
  type: "extension_ui_request", id: "ask-1", method: "select",
  title: `${ASK_USER_TITLE_PREFIX}原问题：请选择方案`,
  options: askUserOptions(["方案 A", "方案 B"], "方案 B"),
};

/** 遍历实际组件返回的元素树 */
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

/** 使用项目钩子模拟器驱动实际组件的交互 */
function setup(t, initial = request) {
  const responses = [];
  const hook = hooks.renderHook((props) => AskUserPanel(props), {
    request: initial,
    waitingCount: 0,
    onRespond(current, response) { responses.push({ id: current.id, ...response }); },
  });
  t.after(() => hook.unmount());
  return {
    responses,
    hook,
    get tree() { hook.flush(); return hook.result; },
    find(type) { return elements(this.tree).find((node) => node.type === type); },
    click(label) {
      const button = elements(this.tree).find((node) => node.type === "button" && text(node) === label);
      assert.ok(button, `Button not found: ${label}`);
      button.props.onClick();
      hook.flush();
    },
    type(value) {
      this.find("textarea").props.onChange({ target: { value } });
      hook.flush();
    },
    submit() {
      this.find("form").props.onSubmit({ preventDefault() {} });
      hook.flush();
    },
  };
}

test("Other opens input locally without answering or replacing the question", (t) => {
  const panel = setup(t);
  const heading = panel.find("h3");
  panel.click(ASK_USER_OTHER);
  assert.equal(panel.responses.length, 0);
  assert.equal(panel.find("h3").props.id, heading.props.id);
  assert.equal(text(panel.find("h3")), "原问题：请选择方案");
  assert.equal(panel.find("textarea").props["aria-describedby"], heading.props.id);
  assert.equal(panel.find("textarea").props.autoFocus, true);
  assert.ok(elements(panel.tree).some((node) => node.type === "button" && text(node) === "返回选项"));
});

test("returning restores options and recommendation without clearing the draft", (t) => {
  const panel = setup(t);
  panel.click(ASK_USER_OTHER);
  panel.type("已输入的草稿\n第二行");
  panel.click("返回选项");
  assert.equal(panel.responses.length, 0);
  assert.equal(panel.find("textarea"), undefined);
  assert.match(text(panel.tree), /方案 A.*方案 B推荐/);
  const other = elements(panel.tree).find((node) => node.type === "button" && text(node) === ASK_USER_OTHER);
  assert.equal(other.props.autoFocus, true);
  panel.click(ASK_USER_OTHER);
  assert.equal(panel.find("textarea").props.value, "已输入的草稿\n第二行");
  assert.equal(text(panel.find("h3")), "原问题：请选择方案");
});

test("an ordinary option can still be selected after returning", (t) => {
  const panel = setup(t);
  panel.click(ASK_USER_OTHER);
  panel.type("不提交的草稿");
  panel.click("返回选项");
  panel.click("方案 B推荐");
  assert.deepEqual(panel.responses, [{ id: "ask-1", value: request.options[1] }]);
});

test("custom submission is one response on the original request", (t) => {
  const panel = setup(t);
  panel.click(ASK_USER_OTHER);
  panel.type("  自定义回答\n第二行  ");
  panel.submit();
  panel.submit();
  assert.deepEqual(panel.responses, [{ id: "ask-1", value: `${ASK_USER_CUSTOM_PREFIX}自定义回答\n第二行` }]);
});

test("Skip during input is still a skip rather than an empty custom answer", (t) => {
  const panel = setup(t);
  panel.click(ASK_USER_OTHER);
  panel.type("不会提交的草稿");
  panel.click(ASK_USER_SKIP);
  assert.deepEqual(panel.responses, [{ id: "ask-1", value: ASK_USER_SKIP }]);
});

test("empty or whitespace-only drafts cannot be submitted", (t) => {
  const panel = setup(t);
  panel.click(ASK_USER_OTHER);
  for (const value of ["", " \n "]) {
    panel.type(value);
    const submit = elements(panel.tree).find((node) => node.type === "button" && node.props.type === "submit");
    assert.equal(submit.props.disabled, true);
    panel.submit();
  }
  assert.deepEqual(panel.responses, []);
});

test("question stays outside the scrolling input and option regions", (t) => {
  const panel = setup(t);
  assert.match(panel.find("section").props.className, /flex-col.*overflow-hidden/);
  const heading = panel.find("h3");
  assert.match(heading.props.className, /shrink-0.*overflow-y-auto/);
  assert.equal(panel.find("section").props.children[1].type, "h3");
  panel.click(ASK_USER_OTHER);
  panel.type("长回答\n".repeat(100));
  assert.equal(panel.find("section").props.children[1].type, "h3");
  const body = panel.find("section").props.children[2];
  assert.equal(body.props.children.type, "form");
  assert.match(body.props.className, /overflow-y-auto/);
  assert.equal(text(panel.find("h3")), "原问题：请选择方案");
});

test("request replay preserves the locally open input and draft", (t) => {
  const panel = setup(t);
  panel.click(ASK_USER_OTHER);
  panel.type("保留草稿");
  panel.hook.rerender({ request: { ...request }, waitingCount: 1, onRespond() {} });
  assert.equal(panel.find("textarea").props.value, "保留草稿");
  assert.equal(text(panel.find("h3")), "原问题：请选择方案");
});

test("collapse hides the answer region without responding and expands the same question", (t) => {
  const panel = setup(t);
  panel.click("收起");
  const section = panel.find("section");
  const body = section.props.children[2];
  const toggle = elements(panel.tree).find((node) => node.type === "button" && text(node) === "展开");
  assert.equal(body.props.hidden, true);
  assert.equal(toggle.props["aria-expanded"], false);
  assert.equal(toggle.props["aria-controls"], body.props.id);
  assert.equal(panel.find("h3").props.className, "sr-only");
  assert.match(text(section.props.children[0]), /等待回答：原问题：请选择方案/);
  assert.deepEqual(panel.responses, []);
  panel.click("展开");
  assert.equal(panel.find("section").props.children[2].props.hidden, false);
  assert.match(text(panel.tree), /方案 B推荐/);
  panel.click("方案 A");
  assert.deepEqual(panel.responses, [{ id: "ask-1", value: request.options[0] }]);
});

test("collapse and request replay preserve custom mode and its draft", (t) => {
  const panel = setup(t);
  panel.click(ASK_USER_OTHER);
  panel.type("保留草稿\n第二行");
  panel.click("收起");
  panel.hook.rerender({ request: { ...request }, waitingCount: 2, onRespond() { assert.fail("Collapse must not answer"); } });
  assert.equal(panel.find("section").props.children[2].props.hidden, true);
  assert.match(text(panel.tree), /另有 2 项等待处理/);
  panel.click("展开");
  assert.equal(panel.find("textarea").props.value, "保留草稿\n第二行");
  assert.ok(elements(panel.tree).some((node) => node.type === "button" && text(node) === "返回选项"));
  assert.deepEqual(panel.responses, []);
});

test("a newly mounted question starts expanded with no draft", (t) => {
  const first = setup(t);
  first.click(ASK_USER_OTHER);
  first.type("上一个问题的草稿");
  first.click("收起");
  const next = setup(t, { ...request, id: "ask-2" });
  assert.equal(next.find("section").props.children[2].props.hidden, false);
  next.click(ASK_USER_OTHER);
  assert.equal(next.find("textarea").props.value, "");
});

test("Enter and IME composition do not submit while Ctrl Enter does", (t) => {
  const panel = setup(t);
  panel.click(ASK_USER_OTHER);
  panel.type("回答");
  let submitted = 0;
  let prevented = 0;
  const keydown = panel.find("textarea").props.onKeyDown;
  const event = { key: "Enter", ctrlKey: false, metaKey: false, nativeEvent: { isComposing: false }, currentTarget: { form: { requestSubmit() { submitted += 1; } } }, preventDefault() { prevented += 1; } };
  keydown(event);
  keydown({ ...event, ctrlKey: true, nativeEvent: { isComposing: true } });
  assert.equal(submitted, 0);
  keydown({ ...event, ctrlKey: true });
  keydown({ ...event, metaKey: true });
  assert.equal(submitted, 2);
  assert.equal(prevented, 2);
});
