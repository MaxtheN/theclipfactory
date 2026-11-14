/** Window event fired after a sign in or sign out, so account chrome can refresh. */
export const CLOUD_CHANGED = "gf-cloud-changed";
export const announceCloudChange = () =>
  window.dispatchEvent(new Event(CLOUD_CHANGED));

/** Window event asking Factory to switch to its map tab (first episode dropped). */
export const SHOW_FACTORY_MAP = "gf-show-factory-map";
