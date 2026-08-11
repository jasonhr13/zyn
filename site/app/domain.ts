export type DomainService = "site" | "license" | "updates";

export const LEGACY_DOMAIN = "rcart.app";
export const ZYN_DOMAIN = "zynbot.app";

export function rootDomainForHostname(hostname: string) {
  const normalized = String(hostname || "").trim().toLowerCase().replace(/\.$/, "").split(":")[0];
  return normalized === ZYN_DOMAIN || normalized.endsWith(`.${ZYN_DOMAIN}`)
    ? ZYN_DOMAIN
    : LEGACY_DOMAIN;
}

export function serviceOriginForHostname(hostname: string, service: DomainService) {
  const root = rootDomainForHostname(hostname);
  const prefix = service === "site" ? "" : `${service}.`;
  return `https://${prefix}${root}`;
}

export function serviceOriginForRequest(request: Request, service: DomainService) {
  return serviceOriginForHostname(new URL(request.url).hostname, service);
}
