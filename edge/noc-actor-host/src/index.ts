import type { ActorNamespace, ActorStub, Env, IdFromNameOptions } from "@telnyx/edge-runtime";

export { Counter } from "./MuxHost";

interface IncrementStub extends ActorStub {
  increment(n: number): Promise<number>;
}

interface CounterNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): IncrementStub;
}

interface FetchEnv extends Env {
  COUNTER: CounterNamespace;
}

export default {
  async fetch(request: Request, env: FetchEnv): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name") ?? "demo";
    const value = await env.COUNTER.idFromName(name).increment(1);
    return Response.json({ value });
  },
};
