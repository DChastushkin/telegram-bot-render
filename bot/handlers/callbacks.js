// bot/handlers/callbacks.js
import { isOldQueryError } from "../utils.js";
import { memberMenu } from "../ui.js";
import {
  pendingSubmissions, pendingRejections, pendingRejectionsByAdmin
} from "../state.js";

// безопасный esc для HTML
const esc = (s = "") =>
  String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

// пытаемся получить кликабельную ссылку на канал и его имя
async function resolveChannelLink(ctx, CHANNEL_ID, CHANNEL_LINK) {
  let title = "канал";
  try {
    const chat = await ctx.telegram.getChat(CHANNEL_ID);
    if (chat?.title) title = chat.title;
    // 1) если явно передали ссылку через ENV — берём её
    if (CHANNEL_LINK) return { link: CHANNEL_LINK, title };

    // 2) если у канала есть username — строим публичную ссылку
    if (chat?.username) {
      return { link: `https://t.me/${chat.username}`, title };
    }

    // 3) пробуем получить «основную» инвайт-ссылку
    try {
      const primary = await ctx.telegram.exportChatInviteLink(CHANNEL_ID);
      if (primary) return { link: primary, title };
    } catch {}

    // 4) создаём новую инвайт-ссылку (join-request, безопасно для приватных каналов)
    try {
      const inv = await ctx.telegram.createChatInviteLink(CHANNEL_ID, {
        creates_join_request: true,
        name: `link_${Date.now()}`
      });
      if (inv?.invite_link) return { link: inv.invite_link, title };
    } catch {}
  } catch {}

  return { link: null, title };
}

export function registerCallbackHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID, CHANNEL_LINK } = env;

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

      // approve — ОТПРАВЛЯЕМ ССЫЛКУ НА КАНАЛ
      if (p.t === "approve") {
        await ctx.telegram.approveChatJoinRequest(p.cid, p.uid);
        await ctx.editMessageReplyMarkup();

        try {
          const { link, title } = await resolveChannelLink(ctx, CHANNEL_ID, CHANNEL_LINK);
          if (link) {
            await ctx.telegram.sendMessage(
              p.uid,
              `✅ Вам одобрен доступ в канал <a href="${link}">${esc(title)}</a>.`,
              { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: memberMenu().reply_markup }
            );
          } else {
            // запасной вариант — без ссылки
            await ctx.telegram.sendMessage(
              p.uid,
              `✅ Вам одобрен доступ в канал «${title}». Откройте список чатов — канал появится сверху.`,
              { reply_markup: memberMenu().reply_markup }
            );
          }
        } catch (e) {
          console.error("approve notify error:", e);
        }
        return;
      }

      // decline
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
        const adminMsg = ctx.update.callback_query.message;
        await ctx.telegram.copyMessage(CHANNEL_ID, ADMIN_CHAT_ID, adminMsg.message_id);
        await ctx.editMessageReplyMarkup();
        return;
      }

      // reject — запрос причины
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
