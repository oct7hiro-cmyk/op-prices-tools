// 相場ランキング data/ranking.json を作る(merge-manual の後に実行)。Node 20+、依存なし。
//   部門: top=超高額(コミパラ・超レアなど) / par=パラレル・SP / base=汎用カード(R・SR・SEC)
//   一覧: high=高額TOP50 / up=今週の値上がり / down=今週の値下がり(約7日前との比較。データが7日分ないときはある分で比較)
//   価格はショップ最安値(履歴の min)で比べる。値上がり・値下がりは部門ごとの最低価格以上のカードだけ、金額順と率順の2通り
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DIV = { TOP: 'top', CP: 'top', LSP: 'top', SP: 'par', TR: 'top', PAR: 'par', SECP: 'par', LPAR: 'par', FA: 'par', OTHER: 'par', R: 'base', SR: 'base', SEC: 'base' };
const MIN_UP = { top: 1000, par: 300, base: 100 }; // 値上がり・値下がりとして載せる最低の変動幅(円)
const MIN_PRICE = { top: 10000, par: 1000, base: 500 }; // 値上がり・値下がりに載せる最低価格(低額カードが率で上位を占めないように。値下がりは下がる前の価格)
const N = 50;
const DAY = 864e5;

const index = JSON.parse(await readFile('sets/index.json', 'utf8'));
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function history(id) {
  const f = `data/history/${id}.csv`;
  if (!existsSync(f)) return [];
  return (await readFile(f, 'utf8')).trim().split('\n').slice(1).map((l) => {
    const [date, min, ref, count] = l.split(','); return { date, min: +min, ref: +ref || +min, count: +count };
  }).filter((h) => h.min > 0);
}

const all = [];
const seen = new Set(); // 弾をまたいだ再録・同じ出品に当たった別バリアントは1件にまとめる(新しい弾を優先)
for (const s of index.sets) {
  const f = `data/sets/${s.code}.json`;
  if (!existsSync(f)) continue;
  const data = JSON.parse(await readFile(f, 'utf8'));
  const cfg = JSON.parse(await readFile(`sets/${s.code}.json`, 'utf8'));
  const meta = Object.fromEntries(cfg.cards.map((c) => [c[0], c]));
  for (const c of data.cards) {
    const m = meta[c.id];
    if (!m || !c.refPrice || c.est) continue; // 推定価格のカードはランキングに載せない
    const div = DIV[m[1]];
    if (!div) continue;
    const key = c.source === 'manual' || !c.offers?.length ? c.id : `${c.refPrice}|${c.offers[0].u}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ id: c.id, set: s.code, div, c: m[1], n: m[2], k: m[4] || cfg.labels?.[m[1]] || m[1], rar: m[3],
      p: c.refPrice, min: c.minPrice ?? null, count: c.count ?? 0, soldout: c.soldout || undefined,
      imgs: (c.imgs ?? []).slice(0, 2), offers: (c.offers ?? []).slice(0, 5), search: c.searchUrl, ysearch: c.ysearchUrl, updatedAt: c.updatedAt ?? data.updatedAt });
  }
}

// 値上がり: 最新値と「約7日前(6〜10日前で最も7日に近い日)」の参考価格を比べる。なければ1日以上前の最も古い日と比べる
for (const r of all) {
  if (r.soldout) continue;
  const h = await history(r.id);
  if (h.length < 2) continue;
  const last = h[h.length - 1];
  const t = Date.parse(last.date);
  const older = h.filter((x) => t - Date.parse(x.date) >= DAY);
  if (!older.length) continue;
  const near = older.filter((x) => { const d = (t - Date.parse(x.date)) / DAY; return d >= 6 && d <= 10; })
    .sort((a, b) => Math.abs((t - Date.parse(a.date)) / DAY - 7) - Math.abs((t - Date.parse(b.date)) / DAY - 7));
  const base = near[0] ?? older[0];
  if (base.count < 2 || last.count < 2) continue; // 出品が薄いときは比べない
  // 今の価格は画面と同じ参考価格(最安値。超高額カードは安い順3件の中央値)
  // 超高額カード(参考価格=安い順3件の中央値)は履歴の ref、それ以外は履歴の min(最安値)と比べる
  const hi = r.div === 'top' || r.p >= 30000;
  // 出品3件未満の日は中央値でなく最安値
  r.prev = hi && base.count >= 3 ? base.ref : base.min; r.days = Math.round((t - Date.parse(base.date)) / DAY); r.diff = r.p - r.prev;
  r.pct = Math.round((r.diff / r.prev) * 1000) / 10;
  r.spark = [...h.slice(-14, -1).map((x) => x.ref), r.p];
}

const out = { updatedAt: today, divisions: {} };
for (const div of ['top', 'par', 'base']) {
  const list = all.filter((r) => r.div === div);
  const high = [...list].sort((a, b) => b.p - a.p).slice(0, N);
  // 値上がり・値下がりは金額順(up/down)と率順(upPct/downPct)の両方を作る
  const ups = list.filter((r) => r.diff >= MIN_UP[div] && r.pct > 0 && r.p >= MIN_PRICE[div]);
  const downs = list.filter((r) => r.diff <= -MIN_UP[div] && r.pct < 0 && r.prev >= MIN_PRICE[div]);
  const up = [...ups].sort((a, b) => b.diff - a.diff || b.pct - a.pct).slice(0, N);
  const upPct = [...ups].sort((a, b) => b.pct - a.pct || b.diff - a.diff).slice(0, N);
  const down = [...downs].sort((a, b) => a.diff - b.diff || a.pct - b.pct).slice(0, N);
  const downPct = [...downs].sort((a, b) => a.pct - b.pct || a.diff - b.diff).slice(0, N);
  const days = list.filter((r) => r.days).map((r) => r.days);
  out.divisions[div] = { high, up, upPct, down, downPct, minPrice: MIN_PRICE[div], total: list.length, days: days.length ? Math.max(...days) : 0 };
}
await writeFile('data/ranking.json', JSON.stringify(out));
console.log('ランキング', Object.entries(out.divisions).map(([k, v]) => `${k}: 対象${v.total} 高額${v.high.length} 値上がり${v.up.length} 値下がり${v.down.length}(最大${v.days}日比)`).join(' / '));
