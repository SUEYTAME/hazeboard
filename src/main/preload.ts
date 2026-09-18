import { contextBridge, ipcRenderer } from 'electron';
import type { Note } from '../shared/types';

/**
 * The only surface the editor page can reach. contextIsolation is on, so the
 * page gets these functions and nothing else - no ipcRenderer, no fs, no
 * require.
 */
contextBridge.exposeInMainWorld('glassboard', {
  getNotes: (): Promise<Note[]> => ipcRenderer.invoke('gb:getNotes'),
  add: (text: string): Promise<Note[]> => ipcRenderer.invoke('gb:add', text),
  toggle: (id: string): Promise<Note[]> => ipcRenderer.invoke('gb:toggle', id),
  remove: (id: string): Promise<Note[]> => ipcRenderer.invoke('gb:remove', id),
  clearDone: (): Promise<Note[]> => ipcRenderer.invoke('gb:clearDone'),
  close: (): void => ipcRenderer.send('gb:close'),
  resize: (height: number): void => ipcRenderer.send('gb:resize', height),
});
