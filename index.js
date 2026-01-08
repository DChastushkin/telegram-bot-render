// index.js (ESM)

import "dotenv/config";
import express from "express";

import { createBot } from "./bot/index.js";

// ===== ENV =====
const BOT_MODE = process.env.BOT_MODE || "prod";
const PORT = process.env.PORT || 10000;

// BASE_URL обязателен на Render
// пример: https://telegram-bot-render-eimj.onrender.com
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const WEBHOOK_PATH = "/webhook";

if (!BASE_URL) {
  console.error("❌ BASE_URL is not set. Webhook mode requires BASE_URL.");
  process.exit(1);
}

const WEBHOOK_URL = `${BASE_URL}${WEBHOOK_PATH}`;

console.log("================================");
console.log("🤖 BOT STARTING");
console.log("MODE:", BOT_MODE);
console.log("BASE_URL:", BASE_URL);
console.log("WEBHOOK_URL:", WEBHOOK_URL);
console.log("CHANNEL_ID:", process.env.CHANNEL_ID);
console.log("ADMIN_CHAT_ID:", process.env.ADMIN_CHAT_ID);
console.log("================================");

// ===== BOT =====
const bot = createBot(process.env);

// ===== APP =====
const app = express();
app.use(express.json({ limit: "2mb" }));

// Healthcheck
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Webhook handler
app.use(bot.webhookCallback(WEBHOOK_PATH));

// ===== START =====
async function start() {
  app.listen(PORT, async () => {
    console.log(`✅ HTTP server listening on :${PORT}`);

    try {
      // на всякий случай чистим polling
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.telegram.setWebhook(WEBHOOK_URL);
      console.log(`✅ Webhook set to: ${WEBHOOK_URL}`);
    } catch (e) {
      console.error("❌ Failed to set webhook:", e);
      process.exit(1);
    }
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

start().catch((e) => {
  console.error("❌ Fatal error on start:", e);
  process.exit(1);
});
