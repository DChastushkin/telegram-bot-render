// index.js (root)

require("dotenv").config();

const express = require("express");
const morgan = require("morgan");

// Твой бот (экземпляр Telegraf)
const bot = require("./bot");

// ====== ENV ======
const PORT = process.env.PORT || 10000;

// BASE_URL должен быть именно таким:
// https://without-mask.onrender.com
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");

const WEBHOOK_PATH = "/webhook";              // без токена
const WEBHOOK_URL = BASE_URL ? `${BASE_URL}${WEBHOOK_PATH}` : "";

// ====== APP ======
const app = express();

// Telegram шлёт JSON — парсим
app.use(express.json({ limit: "2mb" }));

// Логи запросов (очень помогает)
app.use(morgan("tiny"));

// Healthcheck (для Render и для пингов)
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Главная строка: Telegraf сам обрабатывает webhook и сам отвечает 200
app.use(bot.webhookCallback(WEBHOOK_PATH));

// ====== START ======
async function start() {
  // 1) Всегда стартуем HTTP сервер
  app.listen(PORT, async () => {
    console.log(`✅ HTTP server listening on :${PORT}`);

    // 2) Если BASE_URL задан — работаем через webhook (Render)
    if (BASE_URL) {
      try {
        await bot.telegram.setWebhook(WEBHOOK_URL);
        console.log(`✅ Webhook set to: ${WEBHOOK_URL}`);
      } catch (e) {
        console.error("❌ Failed to set webhook:", e);
      }
    } else {
      // 3) Если BASE_URL нет — локальная разработка через polling
      try {
        await bot.launch();
        console.log("✅ Bot launched with long polling (BASE_URL is empty)");
      } catch (e) {
        console.error("❌ Failed to launch bot with polling:", e);
      }
    }
  });

  // Graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

start().catch((e) => console.error("❌ Fatal start error:", e));
