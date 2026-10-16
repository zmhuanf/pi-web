// 滚动锚定稳定工具，输出结束时避免往上跳

// 输出结束保留 prompt anchor 撑高为底部留白，避免视口跳变
// 释放 spacer 会让视口从 user 固定位置跳到底部，长对话下跳一屏
// 返回保留高度，供 ChatWindow 同步 promptAnchorSpacerHeightRef 供下轮比较
export function retainAnchorSpacer(spacer: HTMLElement | null): number {
  if (!spacer) return 0
  const height = spacer.style.height
  // 只清零高占位，有撑高时原样保留作为底部留白
  if (!height || height === "0px") {
    spacer.style.height = ""
    return 0
  }
  return parseFloat(height) || 0
}

// 布局抖动后二次贴底，覆盖折叠等高度突变
// 双 rAF 确保 ChatWindow 分组折叠与 spacer 清零均已完成
export function schedulePostLayoutBottomFix(
  container: HTMLElement | null,
  followingRef: { current: boolean },
  isNearBottomRef: { current: boolean },
  scrollToBottom: (behavior: ScrollBehavior) => void,
): void {
  if (!container) return
  if (!followingRef.current) return
  if (!isNearBottomRef.current) return

  // 为什么用双帧：首帧等待 React commit 与分组折叠完成，次帧等待浏览器 layout
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!followingRef.current || !isNearBottomRef.current) return
      scrollToBottom("instant")
    })
  })
}
