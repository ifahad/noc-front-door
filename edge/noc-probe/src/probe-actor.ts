import { StatefulActor, type AlarmInfo } from "@telnyx/edge-runtime";
import { logEvent } from "./log";

export interface ArmedInfo {
  when: number;
  token: string;
  armedAt: number;
}

export interface FiredInfo {
  firedAt: number;
  lagMs: number;
  retryCount: number;
  token: string;
}

export interface ActorStatus {
  armed: ArmedInfo | null;
  fired: FiredInfo | null;
  pendingAlarm: number | null;
  actorEnvKeys: string[];
}

export class ProbeActor extends StatefulActor {
  async armAlarm(
    delayMs: number,
    token: string
  ): Promise<{ armedFor: number; token: string }> {
    const armedAt = Date.now();
    const when = armedAt + delayMs;
    await this.ctx.storage.put("alarm_armed", {
      when,
      token,
      armedAt,
    } satisfies ArmedInfo);
    await this.ctx.storage.setAlarm(when);
    logEvent("actor_log_probe", { where: "armAlarm", delay_ms: delayMs });
    return { armedFor: when, token };
  }

  override async alarm(info: AlarmInfo): Promise<void> {
    const armed = await this.ctx.storage.get<ArmedInfo>("alarm_armed");
    const firedAt = Date.now();
    const lagMs = armed ? firedAt - armed.when : -1;
    await this.ctx.storage.put("alarm_fired", {
      firedAt,
      lagMs,
      retryCount: info.retryCount,
      token: armed?.token ?? "unknown",
    } satisfies FiredInfo);
    logEvent("actor_log_probe", {
      where: "alarm",
      retryCount: info.retryCount,
      lagMs,
    });
  }

  async status(): Promise<ActorStatus> {
    const armed = await this.ctx.storage.get<ArmedInfo>("alarm_armed");
    const fired = await this.ctx.storage.get<FiredInfo>("alarm_fired");
    const pendingAlarm = await this.ctx.storage.getAlarm();
    return {
      armed: armed ?? null,
      fired: fired ?? null,
      pendingAlarm,
      actorEnvKeys: Object.keys(this.env ?? {}),
    };
  }

  async ping(): Promise<number> {
    return Date.now();
  }
}
