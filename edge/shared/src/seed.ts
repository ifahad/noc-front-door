import type { Site } from "./types";

export const CUSTOMERS: { customer_id: string; name: string }[] = [
  { customer_id: "c-alwaha", name: "Al-Waha Pharmacies" },
  { customer_id: "c-rawda", name: "Rawda Cafés" },
];

export const REGIONS: { region: string; code: string; label: string }[] = [
  { region: "riyadh-north", code: "1", label: "Riyadh North" },
  { region: "riyadh-south", code: "2", label: "Riyadh South" },
  { region: "jeddah", code: "3", label: "Jeddah" },
  { region: "dammam", code: "4", label: "Dammam" },
  { region: "lab", code: "9", label: "Lab" },
];

export const SITES: Site[] = [
  { site_id: "RUH-114", code: "14", customer_id: "c-alwaha", label: "the Al Yasmin branch", region: "riyadh-north", region_label: "Riyadh North" },
  { site_id: "RUH-121", code: "21", customer_id: "c-alwaha", label: "the Al Malqa branch", region: "riyadh-north", region_label: "Riyadh North" },
  { site_id: "RUH-133", code: "33", customer_id: "c-alwaha", label: "the Hittin branch", region: "riyadh-north", region_label: "Riyadh North" },
  { site_id: "RUH-207", code: "27", customer_id: "c-alwaha", label: "the RUH-207 branch", region: "riyadh-south", region_label: "Riyadh South" },
  { site_id: "JED-007", code: "07", customer_id: "c-alwaha", label: "the JED-007 branch", region: "jeddah", region_label: "Jeddah" },
  { site_id: "JED-015", code: "15", customer_id: "c-alwaha", label: "the JED-015 branch", region: "jeddah", region_label: "Jeddah" },
  { site_id: "DMM-003", code: "03", customer_id: "c-alwaha", label: "the DMM-003 branch", region: "dammam", region_label: "Dammam" },
  { site_id: "DMM-011", code: "11", customer_id: "c-alwaha", label: "the DMM-011 branch", region: "dammam", region_label: "Dammam" },
  { site_id: "JED-900", code: "90", customer_id: "c-rawda", label: "the JED-900 branch", region: "jeddah", region_label: "Jeddah" },
  { site_id: "TST-001", code: "99", customer_id: "c-lab", label: "the Lab branch", region: "lab", region_label: "Lab", hidden: true },
];

export interface ContactSeed {
  contact_id: string;
  name: string;
  customer_id: string;
  site_id: string;
  preferred_language: "en" | "ar";
}

export const CONTACT_SEED: ContactSeed[] = [
  { contact_id: "c-ahmed", name: "Ahmed", customer_id: "c-alwaha", site_id: "RUH-114", preferred_language: "en" },
  { contact_id: "c-sara", name: "Sara", customer_id: "c-alwaha", site_id: "RUH-121", preferred_language: "en" },
  { contact_id: "c-khalid", name: "Khalid", customer_id: "c-alwaha", site_id: "RUH-133", preferred_language: "ar" },
  { contact_id: "c-noura", name: "Noura", customer_id: "c-rawda", site_id: "JED-900", preferred_language: "en" },
];

export const NMS_ALARM_DEVICE = "edge router";

export const NMS_BY_REGION: Record<string, { state: "up" | "down"; alarms: string[]; device: string }> = {
  "riyadh-north": { state: "down", alarms: ["WAN link down", "LTE backup down"], device: NMS_ALARM_DEVICE },
  "riyadh-south": { state: "up", alarms: [], device: NMS_ALARM_DEVICE },
  jeddah: { state: "up", alarms: [], device: NMS_ALARM_DEVICE },
  dammam: { state: "up", alarms: [], device: NMS_ALARM_DEVICE },
  lab: { state: "up", alarms: [], device: NMS_ALARM_DEVICE },
};

export const NMS_DOWN_LOCAL_HOUR = 1;
export const NMS_DOWN_LOCAL_MINUTE = 52;
