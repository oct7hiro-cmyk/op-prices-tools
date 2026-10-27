// カード検索・お気に入り用の一覧 data/search.json を作る(merge-manual の後に実行)。Node 20+、依存なし。
//   c: [カード番号, 弾, 名前, 表示ラベル, 参考価格, 前日の参考価格, 画像URL]
//   画面ではこれで検索・お気に入りの価格表示をして、タップしたら弾のデータ(data/sets/<弾>.json)から販売店の一覧を開く
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const NOIMG = /no[_-]?(photo|image|img)|now[_-]?printing/i;
const HI_CATS = new Set(['TOP', 'CP', 'LSP', 'TR']);
const LBL = { R: 'R', SR: 'SR', SEC: 'SEC', PAR: 'パラレル', SECP: 'SECパラレル', LPAR: 'リーダーパラレル', SP: 'SP', CP: 'コミパラ',
  LSP: 'リーダースーパーパラレル', TOP: '超レア', TR: 'トレジャーレア', FOIL: 'フォイル', FA: 'フルアート', OTHER: '特別パラレル' };
const index = JSON.parse(await readFile('sets/index.json', 'utf8'));

// 前日(最新より前の一番新しい日)の参考価格。超高額カードは ref(中央値)、それ以外は min(最安値)。出品3件未満の日は min
async function prevOf(id, hi) {
  const f = `data/history/${id}.csv`;
  if (!existsSync(f)) return null;
  const rows = (await readFile(f, 'utf8')).trim().split('\n').slice(1).map((l) => l.split(',')).filter((r) => +r[1] > 0);
  if (rows.length < 2) return null;
  const r = rows[rows.length - 2];
  return hi && +r[3] >= 3 ? Math.round(+r[2] || +r[1]) : +r[1];
}

const out = [];
for (const s of index.sets) {
  const f = `data/sets/${s.code}.json`;
  if (!existsSync(f)) continue;
  const data = JSON.parse(await readFile(f, 'utf8'));
  const cfg = JSON.parse(await readFile(`sets/${s.code}.json`, 'utf8'));
  const byId = Object.fromEntries(data.cards.map((c) => [c.id, c]));
  for (const [id, cat, name, , label] of cfg.cards) {
    const c = byId[id] ?? {};
    const p = c.refPrice ?? null;
    const hi = HI_CATS.has(cat) || (p ?? 0) >= 30000;
    const img = (c.imgs ?? []).find((u) => !NOIMG.test(u)) ?? '';
    out.push([id, s.code, name, label || cfg.labels?.[cat] || LBL[cat] || cat, p, p != null && !c.est && !c.soldout ? await prevOf(id, hi) : null, img]);
  }
}
await writeFile('data/search.json', JSON.stringify({ updatedAt: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), c: out }));
console.log(`検索用の一覧 ${out.length}件`);
