import { describe, expect, it, vi } from "vitest";
import { TranscriptionTimeoutError } from "./errors.js";
import { pollUntilDone } from "./poll.js";

describe("pollUntilDone", () => {
  it("returns the result from the first call when it is already done, without sleeping", async () => {
    const poll = vi.fn().mockResolvedValue({ done: true, result: "value" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollUntilDone({
      provider: "test",
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      poll,
      sleep,
    });

    expect(result).toBe("value");
    expect(poll).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("polls again after a not-done result, waiting pollIntervalMs between attempts", async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true, result: 42 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollUntilDone({
      provider: "test",
      pollIntervalMs: 50,
      timeoutMs: 1_000,
      poll,
      sleep,
    });

    expect(result).toBe(42);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("throws TranscriptionTimeoutError, carrying the provider and timeout, once timeoutMs has elapsed", async () => {
    const poll = vi.fn().mockResolvedValue({ done: false });

    await expect(
      pollUntilDone({ provider: "assemblyai", pollIntervalMs: 2, timeoutMs: 10, poll }),
    ).rejects.toThrow(TranscriptionTimeoutError);
  });

  it("propagates an error thrown by poll() immediately, without retrying", async () => {
    const poll = vi.fn().mockRejectedValue(new Error("network blip"));

    await expect(
      pollUntilDone({ provider: "test", pollIntervalMs: 1, timeoutMs: 1_000, poll }),
    ).rejects.toThrow("network blip");
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
