// src/server.js
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";

import { PORT } from "./config/env.js";
import { initFirebaseAdmin } from "./auth/firebase.js";
import { attachRoutes } from "./http/routes.js";
import { attachChatGateway } from "./ws/chatGateway.js";
import { initDb } from "./db/initDB.js";

initFirebaseAdmin();

const app = express();

await initDb();
attachRoutes(app);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/chat" });

attachChatGateway(wss);

server.listen(PORT, () => {
  console.log(`HTTP: http://localhost:${PORT}/health`);
  console.log(`WS:   ws://localhost:${PORT}/chat`);
});
