import { useShareIntentContext } from "expo-share-intent";
import { useEffect, useRef, useState } from "react";
import type { AttachmentComposerContainer } from "./use-attachment-composer";

export interface ShareIntentStaging {
  /** Text to stage into the composer's draft (the share target's shared text/url). `undefined` when nothing is pending. */
  prefillText: string | undefined;
  /** Bump key for `Composer`'s `prefillVersion` prop — see its doc for why a version, not the text itself, triggers staging. */
  prefillVersion: number;
}

/**
 * Consumes `expo-share-intent`'s context (set up once, at the app
 * root — see `app/_layout.tsx`) and stages whatever arrived — a
 * shared image into the attachment composer, or shared text/a URL
 * into the composer's draft — then resets the share intent so it
 * does not re-stage on the next render or app resume. Handles both
 * cold start (the app was launched by the share) and warm start (the
 * app was already open) the same way: `hasShareIntent` flips true
 * either way once `expo-share-intent`'s native module resolves it.
 *
 * Per `odd/tasks/mvp.md`'s "No confirmations" owner decision read
 * narrowly for this case — sharing is still one explicit owner
 * action, so staging (not auto-sending) is correct: the owner can add
 * a caption and sending stays one more tap, never automatic.
 */
export function useShareIntentStaging(
  attachmentComposer: AttachmentComposerContainer,
): ShareIntentStaging {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined);
  const [prefillVersion, setPrefillVersion] = useState(0);
  const handledRef = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || handledRef.current) {
      return;
    }
    handledRef.current = true;

    const imageFile = shareIntent.files?.find((file) => file.mimeType?.startsWith("image/"));
    if (imageFile) {
      attachmentComposer.stageSharedPhoto(
        imageFile.path,
        imageFile.mimeType ?? "image/jpeg",
        imageFile.fileName ?? `shared-${Date.now()}.jpg`,
      );
    } else if (shareIntent.text) {
      setPrefillText(shareIntent.text);
      setPrefillVersion((v) => v + 1);
    }

    resetShareIntent();
  }, [hasShareIntent, shareIntent, attachmentComposer, resetShareIntent]);

  useEffect(() => {
    if (!hasShareIntent) {
      handledRef.current = false;
    }
  }, [hasShareIntent]);

  return { prefillText, prefillVersion };
}
