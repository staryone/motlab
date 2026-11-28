"""Track points, a flat surface or the whole frame through a clip, so animation can stick to the footage.

    python3 track.py <clip> [--points NAME=X,Y[,X,Y...]] [--plane NAME=X1,Y1,X2,Y2,X3,Y3,X4,Y4] [--camera [NAME]]
                     [--at SECONDS] [--range FROM TO] [--window 15] [--grow 0] [--out <clip>.track.json] [--sheet out.jpg]

Positions are in the clip's pixels, as it plays (a phone's rotation applied), and true at --at seconds into the clip
(default 0). Tracking runs from there to both ends, or over --range only.

--points   one or more points under one name: one gives a position, two a position, a scale and a turn. Pick each on
           a small, sharp detail (a corner, a mark, a screw); a point on a plain area cannot be followed.
--plane    the four corners of a flat surface (a screen, a sign, a table top, a wall), in the order top left, top
           right, bottom right, bottom left of what will be drawn on it. The texture inside it is what is followed.
--grow     also follow texture this far around the plane, as a fraction of its size (0.15 takes in a phone's bezel
           around a plain screen). Things that move differently (fingers) are left out by themselves.
--camera   the whole frame's move: a matrix per frame from the start frame's pixels to this frame's. For animation
           fixed to a distant or flat background, and for shake.
--window   the size of the detail around each point, in pixels from its centre.
--sheet    also draw this run's tracks on 8 frames from the tracked part, in one picture, to look at before using them:
           a plane's outline, each point, and for the camera a grid fixed to the first frame.

Each run adds its tracks to <clip>.track.json (replacing tracks of the same name). Every track keeps a confidence
per frame from 0 to 1; frames where it was lost are null. The scene reads the file with loadTrack() from
/__motlab/comp.js. Method: pyramidal Lucas-Kanade (Bouguet) on features spread over the region, each frame matched to
a keyframe warped by the predicted homography, which is fitted with RANSAC; numpy and scipy only.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

LEVELS = 4        # pyramid levels: a move of about 10 * 2^3 pixels a frame is still found
FEATURE_R = 10    # window around each feature, in pixels from its centre
MAX_FEATURES = 400
GRID = 10         # features are spread over a GRID x GRID grid of the region, so a fit uses all of it
ITERS = 12


# ---------------------------------------------------------------- reading the clip
def probe(clip):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,r_frame_rate:stream_side_data=rotation', '-of', 'json', clip],
                         capture_output=True, text=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    w, h = s['width'], s['height']
    rot = next((abs(int(d.get('rotation', 0))) for d in s.get('side_data_list', []) if 'rotation' in d), 0)
    if rot in (90, 270):
        w, h = h, w
    num, den = s['r_frame_rate'].split('/')
    times = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'frame=best_effort_timestamp_time', '-of', 'csv=p=0', clip],
                           capture_output=True, text=True, check=True).stdout.split()
    times = sorted(float(t.strip(',')) for t in times if t.strip(',') not in ('', 'N/A'))
    return w, h, float(num) / float(den), [t - times[0] for t in times]


def frames(clip, w, h, first, last):
    """grey frames first..last (indexes, inclusive), in order, as float32 0..1"""
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', clip, '-fps_mode', 'passthrough', '-f', 'rawvideo',
                          '-pix_fmt', 'gray', '-'], stdout=subprocess.PIPE)
    try:
        for i in range(last + 1):
            b = p.stdout.read(w * h)
            if len(b) < w * h:
                break
            if i >= first:
                yield i, np.frombuffer(b, np.uint8).reshape(h, w).astype(np.float32) / 255
    finally:
        p.stdout.close()
        p.kill()
        p.wait()


def frames_back(clip, w, h, first, last, chunk=48):
    """the same frames from last down to first, decoded in chunks so a long stretch does not fill memory"""
    hi = last
    while hi >= first:
        lo = max(first, hi - chunk + 1)
        yield from reversed(list(frames(clip, w, h, lo, hi)))
        hi = lo - 1


# ---------------------------------------------------------------- image helpers
def pyramid(img, levels=LEVELS):
    p = [img]
    for _ in range(levels - 1):
        a = ndimage.gaussian_filter(p[-1], 1.0)
        hh, ww = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
        p.append(a[:hh, :ww].reshape(hh // 2, 2, ww // 2, 2).mean((1, 3)))
    return p


def sample(img, x, y):
    return ndimage.map_coordinates(img, [y, x], order=1, mode='nearest')


def windows(img, x, y, r):
    """bilinear samples of the (2r+1)^2 window around each point (x, y). Every pixel of a window moves by the same
    fraction, so one block per point is gathered and blended with four slices, instead of sampling each pixel."""
    ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = (x - ix).astype(np.float32)[:, None, None], (y - iy).astype(np.float32)[:, None, None]
    o = np.arange(-r, r + 2)
    rows = np.clip(iy[:, None] + o, 0, img.shape[0] - 1)
    cols = np.clip(ix[:, None] + o, 0, img.shape[1] - 1)
    b = img[rows[:, :, None], cols[:, None, :]]
    top = b[:, :-1, :-1] * (1 - fx) + b[:, :-1, 1:] * fx
    bot = b[:, 1:, :-1] * (1 - fx) + b[:, 1:, 1:] * fx
    return (top * (1 - fy) + bot * fy).reshape(len(x), -1)


def corners(img, mask, n=MAX_FEATURES, mind=9):
    """Shi-Tomasi corners inside mask, the strongest of each grid cell first, so they spread over the region"""
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return np.zeros((0, 2), np.float32)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    a = img[y0:y1, x0:x1]
    gx, gy = ndimage.sobel(a, 1) / 8, ndimage.sobel(a, 0) / 8
    xx, xy, yy = (ndimage.gaussian_filter(v, 1.5) for v in (gx * gx, gx * gy, gy * gy))
    lam = (xx + yy) / 2 - np.sqrt(((xx - yy) / 2) ** 2 + xy * xy)
    lam[~mask[y0:y1, x0:x1]] = 0
    edge = FEATURE_R + 2   # keep windows inside the picture
    lam[:max(0, edge - y0)] = 0
    lam[:, :max(0, edge - x0)] = 0
    lam[max(0, img.shape[0] - edge - y0):] = 0
    lam[:, max(0, img.shape[1] - edge - x0):] = 0
    if lam.max() <= 0:
        return np.zeros((0, 2), np.float32)
    peak = (lam == ndimage.maximum_filter(lam, mind)) & (lam > lam.max() * 0.01) & (lam > 1e-5)
    cy, cx = np.nonzero(peak)
    v = lam[cy, cx]
    cell = (cy * GRID // lam.shape[0]) * GRID + cx * GRID // lam.shape[1]
    order = np.lexsort((-v, cell))
    rank = np.empty(len(order), int)
    starts = np.r_[0, np.flatnonzero(np.diff(cell[order])) + 1]
    for s, e in zip(starts, np.r_[starts[1:], len(order)]):
        rank[order[s:e]] = np.arange(e - s)
    pick = np.lexsort((-v, rank))[:n]   # round robin over the cells, strongest first
    return np.stack([cx[pick] + x0, cy[pick] + y0], 1).astype(np.float32)


def polygon_mask(poly, w, h):
    m = Image.new('L', (w, h), 0)
    ImageDraw.Draw(m).polygon([tuple(map(float, p)) for p in poly], fill=1)
    return np.asarray(m, bool)


# ---------------------------------------------------------------- Lucas-Kanade against a fixed template
class Template:
    """A keyframe's pyramid with windows around points, ready to be matched in other frames. The template's gradients
    and the 2x2 matrices are worked out once, so a frame costs only its own samples (inverse compositional)."""

    def __init__(self, img, pts, r=FEATURE_R, levels=LEVELS):
        self.pyr = pyramid(img, levels)
        self.pts = np.asarray(pts, np.float32)
        self.r = r
        self.levels = []
        for lv, I in enumerate(self.pyr):
            p = self.pts / 2 ** lv
            gx, gy = ndimage.sobel(I, 1) / 8, ndimage.sobel(I, 0) / 8
            i0, sx, sy = (windows(a, p[:, 0], p[:, 1], r) for a in (I, gx, gy))
            G = np.stack([np.stack([(sx * sx).sum(1), (sx * sy).sum(1)], -1),
                          np.stack([(sx * sy).sum(1), (sy * sy).sum(1)], -1)], -2)
            self.levels.append((p, i0, sx, sy, np.linalg.inv(G + np.eye(2) * 1e-6)))

    def subset(self, keep):
        t = object.__new__(Template)
        t.pyr, t.pts, t.r = self.pyr, self.pts[keep], self.r
        t.levels = [tuple(a[keep] for a in lv) for lv in self.levels]
        return t

    def match(self, J_pyr, d=None):
        """where each template point is in the image of J_pyr, starting from offsets d; also the mean absolute
        difference and the normalised correlation of each window at the end"""
        d = np.zeros_like(self.pts) if d is None else np.asarray(d, np.float32).copy()
        n = len(self.levels)
        d = d / 2 ** (n - 1)
        live = np.ones(len(d), bool)
        for lv in range(n - 1, -1, -1):
            p, i0, sx, sy, Gi = self.levels[lv]
            J = J_pyr[lv]
            live[:] = True
            for _ in range(ITERS):   # only points that still move are sampled again
                q = p[live] + d[live]
                e = windows(J, q[:, 0], q[:, 1], self.r) - i0[live]
                step = np.einsum('nij,nj->ni', Gi[live], np.stack([(e * sx[live]).sum(1), (e * sy[live]).sum(1)], -1))
                d[live] -= step
                moving = np.abs(step).max(1) >= 0.01
                live[np.flatnonzero(live)[~moving]] = False
                if not live.any():
                    break
            if lv:
                d *= 2
        p, i0 = self.levels[0][:2]
        j = windows(J_pyr[0], p[:, 0] + d[:, 0], p[:, 1] + d[:, 1], self.r)
        return self.pts + d, np.abs(j - i0).mean(1), ncc(i0, j)


def ncc(a, b):
    a = a - a.mean(1, keepdims=True)
    b = b - b.mean(1, keepdims=True)
    return (a * b).sum(1) / (np.sqrt((a * a).sum(1) * (b * b).sum(1)) + 1e-9)


# ---------------------------------------------------------------- homographies
def homography(src, dst):
    """direct linear transform with Hartley's normalisation"""
    def norm(p):
        m = p.mean(0)
        s = np.sqrt(2) / max(np.linalg.norm(p - m, axis=1).mean(), 1e-9)
        return np.array([[s, 0, -s * m[0]], [0, s, -s * m[1]], [0, 0, 1]])
    Ts, Td = norm(src), norm(dst)
    a = np.c_[src, np.ones(len(src))] @ Ts.T
    b = np.c_[dst, np.ones(len(dst))] @ Td.T
    A = np.zeros((2 * len(a), 9))
    A[0::2, 0:3] = a
    A[0::2, 6:9] = -b[:, :1] * a
    A[1::2, 3:6] = a
    A[1::2, 6:9] = -b[:, 1:2] * a
    H = np.linalg.inv(Td) @ np.linalg.svd(A, full_matrices=False)[2][-1].reshape(3, 3) @ Ts
    return H / H[2, 2]


