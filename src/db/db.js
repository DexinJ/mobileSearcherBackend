// src/db/db.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// single shared connection
let dbPromise = null;

export async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: process.env.SQLITE_PATH || "./data.sqlite",
      driver: sqlite3.Database,
    });
  }

  return dbPromise;
}

/**
 * Returns YYYY-MM-DD in America/Los_Angeles day boundary.
 * Uses Intl without extra deps.
 */
export function dayKeyLA(date = new Date()) {
  // en-CA formats like YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
