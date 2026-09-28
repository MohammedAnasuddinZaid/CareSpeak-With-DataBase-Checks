/**
 * Write-path notification helper.
 *
 * Every mutation must call one of these *after* the durable write succeeds.
 * Order matters: MySQL first, then publish. Publishing first would let a
 * subscriber reconcile and read a row that does not exist yet, producing a
 * spurious gap that only heals on the next slow tick.
 *
 * The functions are deliberately fire-and-forget (they return void, not a
 * promise) so a slow or unreachable bus can never add latency to, or fail, a
 * clinical write. The failure mode is a missed push, which the SSE reconcile
 * tick repairs within seconds. The alternative — awaiting the bus — would make
 * Redis availability part of the critical path for recording a vital sign.
 */
import { getBus, topics, streams } from "./realtime";

export type ConsoleEventType =
  | "gesture"
  | "metrics"
  | "vitals"
  | "reply"
  | "status"
  | "alert";

/**
 * Notify every live viewer of a bedside console.
 *
 * `durable` additionally appends to a Redis Stream, giving a reconnecting
 * client a bounded replay window. It costs one extra command, so it is opt-in
 * and reserved for events where a missed frame has clinical consequence —
 * replies and alerts, not per-frame vitals.
 */
export function publishConsoleEvent(
  sessionCode: string,
  type: ConsoleEventType,
  data: unknown,
  options: { durable?: boolean } = {},
): void {
  if (!sessionCode) return;
  void (async () => {
    try {
      const bus = await getBus();
      if (options.durable) {
        await bus.append(streams.console(sessionCode), {
          type,
          data,
          at: Date.now(),
        });
      } else {
        await bus.publish(topics.console(sessionCode), { type, data, at: Date.now() });
      }
    } catch (err) {
      console.error(
        `[publish] failed to notify ${type} for ${sessionCode}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/** Notify a ward-level view (the wall display) after any bed changes. */
export function publishWardEvent(wardId: number | string, type: string, data: unknown): void {
  void (async () => {
    try {
      const bus = await getBus();
      await bus.publish(topics.ward(wardId), { type, data, at: Date.now() });
    } catch {
      // Same reasoning as above: a missed ward ping is cosmetic.
    }
  })();
}