def apply(H, p):
    q = np.c_[p, np.ones(len(p))] @ H.T
    return q[:, :2] / q[:, 2:]


def ransac(src, dst, thr=1.0, tries=500, seed=0):
    """the homography most points agree on, within thr pixels; the same input gives the same answer. All the
    four-point guesses are solved at once."""
    n = len(src)
    rng = np.random.default_rng(seed)
    pick = np.argpartition(rng.random((tries, n)), 4, 1)[:, :4]
    m = src.mean(0)
    s, d = src[pick] - m, dst[pick] - m   # centred, for a better conditioned solve
    x, y, u, v = s[..., 0], s[..., 1], d[..., 0], d[..., 1]
    z, o = np.zeros_like(x), np.ones_like(x)
    A = np.concatenate([np.stack([x, y, o, z, z, z, -u * x, -u * y], -1),
                        np.stack([z, z, z, x, y, o, -v * x, -v * y], -1)], 1)
    b = np.concatenate([u, v], 1)
    ok = np.abs(np.linalg.det(A)) > 1e-9
    h = np.linalg.solve(A[ok], b[ok][..., None])[..., 0]
    Hs = np.concatenate([h, np.ones((len(h), 1))], 1).reshape(-1, 3, 3)
    q = np.einsum('kij,nj->kni', Hs, np.c_[src - m, np.ones(n)])
    err = np.linalg.norm(q[..., :2] / q[..., 2:] - (dst - m), axis=2)
    inl = err < thr
    best = inl[np.argmax(inl.sum(1))] if len(inl) else None
    if best is None or best.sum() < 8:
        return None, best
    H = homography(src[best], dst[best])
    for _ in range(2):   # refit on everything within the threshold of the refit
        inl = np.linalg.norm(apply(H, src) - dst, axis=1) < thr
        if inl.sum() < 8:
            break
        best, H = inl, homography(src[inl], dst[inl])
    return H, best


