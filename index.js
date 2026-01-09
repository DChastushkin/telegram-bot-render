// index.js
import "dotenv/config";
import express from "express";
import { createBot } from "./bot/index.js";
import state from "./bot/state.js";

const { channelToDiscussion, pendingAnonReplies } = state;

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const WEBHOOK_PATH = "/webhook";

if (!BASE_URL) {
  console.error("❌ BASE_URL is not set");
  process.exit(1);
}

const WEBHOOK_URL = `${BASE_URL}${WEBHOOK_PATH}`;

// ===== BOT =====
const bot = createBot(process.env);

// ===== /start anon:<msgId> =====
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
      "🕶 Напишите анонимный комментарий к теме.\n" +
      "Он будет опубликован без указания автора."
    );
    return;
  }

  await ctx.reply("Привет! Используйте меню ниже 👇");
});

// ===== DISCUSSION LINKING =====
bot.on("message", (ctx, next) => {
  const msg = ctx.message;
  if (!msg) return next();

  if (
    msg.forward_from_chat &&
    msg.forward_from_chat.type === "channel" &&
    typeof msg.forward_from_message_id === "number"
  ) {
    channelToDiscussion.set(msg.forward_from_message_id, {
      discussionChatId: msg.chat.id,
      discussionMsgId: msg.message_id
    });
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
app.listen(PORT, async () => {
  console.log(`✅ HTTP server listening on :${PORT}`);

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.telegram.setWebhook(WEBHOOK_URL);
  console.log(`✅ Webhook set to ${WEBHOOK_URL}`);
});
