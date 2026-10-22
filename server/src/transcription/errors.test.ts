import { describe, expect, it } from "vitest";
import {
  ProviderFailureError,
  TranscriptionError,
  TranscriptionHttpError,
  TranscriptionTimeoutError,
} from "./errors.js";

describe("transcription errors", () => {
  it("ProviderFailureError carries the provider, status and optional detail, and extends TranscriptionError", () => {
    const error = new ProviderFailureError("assemblyai", "error", "download failed");

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.provider).toBe("assemblyai");
    expect(error.status).toBe("error");
    expect(error.detail).toBe("download failed");
    expect(error.message).toBe(
      "assemblyai reported transcription failure (status: error): download failed",
    );
  });

  it("ProviderFailureError's message omits the colon and detail when none is given", () => {
    const error = new ProviderFailureError("speechmatics", "rejected");

    expect(error.message).toBe("speechmatics reported transcription failure (status: rejected)");
    expect(error.detail).toBeUndefined();
  });

  it("TranscriptionHttpError carries the status code and a body excerpt", () => {
    const error = new TranscriptionHttpError("groq", 401, "invalid api key");

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.statusCode).toBe(401);
    expect(error.body).toBe("invalid api key");
    expect(error.message).toBe("groq request failed with HTTP 401");
  });

  it("TranscriptionTimeoutError carries the timeout duration", () => {
    const error = new TranscriptionTimeoutError("assemblyai", 5_000);

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.timeoutMs).toBe(5_000);
    expect(error.message).toBe("assemblyai polling timed out after 5000ms");
  });
});
