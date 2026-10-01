import { act } from 'preact/test-utils';

export async function waitForCondition(description, condition, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${description}.`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}
