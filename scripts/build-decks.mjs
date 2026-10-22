// 環境デッキのTier表・デッキリスト・価格をまとめる。Node 20+、依存なし。
//   node scripts/build-decks.mjs --watch … デッキに入っているカードのうち、弾の価格監視(cards.json)に無いものの検索条件を
//                                          data/decks-watch.json に書く(fetch-prices がこれも取得して data/decks-prices.json に保存)
//   node scripts/build-decks.mjs         … data/decks.json(Tier表・リーダーの成績と相性・デッキごとのカード・ノーマル版/フルパラ版の合計価格)を作る
// Tier表・成績・相性は data/meta.json、デッキリストは data/decklists-auto.json(どちらも fetch-decks.mjs が OPlayTCG から取得)。
// 取れていないときは decklists.json(手で書いたTier表とデッキコード)を使う。
// フルパラ版: 各カードのパラレル候補(元の弾のパラレル・プレミアムカードコレクション。SP・コミパラ・超レアなどは除く)のうち
//            一番安いものに置き換えたもの。候補が無いカードはノーマルのまま。リーダーもリーダーパラレルにする
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const WATCH = process.argv.includes('--watch');
const NG_VARIANT = ['パラ', 'SP', 'スペシャル', 'スーパー', 'コミ', '漫画', 'サイン', '★'];
const NG_SPECIAL = ['ANNIVERSARY', '周年', 'CHINA', '中国', '英語', '海外', '簡体', '繁体'];
const PCC_WORDS = ['プレミアムカードコレクション', 'ベストセレクション', 'PCC', 'プレミアムカード', 'プレカコレ'];
const SPECIAL = new Set(['TOP', 'SP', 'CP', 'LSP', 'TR']); // フルパラに使わない区分
const TYPE = { LEADER: 'リーダー', CHARACTER: 'キャラ', EVENT: 'イベント', STAGE: 'ステージ' };
const COLOR = { '赤': '赤', '緑': '緑', '青': '青', '紫': '紫', '黒': '黒', '黄': '黄' };
const read = async (f, d = null) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : d);

const src = await read('decklists.json');
const meta = await read('data/meta.json');
const auto = await read('data/decklists-auto.json', { decks: {} });
const raw = await read('data/raw/cardlists.json');
const index = await read('sets/index.json');

// カード番号 → 元の弾のシリーズ番号(OP17 → 550117、EB04 → 550204、PRB02 → 550302、ST30 → 550030)
const home = (id) => { const m = id.match(/^(OP|EB|PRB|ST)(\d+)-/); return m ? '550' + { ST: '0', OP: '1', EB: '2', PRB: '3' }[m[1]] + m[2].padStart(2, '0') : null; };
// 公式カードリスト。同じ番号が複数の弾にあれば元の弾を優先
const card = {};
for (const [sid, s] of Object.entries(raw.sets)) for (const c of s.cards) {
  const v = { id: c[0], rar: c[1], name: c[2], type: c[3], color: c[4], series: sid, info: c[5] ?? '' };
  if (!card[c[0]] || home(c[0]) === sid) card[c[0]] = v;
}
const catOf = {};
for (const s of index.sets) { const c = await read(`sets/${s.code}.json`); for (const x of c.cards) if (!catOf[x[0]] || home(x[0]) === c.series) catOf[x[0]] = x[1]; }
const autoNames = Object.assign({}, ...Object.values(auto.decks ?? {}).map((x) => x.names ?? {}));
const nameOf = (id) => { const b = id.replace(/_[pr]\d+$/, ''); return card[id]?.name ?? card[b]?.name ?? src.names?.[b] ?? autoNames[b] ?? b; };

// デッキ名: リーダーの色+短い名前(例: 青ロックス)。同じ名前が2つ以上あれば弾コードを付ける
function deckName(id) {
  const c = card[id], full = nameOf(id);
  const short = src.short?.[id] ?? full.split('・').pop();
  const col = (c?.color ?? '').split('/').map((x) => COLOR[x] ?? '').join('');
  return col + short;
}

