// Re-export the actor class from the entry point so it is bundled and shipped
// with the function (the runtime resolves the [[actors]] type here; the
// exported class name must equal the type).
export { Counter } from "./counter";

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const counter = env.COUNTER.idFromName("demo");
    const value = await counter.increment(1);

    return Response.json({ value });
  },
};
