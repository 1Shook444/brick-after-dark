// Display-name rules shared by the UI and the leaderboard module.
// 2-16 characters after trimming; letters, numbers, spaces, _ and - only;
// plus a small, deliberately basic profanity filter.
const ALLOWED = /^[A-Za-z0-9 _-]{2,16}$/;
// Matched anywhere inside the name (after leetspeak + separator removal).
const BLOCKED_ANYWHERE = ['fuck', 'fuk', 'shit', 'bitch', 'cunt', 'asshole', 'pussy', 'nigg', 'nigga', 'faggot', 'whore', 'slut', 'bastard', 'hitler', 'nazi', 'porn', 'penis', 'vagina', 'retard', 'kike', 'chink', 'twat', 'wank', 'dildo', 'jizz', 'motherf'];
// Only blocked as a whole word, to avoid false positives like "grapes" or "Dickens".
const BLOCKED_WORDS = ['ass', 'dick', 'cock', 'fag', 'rape', 'cum', 'tit', 'tits', 'sex', 'kkk', 'spic', 'hoe'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '$': 's', '@': 'a' };

export function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

export function validateName(raw) {
  const name = cleanName(raw);
  if (name.length < 2) return { ok: false, name, error: 'Use at least 2 characters.' };
  if (name.length > 16) return { ok: false, name, error: 'Use 16 characters or fewer.' };
  if (!ALLOWED.test(name)) return { ok: false, name, error: 'Only letters, numbers, spaces, _ and - are allowed.' };
  const lower = name.toLowerCase().replace(/[0-9$@]/g, (ch) => LEET[ch] ?? ch);
  const squashed = lower.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
  const plain = lower.replace(/[^a-z]/g, '');
  if (BLOCKED_ANYWHERE.some((w) => { const sq = w.replace(/(.)\1+/g, '$1'); return plain.includes(w) || (sq.length >= 4 && squashed.includes(sq)); })) return { ok: false, name, error: 'Please pick a different name.' };
  const words = lower.split(/[ _-]+/).filter(Boolean);
  if (words.some((w) => BLOCKED_WORDS.includes(w.replace(/[^a-z]/g, '')))) return { ok: false, name, error: 'Please pick a different name.' };
  return { ok: true, name, error: '' };
}
