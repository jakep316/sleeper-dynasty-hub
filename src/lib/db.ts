import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// Create a single PG pool for the whole app
const globalForPg = globalThis as unknown as { pgPool?: Pool; prisma?: PrismaClient };

const pool =
  globalForPg.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    // Neon requires SSL. Your URL already has sslmode=require, but this helps ensure it works.
    ssl: { rejectUnauthorized: false },
  });

const adapter = new PrismaPg(pool);

export const db =
  globalForPg.prisma ??
  new PrismaClient({
    adapter,
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPg.pgPool = pool;
  globalForPg.prisma = db;
}
