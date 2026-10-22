import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Reads `audio` fully into memory: a path is read from disk, a Buffer is
 * returned unchanged. Every adapter needs the audio as bytes exactly
 * once, to either send a raw body (AssemblyAI's upload) or attach it as
 * a multipart file part (Speechmatics, Groq).
 */
export async function readAudioBuffer(audio: string | Buffer): Promise<Buffer> {
  return typeof audio === "string" ? readFile(audio) : audio;
}

/**
 * Best-effort file extension for a MIME type, used only to give
 * uploaded audio a plausible filename for providers that key format
 * detection off the filename extension (Speechmatics, Groq) in addition
 * to, or instead of, the multipart part's declared Content-Type.
 *
 * Covers the containers each provider's docs confirm supporting. An
 * unrecognized MIME type still produces a filename: the extension falls
 * back to the MIME subtype as-is, which is the best guess available
 * without baking a provider-specific format list in here.
 */
const EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mp4": "mp4",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

/**
 * A filename for `audio`: its own basename when it is a file path, or a
 * synthesized `audio.<ext>` when it is an in-memory Buffer with no name
 * of its own.
 */
export function fileNameFor(audio: string | Buffer, mimeType: string): string {
  if (typeof audio === "string") {
    return basename(audio);
  }

  const extension =
    EXTENSIONS_BY_MIME_TYPE[mimeType.toLowerCase()] ?? mimeType.split("/")[1] ?? "bin";
  return `audio.${extension}`;
}