def warp_into(img, H, box):
    """img seen through H (keyframe pixels -> img pixels) over box (x0, y0, x1, y1) of the keyframe; outside the
    picture stays at the nearest edge"""
    x0, y0, x1, y1 = box
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    q = np.stack([xx.ravel(), yy.ravel(), np.ones(xx.size, np.float32)]) .T @ H.T.astype(np.float32)
    u, v = q[:, 0] / q[:, 2], q[:, 1] / q[:, 2]
    return ndimage.map_coordinates(img, [v, u], order=1, mode='nearest').reshape(xx.shape)


# ---------------------------------------------------------------- one region through the clip
def region_mask(region, H, grow, w, h):
    if region is None:
        return np.ones((h, w), bool)
    poly = apply(H, region)
    c = poly.mean(0)
    return polygon_mask(c + (poly - c) * (1 + grow), w, h)


def keyframe(img, pts, H, w, h):
    """a keyframe from details at pts (frame pixels), cut to the box around them with room for the pyramid"""
    m = FEATURE_R * 2 ** LEVELS
    x0, y0 = np.maximum(0, np.floor(pts.min(0)).astype(int) - m)
    x1, y1 = np.minimum([w, h], np.ceil(pts.max(0)).astype(int) + 1 + m)
    return {'tpl': Template(img[y0:y1, x0:x1], pts - [x0, y0]), 'H': H.copy(), 'box': (int(x0), int(y0), int(x1), int(y1)),
            'bad': np.zeros(len(pts), int)}


