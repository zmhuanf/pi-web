import type { ExtensionUiRequest } from "../types";

export const ASK_USER_TITLE_PREFIX = "ask_user · ";
export const ASK_USER_OTHER = "其他：自己输入";
export const ASK_USER_CUSTOM_PREFIX = "ask_user:custom:";
export const ASK_USER_SKIP = "跳过";
export const ASK_USER_SKIP_ANSWER = "按你推荐的来";
export const ASK_USER_PLACEHOLDER = "请输入你的回答";

export type AskUserRequest = Extract<ExtensionUiRequest, { method: "select" | "input" }>;

/** 识别提问工具的标准扩展交互 */
export function isAskUserRequest(request: ExtensionUiRequest | null): request is AskUserRequest {
  if (!request || !(request.method === "select" || request.method === "input")) return false;
  if (!request.title.startsWith(ASK_USER_TITLE_PREFIX)) return false;
  return request.method === "input"
    ? request.placeholder === ASK_USER_PLACEHOLDER
    : request.options.length >= 3
      && request.options.at(-2) === ASK_USER_OTHER
      && request.options.at(-1) === ASK_USER_SKIP
      && request.options.slice(0, -2).every((option, index) => option.startsWith(`${index + 1}. `) || option.startsWith(`★ ${index + 1}. `));
}

/** 为选项添加编号和推荐标记并保留原文 */
export function askUserOptions(options: readonly string[], recommendedOption?: string): string[] {
  return [
    ...options.map((option, index) => `${option === recommendedOption ? "★ " : ""}${index + 1}. ${option}`),
    ASK_USER_OTHER,
    ASK_USER_SKIP,
  ];
}
