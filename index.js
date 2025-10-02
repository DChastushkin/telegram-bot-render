// index.js — сервер для Render + запуск бота (webhook в проде / polling локально)
// ESM: в package.json должно быть "type": "module"

import express from "express";
import { createBot } from "./bot.js";

const {
  BOT_TOKEN,
  CHANNEL_ID,     // -100xxxxxxxxxx или @username
  ADMIN_CHAT_ID,  // ID админ-чата или вашего аккаунта
  APP_URL,        // https://<service>.onrender.com (Render -> Environment)
  PORT            // Render проставит сам
} = process.env;

if (!BOT_TOKEN || !CHANNEL_ID || !ADMIN_CHAT_ID) {
  console.error("❌ Нужны переменные окружения: BOT_TOKEN, CHANNEL_ID, ADMIN_CHAT_ID");
  process.exit(1);
}

const app = express();
app.get("/", (_, res) => res.send("OK — bot is alive")); // healthcheck

// Создаём бота (вся логика внутри bot.js)
const bot = createBot({ BOT_TOKEN, CHANNEL_ID, ADMIN_CHAT_ID });

// Всегда слушаем порт — Render проверяет, что сервис «живой»
const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => {
  console.log(`HTTP server listening on ${listenPort}`);
});

(async () => {
  try {
    if (APP_URL) {
      // PROD: WEBHOOK
      const secretPath = `/webhook/${BOT_TOKEN.slice(0, 10)}`;
      app.use(express.json());
      app.use(secretPath, bot.webhookCallback(secretPath));

      await bot.telegram.setWebhook(`${APP_URL}${secretPath}`, {
        drop_pending_updates: true
      });
      console.log("Webhook set to:", `${APP_URL}${secretPath}`);
    } else {
      // LOCAL: POLLING
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.launch({ dropPendingUpdates: true });
      console.log("Bot launched in polling mode");
    }
  } catch (err) {
    console.error("Bot start error:", err);
  }
})();

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
