import { getShareExtensionKey } from "expo-share-intent";

/**
 * Routes a cold- or warm-started "Share with Bitacora" intent (T10
 * work unit (b)) straight to the chat tab, where
 * `useShareIntentStaging` (`src/features/chat/use-share-intent-staging.ts`)
 * picks up the shared image/text. Everything else passes through
 * unchanged. See `expo-share-intent`'s own `expo-router` integration
 * docs for why this file's name and export are exactly this shape —
 * `expo-router` calls it before resolving any other route.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) {
      return "/(tabs)/chat";
    }
    return path;
  } catch {
    return path;
  }
}