function parseCode(code) {
  const [leader, rest = ''] = code.split('|');
  return { leader: leader.trim(), cards: rest.split(',').filter(Boolean).map((t) => { const m = t.trim().match(/^(\d+)x(.+)$/); return { id: m[2].trim(), n: +m[1] }; }) };
}
// フルパラ版の候補: 元の弾のパラレル(一番番号の小さいもの)+プレミアムカードコレクションのパラレル。
// 元の弾に無ければプレミアムブースターのパラレル(フォイル以外)
function paraCands(id) {
  const vs = Object.keys(card).filter((k) => k.startsWith(id + '_p') && !SPECIAL.has(catOf[k]));
  const num = (k) => +k.match(/_p(\d+)$/)[1];
  const h = home(id);
  const own = vs.filter((k) => card[k].series === h && catOf[k] !== 'FOIL').sort((a, b) => num(a) - num(b)).slice(0, 1).map((k) => ({ id: k, kind: 'home' }));
  const pcc = vs.filter((k) => /^5508/.test(card[k].series) && /プレミアムカードコレクション/.test(card[k].info)).map((k) => ({ id: k, kind: 'pcc', info: card[k].info }));
  const prb = own.length ? [] : vs.filter((k) => /^5503/.test(card[k].series) && !['FOIL', 'OTHER'].includes(catOf[k])).sort((a, b) => num(a) - num(b)).slice(0, 1).map((k) => ({ id: k, kind: 'home' }));
  return [...own, ...prb, ...pcc];
}

// Tier表とデッキ(OPlayTCG のデータがあればそれ、無ければ decklists.json)
const codeFromSrc = Object.fromEntries(src.tiers.flatMap((t) => t.decks).filter((d) => d.code && d.leader).map((d) => [d.leader, d.code]));
const rows = meta?.tiers?.length
  ? meta.tiers.map((t) => ({ tier: t.tier, label: t.label, leaders: t.leaders }))
  : src.tiers.map((t) => ({ tier: t.tier, label: t.label, leaders: t.decks.map((d) => d.leader).filter(Boolean) }));
const codeOf = (id) => auto.decks?.[id]?.code ?? codeFromSrc[id] ?? null;
const allLeaders = rows.flatMap((r) => r.leaders);
const opponents = new Set();
for (const id of allLeaders) for (const m of meta?.leaders?.[id]?.matchups ?? []) opponents.add(m.o);

const need = new Map(); // カード番号 → 候補の種類
for (const id of [...allLeaders, ...opponents]) need.set(id, 'base');
for (const id of allLeaders) {
  const code = codeOf(id);
  const ids = code ? [parseCode(code).leader, ...parseCode(code).cards.map((c) => c.id)] : [id];
  for (const c of ids) { need.set(c, 'base'); for (const p of paraCands(c)) need.set(p.id, p.kind); }
}

