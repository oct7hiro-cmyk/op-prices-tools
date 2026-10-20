// 楽天市場商品検索API(新エンドポイント)で cards.json の各カードの価格を取得し、
// data/latest.json / data/spikes.json / data/history/<id>.csv を更新する。Node 20+、依存なし。
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const { RAKUTEN_APP_ID, RAKUTEN_ACCESS_KEY, RAKUTEN_AFFILIATE_ID = '', SITE_REFERER, YAHOO_APP_ID = '', YAHOO_VC_SID = '', YAHOO_VC_PID = '' } = process.env;
const DELAY_MS = Number(process.env.DELAY_MS ?? 1100); // 1秒1リクエスト程度に抑える
if (!RAKUTEN_APP_ID || !RAKUTEN_ACCESS_KEY || !SITE_REFERER) {
  console.error('RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / SITE_REFERER を設定してください');
  process.exit(1);
}

const ENDPOINT = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
const YAHOO_ENDPOINT = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';
const SPIKE_PCT = 20;     // 基準価格から+20%以上で急騰扱い
const MIN_SAMPLES = 2;    // 有効な出品が2件未満なら「薄い」として急騰判定しない
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // JST日付
const norm = (s) => s.normalize('NFKC').toUpperCase();
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function searchRakuten(keyword, minPrice) {
  const url = new URL(ENDPOINT);
  Object.entries({
    format: 'json', formatVersion: 2, applicationId: RAKUTEN_APP_ID, accessKey: RAKUTEN_ACCESS_KEY,
    affiliateId: RAKUTEN_AFFILIATE_ID, keyword, hits: 30, sort: '+itemPrice', availability: 1, minPrice,
  }).forEach(([k, v]) => v !== '' && url.searchParams.set(k, String(v)));

    let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { Referer: SITE_REFERER, Origin: new URL(SITE_REFERER).origin } });
    if (res.ok) {
      const j = await res.json();
      return (j.Items ?? []).map((i) => i.Item ?? i).map((i) => {
        const u = (i.mediumImageUrls ?? [])[0], img = typeof u === 'string' ? u : u?.imageUrl;
        return { src: 'rakuten', itemName: i.itemName, itemPrice: i.itemPrice, shopName: i.shopName,
          url: i.affiliateUrl || i.itemUrl, img: img ? img.replace(/\?_ex=\d+x\d+$/, '') + '?_ex=400x400' : null };
      });
    }
    if (res.status === 401 || res.status === 403)
      throw new Error(`認証エラー(${res.status}): アクセスキー/アプリID、およびアプリ設定の許可ドメインと SITE_REFERER の一致を確認`);
        if (res.status === 404) return [];            // 該当なし
    lastErr = `${res.status} ${(await res.text()).slice(0, 300)}`;
    await sleep(2000 * attempt);                  // 429/5xx は待って再試行
  }
  throw new Error(`取得失敗(${lastErr}): ${keyword}`);  
}

// Yahoo!ショッピング商品検索API(v3)。YAHOO_APP_ID が無ければスキップ。失敗しても楽天だけで続行する
let yahooDown = false;
async function searchYahoo(keyword, minPrice) {
  if (!YAHOO_APP_ID || yahooDown) return [];
  const url = new URL(YAHOO_ENDPOINT);
  Object.entries({ appid: YAHOO_APP_ID, query: keyword, results: 30, sort: '+price', in_stock: 'true',
    price_from: minPrice, image_size: 600 }).forEach(([k, v]) => v != null && v !== '' && url.searchParams.set(k, String(v)));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': `op-prices-tools/1.0 (+${SITE_REFERER})` } });
      if (res.ok) {
        const j = await res.json();
        return (j.hits ?? []).map((h) => ({ src: 'yahoo', itemName: h.name ?? '', itemPrice: Number(h.price), shopName: h.seller?.name ?? '',
          url: vcWrap(h.url), img: h.exImage?.url || h.image?.medium || null }));
      }
      if (res.status === 401 || res.status === 403) { yahooDown = true; console.error(`[Yahoo] 認証エラー(${res.status}): ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)} / appid長さ=${YAHOO_APP_ID.length}。以降は楽天のみ`); return []; }
      if (res.status === 404) return [];
      console.error(`[Yahoo] ${res.status} ${keyword}`);
    } catch (e) { console.error(`[Yahoo] ${e.message} ${keyword}`); }
    await sleep(2000 * attempt);
  }
  return [];
}

// アフィリエイトリンク
// Yahoo!: バリューコマースのMyLink形式(YAHOO_VC_SID/PID 未設定なら通常URL)
const vcWrap = (u) => (u && YAHOO_VC_SID && YAHOO_VC_PID
  ? `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=${YAHOO_VC_SID}&pid=${YAHOO_VC_PID}&vc_url=${encodeURIComponent(u)}` : u);
