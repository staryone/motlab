import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/motlab/scripts/mix.py', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';

for (const duration of [0.25, 0.75, 1.25, 2]) {
  test(`mix beds: ${duration}s span bounds and multiplies overlapping fades`, () => {
    const result = spawnSync(python, ['-c', `
import contextlib, importlib.util, io, sys
import numpy as np
spec = importlib.util.spec_from_file_location('mix', sys.argv[1])
mix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mix)
n = int(float(sys.argv[2]) * mix.RATE)
out = np.zeros((n + 10, 2))
with contextlib.redirect_stdout(io.StringIO()):
    mix.add_bed(out, {'file': 'tone', 'at': 0, 'to': float(sys.argv[2])}, np.ones((100, 2)), -26, mix.Timeline({}, 0), 3)
expected = np.full(n, mix.db(-26))
fi, fo = min(n, 24000), min(n, 48000)
expected[:fi] *= np.linspace(0, 1, fi) ** 2
expected[-fo:] *= np.linspace(1, 0, fo) ** 2
np.testing.assert_allclose(out[:n], np.repeat(expected[:, None], 2, axis=1))
assert out[0, 0] == out[n - 1, 0] == 0
assert out[:n].max() > 0
assert not out[n:].any()
`, script, String(duration)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  });
}

for (const duration of [0, -0.25]) {
  test(`mix beds: rejects a ${duration}s span`, () => {
    const result = spawnSync(python, ['-c', `
import importlib.util, sys
import numpy as np
spec = importlib.util.spec_from_file_location('mix', sys.argv[1])
mix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mix)
mix.add_bed(np.zeros((48000, 2)), {'file': 'tone', 'at': 0, 'to': float(sys.argv[2])}, np.ones((100, 2)), -26, mix.Timeline({}, 0), 1)
`, script, String(duration)], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.error?.message || result.stderr);
    assert.match(result.stderr, /bed tone ends before it starts/);
  });
}
