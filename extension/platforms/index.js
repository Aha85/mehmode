import facebook from "./facebook/config.js";
import instagram from "./instagram/config.js";
import linkedin from "./linkedin/config.js";
import tiktok from "./tiktok/config.js";
import x from "./x/config.js";

export const PLATFORMS = Object.freeze([facebook, instagram, linkedin, tiktok, x]);
export const originsFor = platform => platform.hosts.map(host => `https://${host}/*`);
export function platformForUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return PLATFORMS.find(platform => platform.hosts.includes(url.hostname)) || null;
  } catch { return null; }
}
export const platformById = id => PLATFORMS.find(platform => platform.id === id) || null;