def moved_with(pts, img, last, M):
    """which details at pts in img are found in the last frame where M (this frame -> last) puts them, within a
    pixel: details on the plane, not on a finger crossing it"""
    want = apply(M, pts)
    found, _, score = Template(img, pts).match(pyramid(last), want - pts)
    return (np.linalg.norm(found - want, axis=1) < 1.0) & (score > 0.8)


def track_region(seq, w, h, region, grow=0.0, log=print):
    """seq: (index, frame) from the start frame on. region: the four corners of a plane in the start frame, or None
    for the whole frame. Returns {index: (H start -> frame, confidence)} with H None where it was lost.

    Each frame is warped by the predicted homography into the keyframe's pixels and its details matched there, so
    the error does not add up from frame to frame. Details that keep moving their own way (a finger) are dropped. A
    new keyframe is taken when too few details are left or seen; it keeps the details still on the plane and adds
    new ones only if they moved with the plane since the last frame."""
    out, key, last, lost = {}, None, None, 0
    Hl = Hll = None
    for i, img in seq:
        if key is None:
            H = np.eye(3)
            pts = corners(img, region_mask(region, H, grow, w, h))
            if len(pts) < 8:
                log(f'  frame {i}: too little texture to follow ({len(pts)} details)')
                out[i] = (None, 0.0)
                break
            key = keyframe(img, pts, H, w, h)
            out[i] = (H, 1.0)
            Hl, last = H, img
            continue
        pred = Hl if Hll is None else Hl @ np.linalg.inv(Hll) @ Hl   # the last frame's move once more
        tpl, Hk, box = key['tpl'], key['H'], key['box']
        T = np.array([[1, 0, box[0]], [0, 1, box[1]], [0, 0, 1]], float)
        Gl = pred @ np.linalg.inv(Hk) @ T                             # keyframe box pixels -> this frame, predicted
        J = pyramid(warp_into(img, Gl, (0, 0, box[2] - box[0], box[3] - box[1])))
        found, err, _ = tpl.match(J)
        seen = apply(Gl, found)
        visible = (seen[:, 0] >= 0) & (seen[:, 1] >= 0) & (seen[:, 0] < w) & (seen[:, 1] < h)
        good = visible & (err < 0.08)
        C, inl = ransac(tpl.pts[good], found[good]) if good.sum() >= 8 else (None, None)
        if C is None:
            lost += 1
            out[i] = (None, 0.0)
            Hl, Hll, last = pred, None, img
            if lost > 10:
                log(f'  lost at frame {i}')
                break
            continue
        lost = 0
        H = Gl @ C @ np.linalg.inv(T) @ Hk
        ok = np.zeros(len(found), bool)
        ok[np.flatnonzero(good)[inl]] = True
        out[i] = (H, round(float(ok.sum() / max(visible.sum(), 1)), 3))
        key['bad'][visible & ~ok] += 1
        key['bad'][ok] = 0
        if ok.sum() < max(20, 0.3 * len(ok)) or visible.mean() < 0.5:
            keep = apply(H @ np.linalg.inv(Hk) @ T, tpl.pts[ok])
            new = corners(img, region_mask(region, H, grow, w, h))
            if len(keep) and len(new):
                new = new[np.min(np.linalg.norm(new[:, None] - keep[None], axis=2), 1) > 6]
            if len(new):
                new = new[moved_with(new, img, last, Hl @ np.linalg.inv(H))]
            pts = np.r_[keep, new].astype(np.float32)
            if len(pts) >= 8:
                key = keyframe(img, pts, H, w, h)
        else:
            drop = key['bad'] >= 5
            if drop.any() and (~drop).sum() >= 20:
                key = {**key, 'tpl': tpl.subset(~drop), 'bad': key['bad'][~drop]}
        Hll, Hl, last = Hl, H, img
    return out


