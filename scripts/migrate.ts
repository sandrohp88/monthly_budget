import { runMigrations } from "../lib/db/client";

runMigrations();
console.warn("migrations applied");
