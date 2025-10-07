// bot/submit.js
import { pendingSubmissions } from "./state.js";

export const intentLabel = (intent) =>
  intent === "advice" ? "нужен совет" : "хочу высказаться";

const ADVICE_HEADER  = "Новое обращение от подписчика - требуется обратная связь";
const EXPRESS_HEADER = "Новая тема от подписчика";

// shift entities
function shiftEntities(entities = [], shift = 0) {
  if (!Array.isArray(entities) || shift === 0) return entities;
  return entities.map(e => ({ ...e, offset: e.offset + shift }));
}

// join text segments + entities
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

/**
 * Превью для модерации = точная копия будущей публикации:
 * - если есть медиа с подписью → ОДИН пост (медиа + "шапка\n\nтексты")
 * - если текст + стикер/кружок → ДВА поста (1: "шапка\n\nтексты", 2: стикер/кружок)
 * - если только текст → ОДИН пост
 * - если только стикер/кружок → ДВА поста (1: "шапка", 2: контент)
 */
export async function submitDraftToModeration({ telegram, ADMIN_CHAT_ID }, { user, draft, intent }) {
  const header = intent === "advice" ? ADVICE_HEADER : EXPRESS_HEADER;
  const info =
    `👤 От: @${user.username || "—"}\n` +
    `ID: ${user.id}\n` +
    `Имя: ${[user.first_name, user.last_name].filter(Boolean).join(" ") || "—"}\n` +
    `Тип обращения: ${intentLabel(intent)}`;

  await telegram.sendMessage(ADMIN_CHAT_ID, info);

  const items = draft.items || [];
  const textSegments = items
    .map(it => ({ text: it.text || "", entities: it.entities || [] }))
    .filter(s => s.text && s.text.trim().length > 0);

  let primary = null; // последняя медиа с подписью
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].supportsCaption) { primary = items[i]; break; }
  }
  const nonCaptionItems = items.filter(it => !it.supportsCaption);
  const hasText = textSegments.length > 0;

  const adminPreviewMsgIds = [];

  if (primary) {
    const { text: body, entities } = joinTextWithEntities(textSegments);
    const caption = body ? `${header}\n\n${body}` : header;
    const caption_entities = shiftEntities(entities, body ? header.length + 2 : 0);

    const copied = await telegram.copyMessage(
      ADMIN_CHAT_ID,
      primary.srcChatId,
      primary.srcMsgId,
      { caption, caption_entities }
    );
    adminPreviewMsgIds.push(copied.message_id);

  } else if (hasText && nonCaptionItems.length > 0) {
    const { text: body, entities } = joinTextWithEntities(textSegments);
    const combined = `${header}\n\n${body}`;
    const finalEntities = shiftEntities(entities, header.length + 2);
    const msg1 = await telegram.sendMessage(ADMIN_CHAT_ID, combined, { entities: finalEntities });
    adminPreviewMsgIds.push(msg1.message_id);

    const msg2 = await telegram.copyMessage(ADMIN_CHAT_ID, nonCaptionItems[0].srcChatId, nonCaptionItems[0].srcMsgId);
    adminPreviewMsgIds.push(msg2.message_id);

  } else if (hasText) {
    const { text: body, entities } = joinTextWithEntities(textSegments);
    const combined = `${header}\n\n${body}`;
    const finalEntities = shiftEntities(entities, header.length + 2);
    const sent = await telegram.sendMessage(ADMIN_CHAT_ID, combined, { entities: finalEntities });
    adminPreviewMsgIds.push(sent.message_id);

  } else {
    const s1 = await telegram.sendMessage(ADMIN_CHAT_ID, header);
    adminPreviewMsgIds.push(s1.message_id);
    const first = items[0];
    const s2 = await telegram.copyMessage(ADMIN_CHAT_ID, first.srcChatId, first.srcMsgId);
    adminPreviewMsgIds.push(s2.message_id);
  }

  const cb = (t) => JSON.stringify({ t, uid: user.id });
  const control = await telegram.sendMessage(
    ADMIN_CHAT_ID,
    "📝 Предпросмотр публикации (см. сообщение выше).",
    { reply_markup: { inline_keyboard: [[
      { text: "📣 Опубликовать", callback_data: cb("publish") },
      { text: "🚫 Отклонить",   callback_data: cb("reject")  }
    ]] } }
  );

  pendingSubmissions.set(control.message_id, {
    authorId: user.id,
    intent,
    items,
    adminPreviewMsgIds
  });
}
