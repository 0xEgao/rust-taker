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

Portal is a desktop client for [OpenSwap](https://github.com/citadel-foss/openswap) — a trustless,
self-custodial [atomic swap](https://bitcoinops.org/en/topics/coinswap/) protocol built on Bitcoin.
Unlike solutions that rely on centralized servers as
[single points of failure](https://en.wikipedia.org/wiki/Single_point_of_failure), OpenSwap's
marketplace is seeded in the Bitcoin blockchain itself — no central host, no custodian, and no
point at which anyone else can take your money.

An ordinary Bitcoin transaction leaves a permanent on-chain trail linking where your coins came
from to where they went. Portal breaks that link: it routes your coins through a chain of
independent counterparties, so the coins you receive have no on-chain connection to the coins you
spent. Every hop is enforced by a Bitcoin contract you can always reclaim from.

Portal is a full wallet — receive, send, coin control, transaction history — with swaps built in.
Pick an amount, pick how many hops, press swap.

**Two roles**, switched from the launch screen:

- **`Wallet`** is the client side. You initiate swaps, pay the fees (swap + mining), and need no
  fidelity bond. You pick your route from the marketplace based on bond validity, available
  liquidity and fee rates. Protocol complexity lives here, which keeps the other side lightweight.

- **`Router`** is the service side. You supply liquidity and earn a fee on every swap routed
  through you, competing on fee rates in an open market and signalling reliability through a
  larger [fidelity bond](https://github.com/JoinMarket-Org/joinmarket-clientserver/blob/master/docs/fidelity-bonds.md).
  Routers need uptime and hot-wallet liquidity, but no day-to-day management.

**Multi-hop routing** mirrors Lightning: no single router sees the full route. The wallet relays
every message between routers over Tor, keeping each router's view partial. Both the legacy P2WSH
and the modern Taproot + MuSig2 contracts are supported.

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

Every launch starts at the **connection screen**. Pick a chain backend, wait for Tor to finish
bootstrapping, and wait for the check confirming the chain is answering — a swap started without a
working backend fails in ways that cost money to unwind.

- **Chain backend** — Electrum (pre-filled, nothing to install) or your own Bitcoin Core RPC.
- **Tor** — bundled and enabled by default. Point Portal at your own SOCKS proxy instead if you
  already run one. Tor is mandatory for swaps; routers are reachable only as onion services.

Past the gate, choose **Wallet** or **Router**, then create or open a wallet and let it sync.

Swaps take a while — most of a swap is spent waiting for confirmations, one per hop plus the final
sweep. **Closing the window does not stop a swap:** Portal hides to the tray and keeps working.
Quitting is explicit (tray menu, app menu, or `Cmd`/`Ctrl`+`Q`), and Portal warns you first if a
swap or router is still running.

## Data

Portal uses the OpenSwap library's own directory layout, so data is interchangeable with the
protocol's CLI tools.

```
~/.coinswap/taker/
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
