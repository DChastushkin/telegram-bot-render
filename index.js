// index.js (ESM)

import "dotenv/config";
import express from "express";
import morgan from "morgan";

import { createBot } from "./bot/index.js";

// ===== ENV =====
const PORT = process.env.PORT || 10000;

// BASE_URL, например:
// https://without-mask.onrender.com
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");

const WEBHOOK_PATH = "/webhook";
const WEBHOOK_URL = BASE_URL ? `${BASE_URL}${WEBHOOK_PATH}` : "";

// Создаём бота из твоей фабрики
const bot = createBot(process.env);

// ===== APP =====
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(morgan("tiny"));

// Healthcheck
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Webhook handler (Telegraf сам отвечает 200)
app.use(bot.webhookCallback(WEBHOOK_PATH));

// ===== START =====
async function start() {
  app.listen(PORT, async () => {
    console.log(`✅ HTTP server listening on :${PORT}`);

    if (BASE_URL) {
      try {
        await bot.telegram.setWebhook(WEBHOOK_URL);
        console.log(`✅ Webhook set to: ${WEBHOOK_URL}`);
      } catch (e) {
        console.error("❌ Failed to set webhook:", e);
      }
    } else {
      // локальный режим (polling)
      try {
        await bot.launch();
        console.log("✅ Bot launched with long polling");
      } catch (e) {
        console.error("❌ Failed to launch bot:", e);
      }
    }
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

start().catch((e) => {
  console.error("❌ Fatal error on start:", e);
});
