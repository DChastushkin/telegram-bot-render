// bot/index.js
import { Telegraf } from "telegraf";

import { registerAccessHandlers } from "./handlers/access.js";
import { registerModerationHandlers } from "./handlers/moderation.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";

import { tryHandleAnonReply } from "./submit.js";

export function createBot(env) {
  const bot = new Telegraf(env.BOT_TOKEN);

  // ===========================
  // 🕶 АНОНИМНЫЙ КОММЕНТАРИЙ
  // перехватываем ЛЮБОЙ текст
  // ===========================
  bot.on("text", async (ctx, next) => {
    try {
      const handled = await tryHandleAnonReply(ctx);
      if (handled) return;
    } catch (e) {
      console.error("Anon reply middleware error:", e);
    }
    return next();
  });

  // обычные хендлеры
  registerAccessHandlers(bot, env);
  registerModerationHandlers(bot, env);
  registerCallbackHandlers(bot, env);

  return bot;
}
