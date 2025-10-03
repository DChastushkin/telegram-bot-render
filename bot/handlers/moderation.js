// bot/handlers/moderation.js
import { newUserMenu, memberMenu } from "../ui.js";
import { isMember, handleRejectionReason } from "../utils.js";
import {
  awaitingTopic, pendingRejections, pendingRejectionsByAdmin, pendingSubmissions
} from "../state.js";

export function registerModerationHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID } = env;

  // «Предложить тему» (только для участников)
  bot.hears("📝 Предложить тему/вопрос", async (ctx) => {
    if (!(await isMember(ctx, CHANNEL_ID))) {
      await ctx.reply("❌ Вы ещё не участник канала. Сначала запросите доступ.", newUserMenu());
      return;
    }
    awaitingTopic.add(ctx.from.id);
    await ctx.reply("Напишите вашу тему одним сообщением (или /cancel для отмены).");
  });

  bot.command("cancel", async (ctx) => {
    awaitingTopic.delete(ctx.from.id);
    await ctx.reply("Отменено.", await isMember(ctx, CHANNEL_ID) ? memberMenu() : newUserMenu());
  });

  // Общий обработчик сообщений
  bot.on("message", async (ctx, next) => {
    try {
      // 1) Ответ модератора с причиной (в админ-чате)
      if (String(ctx.chat?.id) === String(ADMIN_CHAT_ID)) {
        const replyTo = ctx.message?.reply_to_message;

        // 1a) Реплай на подсказку/карточку/копию
        if (replyTo) {
          const key = replyTo.message_id;
          const entry = pendingRejections.get(key);
          if (entry) { await handleRejectionReason(ctx, entry, { ADMIN_CHAT_ID }); return; }
        }
        // 1b) «План Б»: следующее сообщение без реплая
        const planB = pendingRejectionsByAdmin.get(ctx.from.id);
        if (planB) { await handleRejectionReason(ctx, planB, { ADMIN_CHAT_ID }); return; }
      }

      // 2) Пользователь прислал тему (любой тип), если ждали
      if (awaitingTopic.has(ctx.from.id)) {
        if (!(await isMember(ctx, CHANNEL_ID))) {
          awaitingTopic.delete(ctx.from.id);
          await ctx.reply("❌ Вы больше не участник канала. Сначала запросите доступ.", newUserMenu());
          return;
        }

        awaitingTopic.delete(ctx.from.id);

        const srcChatId = ctx.chat.id;
        const srcMsgId  = ctx.message.message_id;

        // инфо об авторе
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "—";
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID,
          `👤 От: @${ctx.from.username || "—"}\nID: ${ctx.from.id}\nИмя: ${name}`
        );

        // копия исходника в админ-чат
        const copied = await ctx.telegram.copyMessage(ADMIN_CHAT_ID, srcChatId, srcMsgId);

        // карточка модерации
        const cbData = (t) => JSON.stringify({ t, uid: ctx.from.id });
        const control = await ctx.telegram.sendMessage(
          ADMIN_CHAT_ID,
          "📝 Новая предложенная тема (см. сообщение выше).",
          { reply_markup: { inline_keyboard: [[
            { text: "📣 Опубликовать", callback_data: cbData("publish") },
            { text: "🚫 Отклонить",   callback_data: cbData("reject")  }
          ]] } }
        );

        pendingSubmissions.set(control.message_id, {
          srcChatId, srcMsgId, authorId: ctx.from.id, adminCopyMsgId: copied.message_id
        });

        await ctx.reply("Тема отправлена на модерацию.", memberMenu());
        return;
      }

      return next();
    } catch (e) {
      console.error("message handler error:", e);
      return next();
    }
  });
}
