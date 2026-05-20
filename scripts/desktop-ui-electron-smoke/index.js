import('../desktop-ui-electron-smoke.mjs').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
