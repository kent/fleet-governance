import { afterEach, expect, it, vi } from "vitest";
import { CloudError } from "./google.js";
import { statusPublisher } from "./status-publisher.js";

afterEach(() => vi.useRealTimers());

it("coalesces concurrent complete snapshots and spaces writes to the same object", async () => {
  vi.useFakeTimers();
  const writes: { value: unknown; at: number }[] = [];
  const publish = statusPublisher(async value => { writes.push({ value, at: Date.now() }); });
  const pending = [publish({ events: [1] }), publish({ events: [1, 2] }), publish({ events: [1, 2, 3] })];
  await vi.runAllTimersAsync(); await Promise.all(pending);
  const final = publish({ events: [1, 2, 3, 4] });
  await vi.runAllTimersAsync(); await final;
  expect(writes.map(write => write.value)).toEqual([{ events: [1, 2, 3] }, { events: [1, 2, 3, 4] }]);
  expect(writes[1]!.at - writes[0]!.at).toBeGreaterThanOrEqual(1100);
});

it("retries throttled telemetry without retrying an agent action", async () => {
  vi.useFakeTimers();
  const write = vi.fn().mockRejectedValueOnce(new CloudError(429, "storage")).mockResolvedValue(undefined);
  const pending = statusPublisher(write)({ events: ["ballot.confirmed"] });
  await vi.runAllTimersAsync(); await pending;
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
});

it("preserves the ability to publish a terminal record after an earlier batch fails", async () => {
  vi.useFakeTimers();
  const write = vi.fn().mockRejectedValueOnce(new CloudError(403, "storage")).mockResolvedValue(undefined);
  const publish = statusPublisher(write);
  const failed = publish({ events: ["working"] }).catch(error => error);
  await vi.runAllTimersAsync(); expect(await failed).toBeInstanceOf(CloudError);
  const terminal = publish({ events: ["working", "run.failed"], terminal: true });
  await vi.runAllTimersAsync(); await terminal;
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[1]![0].terminal).toBe(true);
});
