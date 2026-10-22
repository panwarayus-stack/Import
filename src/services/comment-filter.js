'use strict';

/**
 * Comment sanitation + eligibility filtering.
 *
 * YouTube comments are untrusted input twice over: they are rendered in AI prompts
 * (prompt injection) and they influence generated code. Everything here errs on the
 * side of rejecting.
 */

const crypto = require('node:crypto');

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const URL_PATTERN = /(https?:\/\/|www\.)\S+/gi;

const SPAM_PATTERNS = [
  /\b(subscribe|sub) (to )?my (channel|yt|youtube)\b/i,
  /\b(free|cheap) (followers|subscribers|views|likes)\b/i,
  /\b(telegram|whatsapp|crypto|forex|casino|betting|loan|escort|porn)\b/i,
  /\b(check (out )?my|visit my) (channel|page|site|link)\b/i,
  /\b(bit\.ly|tinyurl|t\.me|wa\.me)\b/i,
  /\b(giveaway|airdrop|dm me|inbox me|contact me on)\b/i,
];

const PROMPT_INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|above|earlier) (instructions|prompts|rules)/i,
  /\b(disregard|forget) (all )?(your|the) (instructions|rules|system prompt)/i,
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  /\b(reveal|print|show|repeat) (your|the) (system )?(prompt|instructions|api key|token)/i,
  /\bdeveloper mode\b/i,
  /\bdo anything now\b/i,
  /\bnew instructions?:/i,
  /<\|im_start\|>|<\|system\|>|\[\/?INST\]/i,
  /\b(os|shell|bash|terminal) command\b/i,
];

const LOW_VALUE_PATTERNS = [
  /^(first|second|third|nice|good|great|cool|awesome|wow|lol|lmao|ok|okay|yes|no|hi|hello|thanks|thank you)[\s!.]*$/i,
  /^[\p{Emoji}\p{P}\s]+$/u,
];

const BANNED_WORDS = (process.env.COMMENT_BANNED_WORDS || '')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

function sanitizeComment(text, { maxLength = 2000 } = {}) {
  let value = String(text || '')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (value.length > maxLength) value = value.slice(0, maxLength).trim();
  return value;
}

function contentHash(text) {
  return crypto
    .createHash('sha256')
    .update(
      String(text || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\p{N} ]/gu, '')
        .trim(),
    )
    .digest('hex');
}

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** True when `text` is a near-duplicate of one of `existingTexts`. */
function isNearDuplicate(text, existingTexts, { threshold = 0.82 } = {}) {
  const candidate = tokens(text);
  if (candidate.size < 4) return false;
  for (const other of existingTexts) {
    if (jaccard(candidate, tokens(other)) >= threshold) return true;
  }
  return false;
}

/**
 * Evaluate a raw comment.
 * @returns {{eligible: boolean, reason: string|null, text: string, hash: string,
 *            flags: string[], score: number, requiresReview: boolean}}
 */
function evaluateComment(rawText, options = {}) {
  const {
    minLength = 12,
    maxLength = 2000,
    minLikes = 0,
    likeCount = 0,
    existingTexts = [],
    allowSuspicious = false,
    maxLinks = 1,
  } = options;

  const flags = [];
  const text = sanitizeComment(rawText, { maxLength });
  const hash = contentHash(text);
  const result = (eligible, reason, extra = {}) => ({
    eligible,
    reason,
    text,
    hash,
    flags,
    score: 0,
    requiresReview: flags.length > 0,
    ...extra,
  });

  if (!text) return result(false, 'empty');
  if (text.length < minLength) return result(false, 'too_short', { score: text.length });
  if (likeCount < minLikes) return result(false, 'below_like_threshold');

  if (LOW_VALUE_PATTERNS.some((p) => p.test(text))) return result(false, 'low_value');
  if (/(.)\1{9,}/u.test(text)) return result(false, 'spam_repetition');

  const letters = text.replace(/[^\p{L}]/gu, '');
  if (!letters) return result(false, 'no_words');
  const upper = text.replace(/[^A-Z]/g, '');
  const alpha = text.replace(/[^A-Za-z]/g, '');
  if (alpha.length > 12 && upper.length / alpha.length > 0.85) return result(false, 'all_caps_shouting');

  const links = text.match(URL_PATTERN) || [];
  if (links.length > maxLinks) return result(false, 'spam_links');
  if (links.length === 1 && text.replace(URL_PATTERN, '').trim().length < 25) return result(false, 'spam_links');

  if (SPAM_PATTERNS.some((p) => p.test(text))) return result(false, 'spam_content');
  if (BANNED_WORDS.some((word) => word && text.toLowerCase().includes(word))) return result(false, 'banned_word');

  const injection = PROMPT_INJECTION_PATTERNS.some((p) => p.test(text));
  if (injection) {
    flags.push('prompt_injection_suspected');
    if (!allowSuspicious) return result(false, 'prompt_injection_suspected');
  }

  if (isNearDuplicate(text, existingTexts)) return result(false, 'duplicate');

  // A useful idea usually has a few words and at least one verb-ish/longer word.
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return result(false, 'too_few_words');
  const longWords = words.filter((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length >= 4);
  if (longWords.length < 2) return result(false, 'not_enough_substance');

  if (/[<>]/.test(text)) flags.push('contains_angle_brackets');

  const score = Math.min(100, Math.round(words.length * 1.5 + longWords.length * 2 + Math.min(likeCount, 50)));
  return result(true, null, { score });
}

module.exports = {
  sanitizeComment,
  contentHash,
  evaluateComment,
  isNearDuplicate,
  jaccard,
  tokens,
  PROMPT_INJECTION_PATTERNS,
  SPAM_PATTERNS,
};
