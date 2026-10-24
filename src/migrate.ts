import { readFileSync } from "node:fs";
import { Store } from "./store.js";
const store = new Store(process.env.DATABASE_URL!);
try {
  await store.pool.query(
    readFileSync(
      new URL("../../migrations/001_base.sql", import.meta.url),
      "utf8",
    ),
  );
} finally {
  await store.pool.end();
}
