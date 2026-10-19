/**
 * In-process queue that runs one job at a time, in arrival order.
 *
 * One at a time is deliberate: two messages from the same customer must be
 * handled in order, and a single store's volume is a few messages per minute.
 * Durability does not live here but in webhook_events: anything lost from
 * memory is picked up again by the recovery sweep.
 */
export class SerialQueue {
  private readonly keys = new Set<number>()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly worker: (key: number) => Promise<void>,
    private readonly onError: (key: number, error: unknown) => void,
  ) {}

  /** Returns false when the key is already queued or running. */
  push(key: number): boolean {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    this.tail = this.tail.then(async () => {
      try {
        await this.worker(key)
      } catch (error) {
        this.onError(key, error)
      } finally {
        this.keys.delete(key)
      }
    })
    return true
  }

  get size(): number {
    return this.keys.size
  }

  /** Resolves once every job queued so far has finished. */
  async idle(): Promise<void> {
    while (this.keys.size > 0) await this.tail
  }
}
