import { Type } from "typebox";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_OTHER,
  ASK_USER_CUSTOM_PREFIX,
  ASK_USER_PLACEHOLDER,
  ASK_USER_SKIP,
  ASK_USER_SKIP_ANSWER,
  ASK_USER_TITLE_PREFIX,
  askUserOptions,
} from "./ask-user-protocol";

const parameters = Type.Object({
  question: Type.String({ minLength: 1, description: "The question to ask the user." }),
  options: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    uniqueItems: true,
    description: "Single-choice answers. Custom input and Skip are added automatically.",
  }),
  recommendedOption: Type.Optional(Type.String({
    description: "The recommended answer, exactly matching one of options. Omit if no recommendation is appropriate.",
  })),
});

interface AskUserAnswer {
  question: string;
  answer: string;
  source: "option" | "custom" | "skipped";
  recommendedOption?: string;
}

/** 注册等待用户选择或填写回答的提问工具 */
export function createAskUserExtension(): InlineExtension {
  return {
    name: "zmhuanf-ask-user",
    factory(pi) {
      pi.registerTool(defineTool<typeof parameters, AskUserAnswer>({
        name: "ask_user",
        label: "询问用户",
        description: "Ask the user a question with single-choice options and an optional recommended option. Waits for their answer. The user can enter a custom answer or skip; skipping answers 按你推荐的来. Ask one question per call.",
        promptSnippet: "Ask the user to choose an option or provide a custom answer",
        exposure: "model-only",
        executionMode: "sequential",
        parameters,
        /** 校验选项并等待选择或自定义回答 */
        async execute(_id, params, signal, _onUpdate, ctx) {
          signal?.throwIfAborted();
          if (!ctx.hasUI) throw new Error("ask_user requires an interactive user interface");
          const question = params.question.trim();
          const options = params.options.map((option) => option.trim());
          const recommendedOption = params.recommendedOption?.trim();
          if (!question || !options.length || options.some((option) => !option)) {
            throw new Error("Question and options must not be blank");
          }
          if (new Set(options).size !== options.length) throw new Error("Options must be unique");
          if (recommendedOption !== undefined && !options.includes(recommendedOption)) {
            throw new Error("recommendedOption must match one of options");
          }
          const title = `${ASK_USER_TITLE_PREFIX}${question}`;
          const choices = askUserOptions(options, recommendedOption);
          const selected = await ctx.ui.select(title, choices, { signal });
          signal?.throwIfAborted();
          let answer: string;
          let source: AskUserAnswer["source"];
          if (selected?.startsWith(ASK_USER_CUSTOM_PREFIX)) {
            answer = selected.slice(ASK_USER_CUSTOM_PREFIX.length).trim();
            if (!answer) throw new Error("Custom answer must not be blank");
            source = "custom";
          } else if (selected === ASK_USER_OTHER) {
            let input: string | undefined;
            do {
              input = await ctx.ui.input(title, ASK_USER_PLACEHOLDER, { signal });
              signal?.throwIfAborted();
            } while (input !== undefined && !input.trim());
            answer = input?.trim() ?? ASK_USER_SKIP_ANSWER;
            source = input === undefined ? "skipped" : "custom";
          } else if (selected === undefined || selected === ASK_USER_SKIP) {
            answer = ASK_USER_SKIP_ANSWER;
            source = "skipped";
          } else {
            const index = choices.indexOf(selected);
            if (index < 0 || index >= options.length) throw new Error("Invalid answer option");
            answer = options[index];
            source = "option";
          }
          return {
            content: [{ type: "text", text: answer }],
            details: { question, answer, source, ...(recommendedOption === undefined ? {} : { recommendedOption }) },
          };
        },
      }));
    },
  };
}
