import type { FunPlayApi } from '../shared/types';

declare global {
  interface Window {
    funplay: FunPlayApi;
  }
}

export {};
