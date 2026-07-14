// src/db/initDb.js
import fs from "fs";
import path from "path";
import { getDb } from "./db.js";

export async function initDb() {
  const db = await getDb();

  const schemaPath = path.join(process.cwd(), "src/db/schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  await db.exec(schema);

  console.log("✅ Database schema initialized");
}
