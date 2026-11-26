import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/motlab/scripts/mix.py', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';

for (const duration of [0.25, 0.75, 1.25, 2]) {
  test(`mix beds: ${duration}s span fits fades and reaches its level`, () => {
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
fi, fo = 24000, 48000
if n < fi + fo:
    fi = int(n / 3)
    fo = n - fi
    assert fi + fo == n
expected[:fi] *= np.linspace(0, 1, fi) ** 2
expected[-fo:] *= np.linspace(1, 0, fo) ** 2
np.testing.assert_allclose(out[:n], np.repeat(expected[:, None], 2, axis=1))
assert out[0, 0] == out[n - 1, 0] == 0
np.testing.assert_allclose(out[:n].max(), mix.db(-26))
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

test('mix beds: clips beds starting before 0 s or past the end of the mix instead of crashing', () => {
  const result = spawnSync(python, ['-c', `
import contextlib, importlib.util, io, sys
import numpy as np
spec = importlib.util.spec_from_file_location('mix', sys.argv[1])
mix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mix)
out = np.zeros((mix.RATE, 2))
with contextlib.redirect_stdout(io.StringIO()):
    mix.add_bed(out, {'file': 'pre', 'at': 0, 'offset': -0.2, 'to': 0.5, 'fade_in': 0, 'fade_out': 0}, np.ones((100, 2)), -26, mix.Timeline({}, 0), 1)
    mix.add_bed(out, {'file': 'late', 'at': 2.0, 'to': 3.0}, np.ones((100, 2)), -26, mix.Timeline({}, 0), 1)
    mix.add_bed(out, {'file': 'before', 'at': -1.0, 'to': -0.2}, np.ones((100, 2)), -26, mix.Timeline({}, 0), 1)
half = mix.RATE // 2
np.testing.assert_allclose(out[:half], mix.db(-26))
assert not out[half:].any()
`, script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});
