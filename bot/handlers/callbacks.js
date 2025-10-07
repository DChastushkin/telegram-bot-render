// bot/handlers/callbacks.js
import { isOldQueryError } from "../utils.js";
import { memberMenu, choiceKeyboard } from "../ui.js";
import { submitDraftToModeration } from "../submit.js";
import {
  pendingDrafts, awaitingIntent,
  pendingSubmissions, pendingRejections, pendingRejectionsByAdmin
} from "../state.js";

const esc = (s="") => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const ADVICE_HEADER  = "Новое обращение от подписчика - требуется обратная связь";
const EXPRESS_HEADER = "Новая тема от подписчика";

async function resolveChannelLink(ctx, CHANNEL_ID, CHANNEL_LINK) {
  let title = "канал";
  try {
    const chat = await ctx.telegram.getChat(CHANNEL_ID);
    if (chat?.title) title = chat.title;
    if (CHANNEL_LINK) return { link: CHANNEL_LINK, title };
    if (chat?.username) return { link:`https://t.me/${chat.username}`, title };
    try { const l = await ctx.telegram.exportChatInviteLink(CHANNEL_ID); if (l) return { link:l, title }; } catch {}
    try { const inv = await ctx.telegram.createChatInviteLink(CHANNEL_ID,{creates_join_request:true,name:`link_${Date.now()}`}); if (inv?.invite_link) return { link:inv.invite_link, title }; } catch {}
  } catch {}
  return { link:null, title };
}

export function registerCallbackHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID, CHANNEL_LINK } = env;

  bot.on("callback_query", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const p = JSON.parse(ctx.update.callback_query.data || "{}");

      // Пользователь завершил набор -> выбирает тип
      if (p.t === "compose_done") {
        // обработано в moderation.js, тут просто выходим
        return;
      }
      if (p.t === "compose_cancel") {
        return;
      }

      // Пользователь выбрал тип обращения
      if (p.t === "choose") {
        const uid = ctx.from.id;
        const session = pendingDrafts.get(uid);
        if (!session) { await ctx.answerCbQuery("Нет черновика"); return; }
        const intent = p.v === "advice" ? "advice" : "express";
        await submitDraftToModeration({ telegram: ctx.telegram, ADMIN_CHAT_ID }, { user: ctx.from, draft: session, intent });
        pendingDrafts.delete(uid);
        awaitingIntent.delete(uid);
        await ctx.reply("Тема отправлена на модерацию.", memberMenu());
        return;
      }

      // Ниже — только из админ-чата
      if (String(ctx.chat?.id) !== String(ADMIN_CHAT_ID)) { await ctx.answerCbQuery("Нет доступа"); return; }
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

      // approve
      if (p.t === "approve") {
        await ctx.telegram.approveChatJoinRequest(p.cid, p.uid);
        await ctx.editMessageReplyMarkup();
        try {
          const { link, title } = await resolveChannelLink(ctx, CHANNEL_ID, CHANNEL_LINK);
          const txt = link
            ? `✅ Вам одобрен доступ в канал <a href="${link}">${esc(title)}</a>.`
            : `✅ Вам одобрен доступ в канал «${title}».`;
          await ctx.telegram.sendMessage(p.uid, txt, {
            parse_mode: "HTML", disable_web_page_preview: true, reply_markup: memberMenu().reply_markup
          });
        } catch (e) { console.error("approve notify error:", e); }
        return;
      }

      if (p.t === "decline") {
        await ctx.telegram.declineChatJoinRequest(p.cid, p.uid);
        await ctx.editMessageReplyMarkup();
        try { await ctx.telegram.sendMessage(p.uid, "❌ Доступ в канал отклонён."); } catch {}
        return;
      }

      // publish — поддержка нескольких элементов
      if (p.t === "publish") {
        const control = ctx.update.callback_query.message;
        const bind = pendingSubmissions.get(control.message_id);
        if (bind) {
          const { authorId, intent, items } = bind;
          const header = intent === "advice" ? ADVICE_HEADER : EXPRESS_HEADER;

          // первая публикация — максимально «одним постом», если возможно
          const first = items[0];

          if (first.kind === "text") {
            const combined = `${header}\n\n${first.text || ""}`.trimEnd();
            await ctx.telegram.sendMessage(CHANNEL_ID, combined);
          } else if (first.supportsCaption) {
            const caption = first.text ? `${header}\n\n${first.text}` : header;
            await ctx.telegram.copyMessage(CHANNEL_ID, first.srcChatId, first.srcMsgId, { caption });
          } else {
            // (стикер/кружок) — шапка отдельным постом, затем контент
            await ctx.telegram.sendMessage(CHANNEL_ID, header);
            await ctx.telegram.copyMessage(CHANNEL_ID, first.srcChatId, first.srcMsgId);
          }

          // остальные элементы публикуем как есть, сохраняя порядок
          for (let i = 1; i < items.length; i++) {
            const it = items[i];
            await ctx.telegram.copyMessage(CHANNEL_ID, it.srcChatId, it.srcMsgId);
          }

          await ctx.editMessageReplyMarkup();

          try {
            await ctx.telegram.sendMessage(authorId, "✅ Ваша тема опубликована.", {
              reply_markup: memberMenu().reply_markup
            });
          } catch {}

          pendingSubmissions.delete(control.message_id);
          return;
        }

        // fallback: очень старая карточка
        const adminMsg = ctx.update.callback_query.message;
        await ctx.telegram.copyMessage(CHANNEL_ID, ADMIN_CHAT_ID, adminMsg.message_id);
        await ctx.editMessageReplyMarkup();
        return;
      }

      // reject — запрос причины (привяжем ко всем скопированным сообщениям)
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
        if (bind?.adminCopyMsgIds) {
          for (const id of bind.adminCopyMsgIds) pendingRejections.set(id, entry);
        }

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
