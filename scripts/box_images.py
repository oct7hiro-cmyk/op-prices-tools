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
    # 背景の「白」の基準をゆるい順に試し、直方体の形(下の shape_ok)になった最初のものを使う。
    # 白っぽい箱は、ゆるい基準だと箱の面まで消えるので、より白いところだけを背景にして切り直す
    # (最初から厳しい基準にすると、ふつうの箱の周りに白いふちが残る)
    best = None
    for th, chroma in ((228, 22), (244, 12), (250, 8), (253, 5)):
        r = cutout1(raw, th, chroma)
        if r and r['score'] > 0:
            return r
        if r and (not best or r['fill'] > best['fill']):
            best = r
    return best


def profile(alpha):
    """直方体の形かどうかの手がかり。斜め上から撮った箱は、上の輪郭は奥の角が一番高い「へ」の字、
    下の輪郭は手前の角が一番低い「V」の字になり、どちらの角も左右の端ではなく内側にある。
    正面だけの写真(海外版の平たい箱・パック)は上下がまっすぐ。箱の白い天面が背景と一緒に消えると、上の一番高い所が端に寄る。
    返り値: 上・下の輪郭の高さの振れ幅(画像の高さ比)と、上の一番高い所・下の一番低い所の横位置(0〜1)"""
    w, h = alpha.size
    px = alpha.load()
    xs, tops, bots = [], [], []
    for x in range(int(w * .03), int(w * .97)):
        ys = [y for y in range(h) if px[x, y] > 128]
        if ys:
            xs.append(x); tops.append(ys[0]); bots.append(ys[-1])
    if not tops:
        return 0, 0, 0, 0
    pt = xs[tops.index(min(tops))] / w
    pb = xs[bots.index(max(bots))] / w
    return (max(tops) - min(tops)) / h, (max(bots) - min(bots)) / h, pt, pb


def shape_ok(t, b, pt, pb, ar):
    return (t >= 0.05 and b >= 0.05 and min(t, b) / max(t, b) >= 0.5
            and 0.12 < pt < 0.88 and 0.12 < pb < 0.88 and 0.45 < ar < 0.85
            # 奥の角(上)と手前の角(下)は横にずれる。同じ位置なら斜めに撮った平たいもの(パックなど)
            and abs(pt - pb) >= 0.12)


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
    crop = im.crop((x0, y0, x1 + 1, y1 + 1))
    t, b, pt, pb = profile(crop.getchannel('A'))
    # 箱は外枠にほぼ詰まった形。端に接していたら背景つきの写真、面積が小さすぎたら別物。
    # さらに斜めから見た直方体の形であること(パック・海外版の平たい箱・欠けた箱は不採用)
    ok = fill > 0.72 and area > 0.12 and edge_r < 0.02 and shape_ok(t, b, pt, pb, ar)
    score = fill + min(t, b) / max(t, b, 1e-6) * 0.5 + min(area, 0.6) * 0.3 if ok else 0
    out = io.BytesIO()
    crop.save(out, 'WEBP', quality=86)
    return {'out': out.getvalue(), 'score': score, 'fill': round(fill, 2), 'area': round(area, 2), 'ar': round(ar, 2), 'edge': round(edge_r, 3), 't': round(t, 3), 'b': round(b, 3)}


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
        info = (f"score={best['score']:.2f} fill={best['fill']} area={best['area']} ar={best['ar']} edge={best['edge']} t={best['t']} b={best['b']}" if best else '候補なし')
        if best and best['score'] > 0:
            file = f'{OUT}/{code.lower()}.webp'
            open(file, 'wb').write(best['out'])
            manifest[code] = {'file': file, 'src': best['src'], 'score': round(best['score'], 2), 'updatedAt': data.get('updatedAt')}
            made += 1
            print(f'[{code}] 採用 {info}')
        else:
            prev = manifest.get(code, {}).get('file')
            keep = False
            if prev and os.path.exists(prev):  # 前回の画像も直方体の形でなければ消す(画面はCSSで描いたBOXになる)
                pim = Image.open(prev).convert('RGBA')
                keep = shape_ok(*profile(pim.getchannel('A')), pim.width / pim.height)
                if not keep:
                    os.remove(prev)
                    manifest.pop(code, None)
            print(f"[{code}] 不採用({info}){' 前回の画像を継続' if keep else ' 画像なし(CSSのBOX)'}")
    json.dump(manifest, open(mf, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(f'BOX画像 {made}弾を更新 / 合計{len(manifest)}弾')


if __name__ == '__main__':
    if len(sys.argv) > 1:  # テスト: python3 scripts/box_images.py 画像ファイル
        r = cutout(open(sys.argv[1], 'rb').read())
        open('/tmp/box_test.webp', 'wb').write(r['out'])
        print({k: v for k, v in r.items() if k != 'out'})
    else:
        main()
