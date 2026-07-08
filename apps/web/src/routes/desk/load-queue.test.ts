// F5 — latest-wins load serialization: a request landing mid-flight is
// never dropped; intermediate requests are collapsed; failures surface
// and never wedge the queue.

import { describe, expect, it } from "vitest";
import { LoadQueue } from "./load-queue";

/** Manually-resolvable job runner recording execution order. */
function harness() {
  const ran: string[] = [];
  const resolvers: Array<() => void> = [];
  const supersededSeen: boolean[] = [];
  const errors: Array<{ error: unknown; req: string }> = [];
  const queue = new LoadQueue<string>(
    (req, superseded) =>
      new Promise<void>((resolve) => {
        ran.push(req);
        resolvers.push(() => {
          supersededSeen.push(superseded());
          resolve();
        });
      }),
    (error, req) => errors.push({ error, req }),
  );
  const finishNext = async () => {
    resolvers.shift()?.();
    await Promise.resolve(); // let the drain loop advance
    await Promise.resolve();
  };
  return { queue, ran, errors, supersededSeen, finishNext };
}

describe("LoadQueue", () => {
  it("runs an idle request immediately", async () => {
    const h = harness();
    h.queue.request("a");
    expect(h.ran).toEqual(["a"]);
    await h.finishNext();
    expect(h.queue.busy).toBe(false);
  });

  it("queues a request arriving mid-flight and runs it after (the F5 repro)", async () => {
    const h = harness();
    h.queue.request("take-1");
    h.queue.request("take-2"); // ~100ms later, take-1 still decoding
    expect(h.ran).toEqual(["take-1"]);
    await h.finishNext();
    expect(h.ran).toEqual(["take-1", "take-2"]);
    await h.finishNext();
    expect(h.queue.busy).toBe(false);
  });

  it("latest wins: intermediate requests are collapsed", async () => {
    const h = harness();
    h.queue.request("a");
    h.queue.request("b");
    h.queue.request("c");
    h.queue.request("d");
    await h.finishNext();
    // b and c never ran; the queue jumped straight to the latest.
    expect(h.ran).toEqual(["a", "d"]);
    await h.finishNext();
    expect(h.ran).toEqual(["a", "d"]);
  });

  it("reports supersession so a stale job can skip follow-up work", async () => {
    const h = harness();
    h.queue.request("a");
    h.queue.request("b");
    await h.finishNext(); // a finishes while b is pending → superseded
    await h.finishNext(); // b finishes with nothing pending
    expect(h.supersededSeen).toEqual([true, false]);
  });

  it("a failed load surfaces the error and the queue keeps going", async () => {
    const errors: Array<{ error: unknown; req: string }> = [];
    const ran: string[] = [];
    const queue = new LoadQueue<string>(
      async (req) => {
        ran.push(req);
        if (req === "bad") throw new Error("decode failed");
      },
      (error, req) => errors.push({ error, req }),
    );
    queue.request("bad");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.req).toBe("bad");
    expect(queue.busy).toBe(false);
    queue.request("good");
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual(["bad", "good"]);
  });
});
