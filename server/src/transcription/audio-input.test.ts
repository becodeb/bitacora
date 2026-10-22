import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileNameFor, readAudioBuffer } from "./audio-input.js";

describe("readAudioBuffer", () => {
  it("returns the same Buffer unchanged when given one", async () => {
    const buffer = Buffer.from("already-in-memory");

    await expect(readAudioBuffer(buffer)).resolves.toBe(buffer);
  });

  describe("given a file path", () => {
    let dir: string;
    let filePath: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "bitacora-audio-input-test-"));
      filePath = join(dir, "clip.bin");
      await writeFile(filePath, Buffer.from("bytes-from-disk"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads the file's bytes from disk", async () => {
      const result = await readAudioBuffer(filePath);
      const expected = await readFile(filePath);

      expect(result).toEqual(expected);
      expect(result.toString("utf8")).toBe("bytes-from-disk");
    });
  });
});

describe("fileNameFor", () => {
  it("returns the path's own basename when audio is a file path, regardless of mimeType", () => {
    expect(fileNameFor("/some/dir/recording.aac", "audio/aac")).toBe("recording.aac");
  });

  it("synthesizes audio.<ext> for each documented MIME type when audio is a Buffer", () => {
    expect(fileNameFor(Buffer.from("x"), "audio/wav")).toBe("audio.wav");
    expect(fileNameFor(Buffer.from("x"), "audio/mp4")).toBe("audio.mp4");
    expect(fileNameFor(Buffer.from("x"), "audio/ogg")).toBe("audio.ogg");
  });

  it("matches MIME types case-insensitively", () => {
    expect(fileNameFor(Buffer.from("x"), "AUDIO/WAV")).toBe("audio.wav");
  });

  it("falls back to the MIME subtype for an undocumented type", () => {
    expect(fileNameFor(Buffer.from("x"), "audio/x-made-up")).toBe("audio.x-made-up");
  });
});
