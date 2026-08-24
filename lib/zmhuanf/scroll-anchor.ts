// 滚动锚定稳定工具，输出结束时避免往上跳

// 释放 prompt anchor 撑高占位时保持视口稳定
// 跟随开启时贴底，关闭时保持相对距离避免突变
export function releaseAnchorWithStableScroll(
  spacer: HTMLElement | null,
  container: HTMLElement | null,
  following: boolean,
): void {
  if (!spacer) return
  const prevHeight = spacer.getBoundingClientRect().height
  const prevScrollTop = container?.scrollTop ?? 0
  spacer.style.height = ""
  if (!container || prevHeight <= 0) return

  // 为什么同步加 rAF 双保险：同步消除首帧跳动，rAF 覆盖折叠等二次布局
  if (following) {
    container.scrollTop = container.scrollHeight - container.clientHeight
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight - container.clientHeight
    })
    return
  }

  // 关闭跟随即钉住当前位置，spacer 释放不应改变视口顶部内容位置
  // 原实现从底部算相对距离使视口下移 spacer 高度，长对话下跳一大截
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
  const clampedTop = Math.min(prevScrollTop, maxScrollTop)
  container.scrollTop = clampedTop
  requestAnimationFrame(() => {
    container.scrollTop = clampedTop
  })
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
