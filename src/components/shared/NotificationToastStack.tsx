import { type JSX } from 'react';
import { X } from 'lucide-react';
import type { AppNotification } from '../../../shared/types';
import { localize, useUiLanguage } from '../../i18n';
import { IconButton } from '../ui/index';

export function NotificationToastStack(props: {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
}): JSX.Element | null {
  const language = useUiLanguage();
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
          <IconButton
            className="notification-toast-dismiss"
            icon={<X size={14} aria-hidden="true" />}
            label={localize(language, '关闭通知', 'Dismiss notification')}
            onClick={() => props.onDismiss(notification.id)}
          />
        </div>
      ))}
    </div>
  );
}
