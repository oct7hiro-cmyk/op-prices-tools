// 楽天バッチの後に実行。manual-prices.json の手入力価格を data/latest.json に反映する。
//  force:true            → 常に手入力価格を使う(高額で楽天に出品が少ないカード向け)
//  force:false/未指定    → 楽天側の有効出品が2件未満のときだけ手入力価格を使う
import { readFile, writeFile } from 'node:fs/promises';

const latest = JSON.parse(await readFile('data/latest.json', 'utf8'));
const manual = JSON.parse(await readFile('manual-prices.json', 'utf8'));
let n = 0;
for (const [id, m] of Object.entries(manual)) {
  const i = latest.cards.findIndex((c) => c.id === id);
  const cur = i >= 0 ? latest.cards[i] : null;
  if (cur && !m.force && cur.count >= 2 && cur.refPrice) continue; // 楽天の価格が十分あるなら優先
  const rec = { ...(cur ?? {}), id, name: m.name ?? cur?.name ?? id, updatedAt: m.updated ?? latest.updatedAt,
    minPrice: m.price, refPrice: m.price, source: 'manual', change: null, ...(m.url ? { url: m.url } : {}),
    ...(m.buyPrice ? { buyPrice: m.buyPrice } : {}), ...(m.label ? { label: m.label } : {}) };
  if (i >= 0) latest.cards[i] = rec; else latest.cards.push(rec);
  n++;
}
await writeFile('data/latest.json', JSON.stringify(latest, null, 1));
console.log(`手入力価格を${n}件反映`);
