// 楽天市場商品検索API(新エンドポイント)で cards.json の各カードの価格を取得し、
// data/latest.json / data/spikes.json / data/history/<id>.csv を更新する。Node 20+、依存なし。
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const { RAKUTEN_APP_ID, RAKUTEN_ACCESS_KEY, RAKUTEN_AFFILIATE_ID = '', SITE_REFERER, YAHOO_APP_ID = '', YAHOO_VC_SID = '', YAHOO_VC_PID = '' } = process.env;
const BOX_ONLY = /^(1|true)$/.test(process.env.BOX_ONLY ?? '');
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

async function searchRakuten(keyword, minPrice, all = false) {
  const url = new URL(ENDPOINT);
  Object.entries({
    format: 'json', formatVersion: 2, applicationId: RAKUTEN_APP_ID, accessKey: RAKUTEN_ACCESS_KEY,
    affiliateId: RAKUTEN_AFFILIATE_ID, keyword, hits: 30, sort: '+itemPrice', availability: all ? 0 : 1, minPrice,
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
async function searchYahoo(keyword, minPrice, all = false) {
  if (!YAHOO_APP_ID || yahooDown) return [];
  const url = new URL(YAHOO_ENDPOINT);
  Object.entries({ appid: YAHOO_APP_ID, query: keyword, results: 30, sort: '+price', in_stock: all ? '' : 'true',
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
// Yahoo!ショッピングの検索結果ページ(受け皿)
const yahooSearchUrl = (kw) => vcWrap(`https://shopping.yahoo.co.jp/search?p=${encodeURIComponent(kw)}`);
// 販売ショップ一覧(安い順・最大8件)。検索は在庫ありのみなので、取得時点で在庫あり
const offersOf = (valid, n = 8) => valid.slice(0, n).map((i) => ({ s: i.src, shop: i.shopName, p: i.itemPrice, u: i.url, n: String(i.itemName ?? '').slice(0, 60) }));
// 最安出品へのリンク情報
const linkOf = (valid, kw) => ({ url: valid[0]?.url ?? null, src: valid[0]?.src ?? null, shop: valid[0]?.shopName ?? null,
  price: valid[0]?.itemPrice ?? null, searchUrl: rakutenSearchUrl(kw), ysearchUrl: yahooSearchUrl(kw), offers: offersOf(valid) });

// 楽天とYahoo!をまとめて検索(Yahoo!側の失敗は無視)
async function search(keyword, minPrice, all = false) {
  const r = await searchRakuten(keyword, minPrice, all);
  const y = await searchYahoo(keyword, minPrice, all);
  return [...r, ...y];
}

function pick(items, card, d) {
  const code = norm(card.code ?? card.id);
  const ng = [...(d.ng ?? []), ...(card.mustNot ?? [])].map(norm);
  const must = (card.must ?? []).map(norm), any = (card.mustAny ?? []).map(norm);
  return items.filter((i) => {
    const n = norm(i.itemName);
    return n.includes(code) && !ng.some((w) => n.includes(w)) && must.every((w) => n.includes(w)) && (!any.length || any.some((w) => n.includes(w)));
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

// 今回取得する弾: 環境変数 SETS(例 "OP17,OP16" / "all")があればそれ。
// なければ新しい3弾は毎日、残りは発売順に7グループへ分けて曜日ごとに週1回。
function chooseSets(index) {
  const all = index.sets.map((s) => s.code);
  const env = (process.env.SETS ?? '').trim();
  if (env) return env === 'all' ? all : env.split(',').map((x) => x.trim()).filter((x) => all.includes(x));
  const daily = all.slice(0, 3), rest = all.slice(3);
  const dow = new Date(Date.now() + 9 * 3600e3).getUTCDay();
  return [...daily, ...rest.filter((_, i) => i % 7 === dow)];
}

async function priceCard(card, defaults) {
  let valid = pick(await search(card.keyword, card.minPrice ?? defaults.minPrice), card, defaults);
  // 在庫のある出品がないとき(高額カードに多い)は、売り切れの出品も含めて探し、その販売価格を参考価格にする
  let soldout = false;
  if (!valid.length) {
    await sleep(DELAY_MS);
    valid = pick(await search(card.keyword, card.minPrice ?? defaults.minPrice, true), card, defaults);
    soldout = valid.length > 0;
  }
  // 通常カード(R/SR/SEC)は最安の trimHigh 倍を超える出品を除く(記念版・別バージョンの高値が混ざって相場が跳ねるのを防ぐ)
  if (card.trimHigh && valid.length) valid = valid.filter((i) => i.itemPrice <= valid[0].itemPrice * card.trimHigh);
  const hist = (await readHistory(card.id)).filter((h) => h.date !== today);
  const rec = { id: card.id, name: card.name, updatedAt: today, count: soldout ? 0 : valid.length, imgs: imgsOf(valid),
    searchUrl: rakutenSearchUrl(card.keyword), ysearchUrl: yahooSearchUrl(card.keyword),
    offers: offersOf(valid).map((o) => (soldout ? { ...o, so: 1 } : o)), ...(soldout ? { soldout: true } : {}) };
  if (valid.length) {
    const ref = median(valid.slice(0, 3).map((i) => i.itemPrice)); // 安い順3件の中央値=外れ値に強い参考価格
    const base = hist.length ? median(hist.slice(-7).map((h) => h.ref)) : null;
    Object.assign(rec, { minPrice: valid[0].itemPrice, refPrice: ref, shop: valid[0].shopName, url: valid[0].url, src: valid[0].src,
      counts: { rakuten: valid.filter((i) => i.src === 'rakuten').length, yahoo: valid.filter((i) => i.src === 'yahoo').length },
      change: base && !soldout ? Math.round(((ref - base) / base) * 1000) / 10 : null });
    const f = `data/history/${card.id}.csv`;
    if (!existsSync(f)) await writeFile(f, 'date,min,ref,count\n');
    const lines = (await readFile(f, 'utf8')).split('\n').filter((l) => l && !l.startsWith(`${today},`)); // 同じ日の再取得は上書き
    await writeFile(f, [...lines, `${today},${rec.minPrice},${ref},${rec.count}`].join('\n') + '\n');
  }
  return rec;
}

// BOX(未開封)の販売価格。弾名+弾コード(OP17 / OP-17)の両方を含む出品だけを使い、
// 複数BOX・カートン・パック・開封済み・オリパなどは除外。安い順3件の中央値をプレ値(実売相場)とする。
const BOX_NG = ['カートン', 'パック単品', 'バラ', 'ばら', '1パック', 'シングル', '開封済', '空箱', 'オリパ', '福袋', 'ケース', 'セット', '2BOX', '3BOX', '4BOX', '5BOX', '6BOX', '10BOX', '12BOX', '24BOX', '×2', 'X2', '2個', '3個', 'スリーブ', 'プレイマット', 'デッキ', 'ストレージ'];
// 「6パック」「15パック ばら売り」などBOXでない出品を除く。BOXのパック数と同じ数、または「2パック付き」(特典)はOK
function packsOk(n, packs) {
  for (const m of n.matchAll(/(\d+)パック(.?)/g)) {
    if (+m[1] !== packs && m[2] !== '付') return false;
  }
  return true;
}
async function priceBox(meta) {
  const code = meta.code, hy = code.replace(/^([A-Z]+)(\d+)$/, '$1-$2');
  const packs = existsSync(`sets/${code}.json`) ? JSON.parse(await readFile(`sets/${code}.json`, 'utf8')).packs ?? 24 : 24;
  const minPrice = Math.max(3000, Math.round((meta.msrp ?? 5000) * 0.7));
  const items = [...await search(`ワンピースカード ${meta.name} BOX`, minPrice)];
  await sleep(DELAY_MS);
  items.push(...await search(`ワンピースカード ${hy} BOX`, minPrice));
  const seen = new Set();
  const valid = items.filter((i) => {
    const n = norm(i.itemName), k = i.url;
    if (seen.has(k)) return false; seen.add(k);
    return n.includes('BOX') && (n.includes(norm(code)) || n.includes(norm(hy))) && !BOX_NG.some((w) => n.includes(norm(w))) && packsOk(n, packs);
  }).sort((a, b) => a.itemPrice - b.itemPrice);
  const kw = `ワンピースカード ${hy} BOX`;
  const res = { count: valid.length, images: imgsOf(valid, 10), link: linkOf(valid, kw), box: null };
  if (valid.length) {
    const pre = median(valid.slice(0, 3).map((i) => i.itemPrice));
    res.box = { pre, min: valid[0].itemPrice, count: valid.length, updatedAt: today,
      counts: { rakuten: valid.filter((i) => i.src === 'rakuten').length, yahoo: valid.filter((i) => i.src === 'yahoo').length } };
    const f = `data/history/BOX-${code}.csv`;
    if (!existsSync(f)) await writeFile(f, 'date,min,ref,count\n');
    const hist = await readFile(f, 'utf8');
    if (!hist.includes(`\n${today},`)) await appendFile(f, `${today},${valid[0].itemPrice},${pre},${valid.length}\n`);
  }
  return res;
}

async function main() {
  const { defaults, cards } = JSON.parse(await readFile('cards.json', 'utf8'));
  const index = JSON.parse(await readFile('sets/index.json', 'utf8'));
  await mkdir('data/history', { recursive: true });
  await mkdir('data/sets', { recursive: true });
  const targets = chooseSets(index);
  console.log(`今回の対象: ${targets.join(', ')}`);
  const spikesAll = [];
  let total = 0, failedAll = 0;

  for (const code of targets) {
    const meta = index.sets.find((s) => s.code === code);
    const list = cards.filter((c) => c.set === code);
    const file = `data/sets/${code}.json`;
    const prev = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
    let out = [];
    const failed = [];
    if (BOX_ONLY && prev) out = prev.cards; // BOXだけ更新するモード(カード価格は前回のまま)
    else for (const card of list) {
      try {
        const rec = await priceCard(card, defaults);
        out.push(rec);
        console.log(`[${code}] ${card.id}: ${rec.count}件(楽天${rec.counts?.rakuten ?? 0}/Yahoo${rec.counts?.yahoo ?? 0}) ref=${rec.refPrice ?? '-'}`);
      } catch (e) {
        if (/認証エラー/.test(e.message)) throw e; // 認証系は全体を止める
        failed.push(card.id); console.error(`[${code}] ${card.id}: ${e.message}`);
      }
      await sleep(DELAY_MS);
    }
    // BOXの画像・販売リンク・実売価格(プレ値)
    const images = { ...(prev?.images ?? {}) }, links = { ...(prev?.links ?? {}) };
    let box = prev?.box ?? null;
    try {
      const r = await priceBox(meta);
      if (r.images.length) images.BOX = r.images;
      links.BOX = r.link;
      if (r.box) box = r.box;
      console.log(`[${code}] BOX: ${r.count}件 プレ値=${r.box?.pre ?? '-'}`);
    } catch (e) { if (/認証エラー/.test(e.message)) throw e; console.error(`[${code}] BOX: ${e.message}`); }
    await sleep(DELAY_MS);

    await writeFile(file, JSON.stringify({ code, updatedAt: BOX_ONLY && prev ? prev.updatedAt : today, credit: 'Supported by Rakuten Developers / Web Services by Yahoo! JAPAN', cards: out, images, links, box }));
    spikesAll.push(...out.filter((c) => c.change != null && c.change >= SPIKE_PCT && c.count >= MIN_SAMPLES).map((c) => ({ ...c, set: code, offers: undefined, imgs: undefined })));
    total += list.length; failedAll += failed.length;
    console.log(`[${code}] 完了: ${out.length}件, 失敗${failed.length}件`);
  }
  spikesAll.sort((a, b) => b.change - a.change);
  if (!BOX_ONLY) await writeFile('data/spikes.json', JSON.stringify({ updatedAt: today, spikes: spikesAll }, null, 1));
  console.log(`全体: ${total}件, 急騰${spikesAll.length}件, 失敗${failedAll}件`);
  if (total && failedAll > total / 2) process.exit(1); // 半数超の失敗はジョブ失敗にする
}
main().catch((e) => { console.error(e.message); process.exit(1); });
