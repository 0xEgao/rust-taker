//! The macOS About panel, opened here rather than through Tauri's predefined About item: that
//! one hands AppKit the credits as a bare string, which it sets flush against both edges of the
//! panel's text view, and a bare string has nowhere to carry an inset.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSAboutPanelOptionApplicationIcon, NSAboutPanelOptionApplicationName,
    NSAboutPanelOptionApplicationVersion, NSAboutPanelOptionCredits, NSApplication, NSColor,
    NSForegroundColorAttributeName, NSImage, NSMutableParagraphStyle,
    NSParagraphStyleAttributeName,
};
use objc2_foundation::{ns_string, NSAttributedString, NSData, NSDictionary, NSString};

// The blank first and last lines are the top and bottom inset: paragraph spacing, the styled
// way, is not reliably applied before a text view's first line or after its last. At the
// credits' font size a line is about `CREDITS_INSET` tall, so all four sides come out even.
const CREDITS: &str = "\nPortal is a desktop app for OpenSwap, a peer-to-peer coinswap protocol \
for Bitcoin.\n\n\
As a wallet, it swaps your coins through a chain of routers over Tor, breaking the on-chain link \
between where your bitcoin came from and where it goes. As a router, it provides that liquidity \
to other wallets and earns a fee for each swap, backed by a fidelity bond.\n\n\
github.com/citadel-foss/portal\n";

/// Points in from each side of the credits' text view.
const CREDITS_INSET: f64 = 14.0;

// Embedded rather than read from the bundle: a dev build has no bundle, and AppKit then shows a
// generic folder.
const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

pub fn show(version: &str) {
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("About panel requested off the main thread");
        return;
    };

    let style = NSMutableParagraphStyle::new();
    style.setFirstLineHeadIndent(CREDITS_INSET);
    style.setHeadIndent(CREDITS_INSET);
    // Negative: measured in from the trailing edge, not out from the leading one.
    style.setTailIndent(-CREDITS_INSET);
    // The system label colour, so the text follows light and dark mode like the rest of the panel.
    let attributes: Retained<NSDictionary<NSString, AnyObject>> =
        NSDictionary::from_retained_objects(
            unsafe {
                &[
                    NSParagraphStyleAttributeName,
                    NSForegroundColorAttributeName,
                ]
            },
            &[
                Retained::into_super(Retained::into_super(Retained::into_super(style))),
                Retained::into_super(Retained::into_super(NSColor::labelColor())),
            ],
        );
    let credits = unsafe {
        NSAttributedString::new_with_attributes(&NSString::from_str(CREDITS), &attributes)
    };

    let mut keys: Vec<&NSString> = unsafe {
        vec![
            NSAboutPanelOptionApplicationName,
            NSAboutPanelOptionApplicationVersion,
            NSAboutPanelOptionCredits,
        ]
    };
    let mut values: Vec<Retained<AnyObject>> = vec![
        Retained::into_super(Retained::into_super(NSString::from_str("Portal"))),
        Retained::into_super(Retained::into_super(NSString::from_str(version))),
        Retained::into_super(Retained::into_super(credits)),
    ];
    keys.push(ns_string!("Copyright"));
    values.push(Retained::into_super(Retained::into_super(
        NSString::from_str("Open source under the MIT License"),
    )));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(ICON)) {
        keys.push(unsafe { NSAboutPanelOptionApplicationIcon });
        values.push(Retained::into_super(Retained::into_super(icon)));
    }

    let options = NSDictionary::from_retained_objects(&keys, &values);
    unsafe {
        NSApplication::sharedApplication(mtm).orderFrontStandardAboutPanelWithOptions(&options)
    };
}
