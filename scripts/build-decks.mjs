// 環境デッキ(decklists.json)の価格をまとめる。Node 20+、依存なし。
//   node scripts/build-decks.mjs --watch … デッキに入っているカードのうち、弾の価格監視(cards.json)に無いものの検索条件を
//                                          data/decks-watch.json に書く(fetch-prices がこれも取得して data/decks-prices.json に保存)
//   node scripts/build-decks.mjs         … data/decks.json(Tier表・デッキごとのカード・ノーマル版/フルパラ版の合計価格)を作る
// フルパラ版: 各カードを、元の弾のパラレル(_p の番号が一番小さいもの。SP・コミパラ・超レアなどは除く)に置き換えたもの。
//            パラレルが無いカードはノーマルのまま。リーダーもリーダーパラレルにする
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const WATCH = process.argv.includes('--watch');
const NG_VARIANT = ['パラ', 'SP', 'スペシャル', 'スーパー', 'コミ', '漫画', 'サイン', '★'];
const NG_SPECIAL = ['ANNIVERSARY', '周年', 'CHINA', '中国', '英語', '海外', '簡体', '繁体'];
const SPECIAL = new Set(['TOP', 'SP', 'CP', 'LSP', 'TR']); // フルパラに使わない区分
const TYPE = { LEADER: 'リーダー', CHARACTER: 'キャラ', EVENT: 'イベント', STAGE: 'ステージ' };
const read = async (f, d = null) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : d);

const src = await read('decklists.json');
const raw = await read('data/raw/cardlists.json');
const index = await read('sets/index.json');
// 公式カードリスト: カード番号 → [番号, レアリティ, 名前, 種類, 色, シリーズ]。同じ番号が複数の弾にあれば元の弾を優先
const SERIES = {}; // 弾コード → シリーズ番号
const cfgs = {};
for (const s of index.sets) { const c = await read(`sets/${s.code}.json`); cfgs[s.code] = c; SERIES[s.code] = c.series; }
const home = (id) => { const m = id.match(/^([A-Z]+)(\d+)-/); return m ? SERIES[m[1] + m[2]] : null; };
const card = {};
for (const [sid, s] of Object.entries(raw.sets)) for (const c of s.cards) {
  if (!card[c[0]] || home(c[0]) === sid) card[c[0]] = [...c, sid];
}
// 弾の設定にある区分(パラレルの種類の判定用)
const catOf = {};
for (const c of Object.values(cfgs)) for (const x of c.cards) if (!catOf[x[0]] || home(x[0]) === c.series) catOf[x[0]] = x[1];

function parseCode(code) {
  const [leader, rest = ''] = code.split('|');
  return { leader: leader.trim(), cards: rest.split(',').filter(Boolean).map((t) => { const m = t.trim().match(/^(\d+)x(.+)$/); return { id: m[2].trim(), n: +m[1] }; }) };
}
// フルパラ版のカード番号
function paraOf(id) {
  const vs = Object.keys(card).filter((k) => k.startsWith(id + '_p') && !SPECIAL.has(catOf[k]));
  if (!vs.length) return id;
  const num = (k) => +k.match(/_p(\d+)$/)[1];
  const h = home(id);
  vs.sort((a, b) => (card[a][5] === h ? 0 : 1) - (card[b][5] === h ? 0 : 1) || (catOf[a] === 'FOIL') - (catOf[b] === 'FOIL') || num(a) - num(b));
  return vs[0];
}

// デッキごとに必要なカード
const decks = src.tiers.flatMap((t) => t.decks.map((d) => ({ ...d, tier: t.tier })));
const need = new Set();
for (const d of decks) {
  if (d.leader) { need.add(d.leader); need.add(paraOf(d.leader)); }
  if (!d.code) continue;
  const p = parseCode(d.code);
  for (const c of [{ id: p.leader }, ...p.cards]) { need.add(c.id); need.add(paraOf(c.id)); }
}

