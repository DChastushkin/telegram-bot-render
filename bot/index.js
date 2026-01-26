import { Telegraf } from "telegraf";

import { registerAccessHandlers } from "./handlers/access.js";
import { registerModerationHandlers } from "./handlers/moderation.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";

import { tryHandleAnonReply } from "./submit.js";
import { pendingAnonReplies, channelToDiscussion } from "./state.js";
import { showMenuByStatus } from "./ui.js";

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

    // 🔹 Обычный старт — СТАРАЯ ЛОГИКА БОТА
    await showMenuByStatus(ctx, env.CHANNEL_ID);
  });

  /* =========================================
     СВЯЗЬ КАНАЛ → DISCUSSION GROUP
     ========================================= */
  bot.on("message", async (ctx, next) => {
    const msg = ctx.message;

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

    return next();
  });

  /* =================================
     АНОНИМНЫЕ КОММЕНТАРИИ
     ================================= */
  // FIX: раньше был bot.on("text") — медиа не доходили до moderation
  bot.on("message", async (ctx, next) => {
    if (ctx.message?.text) {
      const handled = await tryHandleAnonReply(ctx);
      if (handled) return;
    }
    return next();
  });

  registerAccessHandlers(bot, env);
  registerModerationHandlers(bot, env);
  registerCallbackHandlers(bot, env);

  return bot;
}
