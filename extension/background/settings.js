import { PLATFORMS } from "../platforms/index.js";

export function normalizeSettings(value) {
  return {
    schemaVersion: 1,
    platforms: Object.fromEntries(PLATFORMS.map(({ id }) =>
      [id, { enabled: value?.schemaVersion === 1 && value?.platforms?.[id]?.enabled === true }]
    ))
  };
}
