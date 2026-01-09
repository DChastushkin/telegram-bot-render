// bot/handlers/callbacks.js
import { isOldQueryError, safeSendMessage, safeCopyMessage } from "../utils.js";
import { memberMenu, choiceKeyboard } from "../ui.js";
import { submitDraftToModeration } from "../submit.js";
import {
  pendingDrafts,
  awaitingIntent,
  pendingSubmissions,
  pendingRejections,
  pendingRejectionsByAdmin
} from "../state.js";

const esc = (s = "") =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const ADVICE_HEADER = "Новое обращение от подписчика - требуется обратная связь";
const EXPRESS_HEADER = "Новая тема от подписчика";

// helpers
function shiftEntities(entities = [], shift = 0) {
  if (!Array.isArray(entities) || shift === 0) return entities;
  return entities.map((e) => ({ ...e, offset: e.offset + shift }));
}

function joinTextWithEntities(segments, sep = "\n\n") {
  const parts = [];
  const outEntities = [];
  let base = 0;
  for (let i = 0; i < segments.length; i++) {
    const t = segments[i].text || "";
    const ents = Array.isArray(segments[i].entities) ? segments[i].entities : [];
    if (t.length > 0) {
      parts.push(t);
      for (const e of ents) outEntities.push({ ...e, offset: e.offset + base });
      base += t.length;
      if (i !== segments.length - 1) base += sep.length;
    }
  }
  return { text: parts.join(sep), entities: outEntities };
}

async function resolveChannelLink(ctx, CHANNEL_ID, CHANNEL_LINK) {
  let title = "канал";
  try {
    const chat = await ctx.telegram.getChat(CHANNEL_ID);
    if (chat?.title) title = chat.title;
    if (CHANNEL_LINK) return { link: CHANNEL_LINK, title };
    if (chat?.username) return { link: `https://t.me/${chat.username}`, title };
  } catch {}
  return { link: null, title };
}

export function registerCallbackHandlers(bot, env) {
  const { CHANNEL_ID, ADMIN_CHAT_ID, CHANNEL_LINK } = env;

  bot.on("callback_query", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      let p = {};
      try {
        p = JSON.parse(ctx.update.callback_query.data || "{}");
      } catch {}

      // =========================
      // ---------- USER ----------
      // =========================

      if (p.t === "compose_done") {
        const uid = ctx.from.id;
        if (!pendingDrafts.has(uid)) {
          await ctx.answerCbQuery("Черновик не найден");
          return;
        }
        awaitingIntent.add(uid);
        await ctx.reply(
          "Выберите формат обращения (или отправьте цифру: 1 — нужен совет, 2 — хочу высказаться):",
          choiceKeyboard()
        );
        return;
      }

      if (p.t === "compose_cancel") {
        const uid = ctx.from.id;
        pendingDrafts.delete(uid);
        awaitingIntent.delete(uid);
        await ctx.reply("Отменено.", memberMenu());
        return;
      }

      if (p.t === "choose") {
        const uid = ctx.from.id;
        const session = pendingDrafts.get(uid);
        if (!session) {
          await ctx.answerCbQuery("Нет черновика");
          return;
        }
        const intent = p.v === "advice" ? "advice" : "express";
        await submitDraftToModeration(
          { telegram: ctx.telegram, ADMIN_CHAT_ID },
          { user: ctx.from, draft: session, intent }
        );
        pendingDrafts.delete(uid);
        awaitingIntent.delete(uid);
        await ctx.reply("Тема отправлена на модерацию.", memberMenu());
        return;
      }

      // =========================
      // ---------- ADMIN ----------
      // =========================

      if (String(ctx.chat?.id) !== String(ADMIN_CHAT_ID)) {
        await ctx.answerCbQuery("Нет доступа");
        return;
      }

      if (p.t === "publish") {
        const control = ctx.update.callback_query.message;
        const bind = pendingSubmissions.get(control.message_id);
        if (!bind) return;

        const { authorId, intent, items } = bind;
        const header = intent === "advice" ? ADVICE_HEADER : EXPRESS_HEADER;

        const textSegments = items
          .map((it) => ({ text: it.text || "", entities: it.entities || [] }))
          .filter((s) => s.text && s.text.trim().length > 0);

        const { text: body, entities } = joinTextWithEntities(textSegments);
        const combined = body ? `${header}\n\n${body}` : header;
        const finalEntities = shiftEntities(entities, header.length + 2);

        const posted = await safeSendMessage(ctx.telegram, CHANNEL_ID, combined, {
          entities: finalEntities
        });

        const channelMsgId = posted?.message_id;
        if (channelMsgId) {
          const botUsername = ctx.botInfo.username;
          const anonLink = `https://t.me/${botUsername}?start=anon:${channelMsgId}`;

          const updatedText =
            combined +
            `\n\n<a href="${anonLink}">💬 Ответить анонимно</a>`;

          await ctx.telegram.editMessageText(
            CHANNEL_ID,
            channelMsgId,
            undefined,
            updatedText,
            {
              parse_mode: "HTML",
              disable_web_page_preview: true
            }
          );
        }

        await ctx.editMessageReplyMarkup();

        try {
          const { link, title } = await resolveChannelLink(ctx, CHANNEL_ID, CHANNEL_LINK);
          const text = link
            ? `✅ Ваша тема опубликована ❤️\n<a href="${link}">Перейти в канал</a>`
            : `✅ Ваша тема опубликована ❤️`;

          await ctx.telegram.sendMessage(authorId, text, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: memberMenu().reply_markup
          });
        } catch {}

        pendingSubmissions.delete(control.message_id);
        return;
      }

    } catch (e) {
      if (!isOldQueryError(e)) {
        console.error("callback_query error:", e);
      }
    }
  });
}
