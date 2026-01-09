// index.js (ESM)

import "dotenv/config";
import express from "express";

import { createBot } from "./bot/index.js";
import state from "./bot/state.js";

const {
  channelToDiscussion,
  pendingAnonReplies
} = state;

// ===== ENV =====
const BOT_MODE = process.env.BOT_MODE || "prod";
const PORT = process.env.PORT || 10000;

const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const WEBHOOK_PATH = "/webhook";

if (!BASE_URL) {
  console.error("❌ BASE_URL is not set");
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

/**
 * ===================================================
 * 🔐 АНОНИМНЫЙ КОММЕНТАРИЙ — ПЕРЕХВАТ ТЕКСТА
 * ===================================================
 * middleware, срабатывает ДО всех handlers
 */
bot.use(async (ctx, next) => {
  if (!ctx.message || !ctx.message.text || !ctx.from) {
    return next();
  }

  const uid = ctx.from.id;
  const pending = pendingAnonReplies.get(uid);

  if (!pending) {
    return next();
  }

  const { channelMsgId } = pending;
  const link = channelToDiscussion.get(channelMsgId);

  if (!link) {
    await ctx.reply(
      "⚠️ Обсуждение к этой теме пока не найдено.\nПопробуйте чуть позже."
    );
    return;
  }

  const { discussionChatId, discussionMsgId } = link;

  try {
    await ctx.telegram.sendMessage(
      discussionChatId,
      ctx.message.text,
      { reply_to_message_id: discussionMsgId }
    );

    await ctx.reply("✅ Анонимный комментарий опубликован.");
  } catch (e) {
    console.error("❌ Anon reply error:", e);
    await ctx.reply("❌ Не удалось опубликовать комментарий.");
  } finally {
    pendingAnonReplies.delete(uid);
  }

  // ⛔ ВАЖНО: не пускаем дальше
  return;
});

/**
 * ===================================================
 * /start anon:<channelMsgId>
 * ===================================================
 */
bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (payload && payload.startsWith("anon:")) {
    const channelMsgId = Number(payload.split(":")[1]);

    if (!channelMsgId) {
      await ctx.reply("Некорректная ссылка.");
      return;
    }

    pendingAnonReplies.set(ctx.from.id, {
      channelMsgId,
      createdAt: Date.now()
    });

    await ctx.reply(
      "🕶 Напишите анонимный комментарий к теме.\nОн будет опубликован без указания автора."
    );
    return;
  }

  await ctx.reply("Привет! Используйте меню ниже 👇");
});

/**
 * ===================================================
 * 📌 Привязка поста канала к сообщению обсуждения
 * ===================================================
 */
bot.on("message", (ctx, next) => {
  const msg = ctx.message;
  if (!msg) return next();

  if (
    msg.forward_from_chat &&
    msg.forward_from_chat.type === "channel" &&
    typeof msg.forward_from_message_id === "number"
  ) {
    const channelMsgId = msg.forward_from_message_id;

    channelToDiscussion.set(channelMsgId, {
      discussionChatId: msg.chat.id,
      discussionMsgId: msg.message_id
    });

    console.log(
      "💬 Discussion linked:",
      channelMsgId,
      "→",
      msg.chat.id,
      msg.message_id
    );
  }

  return next();
});

// ===== APP =====
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.send("ok"));

app.use(bot.webhookCallback(WEBHOOK_PATH));

// ===== START =====
async function start() {
  app.listen(PORT, async () => {
    console.log(`✅ HTTP server listening on :${PORT}`);

    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.telegram.setWebhook(WEBHOOK_URL);
      console.log(`✅ Webhook set to: ${WEBHOOK_URL}`);
    } catch (e) {
      console.error("❌ Webhook error:", e);
      process.exit(1);
    }
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

start().catch((e) => {
  console.error("❌ Fatal error:", e);
  process.exit(1);
});
