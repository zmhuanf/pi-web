import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-tracker 计时插件
 *
 * pi 自身的会话 JSONL 只记录 token 用量，没有首字/用时信息。
 * 本插件监听 assistant 消息的生命周期事件，记录：
 *   - 首Token耗时 firstTokenMs：从请求发出到收到第一个流式事件（含思考）
 *   - 首字耗时   firstTextMs  ：从请求发出到收到第一段可见文本
 *   - 总用时     durationMs   ：从请求发出到消息结束
 *
 * 时间基准取 assistant 消息自身的 timestamp：pi 在发请求前创建消息对象
 * 时打点，等价于请求发出时刻。不能以 message_start 回调时刻为准——该事件
 * 要等流式 start 事件（HTTP 响应建立）才触发，会丢掉排队与首字节延迟。
 *
 * 数据通过 pi.appendEntry() 以 custom entry（customType="pi-tracker/timing"）
 * 写入当前会话文件（~/.pi/agent/sessions/--<工作目录>--/*.jsonl），
 * 由 opencode-tracker 解析时合并到 pi 的用量记录里。
 *
 * 注意：message_end 事件先于会话持久化触发，因此 timing entry 会落在
 * 对应 assistant 消息的前一行；opencode-tracker 按文件顺序 + 时间戳
 * 窗口做关联，二者保持一致的"零 token 不记录"规则。
 */

const TIMING_TYPE = "pi-tracker/timing";

interface PendingTiming {
  /** 消息自身的 timestamp（ms），pi 于发请求前打点，为请求起点 */
  messageTimestamp: number;
  /** 首次收到任何流式事件的时刻（含 thinking） */
  firstToken: number;
  /** 首次收到文本增量（text_start/text_delta）的时刻 */
  firstText: number;
}

let pending: PendingTiming | null = null;

export default function (pi: ExtensionAPI) {
  // 新一轮请求开始：以消息 timestamp 为起点，其早于 message_start 回调
  // 触发时刻，后者会漏掉排队与首字节延迟
  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    const msg = event.message as { timestamp?: number };
    pending = {
      messageTimestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
      firstToken: 0,
      firstText: 0,
    };
  });

  // 流式更新：捕获首 token / 首字时刻
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant" || !pending) return;
    const now = Date.now();
    if (pending.firstToken === 0) {
      pending.firstToken = now;
    }
    const ev = event.assistantMessageEvent;
    if (
      ev &&
      (ev.type === "text_start" || ev.type === "text_delta") &&
      pending.firstText === 0
    ) {
      pending.firstText = now;
    }
  });

  // 消息结束：结算并落盘
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !pending) return;
    const msg = event.message as {
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        reasoning?: number;
      };
    };
    const u = msg.usage;
    const tokens =
      (u?.input ?? 0) +
      (u?.output ?? 0) +
      (u?.cacheRead ?? 0) +
      (u?.cacheWrite ?? 0) +
      (u?.reasoning ?? 0);
    const end = Date.now();
    const base = pending.messageTimestamp;
    const firstTokenMs = pending.firstToken > 0 ? pending.firstToken - base : 0;
    const firstTextMs = pending.firstText > 0 ? pending.firstText - base : 0;
    const durationMs = end - base;

    // 与 opencode-tracker 的 pi 解析规则保持一致：零 token 消息不生成用量记录，
    // 这里也不写 timing，保证追踪器按顺序关联不会错位。
    if (tokens > 0) {
      pi.appendEntry(TIMING_TYPE, {
        v: 1,
        messageTimestamp: base,
        start: base,
        firstToken: pending.firstToken || 0,
        firstText: pending.firstText || 0,
        end,
        firstTokenMs,
        firstTextMs,
        durationMs,
        // 与追踪器口径一致：output 含 thinking，减去后为真实输出
        outputTokens: Math.max(0, (u?.output ?? 0) - (u?.reasoning ?? 0)),
        reasoningTokens: u?.reasoning ?? 0,
      });
    }
    pending = null;
  });
}
