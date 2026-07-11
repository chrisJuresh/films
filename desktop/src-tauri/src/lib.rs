use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
struct PlayerInfo {
    os: String,
    arch: String,
    mpv: bool,
    mpv_path: Option<String>,
}

/// First path printed by `where`/`which`, if the command resolves on PATH.
fn which(cmd: &str) -> Option<String> {
    let probe = if cfg!(windows) { "where" } else { "which" };
    let mut c = Command::new(probe);
    c.arg(cmd);
    // Don't pop a console window on Windows while probing PATH.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = c.output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// Common install locations for mpv, checked when it isn't on PATH.
fn mpv_candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(la) = std::env::var("LOCALAPPDATA") {
            v.push(PathBuf::from(&la).join(r"Programs\mpv\mpv.exe"));
            v.push(PathBuf::from(&la).join(r"Microsoft\WinGet\Links\mpv.exe"));
        }
        if let Ok(up) = std::env::var("USERPROFILE") {
            v.push(PathBuf::from(&up).join(r"scoop\shims\mpv.exe"));
            v.push(PathBuf::from(&up).join(r"scoop\apps\mpv\current\mpv.exe"));
        }
        v.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin\mpv.exe"));
        v.push(PathBuf::from(r"C:\Program Files\mpv\mpv.exe"));
        v.push(PathBuf::from(r"C:\mpv\mpv.exe"));
    }
    #[cfg(target_os = "macos")]
    {
        v.push(PathBuf::from("/opt/homebrew/bin/mpv"));
        v.push(PathBuf::from("/usr/local/bin/mpv"));
        v.push(PathBuf::from("/Applications/mpv.app/Contents/MacOS/mpv"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        v.push(PathBuf::from("/usr/bin/mpv"));
        v.push(PathBuf::from("/usr/local/bin/mpv"));
        v.push(PathBuf::from("/snap/bin/mpv"));
    }
    v
}

fn find_mpv() -> Option<String> {
    // Cache the lookup so we probe PATH at most once per app session.
    static MPV_PATH: OnceLock<Option<String>> = OnceLock::new();
    MPV_PATH
        .get_or_init(|| {
            which("mpv").or_else(|| {
                mpv_candidates()
                    .into_iter()
                    .find(|c| c.exists())
                    .map(|c| c.to_string_lossy().to_string())
            })
        })
        .clone()
}

#[tauri::command]
fn player_info() -> PlayerInfo {
    let mpv = find_mpv();
    PlayerInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        mpv: mpv.is_some(),
        mpv_path: mpv,
    }
}

/// The webview's Cloudflare-Access session cookies (CF_Authorization etc.) as a
/// `Cookie:` header value, so native clients (mpv, the downloader) authenticate as
/// the logged-in user — no CF service token needed. Reads HttpOnly cookies too.
fn cf_cookie_header(window: &tauri::WebviewWindow) -> Option<String> {
    let cookies = window.cookies().ok()?;
    let parts: Vec<String> = cookies
        .iter()
        .filter(|c| c.name().starts_with("CF_"))
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect();
    if parts.is_empty() { None } else { Some(parts.join("; ")) }
}

fn open_default(url: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    Command::new("cmd").args(["/C", "start", "", url]).spawn().map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    Ok("system default".to_string())
}

/// Play a URL or local file. `prefer = "default"` uses the OS default handler;
/// otherwise mpv is used — and if mpv can't be found we return a clear error
/// (rather than silently opening the browser, which just re-streams).
#[tauri::command]
async fn open_in_player(window: tauri::WebviewWindow, url: String, title: Option<String>, prefer: Option<String>, cf_id: Option<String>, cf_secret: Option<String>) -> Result<String, String> {
    if prefer.as_deref() == Some("default") {
        return open_default(&url);
    }
    match find_mpv() {
        Some(mpv) => {
            let mut c = Command::new(&mpv);
            if let Some(t) = title {
                c.arg(format!("--force-media-title={t}"));
            }
            // Authenticate through Cloudflare Access (skipped for local files):
            // prefer an Access service token (reliable), else the session cookie.
            if url.starts_with("http") {
                if let (Some(id), Some(secret)) = (cf_id.as_deref(), cf_secret.as_deref()) {
                    c.arg(format!("--http-header-fields=CF-Access-Client-Id: {id}"));
                    c.arg(format!("--http-header-fields-append=CF-Access-Client-Secret: {secret}"));
                } else if let Some(cookie) = cf_cookie_header(&window) {
                    c.arg(format!("--http-header-fields=Cookie: {cookie}"));
                }
            }
            // Our URLs are direct files/streams, never YouTube — skip the ytdl hook
            // (avoids the "youtube-dl failed / not recognized" console noise).
            c.arg("--ytdl=no");
            c.arg("--force-window=immediate");
            c.arg(&url);
            // Don't pop a console window alongside mpv on Windows.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            c.spawn()
                .map(|_| "mpv".to_string())
                .map_err(|e| format!("Found mpv at {mpv} but it failed to launch: {e}"))
        }
        None => Err("mpv isn't installed or isn't on PATH. Install it from mpv.io (on Windows: `winget install mpv.net` or add mpv.exe to PATH), then reopen. You can also choose \u{201c}Open in default player\u{201d}.".to_string()),
    }
}

