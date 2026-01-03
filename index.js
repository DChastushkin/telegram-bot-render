// index.js — Webhook-first, Polling-fallback (Render-friendly)
import express from "express";
import bodyParser from "body-parser";
import { Telegraf } from "telegraf";

// ===== ENV =====
const BOT_TOKEN     = process.env.BOT_TOKEN;
const CHANNEL_ID    = process.env.CHANNEL_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const CHANNEL_LINK  = process.env.CHANNEL_LINK || null;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

// ===== Bot init =====
const bot = new Telegraf(BOT_TOKEN);

// наши хендлеры
import { registerModerationHandlers } from "./bot/handlers/moderation.js";
import { registerCallbackHandlers }   from "./bot/handlers/callbacks.js";
import { showMenuByStatus }           from "./bot/ui.js";

const ENV = { CHANNEL_ID, ADMIN_CHAT_ID, CHANNEL_LINK };
registerModerationHandlers(bot, ENV);
registerCallbackHandlers(bot, ENV);

// /start — показать корректное меню
bot.start(async (ctx) => {
  try {
    await showMenuByStatus(ctx, CHANNEL_ID);
  } catch (e) {
    console.error("start handler error:", e);
  }
});

// ===== Web server (для webhook и health) =====
const app  = express();
const PORT = process.env.PORT || 10000;
app.use(bodyParser.json());

// health и корневой роут (убирает 'Cannot GET /')
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/",        (_req, res) => res.status(200).send("ok"));

// базовый URL (Render сам даёт RENDER_EXTERNAL_URL)
const BASE_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "";
const HOOK_PATH = `/webhook/${BOT_TOKEN}`;
const HOOK_URL  = BASE_URL ? `${BASE_URL}${HOOK_PATH}` : null;

// ===== Start =====
async function start() {
  if (HOOK_URL) {
    // ---------- WEBHOOK ----------
    await bot.telegram.setWebhook(HOOK_URL);

    // моментально 200, апдейт — асинхронно (важно для cold start)
    app.post(HOOK_PATH, (req, res) => {
      res.sendStatus(200);
      bot.handleUpdate(req.body).catch(err => console.error("handleUpdate error:", err));
    });

    app.listen(PORT, () => {
      console.log(`Webhook server listening on :${PORT}`);
      console.log(`Webhook set to: ${HOOK_URL}`);
    });
  } else {
    // ---------- POLLING ----------
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await bot.launch();
    console.log("Long polling started (no BASE_URL set)");
  }
}

start().catch((e) => {
  console.error("Bot start error:", e);
  process.exit(1);
});

// корректное завершение
// process.once("SIGINT",  () => bot.stop("SIGINT"));
// process.once("SIGTERM", () => bot.stop("SIGTERM"));
