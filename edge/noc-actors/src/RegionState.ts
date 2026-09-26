import { StatefulActor } from "@telnyx/edge-runtime";

export class RegionState extends StatefulActor {
  async ping(): Promise<{ pong: true; name: string }> {
    return { pong: true, name: String(this.ctx.id) };
  }
}
