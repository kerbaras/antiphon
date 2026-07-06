import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10 });
  return drizzle(client, { schema });
}

/** Apply migrations at boot (dev, CI, and prod all run the same path). */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
}

export { schema };
