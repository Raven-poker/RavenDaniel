// 7枚から最強の5枚を選んで役を評価する
// カードは {r: 2-14, s: 0-3} で表現

const HAND_NAMES = [
  'ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート',
  'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ',
];

const BASE = 15;
const CAT_DIV = BASE ** 5;

function evaluate5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.s === cards[0].s);

  const cnt = new Map();
  for (const r of ranks) cnt.set(r, (cnt.get(r) || 0) + 1);
  const groups = [...cnt.entries()]
    .map(([r, c]) => ({ r, c }))
    .sort((a, b) => b.c - a.c || b.r - a.r);

  let straightHigh = 0;
  if (groups.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5; // A-2-3-4-5
  }

  let cat;
  let tie;
  if (isFlush && straightHigh) { cat = 8; tie = [straightHigh]; }
  else if (groups[0].c === 4) { cat = 7; tie = [groups[0].r, groups[1].r]; }
  else if (groups[0].c === 3 && groups[1].c === 2) { cat = 6; tie = [groups[0].r, groups[1].r]; }
  else if (isFlush) { cat = 5; tie = ranks; }
  else if (straightHigh) { cat = 4; tie = [straightHigh]; }
  else if (groups[0].c === 3) { cat = 3; tie = [groups[0].r, groups[1].r, groups[2].r]; }
  else if (groups[0].c === 2 && groups[1].c === 2) { cat = 2; tie = [groups[0].r, groups[1].r, groups[2].r]; }
  else if (groups[0].c === 2) { cat = 1; tie = [groups[0].r, groups[1].r, groups[2].r, groups[3].r]; }
  else { cat = 0; tie = ranks; }

  let score = cat;
  const t = [...tie];
  while (t.length < 5) t.push(0);
  for (const v of t) score = score * BASE + v;
  return score;
}

function evaluate7(cards) {
  let best = -1;
  const n = cards.length;
  // 7枚から2枚除外する全組み合わせ
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const five = [];
      for (let i = 0; i < n; i++) if (i !== a && i !== b) five.push(cards[i]);
      const s = evaluate5(five);
      if (s > best) best = s;
    }
  }
  const cat = Math.floor(best / CAT_DIV);
  const top = Math.floor(best / BASE ** 4) % BASE;
  const name = cat === 8 && top === 14 ? 'ロイヤルフラッシュ' : HAND_NAMES[cat];
  return { score: best, name };
}

module.exports = { evaluate7, evaluate5, HAND_NAMES };
