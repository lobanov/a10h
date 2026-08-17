/**
 * In-process event bus with a ring buffer for SSE resume (Last-Event-ID).
 * job_events in Postgres remain the durable record; this is transport only.
 */
export interface BusEvent {
  id: number;
  event: string;
  data: unknown;
  ts: number;
}

const RING_CAP = 5000;

class EventBus {
  private ring: BusEvent[] = [];
  private nextId = 1;
  private subscribers = new Set<(e: BusEvent) => void>();

  publish(event: string, data: unknown): BusEvent {
    const e: BusEvent = { id: this.nextId++, event, data, ts: Date.now() };
    this.ring.push(e);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    for (const sub of this.subscribers) {
      try {
        sub(e);
      } catch {
        // subscriber errors must not break the bus
      }
    }
    return e;
  }

  subscribe(fn: (e: BusEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** All events with id > since (for SSE replay). */
  replaySince(since: number): BusEvent[] {
    return this.ring.filter((e) => e.id > since);
  }
}

export const bus = new EventBus();
