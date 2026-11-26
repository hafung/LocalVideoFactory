import { ipcMain, protocol, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { ConfigureOnlineSourceSchema, OnlineSearchSchema, type ConfigureOnlineSource } from '../../../shared/library.js';
import type { OnlineMediaService } from './service.js';

export function registerOnlineMedia(service: OnlineMediaService, configure: (value: ConfigureOnlineSource) => void) {
  const active = new Map<string, AbortController>();
  const idSchema = z.string().uuid();
  const operationKey = (event: IpcMainInvokeEvent, id: unknown) => `${event.sender.id}:${idSchema.parse(id)}`;

  async function run<T>(event: IpcMainInvokeEvent, id: unknown, operation: (signal: AbortSignal) => Promise<T>) {
    const key = operationKey(event, id);
    if (active.has(key)) throw new Error('在线请求已在处理');
    const controller = new AbortController();
    const abort = () => controller.abort();
    active.set(key, controller);
    event.sender.once('destroyed', abort);
    try { return await operation(controller.signal); }
    finally {
      active.delete(key);
      event.sender.off('destroyed', abort);
    }
  }

  ipcMain.handle('online:status', () => service.status());
  ipcMain.handle('online:configure', (_event, value: unknown) => {
    const update = ConfigureOnlineSourceSchema.parse(value);
    configure(update);
    if (update.key !== undefined) service.credentialsChanged(update.source);
    return service.status();
  });
  ipcMain.handle('online:cancel', (event, id: unknown) => active.get(operationKey(event, id))?.abort());
  ipcMain.handle('online:search', (event, id: unknown, value: unknown) =>
    run(event, id, signal => service.search(OnlineSearchSchema.parse(value), signal)));
  ipcMain.handle('online:download', (event, id: unknown, itemId: unknown) =>
    run(event, id, signal => service.downloadSelected(idSchema.parse(itemId), signal)));

  protocol.handle('voxweave-online', request => {
    const url = new URL(request.url);
    const kind = url.pathname.slice(1);
    if (request.method !== 'GET' || !idSchema.safeParse(url.hostname).success || (kind !== 'thumbnail' && kind !== 'preview'))
      return new Response(null, { status: 404 });
    return service.preview(url.hostname, kind, request);
  });
}
