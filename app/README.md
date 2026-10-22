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
- `src/features/chat/` — chat container (hooks) and presentational components
  (atoms/molecules): `MessageBubble`, `Composer`, `CitationText`,
  `CitationSheet`, `ToolActivityIndicator`, `UndoBar`. `use-chat.ts` runs
  text and attachment turns; `use-attachment-composer.ts` owns
  photo/voice staging; `use-share-intent-staging.ts` feeds a shared
  image/text from another app into the composer.
- `src/features/about-you/` — the "What I know about you" tab's
  containers (`use-topics.ts`, `use-topic-detail.ts`, `use-rules.ts`,
  `use-changes.ts`) and presentational rows (`TopicRow`, `MemoryRow`,
  `RuleRow`, `ChangeRow`, `TopicHeader`). Reuses the chat feature's
  `CitationSheet`/`useCitationEntry` for a memory's source citation.
- `src/i18n/` — English/Spanish dictionary and provider.
- `src/theme/` — color/spacing/type tokens (light + dark).

Native `android/`/`ios/` folders are intentionally not committed (Continuous
Native Generation — `npx expo prebuild` regenerates them from `app.json`).

## Permissions

The app requests these Android permissions at runtime, only when the
owner uses the feature that needs them (never on launch):

- **Camera** (`android.permission.CAMERA`) — taking a photo to attach
  (`expo-image-picker`'s `launchCameraAsync`).
- **Photos/media library** (read access) — picking an existing photo
  to attach (`expo-image-picker`'s `launchImageLibraryAsync`).
- **Microphone** (`android.permission.RECORD_AUDIO`) — recording a
  voice note (`expo-audio`). Both `expo-image-picker` and `expo-audio`
  declare this permission (image-picker's own plugin adds it
  unconditionally unless explicitly blocked); setting it to `false` on
  `expo-image-picker` instead *blocks* the permission app-wide via a
  manifest `tools:node="remove"`, which silently breaks voice
  recording — do not do that; the harmless duplicate `<uses-permission>`
  is the correct tradeoff (confirmed against the generated manifest,
  see `app.json`'s `expo-image-picker`/`expo-audio` plugin config).

None of this is requestable from Expo Go — see "Extension points"
below.

## Android share target ("Share with Bitacora")

Sharing an image or plain text from another app (e.g. a screenshot
from the gallery, or a link from a browser) opens Bitacora's chat tab
with the content staged in the composer — the owner can add a caption
and sending is still one explicit tap, never automatic (per
`odd/tasks/mvp.md`'s "No confirmations" decision, read narrowly: the
share itself is already one explicit owner action, so staging rather
than auto-sending is the correct amount of friction).

Implemented with `expo-share-intent` (`app/+native-intent.ts` routes
the share to `/(tabs)/chat`; `src/features/chat/use-share-intent-staging.ts`
stages it). **This only works in a dev or production build — never in
Expo Go** (it needs a native module/config plugin), and only on
Android (`disableIOS: true` in `app.json`; this project targets Android
only per `odd/tasks/mvp.md`'s scope).

## Extension points (not implemented here)

- Widgets (quick note, today) and reply-from-notification (stage 3,
  T14/T15 — not T10's scope).
