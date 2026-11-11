/**
 * Runs jobs in order within each lane (a conversation) and lanes side by side, at most `limit` at
 * once, so a slow job (an answer waiting on Meta or on a download) holds back only its own lane.
 * In memory: whatever must survive a restart lives in the database, not here.
 */
export class KeyedLanes {
  private readonly lanes = new Map<string, Promise<void>>()
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(
    private readonly limit: number,
    private readonly onError: (key: string, error: unknown) => void,
  ) {}

  /** Queues the job after the previous one of its lane; returns at once. */
  run(key: string, job: () => Promise<void>): void {
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const next = previous.then(() => this.slot(key, job))
    this.lanes.set(key, next)
    void next.finally(() => {
      if (this.lanes.get(key) === next) this.lanes.delete(key)
    })
  }

  /** Lanes with a job queued or running. */
  get size(): number {
    return this.lanes.size
  }

  /** Resolves once every job queued so far has finished, or after `timeoutMs`. */
  async idle(timeoutMs = Infinity): Promise<void> {
    let expired = false
    const timer = Number.isFinite(timeoutMs)
      ? new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()).then(() => {
          expired = true
        })
      : new Promise<void>(() => undefined)
    while (this.lanes.size && !expired) await Promise.race([Promise.allSettled([...this.lanes.values()]), timer])
  }

  private async slot(key: string, job: () => Promise<void>): Promise<void> {
    // A free slot is taken; otherwise the job waits until one is handed over (never more than `limit`).
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active++
    try {
      await job()
    } catch (error) {
      this.onError(key, error)
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}
