import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

export function useDialogFocus(options: {
  enabled: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  restoreFocus?: boolean;
}): void {
  const { enabled, containerRef, initialFocusRef, onEscape, restoreFocus = true } = options;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const dialogContainer = container;
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusableElements = (): HTMLElement[] => Array.from(
      dialogContainer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((element) => {
      if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || element === document.activeElement;
    });

    const focusInitialElement = (): void => {
      const explicitInitial = initialFocusRef?.current;
      const target =
        explicitInitial && dialogContainer.contains(explicitInitial)
          ? explicitInitial
          : getFocusableElements()[0] ?? dialogContainer;
      target.focus();
    };

    window.setTimeout(focusInitialElement, 0);

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialogContainer.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (!dialogContainer.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (restoreFocus) {
        window.setTimeout(() => {
          previousActiveElement?.focus();
        }, 0);
      }
    };
  }, [containerRef, enabled, initialFocusRef, onEscape, restoreFocus]);
}
