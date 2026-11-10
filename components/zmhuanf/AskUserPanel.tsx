"use client";

import { useId, useRef, useState } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import {
  ASK_USER_CUSTOM_PREFIX,
  ASK_USER_OTHER,
  ASK_USER_PLACEHOLDER,
  ASK_USER_SKIP,
  ASK_USER_TITLE_PREFIX,
  isAskUserRequest,
  type AskUserRequest,
} from "@/lib/zmhuanf/ask-user-protocol";

export { isAskUserRequest } from "@/lib/zmhuanf/ask-user-protocol";

interface Props {
  request: ExtensionUiRequest | null;
  waitingCount: number;
  onRespond: (request: AskUserRequest, response: { value: string } | { cancelled: true }) => void;
}

const buttonClass = "rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";

/** 显示可收起的提问卡并保留选项模式和自定义草稿 */
export function AskUserPanel({ request, waitingCount, onRespond }: Props) {
  const headingId = useId();
  const [value, setValue] = useState("");
  const [customInput, setCustomInput] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const submitted = useRef(false);
  const [restoreOptionFocus, setRestoreOptionFocus] = useState(false);
  if (!isAskUserRequest(request)) return null;
  const question = request.title.slice(ASK_USER_TITLE_PREFIX.length);

  /** 防止重复提交同一问题 */
  function respond(response: { value: string } | { cancelled: true }) {
    if (submitted.current || !isAskUserRequest(request)) return;
    submitted.current = true;
    onRespond(request, response);
  }

  return (
    <div className="mb-3 min-h-0 shrink-0 px-4 min-[641px]:pr-[52px]">
      <section
        aria-labelledby={headingId}
        className={`mx-auto flex max-h-[45vh] min-h-0 w-full flex-col overflow-hidden rounded-xl border ${collapsed ? "px-4 py-2" : "p-4"}`}
        style={{ maxWidth: "var(--chat-content-max-width, 820px)", borderColor: "var(--border)", background: "var(--bg-panel)", color: "var(--text)" }}
      >
        <div className={`${collapsed ? "" : "mb-2 "}flex shrink-0 items-center justify-between gap-3 text-xs`} style={{ color: "var(--text-muted)" }}>
          <span className="min-w-0 flex-1 truncate" title={collapsed ? question : undefined}>{collapsed ? `等待回答：${question}` : "等待你的回答"}</span>
          {waitingCount > 0 && <span className="shrink-0">另有 {waitingCount} 项等待处理</span>}
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={`${headingId}-body`}
            className="shrink-0 rounded px-2 py-1 transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            onClick={() => setCollapsed((current) => !current)}
          >{collapsed ? "展开" : "收起"}</button>
        </div>
        <h3 id={headingId} className={collapsed ? "sr-only" : "mb-3 max-h-[15vh] shrink-0 overflow-y-auto whitespace-pre-wrap break-words text-sm font-semibold"}>{question}</h3>
        <div id={`${headingId}-body`} hidden={collapsed} className="min-h-0 overflow-y-auto">
          {request.method === "select" && !customInput ? (
            <div className="flex min-h-0 flex-col gap-2">
              {request.options.slice(0, -2).map((option) => {
                const recommended = option.startsWith("★ ");
                const label = option.replace(/^(?:★ )?\d+\. /, "");
                return (
                  <button
                    key={option}
                    type="button"
                    className={`${buttonClass} flex shrink-0 items-center justify-between gap-3`}
                    style={{ borderColor: recommended ? "var(--accent)" : "var(--border)" }}
                    onClick={() => respond({ value: option })}
                  >
                    <span className="min-w-0 whitespace-pre-wrap break-words">{label}</span>
                    {recommended && <span className="shrink-0 text-xs" style={{ color: "var(--accent)" }}>推荐</span>}
                  </button>
                );
              })}
              <div className="mt-1 flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  autoFocus={restoreOptionFocus}
                  className={buttonClass}
                  style={{ borderColor: "var(--border)" }}
                  onClick={() => setCustomInput(true)}
                >{ASK_USER_OTHER}</button>
                <button type="button" className={buttonClass} style={{ borderColor: "var(--border)", color: "var(--text-muted)" }} onClick={() => respond({ value: ASK_USER_SKIP })}>{ASK_USER_SKIP}</button>
              </div>
            </div>
          ) : (
            <form className="min-h-0" onSubmit={(event) => {
              event.preventDefault();
              const answer = value.trim();
              if (answer) respond({ value: request.method === "select" ? `${ASK_USER_CUSTOM_PREFIX}${answer}` : answer });
            }}>
              <textarea
                autoFocus
                aria-label="你的回答"
                aria-describedby={headingId}
                placeholder={ASK_USER_PLACEHOLDER}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={3}
                className="mb-2 block max-h-[22vh] w-full resize-y rounded-lg border p-3 text-sm focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                style={{ borderColor: "var(--border)", background: "var(--bg)", color: "var(--text)" }}
              />
              <div className="flex flex-wrap gap-2">
                {request.method === "select" && (
                  <button type="button" className={buttonClass} style={{ borderColor: "var(--border)" }} onClick={() => {
                    setRestoreOptionFocus(true);
                    setCustomInput(false);
                  }}>返回选项</button>
                )}
                <button type="submit" disabled={!value.trim()} className={buttonClass} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>提交回答</button>
                <button type="button" className={buttonClass} style={{ borderColor: "var(--border)", color: "var(--text-muted)" }} onClick={() => respond(request.method === "select" ? { value: ASK_USER_SKIP } : { cancelled: true })}>{ASK_USER_SKIP}</button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
