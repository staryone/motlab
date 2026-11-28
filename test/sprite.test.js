import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asepriteFrames, frameAt, tagFrames } from '../src/page/sprite.js';

// Frame indices at the middle of each 100 ms step.
const play = (tag, steps, ms = [100, 100, 100, 100, 100]) => Array.from({ length: steps }, (_, i) => frameAt(i * 0.1 + 0.05, tagFrames(tag), ms)).join('');

test('tags play as Aseprite plays them: forward, reverse and ping-pong, each end once a round', () => {
  assert.equal(play({ from: 1, to: 3 }, 8), '12312312');
  assert.equal(play({ from: 1, to: 3, direction: 'reverse' }, 8), '32132132');
  assert.equal(play({ from: 0, to: 3, direction: 'pingpong' }, 12), '012321012321');
  assert.equal(play({ from: 0, to: 3, direction: 'pingpong_reverse' }, 12), '321012321012');
  assert.equal(play({ from: 2, to: 2, direction: 'pingpong' }, 3), '222');
  assert.throws(() => tagFrames({ from: 0, to: 1, direction: 'sideways' }), /unknown tag direction "sideways"/);
});

test('repeat plays that many passes, a ping-pong pass being one way, then holds the last frame', () => {
  assert.equal(play({ from: 1, to: 3, repeat: '2' }, 9), '123123333');
  assert.equal(play({ from: 0, to: 2, direction: 'pingpong', repeat: '3' }, 10), '0121012222');
  assert.equal(play({ from: 0, to: 2, direction: 'pingpong', repeat: '0' }, 6), '012101');   // 0 is written as no repeat: it loops
  assert.equal(frameAt(-1, tagFrames({ from: 1, to: 3 }), [100, 100, 100, 100]), 1);
});

test('each frame shows for its own duration', () => {
  const ms = [100, 300, 50];
  const at = t => frameAt(t, tagFrames({ from: 0, to: 2 }), ms);
  assert.deepEqual([0, 0.099, 0.1, 0.399, 0.4, 0.449, 0.45, 0.5].map(at), [0, 0, 1, 1, 2, 2, 0, 0]);
});

test('Aseprite frames read the same from the hash and the array export, trimmed ones keeping their place', () => {
  const frame = (x, trimmed) => ({ frame: { x, y: 0, w: trimmed ? 8 : 16, h: 16 }, rotated: false, trimmed,
    spriteSourceSize: { x: trimmed ? 4 : 0, y: 0, w: trimmed ? 8 : 16, h: 16 }, sourceSize: { w: 16, h: 16 }, duration: trimmed ? 250 : 100 });
  const hash = { frames: { 'a 0.aseprite': frame(0, false), 'a 1.aseprite': frame(16, true) } };
  const array = { frames: [{ filename: 'a 0.aseprite', ...frame(0, false) }, { filename: 'a 1.aseprite', ...frame(16, true) }] };
  const want = [{ x: 0, y: 0, w: 16, h: 16, ox: 0, oy: 0, sw: 16, sh: 16, ms: 100 }, { x: 16, y: 0, w: 8, h: 16, ox: 4, oy: 0, sw: 16, sh: 16, ms: 250 }];
  assert.deepEqual(asepriteFrames(hash), want);
  assert.deepEqual(asepriteFrames(array), want);
  assert.throws(() => asepriteFrames({ meta: {} }), /no frames/);
});
