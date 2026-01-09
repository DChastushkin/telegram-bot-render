// bot/handlers/callbacks.js
import state from "../state.js";
import { submitDraftToModeration } from "../submit.js";

const {
  composingDrafts,
  pendingSubmissions,
  channelToDiscussion,
} = state;

export function registerCallbackHandlers(bot, env) {
  bot.on("callback_query", async (ctx) => {
    try {
      const raw = ctx.callbackQuery?.data;
      if (!raw) return;

      const data = JSON.parse(raw);
      const type = data.t;

      /* =========================
       * ВЫБОР ТИПА ТЕМЫ
       * ========================= */
      if (type === "choose") {
        composingDrafts.set(ctx.from.id, {
          intent: data.v,
          items: [],
        });

        await ctx.editMessageText(
          "✏️ Напишите сообщение. Можно отправить несколько сообщений.\nКогда закончите — нажмите «Готово».",
          { reply_markup: undefined }
        );
        return;
      }

      /* =========================
       * ГОТОВО → НА МОДЕРАЦИЮ
       * ========================= */
      if (type === "compose_done") {
        const draft = composingDrafts.get(ctx.from.id);
        if (!draft || !draft.items.length) {
          await ctx.answerCbQuery("Черновик пуст");
          return;
        }

        await submitDraftToModeration(
          { telegram: ctx.telegram, ADMIN_CHAT_ID: env.ADMIN_CHAT_ID },
          {
            user: ctx.from,
            draft,
            intent: draft.intent,
          }
        );

        composingDrafts.delete(ctx.from.id);

        await ctx.editMessageText(
          "✅ Тема отправлена на модерацию.\nМы уведомим вас после проверки."
        );
        return;
      }

      /* =========================
       * ПУБЛИКАЦИЯ АДМИНОМ
       * ========================= */
      if (type === "publish") {
        const entry = pendingSubmissions.get(ctx.callbackQuery.message.message_id);
        if (!entry) {
          await ctx.answerCbQuery("Черновик не найден");
          return;
        }

        const posted = await ctx.telegram.copyMessage(
          env.CHANNEL_ID,
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id
        );

        if (posted.message_thread_id) {
          channelToDiscussion.set(posted.message_id, {
            discussionChatId: env.CHANNEL_ID,
            discussionMsgId: posted.message_thread_id,
          });
        }

        const internalId = String(env.CHANNEL_ID).startsWith("-100")
          ? String(env.CHANNEL_ID).slice(4)
          : String(Math.abs(env.CHANNEL_ID));

        const link = `https://t.me/c/${internalId}/${posted.message_id}`;

        await ctx.telegram.sendMessage(
          entry.authorId,
          `✅ Ваша тема опубликована!\n\n🔗 ${link}`
        );

        pendingSubmissions.delete(ctx.callbackQuery.message.message_id);

        await ctx.editMessageReplyMarkup();
        await ctx.answerCbQuery("Опубликовано");
        return;
      }

      /* =========================
       * ОТКЛОНЕНИЕ
       * ========================= */
      if (type === "reject") {
        const entry = pendingSubmissions.get(ctx.callbackQuery.message.message_id);
        if (entry) {
          await ctx.telegram.sendMessage(
            entry.authorId,
            "❌ Ваша тема отклонена модератором."
          );
          pendingSubmissions.delete(ctx.callbackQuery.message.message_id);
        }

        await ctx.editMessageReplyMarkup();
        await ctx.answerCbQuery("Отклонено");
      }
    } catch (e) {
      console.error("Callback error:", e);
    }
  });
}
