// Chia kịch bản thành các đoạn <= maxChars để nạp vào tool tạo giọng (mỗi đoạn
// = 1 file mp3). Chỉ cắt ở ranh giới CÂU, cân bằng độ dài các đoạn, không để đoạn
// lẻ quá ngắn. Port từ stickfigure-video/scripts/prep_voiceover.py (bỏ phần tách
// theo header "Number N" vì kịch bản cầu nguyện không có mục đánh số).

const DEC = '\u0001';
const INI = '\u0002';

const escapeRe = (character) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const splitSentences = (text) => {
  let t = String(text).replace(/(?<=\d)\.(?=\d)/g, DEC); // bảo vệ 10.6
  t = t.replace(/(?<=\s)([A-Z])\.(?=\s)/g, `$1${INI}`); // bảo vệ  G.
  const out = [];
  for (let piece of t.split(/(?<=[.!?])\s+/)) {
    piece = piece
      .replace(new RegExp(escapeRe(DEC), 'g'), '.')
      .replace(new RegExp(escapeRe(INI), 'g'), '.')
      .replace(/\s+/g, ' ')
      .trim();
    if (piece) out.push(piece);
  }
  return out;
};

const slen = (list) =>
  list.reduce((sum, item) => sum + item.length, 0) + Math.max(0, list.length - 1);

const splitEven = (sentences, maxChars) => {
  const half = slen(sentences) / 2;
  const a = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const rest = sentences.slice(index);
    if (a.length && slen(a) >= half && slen(rest) <= maxChars) return [a, rest];
    a.push(sentences[index]);
  }
  return sentences.length > 1 ? [sentences.slice(0, 1), sentences.slice(1)] : [sentences];
};

const pack = (sentences, maxChars) => {
  if (!sentences.length) return [];
  const total = slen(sentences);
  if (total <= maxChars) return [sentences.join(' ')];
  const n = Math.max(1, Math.ceil(total / maxChars));
  const target = total / n;
  const groups = [];
  let cur = [];
  for (const sentence of sentences) {
    if (
      cur.length &&
      (slen(cur) + 1 + sentence.length > maxChars ||
        (slen(cur) >= target && groups.length < n - 1))
    ) {
      groups.push(cur);
      cur = [];
    }
    cur.push(sentence);
  }
  if (cur.length) groups.push(cur);

  // Gộp đoạn đuôi quá ngắn vào đoạn trước; nếu vượt max thì chia đôi cân bằng.
  if (
    groups.length >= 2 &&
    slen(groups[groups.length - 1]) < Math.max(150, target * 0.55)
  ) {
    const merged = groups[groups.length - 2].concat(groups[groups.length - 1]);
    const replacement =
      slen(merged) <= maxChars ? [merged] : splitEven(merged, maxChars);
    groups.splice(groups.length - 2, 2, ...replacement);
  }

  // Trường hợp cuối: một câu dài hơn max — cắt tại khoảng trắng.
  const out = [];
  for (const group of groups) {
    let paragraph = group.join(' ');
    while (paragraph.length > maxChars) {
      let cut = paragraph.lastIndexOf(' ', maxChars);
      cut = cut > 0 ? cut : maxChars;
      out.push(paragraph.slice(0, cut).trim());
      paragraph = paragraph.slice(cut).trim();
    }
    if (paragraph) out.push(paragraph);
  }
  return out;
};

export const prepVoiceover = (text, maxChars = 950) =>
  pack(splitSentences(text), Math.max(200, Number(maxChars) || 950));
