import { map } from 'nanostores';
import type { User } from '~/components/header/Header';

interface ChatState {
  id: string;
  started: boolean;
  aborted: boolean;
  showChat: boolean;
  projectType: string;
  pendingMessage: string | null;
  user: User | null;
}

const defaultState: ChatState = {
  id: '', 
  started: false,
  aborted: false,
  showChat: true,
  projectType: '',
  pendingMessage: null,
  user: null,
};

export const chatStore = map<ChatState>('chat', defaultState);
