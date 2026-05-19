import { useEffect, useState } from 'react';
import { dedupeAppNotifications } from '../lib/app-helpers';
import type { AppNotification } from '../../shared/types';

export function useAppNotifications() {
  const [appNotifications, setAppNotifications] = useState<AppNotification[]>([]);

  useEffect(() => {
    if (!window.funplay?.onAppNotification) {
      return;
    }

    let disposed = false;
    void window.funplay.drainAppNotifications()
      .then((items) => {
        if (!disposed && items.length > 0) {
          setAppNotifications((current) => dedupeAppNotifications([...current, ...items]));
        }
      })
      .catch(() => {
      });

    const dispose = window.funplay.onAppNotification((notification) => {
      setAppNotifications((current) => dedupeAppNotifications([...current, notification]));
    });

    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (appNotifications.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const now = Date.now();
      setAppNotifications((current) =>
        current.filter((notification) => {
          const ageMs = now - Date.parse(notification.createdAt);
          const maxAgeMs = notification.priority === 'urgent' ? 12000 : 7000;
          return ageMs < maxAgeMs;
        })
      );
    }, 1000);

    return () => window.clearTimeout(timeoutId);
  }, [appNotifications]);

  function dismissNotification(id: string): void {
    setAppNotifications((current) => current.filter((notification) => notification.id !== id));
  }

  return { appNotifications, dismissNotification };
}
