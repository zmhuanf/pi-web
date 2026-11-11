import { Type } from "typebox";
import { defineTool, type ExtensionUIContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_BATCH_PREFIX,
  ASK_USER_OTHER,
  ASK_USER_PLACEHOLDER,
  ASK_USER_SKIP,
  ASK_USER_SKIP_ANSWER,
  ASK_USER_TITLE_PREFIX,
  askUserOptions,
  normalizeAskUserQuestion,
  type AskUserAnswer,
  type AskUserQuestion,
} from "./ask-user-protocol";

const questionParameters = Type.Object({
  question: Type.String({ minLength: 1, description: "The question to ask the user." }),
  options: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    uniqueItems: true,
    description: "Single-choice answers.",
  }),
  recommendedOption: Type.Optional(Type.Union([
    Type.Integer({ minimum: 1 }),
    Type.String({ minLength: 1 }),
  ], {
    description: "Recommended option number (1-based).",
  })),
}, { additionalProperties: false });

const parameters = Type.Object({
  questions: Type.Array(questionParameters, {
    minItems: 1,
    description: "Questions to ask together. Use a one-item array for one question.",
  }),
}, { additionalProperties: false });

/** 使用终端的标准选择和输入交互获取每题答案 */
async function askTerminalQuestion(ui: ExtensionUIContext, item: AskUserQuestion, questionIndex: number, signal?: AbortSignal): Promise<AskUserAnswer> {
  signal?.throwIfAborted();
  const { question, options, recommendedOption } = item;
  const title = `${ASK_USER_TITLE_PREFIX}${question}`;
  const choices = askUserOptions(options, recommendedOption);
  const selected = await ui.select(title, choices, { signal });
  signal?.throwIfAborted();
  let answer: string;
  if (selected === ASK_USER_OTHER) {
    let input: string | undefined;
    do {
      input = await ui.input(title, ASK_USER_PLACEHOLDER, { signal });
      signal?.throwIfAborted();
    } while (input !== undefined && !input.trim());
    answer = input?.trim() ?? ASK_USER_SKIP_ANSWER;
  } else if (selected === undefined || selected === ASK_USER_SKIP) {
    answer = ASK_USER_SKIP_ANSWER;
  } else {
    const index = choices.indexOf(selected);
    if (index < 0 || index >= options.length) throw new Error("Invalid answer option");
    answer = options[index];
  }
  return { questionIndex, answer };
}

/** 校验整组回答并按题号返回选项原文或自定义答案 */
function parseBatchAnswers(value: string, questions: AskUserQuestion[]): AskUserAnswer[] {
  let response: unknown;
  try {
    response = JSON.parse(value);
  } catch {
    throw new Error("Invalid question batch response");
  }
  if (!response || typeof response !== "object" || !("answers" in response) || !Array.isArray(response.answers) || response.answers.length !== questions.length) {
    throw new Error("Every question must be answered or explicitly skipped");
  }
  const answers: unknown[] = response.answers;
  return questions.map(({ options }, index) => {
    const selection = answers[index];
    if (!selection || typeof selection !== "object" || !("source" in selection)) throw new Error("Invalid question answer");
    let answer: string;
    const source = selection.source;
    if (source === "option" && "option" in selection && typeof selection.option === "number" && Number.isInteger(selection.option) && selection.option >= 1 && selection.option <= options.length) {
      answer = options[selection.option - 1];
    } else if (source === "custom" && "answer" in selection && typeof selection.answer === "string" && selection.answer.trim()) {
      answer = selection.answer.trim();
    } else if (source === "skipped") {
      answer = ASK_USER_SKIP_ANSWER;
    } else {
      throw new Error("Invalid question answer");
    }
    return { questionIndex: index + 1, answer };
  });
}

/** 注册统一使用问题列表并等待整组回答的提问工具 */
export function createAskUserExtension(): InlineExtension {
  return {
    name: "zmhuanf-ask-user",
    factory(pi) {
      pi.registerTool(defineTool<typeof parameters, { answers: AskUserAnswer[] }>({
        name: "ask_user",
        label: "询问用户",
        description: "Ask the user questions and wait for their answers before proceeding. Always use the questions array, even for one question. Group independent questions in one call; ask dependent follow-up questions after receiving the answers they depend on.",
        promptSnippet: "Ask the user questions and wait for answers; group independent questions in one call",
        exposure: "model-only",
        executionMode: "sequential",
        parameters,
        /** 校验全部题目并等待整组回答后返回对应结果 */
        async execute(_id, params, signal, _onUpdate, ctx) {
          signal?.throwIfAborted();
          if (!ctx.hasUI) throw new Error("ask_user requires an interactive user interface");
          if (!Array.isArray(params.questions) || !params.questions.length) throw new Error("questions must be a non-empty array");
          if (Object.keys(params).some((key) => key !== "questions")) throw new Error("Only questions is accepted");
          const questions = params.questions.map(normalizeAskUserQuestion);
          let answers: AskUserAnswer[];
          if (ctx.mode === "rpc") {
            const value = await ctx.ui.input(`${ASK_USER_TITLE_PREFIX}${questions.length} 个问题`, `${ASK_USER_BATCH_PREFIX}${JSON.stringify(questions)}`, { signal });
            signal?.throwIfAborted();
            if (value === undefined) throw new Error("Question batch was cancelled");
            answers = parseBatchAnswers(value, questions);
          } else {
            answers = [];
            for (const [index, question] of questions.entries()) answers.push(await askTerminalQuestion(ctx.ui, question, index + 1, signal));
          }
          return { content: [{ type: "text", text: JSON.stringify({ answers }) }], details: { answers } };
        },
      }));
    },
  };
}
