// ============================================================
// "Does this customer message need an answer?" — pure, no I/O.
//
// A thread whose last message is "ok", "Thank you sir 🙏" or a lone
// 👍 is not waiting on the shop. Counting it as "waiting for reply"
// made the ERP's red badge useless: staff learned to ignore a number
// that was mostly courtesy messages.
//
// Deliberately narrow, and the same rule the ERP applies to its own
// popups: ONE word outside these lists ("ok when is it ready") and
// the message counts as needing a reply. A missed "ok" costs a
// glance; a missed question costs a customer.
// ============================================================

/** A word that on its own says "understood / thanks". */
const ACK_WORD =
  /^(o+k+a*y*|o+k+e+y*|k+|thanks*|thanx+|thnx+|thx+|thank(you|u|q)?|tq|ty|tysm|noted|received|recieved|got|fine|good|nice|great|welcome|perfect|alright|cool|theek|thik|acc?h+a+|ach+a+|dhanyavaa?d|dhanyawaa?d|shukriya)$/;

/** Politeness that may ride along with one ("ok sir", "thank you ji") but is not an acknowledgement alone. */
const ACK_FILLER =
  /^(ji+|jee|sir|mam|maam|madam|bhaiya|bhai|bro|dear|so|very|much|you|u|it|hai|h|ha+n*|hmm*|and|for|the|info|update)$/;

/** Longer than this is a sentence, not an acknowledgement. */
const MAX_WORDS = 6;

/**
 * True when a customer's message needs no reply. Only plain text can
 * qualify: a photo, voice note or document may be a prescription or
 * a question, so it always needs a human.
 */
export function isAcknowledgement(
  contentType: string | null | undefined,
  text: string | null | undefined,
): boolean {
  if ((contentType ?? 'text') !== 'text') return false;
  const raw = (text ?? '').trim();
  if (!raw) return false;

  const words = raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Only emoji (👍 🙏 👌), no letters at all.
  if (words.length === 0) return /\p{Extended_Pictographic}/u.test(raw);
  if (words.length > MAX_WORDS) return false;

  return (
    words.some((w) => ACK_WORD.test(w)) &&
    words.every((w) => ACK_WORD.test(w) || ACK_FILLER.test(w))
  );
}
