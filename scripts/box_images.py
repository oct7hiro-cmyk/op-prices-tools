"""BOXの画像を作る(fetch-prices の後に実行。依存: Pillow)。

楽天・Yahoo!のBOX出品画像(data/sets/<CODE>.json の images.BOX)から白い背景を透明にして切り抜き、
宙に浮かせて表示できる img/box/<code>.webp を作る。
  1) 画像の外周から、白に近い色の部分をたどって透明にする
  2) 残った部分のうち一番大きなかたまり(=BOX本体)だけを残し、周りの文字の飾りなどは消す
  3) BOXらしい形か(外枠いっぱいに詰まった形・縦横比が普通・画像の端に接していない)で採点し、いちばん良い候補を使う。
     どれも基準に届かなければ前回の画像のまま(初回なら作らない=画面ではCSSで描いたBOXを表示)
"""
import io, json, os, sys, urllib.request
from collections import deque
from PIL import Image, ImageDraw

OUT = 'img/box'


def cutout(raw):
    # 普通の白背景で切り抜き、箱が白っぽくて形が欠けたら(詰まり具合が低い)、より白いところだけを背景として切り直す
    r = cutout1(raw, 228, 22)
    if r and r['fill'] < 0.86:
        r2 = cutout1(raw, 248, 10)
        if r2 and r2['fill'] > r['fill']:
            r2['score'] = r2['fill'] + min(r2['area'], 0.6) * 0.3 if r2['fill'] > 0.72 and r2['area'] > 0.18 and 0.5 < r2['ar'] < 2.2 and r2['edge'] < 0.02 else 0
            return r2
    return r


def cutout1(raw, th, chroma):
    im = Image.open(io.BytesIO(raw)).convert('RGBA')
    im.thumbnail((600, 600))
    w, h = im.size
    px = im.load()
    N = w * h

    def white(x, y):
        r, g, b, a = px[x, y]
        return r > th and g > th and b > th and max(r, g, b) - min(r, g, b) < chroma

    bg = bytearray(N)
    st = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] + [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
    while st:
        x, y = st.pop()
        i = y * w + x
        if bg[i] or not white(x, y):
            continue
        bg[i] = 1
        if x > 0: st.append((x - 1, y))
        if x < w - 1: st.append((x + 1, y))
        if y > 0: st.append((x, y - 1))
        if y < h - 1: st.append((x, y + 1))
    # 一番大きなかたまり
    lab = [0] * N
    best, best_n, cur = 0, 0, 0
    for s in range(N):
        if bg[s] or lab[s]:
            continue
        cur += 1
        n = 0
        q = [s]
        lab[s] = cur
        while q:
            i = q.pop()
            n += 1
            x, y = i % w, i // w
            for j in ((i - 1) if x > 0 else -1, (i + 1) if x < w - 1 else -1, (i - w) if y > 0 else -1, (i + w) if y < h - 1 else -1):
                if j >= 0 and not bg[j] and not lab[j]:
                    lab[j] = cur
                    q.append(j)
        if n > best_n:
            best_n, best = n, cur
    if not best:
        return None
    x0, y0, x1, y1, edge = w, h, 0, 0, 0
    rows = {}
    for i in range(N):
        if lab[i] != best:
            continue
        x, y = i % w, i // w
        x0, y0, x1, y1 = min(x0, x), min(y0, y), max(x1, x), max(y1, y)
        r = rows.get(y)
        rows[y] = (min(r[0], x), max(r[1], x)) if r else (x, x)
        if x in (0, w - 1) or y in (0, h - 1):
            edge += 1
    # 箱は凸な形なので、かたまりの凸包の内側はすべて残す(白っぽい箱の面が背景と一緒に消えるのを防ぐ)
    pts = sorted(set([(r[0], y) for y, r in rows.items()] + [(r[1], y) for y, r in rows.items()]))
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p_ in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p_) <= 0: lo.pop()
        lo.append(p_)
    for p_ in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p_) <= 0: up.pop()
        up.append(p_)
    hull = lo[:-1] + up[:-1]
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).polygon(hull, fill=255)
    im.putalpha(mask)
    best_n = sum(1 for v in mask.getdata() if v)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    fill, area, ar, edge_r = best_n / (bw * bh), best_n / N, bw / bh, edge / (2 * (w + h))
    # 箱は外枠にほぼ詰まった形。端に接していたら背景つきの写真、面積が小さすぎたら別物
    ok = fill > 0.72 and area > 0.18 and 0.5 < ar < 2.2 and edge_r < 0.02
    score = fill + min(area, 0.6) * 0.3 if ok else 0
    out = io.BytesIO()
    im.crop((x0, y0, x1 + 1, y1 + 1)).save(out, 'WEBP', quality=86)
    return {'out': out.getvalue(), 'score': score, 'fill': round(fill, 2), 'area': round(area, 2), 'ar': round(ar, 2), 'edge': round(edge_r, 3)}


def main():
    index = json.load(open('sets/index.json', encoding='utf8'))
    os.makedirs(OUT, exist_ok=True)
    mf = f'{OUT}/index.json'
    manifest = json.load(open(mf, encoding='utf8')) if os.path.exists(mf) else {}
    made = 0
    for s in index['sets']:
        code = s['code']
        f = f'data/sets/{code}.json'
        if not os.path.exists(f):
            continue
        data = json.load(open(f, encoding='utf8'))
        if manifest.get(code, {}).get('fixed'):  # 手動で用意した画像はそのまま使う
            print(f'[{code}] 固定の画像を使用')
            continue
        best = None
        for u in (data.get('images', {}).get('BOX') or [])[:10]:
            try:
                req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0 (op-prices-tools box image)'})
                r = cutout(urllib.request.urlopen(req, timeout=20).read())
                if r and (not best or r['score'] > best['score']):
                    best = {**r, 'src': u}
            except Exception as e:  # noqa
                print(f'[{code}] {u}: {e}', file=sys.stderr)
        info = (f"score={best['score']:.2f} fill={best['fill']} area={best['area']} ar={best['ar']} edge={best['edge']}" if best else '候補なし')
        if best and best['score'] > 0:
            file = f'{OUT}/{code.lower()}.webp'
            open(file, 'wb').write(best['out'])
            manifest[code] = {'file': file, 'src': best['src'], 'score': round(best['score'], 2), 'updatedAt': data.get('updatedAt')}
            made += 1
            print(f'[{code}] 採用 {info}')
        else:
            print(f"[{code}] 不採用({info}){' 前回の画像を継続' if code in manifest else ''}")
    json.dump(manifest, open(mf, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(f'BOX画像 {made}弾を更新 / 合計{len(manifest)}弾')


if __name__ == '__main__':
    if len(sys.argv) > 1:  # テスト: python3 scripts/box_images.py 画像ファイル
        r = cutout(open(sys.argv[1], 'rb').read())
        open('/tmp/box_test.webp', 'wb').write(r['out'])
        print({k: v for k, v in r.items() if k != 'out'})
    else:
        main()