// 楽天の検索結果ページ(出品が取れないカード用の受け皿)。アフィリエイトID未設定なら通常URL
const rakutenSearchUrl = (kw) => {
  const u = `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(kw)}/`;
  return RAKUTEN_AFFILIATE_ID ? `https://hb.afl.rakuten.co.jp/hgc/${RAKUTEN_AFFILIATE_ID}/?pc=${encodeURIComponent(u)}&m=${encodeURIComponent(u)}` : u;
};
// 最安出品へのリンク情報
const linkOf = (valid, kw) => ({ url: valid[0]?.url ?? null, src: valid[0]?.src ?? null, shop: valid[0]?.shopName ?? null,
  price: valid[0]?.itemPrice ?? null, searchUrl: rakutenSearchUrl(kw) });

// 楽天とYahoo!をまとめて検索(Yahoo!側の失敗は無視)
async function search(keyword, minPrice) {
  const r = await searchRakuten(keyword, minPrice);
  const y = await searchYahoo(keyword, minPrice);
  return [...r, ...y];
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

// 出品画像URL(最大n件)。Yahoo!(600px)を2件まで先に、残りを楽天(400px)から。安い順
function imgsOf(items, n = 4) {
  const ys = items.filter((i) => i.src === 'yahoo' && i.img).map((i) => i.img);
  const rs = items.filter((i) => i.src !== 'yahoo' && i.img).map((i) => i.img);
  const out = [];
  for (const u of [...ys.slice(0, 2), ...rs, ...ys.slice(2)]) { if (!out.includes(u)) out.push(u); if (out.length >= n) break; }
  return out;
}

async function readHistory(id) {
  const f = `data/history/${id}.csv`;
  if (!existsSync(f)) return [];
  return (await readFile(f, 'utf8')).trim().split('\n').slice(1).map((l) => { const [date, min, ref, count] = l.split(','); return { date, min: +min, ref: +ref, count: +count }; });
}

async function main() {
  const { defaults, cards, images: imageTargets = [] } = JSON.parse(await readFile('cards.json', 'utf8'));
  await mkdir('data/history', { recursive: true });
  const out = [], failed = [];

  for (const card of cards) {
    try {
      const valid = pick(await search(card.keyword, card.minPrice ?? defaults.minPrice), card, defaults);
      const hist = (await readHistory(card.id)).filter((h) => h.date !== today);
      const rec = { id: card.id, name: card.name, updatedAt: today, count: valid.length, imgs: imgsOf(valid), searchUrl: rakutenSearchUrl(card.keyword) };
      if (valid.length) {
        const ref = median(valid.slice(0, 3).map((i) => i.itemPrice)); // 安い順3件の中央値=外れ値に強い参考価格
        const base = hist.length ? median(hist.slice(-7).map((h) => h.ref)) : null;
        Object.assign(rec, { minPrice: valid[0].itemPrice, refPrice: ref, shop: valid[0].shopName,
          url: valid[0].url, src: valid[0].src,
          counts: { rakuten: valid.filter((i) => i.src === 'rakuten').length, yahoo: valid.filter((i) => i.src === 'yahoo').length },
          change: base ? Math.round(((ref - base) / base) * 1000) / 10 : null });
        const f = `data/history/${card.id}.csv`;
        if (!existsSync(f)) await writeFile(f, 'date,min,ref,count\n');
        await appendFile(f, `${today},${rec.minPrice},${ref},${valid.length}\n`);
      }
      out.push(rec);
      console.log(`${card.id}: ${valid.length}件(楽天${rec.counts?.rakuten ?? 0}/Yahoo${rec.counts?.yahoo ?? 0}) min=${rec.minPrice ?? '-'} ref=${rec.refPrice ?? '-'} change=${rec.change ?? '-'}%`);
    } catch (e) {
      if (/認証エラー/.test(e.message)) throw e; // 認証系は全体を止める
      failed.push(card.id); console.error(`${card.id}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  // 画像だけ取得する対象(SP・スーパーパラレル・BOXなど価格は手入力のもの)。失敗してもジョブは止めない
  const images = {}, links = {};
  for (const card of imageTargets) {
    try {
      const valid = pick(await search(card.keyword, card.minPrice ?? defaults.minPrice), card, defaults);
      const imgs = imgsOf(valid);
      if (imgs.length) images[card.id] = imgs;
      links[card.id] = linkOf(valid, card.keyword);
      console.log(`[画像] ${card.id}: ${imgs.length}件`);
    } catch (e) {
      if (/認証エラー/.test(e.message)) throw e;
      console.error(`[画像] ${card.id}: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  await writeFile('data/latest.json', JSON.stringify({ updatedAt: today, credit: 'Supported by Rakuten Developers / Web Services by Yahoo! JAPAN', cards: out, images, links }, null, 1));
  const spikes = out.filter((c) => c.change != null && c.change >= SPIKE_PCT && c.count >= MIN_SAMPLES).sort((a, b) => b.change - a.change);
  await writeFile('data/spikes.json', JSON.stringify({ updatedAt: today, spikes }, null, 1));
  console.log(`完了: ${out.length}件, 急騰${spikes.length}件, 失敗${failed.length}件`);
  if (failed.length > cards.length / 2) process.exit(1); // 半数超の失敗はジョブ失敗にする
}
main().catch((e) => { console.error(e.message); process.exit(1); });
