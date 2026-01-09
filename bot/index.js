// bot/index.js
import { Telegraf } from "telegraf";

import { registerAccessHandlers } from "./handlers/access.js";
import { registerModerationHandlers } from "./handlers/moderation.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";

import { tryHandleAnonReply } from "./submit.js";
import { pendingAnonReplies } from "./state.js";

export function createBot(env) {
  const bot = new Telegraf(env.BOT_TOKEN);

  // 👉 ОБРАБОТКА ДИПЛИНКА anon_<channelMsgId>
  bot.start(async (ctx) => {
    const payload = ctx.startPayload;

    if (payload && payload.startsWith("anon_")) {
      const channelMsgId = Number(payload.replace("anon_", ""));
      if (channelMsgId) {
        pendingAnonReplies.set(ctx.from.id, {
          channelMsgId,
          createdAt: Date.now(),
        });

        await ctx.reply(
          "✏️ Напишите ваш анонимный комментарий.\nОн будет опубликован в обсуждении."
        );
        return;
      }
    }

    // обычный /start
    await ctx.reply("Привет! Я бот канала.");
  });

  // 👉 ПЕРЕХВАТ ТЕКСТА ДЛЯ АНОНИМНЫХ ОТВЕТОВ
  bot.on("text", async (ctx, next) => {
    const handled = await tryHandleAnonReply(ctx);
    if (handled) return;
    return next();
  });

  registerAccessHandlers(bot, env);
  registerModerationHandlers(bot, env);
  registerCallbackHandlers(bot, env);

  return bot;
}
