// index.js — Webhook-first, Polling-fallback
import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";

// === ENV ===
const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHANNEL_ID    = process.env.CHANNEL_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const CHANNEL_LINK  = process.env.CHANNEL_LINK || null;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// === подключение твоих модулей/хендлеров ===
// пример (оставь как у тебя):
import { registerModerationHandlers } from "./bot/handlers/moderation.js";
import { registerCallbackHandlers }   from "./bot/handlers/callbacks.js";
// если есть другие: import ...

const ENV = { CHANNEL_ID, ADMIN_CHAT_ID, CHANNEL_LINK };
registerModerationHandlers(bot, ENV);
registerCallbackHandlers(bot, ENV);

// === WEBHOOK SERVER (Render-friendly) ===
const app  = express();
const PORT = process.env.PORT || 10000;
app.use(bodyParser.json());

// healthcheck, чтобы было, чем будить/проверять сервис
app.get("/health", (_req, res) => res.status(200).send("ok"));

// вычисляем базовый URL: WEBHOOK_URL (если явно дали) или RENDER_EXTERNAL_URL (Render сам задаёт)
const BASE_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "";
const HOOK_PATH = `/webhook/${BOT_TOKEN}`;
const HOOK_URL  = BASE_URL ? `${BASE_URL}${HOOK_PATH}` : null;

// главный запуск
async function start() {
  if (HOOK_URL) {
    // режим WEBHOOK
    await bot.telegram.setWebhook(HOOK_URL);

    // КРИТИЧЕСКОЕ: мгновенно отдаём 200, обработку делаем асинхронно
    app.post(HOOK_PATH, (req, res) => {
      res.sendStatus(200);
      bot.handleUpdate(req.body).catch(err => console.error("handleUpdate error:", err));
    });

    app.listen(PORT, () => {
      console.log(`Webhook server listening on :${PORT}`);
      console.log(`Webhook set to: ${HOOK_URL}`);
    });
  } else {
    // fallback: POLLING (локально, в тестовом окружении без внешнего URL и т.п.)
    await bot.launch();
    console.log("Long polling started (no BASE_URL set)");
  }
}

start().catch((e) => {
  console.error("Bot start error:", e);
  process.exit(1);
});

// корректное завершение
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
