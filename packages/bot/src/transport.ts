/** Every producer request has a deadline, including cancellable queue exports. */
export function requestWithDeadline(
  url: URL,
  init: RequestInit,
  timeoutMs = 10000,
  send: typeof fetch = fetch,
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline;
  return send(url, { ...init, signal });
}
