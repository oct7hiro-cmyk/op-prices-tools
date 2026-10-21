// 検索エンジン向けの静的ページを作る(build-ranking の後に実行)。Node 20+、依存なし。
//   index.html の <!--HEAD-->〜<!--/HEAD-->(タイトル・説明文)、<!--PAGE-->〜<!--/PAGE-->(表示する画面)、
//   <!--ABOUT-->〜<!--/ABOUT-->(ページ下部の説明・高額カード表)を差し替えて
//   /<弾コード小文字>/index.html と /ranking/index.html を書き出し、ルートの index.html と sitemap.xml も更新する。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = 'https://oct7hiro-cmyk.github.io/op-prices-tools/';
const SITE = 'ワンピースカード 開封シミュレーター';
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
const yen = (v) => '¥' + Math.round(v).toLocaleString('ja-JP');
const LBL = { R: 'R', SR: 'SR', SEC: 'SEC', PAR: 'パラレル', SECP: 'SECパラレル', LPAR: 'リーダーパラレル', SP: 'SP', CP: 'コミパラ', LSP: 'リーダースーパーパラレル', TOP: '超レア', TR: 'トレジャーレア', FOIL: 'フォイル', FA: 'フルアート', OTHER: '特別パラレル' };

const tpl = await readFile('index.html', 'utf8');
const index = JSON.parse(await readFile('sets/index.json', 'utf8'));
const summary = existsSync('data/sets/index.json') ? JSON.parse(await readFile('data/sets/index.json', 'utf8')).sets : {};

function region(html, name, body) {
  const re = new RegExp(`<!--${name}-->[\\s\\S]*?<!--/${name}-->`);
  if (!re.test(html)) throw new Error(`index.html に <!--${name}--> がありません`);
  return html.replace(re, () => `<!--${name}-->${body}<!--/${name}-->`);
}
function head({ title, desc, url, sub }) {
  return `
${sub ? '<base href="/op-prices-tools/">\n' : ''}<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
`;
}
const setLinks = () => '<ul class="lk">' + index.sets.map((s) => `<li><a href="${s.code.toLowerCase()}/">${esc(s.code)} ${esc(s.name)}</a></li>`).join('') + '</ul>';

// 弾ごとの高額カード(同じ出品に当たった別バリアントは1件に)
async function topCards(code, n = 10) {
  const f = `data/sets/${code}.json`;
  if (!existsSync(f)) return [];
  const data = JSON.parse(await readFile(f, 'utf8'));
  const cfg = JSON.parse(await readFile(`sets/${code}.json`, 'utf8'));
  const meta = Object.fromEntries(cfg.cards.map((c) => [c[0], c]));
  const seen = new Set(), out = [];
  for (const c of [...data.cards].filter((c) => c.refPrice && !c.est && meta[c.id]).sort((a, b) => b.refPrice - a.refPrice)) {
    const key = c.source === 'manual' || !c.offers?.length ? c.id : `${c.refPrice}|${c.offers[0].u}`;
    if (seen.has(key)) continue; seen.add(key);
    const m = meta[c.id];
    out.push({ id: c.id.replace(/_[pr]\d+$/, ''), n: m[2], k: m[4] || LBL[m[1]] || m[1], p: c.refPrice });
    if (out.length >= n) break;
  }
  return out;
}

