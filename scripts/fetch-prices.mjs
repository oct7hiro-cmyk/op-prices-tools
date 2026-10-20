// 楽天市場商品検索API(新エンドポイント)で cards.json の各カードの価格を取得し、
// data/latest.json / data/spikes.json / data/history/<id>.csv を更新する。Node 20+、依存なし。
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const { RAKUTEN_APP_ID, RAKUTEN_ACCESS_KEY, RAKUTEN_AFFILIATE_ID = '', SITE_REFERER } = process.env;
const DELAY_MS = Number(process.env.DELAY_MS ?? 1100); // 1秒1リクエスト程度に抑える
if (!RAKUTEN_APP_ID || !RAKUTEN_ACCESS_KEY || !SITE_REFERER) {
  console.error('RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / SITE_REFERER を設定してください');
  process.exit(1);
}

const ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220701';
const SPIKE_PCT = 20;     // 基準価格から+20%以上で急騰扱い
const MIN_SAMPLES = 2;    // 有効な出品が2件未満なら「薄い」として急騰判定しない
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // JST日付
const norm = (s) => s.normalize('NFKC').toUpperCase();
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function search(keyword, minPrice) {
  const url = new URL(ENDPOINT);
  Object.entries({
    format: 'json', formatVersion: 2, applicationId: RAKUTEN_APP_ID, accessKey: RAKUTEN_ACCESS_KEY,
    affiliateId: RAKUTEN_AFFILIATE_ID, keyword, hits: 30, sort: '+itemPrice', availability: 1, minPrice,
  }).forEach(([k, v]) => v !== '' && url.searchParams.set(k, String(v)));

    let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { Referer: SITE_REFERER, Origin: new URL(SITE_REFERER).origin } });
    if (res.ok) { const j = await res.json(); return (j.Items ?? []).map((i) => i.Item ?? i); }
    if (res.status === 401 || res.status === 403)
      throw new Error(`認証エラー(${res.status}): アクセスキー/アプリID、およびアプリ設定の許可ドメインと SITE_REFERER の一致を確認`);
        if (res.status === 404) return [];            // 該当なし
    lastErr = `${res.status} ${(await res.text()).slice(0, 300)}`;
    await sleep(2000 * attempt);                  // 429/5xx は待って再試行
  }
  throw new Error(`取得失敗(${lastErr}): ${keyword}`);  
}

function pick(items, card, d) {
  const code = norm(card.code ?? card.id);
  const ng = [...(d.ng ?? []), ...(card.mustNot ?? [])].map(norm);
  const must = (card.must ?? []).map(norm);
  return items.filter((i) => {
    const n = norm(i.itemName);
    return n.includes(code) && !ng.some((w) => n.includes(w)) && must.every((w) => n.includes(w));
  }).sort((a, b) => a.itemPrice - b.itemPrice);
}

async function readHistory(id) {
  const f = `data/history/${id}.csv`;
  if (!existsSync(f)) return [];
  return (await readFile(f, 'utf8')).trim().split('\n').slice(1).map((l) => { const [date, min, ref, count] = l.split(','); return { date, min: +min, ref: +ref, count: +count }; });
}

async function main() {
  const { defaults, cards } = JSON.parse(await readFile('cards.json', 'utf8'));
  await mkdir('data/history', { recursive: true });
  const out = [], failed = [];

  for (const card of cards) {
    try {
      const valid = pick(await search(card.keyword, card.minPrice ?? defaults.minPrice), card, defaults);
      const hist = (await readHistory(card.id)).filter((h) => h.date !== today);
      const rec = { id: card.id, name: card.name, updatedAt: today, count: valid.length };
      if (valid.length) {
        const ref = median(valid.slice(0, 3).map((i) => i.itemPrice)); // 安い順3件の中央値=外れ値に強い参考価格
        const base = hist.length ? median(hist.slice(-7).map((h) => h.ref)) : null;
        Object.assign(rec, { minPrice: valid[0].itemPrice, refPrice: ref, shop: valid[0].shopName,
          url: valid[0].affiliateUrl || valid[0].itemUrl,
          change: base ? Math.round(((ref - base) / base) * 1000) / 10 : null });
        const f = `data/history/${card.id}.csv`;
        if (!existsSync(f)) await writeFile(f, 'date,min,ref,count\n');
        await appendFile(f, `${today},${rec.minPrice},${ref},${valid.length}\n`);
      }
      out.push(rec);
      console.log(`${card.id}: ${valid.length}件 min=${rec.minPrice ?? '-'} ref=${rec.refPrice ?? '-'} change=${rec.change ?? '-'}%`);
    } catch (e) {
      if (/認証エラー/.test(e.message)) throw e; // 認証系は全体を止める
      failed.push(card.id); console.error(`${card.id}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  await writeFile('data/latest.json', JSON.stringify({ updatedAt: today, credit: 'Supported by Rakuten Developers', cards: out }, null, 1));
  const spikes = out.filter((c) => c.change != null && c.change >= SPIKE_PCT && c.count >= MIN_SAMPLES).sort((a, b) => b.change - a.change);
  await writeFile('data/spikes.json', JSON.stringify({ updatedAt: today, spikes }, null, 1));
  console.log(`完了: ${out.length}件, 急騰${spikes.length}件, 失敗${failed.length}件`);
  if (failed.length > cards.length / 2) process.exit(1); // 半数超の失敗はジョブ失敗にする
}
main().catch((e) => { console.error(e.message); process.exit(1); });
