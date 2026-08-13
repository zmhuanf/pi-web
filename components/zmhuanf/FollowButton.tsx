"use client";

import { useI18n } from "@/hooks/useI18n";

const MOBILE_ICON_BUTTON_SIZE = 36;

// 顶部栏跟随开关：点亮态表示追踪输出，点击强制切换
export function FollowButton({ following, onToggle, mobile = false }: { following: boolean; onToggle: () => void; mobile?: boolean }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onToggle}
      title={t(following ? "follow.titleActive" : "follow.titleInactive")}
      aria-label={t(following ? "follow.titleActive" : "follow.titleInactive")}
      aria-pressed={following}
      className={mobile ? "mobile-follow-toggle" : undefined}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 6, height: "100%",
        padding: mobile ? 0 : "0 12px",
        flexShrink: 0,
        minWidth: mobile ? MOBILE_ICON_BUTTON_SIZE : undefined,
        background: "none", border: "none",
        borderTop: "2px solid transparent",
        borderRight: mobile ? "none" : "1px solid var(--border)",
        cursor: "pointer",
        color: following ? "var(--text)" : "var(--text-muted)",
        fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = following ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: following ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
        <path d="M12 17V3" />
        <path d="m6 11 6 6 6-6" />
        <path d="M19 21H5" />
      </svg>
      {!mobile && <span>{t(following ? "follow.active" : "follow.inactive")}</span>}
    </button>
  );
}
