import { isFresh, verifyTelnyxSignature } from "../../../shared/src/ed25519";

export type SignedResult =
  | "ok"
  | "absent"
  | "invalid"
  | "error"
  | "stale"
  | "no_key";

export async function verifySigned(
  request: Request,
  rawBody: string,
  publicKey: string,
  now: number,
): Promise<SignedResult> {
  if (publicKey === "") return "no_key";
  const sig = await verifyTelnyxSignature(request.headers, rawBody, publicKey);
  if (sig !== "valid") return sig;
  if (!isFresh(request.headers.get("telnyx-timestamp"), Math.floor(now / 1000))) {
    return "stale";
  }
  return "ok";
}
