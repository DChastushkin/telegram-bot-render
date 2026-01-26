import state from "./state.js";

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
 * 📝 САБМИТ ТЕМЫ НА МОДЕРАЦИЮ
 * ===================================================== */

export const intentLabel = (intent) =>
  intent === "advice" ? "нужен совет" : "хочу высказаться";

const ADVICE_HEADER  = "Новое обращение от подписчика — требуется обратная связь";
const EXPRESS_HEADER = "Новая тема от подписчика";

// helpers
function shiftEntities(entities = [], shift = 0) {
  if (!Array.isArray(entities) || shift === 0) return entities;
  return entities.map(e => ({ ...e, offset: e.offset + shift }));
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
 * ❗ ЭТУ ФУНКЦИЮ ИСПОЛЬЗУЮТ moderation.js и callbacks.js
 */
export async function submitDraftToModeration(
  { telegram, ADMIN_CHAT_ID, CHANNEL_ID, BOT_USERNAME },
  { user, draft, intent }
) {
  const header =
    intent === "advice" ? ADVICE_HEADER : EXPRESS_HEADER;

  const info =
    `👤 От: @${user.username || "—"}\n` +
    `ID: ${user.id}\n` +
    `Имя: ${[user.first_name, user.last_name].filter(Boolean).join(" ") || "—"}\n` +
    `Тип обращения: ${intentLabel(intent)}`;

  const infoMsg = await telegram.sendMessage(ADMIN_CHAT_ID, info);

  const items = Array.isArray(draft.items) ? draft.items : [];

  /* =====================================================
   * 🔴 КЛЮЧЕВОЙ ФИКС:
   * КОПИРУЕМ ВСЕ ИСХОДНЫЕ СООБЩЕНИЯ (включая фото без текста)
   * ===================================================== */
  if (infoMsg?.message_id && items.length > 0) {
    for (const it of items) {
      if (!it?.srcChatId || !it?.srcMsgId) continue;

      try {
        await telegram.copyMessage(
          ADMIN_CHAT_ID,
          it.srcChatId,
          it.srcMsgId,
          { reply_to_message_id: infoMsg.message_id }
        );
      } catch (e) {
        console.error("copyMessage to admin failed:", e);
      }
    }
  }

  // Текст собираем ОТДЕЛЬНО, он больше не влияет на медиа
  const textSegments = items
    .map(it => ({ text: it.text || "", entities: it.entities || [] }))
    .filter(s => s.text && s.text.trim().length > 0);

  const { text: body, entities } = joinTextWithEntities(textSegments);
  const combined = body ? `${header}\n\n${body}` : header;
  const finalEntities = shiftEntities(
    entities,
    body ? header.length + 2 : 0
  );

  // Превью в админке + кнопки
  const preview = await telegram.sendMessage(
    ADMIN_CHAT_ID,
    combined,
    {
      entities: finalEntities,
      reply_to_message_id: infoMsg?.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Одобрить", callback_data: JSON.stringify({ t: "publish" }) },
            { text: "❌ Отклонить", callback_data: JSON.stringify({ t: "reject" }) }
          ]
        ]
      }
    }
  );

  if (!preview) return;

  pendingSubmissions.set(preview.message_id, {
    authorId: user.id,
    intent,
    items
  });
}

/* =====================================================
 * 📢 ПУБЛИКАЦИЯ В КАНАЛ
 * ===================================================== */

export async function publishToChannel(
  { telegram, CHANNEL_ID, BOT_USERNAME },
  { text }
) {
  const sent = await telegram.sendMessage(
    CHANNEL_ID,
    text,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );

  const channelMsgId = sent.message_id;
  const anonLink = `https://t.me/${BOT_USERNAME}?start=anon_${channelMsgId}`;

  const finalText = `${text}\n\n<a href="${anonLink}">Ответить анонимно</a>`;

  await telegram.editMessageText(
    CHANNEL_ID,
    channelMsgId,
    undefined,
    finalText,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );

  return channelMsgId;
}
