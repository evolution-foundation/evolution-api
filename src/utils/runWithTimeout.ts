/**
 * Waits for `task` up to `ms` and returns whether it timed out. The task is not cancelled:
 * it keeps running, the caller just stops waiting for it.
 */
export async function runWithTimeout(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });

  try {
    return await Promise.race([task.then(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
