export const refreshFileTreeEventName = 'refresh-file-tree';

export interface RefreshFileTreeDetail {
  projectId?: string;
  reason?: 'project-opened' | 'project-created' | 'prompt-completed' | 'watcher' | 'manual';
}

export function dispatchRefreshFileTree(detail: RefreshFileTreeDetail = {}): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent<RefreshFileTreeDetail>(refreshFileTreeEventName, { detail }));
}

export function subscribeRefreshFileTree(listener: (detail: RefreshFileTreeDetail) => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handler = (event: Event): void => {
    listener((event as CustomEvent<RefreshFileTreeDetail>).detail ?? {});
  };

  window.addEventListener(refreshFileTreeEventName, handler);
  return () => window.removeEventListener(refreshFileTreeEventName, handler);
}
