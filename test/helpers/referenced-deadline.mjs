// Mocked pending operations have no socket/host handle to keep production unref'ed
// deadlines alive. This test-owned deadline supplies that handle and bounds hangs.
export async function withReferencedDeadline(operation, timeoutMs = 5_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Test operation did not settle within ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
