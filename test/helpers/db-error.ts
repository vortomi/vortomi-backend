/**
 * Message of the database error a query fails with. Drizzle wraps Postgres errors
 * in "Failed query: ..." and keeps the real one (constraint, policy) as the cause.
 */
export async function dbError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query
  } catch (error) {
    const err = error as Error & { cause?: Error }
    return `${err.message} ${err.cause?.message ?? ''}`
  }
  throw new Error('Expected the query to fail, but it succeeded')
}
