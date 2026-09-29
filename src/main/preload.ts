import { contextBridge, ipcRenderer } from 'electron';
import type { Card, CardStyle, NoteStyle } from '../shared/types';

/**
 * The only surface the overlay page can reach. contextIsolation is on, so the
 * page gets these functions and nothing else - no ipcRenderer, no fs, no
 * require. Every mutation returns the full card list so the page always
 * repaints from authoritative state.
 */
contextBridge.exposeInMainWorld('hazeboard', {
  getCards: (): Promise<Card[]> => ipcRenderer.invoke('gb:getCards'),
  addCard: (text: string, x?: number, y?: number): Promise<Card[]> =>
    ipcRenderer.invoke('gb:addCard', text, x, y),
  addNote: (cardId: string, text: string): Promise<Card[]> =>
    ipcRenderer.invoke('gb:addNote', cardId, text),
  toggleNote: (id: string): Promise<Card[]> => ipcRenderer.invoke('gb:toggleNote', id),
  removeNote: (id: string): Promise<Card[]> => ipcRenderer.invoke('gb:removeNote', id),
  removeCard: (id: string): Promise<Card[]> => ipcRenderer.invoke('gb:removeCard', id),
  moveCard: (id: string, x: number, y: number): Promise<Card[]> =>
    ipcRenderer.invoke('gb:moveCard', id, x, y),
  moveNote: (noteId: string, cardId: string, index: number): Promise<Card[]> =>
    ipcRenderer.invoke('gb:moveNote', noteId, cardId, index),
  detachNote: (noteId: string, x: number, y: number): Promise<Card[]> =>
    ipcRenderer.invoke('gb:detachNote', noteId, x, y),
  setNoteStyle: (noteId: string, style: Partial<NoteStyle>): Promise<Card[]> =>
    ipcRenderer.invoke('gb:setNoteStyle', noteId, style),
  setCardTitle: (id: string, title: string): Promise<Card[]> =>
    ipcRenderer.invoke('gb:setCardTitle', id, title),
  setCardStyle: (id: string, style: Partial<CardStyle>): Promise<Card[]> =>
    ipcRenderer.invoke('gb:setCardStyle', id, style),
  close: (): void => ipcRenderer.send('gb:close'),
});