if (WATCH) {
  const watched = new Set((await read('cards.json', { cards: [] })).cards.map((c) => c.id));
  const out = [];
  for (const [id, kind] of need) {
    if (watched.has(id)) continue;
    const base = id.replace(/_[pr]\d+$/, ''), c = card[id] ?? card[base];
    const w = { set: 'DECK', id, name: `${nameOf(id)}(${id === base ? (c?.rar ?? '') : kind === 'pcc' ? 'プレミアムカードコレクション' : 'パラレル'})`, code: base };
    if (id === base) Object.assign(w, { keyword: `ワンピースカード ${base}`, mustNot: [...NG_VARIANT, ...NG_SPECIAL, ...PCC_WORDS], trimHigh: 4 });
    else if (kind === 'pcc') Object.assign(w, { keyword: `ワンピースカード ${base} プレミアムカードコレクション`, mustAny: PCC_WORDS, mustNot: ['スーパー', 'コミ', '漫画', 'SP', 'スペシャル', ...NG_SPECIAL] });
    else Object.assign(w, { keyword: `ワンピースカード ${base} パラレル`, must: ['パラ'], mustNot: ['スーパー', 'コミ', '漫画', 'SP', 'スペシャル', ...NG_SPECIAL, ...PCC_WORDS] });
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
const item = (id, n, kind) => {
  const base = id.replace(/_[pr]\d+$/, ''), c = card[id] ?? card[base] ?? {}, r = price[id] ?? {};
  if (r.updatedAt > updated) updated = r.updatedAt;
  return { id, n, name: nameOf(id), rar: c.rar ?? '', type: TYPE[c.type] ?? '', color: c.color ?? '', para: id !== base,
    pcc: kind === 'pcc' ? (card[id]?.info ?? 'プレミアムカードコレクション') : undefined,
    p: r.refPrice ?? null, est: r.est || undefined, so: r.soldout || undefined, offers: (r.offers ?? []).slice(0, 8), imgs: (r.imgs ?? []).slice(0, 3),
    search: r.searchUrl, ysearch: r.ysearchUrl };
};
// フルパラ版: 候補のうち価格のある一番安いもの(どれも価格が無ければ最初の候補)
const full = (id, n) => {
  const cs = paraCands(id);
  if (!cs.length) return item(id, n);
  const priced = cs.map((c) => ({ c, p: price[c.id]?.refPrice })).filter((x) => x.p).sort((a, b) => a.p - b.p);
  const pick = priced[0]?.c ?? cs[0];
  return item(pick.id, n, pick.kind);
};
const total = (list) => ({ total: list.reduce((t, x) => t + (x.p ?? 0) * x.n, 0), missing: list.filter((x) => x.p == null).reduce((t, x) => t + x.n, 0) });

// 名前の重複には弾コードを付ける
const names = {};
for (const id of new Set([...allLeaders, ...opponents])) names[id] = deckName(id);
const dup = {};
Object.values(names).forEach((n) => (dup[n] = (dup[n] ?? 0) + 1));
for (const id in names) if (dup[names[id]] > 1) names[id] += `(${id.split('-')[0]})`;

const ML = meta?.leaders ?? {};
const mu = (x) => ({ id: x.o, name: names[x.o] ?? deckName(x.o), games: x.games, winRate: x.winRate, first: x.first, second: x.second, leader: item(x.o, 1) });
const out = { updatedAt: '', source: meta ? meta.source : src.source, sourceUrl: meta ? meta.sourceUrl : src.sourceUrl,
  listUpdated: meta ? (meta.statsAt ?? '').slice(0, 10) : src.updated, rule: meta?.rule ?? null, window: meta?.window ?? null, minMatch: meta?.minMatch ?? null,
  lists: auto.source ? { source: auto.source, sourceUrl: auto.sourceUrl, rule: auto.rule } : null, tiers: [] };
for (const r of rows) {
  const row = { tier: r.tier, label: r.label, decks: [] };
  for (const id of r.leaders) {
    const code = codeOf(id), st = ML[id];
    const e = { slug: id.toLowerCase(), name: names[id], leader: item(id, 1), ready: !!code };
    if (st) {
      e.stats = { winRate: st.winRate, games: st.games, first: st.first, second: st.second, share: st.share, players: st.players };
      const ms = st.matchups ?? [];
      e.good = ms.filter((x) => x.winRate > 50).sort((a, b) => b.winRate - a.winRate).slice(0, 3).map(mu);
      e.bad = ms.filter((x) => x.winRate < 50).sort((a, b) => a.winRate - b.winRate).slice(0, 3).map(mu);
    }
    if (code) {
      const p = parseCode(code);
      const normal = [item(p.leader, 1), ...p.cards.map((c) => item(c.id, c.n))];
      const fl = [full(p.leader, 1), ...p.cards.map((c) => full(c.id, c.n))];
      e.count = p.cards.reduce((t, c) => t + c.n, 0);
      e.normal = { cards: normal, ...total(normal) };
      e.full = { cards: fl, ...total(fl) };
    }
    row.decks.push(e);
  }
  out.tiers.push(row);
}
out.updatedAt = updated;
await writeFile('data/decks.json', JSON.stringify(out));
const ready = out.tiers.flatMap((t) => t.decks).filter((d) => d.ready);
console.log(`デッキ ${ready.length}/${allLeaders.length}件\n` + out.tiers.map((t) => `${t.tier}: ` + t.decks.map((d) => `${d.name}${d.stats ? `(${d.stats.winRate}%)` : ''} ¥${d.normal?.total ?? '-'}/¥${d.full?.total ?? '-'}(なし${d.normal?.missing ?? '-'}/${d.full?.missing ?? '-'})`).join(' ')).join('\n'));
