// Shared Tor connectivity config — edited during first-run setup (pages/setup)
// and again later from Settings, so both read/write the same persisted defaults
// instead of drifting apart.
//
// The chain backend (Electrum server / your own node) is *not* here: it lives in
// the backend's own config file, because wallet restore and maker startup need it
// on paths that never see a value from the UI.

export interface ConnectivityConfig {
  torControlPort: number;
  torSocksPort: number;
  torAuthPassword: string;
}

// Matches taker-app/src/components/settings/FirstTimeSetup.js's exact defaults.
export const RPC_HOST = "127.0.0.1";

export const HARDCODED_DEFAULTS: ConnectivityConfig = {
  torControlPort: 9051,
  torSocksPort: 9050,
  torAuthPassword: "",
};

const STORAGE_KEY = "coinswap_connectivity_defaults";

export function loadConnectivityDefaults(): ConnectivityConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return HARDCODED_DEFAULTS;
    return { ...HARDCODED_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return HARDCODED_DEFAULTS;
  }
}

export function saveConnectivityDefaults(config: ConnectivityConfig) {
  // Persist the complete user-selected configuration so startup can reconnect
  // without silently replacing any chosen defaults.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
