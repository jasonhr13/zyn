// Last-write-wins status flush. Target can re-emit a new step per task many times a second;
// one IPC + Redux update per change is enough to stall the Task Groups page. Buffer the latest
// payload per id and send it once per interval. Terminal statuses (running === false) flush
// immediately so Stop still feels instant.
const STATUS_FLUSH_MS = 64;

function createStatusCoalescer({
  send,
  intervalMs = STATUS_FLUSH_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('createStatusCoalescer requires send()');
  const pending = new Map();
  let timer = null;

  function flush() {
    timer = null;
    if (!pending.size) return;
    const batch = [...pending.values()];
    pending.clear();
    send(batch);
  }

  function cancelTimer() {
    if (timer == null) return;
    clearTimeoutFn(timer);
    timer = null;
  }

  function enqueue(id, payload, { immediate = false } = {}) {
    pending.set(id == null ? '' : String(id), payload);
    if (immediate) {
      cancelTimer();
      flush();
      return;
    }
    if (timer == null) timer = setTimeoutFn(flush, intervalMs);
  }

  function drop(id) {
    pending.delete(id == null ? '' : String(id));
  }

  function dropAll() {
    pending.clear();
    cancelTimer();
  }

  function flushNow() {
    cancelTimer();
    flush();
  }

  return { enqueue, drop, dropAll, flushNow };
}

module.exports = { createStatusCoalescer, STATUS_FLUSH_MS };
