// bot/handlers/callbacks.js
import { channelToDiscussion } from "../state.js";

export function registerCallbackHandlers(bot, env) {
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (!data) return;

    // === ОДОБРЕНИЕ ПУБЛИКАЦИИ ===
    if (data.startsWith("approve:")) {
      const draftId = data.replace("approve:", "");

      const draft = ctx.session?.drafts?.[draftId];
      if (!draft) {
        await ctx.answerCbQuery("Черновик не найден");
        return;
      }

      // Публикуем в канал
      const posted = await ctx.telegram.copyMessage(
        env.CHANNEL_ID,
        draft.chatId,
        draft.messageId
      );

      // 🔗 СОХРАНЯЕМ СВЯЗКУ КАНАЛ → ОБСУЖДЕНИЕ
      if (posted.message_thread_id) {
        channelToDiscussion.set(posted.message_id, {
          discussionChatId: env.CHANNEL_ID,
          discussionMsgId: posted.message_thread_id,
        });
      }

      // 🔗 ССЫЛКА НА ПОСТ В ПРИВАТНОМ КАНАЛЕ
      const internalId = String(env.CHANNEL_ID).startsWith("-100")
        ? String(env.CHANNEL_ID).slice(4)
        : String(Math.abs(env.CHANNEL_ID));

      const postLink = `https://t.me/c/${internalId}/${posted.message_id}`;

      // Ответ пользователю
      await ctx.telegram.sendMessage(
        draft.authorId,
        `✅ Ваша тема опубликована!\n\n🔗 ${postLink}`
      );

      await ctx.editMessageReplyMarkup();
      await ctx.answerCbQuery("Опубликовано");

      return;
    }

    // === ОТКЛОНЕНИЕ ===
    if (data.startsWith("reject:")) {
      const draftId = data.replace("reject:", "");
      const draft = ctx.session?.drafts?.[draftId];

      if (draft) {
        await ctx.telegram.sendMessage(
          draft.authorId,
          "❌ Ваша тема отклонена модератором."
        );
      }

      await ctx.editMessageReplyMarkup();
      await ctx.answerCbQuery("Отклонено");
    }
  });
}
