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
    {
        // Go through cmd's `start` (always in System32/PATH) rather than
        // explorer.exe, which lives in C:\Windows and isn't reliably on PATH.
        use std::os::windows::process::CommandExt;
        Command::new("cmd").args(["/C", "start", "", url]).creation_flags(0x08000000)
            .spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    Ok("system default".to_string())
}

/// Play a URL or local file. `prefer = "default"` uses the OS default handler;
/// otherwise mpv is used — and if mpv can't be found we return a clear error
/// (rather than silently opening the browser, which just re-streams).
#[tauri::command]
async fn open_in_player(window: tauri::WebviewWindow, url: String, title: Option<String>, prefer: Option<String>, film_id: Option<i64>, resume: Option<f64>, cf_id: Option<String>, cf_secret: Option<String>) -> Result<String, String> {
    if prefer.as_deref() == Some("default") {
        return open_default(&url);
    }
    match find_mpv() {
        Some(mpv) => {
            let app = window.app_handle().clone();
            let mut c = Command::new(&mpv);
            if let Some(t) = title {
                c.arg(format!("--force-media-title={t}"));
            }
            // Authenticate through Cloudflare Access (skipped for local files):
            // prefer an Access service token (reliable), else the session cookie.
            if url.starts_with("http") {
                if let (Some(cid), Some(secret)) = (cf_id.as_deref(), cf_secret.as_deref()) {
                    c.arg(format!("--http-header-fields=CF-Access-Client-Id: {cid}"));
                    c.arg(format!("--http-header-fields-append=CF-Access-Client-Secret: {secret}"));
                } else if let Some(cookie) = cf_cookie_header(&window) {
                    c.arg(format!("--http-header-fields=Cookie: {cookie}"));
                }
            }
            // Resume where the site says they left off.
            if let Some(r) = resume { if r > 5.0 { c.arg(format!("--start={r}")); } }
            // Capture the final position: mpv writes a watch-later file on quit.
            // One dir per film → exactly one file to read back afterwards.
            let mut wl_dir: Option<PathBuf> = None;
            if let Some(fid) = film_id {
                if let Ok(base) = app.path().app_cache_dir() {
                    let d = base.join("films-wl").join(fid.to_string());
                    let _ = std::fs::create_dir_all(&d);
                    if let Ok(rd) = std::fs::read_dir(&d) { for e in rd.flatten() { let _ = std::fs::remove_file(e.path()); } }
                    c.arg("--save-position-on-quit");
                    c.arg(format!("--watch-later-directory={}", d.display()));
                    wl_dir = Some(d);
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
            match c.spawn() {
                Ok(mut child) => {
                    // When mpv quits, read the position it saved and report it back so
                    // the site's "watched %" updates for mpv sessions too.
                    if let (Some(fid), Some(d)) = (film_id, wl_dir) {
                        std::thread::spawn(move || {
                            let _ = child.wait();
                            if let Some(pos) = read_wl_start(&d) {
                                let _ = app.emit("mpv-progress", MpvProgress { id: fid, position: pos });
                            }
                        });
                    }
                    Ok("mpv".to_string())
                }
                Err(e) => Err(format!("Found mpv at {mpv} but it failed to launch: {e}")),
            }
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

// A "Save to PC" copy can now live in ANY folder the user picks, so we keep a
// registry (id → absolute path) in the app config dir. local_downloads merges it
// with a scan of the default cache folder, so both custom-folder saves and legacy
// cache saves show up under "On this PC".
fn registry_file(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("saves.json"))
}
fn read_registry(app: &AppHandle) -> std::collections::HashMap<String, String> {
    registry_file(app).ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn registry_set(app: &AppHandle, id: i64, path: &str) {
    let mut m = read_registry(app);
    m.insert(id.to_string(), path.to_string());
    if let Ok(p) = registry_file(app) {
        if let Ok(s) = serde_json::to_string(&m) { let _ = std::fs::write(p, s); }
    }
}

#[derive(Serialize, Clone)]
struct MoveProgress { id: i64, received: u64, total: u64, done: bool, error: Option<String> }

#[derive(Serialize, Clone)]
struct MpvProgress { id: i64, position: f64 }

/// The resume position mpv wrote to its watch-later file (single file in `dir`).
fn read_wl_start(dir: &std::path::Path) -> Option<f64> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        if let Ok(txt) = std::fs::read_to_string(e.path()) {
            for line in txt.lines() {
                if let Some(v) = line.trim().strip_prefix("start=") {
                    if let Ok(f) = v.trim().parse::<f64>() { return Some(f); }
                }
            }
        }
    }
    None
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
    let mut by_id: std::collections::HashMap<i64, LocalDl> = std::collections::HashMap::new();
    let media = ["mkv", "mp4", "m4v", "webm", "avi"];
    // 1) Scan the default cache folder (legacy saves + any in-progress .part).
    if let Ok(dir) = cache_dir(&app) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
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
                let Ok(id) = id_str.parse::<i64>() else { continue; };
                if complete && size < 20_000_000 { continue; }   // ignore bogus tiny complete files
                by_id.insert(id, LocalDl { id, path: p.to_string_lossy().to_string(), size, complete });
            }
        }
    }
    // 2) Registry entries (files in any folder). Authoritative: the path here is
    //    where the file ACTUALLY is now, so it overrides a stale cache-scan hit.
    for (ids, path) in read_registry(&app) {
        let Ok(id) = ids.parse::<i64>() else { continue; };
        if let Ok(m) = std::fs::metadata(&path) {
            if m.len() > 20_000_000 {
                by_id.insert(id, LocalDl { id, path, size: m.len(), complete: true });
            }
        }
    }
    by_id.into_values().collect()
}

