import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import path from 'node:path';
const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const ffmpeg = path.join(root, 'resources/ffmpeg/ffmpeg.exe');
const directory = path.join(root, '.windows-smoke/preview-export-regression');
async function crop(file, time) {
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-ss', time.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'crop=400:120:120:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}
function difference(a, b) { return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length; }
for (const rate of [2, 4, .5]) {
  const actual = await crop(path.join(directory, `export-${rate}x.mp4`), .4);
  const expected = await crop(path.join(directory, 'source.mp4'), .4 * rate);
  const unchanged = await crop(path.join(directory, 'source.mp4'), .4);
  const correctError = difference(actual, expected), wrongError = difference(actual, unchanged);
  console.log({ rate, correctError, wrongError });
  assert.ok(correctError < wrongError, 'Video motion did not match the selected speed');
}
