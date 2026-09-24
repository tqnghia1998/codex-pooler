// Polls share in-flight work; explicit refreshes run after it to observe mutations.
export function createRefreshQueue() {
  let pending = null;
  return (task, { background = false } = {}) => {
    if (pending && background) return pending;
    const next = (pending || Promise.resolve()).catch(() => {}).then(task);
    const result = next.finally(() => {
      if (pending === result) pending = null;
    });
    pending = result;
    return result;
  };
}