const pages = [];
for (const s of index.sets) {
  const cfg = JSON.parse(await readFile(`sets/${s.code}.json`, 'utf8'));
  const sm = summary[s.code] ?? {};
  const top = await topCards(s.code);
  const url = `${BASE}${s.code.toLowerCase()}/`;
  const hit = top.slice(0, 3).map((c) => `${c.n}(${c.k})${yen(c.p)}`).join('、');
  const title = `${s.code} ${s.name} 開封シミュレーター|BOX開封ガチャ・期待値・当たりカード相場`;
  const desc = `ワンピースカード ${s.code}「${s.name}」のBOX開封をシミュレーション。` +
    (sm.ev ? `1BOXの期待値${yen(sm.ev)}` : '') + (sm.pre ? `、プレ値${yen(sm.pre)}` : '') +
    (hit ? `。当たりカード:${hit}など。` : '。') + '楽天・Yahoo!の販売価格から毎日更新。';
  const cats = Object.entries(cfg.cats ?? {}).map(([k, c]) => `<li>${esc(LBL[k] ?? k)}:1BOXに約${c.lambda >= 1 ? c.lambda.toFixed(1) + '枚' : '1/' + Math.round(1 / c.lambda) + '枚'}</li>`).join('');
  const about = `<section class="about" id="about">
<h2>${esc(s.code)} ${esc(s.name)} 開封シミュレーター</h2>
<p>ワンピースカードゲーム「${esc(cfg.title || s.name)}」${cfg.release ? `(${esc(cfg.release)}発売)` : ''}のBOX開封をシミュレーションできます。1BOX(${cfg.packs}パック)を開けたときに出るR以上のカードを、封入率の目安にもとづいて抽選し、ショップの販売価格の合計を定価・プレ値と比べます。</p>
<table><tbody>
<tr><th>定価(1BOX)</th><td class="r">${cfg.msrp ? yen(cfg.msrp) : '-'}</td></tr>
<tr><th>プレ値(未開封BOXの販売価格)</th><td class="r">${sm.pre ? yen(sm.pre) : '-'}</td></tr>
<tr><th>1BOXの期待値(R以上の販売価格)</th><td class="r">${sm.ev ? yen(sm.ev) : '-'}</td></tr>
</tbody></table>
${top.length ? `<h3>${esc(s.code)}の高額カード TOP${top.length}</h3><table><tbody>${top.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.n)}(${esc(c.k)})<br><small>${esc(c.id)}</small></td><td class="r">${yen(c.p)}</td></tr>`).join('')}</tbody></table>` : ''}
${cats ? `<h3>封入率の目安</h3><ul>${cats}</ul>` : ''}
<p>価格は${esc(sm.updatedAt || today)}時点のショップ販売価格(楽天・Yahoo!ショッピング)です。封入率は販売・買取サイトの開封調査にもとづく推定値で、公式発表ではありません。当サイトは非公式のファンサイトです。</p>
<h3>ほかの弾の開封シミュレーター</h3>${setLinks()}
<p><a href="ranking/">ワンピースカード 相場ランキング(高額カードTOP50・今週の値上がり)</a></p>
</section>`;
  let html = region(tpl, 'HEAD', head({ title, desc, url, sub: true }));
  html = region(html, 'PAGE', `<script>window.PAGE={set:'${s.code}'}</script>`);
  html = region(html, 'ABOUT', about);
  await mkdir(s.code.toLowerCase(), { recursive: true });
  await writeFile(`${s.code.toLowerCase()}/index.html`, html);
  pages.push(url);
}

// ランキング
{
  const url = `${BASE}ranking/`;
  const rk = existsSync('data/ranking.json') ? JSON.parse(await readFile('data/ranking.json', 'utf8')) : null;
  const sec = (div, name) => {
    const list = rk?.divisions?.[div]?.high?.slice(0, 10) ?? [];
    return list.length ? `<h3>${name} 高額TOP10</h3><table><tbody>${list.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.n)}(${esc(r.k)})<br><small>${esc(r.set)} ${esc(r.id.replace(/_[pr]\d+$/, ''))}</small></td><td class="r">${yen(r.p)}</td></tr>`).join('')}</tbody></table>` : '';
  };
  const title = 'ワンピースカード 相場ランキング|高額カードTOP50・今週の値上がり';
  const desc = 'ワンピースカードゲームの相場ランキング。SP・コミパラなどの超高額カード、パラレル、通常カード(R・SR・SEC)の高額TOP50と今週値上がりしたカードを、楽天・Yahoo!の販売価格から毎日更新。';
  const about = `<section class="about" id="about"><h2>ワンピースカード 相場ランキング</h2>
<p>全弾のカードの販売価格(楽天・Yahoo!ショッピング、安い順3件の中央値)を毎朝集計しています。${rk ? esc(rk.updatedAt) + '時点。' : ''}</p>
${sec('top', '超高額')}${sec('par', 'パラレル')}${sec('base', '通常カード')}
<h3>弾別の開封シミュレーター</h3>${setLinks()}</section>`;
  let html = region(tpl, 'HEAD', head({ title, desc, url, sub: true }));
  html = region(html, 'PAGE', `<script>window.PAGE={view:'rank'}</script>`);
  html = region(html, 'ABOUT', about);
  await mkdir('ranking', { recursive: true });
  await writeFile('ranking/index.html', html);
  pages.push(url);
}

// トップ(ルートの index.html は説明と弾一覧のリンクだけ更新)
{
  const about = `<section class="about" id="about"><h2>ワンピースカード 開封シミュレーターとは</h2>
<p>ワンピースカードゲームのブースターパック・エクストラブースター・プレミアムブースターのBOX開封を、無料でシミュレーションできるサイトです。出たカードの合計金額を、楽天・Yahoo!ショッピングの販売価格で計算し、定価やプレ値(未開封BOXの販売価格)と比べて「当たりBOXか」を判定します。1BOXの期待値、当たりカードの相場、開封履歴も見られます。</p>
<h3>弾別の開封シミュレーター</h3>${setLinks()}
<p><a href="ranking/">相場ランキング(高額カードTOP50・今週の値上がり)</a></p></section>`;
  const html = region(tpl, 'ABOUT', about);
  if (html !== tpl) await writeFile('index.html', html);
  pages.unshift(BASE);
}

await writeFile('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((u) => `<url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`);
console.log(`静的ページ ${pages.length}件 / sitemap.xml`);