if (WATCH) {
  const watched = new Set((await read('cards.json', { cards: [] })).cards.map((c) => c.id));
  const out = [];
  for (const id of need) {
    if (watched.has(id)) continue;
    const base = id.replace(/_[pr]\d+$/, ''), c = card[id] ?? card[base];
    const w = { set: 'DECK', id, name: `${c?.[2] ?? base}(${id === base ? (c?.[1] ?? '') : 'パラレル'})`, code: base };
    if (id === base) Object.assign(w, { keyword: `ワンピースカード ${base}`, mustNot: [...NG_VARIANT, ...NG_SPECIAL], trimHigh: 4 });
    else Object.assign(w, { keyword: `ワンピースカード ${base} パラレル`, must: ['パラ'], mustNot: ['スーパー', 'コミ', '漫画', 'SP', 'スペシャル', ...NG_SPECIAL] });
    out.push(w);
  }
  await writeFile('data/decks-watch.json', JSON.stringify({ cards: out }, null, 1) + '\n');
  console.log(`デッキ用の価格監視 ${out.length}件(弾の監視と重複しないもの) / 必要なカード ${need.size}種`);
  process.exit(0);
}

// 価格: 弾のデータとデッキ用のデータから、カード番号ごとに新しいものを使う
const price = {};
const add = (c) => { if (c?.id && (!price[c.id] || String(c.updatedAt) >= String(price[c.id].updatedAt))) price[c.id] = c; };
for (const s of index.sets) (await read(`data/sets/${s.code}.json`, { cards: [] })).cards.forEach(add);
(await read('data/decks-prices.json', { cards: [] })).cards.forEach(add);
let updated = '';
const item = (id, n) => {
  const base = id.replace(/_[pr]\d+$/, ''), c = card[id] ?? card[base] ?? [], r = price[id] ?? {};
  if (r.updatedAt > updated) updated = r.updatedAt;
  return { id, n, name: c[2] ?? base, rar: c[1] ?? '', type: TYPE[c[3]] ?? '', color: c[4] ?? '', para: id !== base,
    p: r.refPrice ?? null, est: r.est || undefined, so: r.soldout || undefined, offers: (r.offers ?? []).slice(0, 8), imgs: (r.imgs ?? []).slice(0, 3),
    search: r.searchUrl, ysearch: r.ysearchUrl };
};
const total = (list) => {
  const miss = list.filter((x) => x.p == null);
  return { total: list.reduce((t, x) => t + (x.p ?? 0) * x.n, 0), missing: miss.reduce((t, x) => t + x.n, 0) };
};
const out = { updatedAt: '', source: src.source, sourceUrl: src.sourceUrl, listUpdated: src.updated, tiers: [] };
for (const t of src.tiers) {
  const row = { tier: t.tier, label: t.label, decks: [] };
  for (const d of t.decks) {
    const e = { slug: d.slug, name: d.name, leader: d.leader ? item(d.leader, 1) : null, ready: !!d.code };
    if (d.code) {
      const p = parseCode(d.code);
      const normal = [item(p.leader, 1), ...p.cards.map((c) => item(c.id, c.n))];
      const full = [item(paraOf(p.leader), 1), ...p.cards.map((c) => item(paraOf(c.id), c.n))];
      e.leader = normal[0];
      e.count = p.cards.reduce((t, c) => t + c.n, 0);
      e.normal = { cards: normal, ...total(normal) };
      e.full = { cards: full, ...total(full) };
    }
    row.decks.push(e);
  }
  out.tiers.push(row);
}
out.updatedAt = updated;
await writeFile('data/decks.json', JSON.stringify(out));
const ready = out.tiers.flatMap((t) => t.decks).filter((d) => d.ready);
console.log(`デッキ ${ready.length}/${decks.length}件: ` + ready.map((d) => `${d.name} ノーマル¥${d.normal.total}(価格なし${d.normal.missing}枚) フルパラ¥${d.full.total}(価格なし${d.full.missing}枚)`).join(' / '));
