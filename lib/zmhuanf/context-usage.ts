import {
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@/lib/session-reader";
import type { AgentMessage, AssistantMessage, SessionEntry } from "@/lib/types";
import type { ContextUsage } from "@/lib/pi-types";

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

type Usage = NonNullable<AssistantMessage["usage"]>;
type MessageContent = Extract<AgentMessage, { content: unknown }>["content"];

function usageContextTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function contentChars(content: MessageContent): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

function estimateMessageTokens(msg: AgentMessage): number {
  switch (msg.role) {
    case "user":
    case "toolResult":
    case "custom":
      return Math.ceil(contentChars(msg.content) / CHARS_PER_TOKEN);
    case "assistant": {
      let chars = 0;
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") {
          chars += block.toolName.length + JSON.stringify(block.input).length;
        }
      }
      return Math.ceil(chars / CHARS_PER_TOKEN);
    }
    case "bashExecution":
      return Math.ceil((msg.command.length + msg.output.length) / CHARS_PER_TOKEN);
  }
}

// 复刻 pi 运行时 estimateContextTokens：最后一条能描述当前前缀的 assistant usage 为准，其后消息按字符估算
export function estimateSessionContextTokens(messages: AgentMessage[]): number {
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let lastUsage: { usage: Usage; index: number } | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const appliesToPrefix = (msg.timestamp ?? 0) >= latestPrefixTimestamp;
      if (
        appliesToPrefix &&
        msg.stopReason !== "aborted" &&
        msg.stopReason !== "error" &&
        msg.usage &&
        usageContextTokens(msg.usage) > 0
      ) {
        lastUsage = { usage: msg.usage, index: i };
      }
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, msg.timestamp ?? 0);
  }
  if (!lastUsage) {
    return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  }
  let tokens = usageContextTokens(lastUsage.usage);
  for (let i = lastUsage.index + 1; i < messages.length; i++) {
    tokens += estimateMessageTokens(messages[i]);
  }
  return tokens;
}

const MODEL_RUNTIME_TTL_MS = 60_000;

declare global {
  var __piContextModelRuntime: { runtime: ModelRuntime; expiresAt: number } | undefined;
}

export function invalidateContextModelRuntime(): void {
  globalThis.__piContextModelRuntime = undefined;
}

async function getModelRuntime(): Promise<ModelRuntime> {
  const cached = globalThis.__piContextModelRuntime;
  if (cached && cached.expiresAt > Date.now()) return cached.runtime;
  const runtime = await ModelRuntime.create();
  globalThis.__piContextModelRuntime = { runtime, expiresAt: Date.now() + MODEL_RUNTIME_TTL_MS };
  return runtime;
}

// 无活跃 RPC 会话时从文件估算 contextUsage；模型缺失或查询失败时返回 null 保持原行为
export async function computeContextUsageFromFile(filePath: string): Promise<ContextUsage | null> {
  try {
    const sm = SessionManager.open(filePath);
    const entries = sm.getEntries() as unknown as SessionEntry[];
    const ctx = buildSessionContext(entries, sm.getLeafId());
    if (!ctx.model) return null;
    const model = (await getModelRuntime()).getModel(ctx.model.provider, ctx.model.modelId);
    if (!model || model.contextWindow <= 0) return null;
    const tokens = estimateSessionContextTokens(ctx.messages);
    return {
      tokens,
      contextWindow: model.contextWindow,
      percent: (tokens / model.contextWindow) * 100,
    };
  } catch {
    return null;
  }
}
