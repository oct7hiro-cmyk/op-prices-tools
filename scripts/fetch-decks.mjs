// 環境デッキのTier表・リーダーの勝率・相性・デッキリストを OPlayTCG のメタ統計(https://oplaytcg.com/en/meta-stats)から取る。Node 20+、依存なし。
//   data/meta.json            … Tier表(直近30日のランク戦)・リーダーごとの成績(先手/後手)・相性(対戦数の多い相手のみ)
//   data/decklists-auto.json  … リーダーごとのデッキリスト(よく使われている構築のうち、50戦以上で勝率が一番高いもの)
// Tierの決め方(このサイト独自):
//   対象 = 直近30日のランク戦で対戦数 MIN_GAMES 以上・使用率 MIN_SHARE 以上のリーダー
//   強さ = 勝率の95%信頼区間の下限(対戦数が少なく偶然勝っているだけのリーダーを上げすぎない)
//   SS: 52%以上 / S: 50%以上 / A: 47.5%以上 / B: それ未満
// 取得に失敗したときは前回のデータをそのまま使う
import { readFile, writeFile } from 'node:fs/promises';

const UA = { 'User-Agent': 'op-prices-tools/1.0 (+https://oct7hiro-cmyk.github.io/op-prices-tools/)' };
const WIN = 'd30', MODE = 'ranked';
const MIN_GAMES = 1000, MIN_SHARE = 0.01;        // Tier表に載せる条件
const MIN_MATCH = 200;                          // 相性に載せる最低対戦数
const MIN_DECK_GAMES = 50;                      // デッキリストに使う構築の最低対戦数
const TIERS = [['SS', 'Tier 1', 0.52], ['S', 'Tier 2', 0.50], ['A', 'Tier 3', 0.475], ['B', 'Tier 4', -1]];

const lower = (w, n) => { const z = 1.96, p = w / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n); };
const pct = (w, n) => (n ? Math.round((w / n) * 1000) / 10 : null);

async function getPayload() {
  const r = await fetch('https://oplaytcg.com/en/meta-stats', { headers: UA });
  if (!r.ok) throw new Error(`meta-stats HTTP ${r.status}`);
  const h = await r.text();
  // Next.js のページに埋め込まれたデータ(self.__next_f.push([1,"…"]))をつなげて、{"payload":{"v":…}} を取り出す
  const s = [...h.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
  const st = s.indexOf('{"payload":{"v":');
  if (st < 0) throw new Error('メタ統計のデータが見つからない(ページの形式が変わった可能性)');
  let d = 0, i = st, q = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === '"') q = false; continue; }
    if (c === '"') q = true; else if (c === '{') d++; else if (c === '}' && --d === 0) break;
  }
  return JSON.parse(s.slice(st, i + 1)).payload;
}

let P, D;
try {
  P = await getPayload();
  const r = await fetch('https://oplaytcg.com/api/meta/decks/jp', { headers: { ...UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`decks HTTP ${r.status}`);
  D = await r.json();
} catch (e) {
  console.error(`OPlayTCG の取得に失敗(${e.message})。前回のデータを使います`);
  process.exit(0);
}

const w = P.windows?.[WIN]?.[MODE];
if (!w?.leaders?.length) { console.error('リーダーのデータなし。前回のデータを使います'); process.exit(0); }
const total = w.n; // 対戦数(1対戦に2リーダー)
const leaders = {};
for (const l of w.leaders) {
  const gs = l.g - l.gf, ws = l.w - l.wf;
  leaders[l.l] = { games: l.g, wins: l.w, winRate: pct(l.w, l.g), lower: Math.round(lower(l.w, l.g) * 1000) / 10,
    first: { games: l.gf, winRate: pct(l.wf, l.gf) }, second: { games: gs, winRate: pct(ws, gs) },
    share: Math.round((l.g / (2 * total)) * 1000) / 10, players: l.u,
    matchups: (l.m ?? []).filter((m) => m.o !== l.l && m.g >= MIN_MATCH).map((m) => {
      const g2 = m.g - m.gf, w2 = m.w - m.wf;
      return { o: m.o, games: m.g, winRate: pct(m.w, m.g), first: m.gf >= 30 ? pct(m.wf, m.gf) : null, second: g2 >= 30 ? pct(w2, g2) : null };
    }) };
}
const eligible = Object.entries(leaders).filter(([, x]) => x.games >= MIN_GAMES && x.share >= MIN_SHARE * 100).sort((a, b) => b[1].lower - a[1].lower);
const tiers = TIERS.map(([tier, label, th], i) => ({ tier, label, leaders: eligible.filter(([, x]) => x.lower / 100 >= th && (i === 0 || x.lower / 100 < TIERS[i - 1][2])).map(([id]) => id) })).filter((t) => t.leaders.length);
const meta = { source: 'OPlayTCG メタ統計', sourceUrl: 'https://oplaytcg.com/en/meta-stats', statsAt: P.gen ?? null, to: P.to ?? null,
  window: '直近30日・ランク戦', totalGames: total, rule: `直近30日のランク戦で${MIN_GAMES}戦以上・使用率${MIN_SHARE * 100}%以上のリーダーを、勝率の95%信頼区間の下限で並べたもの(SS 52%以上 / S 50%以上 / A 47.5%以上 / B それ未満)`,
  minMatch: MIN_MATCH, tiers, leaders };
await writeFile('data/meta.json', JSON.stringify(meta));

// デッキリスト(Tier表のリーダーと、相性表に出る相手のぶん)
const out = { fetchedAt: new Date().toISOString(), statsAt: D.gen ?? null, source: 'OPlayTCG メタ統計', sourceUrl: 'https://oplaytcg.com/en/meta-stats',
  rule: `直近30日のランク戦で使用数上位の構築のうち、${MIN_DECK_GAMES}戦以上で勝率が一番高いもの`, decks: {} };
for (const [id] of eligible) {
  const e = D.decks?.[`${WIN}|${MODE}|${id}`] ?? D.decks?.[`${WIN}|all|${id}`];
  const list = (e?.d ?? []).filter((x) => Array.isArray(x.k) && x.k.length && x.g > 0);
  if (!list.length) continue;
  const best = list.filter((x) => x.g >= MIN_DECK_GAMES).sort((a, b) => b.w / b.g - a.w / a.g)[0] ?? [...list].sort((a, b) => b.g - a.g)[0];
  const cnt = {};
  for (const c of best.k) cnt[c] = (cnt[c] ?? 0) + 1;
  const cards = Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const names = {};
  for (const [c] of cards) if (D.cards?.[c]?.n) names[c] = D.cards[c].n;
  out.decks[id] = { leader: id, code: `${id}|` + cards.map(([c, n]) => `${n}x${c}`).join(','), games: best.g, winRate: pct(best.w, best.g), names };
}
await writeFile('data/decklists-auto.json', JSON.stringify(out, null, 1) + '\n');
console.log(tiers.map((t) => `${t.tier}: ${t.leaders.map((id) => `${id}(${leaders[id].winRate}%)`).join(' ')}`).join('\n'));
console.log(`デッキリスト ${Object.keys(out.decks).length}件 / リーダー ${Object.keys(leaders).length}人`);
