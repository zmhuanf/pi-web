import type { ExtensionUiRequest } from "../types";

export const ASK_USER_TITLE_PREFIX = "ask_user · ";
export const ASK_USER_OTHER = "其他：自己输入";
export const ASK_USER_SKIP = "跳过";
export const ASK_USER_SKIP_ANSWER = "按你推荐的来";
export const ASK_USER_PLACEHOLDER = "请输入你的回答";
export const ASK_USER_BATCH_PREFIX = "ask_user:questions:v1:";

export type AskUserRequest = Extract<ExtensionUiRequest, { method: "input" }>;

export interface AskUserQuestion {
  question: string;
  options: string[];
  recommendedOption?: string;
}

export type AskUserSelection =
  | { source: "option"; option: number }
  | { source: "custom"; answer: string }
  | { source: "skipped" };

export interface AskUserAnswer {
  questionIndex: number;
  answer: string;
}

/** 校验题目并将推荐编号转换为选项原文 */
export function normalizeAskUserQuestion(input: unknown): AskUserQuestion {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid question");
  const { question: rawQuestion, options: rawOptions, recommendedOption: recommendation } = input as Record<string, unknown>;
  if (typeof rawQuestion !== "string" || !Array.isArray(rawOptions) || rawOptions.some((option) => typeof option !== "string")) {
    throw new Error("Question and options must be strings");
  }
  const question = rawQuestion.trim();
  const options = (rawOptions as string[]).map((option) => option.trim());
  if (!question || !options.length || options.some((option) => !option)) throw new Error("Question and options must not be blank");
  if (new Set(options).size !== options.length) throw new Error("Options must be unique");
  if (typeof recommendation === "number" && (!Number.isInteger(recommendation) || recommendation < 1 || recommendation > options.length)) {
    throw new Error("recommendedOption must be an option number from 1 to options.length");
  }
  if (recommendation !== undefined && typeof recommendation !== "number" && typeof recommendation !== "string") {
    throw new Error("recommendedOption must be an option number or text");
  }
  let recommendedOption = typeof recommendation === "number" ? options[recommendation - 1] : recommendation?.trim();
  if (typeof recommendedOption === "string" && !options.includes(recommendedOption) && /^[1-9]\d*$/.test(recommendedOption)) {
    const index = Number(recommendedOption);
    if (!Number.isSafeInteger(index) || index > options.length) throw new Error("recommendedOption must be an option number from 1 to options.length");
    recommendedOption = options[index - 1];
  }
  if (recommendedOption !== undefined && !options.includes(recommendedOption)) throw new Error("recommendedOption must match one of options");
  return { question, options, ...(recommendedOption === undefined ? {} : { recommendedOption }) };
}

/** 从标准输入请求读取多题载荷并拒绝无效题目 */
export function readAskUserBatch(request: ExtensionUiRequest | null): AskUserQuestion[] | null {
  if (request?.method !== "input" || !request.title.startsWith(ASK_USER_TITLE_PREFIX) || !request.placeholder?.startsWith(ASK_USER_BATCH_PREFIX)) return null;
  try {
    const questions: unknown = JSON.parse(request.placeholder.slice(ASK_USER_BATCH_PREFIX.length));
    return Array.isArray(questions) && questions.length > 0 ? questions.map(normalizeAskUserQuestion) : null;
  } catch {
    return null;
  }
}

/** 识别携带完整问题列表的标准输入请求 */
export function isAskUserRequest(request: ExtensionUiRequest | null): request is AskUserRequest {
  return readAskUserBatch(request) !== null;
}

/** 为选项添加编号和推荐标记并保留原文 */
export function askUserOptions(options: readonly string[], recommendedOption?: string): string[] {
  return [
    ...options.map((option, index) => `${option === recommendedOption ? "★ " : ""}${index + 1}. ${option}`),
    ASK_USER_OTHER,
    ASK_USER_SKIP,
  ];
}
