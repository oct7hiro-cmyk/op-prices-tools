// 公式カードリスト(data/raw/cardlists.json)と弾ごとの調査結果(sets/research/*.json)から
//   sets/index.json        … 弾の一覧(新しい順)
//   sets/<CODE>.json       … ガチャ画面が読む弾ごとの設定(カード・カテゴリ・封入率)
//   cards.json             … 価格監視の対象(楽天/Yahoo!の検索条件)
// を生成する。Node 20+、依存なし。研究ファイルを直したら `node scripts/build-sets.mjs` を実行する。
import { readFile, writeFile, readdir } from 'node:fs/promises';

const raw = JSON.parse(await readFile('data/raw/cardlists.json', 'utf8'));
const files = (await readdir('sets/research')).filter((f) => f.endsWith('.json'));

const LABEL = { R: 'R', SR: 'SR', SEC: 'SEC', PAR: 'パラレル', SECP: 'SECパラレル', LPAR: 'リーダーパラレル', SP: 'SP',
  CP: 'コミパラ', LSP: 'リーダースーパーパラレル', TOP: '超レア', TR: 'トレジャーレア', FOIL: 'フォイル', FA: 'フルアート', OTHER: '特別パラレル' };
// 個別の呼び名(分かっているもの)
const NAME_OVERRIDE = { 'OP17-118_p2': '海賊団SP', 'EB04-061_p3': '海賊団SP',
  // 3周年記念SP(金・銀)。海賊団SPと同じ最上位の扱い
  'OP05-119_p7': '周年記念SP(金)', 'OP05-119_p6': '周年記念SP(銀)', 'OP09-093_p4': '周年記念SP(金)', 'OP09-093_p5': '周年記念SP(銀)',
  'OP09-004_p5': '周年記念SP(金)', 'OP09-004_p6': '周年記念SP(銀)', 'OP09-051_p5': '周年記念SP(金)', 'OP09-051_p6': '周年記念SP(銀)',
  'OP13-118_p3': 'レッドSP', 'OP13-119_p3': 'レッドSP', 'OP13-120_p3': 'レッドSP' };
// 周年記念SPなど、別の弾のカード番号で収録される最上位カードは必ず最上位(TOP)に入れる
const FORCE_TOP = new Set(Object.keys(NAME_OVERRIDE));
// 価格は監視せず、画像だけ探すカテゴリ(低額で種類が多い)
const IMG_ONLY = new Set(['FOIL']);
// コミパラ(スーパーパラレル)を表す語。「スーパー」だけだとSR(スーパーレア)の出品に当たってしまう
const SUPER = ['スーパーパラ', 'スーパー・パラ', 'スーパー パラ'];
const NG_VARIANT = ['パラ', 'SP', 'スペシャル', ...SUPER, 'コミ', '漫画', 'サイン', '★']; // スペシャル=SPカード(PRBの再録SPなど)
// 記念セット・海外版など、同じカード番号でも別物の出品を除く
const NG_SPECIAL = ['ANNIVERSARY', '周年', 'CHINA', '中国', '英語', '海外', '簡体', '繁体'];
// コミパラ・通常パラレルの価格に混ざりやすい、別の絵柄の上位版(レッドSP・海賊団SP・描き下ろしなど)
const NG_OTHER_ART = ['レッド', '海賊団', '書き下ろし', '描き下ろし', '周年'];
// 通常のSPに混ざりやすい、周年記念SP(金・銀背景)の出品
const NG_GOLD = ['金背景', '銀背景', '金枠', '銀枠', 'ゴールド', 'シルバー'];

