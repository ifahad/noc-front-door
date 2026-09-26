const PHONE_RE = /\+[0-9]{8,15}(?![0-9])/g;

export function mask(value: string): string {
  return value.replace(PHONE_RE, (m) => `${m.slice(0, 5)}****${m.slice(-3)}`);
}
