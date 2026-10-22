// 環境デッキのデッキリストを OPlayTCG のメタ統計(https://oplaytcg.com/en/meta-stats)から取る。Node 20+、依存なし。
// decklists.json の各デッキのリーダーについて、直近30日のランク戦でよく使われている構築(上位3つ)のうち、
// 対戦数が MIN_GAMES 以上で勝率が一番高いものを選ぶ(該当がなければ対戦数が一番多いもの)。
// 結果は data/decklists-auto.json。取得に失敗したときは前回の結果をそのまま使う
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const URL_API = 'https://oplaytcg.com/api/meta/decks/jp';
const PERIOD = 'd30', MODE = 'ranked', MIN_GAMES = 50;
const OUT = 'data/decklists-auto.json';

const src = JSON.parse(await readFile('decklists.json', 'utf8'));
let j;
try {
  const r = await fetch(URL_API, { headers: { 'User-Agent': 'op-prices-tools/1.0 (+https://oct7hiro-cmyk.github.io/op-prices-tools/)', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  j = await r.json();
} catch (e) {
  console.error(`OPlayTCG の取得に失敗(${e.message})。前回のデッキリストを使います`);
  process.exit(0);
}
const prev = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : { decks: {} };
const out = { fetchedAt: new Date().toISOString(), statsAt: j.gen ?? null, source: 'OPlayTCG メタ統計', sourceUrl: 'https://oplaytcg.com/en/meta-stats',
  rule: `直近30日のランク戦で使用数上位の構築のうち、${MIN_GAMES}戦以上で勝率が一番高いもの`, decks: {} };
for (const t of src.tiers) for (const d of t.decks) {
  if (!d.leader) continue;
  const e = j.decks?.[`${PERIOD}|${MODE}|${d.leader}`] ?? j.decks?.[`${PERIOD}|all|${d.leader}`];
  const list = (e?.d ?? []).filter((x) => Array.isArray(x.k) && x.k.length && x.g > 0);
  if (!list.length) { if (prev.decks[d.slug]) out.decks[d.slug] = prev.decks[d.slug]; console.log(`[${d.name}] 構築データなし`); continue; }
  const ok = list.filter((x) => x.g >= MIN_GAMES).sort((a, b) => b.w / b.g - a.w / a.g);
  const best = ok[0] ?? [...list].sort((a, b) => b.g - a.g)[0];
  const cnt = {};
  for (const id of best.k) cnt[id] = (cnt[id] ?? 0) + 1;
  const cards = Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const names = {};
  for (const [id] of cards) if (j.cards?.[id]?.n) names[id] = j.cards[id].n;
  out.decks[d.slug] = { leader: d.leader, code: `${d.leader}|` + cards.map(([id, n]) => `${n}x${id}`).join(','),
    games: best.g, wins: best.w, winRate: Math.round((best.w / best.g) * 1000) / 10, candidates: list.length, names };
  console.log(`[${d.name}] 勝率${out.decks[d.slug].winRate}%(${best.g}戦)/ 候補${list.length}構築`);
}
await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`デッキリスト ${Object.keys(out.decks).length}件`);
