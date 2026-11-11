"use client";

import type { ExtensionUiRequest } from "@/lib/types";
import { readAskUserBatch, type AskUserRequest } from "@/lib/zmhuanf/ask-user-protocol";
import { AskUserBatchPanel } from "./AskUserBatchPanel";

export { isAskUserRequest } from "@/lib/zmhuanf/ask-user-protocol";

interface Props {
  request: ExtensionUiRequest | null;
  waitingCount: number;
  onRespond: (request: AskUserRequest, response: { value: string } | { cancelled: true }) => void;
}

/** 将有效的问题列表交给统一提问面板 */
export function AskUserPanel({ request, waitingCount, onRespond }: Props) {
  if (request?.method !== "input") return null;
  const questions = readAskUserBatch(request);
  return questions ? <AskUserBatchPanel key={request.id} request={request} questions={questions} waitingCount={waitingCount} onRespond={onRespond} /> : null;
}
