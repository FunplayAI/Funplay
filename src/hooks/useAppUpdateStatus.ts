import { useEffect, useState } from 'react';
import type { AppUpdateSnapshot } from '../../shared/types';

export function useAppUpdateStatus() {
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateSnapshot | null>(null);

  useEffect(() => {
    if (!window.funplay?.onAppUpdateStatus) {
      return;
    }

    let disposed = false;
    void window.funplay.getUpdateStatus()
      .then((snapshot) => {
        if (!disposed) {
          setAppUpdateStatus(snapshot);
        }
      })
      .catch(() => {
      });

    const dispose = window.funplay.onAppUpdateStatus((snapshot) => {
      setAppUpdateStatus(snapshot);
    });

    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  async function refreshAppUpdateStatus(): Promise<AppUpdateSnapshot> {
    const snapshot = await window.funplay.getUpdateStatus();
    setAppUpdateStatus(snapshot);
    return snapshot;
  }

  async function checkForUpdates(): Promise<AppUpdateSnapshot> {
    const snapshot = await window.funplay.checkForUpdates();
    setAppUpdateStatus(snapshot);
    return snapshot;
  }

  async function downloadUpdate(): Promise<AppUpdateSnapshot> {
    const snapshot = await window.funplay.downloadUpdate();
    setAppUpdateStatus(snapshot);
    return snapshot;
  }

  async function installUpdate(): Promise<AppUpdateSnapshot> {
    const snapshot = await window.funplay.installUpdate();
    setAppUpdateStatus(snapshot);
    return snapshot;
  }

  return { appUpdateStatus, refreshAppUpdateStatus, checkForUpdates, downloadUpdate, installUpdate };
}
