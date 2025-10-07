// index.js — сервер для Render + запуск бота (ESM)
import express from "express";
import { createBot } from "./bot/index.js";

const {
  BOT_TOKEN,
  CHANNEL_ID,
  ADMIN_CHAT_ID,
  CHANNEL_LINK, // <— опционально: например "https://t.me/your_channel"
  APP_URL,
  PORT
} = process.env;

if (!BOT_TOKEN || !CHANNEL_ID || !ADMIN_CHAT_ID) {
  console.error("❌ ENV нужны: BOT_TOKEN, CHANNEL_ID, ADMIN_CHAT_ID");
  process.exit(1);
}

const app = express();
app.get("/", (_, res) => res.send("OK — bot is alive"));

const bot = createBot({ BOT_TOKEN, CHANNEL_ID, ADMIN_CHAT_ID, CHANNEL_LINK });

const listenPort = Number(PORT) || 3000;
app.listen(listenPort, () => console.log(`HTTP server listening on ${listenPort}`));

// keepalive (только если есть APP_URL)
if (process.env.APP_URL) {
  const periodMin = Number(process.env.KEEPALIVE_MIN || 4); // 4–5 мин
  const url = `${process.env.APP_URL}/?ka=${Date.now()}`;
  setInterval(async () => {
    try {
      await fetch(`${process.env.APP_URL}/?ka=${Date.now()}`);
      console.log(`[keepalive] ping OK ${new Date().toISOString()}`);
    } catch (e) {
      console.log(`[keepalive] ping FAIL: ${e.message}`);
    }
  }, periodMin * 60 * 1000);
}

(async () => {
  try {
    if (APP_URL) {
      const path = `/webhook/${BOT_TOKEN.slice(0, 10)}`;
      app.use(express.json());
      app.use(path, bot.webhookCallback(path));
      await bot.telegram.setWebhook(`${APP_URL}${path}`, { drop_pending_updates: true });
      console.log("Webhook set to:", `${APP_URL}${path}`);
    } else {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.launch({ dropPendingUpdates: true });
      console.log("Bot launched in polling mode");
    }
  } catch (e) {
    console.error("Bot start error:", e);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