// どの弾のカードでも番号から名前を引けるように
const NAME_ANY = {};
for (const st of Object.values(raw.sets)) for (const c of st.cards) NAME_ANY[c[0]] ??= c[2];
const sets = [];
const watch = [];
for (const f of files) {
  const r = JSON.parse(await readFile(`sets/research/${f}`, 'utf8'));
  const src = raw.sets[r.series];
  if (!src) { console.error(`カードリストなし: ${r.code}`); continue; }
  const isPRB = r.code.startsWith('PRB');
  const base = { ...(r.base ?? {}) };
  if (!isPRB) base.R = [7, 8]; // OP/EB は 1BOX R 7〜8枚(複数の販売サイトの集計)
  // 発売前で公式カードリストにまだ無いパラレル・SPなど(調査ファイルの extra: [番号, レアリティ])。名前は元のカード番号から引く
  const offIds = new Set(src.cards.map((c) => c[0]));
  const extra = (r.extra ?? []).filter(([id]) => !offIds.has(id)).map(([id, rar]) => [id, rar, NAME_ANY[id.replace(/_[pr]\d+$/, '')] ?? id]);
  const cards = [];
  for (const [id, rar, name] of [...src.cards, ...extra]) {
    let cat = null;
    if (id.includes('_p')) cat = FORCE_TOP.has(id) ? 'TOP' : (r.variants[id] ?? 'OTHER');
    else if (r.cp_r_ids?.includes(id)) cat = 'CP'; // プレミアムブースターのコミパラ(_r番号で掲載)
    else if (['R', 'SR', 'SEC'].includes(rar)) cat = rar;
    if (!cat) continue;
    cards.push([id, cat, name, rar, NAME_OVERRIDE[id] ?? r.names?.[id] ?? null]);
  }
  const cats = {};
  for (const [k, v] of Object.entries(r.categories ?? {})) {
    const lambda = typeof v === 'object' ? v.lambda : v;
    if (lambda > 0 && cards.some((c) => c[1] === k)) cats[k] = { lambda, note: (typeof v === 'object' && v.note) || '' };
  }
  // 確定枠: OP/EBは1BOXに「SEC」か「R/SRパラレル」のどちらか1枚が必ず入る(SECは2枚出ない・SECとパラレルは同時に出ない)。
  // 比率は調査の期待枚数λの比。リーダーパラレル・SP以上などは確定枠とは別に追加で出る
  let hit = null;
  if (!isPRB) {
    // SECパラレルもSECの一種として確定枠に含める(SECとSECパラレルが同時に出ないように)
    const sec = cats.SEC?.lambda ?? (Array.isArray(base.SEC) ? (base.SEC[0] + base.SEC[1]) / 2 : 0);
    const par = cats.PAR?.lambda ?? 0, secp = cats.SECP?.lambda ?? 0;
    if (sec > 0 && par > 0) {
      const t = sec + par + secp, r3 = (x) => Math.round((x / t) * 1000) / 1000;
      hit = { SEC: r3(sec), ...(secp ? { SECP: r3(secp) } : {}) };
      hit.PAR = Math.round((1 - hit.SEC - (hit.SECP ?? 0)) * 1000) / 1000;
      delete cats.SEC; delete cats.PAR; delete cats.SECP; delete base.SEC;
    }
  }
  const conf = { code: r.code, series: r.series, name: r.name, title: src.name, release: r.release ?? null,
    msrp: r.msrp_box ?? null, packs: r.packs ?? 24, perPack: r.cards_per_pack ?? 6, market: r.box_market ?? null,
    confidence: r.confidence ?? null, base, hit, cats, labels: { ...LABEL, ...(r.labels ?? {}) }, cards,
    // 公式カードリストの画像を使う弾: 公式に載っている番号(画面で公式画像を先に試す)
    ...(r.officialImg ? { offImg: [...offIds] } : {}),
    // 発売前の仮の価格(予想販売価格)。出品の価格が取れるまで使う
    ...(r.provisional ? { prov: r.provisional } : {}), sources: r.sources ?? [], notes: r.notes ?? '' };
  await writeFile(`sets/${r.code}.json`, JSON.stringify(conf));
  sets.push({ code: r.code, name: r.name, title: src.name, release: conf.release, msrp: conf.msrp, market: conf.market, confidence: conf.confidence });

  // 価格監視: ベース(R/SR/SEC)と、λ>0のカテゴリに属するバリアント
  const byCode = {};
  // カード番号: _p(パラレル)・_r(プレミアムブースターの再録)を除いた番号
  cards.forEach((c) => { const code = c[0].replace(/_[pr]\d+$/, ''); (byCode[code] ??= []).push(c); });
  for (const [id, cat, name] of cards) {
    const code = id.replace(/_[pr]\d+$/, '');
    // 封入率の設定が無い区分(OP01/OP02の特別パラレルなど)は価格を監視せず、全カード一覧に出す画像だけ探す
    if (!IMG_ONLY.has(cat) && !['R', 'SR', 'SEC'].includes(cat) && !cats[cat] && !hit?.[cat]) {
      watch.push({ set: r.code, id, name: `${name}(${LABEL[cat] ?? cat})`, code, keyword: `ワンピースカード ${code} パラレル`, imgOnly: true, must: ['パラ'],
        mustNot: [...SUPER, 'コミ', '漫画', 'SP', ...NG_SPECIAL, ...NG_OTHER_ART] });
      continue;
    }
    const siblings = byCode[code].length > 1;
    const lbl = NAME_OVERRIDE[id] ?? r.names?.[id] ?? null;
    const hasFA = isPRB && byCode[code].some((c) => c[1] === 'FA');
    const w = { set: r.code, id, name: `${name}(${lbl ?? LABEL[cat] ?? cat})`, code, ...(['TOP', 'CP', 'LSP', 'TR'].includes(cat) ? { hi: true } : {}) };
    if (IMG_ONLY.has(cat)) Object.assign(w, { keyword: `ワンピースカード ${code}`, imgOnly: true, mustNot: [...NG_VARIANT, ...NG_SPECIAL] });
    else if (r.search?.[id]) Object.assign(w, r.search[id]); // 調査ファイルで個別に指定した検索条件(描き下ろしパラレルなど)
    else if (isPRB && /_r\d+$/.test(id) && cat === 'CP') // プレミアムブースターのコミパラ: 元の弾のコミパラと区別するためPRBの出品だけ
      Object.assign(w, { keyword: `ワンピースカード ${code} ${r.code}`, mustAny: [...SUPER, 'コミ', '漫画'], mustAny2: ['PRB', 'BEST', 'ベスト'], mustNot: NG_OTHER_ART, minPrice: 5000 });
    else if (isPRB && /_r\d+$/.test(id)) // 再録(R/SR/SEC): 元の弾の同じ番号と区別するため、PRBの出品だけを価格に使う
      Object.assign(w, { keyword: `ワンピースカード ${code} ${r.code}`, mustAny: ['PRB', 'BEST', 'ベスト'], mustNot: [...NG_VARIANT, ...NG_SPECIAL], trimHigh: 4 });
    else if (['R', 'SR', 'SEC'].includes(cat)) Object.assign(w, { keyword: `ワンピースカード ${code}`, mustNot: [...NG_VARIANT, ...NG_SPECIAL], trimHigh: 4 });
    else if (cat === 'SP') Object.assign(w, { keyword: `ワンピースカード ${code} SP`, mustAny: ['SP', 'スペシャル'], mustNot: [...NG_OTHER_ART, ...NG_GOLD], minPrice: 1000 });
    else if (cat === 'CP' || cat === 'LSP') Object.assign(w, { keyword: `ワンピースカード ${code} パラレル`, mustAny: [...SUPER, 'コミ', '漫画'], mustNot: cat === 'CP' ? [...NG_OTHER_ART, '金', '銀'] : NG_OTHER_ART, minPrice: 5000 });
    else if (cat === 'FA') Object.assign(w, { keyword: `ワンピースカード ${code} フルアート`, mustAny: ['フルアート', 'FA'], mustNot: [...SUPER, 'コミ', '漫画', 'SP', ...NG_SPECIAL] });
    else if (cat === 'TOP') {
      const lb = NAME_OVERRIDE[id] ?? '';
      if (/金/.test(lb)) Object.assign(w, { keyword: `ワンピースカード ${code} 金`, mustAny: ['金'], mustNot: ['銀'], minPrice: 20000 });
      else if (/銀/.test(lb)) Object.assign(w, { keyword: `ワンピースカード ${code} 銀`, mustAny: ['銀'], mustNot: ['金'], minPrice: 20000 });
      else if (/レッド/.test(lb)) Object.assign(w, { keyword: `ワンピースカード ${code} レッド`, mustAny: ['レッド', '赤'], minPrice: 50000 });
      else if (/海賊団/.test(lb)) Object.assign(w, { keyword: `ワンピースカード ${code} 海賊団`, mustAny: ['海賊団'], minPrice: 50000 });
      else Object.assign(w, { keyword: `ワンピースカード ${code}`, mustAny: [...SUPER, 'コミ', '漫画', '海賊団', '金', '赤', 'サイン', '周年'], minPrice: 30000 });
    }
    else if (cat === 'TR') Object.assign(w, { keyword: `ワンピースカード ${code} TR`, mustAny: ['TR', 'トレジャー'], minPrice: 300 });
    else Object.assign(w, { keyword: `ワンピースカード ${code} パラレル`, must: ['パラ'], mustNot: [...SUPER, 'コミ', '漫画', 'SP', ...NG_SPECIAL, ...NG_OTHER_ART, ...(hasFA ? ['フルアート'] : [])],
      ...(siblings && cat === 'OTHER' ? { minPrice: 3000 } : {}) });
    // 他の弾の番号で収録されるSP・リーダーパラレル(再録)は、元の弾のものと区別するため弾コードか弾名を含む出品だけ(調査ファイルの spSetTag)
    if (['SP', 'LPAR'].includes(cat) && r.spSetTag && !code.startsWith(r.code)) w.mustAny2 = r.spSetTag;
    // プレミアムブースターは再録カードの出品が少ないので、見つからなければ同じ番号のカードの画像を使う
    if (isPRB && !w.imgOnly) Object.assign(w, { imgKeyword: `ワンピースカード ${code}`, imgNg: /_r\d+$/.test(id) || ['R', 'SR', 'SEC'].includes(cat) ? [...NG_VARIANT, ...NG_SPECIAL] : NG_SPECIAL });
    watch.push(w);
  }
}
sets.sort((a, b) => String(b.release).localeCompare(String(a.release)));
await writeFile('sets/index.json', JSON.stringify({ updated: new Date().toISOString().slice(0, 10), sets }, null, 1));
const cardsJson = JSON.parse(await readFile('cards.json', 'utf8'));
const EXTRA_NG = ['キズ', '英語版', '中国語', '簡体', '繁体'];
const defaults = { ...cardsJson.defaults, ng: [...new Set([...(cardsJson.defaults.ng ?? []), ...EXTRA_NG])] };
await writeFile('cards.json', JSON.stringify({ defaults, cards: watch }, null, 1) + '\n');
const per = {}; watch.forEach((w) => { per[w.set] = (per[w.set] ?? 0) + 1; });
console.log(`弾 ${sets.length} / 監視カード ${watch.length}`, per);
