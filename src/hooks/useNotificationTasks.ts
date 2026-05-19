import { useState } from 'react';
import type { ScheduledNotificationTask } from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';

export function useNotificationTasks(language: UiLanguage) {
  const [notificationTasks, setNotificationTasks] = useState<ScheduledNotificationTask[]>([]);
  const [isLoadingNotificationTasks, setIsLoadingNotificationTasks] = useState(false);
  const [notificationTaskError, setNotificationTaskError] = useState('');

  async function refreshNotificationTasks(): Promise<void> {
    setIsLoadingNotificationTasks(true);
    setNotificationTaskError('');
    try {
      setNotificationTasks(await window.funplay.listNotificationTasks());
    } catch (error) {
      setNotificationTaskError(error instanceof Error ? error.message : localize(language, '通知任务读取失败。', 'Failed to load notification tasks.'));
    } finally {
      setIsLoadingNotificationTasks(false);
    }
  }

  async function handleCancelNotificationTask(taskId: string): Promise<void> {
    setNotificationTaskError('');
    try {
      await window.funplay.cancelNotificationTask(taskId);
      await refreshNotificationTasks();
    } catch (error) {
      setNotificationTaskError(error instanceof Error ? error.message : localize(language, '通知任务取消失败。', 'Failed to cancel notification task.'));
    }
  }

  return {
    notificationTasks,
    isLoadingNotificationTasks,
    notificationTaskError,
    refreshNotificationTasks,
    handleCancelNotificationTask
  };
}
