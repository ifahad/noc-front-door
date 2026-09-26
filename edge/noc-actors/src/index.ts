export { SiteState } from "./SiteState";
export { RegionState } from "./RegionState";

export default {
  async fetch(): Promise<Response> {
    return new Response("noc-actors", { status: 200 });
  },
};
