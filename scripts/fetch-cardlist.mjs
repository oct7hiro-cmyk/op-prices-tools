// 公式カードリスト(onepiece-cardgame.com)から全弾の収録カードを取得し data/raw/cardlists.json に保存する。Node 20+、依存なし。
// 対象: ブースター(5501xx)・エクストラブースター(5502xx)・プレミアムブースター(5503xx)・スタートデッキ(5500xx)・
//       限定商品収録カード(550801: プレミアムカードコレクションなど)・プロモーションカード(550901)
// 限定商品・プロモは入手方法(getInfo)も6番目に入れる(フルパラ版にプレミアムカードコレクションを使うため)
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = 'https://www.onepiece-cardgame.com/cardlist/';
const UA = { 'User-Agent': 'Mozilla/5.0 (op-prices-tools; +https://oct7hiro-cmyk.github.io/op-prices-tools/)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<br[^>]*>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();

async function get(url) {
  for (let i = 1; i <= 3; i++) {
    const r = await fetch(url, { headers: UA });
    if (r.ok) return r.text();
    console.error(`${r.status} ${url}`); await sleep(3000 * i);
  }
  throw new Error(`取得失敗 ${url}`);
}

const top = await get(BASE);
const sel = top.match(/<select[^>]*name="series"[^>]*>([\s\S]*?)<\/select>/)[1];
const series = [...sel.matchAll(/<option value="(\d+)"[^>]*>([\s\S]*?)<\/option>/g)]
  .map((m) => ({ id: m[1], name: strip(m[2]) })).filter((s) => /^550[0123]\d\d$|^5508\d\d$|^5509\d\d$/.test(s.id));

const out = { fetched: new Date().toISOString(), source: BASE, sets: {} };
for (const s of series) {
  const html = await get(`${BASE}?series=${s.id}`);
  const cards = [...html.matchAll(/<dl class="modalCol" id="([^"]+)">([\s\S]*?)<\/dl>/g)].map((m) => {
    const body = m[2];
    const info = [...(body.match(/<div class="infoCol">([\s\S]*?)<\/div>/)?.[1] ?? '').matchAll(/<span>([\s\S]*?)<\/span>/g)].map((x) => strip(x[1]));
    const name = strip(body.match(/<div class="cardName">([\s\S]*?)<\/div>/)?.[1] ?? '');
    const color = strip(body.match(/<div class="color"><h3>色<\/h3>([\s\S]*?)<\/div>/)?.[1] ?? '');
    const get = /^550[89]/.test(s.id) ? strip(body.match(/<div class="getInfo"><h3>[^<]*<\/h3>([\s\S]*?)<\/div>/)?.[1] ?? '').replace(/\s*カードリスト$/, '') : null;
    return get ? [m[1], info[1] ?? '', name, info[2] ?? '', color, get] : [m[1], info[1] ?? '', name, info[2] ?? '', color];
  });
  out.sets[s.id] = { name: s.name, cards };
  console.log(`${s.id} ${s.name}: ${cards.length}枚`);
  await sleep(1500);
}
await mkdir('data/raw', { recursive: true });
await writeFile('data/raw/cardlists.json', JSON.stringify(out));
console.log(`完了: ${series.length}弾`);