def track_points(seq, start_pts, r, log=print):
    """seq: (index, frame) from the start frame on. Each point is matched to its keyframe window, which is renewed
    when the match gets weak. Returns {index: (points, confidence)}"""
    out, key, cur, prev = {}, None, np.asarray(start_pts, np.float32), None
    for i, img in seq:
        if key is None:
            key = Template(img, cur, r)
            out[i] = (cur.copy(), 1.0)
            prev, last = cur.copy(), img
            continue
        guess = cur + (cur - prev) - key.pts   # the last frame's move once more
        found, _, score = key.match(pyramid(img), guess)
        if score.min() < 0.75:   # a renewed keyframe from the last frame, then match again from there
            chain = Template(last, cur, r)
            found2, _, score2 = chain.match(pyramid(img), cur - prev)
            if score2.min() > score.min():
                found, score = found2, score2
            key = Template(img, found, r)
        prev, cur, last = cur, found, img
        out[i] = (found.copy(), round(float(score.min()), 3))
        if score.min() < 0.3:
            log(f'  point lost at frame {i}')
            break
    return out


def draw_sheet(clip, doc, names, out, cols=4, n=8):
    w, h = doc['width'], doc['height']
    spans = [(t['first'], t['first'] + len(t['confidence']) - 1) for name, t in doc['tracks'].items() if name in names]
    lo, hi = min(a for a, _ in spans), max(b for _, b in spans)
    pick = sorted(set(int(round(x)) for x in np.linspace(lo, hi, n)))
    tw, th = 480, round(480 * h / w)
    sel = '+'.join(rf'eq(n\,{i})' for i in pick)
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', clip, '-vf', f'select={sel}', '-fps_mode', 'passthrough', '-f', 'rawvideo',
                          '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    sheet = Image.new('RGB', (cols * tw, -(-len(pick) // cols) * th))
    colours = [(255, 0, 255), (0, 220, 255), (255, 200, 0), (120, 255, 80)]
    grid = np.array([[x, y] for x in np.linspace(w * 0.1, w * 0.9, 9) for y in np.linspace(h * 0.1, h * 0.9, 5)])
    for k, i in enumerate(pick):
        im = Image.frombytes('RGB', (w, h), raw[k * w * h * 3:(k + 1) * w * h * 3])
        d = ImageDraw.Draw(im)
        for c, name in enumerate(names):
            t = doc['tracks'][name]
            j = i - t['first']
            key = {'plane': 'corners', 'points': 'points', 'camera': 'matrix'}[t['kind']]
            v = t[key][j] if 0 <= j < len(t[key]) else None
            col, r = colours[c % len(colours)], max(4, w // 200)
            if v is None:
                continue
            if t['kind'] == 'plane':
                q = [tuple(v[m:m + 2]) for m in range(0, 8, 2)]
                d.line(q + [q[0]], fill=col, width=max(2, w // 500))
            elif t['kind'] == 'points':
                for m in range(0, len(v), 2):
                    d.ellipse([v[m] - r, v[m + 1] - r, v[m] + r, v[m + 1] + r], outline=col, width=max(2, w // 500))
            else:
                for x, y in apply(np.array(v).reshape(3, 3), grid):
                    d.ellipse([x - r / 2, y - r / 2, x + r / 2, y + r / 2], fill=col)
        d.text((8, 8), f'frame {i}', fill=(255, 255, 255))
        sheet.paste(im.resize((tw, th)), ((k % cols) * tw, (k // cols) * th))
    sheet.save(out, quality=88)
    print(f'wrote {out}')


# ---------------------------------------------------------------- running both ways and writing the file
def both_ways(clip, w, h, start, first, last, run):
    fwd = run(frames(clip, w, h, start, last))
    back = run(frames_back(clip, w, h, first, start)) if start > first else {}
    return {**back, **fwd}


def nums(s, n=None):
    v = [float(x) for x in s.split(',')]
    if n and len(v) != n:
        raise SystemExit(f'expected {n} numbers, got {len(v)}: {s}')
    return v


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('clip')
    ap.add_argument('--points', action='append', default=[], metavar='NAME=X,Y[,X,Y...]')
    ap.add_argument('--plane', action='append', default=[], metavar='NAME=X1,Y1,...,X4,Y4')
    ap.add_argument('--camera', nargs='?', const='camera', metavar='NAME')
    ap.add_argument('--at', type=float, default=0.0, help='seconds into the clip where the positions are true')
    ap.add_argument('--range', type=float, nargs=2, metavar=('FROM', 'TO'), help='track only this part, in seconds')
    ap.add_argument('--window', type=int, default=15, help='detail around a point, pixels from its centre')
    ap.add_argument('--grow', type=float, default=0.0, help='follow texture this far around a plane (fraction)')
    ap.add_argument('--out')
    ap.add_argument('--sheet', help='draw the tracks on 8 frames into this picture')
    o = ap.parse_args()
    if not (o.points or o.plane or o.camera):
        ap.error('give --points, --plane or --camera')
    w, h, fps, times = probe(o.clip)
    n = len(times)
    idx = lambda t: max(0, int(np.searchsorted(times, t + 1e-6, 'right')) - 1)
    first, last = (idx(o.range[0]), idx(o.range[1])) if o.range else (0, n - 1)
    start = min(max(idx(o.at), first), last)
    out = o.out or os.path.splitext(o.clip)[0] + '.track.json'
    doc = {}
    if os.path.exists(out):
        doc = json.load(open(out, encoding='utf8'))
        if doc.get('width') != w or doc.get('height') != h or len(doc.get('times', [])) != n:
            print(f'{out} was made from a different clip; starting it again')
            doc = {}
    doc.update({'clip': os.path.basename(o.clip), 'width': w, 'height': h, 'fps': round(fps, 4),
                'times': [round(t, 5) for t in times]})
    tracks = doc.setdefault('tracks', {})
    print(f'{o.clip}: {w}x{h}, {n} frames at {fps:.3f} fps; from frame {start} ({times[start]:.3f} s), frames {first} to {last}')

    def emit(name, kind, res, key, fmt):
        span = [i for i in sorted(res)]
        lo = span[0]
        vals = [None] * (span[-1] - lo + 1)
        conf = [0.0] * len(vals)
        for i in span:
            v, c = res[i]
            if v is not None:
                vals[i - lo] = fmt(v)
            conf[i - lo] = c
        tracks[name] = {'kind': kind, 'first': lo, key: vals, 'confidence': conf}
        weak = sum(1 for c, v in zip(conf, vals) if v is None or c < 0.5)
        print(f'  {name}: frames {lo} to {span[-1]}' + (f', {weak} weak or lost' if weak else ', all followed'))

    for spec in o.points:
        name, xy = spec.split('=', 1)
        p = np.array(nums(xy), np.float32).reshape(-1, 2)
        t0 = time.time()
        res = both_ways(o.clip, w, h, start, first, last, lambda seq: track_points(seq, p, o.window))
        emit(name, 'points', res, 'points', lambda v: [round(float(x), 2) for x in v.ravel()])
        print(f'    {time.time() - t0:.1f} s')
    for spec in o.plane:
        name, xy = spec.split('=', 1)
        q = np.array(nums(xy, 8), float).reshape(4, 2)
        t0 = time.time()
        res = both_ways(o.clip, w, h, start, first, last, lambda seq: track_region(seq, w, h, q, o.grow))
        emit(name, 'plane', {i: (None if H is None else apply(H, q), c) for i, (H, c) in res.items()},
             'corners', lambda v: [round(float(x), 2) for x in v.ravel()])
        print(f'    {time.time() - t0:.1f} s')
    if o.camera:
        # the whole frame moves together, so half the size is enough and four times faster; the matrices are scaled
        # back to the clip's pixels
        t0 = time.time()
        k = 2 if w > 1280 else 1
        half = lambda seq: ((i, f[:f.shape[0] // k * k, :f.shape[1] // k * k].reshape(f.shape[0] // k, k, f.shape[1] // k, k).mean((1, 3))) for i, f in seq)
        S = np.diag([1 / k, 1 / k, 1])
        res = both_ways(o.clip, w, h, start, first, last, lambda seq: track_region(half(seq), w // k, h // k, None))
        res = {i: (None if H is None else np.linalg.inv(S) @ H @ S, c) for i, (H, c) in res.items()}
        emit(o.camera, 'camera', res, 'matrix', lambda H: [float(f'{x:.7g}') for x in (H / H[2, 2]).ravel()])
        print(f'    {time.time() - t0:.1f} s')
    with open(out, 'w', encoding='utf8') as f:
        json.dump(doc, f, separators=(',', ':'))
    print(f'wrote {out}')
    if o.sheet:
        names = [s.split('=', 1)[0] for s in o.points + o.plane] + ([o.camera] if o.camera else [])
        draw_sheet(o.clip, doc, [n for n in names if n in tracks], o.sheet)


if __name__ == '__main__':
    sys.exit(main())
