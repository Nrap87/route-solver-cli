/** Default Star Delivery REST root (same host as wecode OutSystems StarDeliveryServices). */
export const DEFAULT_STAR_DELIVERY_REST_BASE =
  "https://wecode.outsystems.com/StarDelivery_Ngin/rest/StarDeliveryServices";

export const DEFAULT_PLAYER_GUID = "bdcd133d-74a8-4b15-a13b-b545501a40de";

export const DEFAULT_PLAYER_EMAIL = "nelson.pinto@version1.com";

const STORAGE_GUID = "sd_player_guid";
const STORAGE_EMAIL = "sd_player_email";

function readStoredPlayer(key: string, fallback: string): string {
  try {
    const v = sessionStorage.getItem(key);
    return v != null && v.trim() !== "" ? v.trim() : fallback;
  } catch {
    return fallback;
  }
}

/** Player GUID for API headers (env → sessionStorage → default). Not shown in the web UI. */
export function resolvePlayerGuid(): string {
  const fromEnv = import.meta.env.VITE_PLAYER_GUID?.trim();
  if (fromEnv) return fromEnv;
  return readStoredPlayer(STORAGE_GUID, DEFAULT_PLAYER_GUID);
}

/** Player email for API headers (env → sessionStorage → default). Not shown in the web UI. */
export function resolvePlayerEmail(): string {
  const fromEnv = import.meta.env.VITE_PLAYER_EMAIL?.trim();
  if (fromEnv) return fromEnv;
  return readStoredPlayer(STORAGE_EMAIL, DEFAULT_PLAYER_EMAIL);
}
