// bot/submit.js
import state from "./state.js";
import { safeSendMessage, safeCopyMessage } from "./utils.js";

const {
  pendingSubmissions,
  pendingAnonReplies,
  channelToDiscussion
} = state;

/* =====================================================
 * 🕶 АНОНИМНЫЙ КОММЕНТАРИЙ
 * ===================================================== */
export async function tryHandleAnonReply(ctx) {
  if (!ctx?.from || !ctx.message?.text) return false;

  const uid = ctx.from.id;
  const pending = pendingAnonReplies.get(uid);
  if (!pending) return false;

  const { channelMsgId } = pending;
  const link = channelToDiscussion.get(channelMsgId);

  if (!link) {
    await ctx.reply(
      "⚠️ Обсуждение к этой теме пока не найдено.\nПопробуйте чуть позже."
    );
    return true;
  }

  const { discussionChatId, discussionMsgId } = link;

  try {
    await ctx.telegram.sendMessage(
      discussionChatId,
      ctx.message.text,
      { reply_to_message_id: discussionMsgId }
    );

    await ctx.reply("✅ Анонимный комментарий опубликован.");
  } catch (e) {
    console.error("Anon reply error:", e);
    await ctx.reply("❌ Не удалось опубликовать комментарий.");
  } finally {
    pendingAnonReplies.delete(uid);
  }

  return true;
}

/* =====================================================
 * 📝 САБМИТ ТЕМЫ НА МОДЕРАЦИЮ (СТАРАЯ ЛОГИКА)
 * ===================================================== */

export const intentLabel = (intent) =>
  intent === "advice" ? "нужен совет" : "хочу высказаться";

const ADVICE_HEADER  = "Новое обращение от подписчика - требуется обратная связь";
const EXPRESS_HEADER = "Новая тема от подписчика";

// смещение entities
function shiftEntities(entities = [], shift = 0) {
  if (!Array.isArray(entities) || shift === 0) return entities;
  return entities.map(e => ({ ...e, offset: e.offset + shift }));
}

// склейка текста
function joinTextWithEntities(segments, sep = "\n\n") {
  const parts = [];
  const outEntities = [];
  let base = 0;

  for (let i = 0; i < segments.length; i++) {
    const t = segments[i].text || "";
    const ents = Array.isArray(segments[i].entities) ? segments[i].entities : [];

    if (t.length > 0) {
      parts.push(t);
      for (const e of ents) {
        outEntities.push({ ...e, offset: e.offset + base });
      }
      base += t.length;
      if (i !== segments.length - 1) base += sep.length;
    }
  }

  return { text: parts.join(sep), entities: outEntities };
}

/**
 * ❗ ЭТУ ФУНКЦИЮ ЖДУТ moderation.js и callbacks.js
 * ❗ ЕЁ НЕЛЬЗЯ УДАЛЯТЬ
 */
export async function submitDraftToModeration(
  { telegram, ADMIN_CHAT_ID },
  { user, draft, intent }
) {
  const header =
    intent === "advice" ? ADVICE_HEADER : EXPRESS_HEADER;

  const info =
    `👤 От: @${user.username || "—"}\n` +
    `ID: ${user.id}\n` +
    `Имя: ${[user.first_name, user.last_name].filter(Boolean).join(" ") || "—"}\n` +
    `Тип обращения: ${intentLabel(intent)}`;

  await safeSendMessage(telegram, ADMIN_CHAT_ID, info);

  const items = draft.items || [];
  const textSegments = items
    .map(it => ({ text: it.text || "", entities: it.entities || [] }))
    .filter(s => s.text && s.text.trim().length > 0);

  const { text: body, entities } = joinTextWithEntities(textSegments);
  const combined = body ? `${header}\n\n${body}` : header;
  const finalEntities = shiftEntities(
    entities,
    body ? header.length + 2 : 0
  );

  const preview = await safeSendMessage(
    telegram,
    ADMIN_CHAT_ID,
    combined,
    { entities: finalEntities }
  );

  if (preview) {
    pendingSubmissions.set(preview.message_id, {
      authorId: user.id,
      intent,
      items
    });
  }
}
