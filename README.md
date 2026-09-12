<div align="center">

<img src="src-tauri/icons/128x128@2x.png" alt="Portal" width="110" />

# Portal

A desktop Bitcoin wallet that swaps your coins privately, over Tor, with no trusted third party.

[![MIT Licensed](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-citadelfoss.xyz-blue)](https://citadelfoss.xyz/)

</div>

## ⚠️ Warning

This project is under active development. Mainnet use is **NOT recommended.**

# About

Portal is a desktop client for [OpenSwap](https://github.com/citadel-foss/openswap), a Bitcoin
swap protocol with no company or server in the middle — the marketplace lives on the Bitcoin
blockchain itself.

It is a full wallet — receive, send, coin control, history — with swaps built in. Pick an amount,
pick how many hops, press swap.

**Two roles**, chosen at launch (the protocol docs call them *taker* and *maker*):

- **`Wallet`** starts swaps and pays the fees. Nothing to run, nothing to lock up.
- **`Router`** provides the liquidity and earns a fee on every swap through it. Needs uptime, coins
  in a hot wallet, and a
  [fidelity bond](https://github.com/JoinMarket-Org/joinmarket-clientserver/blob/master/docs/fidelity-bonds.md)
  — a time-locked UTXO that makes flooding the market with fake routers expensive.

No single router sees the whole route: the wallet relays every message between them over Tor. Both
the older P2WSH and the newer Taproot contracts are supported.

# Getting started

## Requirements

Running a release build needs nothing else installed — Portal bundles its own Tor and defaults to a
public Electrum server. To build from source you need:

- **Node.js** v18 or newer
- **Rust** (stable) via [rustup](https://rustup.rs/)
- **System dependencies:**

```bash
# macOS
xcode-select --install

# Debian / Ubuntu
sudo apt-get update
sudo apt-get install -y build-essential curl wget file libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev libwebkit2gtk-4.1-dev libxdo-dev pkg-config
```

Tauri's [prerequisites guide](https://tauri.app/start/prerequisites/) covers other platforms.

## Run from source

```bash
git clone https://github.com/citadel-foss/portal.git
cd portal
npm install

npm run tauri dev
```

The first run compiles the Rust backend and the OpenSwap library, which takes several minutes.
Later runs are incremental.

## Build

```bash
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/` — `.dmg` on macOS, `.deb`/`.AppImage`/`.rpm`
on Linux, `.msi` on Windows. Tauri builds only for the platform you are on.

## First run

Every launch starts at the **connection screen**: pick a chain backend and wait for Tor to
bootstrap and the chain to answer. A swap started without a working backend fails in ways that cost
money to unwind, so this gate is not skippable.

- **Chain backend** — Electrum (pre-filled, nothing to install) or your own Bitcoin Core RPC.
- **Tor** — bundled and started fresh each launch. Mandatory for swaps; routers are reachable only
  as onion services.

Then choose **Wallet** or **Router**, open or create a wallet, and let it sync.

Swaps take a while — most of the time is spent waiting for confirmations, one per hop plus the final
sweep. **Closing the window does not stop a swap:** Portal hides to the tray and keeps working.
Quitting is explicit (tray menu, app menu, or `Cmd`/`Ctrl`+`Q`), and Portal warns you first if a
swap or router is still running.

## Data

Portal uses the OpenSwap library's own layout, so the data is interchangeable with the protocol's
CLI tools. 

```
~/.openswap/taker/
├── wallets/            wallet files, plus one swap report per wallet
├── debug.log           application log
├── offerbook.json      cached marketplace state
├── swap_tracker.cbor   crash-resilient swap state, for recovery
└── config.toml
```

Connection settings are deliberately **never** written to disk — the chain backend and Tor settings
are seeded fresh each launch and held in memory only, so a node's RPC password is never at rest.

# Development

| Command | What it does |
| --- | --- |
| `npm run tauri dev` | Full app, real desktop window |
| `npm run dev` | Vite alone — no Tauri, so no backend calls work. UI iteration only |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run tauri build` | Production installers |

Backend, from `src-tauri/`: `cargo check`, `cargo clippy --all-targets`.

```
src/          React frontend
  api/        the single typed IPC boundary — components import from here, never invoke() directly
  pages/      one directory per screen
  components/ shared UI primitives
src-tauri/    Rust backend
  src/commands/  IPC commands, grouped by domain
```

# Links

- [OpenSwap](https://github.com/citadel-foss/openswap) — protocol implementation
- [Protocol specification](https://github.com/citadel-foss/OpenSwap-Protocol-Specification)
- [Website](https://citadelfoss.xyz/)
- [Matrix](https://matrix.to/#/#ciatdel-foss:matrix.org) — dev community
