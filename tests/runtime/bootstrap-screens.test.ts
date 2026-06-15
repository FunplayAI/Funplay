import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BootstrapScreens } from '../../src/components/pages/BootstrapScreens.tsx';

/**
 * The early-return screens extracted from App.tsx. BootstrapScreens is a pure
 * presentational component, so the loading / error / workspace-null switch is
 * pinned by passing props directly. The welcome/onboarding branches are covered
 * by WelcomeScreen / OnboardingScreen's own render tests.
 */

function render(overrides: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(BootstrapScreens, {
      isLoading: false,
      bootstrapError: '',
      appMode: 'workspace',
      setAppMode: () => undefined,
      projects: [],
      language: 'zh-CN',
      mcpPlugins: [],
      onboarding: {} as never,
      openProject: () => undefined,
      appNotifications: [],
      dismissNotification: () => undefined,
      ...overrides
    } as never)
  );
}

test('BootstrapScreens shows the loading splash while isLoading', () => {
  assert.match(render({ isLoading: true }), /正在加载 Funplay/);
});

test('BootstrapScreens shows the error card on bootstrapError', () => {
  const html = render({ bootstrapError: 'kaboom' });
  assert.match(html, /启动失败/);
  assert.match(html, /kaboom/);
});

test('BootstrapScreens prefers the loading splash over a bootstrap error', () => {
  assert.match(render({ isLoading: true, bootstrapError: 'kaboom' }), /正在加载 Funplay/);
});

test('BootstrapScreens renders nothing once the workspace is active', () => {
  assert.equal(render({ appMode: 'workspace' }), '');
});
