"""Make sprite stacks: an object as horizontal slices, bottom to top, for loadStack() in /__motlab/sprite.js.

  python slices.py views <top.png> <front.png> <side.png> [--back back.png] [--left left.png] --out <dir>/<name>
      Carves the object from flat views, one pixel to a voxel: a voxel stays where every view shows something (a
      visual hull). top.png is seen from above with the front at the bottom of the picture; front.png from the front;
      side.png from the object's right, so its front is on the left; back.png from behind and left.png from its left,
      when the object differs there. Transparent pixels are empty. Sizes must agree: top W x D, front W x H, side D x H.
      Each voxel takes its colour from the view that sees it: the top view where it is the highest in its column, else
      the front, the back, the right side or the left. Without back.png and left.png, the back and the left take what
      the side view shows at the same height and depth, as for an object that is the same on both sides. The rest
      (undersides, the inside) takes the colour of the nearest coloured voxel.

  python slices.py glb <model.glb> --size 48 --out <dir>/<name> [--blender <path>]
      Voxelizes a 3D model in Blender (scripts/blender/voxelize.py): --size voxels along its longest side across, the
      colour of each from its material's base colour texture or colour. Needs Blender (`blender`, BLENDER or --blender).

  From distance functions, in Python (the same y-up shapes as the motlab skill's mesh_from_sdf.py):
      from slices import from_sdf
      from_sdf(lambda x, y, z: ..., colour, lo=(x0, y0, z0), hi=(x1, y1, z1), size=40, out='kits/toys/car/car')
  colour is an (r, g, b) tuple, or a function of x, y, z that returns an array of shape (..., 3), 0 to 255.

Each writes <name>.stack.png (the slices side by side, bottom first), <name>.stack.json, which loadStack() reads, and
<name>.stack-preview.png, the stack drawn at four angles, to look at before using it.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))


def save_stack(rgba, out, voxel=None):
    """rgba: uint8 array [y][z][x][4], y up and z towards the front. Writes the strip, its JSON and a preview."""
    rgba = np.asarray(rgba, dtype=np.uint8)
    keep = np.nonzero(rgba[..., 3].reshape(rgba.shape[0], -1).max(1))[0]
    if not len(keep): sys.exit('the object came out empty: nothing is solid in it')
    rgba = rgba[keep[0]:keep[-1] + 1]   # no empty slices below or above the object
    n, d, w = rgba.shape[:3]
    strip = np.concatenate(list(rgba), axis=1)   # slice y at columns y*w .. y*w + w - 1
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    name = os.path.basename(out)
    Image.fromarray(strip, 'RGBA').save(out + '.stack.png')
    info = {'image': name + '.stack.png', 'slices': int(n), 'width': int(w), 'depth': int(d), 'layout': 'row', 'order': 'bottom-first'}
    if voxel: info['voxel'] = round(float(voxel), 6)
    with open(out + '.stack.json', 'w', encoding='utf-8') as f: json.dump(info, f, indent=2); f.write('\n')
    preview(rgba, out + '.stack-preview.png')
    print(f'{out}.stack.png  {n} slices of {w} x {d}')
    return info


def preview(rgba, path, scale=4, angles=(0, 45, 90, 135)):
    """The stack as loadStack() draws it, at a few angles, on grey."""
    n, d, w = rgba.shape[:3]
    side = int(np.ceil(np.hypot(w, d))) * scale
    tile = Image.new('RGBA', (side + 8, side + n * scale + 8), (60, 60, 60, 255))
    sheet = Image.new('RGBA', (tile.width * len(angles), tile.height), (60, 60, 60, 255))
    for a, angle in enumerate(angles):
        t = tile.copy()
        for i in range(n):
            s = Image.fromarray(rgba[i], 'RGBA').resize((w * scale, d * scale), Image.NEAREST).rotate(-angle, Image.NEAREST, expand=True)
            for k in range(scale):   # a slice is one voxel thick: fill the step up to the next one
                y = t.height - 4 - side // 2 - s.height // 2 - i * scale - k
                t.alpha_composite(s, ((t.width - s.width) // 2, y))
        sheet.paste(t, (a * tile.width, 0))
    sheet.convert('RGB').save(path)


def fill_hidden(rgba, coloured):
    """Colours every solid voxel that no view coloured from the nearest one that has a colour."""
    solid = rgba[..., 3] > 0
    if (solid & ~coloured).any() and coloured.any():
        _, idx = ndimage.distance_transform_edt(~coloured, return_indices=True)
        near = rgba[tuple(idx)]
        rgba[..., :3] = np.where((solid & ~coloured)[..., None], near[..., :3], rgba[..., :3])
    return rgba


# ---- from flat views ----------------------------------------------------------------------------------------------

def load(path):
    a = np.asarray(Image.open(path).convert('RGBA'))
    return a, a[..., 3] > 127


def first_along(solid, axis, last=False):
    """True for each solid voxel that is the first one along axis (the last one with last=True)."""
    count = solid.shape[axis]
    order = np.arange(count).reshape([-1 if i == axis else 1 for i in range(3)])
    pos = np.where(solid, order, count if not last else -1)
    edge = pos.min(axis, keepdims=True) if not last else pos.max(axis, keepdims=True)
    return solid & (order == edge)


def from_views(top, front, side, back=None, left=None):
    (T, t), (F, f), (S, s) = load(top), load(front), load(side)
    D, W = t.shape; H = f.shape[0]
    if f.shape != (H, W): sys.exit(f'front.png is {f.shape[1]} x {f.shape[0]}; it must be as wide as top.png ({W})')
    if s.shape != (H, D): sys.exit(f'side.png is {s.shape[1]} x {s.shape[0]}; it must be {D} wide (top.png\'s height) and {H} high (front.png\'s)')
    views = {}
    for name, path, shape in (('back', back, (H, W)), ('left', left, (H, D))):
        if path:
            views[name] = load(path)
            if views[name][1].shape != shape: sys.exit(f'{name}.png is {views[name][1].shape[1]} x {views[name][1].shape[0]}; it must be {shape[1]} x {shape[0]}')
    y = np.arange(H)[:, None, None]; z = np.arange(D)[None, :, None]; x = np.arange(W)[None, None, :]
    row = H - 1 - y   # image rows count down from the top; y counts up from the bottom
    solid = t[z, x] & f[row, x] & s[row, D - 1 - z]
    if 'back' in views: solid &= views['back'][1][row, W - 1 - x]
    if 'left' in views: solid &= views['left'][1][row, z]
    rgba = np.zeros((H, D, W, 4), np.uint8); rgba[..., 3] = np.where(solid, 255, 0)
    coloured = np.zeros_like(solid)
    yy, zz, xx = np.broadcast_arrays(y, z, x)
    rules = [(first_along(solid, 0, last=True), lambda: T[zz, xx]),          # highest in its column: seen from above
             (first_along(solid, 1, last=True), lambda: F[row + 0 * zz, xx]),  # frontmost: seen from the front
             (first_along(solid, 1), (lambda: views['back'][0][row + 0 * zz, W - 1 - xx]) if 'back' in views else (lambda: S[row + 0 * xx, D - 1 - zz])),
             (first_along(solid, 2, last=True), lambda: S[row + 0 * xx, D - 1 - zz]),  # rightmost: seen from the right
             (first_along(solid, 2), (lambda: views['left'][0][row + 0 * xx, zz]) if 'left' in views else (lambda: S[row + 0 * xx, D - 1 - zz]))]
    for mask, colour in rules:
        take = mask & ~coloured
        if take.any():
            rgba[..., :3] = np.where(take[..., None], colour()[..., :3], rgba[..., :3])
            coloured |= take
    return fill_hidden(rgba, coloured)


# ---- from distance functions --------------------------------------------------------------------------------------

def from_sdf(f, colour, lo, hi, size=40, out='stack'):
    """Samples f (negative inside, y up) at the middle of each voxel; size voxels along the longer of x and z."""
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    voxel = max(hi[0] - lo[0], hi[2] - lo[2]) / size
    n = np.maximum(1, np.round((hi - lo) / voxel).astype(int))
    xs, ys, zs = (lo[i] + (np.arange(n[i]) + 0.5) * voxel for i in range(3))
    Y, Z, X = np.meshgrid(ys, zs, xs, indexing='ij')
    solid = f(X, Y, Z) < 0
    rgba = np.zeros(solid.shape + (4,), np.uint8)
    c = np.broadcast_to(np.asarray(colour(X, Y, Z) if callable(colour) else colour, float), solid.shape + (3,))
    rgba[..., :3] = np.where(solid[..., None], np.clip(np.round(c), 0, 255), 0).astype(np.uint8)
    rgba[..., 3] = np.where(solid, 255, 0)
    return save_stack(rgba, out, voxel)


# ---- from a 3D model ----------------------------------------------------------------------------------------------

def from_glb(model, size, out, blender=None):
    exe = blender or os.environ.get('BLENDER') or shutil.which('blender')
    if not exe: sys.exit('Blender not found: put blender on PATH, set BLENDER, or pass --blender <path>')
    with tempfile.TemporaryDirectory() as tmp:
        npz = os.path.join(tmp, 'voxels.npz')
        r = subprocess.run([exe, '-b', '--factory-startup', '-P', os.path.join(HERE, 'blender', 'voxelize.py'), '--',
                            os.path.abspath(model), npz, str(size)], capture_output=True, text=True)
        if r.returncode or not os.path.exists(npz):
            sys.exit(f'Blender could not voxelize {model}:\n' + (r.stderr or r.stdout)[-1500:])
        with np.load(npz) as data: rgba, voxel = data['rgba'], float(data['voxel'])   # closed before the folder goes
    return save_stack(rgba, out, voxel)


def opt(args, name, default=None):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a or a[0] not in ('views', 'glb'): sys.exit(__doc__)
    cmd, a = a[0], a[1:]
    out = opt(a, '--out')
    if not out: sys.exit('--out <dir>/<name> is needed')
    if cmd == 'views':
        back, left = opt(a, '--back'), opt(a, '--left')
        if len(a) != 3: sys.exit('views needs top.png, front.png and side.png')
        save_stack(from_views(*a, back=back, left=left), out)
    else:
        size, exe = int(opt(a, '--size', '48')), opt(a, '--blender')
        if len(a) != 1: sys.exit('glb needs one model file')
        from_glb(a[0], size, out, exe)
