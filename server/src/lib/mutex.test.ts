import { describe, expect, it } from "vitest";
import { Mutex } from "./mutex.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Mutex", () => {
  it("runs queued callbacks one at a time, in call order, even when the first is slower", async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const first = mutex.run(async () => {
      order.push("first:start");
      await delay(20);
      order.push("first:end");
    });
    const second = mutex.run(async () => {
      order.push("second:start");
      await delay(1);
      order.push("second:end");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("does not jam the queue when an earlier callback rejects", async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const failing = mutex.run(async () => {
      order.push("failing");
      throw new Error("boom");
    });
    const after = mutex.run(async () => {
      order.push("after");
    });

    await expect(failing).rejects.toThrow("boom");
    await after;

    expect(order).toEqual(["failing", "after"]);
  });

  it("returns each callback's own result", async () => {
    const mutex = new Mutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });
});
