// Postgres access. In production Netlify Database provides the connection; COACH_DB_URL overrides it
// for local testing against any Postgres.
import { getDatabase } from "@netlify/database";

export type Q = <T = any>(text: string, params?: unknown[]) => Promise<T[]>;

let instance: ReturnType<typeof getDatabase> | null = null;
const database = () =>
  (instance ??= process.env.COACH_DB_URL
    ? getDatabase({ connectionString: process.env.COACH_DB_URL })
    : getDatabase());

export const q: Q = async (text, params = []) => (await database().pool.query(text, params as any[])).rows;

// Runs fn inside one transaction. Use for anything that must not interleave (booking, releasing money).
export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await database().pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(async (text, params = []) => (await client.query(text, params as any[])).rows);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
