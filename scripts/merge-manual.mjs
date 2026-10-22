// 楽天/Yahoo!バッチの後に実行(手入力の価格は使わない)。
// 1) 価格が取れなかったカード(在庫あり・売り切れのどちらの出品もない)に、同じ弾・同じ区分の中央値を「推定価格」として入れる。
//    同じ弾に価格のあるカードがなければ全弾の同じ区分の中央値。推定は est:true で区別し、画面で「推定」と表示する
// 2) 弾一覧用のまとめ data/sets/index.json(更新日・BOX画像・プレ値・1BOXの期待値)を作る
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const index = JSON.parse(await readFile('sets/index.json', 'utf8'));
const HI_CATS = new Set(['TOP', 'CP', 'LSP', 'TR']); // 超高額カード(参考価格は安い順3件の中央値)
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)) : null; };

// 読み込み(以前の手入力・推定の値は捨てて、実際の出品価格だけを残す)
const all = [];
for (const s of index.sets) {
  const f = `data/sets/${s.code}.json`;
  if (!existsSync(f)) continue;
  const data = JSON.parse(await readFile(f, 'utf8'));
  const cfg = JSON.parse(await readFile(`sets/${s.code}.json`, 'utf8'));
  const cat = Object.fromEntries(cfg.cards.map((c) => [c[0], c[1]]));
  data.cards = data.cards.filter((c) => c.source !== 'manual' || c.offers?.length).map((c) => {
    if (c.source === 'manual' || c.est) { const { refPrice, minPrice, source, est, buyPrice, label, ...rest } = c; return rest; }
    if (c.minPrice) { // カードの価格はショップ最安値(2番目の35%未満の極端に安い出品は別物とみなして除く)。超高額カードは安い順3件の中央値
      const ps = (c.offers ?? []).map((o) => o.p).filter((p) => p > 0).sort((a, b) => a - b);
      while (ps.length >= 3 && ps[0] < ps[1] * 0.35) ps.shift();
      const hi = HI_CATS.has(cat[c.id]) || (ps[0] ?? 0) >= 30000;
      return { ...c, refPrice: ps.length ? (ps.length >= 3 && hi ? ps[1] : ps[0]) : c.minPrice };
    }
    return c;
  });
  all.push({ s, f, data, cfg });
}
// 区分ごとの中央値(弾ごと・全弾)
const catOf = (cfg) => Object.fromEntries(cfg.cards.map((c) => [c[0], c[1]]));
const perSet = {}, global = {};
for (const { s, data, cfg } of all) {
  const cat = catOf(cfg);
  for (const c of data.cards) {
    if (!c.refPrice || !cat[c.id]) continue;
    ((perSet[s.code] ??= {})[cat[c.id]] ??= []).push(c.refPrice);
    (global[cat[c.id]] ??= []).push(c.refPrice);
  }
}
const summary = {};
let est = 0;
for (const { s, f, data, cfg } of all) {
  const used = new Set([...Object.keys(cfg.base ?? {}), ...Object.keys(cfg.hit ?? {}), ...Object.keys(cfg.cats ?? {})]);
  const byId = Object.fromEntries(data.cards.map((c) => [c.id, c]));
  for (const [id, cat, name] of cfg.cards) {
    if (!used.has(cat) || byId[id]?.refPrice) continue;
    const v = median(perSet[s.code]?.[cat] ?? []) ?? median(global[cat] ?? []);
    if (!v) continue;
    const rec = { ...(byId[id] ?? { id, name, offers: [], imgs: [] }), refPrice: v, minPrice: v, est: true, source: 'estimate' };
    if (byId[id]) Object.assign(byId[id], rec); else data.cards.push(rec);
    est++;
  }
  await writeFile(f, JSON.stringify(data));
  // 1BOXの期待値: 基本枠(R・SR)+確定枠(SECかパラレルのどちらか1枚)+追加の当たり(λ)
  const price = Object.fromEntries(data.cards.map((c) => [c.id, c.refPrice ?? 0]));
  const avg = (k) => { const a = cfg.cards.filter((c) => c[1] === k); return a.length ? a.reduce((t, c) => t + (price[c[0]] ?? 0), 0) / a.length : 0; };
  let ev = 0;
  for (const [k, r] of Object.entries(cfg.base ?? {})) if (Array.isArray(r)) ev += ((r[0] + r[1]) / 2) * avg(k);
  for (const [k, p] of Object.entries(cfg.hit ?? {})) ev += p * avg(k);
  for (const [k, c] of Object.entries(cfg.cats ?? {})) ev += c.lambda * avg(k);
  summary[s.code] = { updatedAt: data.updatedAt, box: data.images?.BOX?.[0] ?? null, ev: Math.round(ev), pre: data.box?.pre ?? null,
    priced: cfg.cards.filter((c) => price[c[0]]).length, estimated: data.cards.filter((c) => c.est).length, total: cfg.cards.length };
}
await writeFile('data/sets/index.json', JSON.stringify({ updated: new Date().toISOString().slice(0, 10), sets: summary }, null, 1));
console.log(`推定価格 ${est}件 / まとめ${Object.keys(summary).length}弾`);