/// Reveal a saved film in the file manager — highlighting it where we can
/// (Windows explorer /select, macOS open -R), else falling back to just opening
/// its containing folder with the default handler (which is the reliable path).
#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if Command::new("explorer").arg(format!("/select,{}", p.display()))
            .creation_flags(0x08000000).spawn().is_ok() { return Ok(()); }
    }
    #[cfg(target_os = "macos")]
    { if Command::new("open").arg("-R").arg(p).spawn().is_ok() { return Ok(()); } }
    let dir = p.parent().unwrap_or(p);
    open_default(&dir.to_string_lossy()).map(|_| ())
}

/// Open the "Save to PC" folder in the OS file manager.
#[tauri::command]
fn open_downloads_dir(app: AppHandle) -> Result<(), String> {
    let d = cache_dir(&app)?;
    open_default(&d.to_string_lossy()).map(|_| ())
}

/// Native "choose a folder" dialog. Returns the picked path, or None if cancelled.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |f| { let _ = tx.send(f); });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await.ok().flatten().map(|p| p.to_string())
}

/// Move a saved film into `dest_dir`, updating the registry. Same-volume moves
/// are an instant rename; cross-volume copies stream with `films-move-progress`
/// events so the UI can show a bar. Returns the new absolute path.
#[tauri::command]
async fn move_local_file(app: AppHandle, id: i64, dest_dir: String) -> Result<String, String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || do_move(&a, id, &dest_dir))
        .await.map_err(|e| e.to_string())?
}

fn do_move(app: &AppHandle, id: i64, dest_dir: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    // Where is it now? Registry first (may be outside the cache), else the cache.
    let src = read_registry(app).get(&id.to_string()).cloned()
        .filter(|p| std::path::Path::new(p).exists())
        .or_else(|| local_file(app.clone(), id))
        .ok_or_else(|| "That film isn't saved on this PC.".to_string())?;
    let src_path = PathBuf::from(&src);
    let fname = src_path.file_name().and_then(|s| s.to_str()).ok_or("bad source filename")?.to_string();
    let dest = PathBuf::from(dest_dir);
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let dst_path = dest.join(&fname);
    if dst_path == src_path { return Ok(src); }                       // already there
    let total = std::fs::metadata(&src_path).map(|m| m.len()).unwrap_or(0);
    let emit = |received: u64, done: bool, error: Option<String>| {
        let _ = app.emit("films-move-progress", MoveProgress { id, received, total, done, error });
    };
    // Fast path: same volume → rename is instant.
    if std::fs::rename(&src_path, &dst_path).is_ok() {
        registry_set(app, id, &dst_path.to_string_lossy());
        emit(total, true, None);
        return Ok(dst_path.to_string_lossy().to_string());
    }
    // Cross-volume: stream copy with progress, then remove the source.
    let mut r = std::fs::File::open(&src_path).map_err(|e| e.to_string())?;
    let mut w = std::fs::File::create(&dst_path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let (mut received, mut last) = (0u64, 0u64);
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => { let _ = std::fs::remove_file(&dst_path); emit(received, true, Some(e.to_string())); return Err(e.to_string()); }
        };
        if let Err(e) = w.write_all(&buf[..n]) { let _ = std::fs::remove_file(&dst_path); emit(received, true, Some(e.to_string())); return Err(e.to_string()); }
        received += n as u64;
        if received - last > 8_000_000 { last = received; emit(received, false, None); }
    }
    let _ = w.flush();
    let _ = std::fs::remove_file(&src_path);
    registry_set(app, id, &dst_path.to_string_lossy());
    emit(received, true, None);
    Ok(dst_path.to_string_lossy().to_string())
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
async fn download_to_pc(app: AppHandle, window: tauri::WebviewWindow, url: String, id: i64, ext: Option<String>, dest: Option<String>, cf_id: Option<String>, cf_secret: Option<String>) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    // Save into the user-chosen folder if given, else the default app cache.
    let dir = match dest.as_deref() {
        Some(d) if !d.trim().is_empty() => { let p = PathBuf::from(d); std::fs::create_dir_all(&p).map_err(|e| e.to_string())?; p }
        _ => cache_dir(&app)?,
    };
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
            registry_set(&app, id, &final_path.to_string_lossy());
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
            registry_set(&app, id, &final_path.to_string_lossy());
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            player_info,
            open_in_player,
            check_update,
            local_file,
            local_downloads,
            reveal_file,
            open_downloads_dir,
            pick_folder,
            move_local_file,
            download_to_pc
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Film Index desktop app");
}
