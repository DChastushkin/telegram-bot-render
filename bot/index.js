import { Telegraf } from "telegraf";

import { registerAccessHandlers } from "./handlers/access.js";
import { registerModerationHandlers } from "./handlers/moderation.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";

import { tryHandleAnonReply } from "./submit.js";
import { pendingAnonReplies, channelToDiscussion } from "./state.js";
import { showMenuByStatus } from "./ui.js";

console.error("🔥 BOT INDEX LOADED v2026-02-01");

export function createBot(env) {
  const bot = new Telegraf(env.BOT_TOKEN);

  /* ===============================
     /start — МАРШРУТИЗАТОР
     =============================== */
  bot.start(async (ctx) => {
    const payload = ctx.startPayload;

    // 🔹 Анонимный комментарий по диплинку
    if (payload && payload.startsWith("anon_")) {
      const channelMsgId = Number(payload.replace("anon_", ""));
      if (channelMsgId) {
        pendingAnonReplies.set(ctx.from.id, {
          channelMsgId,
          createdAt: Date.now(),
        });

        await ctx.reply(
          "✏️ Напишите анонимный комментарий.\nОн будет опубликован в обсуждении темы."
        );
        return;
      }
    }

    // 🔹 Обычный старт
    await showMenuByStatus(ctx, env.CHANNEL_ID);
  });

  /* =====================================================
     ГЛАВНЫЙ MESSAGE-HANDLER (ЕДИНСТВЕННЫЙ)
     ===================================================== */
  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;

    // ===== DEBUG: подтверждаем, что апдейт реально пришёл
    console.error("📥 MESSAGE IN BOT", {
      chatId: msg.chat?.id,
      messageId: msg.message_id,
      hasText: !!msg.text,
      hasPhoto: !!msg.photo,
      hasVideo: !!msg.video,
      hasDocument: !!msg.document,
    });

    /* =========================================
       СВЯЗЬ КАНАЛ → DISCUSSION GROUP
       ========================================= */
    if (msg.chat?.type === "group" || msg.chat?.type === "supergroup") {
      if (
        msg.reply_to_message &&
        msg.reply_to_message.forward_from_chat &&
        msg.reply_to_message.forward_from_chat.id === Number(env.CHANNEL_ID)
      ) {
        const channelMsgId =
          msg.reply_to_message.forward_from_message_id;

        if (channelMsgId) {
          channelToDiscussion.set(channelMsgId, {
            discussionChatId: msg.chat.id,
            discussionMsgId:
              msg.message_thread_id ?? msg.message_id,
          });
        }
      }
    }

    /* =================================
       АНОНИМНЫЕ КОММЕНТАРИИ (ТОЛЬКО ТЕКСТ)
       ================================= */
    if (msg.text) {
      const handled = await tryHandleAnonReply(ctx);
      if (handled) return;
    }

    return next();
  });

  /* ===== РЕГИСТРАЦИЯ ОСТАЛЬНЫХ ХЕНДЛЕРОВ ===== */
  registerAccessHandlers(bot, env);
  registerModerationHandlers(bot, env);
  registerCallbackHandlers(bot, env);

  return bot;
}
