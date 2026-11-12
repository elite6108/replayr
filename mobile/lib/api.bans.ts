import type { Href } from "expo-router";
import { staffFetch } from "./api.staff";

export type AccessBan = {
  id: string;
  kind: "account" | "ip";
  subject: string;
  label: string;
  reason: string;
  createdAt: string;
};

export function staffBansHref(): Href {
  return "/staff/bans" as Href;
}

export function fetchAccessBans(token: string) {
  return staffFetch<{ bans: AccessBan[] }>("/v1/admin/bans", token);
}

export function createAccessBan(
  token: string,
  body: { kind: "account"; userId: string; reason: string } | { kind: "ip"; ip: string; reason: string },
) {
  return staffFetch<{ ban: AccessBan }>("/v1/admin/bans", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function liftAccessBan(token: string, banId: string) {
  return staffFetch<{ ok: boolean }>(`/v1/admin/bans/${banId}/lift`, token, { method: "POST" });
}
