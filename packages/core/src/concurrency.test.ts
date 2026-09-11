import { describe, expect, test } from "bun:test";
import { mapBounded } from "./concurrency";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("mapBounded", () => {
  test("reaches but never exceeds the configured concurrency and preserves order", async () => {
    let active = 0;
    let maximum = 0;
    const values = Array.from({ length: 12 }, (_, index) => index);
    const results = await mapBounded(values, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await pause(5);
      active -= 1;
      return value * 2;
    });

    expect(maximum).toBeLessThanOrEqual(4);
    expect(maximum).toBe(4);
    expect(results).toEqual(values.map((value) => value * 2));
  });

  test("releases runners and rejects when a task fails", async () => {
    let active = 0;
    await expect(mapBounded(Array.from({ length: 20 }, (_, index) => index), async (value) => {
      active += 1;
      try {
        await pause(2);
        if (value === 3) throw new Error("task failed");
        return value;
      } finally {
        active -= 1;
      }
    })).rejects.toThrow("task failed");
    expect(active).toBe(0);
  });

  test("rejects invalid limits and observes cancellation", async () => {
    await expect(mapBounded([1], async (value) => value, { concurrency: 0 })).rejects.toThrow("positive integer");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(mapBounded([1], async (value) => value, { signal: controller.signal })).rejects.toThrow("cancelled");
  });
});
