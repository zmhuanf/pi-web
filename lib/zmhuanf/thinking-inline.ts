import type { SessionEntry } from "@/lib/types";

// 判断 entry 是否为分组锚点（user 消息或 compaction 摘要）
// 与前端 ChatWindow.isGroupAnchor 对齐，保证内联范围与默认展开范围一致
function isAnchorEntry(entry: SessionEntry): boolean {
  if (entry.type === "message") return entry.message.role === "user";
  return entry.type === "compaction";
}

// 判断 assistant 消息是否含非空思考内容
function hasThinkingContent(entry: SessionEntry): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant") return false;
  return (entry.message.content ?? []).some(
    (block) => block.type === "thinking" && block.thinking.trim() !== "",
  );
}

// 选取应保留内联思考的 entry 集合
// loadSession 后变 deferred 会重新加载，内容瞬时清空导致高度突变往上跳
// 内联最后一条锚点之后的带思考 assistant 即可根治；无锚点时回退到最后一条带思考的
export function selectInlineThinkingEntries(entries: SessionEntry[]): Set<SessionEntry> {
  const lastAnchorIdx = entries.findLastIndex(isAnchorEntry);
  if (lastAnchorIdx === -1) {
    const fallback = entries.findLast(hasThinkingContent);
    return fallback ? new Set([fallback]) : new Set();
  }
  return new Set(entries.slice(lastAnchorIdx + 1).filter(hasThinkingContent));
}
