// src/config/env.js
import dotenv from "dotenv";

dotenv.config();

export const PORT = process.env.PORT || 3000;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");
