export { SiteActor } from "./SiteActor";
export { RegionActor } from "./RegionActor";

export default {
  async fetch(): Promise<Response> {
    return new Response("noc-actors", { status: 200 });
  },
};
