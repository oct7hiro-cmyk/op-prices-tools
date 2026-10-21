// 楽天/Yahoo!バッチの後に実行。
// 1) manual-prices.json の手入力価格を data/sets/<CODE>.json に反映する
//    force:true → 常に手入力価格を使う(高額で出品が少ないカード向け)
//    force:false/未指定 → 有効出品が2件未満のときだけ手入力価格を使う
// 2) 弾一覧用のまとめ data/sets/index.json(更新日・BOX画像・1BOXの期待値)を作る
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const manual = JSON.parse(await readFile('manual-prices.json', 'utf8'));
const index = JSON.parse(await readFile('sets/index.json', 'utf8'));
const summary = {};
let n = 0;
for (const s of index.sets) {
  const f = `data/sets/${s.code}.json`;
  if (!existsSync(f)) continue;
  const data = JSON.parse(await readFile(f, 'utf8'));
  const cfg = JSON.parse(await readFile(`sets/${s.code}.json`, 'utf8'));
  const ids = new Set(cfg.cards.map((c) => c[0]));
  for (const [id, m] of Object.entries(manual)) {
    if (!ids.has(id)) continue;
    const i = data.cards.findIndex((c) => c.id === id);
    const cur = i >= 0 ? data.cards[i] : null;
    if (cur && cur.source !== 'manual' && !m.force && cur.count >= 2 && cur.refPrice) continue;
    const rec = { ...(cur ?? {}), id, name: m.name ?? cur?.name ?? id, updatedAt: m.updated ?? data.updatedAt,
      minPrice: m.price, refPrice: m.price, source: 'manual', change: null, ...(m.url ? { url: m.url } : {}),
      ...(m.buyPrice ? { buyPrice: m.buyPrice } : {}), ...(m.label ? { label: m.label } : {}) };
    if (i >= 0) data.cards[i] = rec; else data.cards.push(rec);
    n++;
  }
  await writeFile(f, JSON.stringify(data));
  // 1BOXの期待値(価格未取得は0円)
  const price = Object.fromEntries(data.cards.map((c) => [c.id, c.refPrice ?? 0]));
  const avg = (cat) => { const a = cfg.cards.filter((c) => c[1] === cat); return a.length ? a.reduce((t, c) => t + (price[c[0]] ?? 0), 0) / a.length : 0; };
  let ev = 0;
  for (const [cat, r] of Object.entries(cfg.base)) if (Array.isArray(r)) ev += ((r[0] + r[1]) / 2) * avg(cat);
  for (const [cat, c] of Object.entries(cfg.cats)) ev += c.lambda * avg(cat);
  summary[s.code] = { updatedAt: data.updatedAt, box: data.images?.BOX?.[0] ?? null, ev: Math.round(ev), pre: data.box?.pre ?? null,
    priced: cfg.cards.filter((c) => price[c[0]]).length, total: cfg.cards.length };
}
await writeFile('data/sets/index.json', JSON.stringify({ updated: new Date().toISOString().slice(0, 10), sets: summary }, null, 1));
console.log(`手入力価格を${n}件反映 / まとめ${Object.keys(summary).length}弾`);
