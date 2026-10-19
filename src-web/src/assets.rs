//! Static frontend, served from a directory beside the binary, or else from the copy built into
//! the binary itself (see `build.rs`).
//!
//! Only the allowlisted directory is served, and an API path never falls back to `index.html`
//! — a mistyped route must 404 rather than hand back an HTML page a client will try to parse
//! as JSON.

use axum::http::{header, HeaderValue, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::state::WebState;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded_web.rs"));
}

/// Whether this binary carries its own frontend.
pub fn has_embedded() -> bool {
    !embedded::FILES.is_empty()
}

fn no_store() -> SetResponseHeaderLayer<HeaderValue> {
    // No private API response or backup byte may be cached; the shell is versioned with the
    // build, so it must not be reused across incompatible releases either.
    SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))
}

pub fn router(state: &WebState) -> Router<WebState> {
    let files: Router = match state.config.assets_dir.as_ref() {
        Some(dir) => Router::new().fallback_service(
            ServeDir::new(dir)
                // A single-page app serves its shell for unknown *page* paths; API routes are
                // matched earlier, so they never reach this.
                .not_found_service(ServeFile::new(dir.join("index.html"))),
        ),
        None if has_embedded() => Router::new().fallback(serve_embedded),
        // Nothing to serve in development: Vite owns the UI and only proxies the API here.
        None => return Router::new(),
    };
    mount(&state.config.base_path, files).layer(no_store())
}

/// Puts the frontend under the base path, beside the API routes `Config::route` joins under it.
/// Nesting strips the prefix, so both file services resolve paths as if served at the root.
fn mount<S: Clone + Send + Sync + 'static>(base_path: &str, files: Router) -> Router<S> {
    let base = base_path.trim_end_matches('/');
    if base.is_empty() {
        Router::new().fallback_service(files)
    } else {
        Router::new().nest_service(base, files)
    }
}

/// The embedded counterpart of the directory service above, with the same single-page fallback:
/// an unknown path gets the shell, and API routes were matched before this is reached. The path
/// arrives with the base path already stripped by `mount`.
async fn serve_embedded(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let file = |name: &str| embedded::FILES.iter().find(|(route, _)| *route == name);
    let Some((route, bytes)) = file(path).or_else(|| file("index.html")) else {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };
    let content_type = match route.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("json") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    ([(header::CONTENT_TYPE, content_type)], *bytes).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;

    /// Serves `files` mounted under `base`, beside one prefixed API route as `main` merges them,
    /// and returns the status and body for each path.
    async fn fetch(base: &str, paths: &[&str]) -> Vec<(i32, String)> {
        let api = format!("{}/api/v1/session", base.trim_end_matches('/'));
        let files: Router =
            Router::new().fallback(|uri: Uri| async move { format!("file {}", uri.path()) });
        let app = Router::new()
            .route(&api, get(|| async { "api" }))
            .merge(mount::<()>(base, files));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let urls: Vec<String> = paths.iter().map(|p| format!("{origin}{p}")).collect();
        tokio::task::spawn_blocking(move || {
            urls.iter()
                .map(|url| {
                    let response = minreq::get(url).send().unwrap();
                    (response.status_code, response.as_str().unwrap().to_string())
                })
                .collect()
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn files_are_served_under_the_base_path_with_it_stripped() {
        let got = fetch(
            "/portal",
            &[
                "/portal/",
                "/portal/assets/app.js",
                "/portal/api/v1/session",
                "/assets/app.js",
                "/",
            ],
        )
        .await;
        assert_eq!(got[0], (200, "file /".into()));
        assert_eq!(got[1], (200, "file /assets/app.js".into()));
        assert_eq!(got[2], (200, "api".into()));
        assert_eq!(got[3].0, 404, "nothing is served outside the base path");
        assert_eq!(got[4].0, 404, "nothing is served outside the base path");
    }

    #[tokio::test]
    async fn without_a_base_path_files_are_served_from_the_root() {
        let got = fetch("/", &["/", "/assets/app.js", "/api/v1/session"]).await;
        assert_eq!(got[0], (200, "file /".into()));
        assert_eq!(got[1], (200, "file /assets/app.js".into()));
        assert_eq!(got[2], (200, "api".into()));
    }
}
