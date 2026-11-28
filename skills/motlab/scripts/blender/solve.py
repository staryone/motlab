"""The 3D camera of a real clip, for a three.js scene laid over it: Blender's tracker and camera solver, run with no
window.

    blender -b --factory-startup -P solve.py -- <clip> [--floor X,Y X,Y X,Y] [--at SECONDS] [--focal 35] [--sensor 36]
            [--fixed-focal] [--range FROM TO] [--every 24] [--details 30] [--name camera3d] [--out <clip>.track.json]

Up to --details details are found every --every frames and tracked both ways, the camera is solved with its focal length refined from
--focal (mm, on a --sensor mm wide sensor; 35 on 36 is a normal lens), short and badly placed tracks are dropped,
and it is solved again. --fixed-focal keeps --focal as it is (a known lens).

--floor takes three points in the clip's pixels, at --at seconds, on a flat surface the animation stands on (a
floor, a table): the details nearest to them become the ground, y = 0, with y up. Without it the axes are wherever
the solver put them. The units are the solver's own; the surface's details (points) show how big things are.

Writes an entry into <clip>.track.json (the file track.py and motlab matte write): per frame the camera's world
matrix for three.js (16 numbers, column by column, y up), its vertical field of view, and the solved details as
points. /__motlab/comp.js puts it on a three.js camera with track.setCamera(name, t, camera).
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time

import bpy
from mathutils import Matrix, Vector

# Blender is z up, three.js y up: x stays, y becomes -z, z becomes y. Both cameras look down their -z with y up.
TO_THREE = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))


def times_of(clip):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time',
                          '-of', 'csv=p=0', clip], capture_output=True, text=True, check=True).stdout.split()
    t = sorted(float(v.strip(',')) for v in out if v.strip(',') not in ('', 'N/A'))
    return [v - t[0] for v in t]


def context(clip):
    """an area of the startup window turned into a clip editor: the tracking operators need one, and with
    --factory-startup a window exists even with -b"""
    win = bpy.context.window
    area = max(win.screen.areas, key=lambda a: a.width * a.height)
    area.type = 'CLIP_EDITOR'
    space = next(s for s in area.spaces if s.type == 'CLIP_EDITOR')
    space.clip = clip
    space.mode = 'TRACKING'
    region = next(r for r in area.regions if r.type == 'WINDOW')
    return dict(window=win, screen=win.screen, area=area, region=region, space_data=space, edit_movieclip=clip, clip=clip,
                scene=bpy.context.scene)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('clip')
    ap.add_argument('--floor', nargs=3, metavar='X,Y')
    ap.add_argument('--at', type=float, default=0.0, help='seconds into the clip where the --floor points are')
    ap.add_argument('--focal', type=float, default=35.0, help='focal length in mm, a first guess unless --fixed-focal')
    ap.add_argument('--sensor', type=float, default=36.0, help='sensor width in mm')
    ap.add_argument('--fixed-focal', action='store_true')
    ap.add_argument('--range', type=float, nargs=2, metavar=('FROM', 'TO'))
    ap.add_argument('--every', type=int, default=24, help='find new details every this many frames')
    ap.add_argument('--details', type=int, default=30, help='new details each time, at most: more makes the solve much slower')
    ap.add_argument('--name', default='camera3d')
    ap.add_argument('--out')
    o = ap.parse_args(argv)
    path = os.path.abspath(o.clip)
    out = o.out or os.path.splitext(path)[0] + '.track.json'

    clip = bpy.data.movieclips.load(path)
    scene = bpy.context.scene
    W, H = clip.size
    n = clip.frame_duration
    times = times_of(path)
    if len(times) != n:
        print(f'note: ffprobe counts {len(times)} frames and Blender {n}; Blender takes the frame rate as constant')
    fps = clip.fps
    idx = lambda s: max(0, min(n - 1, int(round(s * fps))))
    lo, hi = (idx(o.range[0]), idx(o.range[1])) if o.range else (0, n - 1)
    first, last = lo + 1, hi + 1   # Blender's frames start at 1
    scene.frame_start, scene.frame_end = first, last
    scene.render.resolution_x, scene.render.resolution_y = W, H

    t = clip.tracking
    cam = t.camera
    cam.units = 'MILLIMETERS'
    cam.sensor_width = o.sensor
    cam.focal_length = o.focal
    cam.principal_point_pixels = (W / 2, H / 2)
    cam.k1 = cam.k2 = cam.k3 = 0
    s = t.settings
    s.default_pattern_size = max(15, round(W / 90)) | 1
    s.default_search_size = max(61, round(W / 16)) | 1
    s.default_motion_model = 'Loc'
    s.use_default_brute = True
    s.default_correlation_min = 0.75
    s.default_margin = 10
    s.use_keyframe_selection = True
    s.refine_intrinsics_focal_length = not o.fixed_focal
    ctx = context(clip)
    print(f'{os.path.basename(path)}: {W}x{H}, {n} frames at {fps:.3f} fps; solving frames {first} to {last}')

    t0 = time.time()
    with bpy.context.temp_override(**ctx):
        for f in range(first, last + 1, max(1, o.every)):
            scene.frame_set(f)
            ctx['space_data'].clip_user.frame_current = f
            before = {tr.name for tr in t.tracks}
            bpy.ops.clip.detect_features(placement='FRAME', margin=16, threshold=0.1, min_distance=max(30, W // 30))
            new = [tr for tr in t.tracks if tr.name not in before]
            if len(new) > o.details:   # keep an even share of them: more only slows the solve
                keep = set(tr.name for tr in new[::math.ceil(len(new) / o.details)])
                for tr in t.tracks:
                    tr.select = tr.name not in before and tr.name not in keep
                bpy.ops.clip.delete_track()
                new = [tr for tr in t.tracks if tr.name in keep]
            for tr in t.tracks:
                tr.select = tr.name not in before
            if not new:
                continue
            bpy.ops.clip.track_markers(backwards=False, sequence=True)
            bpy.ops.clip.track_markers(backwards=True, sequence=True)
        print(f'  {len(t.tracks)} details tracked in {time.time() - t0:.1f} s', flush=True)
        scene.frame_set(first)
        bpy.ops.clip.solve_camera()
        r = t.reconstruction
        if not r.is_valid:
            sys.exit('the camera could not be solved: the shot needs more texture, a longer move, or parallax (a camera that only turns on a tripod has none)')
        print(f'  first solve: error {r.average_error:.2f} px, focal {cam.focal_length:.1f} mm, {time.time() - t0:.1f} s', flush=True)
        # The solver does not give the same answer every run, and a first solve now and then fails in part or leaves
        # the focal length where it started. Drop short and badly placed details and solve again, from the focal
        # length found, until the focal length and the error settle (at most three more times).
        for _ in range(3):
            err, focal = r.average_error, cam.focal_length
            for tr in t.tracks:
                tr.select = True
            bpy.ops.clip.clean_tracks(frames=10, error=max(1.0, 3 * err), action='DELETE_TRACK')
            bpy.ops.clip.solve_camera()
            r = t.reconstruction
            if not r.is_valid:
                sys.exit('the camera could not be solved after dropping the weak details')
            if abs(cam.focal_length - focal) < 0.003 * focal and abs(r.average_error - err) < 0.05 * err:
                break
        print(f'  solved: error {r.average_error:.2f} px over {len(r.cameras)} frames, focal {cam.focal_length:.1f} mm, {len(t.tracks)} details, {time.time() - t0:.1f} s', flush=True)

        # the scene camera follows the solve; --floor turns the world so three details lie on y = 0
        cam_ob = bpy.data.objects.new('camera', bpy.data.cameras.new('camera'))
        scene.collection.objects.link(cam_ob)
        scene.camera = cam_ob
        scene.active_clip = clip
        con = cam_ob.constraints.new('CAMERA_SOLVER')
        con.use_active_clip = True
        if o.floor:
            fa = first + idx(o.at) - lo
            scene.frame_set(fa)
            pts = [tuple(float(v) for v in p.split(',')) for p in o.floor]
            chosen = []
            for x, y in pts:
                best = None
                for tr in t.tracks:
                    if not tr.has_bundle or tr in chosen:
                        continue
                    m = tr.markers.find_frame(fa)
                    if m is None or m.mute:
                        continue
                    d = math.hypot(m.co[0] * W - x, (1 - m.co[1]) * H - y)
                    if best is None or d < best[0]:
                        best = (d, tr)
                if best is None:
                    sys.exit(f'no solved detail near {x:.0f},{y:.0f} at frame {fa}')
                chosen.append(best[1])
                print(f'  floor point {x:.0f},{y:.0f}: detail {best[0]:.0f} px away')
            for tr in t.tracks:
                tr.select = tr in chosen
            bpy.ops.clip.set_plane(plane='FLOOR')
        bpy.context.view_layer.update()
        P = cam_ob.matrix_basis.copy()   # the camera solver constraint gives world = this @ the solved camera

    cams = {c.frame: c.matrix for c in r.cameras}
    matrices, conf = [], []
    for f in range(first, last + 1):
        if f in cams:
            M = TO_THREE @ P @ cams[f]
            matrices.append([round(M[row][col], 6) for col in range(4) for row in range(4)])
            conf.append(1.0)
        else:
            matrices.append(None)
            conf.append(0.0)
    points = []
    for tr in t.tracks:
        if tr.has_bundle:
            v = TO_THREE @ P @ Vector((*tr.bundle, 1.0))
            points.append([round(v[0], 4), round(v[1], 4), round(v[2], 4)])
    f_mm = cam.focal_length
    fov = math.degrees(2 * math.atan(o.sensor * H / W / 2 / f_mm))

    doc = {}
    if os.path.exists(out):
        doc = json.load(open(out, encoding='utf8'))
        if doc.get('width') != W or doc.get('height') != H or len(doc.get('times', [])) != len(times):
            print(f'{out} was made from a different clip; starting it again')
            doc = {}
    doc.update({'clip': os.path.basename(path), 'width': W, 'height': H, 'fps': round(fps, 4), 'times': [round(v, 5) for v in times]})
    doc.setdefault('tracks', {})[o.name] = {
        'kind': 'camera3d', 'first': lo, 'matrix': matrices, 'confidence': conf, 'fov': round(fov, 4), 'focal': round(f_mm, 3),
        'sensor': o.sensor, 'error': round(r.average_error, 3), 'floor': bool(o.floor), 'points': points[:500],
    }
    with open(out, 'w', encoding='utf8') as fh:
        json.dump(doc, fh, separators=(',', ':'))
    print(f'wrote {o.name} into {out}: {sum(c > 0 for c in conf)} of {len(conf)} frames, field of view {fov:.1f} degrees')


main()
