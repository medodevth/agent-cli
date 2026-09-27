import { PatchQueueManager } from './DiffPatch.js';

/** 75. Factory helper for an independent FIFO patch queue. */
export function patchQueueManager(): PatchQueueManager {
  return PatchQueueManager.create();
}
