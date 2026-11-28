"""Cut a photo into layers by depth, for parallax with /__motlab/camera.js.

    python3 depth_layers.py <photo> [<depth.png>] [--layers 3] [--far 0.6] [--soft 0.03] [--out <folder>]

<depth.png> is the photo's depth map from `motlab depth <photo>` (lighter is nearer), by default <photo>.depth.png
next to it. The cuts go where the depth map has the fewest pixels between groups of depths (1-D k-means), so a layer
tends to hold whole objects. Each layer is a PNG of the photo's size: the far one is opaque, and each nearer one is
transparent where something is further away. Under every layer's nearer neighbours, the hidden part is filled from
its own edges and blurred, so a camera move that shows a little more behind an object finds picture there, not a
hole. Small moves only: the fill is a smear, not a picture of what was behind.

--layers  how many layers (2 to 8)
--far     the parallax depth of the far layer for camera.js; the nearest is 1 and the others sit between by depth
--soft    the width of the soft edge between layers, as a fraction of the depth range
--out     the folder for <stem>-1.png (far) ... <stem>-N.png (near) and <stem>-layers.json (default: next to the photo)
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def kmeans_1d(values, k, rounds=50):
    """Centres of k groups of depths, from a 256-bin histogram (fast on any image size)."""
    hist, edges = np.histogram(values, bins=256, range=(0, 1))
    mids = (edges[:-1] + edges[1:]) / 2
    centres = np.quantile(values, (np.arange(k) + 0.5) / k)
    for _ in range(rounds):
        cuts = (centres[:-1] + centres[1:]) / 2
        group = np.searchsorted(cuts, mids)
        new = np.array([np.average(mids[group == g], weights=hist[group == g]) if hist[group == g].sum() else centres[g] for g in range(k)])
        if np.allclose(new, centres, atol=1e-5): break
        centres = np.sort(new)
    return centres


def fill_hidden(rgb, known, blur):
    """rgb with every pixel outside `known` taken from the nearest known pixel, then blurred where it was filled."""
    if known.all(): return rgb
    _, (iy, ix) = ndimage.distance_transform_edt(~known, return_indices=True)
    out = rgb[iy, ix]
    soft = np.stack([ndimage.gaussian_filter(out[..., c], blur) for c in range(3)], -1)
    return np.where(known[..., None], rgb, soft)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('photo')
    ap.add_argument('depth', nargs='?')
    ap.add_argument('--layers', type=int, default=3)
    ap.add_argument('--far', type=float, default=0.6)
    ap.add_argument('--soft', type=float, default=0.03)
    ap.add_argument('--out')
    a = ap.parse_args()
    if not 2 <= a.layers <= 8: ap.error('--layers is 2 to 8')
    photo = Path(a.photo)
    depth_path = Path(a.depth) if a.depth else photo.with_name(photo.stem + '.depth.png')
    if not depth_path.exists(): ap.error(f'{depth_path} not found: make it with  motlab depth {photo}')
    img = Image.open(photo).convert('RGB')
    dep = Image.open(depth_path).convert('L')
    if dep.size != img.size: dep = dep.resize(img.size, Image.BILINEAR)
    rgb = np.asarray(img, dtype=np.float32)
    d = np.asarray(dep, dtype=np.float32) / 255
    lo, hi = np.percentile(d, [0.5, 99.5])
    d = np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1)

    centres = kmeans_1d(d.ravel(), a.layers)
    cuts = (centres[:-1] + centres[1:]) / 2
    half = max(a.soft, 1e-4) / 2
    # cover[i]: how much layer i covers each pixel, 1 at and nearer than its cut, ramping over the soft edge.
    cover = [np.ones_like(d)] + [np.clip((d - (c - half)) / (2 * half), 0, 1) for c in cuts]
    blur = max(img.size) / 200
    out = Path(a.out) if a.out else photo.parent
    out.mkdir(parents=True, exist_ok=True)
    span = centres[-1] - centres[0]
    layers = []
    for i in range(a.layers):
        # The layer's own pixels are those no nearer layer covers fully; the rest is hidden behind and gets filled.
        nearer = cover[i + 1] if i + 1 < a.layers else np.zeros_like(d)
        known = nearer < 0.5
        if i: known &= cover[i] > 0.5
        colour = fill_hidden(rgb, known, blur) if known.any() else rgb
        alpha = cover[i]
        name = f'{photo.stem}-{i + 1}.png'
        Image.fromarray(np.dstack([colour, alpha * 255]).round().clip(0, 255).astype(np.uint8), 'RGBA').save(out / name)
        depth = a.far + (1 - a.far) * ((centres[i] - centres[0]) / span if span > 0 else i / (a.layers - 1))
        layers.append({'file': name, 'depth': round(float(depth), 3), 'share': round(float((alpha * (1 - nearer)).mean()), 3)})
    info = {'photo': photo.name, 'size': list(img.size), 'cuts': [round(float(c * (hi - lo) + lo), 3) for c in cuts], 'layers': layers}
    (out / f'{photo.stem}-layers.json').write_text(json.dumps(info, indent=2) + '\n', encoding='utf-8')
    for l in layers: print(f"{out / l['file']}  depth {l['depth']}  {l['share'] * 100:.0f}% of the picture")
    print(f"-> {out / (photo.stem + '-layers.json')}")


if __name__ == '__main__':
    main()
