//! Builds the frontend into the binary when `PORTAL_EMBED_WEB` names a built `dist/web`, so a
//! release is one file that serves its own UI with no `--assets-dir`. Unset, the table is empty:
//! development keeps Vite serving the UI, and the container keeps serving its own directory.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=PORTAL_EMBED_WEB");
    let mut table = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    if let Ok(dir) = std::env::var("PORTAL_EMBED_WEB") {
        // Relative to the workspace root, where `npm run web:build` runs; cargo runs this
        // script from the package directory instead.
        let dir = Path::new(&dir);
        let dir = if dir.is_absolute() {
            dir.to_path_buf()
        } else {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(dir)
        };
        let dir = dir
            .canonicalize()
            .unwrap_or_else(|e| panic!("PORTAL_EMBED_WEB {}: {e}", dir.display()));
        assert!(
            dir.join("index.html").is_file(),
            "PORTAL_EMBED_WEB {} has no index.html — build the frontend first",
            dir.display()
        );
        println!("cargo:rerun-if-changed={}", dir.display());
        let mut files = Vec::new();
        collect(&dir, &mut files);
        files.sort();
        for file in files {
            let route = file
                .strip_prefix(&dir)
                .expect("collected under dir")
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            writeln!(table, "    ({route:?}, include_bytes!({:?})),", file.display().to_string())
                .expect("writing to a String");
        }
    }
    table.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    std::fs::write(out.join("embedded_web.rs"), table).expect("writing the embedded table");
}

fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("reading the frontend build") {
        let entry = entry.expect("reading the frontend build");
        let path = entry.path();
        // `file_type` does not follow links, unlike `Path::is_dir`: a link would embed whatever it
        // points at, inside the build or not, and the server would then serve it.
        let kind = entry.file_type().expect("reading the frontend build");
        assert!(!kind.is_symlink(), "refusing to embed symlink {}", path.display());
        if kind.is_dir() {
            collect(&path, files);
        } else {
            files.push(path);
        }
    }
}
