# Bitacora app

Expo (React Native, TypeScript) Android client for Bitacora. Talks to the
server in `../server` over `POST /v1/chat` (SSE), `GET /v1/chat/history`,
`POST /v1/chat/undo`, and `GET /v1/entries/:id` (see
`odd/tasks/mvp.md`, T10).

## Prerequisites

- Node 24, npm.
- A physical Android device or emulator, and either:
  - the Expo Go-equivalent **dev client** (recommended — this project uses
    native modules, so plain Expo Go will not run it), built once via EAS
    (`eas build --profile development --platform android`), or
  - Android Studio/`adb` set up locally for `npx expo run:android`.
- The Bitacora server running and reachable from your phone — either the
  production deploy (`https://bitacora.becode.com.ar`) or your machine's LAN
  address (e.g. `http://192.168.1.50:3000`; find it with `ip addr` or your
  OS's network settings). A phone on Wi-Fi cannot reach `localhost`.
- The server's bearer token (`APP_TOKEN` in the server's env).

## Install

```sh
cd app
npm install
```

## Run (dev client)

```sh
npx expo start --dev-client
```

Scan the QR code from your dev-client build, or press `a` to launch on a
connected/emulated Android device.

## First run

The app opens to a connect screen: enter the server URL and the bearer
token. Both are validated (`GET /health`, then an authed `GET /v1/me`)
before being saved to `expo-secure-store`; nothing is persisted on a failed
check. Change either later from the gear icon → Settings, which also has
the English/Spanish toggle for the UI (AI-generated chat replies are always
Rioplatense Spanish, independent of this setting — see `odd/tasks/mvp.md`).

## Scripts

- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` / `npm run lint:fix` — Biome (same version/style as `../server`).
- `npm test` — Jest (`jest-expo` preset) + `@testing-library/react-native`.
- `npx expo-doctor` — Expo environment/config sanity check.
- `npx expo export --platform android` — proves the JS bundle builds
  without a device. **Known gap on arm64 Linux (e.g. a Raspberry Pi dev
  machine):** this fails at the Hermes bytecode step because the
  `hermes-compiler` package only ships an x86-64 Linux `hermesc` binary;
  `file` on it confirms `ELF 64-bit ... x86-64` on a machine reporting
  `aarch64`. Metro's JS bundling itself succeeds (1000+ modules resolved)
  before that step. This also blocks `eas build` run *locally* on such a
  machine — EAS's own cloud builders are unaffected, since they build on
  x86-64 workers.

## Building an APK

Requires an Expo account (owner input per `odd/tasks/mvp.md`'s T10 row) and
is not run from this writer's task — only the config (`eas.json`) is in
place:

```sh
eas build --profile preview --platform android   # installable APK
eas build --profile development --platform android  # dev client APK
```

## Project shape

- `app/` — `expo-router` file-based routes (the Android screens).
- `src/api/` — typed HTTP/SSE client for the server.
- `src/features/settings/` — connection + language container (hook) and storage.
- `src/features/chat/` — chat container (hook) and presentational components
  (atoms/molecules): `MessageBubble`, `Composer`, `CitationText`,
  `CitationSheet`, `ToolActivityIndicator`, `UndoBar`.
- `src/i18n/` — English/Spanish dictionary and provider.
- `src/theme/` — color/spacing/type tokens (light + dark).

Native `android/`/`ios/` folders are intentionally not committed (Continuous
Native Generation — `npx expo prebuild` regenerates them from `app.json`).

## Extension points (not implemented here)

- Photo/voice attachments in the composer.
- Android share target ("Share with Bitacora").
- The "What I know about you" tab (`app/(tabs)/about-you.tsx` is a
  placeholder route only).
