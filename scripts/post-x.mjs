// 毎朝の値上がり・値下がりランキングを X(旧Twitter)に投稿する。Node 20+、依存なし。
// 環境変数 X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET(X Developer Portal のアプリのキー)が無ければ何もしない。
// DRY_RUN=1 なら投稿せずに本文だけ表示する
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
const DRY = /^(1|true)$/.test(process.env.DRY_RUN ?? '');
const SITE = 'https://oct7hiro-cmyk.github.io/op-prices-tools/ranking/';
if (!DRY && !(X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_SECRET)) { console.log('Xのキーが未設定なので投稿しません'); process.exit(0); }

const r = JSON.parse(await readFile('data/ranking.json', 'utf8'));
const yen = (v) => '¥' + Math.round(v).toLocaleString('ja-JP');
// 超高額とパラレル/SPの値上がり・値下がり(金額順)をまとめて、変動額の大きい順
const pool = (k) => ['top', 'par'].flatMap((d) => r.divisions?.[d]?.[k] ?? []);
const ups = pool('up').sort((a, b) => b.diff - a.diff);
const downs = pool('down').sort((a, b) => a.diff - b.diff);
if (!ups.length && !downs.length) { console.log('値上がり・値下がりが無いので投稿しません'); process.exit(0); }

// X の文字数: 日本語などは2、英数字は1として280まで。URLは23
const weight = (s) => [...s.replace(/https?:\/\/\S+/g, 'x'.repeat(23))].reduce((t, c) => t + (c.codePointAt(0) <= 0x10ff ? 1 : 2), 0);
const md = r.updatedAt ? `${+r.updatedAt.slice(5, 7)}/${+r.updatedAt.slice(8, 10)}` : '';
const head = `ワンピースカード相場 ${md}`;
const tail = `#ワンピースカード #ワンピカード\n${SITE}`;
const line = (x, up) => `${up ? '▲' : '▼'}${x.n}(${x.k}) ${yen(x.prev)}→${yen(x.p)}`;
let body = [head];
// 値上がり3つ・値下がり2つを優先し、入りきれば値上がりを足す。表示は値上がり→値下がりの順
const cand = [...ups.slice(0, 3).map((x) => line(x, true)), ...downs.slice(0, 2).map((x) => line(x, false)), ...ups.slice(3, 5).map((x) => line(x, true))];
const picked = [];
for (const l of cand) { const next = [head, ...picked, l, tail].join('\n'); if (weight(next) <= 280) picked.push(l); }
picked.sort((a, b) => (a[0] === '▲' ? 0 : 1) - (b[0] === '▲' ? 0 : 1));
body.push(...picked);
const text = [...body, tail].join('\n');
console.log(text, `\n(${weight(text)}/280)`);
if (DRY || body.length < 2) process.exit(0);

// OAuth 1.0a(ユーザーのアクセストークンで投稿)
const url = 'https://api.x.com/2/tweets';
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const oauth = { oauth_consumer_key: X_API_KEY, oauth_nonce: crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: X_ACCESS_TOKEN, oauth_version: '1.0' };
const params = Object.keys(oauth).sort().map((k) => `${enc(k)}=${enc(oauth[k])}`).join('&');
const base = ['POST', enc(url), enc(params)].join('&');
oauth.oauth_signature = crypto.createHmac('sha1', `${enc(X_API_SECRET)}&${enc(X_ACCESS_SECRET)}`).update(base).digest('base64');
const auth = 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
const res = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
const out = await res.text();
if (!res.ok) { console.error(`X への投稿に失敗(${res.status}): ${out.slice(0, 300)}`); process.exit(0); } // 投稿の失敗で毎日の更新は止めない
console.log('投稿しました', out.slice(0, 200));
