// 遊々亭(yuyu-tei.jp)のシングル販売ページから、弾ごとの全カード(区分・名前・販売価格・在庫・画像)を取得する。
//   data/yy/<CODE>.json      … その日の一覧
//   data/yy/hist/<CODE>.json … カードごとの価格の履歴(直近90日分)
// 1日1回・1弾1リクエスト(間隔2秒)。Node 20+、依存なし。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SITE_REFERER = process.env.SITE_REFERER ?? 'https://oct7hiro-cmyk.github.io/op-prices-tools/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// 一覧ページのHTMLを解析する(ブラウザでもNodeでも動く素の文字列処理)
export function parseList(html) {
  const out = [];
  const re = /<h3[^>]*>\s*<span[^>]*>([^<]*)<\/span>\s*Card List<\/h3>|<div\s+class="card-product[^"]*">([\s\S]*?)カートへ/g;
  let sec = null, m;
  while ((m = re.exec(html))) {
    if (m[1] != null) { sec = m[1].trim(); continue; }
    const b = m[2];
    const link = b.match(/href="https:\/\/yuyu-tei\.jp\/sell\/opc\/card\/([^/"]+)\/(\d+)"/);
    const alt = b.match(/<img\s+src="([^"]*)"\s+alt="([^"]*)"\s+class="card/);
    const no = b.match(/<span\s+class="d-block border[^"]*">\s*([^<]*?)\s*<\/span>/) ?? (alt && alt[2].match(/^(\S+)/));
    const h4 = b.match(/<h4[^>]*>([\s\S]*?)<\/h4>/);
    const price = b.match(/<strong[^>]*>\s*([\d,]+)\s*円/);
    const stock = b.match(/在庫\s*:\s*([^<]*?)\s*<\/label>/);
    if (!link || !h4) continue;
    const full = decode(h4[1].trim()).replace(/）/g, ')').replace(/（/g, '(');
    const tags = [...full.matchAll(/\(([^()]*)\)/g)].map((x) => x[1]);
    const base = full.replace(/(\([^()]*\))+$/, '').trim();
    const img = alt && !/noimage/.test(alt[1]) ? `${link[1]}/${link[2]}` : null;
    out.push({ cid: +link[2], ver: link[1], sec, no: no ? no[1].trim() : '', name: base, full, tags,
      p: price ? +price[1].replace(/,/g, '') : null, stock: stock ? stock[1].replace(/\s+/g, ' ').trim() : '', img });
  }
  return out;
}

async function main() {
  const index = JSON.parse(await readFile('sets/index.json', 'utf8'));
  await mkdir('data/yy/hist', { recursive: true });
  let ok = 0;
  for (const s of index.sets) {
    const url = `https://yuyu-tei.jp/sell/opc/s/${s.code.toLowerCase()}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': `op-prices-tools/1.0 (+${SITE_REFERER})`, 'Accept-Language': 'ja' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cards = parseList(await res.text()).filter((c) => c.sec && c.sec !== '-');
      if (cards.length < 20) throw new Error(`カードが少なすぎます(${cards.length}件)。ページの形式が変わった可能性`);
      await writeFile(`data/yy/${s.code}.json`, JSON.stringify({ code: s.code, updatedAt: today, source: '遊々亭', url, cards }));
      const hf = `data/yy/hist/${s.code}.json`;
      const hist = existsSync(hf) ? JSON.parse(await readFile(hf, 'utf8')) : {};
      for (const c of cards) {
        if (c.p == null) continue;
        const h = (hist[c.cid] ??= []).filter((x) => x[0] !== today);
        h.push([today, c.p]);
        hist[c.cid] = h.slice(-90);
      }
      await writeFile(hf, JSON.stringify(hist));
      ok++;
      console.log(`[${s.code}] ${cards.length}件`);
    } catch (e) { console.error(`[${s.code}] ${e.message}`); }
    await sleep(2000);
  }
  console.log(`遊々亭: ${ok}/${index.sets.length}弾`);
  if (!ok) process.exit(1);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
