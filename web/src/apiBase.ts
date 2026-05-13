import { DEFAULT_STAR_DELIVERY_REST_BASE } from "./starDeliveryDefaults";

function normalizeRestBase(url: string): string {
  const t = url.trim().replace(/\/+$/, "");
  return t || DEFAULT_STAR_DELIVERY_REST_BASE.replace(/\/+$/, "");
}

/**
 * Base URL passed to `@cli/api` fetch helpers.
 * In dev, always `/__api` (Vite proxy); in production, the configured REST root.
 */
export function restBaseForRequests(configuredBase: string): string {
  if (import.meta.env.DEV) {
    return "/__api";
  }
  return normalizeRestBase(configuredBase || DEFAULT_STAR_DELIVERY_REST_BASE);
}
