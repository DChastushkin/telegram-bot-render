// bot/handlers/callbacks.js
import { isOldQueryError } from "../utils.js";
import { memberMenu } from "../ui.js";
import {
  pendingSubmissions, pendingRejections, pendingRejectionsByAdmin
} from "../state.js";

export function registerCallbackHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID } = env;

  bot.on("callback_query", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      if (String(ctx.chat?.id) !== String(ADMIN_CHAT_ID)) {
        await ctx.answerCbQuery("Нет доступа"); return;
      }

      const adminId = ctx.from.id;
      const p = JSON.parse(ctx.update.callback_query.data || "{}");

      // unban
      if (p.t === "unban") {
        try {
          await ctx.telegram.unbanChatMember(CHANNEL_ID, p.uid);
          await ctx.editMessageReplyMarkup();
          try { await ctx.telegram.sendMessage(p.uid, "✅ Вы разблокированы. Нажмите «Запросить доступ» ещё раз."); } catch {}
        } catch (e) { console.error("unban error:", e); }
        return;
      }

      // approve / decline (join)
      if (p.t === "approve") {
        await ctx.telegram.approveChatJoinRequest(p.cid, p.uid);
        await ctx.editMessageReplyMarkup();
        try {
          await ctx.telegram.sendMessage(p.uid, "✅ Вам одобрен доступ в канал.");
          await ctx.telegram.sendMessage(p.uid, "Добро пожаловать! Теперь вы можете предложить тему.", {
            reply_markup: memberMenu().reply_markup
          });
        } catch {}
        return;
      }
      if (p.t === "decline") {
        await ctx.telegram.declineChatJoinRequest(p.cid, p.uid);
        await ctx.editMessageReplyMarkup();
        try { await ctx.telegram.sendMessage(p.uid, "❌ Доступ в канал отклонён."); } catch {}
        return;
      }

      // publish
      if (p.t === "publish") {
        const control = ctx.update.callback_query.message;
        const bind = pendingSubmissions.get(control.message_id);
        if (bind) {
          const { srcChatId, srcMsgId, authorId } = bind;
          await ctx.telegram.copyMessage(CHANNEL_ID, srcChatId, srcMsgId);
          await ctx.editMessageReplyMarkup();
          try { await ctx.telegram.sendMessage(authorId, "✅ Ваша тема опубликована."); } catch {}
          pendingSubmissions.delete(control.message_id);
          return;
        }
        // fallback
        const adminMsg = ctx.update.callback_query.message;
        await ctx.telegram.copyMessage(CHANNEL_ID, ADMIN_CHAT_ID, adminMsg.message_id);
        await ctx.editMessageReplyMarkup();
        return;
      }

      // reject — запрос причины (принимаем реплай или следующее сообщение)
      if (p.t === "reject") {
        const control = ctx.update.callback_query.message;
        const prompt = await ctx.telegram.sendMessage(
          ADMIN_CHAT_ID,
          "✍️ Напишите причину отклонения ответом на ЭТО сообщение (или просто следующим сообщением).",
          { reply_to_message_id: control.message_id }
        );

        const entry = { authorId: p.uid, modMsgId: control.message_id, modText: control.text || "" };

        pendingRejections.set(prompt.message_id, entry);          // 1) на подсказку
        pendingRejections.set(control.message_id, entry);         // 2) на карточку
        const bind = pendingSubmissions.get(control.message_id);  // 3) на копию
        if (bind?.adminCopyMsgId) pendingRejections.set(bind.adminCopyMsgId, entry);

        pendingRejectionsByAdmin.set(adminId, entry);             // «план Б»
        return;
      }

      await ctx.answerCbQuery("Неизвестное действие").catch(() => {});
    } catch (e) {
      if (!isOldQueryError(e)) console.error("callback_query error:", e);
      try { await ctx.answerCbQuery("Ошибка").catch(() => {}); } catch {}
    }
  });
}
