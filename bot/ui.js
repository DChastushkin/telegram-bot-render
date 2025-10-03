// bot/ui.js
import { Markup } from "telegraf";
import { isMember } from "./utils.js";

export const newUserMenu = () => Markup.keyboard([["🔓 Запросить доступ в канал"]]).resize();
export const memberMenu  = () => Markup.keyboard([["📝 Предложить тему/вопрос"]]).resize();

// inline-кнопки выбора типа обращения
export const choiceKeyboard = () => Markup.inlineKeyboard([
  [{ text: "🧭 Нужен совет", callback_data: JSON.stringify({ t: "choose", v: "advice" }) }],
  [{ text: "💬 Хочу высказаться", callback_data: JSON.stringify({ t: "choose", v: "express" }) }]
]);

export async function showMenuByStatus(ctx, channelId) {
  const member = await isMember(ctx, channelId);
  if (member) {
    await ctx.reply("Вы участник канала. Можете предложить тему.", memberMenu());
  } else {
    await ctx.reply("Чтобы предлагать темы, запросите доступ в канал.", newUserMenu());
  }
}
