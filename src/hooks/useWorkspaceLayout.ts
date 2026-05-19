import { useEffect, useState } from 'react';
import { persistWorkspaceLayoutPrefs, readWorkspaceLayoutPrefs } from '../lib/app-helpers';

export function useWorkspaceLayout() {
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(() => readWorkspaceLayoutPrefs().leftCollapsed);
  const [rightInspectorCollapsed, setRightInspectorCollapsed] = useState(() => readWorkspaceLayoutPrefs().rightCollapsed);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() => readWorkspaceLayoutPrefs().leftWidth);
  const [rightInspectorWidth, setRightInspectorWidth] = useState(() => readWorkspaceLayoutPrefs().rightWidth);

  useEffect(() => {
    persistWorkspaceLayoutPrefs({
      leftCollapsed: leftSidebarCollapsed,
      rightCollapsed: rightInspectorCollapsed,
      leftWidth: leftSidebarWidth,
      rightWidth: rightInspectorWidth
    });
  }, [leftSidebarCollapsed, rightInspectorCollapsed, leftSidebarWidth, rightInspectorWidth]);

  return {
    leftSidebarCollapsed,
    setLeftSidebarCollapsed,
    rightInspectorCollapsed,
    setRightInspectorCollapsed,
    leftSidebarWidth,
    setLeftSidebarWidth,
    rightInspectorWidth,
    setRightInspectorWidth
  };
}
