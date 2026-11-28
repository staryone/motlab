"""Voxelize a 3D model for a sprite stack. Run by slices.py glb, or by hand:

    blender -b --factory-startup -P voxelize.py -- <model.glb | .gltf | .obj | .fbx> <out.npz> [size]

Writes out.npz with rgba (uint8, [y][z][x][4], y up, z towards the model's front) and voxel (its size in metres).
size is the number of voxels along the longer side across (x or z; 48 by default).

A voxel is solid when its middle is inside the model (behind the nearest face, as its normal says) or within 0.4 of a
voxel of a face, so thin parts stay. Its colour is the material's at the nearest point of the surface: the image on
the Principled BSDF's Base Color (sampled at the point's UV, the nearest pixel), else that input's colour. Faces need
to point outwards, as they do in a model exported for games or the web.
"""
import os
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

argv = sys.argv[sys.argv.index('--') + 1:]
model, out, size = argv[0], argv[1], int(argv[2]) if len(argv) > 2 else 48

bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(model)[1].lower()
if ext in ('.glb', '.gltf'): bpy.ops.import_scene.gltf(filepath=model)
elif ext == '.obj': bpy.ops.wm.obj_import(filepath=model)
elif ext == '.fbx': bpy.ops.import_scene.fbx(filepath=model)
else: sys.exit(f'voxelize: cannot read {ext} files')

LIN = lambda c: np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)   # linear to sRGB


def base_colour(mat):
    """(image pixels as an [h][w][4] array, or None, and the flat sRGB colour) for a material."""
    if not mat or not mat.use_nodes: return None, np.array([0.8, 0.8, 0.8])
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf: return None, np.array([0.8, 0.8, 0.8])
    sock = bsdf.inputs['Base Color']
    node, seen = (sock.links[0].from_node if sock.links else None), 0
    while node and node.type != 'TEX_IMAGE' and seen < 4:   # through a mix or a colour multiply to the image
        node = next((i.links[0].from_node for i in node.inputs if i.links), None); seen += 1
    flat = LIN(np.array(sock.default_value[:3]))
    if node and node.type == 'TEX_IMAGE' and node.image and node.image.size[0]:
        img = node.image; w, h = img.size
        return np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4), flat
    return None, flat


# Every triangle of every mesh in world space, with its UVs and what colours it.
depsgraph = bpy.context.evaluated_depsgraph_get()
verts, tris, uvs, looks, tri_look = [], [], [], [], []
look_of = {}
for obj in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
    ev = obj.evaluated_get(depsgraph); mesh = ev.to_mesh(); mesh.calc_loop_triangles()
    mw, base = obj.matrix_world, len(verts)
    verts += [mw @ v.co for v in mesh.vertices]
    uv = mesh.uv_layers.active.data if mesh.uv_layers.active else None
    for lt in mesh.loop_triangles:
        tris.append([base + i for i in lt.vertices])
        uvs.append([uv[l].uv.copy() if uv else Vector((0, 0)) for l in lt.loops])
        mat = obj.material_slots[lt.material_index].material if obj.material_slots else None
        if mat not in look_of: look_of[mat] = len(looks); looks.append(base_colour(mat))
        tri_look.append(look_of[mat])
    ev.to_mesh_clear()
if not tris: sys.exit('voxelize: the file has no mesh')
tree = BVHTree.FromPolygons(verts, tris)

# The grid: Blender is z up with the front towards -y; the stack is y up with the front towards +z.
co = np.array([v[:] for v in verts])
lo, hi = co.min(0), co.max(0)
voxel = max(hi[0] - lo[0], hi[1] - lo[1]) / size
n = np.maximum(1, np.ceil((hi - lo) / voxel).astype(int))
rgba = np.zeros((n[2], n[1], n[0], 4), np.uint8)
for zi in range(n[2]):
    for yi in range(n[1]):
        for xi in range(n[0]):
            p = Vector((lo[0] + (xi + 0.5) * voxel, hi[1] - (yi + 0.5) * voxel, lo[2] + (zi + 0.5) * voxel))
            hit, normal, idx, dist = tree.find_nearest(p)
            if hit is None: continue
            if (p - hit).dot(normal) > 0 and dist > voxel * 0.4: continue   # outside, and no face cuts into its middle
            a, b, c = (verts[i] for i in tris[idx])
            u = barycentric_transform(hit, a, b, c, *(uv.to_3d() for uv in uvs[idx]))
            img, flat = looks[tri_look[idx]]
            if img is not None:
                h, w = img.shape[:2]
                px = img[min(h - 1, max(0, int((u[1] % 1) * h))), min(w - 1, max(0, int((u[0] % 1) * w)))]
                rgb = px[:3]
            else: rgb = flat
            rgba[zi, yi, xi, :3] = np.clip(np.round(np.asarray(rgb) * 255), 0, 255)
            rgba[zi, yi, xi, 3] = 255
np.savez(out, rgba=rgba, voxel=voxel)
print(f'voxelize: {n[0]} x {n[1]} x {n[2]} voxels of {voxel:.4f} m, {int((rgba[..., 3] > 0).sum())} solid')
