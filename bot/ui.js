// bot/ui.js
import { Markup } from "telegraf";
import { isMember } from "./utils.js";

// Единый текст-подсказка для не-участников
export const NON_MEMBER_HINT =
  "Чтобы предлагать темы, запросите доступ в канал. В нем будут публикации и их обсуждение.";

// Клавиатуры
export const newUserMenu = () =>
  Markup.keyboard([["🔓 Запросить доступ в канал"]]).resize();

export const memberMenu = () =>
  Markup.keyboard([["📝 Предложить тему/вопрос"]]).resize();

export const choiceKeyboard = () =>
  Markup.inlineKeyboard([
    [{ text: "🧭 Нужен совет",      callback_data: JSON.stringify({ t: "choose", v: "advice"  }) }],
    [{ text: "💬 Хочу высказаться", callback_data: JSON.stringify({ t: "choose", v: "express" }) }],
  ]);

export const composeKeyboard = () =>
  Markup.inlineKeyboard([
    [{ text: "✅ Готово",  callback_data: JSON.stringify({ t: "compose_done"   }) }],
    [{ text: "❌ Отмена",  callback_data: JSON.stringify({ t: "compose_cancel" }) }],
  ]);

// Показ единой подсказки для не-участников
export async function showNonMemberHint(ctx) {
  await ctx.reply(NON_MEMBER_HINT, newUserMenu());
}

// Показываем меню в зависимости от статуса
export async function showMenuByStatus(ctx, channelId) {
  const member = await isMember(ctx, channelId);
  if (member) {
    await ctx.reply("Вы участник канала. Можете предложить тему.", memberMenu());
  } else {
    await showNonMemberHint(ctx);
  }
}
