# macOS Release Packaging

Last updated: 2026-05-13

## Current Release Identity

- App version: `0.2.0`
- Bundle ID: `ai.funplay.desktop`
- Product name: `Funplay`
- Apple ID: `zhangyx798@sina.com`
- Apple Team ID: `72NDWCYZJZ`
- Signing identity: `Developer ID Application: yuanxiang zhang (72NDWCYZJZ)`
- Output directory: `release/`

Do not commit the Apple app-specific password. Keep it in a local password manager, shell secret, or macOS Keychain item.

## Version Bump

```bash
npm version 0.2.0 --no-git-tag-version
```

This updates both `package.json` and `package-lock.json`.

## Build, Sign, And Notarize

Use the same universal macOS packaging path as the previous release:

```bash
export APPLE_ID="zhangyx798@sina.com"
export APPLE_TEAM_ID="72NDWCYZJZ"
export APPLE_APP_SPECIFIC_PASSWORD="<apple-app-specific-password>"

npm run dist
npm run rebuild:native:force
```

`npm run dist` runs:

```bash
npm run dist:mac:universal
```

which performs:

1. `ensure:claude-sdk:darwin-x64`
2. `npm run build`
3. `electron-builder --mac --universal`

The current `package.json` `build.mac` config uses:

- `target`: `dmg`, `zip`
- `notarize`: `true`
- `x64ArchFiles`: `**/node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/claude`

## Expected Artifacts

After a successful release build:

```text
release/mac-universal/Funplay.app
release/Funplay-0.2.0-universal.dmg
release/Funplay-0.2.0-universal.dmg.blockmap
release/Funplay-0.2.0-universal-mac.zip
release/Funplay-0.2.0-universal-mac.zip.blockmap
release/latest-mac.yml
```

## Verification

Check version metadata:

```bash
plutil -p release/mac-universal/Funplay.app/Contents/Info.plist \
  | rg "CFBundleShortVersionString|CFBundleVersion|CFBundleIdentifier"
```

Expected values for `0.2.0`:

```text
CFBundleIdentifier => ai.funplay.desktop
CFBundleShortVersionString => 0.2.0
CFBundleVersion => 0.2.0
```

Check Developer ID signature:

```bash
codesign -dv --verbose=4 release/mac-universal/Funplay.app
```

Expected identity:

```text
Developer ID Application: yuanxiang zhang (72NDWCYZJZ)
```

Check Gatekeeper notarization:

```bash
spctl -a -vvv -t exec release/mac-universal/Funplay.app
```

Expected result:

```text
accepted
source=Notarized Developer ID
```

Check stapled app ticket:

```bash
xcrun stapler validate release/mac-universal/Funplay.app
```

Expected result:

```text
The validate action worked!
```

Check the DMG behavior:

```bash
xcrun stapler validate release/Funplay-0.2.0-universal.dmg
```

Current expected behavior matches the previous release: the `.dmg` itself does not have a stapled ticket. The app inside the generated artifacts is the notarized/stapled object.

Check update metadata:

```bash
sed -n '1,120p' release/latest-mac.yml
```

Check artifact hashes:

```bash
shasum -a 256 \
  release/Funplay-0.2.0-universal.dmg \
  release/Funplay-0.2.0-universal-mac.zip
```

## Troubleshooting

If electron-builder prints this message:

```text
skipped macOS notarization reason=`notarize` options were unable to be generated
```

then the signing certificate was found, but notarization credentials were not available to electron-builder. Set one of the supported credential groups before running `npm run dist`:

```bash
export APPLE_ID="zhangyx798@sina.com"
export APPLE_TEAM_ID="72NDWCYZJZ"
export APPLE_APP_SPECIFIC_PASSWORD="<apple-app-specific-password>"
```

or configure a notarytool Keychain profile and run with:

```bash
export APPLE_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
export APPLE_KEYCHAIN_PROFILE="<notarytool-profile-name>"
npm run dist
```

If `npm run dist` installs or rebuilds native modules, always finish with:

```bash
npm run rebuild:native:force
```

This restores `better-sqlite3` for the Electron ABI used by `npm run dev`.
