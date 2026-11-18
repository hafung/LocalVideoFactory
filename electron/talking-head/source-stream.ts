import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export async function streamTalkSource(file: URL, request: Request): Promise<Response> {
  const { size } = await stat(file);
  const headers = new Headers({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
  const range = request.headers.get('range');
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
    if (match?.[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else if (match?.[2]) {
      start = Math.max(0, size - Number(match[2]));
    } else {
      start = size;
    }
    if (start > end || !Number.isSafeInteger(start)) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  const body = request.method === 'HEAD' || size === 0
    ? null : Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array<ArrayBuffer>>;
  return new Response(body, { status: range ? 206 : 200, headers });
}
