// bot/index.js
import { Telegraf } from "telegraf";
import { registerAccessHandlers } from "./handlers/access.js";
import { registerModerationHandlers } from "./handlers/moderation.js";
import { registerCallbackHandlers } from "./handlers/callbacks.js";

export function createBot(env) {
  const bot = new Telegraf(env.BOT_TOKEN);
  registerAccessHandlers(bot, env);
  registerModerationHandlers(bot, env);
  registerCallbackHandlers(bot, env);
  return bot;
}
