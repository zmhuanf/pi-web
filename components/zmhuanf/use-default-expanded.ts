import { useCallback, useEffect, useRef, useState } from "react";

// 默认展开状态 + 用户手动覆盖：外部 flag 变化时跟随，手动操作过的保持用户选择
export function useDefaultExpanded(defaultExpanded: boolean | undefined): [boolean, () => void] {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const userToggledRef = useRef(false);
  useEffect(() => {
    if (userToggledRef.current) return;
    setExpanded(defaultExpanded ?? false);
  }, [defaultExpanded]);
  const toggle = useCallback(() => {
    userToggledRef.current = true;
    setExpanded((v) => !v);
  }, []);
  return [expanded, toggle];
}
