import { logEvent } from "./log";

export type DeadlineResult<T> = { ok: true; value: T } | { ok: false; timeout: true };

export function deadline<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<DeadlineResult<T>> {
  p.catch((err: unknown) => {
    logEvent({
      svc: "shared",
      hop: "timing",
      evt: "late_rejection",
      lvl: "warn",
      label,
      err: String(err),
    });
  });
  return new Promise<DeadlineResult<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, timeout: true });
    }, ms);
    p.then(
      (value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, timeout: true });
      },
    );
  });
}
