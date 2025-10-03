// bot/handlers/callbacks.js
import { isOldQueryError } from "../utils.js";
import { memberMenu } from "../ui.js";
import { submitDraftToModeration } from "../submit.js";
import {
  pendingSubmissions, pendingRejections, pendingRejectionsByAdmin, pendingDrafts
} from "../state.js";

// esc для HTML
const esc = (s = "") => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");

// строим ссылку на канал (как раньше)
async function resolveChannelLink(ctx, CHANNEL_ID, CHANNEL_LINK) {
  let title = "канал";
  try {
    const chat = await ctx.telegram.getChat(CHANNEL_ID);
    if (chat?.title) title = chat.title;
    if (CHANNEL_LINK) return { link: CHANNEL_LINK, title };
    if (chat?.username) return { link: `https://t.me/${chat.username}`, title };
    try { const l = await ctx.telegram.exportChatInviteLink(CHANNEL_ID); if (l) return { link: l, title }; } catch {}
    try {
      const inv = await ctx.telegram.createChatInviteLink(CHANNEL_ID, { creates_join_request: true, name: `link_${Date.now()}` });
      if (inv?.invite_link) return { link: inv.invite_link, title };
    } catch {}
  } catch {}
  return { link: null, title };
}

const ADVICE_HEADER = "Новое обращение от подписчика - требуется обратная связь";

export function registerCallbackHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID, CHANNEL_LINK } = env;

  bot.on("callback_query", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const p = JSON.parse(ctx.update.callback_query.data || "{}");

      // --- USER: выбор типа обращения
      if (p.t === "choose") {
        const uid = ctx.from.id;
        const draft = pendingDrafts.get(uid);
        if (!draft) { await ctx.answerCbQuery("Нет черновика"); return; }

        const intent = p.v === "advice" ? "advice" : "express";
        await submitDraftToModeration({ telegram: ctx.telegram, ADMIN_CHAT_ID }, { user: ctx.from, draft, intent });
        pendingDrafts.delete(uid);

        await ctx.reply("Тема отправлена на модерацию.", memberMenu());
        return;
      }

      // --- ADMIN: всё ниже только из админ-чата
      if (String(ctx.chat?.id) !== String(ADMIN_CHAT_ID)) {
        await ctx.answerCbQuery("Нет доступа"); return;
      }

      const adminId = ctx.from.id;

      // unban
      if (p.t === "unban") {
        try {
          await ctx.telegram.unbanChatMember(CHANNEL_ID, p.uid);
          await ctx.editMessageReplyMarkup();
          try { await ctx.telegram.sendMessage(p.uid, "✅ Вы разблокированы. Нажмите «Запросить доступ» ещё раз."); } catch {}
        } catch (e) { console.error("unban error:", e); }
        return;
      }

      // approve — с кликабельной ссылкой и меню
      if (p.t === "approve") {
        await ctx.telegram.approveChatJoinRequest(p.cid, p.uid);
        await ctx.editMessageReplyMarkup();
        try {
          const { link, title } = await resolveChannelLink(ctx, CHANNEL_ID, CHANNEL_LINK);
          const text = link
            ? `✅ Вам одобрен доступ в канал <a href="${link}">${esc(title)}</a>.`
            : `✅ Вам одобрен доступ в канал «${title}».`;
          await ctx.telegram.sendMessage(p.uid, text, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: memberMenu().reply_markup });
        } catch (e) { console.error("approve notify error:", e); }
        return;
      }

      if (p.t === "decline") {
        await ctx.telegram.declineChatJoinRequest(p.cid, p.uid);
        await ctx.editMessageReplyMarkup();
        try { await ctx.telegram.sendMessage(p.uid, "❌ Доступ в канал отклонён."); } catch {}
        return;
      }

      // publish — один пост с заголовком (если нужен совет)
      if (p.t === "publish") {
        const control = ctx.update.callback_query.message;
        const bind = pendingSubmissions.get(control.message_id);

        if (bind) {
          const { srcChatId, srcMsgId, authorId, intent, kind, supportsCaption, text } = bind;

          if (intent === "advice") {
            if (kind === "text") {
              const combined = `${ADVICE_HEADER}\n\n${text || ""}`.trimEnd();
              await ctx.telegram.sendMessage(CHANNEL_ID, combined);
            } else if (supportsCaption) {
              const caption = text ? `${ADVICE_HEADER}\n\n${text}` : ADVICE_HEADER;
              await ctx.telegram.copyMessage(CHANNEL_ID, srcChatId, srcMsgId, { caption });
            } else {
              // тип без подписи (например, видео-кружок/стикер) — отправим только контент
              await ctx.telegram.copyMessage(CHANNEL_ID, srcChatId, srcMsgId);
            }
          } else {
            // без шапки
            if (kind === "text") {
              await ctx.telegram.sendMessage(CHANNEL_ID, text || "");
            } else {
              await ctx.telegram.copyMessage(CHANNEL_ID, srcChatId, srcMsgId);
            }
          }

          await ctx.editMessageReplyMarkup();

          try {
            await ctx.telegram.sendMessage(
              authorId,
              "✅ Ваша тема опубликована.",
              { reply_markup: memberMenu().reply_markup }
            );
          } catch {}

          pendingSubmissions.delete(control.message_id);
          return;
        }

        // fallback
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

        pendingRejections.set(prompt.message_id, entry);
        pendingRejections.set(control.message_id, entry);
        const bind = pendingSubmissions.get(control.message_id);
        if (bind?.adminCopyMsgId) pendingRejections.set(bind.adminCopyMsgId, entry);

        pendingRejectionsByAdmin.set(adminId, entry);
        return;
      }

      await ctx.answerCbQuery("Неизвестное действие").catch(() => {});
    } catch (e) {
      if (!isOldQueryError(e)) console.error("callback_query error:", e);
      try { await ctx.answerCbQuery("Ошибка").catch(() => {}); } catch {}
    }
  });
}
