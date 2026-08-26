fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string("Cargo.lock").expect("Cargo.lock is required");
    let coinswap_block = lock
        .split("[[package]]")
        .find(|block| {
            block
                .lines()
                .any(|line| line.trim() == "name = \"coinswap\"")
        })
        .expect("coinswap must be pinned in Cargo.lock");
    let revision = coinswap_block
        .lines()
        .find_map(|line| line.trim().strip_prefix("source = \"")?.strip_suffix('"'))
        .and_then(|source| source.rsplit_once('#').map(|(_, revision)| revision))
        .filter(|revision| revision.len() == 40)
        .expect("coinswap Cargo.lock source must end in a full git revision");
    println!("cargo:rustc-env=PORTAL_COINSWAP_REV={revision}");
    const COMMANDS: &[&str] = &[
        "check_core_zmq",
        "check_tor",
        "get_version_info",
        "get_chain_backend",
        "set_chain_backend",
        "reset_chain_backend",
        "check_backend",
        "is_wallet_encrypted",
        "list_wallets",
        "init_taker",
        "shutdown_taker",
        "get_wallet_info",
        "choose_restore_backup",
        "restore_wallet",
        "backup_wallet",
        "get_balances",
        "check_swap_liquidity",
        "validate_address",
        "get_new_address",
        "get_transactions",
        "list_utxos",
        "send_to_address",
        "sync_wallet",
        "estimate_fees",
        "get_btc_price",
        "get_offers",
        "sync_offerbook",
        "poll_maker",
        "remove_maker",
        "prepare_swap",
        "estimate_swap_funding",
        "start_swap",
        "get_swap_progress",
        "get_swap_tracker",
        "recover_swap",
        "get_recovery_status",
        "list_swap_reports",
        "get_swap_report",
        "verify_deniability",
        "get_logs",
        "init_maker",
        "update_maker_settings",
        "start_maker",
        "stop_maker",
        "get_maker_status",
        "get_maker_info",
        "list_maker_swap_reports",
        "get_maker_swap_report",
        "verify_maker_deniability",
        "get_maker_balances",
        "list_maker_utxos",
        "get_maker_new_address",
        "get_maker_transactions",
        "sync_maker_wallet",
        "list_maker_fidelity_bonds",
        "list_makers",
        "get_saved_maker_settings",
        "list_dashboard_imports",
        "import_dashboard_makers",
        "clear_maker_settings",
        "get_suggested_maker_ports",
        "check_maker_ports",
        "get_maker_logs",
    ];
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("failed to build Tauri command manifest")
}
