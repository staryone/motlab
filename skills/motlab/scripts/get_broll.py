"""Find and download stock video for B-roll from Pexels (pexels.com) into a project.

  python get_broll.py search "city street at night" [--orientation landscape|portrait|square] [--min 4] [--max 30] [--n 15]
      Lists matches: id, length, the largest size, frame rate, who made it and its page on Pexels (at most 80).
      --min and --max keep videos of that many seconds; --orientation matches the video's shape to the frame.

  python get_broll.py get <id> [<id> ...] [--height 1080] [--out footage/broll]
      Downloads each video as <name>-<id>.mp4, in the smallest MP4 whose short side is at least --height (else the
      largest), and adds a credit line to CREDITS.md in the same folder.

Needs a free API key from https://www.pexels.com/api/ in the PEXELS_API_KEY environment variable; the user makes it
with their own Pexels account. The API allows 200 requests an hour and 20,000 a month: search is one request (two with
--min or --max), and get is one per video plus the download.
Pexels videos are free to use and need no credit (https://www.pexels.com/license/, read 2026-11-28), but identifiable
people may not be shown in a bad light or seem to endorse a product, and an unaltered copy may not be sold. The
license says nothing about model releases. CREDITS.md keeps the maker and the page anyway, as Pexels asks.
"""
import json, os, re, ssl, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path

API = 'https://api.pexels.com/v1/videos/'
UA = 'motlab-get-broll'


def fetch(url, key=None):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **({'Authorization': key} if key else {})})
    try: return urllib.request.urlopen(req, timeout=120).read()
    except urllib.error.HTTPError as e:
        hint = ' (the key in PEXELS_API_KEY was refused)' if e.code in (401, 403) else ' (over the limit of 200 requests an hour)' if e.code == 429 else ''
        sys.exit(f'{url.split("?")[0]}: HTTP {e.code}{hint}')
    except urllib.error.URLError as e:
        # A Windows certificate store can hold an expired intermediate that breaks a valid chain; certifi's bundle,
        # when installed, verifies it (as in get_sfx.py).
        if not isinstance(e.reason, ssl.SSLCertVerificationError): raise
        try: import certifi
        except ImportError: sys.exit(f'{url}: {e.reason}. pip install certifi, then try again')
        return urllib.request.urlopen(req, timeout=120, context=ssl.create_default_context(cafile=certifi.where())).read()


def api_key():
    key = os.environ.get('PEXELS_API_KEY', '').strip()
    if not key: sys.exit('Set PEXELS_API_KEY to a Pexels API key first. The user gets one free at https://www.pexels.com/api/')
    return key


def opt(args, name, default):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default


def mp4s(video):
    return [f for f in video.get('video_files', []) if f.get('file_type') == 'video/mp4' and f.get('width') and f.get('height')]


def pick_file(video, height):
    """The smallest MP4 whose short side is at least `height`, else the largest."""
    files = sorted(mp4s(video), key=lambda f: min(f['width'], f['height']))
    if not files: return None
    return next((f for f in files if min(f['width'], f['height']) >= height), files[-1])


def name_of(video):
    """The words of the video's page address, e.g. aerial-view-of-a-city for .../video/aerial-view-of-a-city-857195/."""
    path = urllib.parse.urlparse(video.get('url') or '').path.rstrip('/').split('/')[-1]
    slug = re.sub(r'-?\d+$', '', path)
    return re.sub(r'[^a-z0-9-]+', '-', slug.lower()).strip('-')[:40] or 'video'


def search(args):
    orient, n = opt(args, '--orientation', None), int(opt(args, '--n', '15'))
    lo, hi = float(opt(args, '--min', '0')), float(opt(args, '--max', '0'))
    if orient not in (None, 'landscape', 'portrait', 'square'): sys.exit('--orientation is landscape, portrait or square')
    if not args: sys.exit('search needs words, e.g. search "city street at night"')
    key, rows, total = api_key(), [], 0
    q = {'query': ' '.join(args)[:200], 'per_page': 80 if lo or hi else min(max(n, 1), 80), **({'orientation': orient} if orient else {})}
    for page in (1, 2) if lo or hi else (1,):
        d = json.loads(fetch(API + 'search?' + urllib.parse.urlencode({**q, 'page': page}), key))
        total = d.get('total_results', 0)
        rows += [v for v in d.get('videos', []) if v['duration'] >= lo and (not hi or v['duration'] <= hi)]
        if len(rows) >= n or not d.get('next_page'): break
    rows = rows[:n]
    if not rows: print('no matches'); return
    for v in rows:
        big = max(mp4s(v), key=lambda f: f['width'] * f['height'], default=None)
        size = f"{big['width']}x{big['height']}" if big else '?'
        fps = f"{round(big['fps'])} fps" if big and big.get('fps') else ''
        print(f"{v['id']:>9}  {v['duration']:3d} s  {size:>9} {fps:>6}  {v['user']['name'][:20]:20s} {v['url']}")
    print(f"{len(rows)} of {total} matches. Look at a page before choosing. Get with: python get_broll.py get <id> ... --out footage/broll")


def get(args):
    out, height = Path(opt(args, '--out', 'footage/broll')), int(opt(args, '--height', '1080'))
    if not args: sys.exit('get needs one or more ids from search')
    key = api_key()
    out.mkdir(parents=True, exist_ok=True)
    credits = out / 'CREDITS.md'
    text = credits.read_text(encoding='utf-8') if credits.exists() else ('# Video credits\n\nVideos from Pexels (https://www.pexels.com/license/). '
                                                                        'A credit is not required; keep this file with the project.\n\n')
    for id in args:
        if not id.isdigit(): sys.exit(f'"{id}" is not a Pexels video id (a number from search)')
        v = json.loads(fetch(API + 'videos/' + id, key))
        f = pick_file(v, height)
        if not f: print(f'{id}: no MP4 file, skipped'); continue
        path = out / f'{name_of(v)}-{id}.mp4'
        if not path.exists(): path.write_bytes(fetch(f['link']))
        fps = f" at {round(f['fps'])} fps" if f.get('fps') else ''
        if f'(id {id}' not in text: text += f"- `{path.name}`: video by {v['user']['name']} on Pexels, {v['url']} (id {id}, {f['width']}x{f['height']}{fps})\n"
        print(f"{path}  {v['duration']} s  {f['width']}x{f['height']}{fps}")
    credits.write_text(text, encoding='utf-8'); print(f'credits -> {credits}')


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a or a[0] not in ('search', 'get'): sys.exit(__doc__)
    (search if a[0] == 'search' else get)(a[1:])
