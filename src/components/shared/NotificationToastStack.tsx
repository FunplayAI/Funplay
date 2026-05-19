import { type JSX } from 'react';
import type { AppNotification } from '../../../shared/types';

export function NotificationToastStack(props: {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
}): JSX.Element | null {
  if (props.notifications.length === 0) {
    return null;
  }

  return (
    <div className="notification-toast-stack" role="status" aria-live="polite">
      {props.notifications.map((notification) => (
        <div key={notification.id} className={`notification-toast ${notification.priority}`}>
          <div className="notification-toast-copy">
            <strong>{notification.title}</strong>
            {notification.body ? <span>{notification.body}</span> : null}
          </div>
          <button className="notification-toast-dismiss" onClick={() => props.onDismiss(notification.id)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
