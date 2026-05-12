export interface SendQueue {
  enqueue: (targetKey: string, sendFn: () => Promise<void>) => void;
  pendingCount: (targetKey: string) => number;
}

export function createSendQueue(options: { interSendDelayMs?: number } = {}): SendQueue {
  const interSendDelayMs = options.interSendDelayMs ?? 350;
  const targetChains = new Map<string, Promise<void>>();

  const enqueue = (targetKey: string, sendFn: () => Promise<void>): void => {
    const prev: Promise<void> = targetChains.get(targetKey) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(async () => {
        await sendFn();
      })
      .then(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, interSendDelayMs);
          }),
      )
      .catch(() => {
        // Swallow errors to keep the chain alive.
        // Errors are logged by the deliver callback's onError handler.
      });
    targetChains.set(targetKey, next);
  };

  const pendingCount = (targetKey: string): number => {
    return targetChains.has(targetKey) ? 1 : 0;
  };

  return { enqueue, pendingCount };
}
