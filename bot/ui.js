// bot/ui.js
import { Markup } from "telegraf";
import { isMember } from "./utils.js";

export const newUserMenu = () => Markup.keyboard([["🔓 Запросить доступ в канал"]]).resize();
export const memberMenu  = () => Markup.keyboard([["📝 Предложить тему/вопрос"]]).resize();

export const choiceKeyboard = () =>
  Markup.inlineKeyboard([
    [{ text: "🧭 Нужен совет",       callback_data: JSON.stringify({ t: "choose", v: "advice"  }) }],
    [{ text: "💬 Хочу высказаться",  callback_data: JSON.stringify({ t: "choose", v: "express" }) }]
  ]);

export const composeKeyboard = () =>
  Markup.inlineKeyboard([
    [{ text: "✅ Готово",  callback_data: JSON.stringify({ t: "compose_done"   }) }],
    [{ text: "❌ Отмена",  callback_data: JSON.stringify({ t: "compose_cancel" }) }],
  ]);

export async function showMenuByStatus(ctx, channelId) {
  const member = await isMember(ctx, channelId);
  if (member) {
    await ctx.reply("Вы участник канала. Можете предложить тему.", memberMenu());
  } else {
    await ctx.reply(
      "Чтобы предлагать темы, запросите доступ в канал. В нем будут публикации и их обсуждение.",
      newUserMenu()
    );
  }
}
