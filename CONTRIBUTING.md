# Contributing To Funplay

Thanks for helping improve Funplay. The project is still moving quickly, so small, focused changes are easiest to review and safest to merge.

## Development Setup

```bash
npm install
npm run dev
```

`npm run dev` rebuilds the native Electron dependency ABI before starting the Electron Vite dev server.

## Before Opening A PR

Run the core verification commands:

```bash
npm run build
npm run test:runtime
```

For UI or desktop shell changes, also run:

```bash
npm run ui:smoke
npm run ui:electron-smoke
npm run ui:maturity-gate
```

For release packaging changes, run the relevant release checks documented in `docs/open-source-release-checklist.md` and `docs/mac-release-packaging.md`.

## Native Dependency Warning

Funplay uses `better-sqlite3`, which must match either the Node.js ABI or Electron ABI. Prefer the npm scripts in `package.json`.

After running a single test file manually, restore the Electron ABI:

```bash
npm run rebuild:native:force
```

## Code Boundaries

- `electron/main/` owns main-process services, IPC handlers, persistence, and agent runtimes.
- `electron/preload/` owns the secure context bridge.
- `src/` owns the React renderer UI.
- `shared/` owns cross-process types and shared logic.

Renderer code must not import from `electron/main/`. Main-process code must not import from `src/`.

When adding or changing IPC, update:

- `shared/types.ts` or the relevant `shared/types/*` file
- `electron/preload/index.ts`
- the main-process handler
- `electron/main/ipc-validation.ts`

## Pull Request Shape

Please include:

- What changed and why
- Screenshots or smoke artifact paths for UI changes
- The verification commands you ran
- Any known risks or follow-up work

Keep unrelated refactors out of feature and bugfix PRs.
