"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ASK_USER_OTHER,
  ASK_USER_PLACEHOLDER,
  ASK_USER_SKIP,
  type AskUserQuestion,
  type AskUserRequest,
  type AskUserSelection,
} from "@/lib/zmhuanf/ask-user-protocol";

interface Props {
  request: AskUserRequest;
  questions: AskUserQuestion[];
  waitingCount: number;
  onRespond: (request: AskUserRequest, response: { value: string } | { cancelled: true }) => void;
}

interface QuestionDraft {
  value: string;
  customInput: boolean;
  option?: number;
  skipped: boolean;
  confirmed?: boolean;
  restoreOptionFocus?: boolean;
}

const buttonClass = "rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";

/** 从当前回答模式提取答案并保留未启用的草稿 */
function draftSelection(draft: QuestionDraft): AskUserSelection | undefined {
  if (draft.skipped) return { source: "skipped" };
  if (draft.customInput) return draft.confirmed && draft.value.trim() ? { source: "custom", answer: draft.value.trim() } : undefined;
  return draft.option === undefined ? undefined : { source: "option", option: draft.option };
}

/** 按题保存草稿并在多题确认完成后自动提交 */
export function AskUserBatchPanel({ request, questions, waitingCount, onRespond }: Props) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const submitted = useRef(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(() => ({ value: "", customInput: false, skipped: false })));
  const item = questions[activeIndex];
  const draft = drafts[activeIndex];
  const selections = drafts.map(draftSelection);
  const answeredCount = selections.filter((selection) => selection !== undefined).length;
  const submissionDrafts = drafts.map((entry, index) => index === activeIndex ? { ...entry, confirmed: true } : entry);
  const canSubmit = submissionDrafts.every((entry) => draftSelection(entry) !== undefined);
  const canConfirmCustom = draft.customInput && !draft.skipped && Boolean(draft.value.trim());

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [activeIndex]);

  /** 仅更新当前题并保留其他题的选择和草稿 */
  function updateDraft(update: Partial<QuestionDraft>) {
    setDrafts((current) => current.map((entry, index) => index === activeIndex ? { ...entry, ...update } : entry));
  }

  /** 阻止缺题和重复提交并按题目顺序发送整组回答 */
  function submitAnswers(nextDrafts = submissionDrafts) {
    const answers = nextDrafts.map(draftSelection);
    if (submitted.current || answers.some((answer) => answer === undefined)) return;
    submitted.current = true;
    onRespond(request, { value: JSON.stringify({ answers }) });
  }

  /** 确认当前答案并跳到下一道未回答题或提交 */
  function confirmAnswer(update: Partial<QuestionDraft> = {}) {
    if (submitted.current) return;
    const nextDrafts = drafts.map((entry, index) => index === activeIndex ? { ...entry, ...update, confirmed: true } : entry);
    if (!draftSelection(nextDrafts[activeIndex])) return;
    setDrafts(nextDrafts);
    for (let offset = 1; offset < questions.length; offset++) {
      const index = (activeIndex + offset) % questions.length;
      if (!draftSelection(nextDrafts[index])) {
        setActiveIndex(index);
        return;
      }
    }
    submitAnswers(nextDrafts);
  }

  return (
    <div className="mb-3 min-h-0 shrink-0 px-4 min-[641px]:pr-[52px]">
      <section
        aria-labelledby={headingId}
        className={`mx-auto flex max-h-[45vh] min-h-0 w-full flex-col overflow-hidden rounded-xl border ${collapsed ? "px-4 py-2" : "p-4"}`}
        style={{ maxWidth: "var(--chat-content-max-width, 820px)", borderColor: "var(--border)", background: "var(--bg-panel)", color: "var(--text)" }}
      >
        <div className={`${collapsed ? "" : "mb-2 "}flex shrink-0 items-center justify-between gap-3 text-xs`} style={{ color: "var(--text-muted)" }}>
          <span className="min-w-0 flex-1 truncate" title={collapsed ? item.question : undefined}>
            {collapsed ? `等待回答：${item.question} · ${answeredCount}/${questions.length}` : `第 ${activeIndex + 1}/${questions.length} 题 · 已回答 ${answeredCount}/${questions.length}`}
          </span>
          {waitingCount > 0 && <span className="shrink-0">另有 {waitingCount} 项等待处理</span>}
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={`${headingId}-body`}
            className="shrink-0 rounded px-2 py-1 transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            onClick={() => setCollapsed((current) => !current)}
          >{collapsed ? "展开" : "收起"}</button>
        </div>
        <h3 ref={headingRef} tabIndex={-1} id={headingId} className={collapsed ? "sr-only" : "mb-3 max-h-[15vh] shrink-0 overflow-y-auto whitespace-pre-wrap break-words text-sm font-semibold outline-none"}>{item.question}</h3>
        <div ref={bodyRef} id={`${headingId}-body`} hidden={collapsed} className="min-h-0 overflow-y-auto">
          <form key={activeIndex} onSubmit={(event) => {
            event.preventDefault();
            submitAnswers();
          }}>
            {!draft.customInput ? (
              <div className="flex flex-col gap-2">
                {item.options.map((option, index) => {
                  const recommended = option === item.recommendedOption;
                  const selected = !draft.skipped && draft.option === index + 1;
                  return (
                    <button
                      key={index}
                      type="button"
                      aria-pressed={selected}
                      className={`${buttonClass} flex shrink-0 items-center justify-between gap-3`}
                      style={{ borderColor: selected || recommended ? "var(--accent)" : "var(--border)", background: selected ? "var(--bg-selected)" : undefined }}
                      onClick={() => confirmAnswer({ option: index + 1, skipped: false })}
                    >
                      <span className="min-w-0 whitespace-pre-wrap break-words">{option}</span>
                      {recommended && <span className="shrink-0 text-xs" style={{ color: "var(--accent)" }}>推荐</span>}
                    </button>
                  );
                })}
                <button
                  type="button"
                  autoFocus={draft.restoreOptionFocus}
                  className={`${buttonClass} mt-1 w-full`}
                  style={{ borderColor: "var(--border)" }}
                  onClick={() => updateDraft({ customInput: true, skipped: false, confirmed: false })}
                >{ASK_USER_OTHER}</button>
              </div>
            ) : (
              <>
                <textarea
                  autoFocus
                  aria-label="你的回答"
                  aria-describedby={headingId}
                  placeholder={ASK_USER_PLACEHOLDER}
                  value={draft.value}
                  onChange={(event) => updateDraft({ value: event.target.value, skipped: false, confirmed: false })}
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
                <button type="button" className={buttonClass} style={{ borderColor: "var(--border)" }} onClick={() => updateDraft({ customInput: false, skipped: false, restoreOptionFocus: true })}>返回选项</button>
              </>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
              <button type="button" disabled={activeIndex === 0} className={buttonClass} style={{ borderColor: "var(--border)" }} onClick={() => setActiveIndex((current) => current - 1)}>上一题</button>
              <button type="button" aria-pressed={draft.skipped} className={buttonClass} style={{ borderColor: draft.skipped ? "var(--accent)" : "var(--border)", color: "var(--text-muted)" }} onClick={() => confirmAnswer({ skipped: true })}>{ASK_USER_SKIP}</button>
              <button type="button" disabled={draft.customInput && !draft.skipped ? !canConfirmCustom || questions.length === 1 : activeIndex === questions.length - 1} className={buttonClass} style={{ borderColor: "var(--border)" }} onClick={() => canConfirmCustom ? confirmAnswer() : setActiveIndex((current) => current + 1)}>下一题</button>
              {draft.skipped && <span className="text-xs" style={{ color: "var(--text-muted)" }}>本题已跳过</span>}
              <button type="submit" disabled={!canSubmit} className={`${buttonClass} ml-auto`} style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>提交</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
