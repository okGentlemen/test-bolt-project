import { atom } from 'nanostores';

interface FileSyncEvent {
  path: string;
  content: string | Uint8Array;
}

export const fileSyncStore = atom<FileSyncEvent | null>(null);

export const syncFile = (path: string, content: string | Uint8Array) => {
  fileSyncStore.set({ path, content });
}; 