// ------------------------------------------------------------- update check --

#[derive(Serialize, Clone)]
struct UpdateInfo {
    current: String,
    latest: Option<String>,
    url: Option<String>,
    available: bool,
}

fn version_gt(a: &str, b: &str) -> bool {
    let pa: Vec<u32> = a.split('.').filter_map(|x| x.parse().ok()).collect();
    let pb: Vec<u32> = b.split('.').filter_map(|x| x.parse().ok()).collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Check the latest GitHub release and report whether it's newer than this build.
#[tauri::command]
async fn check_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let client = reqwest::Client::builder()
        .user_agent("films-desktop")
        .build()
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = client
        .get("https://api.github.com/repos/chrisJuresh/films/releases/latest")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let tag = json.get("tag_name").and_then(|t| t.as_str()).unwrap_or("");
    let latest = tag.rsplit('v').next().unwrap_or("").to_string(); // films-desktop-v0.1.2 -> 0.1.2
    let url = json
        .get("html_url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());
    let available = !latest.is_empty() && version_gt(&latest, &current);
    Ok(UpdateInfo {
        current,
        latest: if latest.is_empty() { None } else { Some(latest) },
        url,
        available,
    })
}

// ----------------------------------------------- download to PC (preload) ----

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("films");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// The locally-cached file for a film, if it's been downloaded, else None.
#[tauri::command]
fn local_file(app: AppHandle, id: i64) -> Option<String> {
    let d = cache_dir(&app).ok()?;
    for ext in ["mkv", "mp4", "m4v", "webm", "avi"] {
        let p = d.join(format!("{id}.{ext}"));
        // Ignore bogus tiny files (e.g. a saved auth/login page) — a real film is huge.
        if let Ok(m) = std::fs::metadata(&p) {
            if m.len() > 20_000_000 {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[derive(Serialize, Clone)]
struct LocalDl {
    id: i64,
    path: String,
    size: u64,
    complete: bool,
}

/// Films in the "Save to PC" cache. Complete saves are `<id>.<media>`; an
/// interrupted one is `<id>.<media>.part` — we report BOTH (complete=false for
/// the .part) so a half-finished save is visible instead of silently missing.
#[tauri::command]
fn local_downloads(app: AppHandle) -> Vec<LocalDl> {
    let mut out = Vec::new();
    let Ok(dir) = cache_dir(&app) else { return out; };
    let Ok(entries) = std::fs::read_dir(&dir) else { return out; };
    let media = ["mkv", "mp4", "m4v", "webm", "avi"];
    for e in entries.flatten() {
        let p = e.path();
        let fname = match p.file_name().and_then(|s| s.to_str()) { Some(s) => s.to_string(), None => continue };
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        // "<id>.<media>.part" → incomplete; "<id>.<media>" → complete.
        let (id_str, complete) = if let Some(base) = fname.strip_suffix(".part") {
            (base.rsplit_once('.').map_or(base, |(a, _)| a), false)
        } else {
            let ext_ok = p.extension().and_then(|x| x.to_str()).map(|x| media.contains(&x)).unwrap_or(false);
            if !ext_ok { continue; }
            (fname.rsplit_once('.').map_or(fname.as_str(), |(a, _)| a), true)
        };
        let Ok(id) = id_str.parse::<i64>() else { continue; };   // cache files are named "<id>.…"
        if complete && size < 20_000_000 { continue; }           // ignore bogus tiny complete files
        out.push(LocalDl { id, path: p.to_string_lossy().to_string(), size, complete });
    }
    out
}

/// Open the OS file manager at a saved file (selecting it) or a folder.
/// Windows: explorer /select; macOS: open -R; Linux: xdg-open the directory.
fn show_in_manager(path: &std::path::Path, select: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer");
        if select { c.arg(format!("/select,{}", path.display())); } else { c.arg(path); }
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c.spawn().map_err(|e| e.to_string())?; // explorer exits nonzero even on success; don't wait
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("open");
        if select { c.arg("-R"); }
        c.arg(path);
        c.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // xdg-open can't select a file, so open the containing directory.
        let target = if select { path.parent().unwrap_or(path) } else { path };
        std::process::Command::new("xdg-open").arg(target).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Unsupported platform".into())
}

/// Reveal a specific saved film in the file manager.
#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    show_in_manager(std::path::Path::new(&path), true)
}

/// Open the folder where "Save to PC" downloads live.
#[tauri::command]
fn open_downloads_dir(app: AppHandle) -> Result<(), String> {
    let d = cache_dir(&app)?;
    show_in_manager(&d, false)
}

#[derive(Serialize, Clone)]
struct DlProgress {
    id: i64,
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

/// Download a film to the local cache (preload), RESUMABLE + retrying: a big file
/// over Cloudflare can drop mid-stream, so on a dropped connection we resume from
/// the .part with an HTTP Range request. Emits `films-download-progress` events
/// (including a final one with `error` on failure) so the UI — which tracks these
/// app-wide — stays correct even across navigation.
#[tauri::command]
async fn download_to_pc(app: AppHandle, window: tauri::WebviewWindow, url: String, id: i64, ext: Option<String>, cf_id: Option<String>, cf_secret: Option<String>) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let dir = cache_dir(&app)?;
    let ext = ext.unwrap_or_else(|| "mp4".to_string());
    let final_path = dir.join(format!("{id}.{ext}"));
    let part = dir.join(format!("{id}.{ext}.part"));
    let client = reqwest::Client::builder().user_agent("films-desktop").build().map_err(|e| e.to_string())?;
    let cookie = cf_cookie_header(&window);

    let emit = |received: u64, total: u64, done: bool, error: Option<String>| {
        let _ = app.emit("films-download-progress", DlProgress { id, received, total, done, error });
    };

    let mut total: u64 = 0;
    let attempts = 6u32;
    let mut last_err = String::new();
    for _ in 0..attempts {
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let mut rb = client.get(&url);
        if let (Some(cid), Some(cs)) = (cf_id.as_deref(), cf_secret.as_deref()) {
            rb = rb.header("CF-Access-Client-Id", cid).header("CF-Access-Client-Secret", cs);
        } else if let Some(ck) = cookie.as_deref() {
            rb = rb.header(reqwest::header::COOKIE, ck);
        }
        if have > 0 { rb = rb.header(reqwest::header::RANGE, format!("bytes={}-", have)); }

        let resp = match rb.send().await {
            Ok(r) => r,
            Err(e) => { last_err = format!("connection error: {e}"); continue; } // retry
        };
        let status = resp.status();
        if status.as_u16() == 416 {
            // Requested range beyond EOF → the .part already has the whole file.
            std::fs::rename(&part, &final_path).map_err(|e| e.to_string())?;
            emit(have, have, true, None);
            return Ok(final_path.to_string_lossy().to_string());
        }
        if !status.is_success() {
            emit(0, 0, true, Some(format!("HTTP {status}")));
            return Err(format!("Download failed (HTTP {status})"));
        }
        // Auth wall (Cloudflare Access) with no session → a login page, not the film.
        let host = resp.url().host_str().unwrap_or("").to_string();
        let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if host.contains("cloudflareaccess.com") || ctype.starts_with("text/html") {
            let _ = std::fs::remove_file(&part);
            let msg = "Cloudflare Access blocked the app — no login session. Set up a CF Access service token.".to_string();
            emit(0, 0, true, Some(msg.clone()));
            return Err(msg);
        }

        let resuming = have > 0 && status.as_u16() == 206;
        let mut received = if resuming { have } else { 0 };
        total = if resuming { have + resp.content_length().unwrap_or(0) } else { resp.content_length().unwrap_or(0) };
        let mut file = if resuming {
            std::fs::OpenOptions::new().append(true).open(&part).map_err(|e| e.to_string())?
        } else {
            std::fs::File::create(&part).map_err(|e| e.to_string())?
        };

        let mut stream = resp.bytes_stream();
        let mut last_emit = received;
        let mut dropped = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(c) => {
                    if let Err(e) = file.write_all(&c) { return Err(e.to_string()); }
                    received += c.len() as u64;
                    if received - last_emit > 2_000_000 {
                        last_emit = received;
                        emit(received, total, false, None);
                    }
                }
                Err(e) => { last_err = format!("stream dropped: {e}"); dropped = true; break; } // resume next attempt
            }
        }
        let _ = file.flush();
        if !dropped {
            std::fs::rename(&part, &final_path).map_err(|e| e.to_string())?;
            emit(received, total.max(received), true, None);
            return Ok(final_path.to_string_lossy().to_string());
        }
    }
    let msg = format!("Download kept dropping — gave up after {attempts} tries ({last_err}).");
    emit(0, total, true, Some(msg.clone()));
    Err(msg)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            player_info,
            open_in_player,
            check_update,
            local_file,
            local_downloads,
            reveal_file,
            open_downloads_dir,
            download_to_pc
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Film Index desktop app");
}
