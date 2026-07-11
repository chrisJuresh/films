use std::path::PathBuf;
use std::process::Command;
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
    let out = Command::new(probe).arg(cmd).output().ok()?;
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
    if let Some(p) = which("mpv") {
        return Some(p);
    }
    mpv_candidates()
        .into_iter()
        .find(|c| c.exists())
        .map(|c| c.to_string_lossy().to_string())
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
struct DlProgress {
    id: i64,
    received: u64,
    total: u64,
    done: bool,
}

/// Download a film to the local cache (preload), emitting `films-download-progress`
/// events so the UI can show a bar. Returns the final local path when complete.
#[tauri::command]
async fn download_to_pc(app: AppHandle, window: tauri::WebviewWindow, url: String, id: i64, ext: Option<String>, cf_id: Option<String>, cf_secret: Option<String>) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let dir = cache_dir(&app)?;
    let ext = ext.unwrap_or_else(|| "mp4".to_string());
    let final_path = dir.join(format!("{id}.{ext}"));
    let part = dir.join(format!("{id}.{ext}.part"));

    let client = reqwest::Client::builder()
        .user_agent("films-desktop")
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    // Authenticate through Cloudflare Access: Access service token, else the cookie.
    if let (Some(cid), Some(cs)) = (cf_id.as_deref(), cf_secret.as_deref()) {
        req = req.header("CF-Access-Client-Id", cid).header("CF-Access-Client-Secret", cs);
    } else if let Some(cookie) = cf_cookie_header(&window) {
        req = req.header(reqwest::header::COOKIE, cookie);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Download failed (HTTP {})", resp.status()));
    }
    // A native client has no login session, so an auth wall (Cloudflare Access)
    // redirects to a login page. Refuse to save that as if it were the film.
    let final_host = resp.url().host_str().unwrap_or("").to_string();
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if final_host.contains("cloudflareaccess.com") || ctype.starts_with("text/html") {
        return Err("Cloudflare Access blocked the app — it has no login session. A CF Access service token is needed for native download / mpv.".to_string());
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received - last_emit > 2_000_000 {
            last_emit = received;
            let _ = app.emit("films-download-progress", DlProgress { id, received, total, done: false });
        }
    }
    file.flush().ok();
    std::fs::rename(&part, &final_path).map_err(|e| e.to_string())?;
    let _ = app.emit("films-download-progress", DlProgress { id, received, total, done: true });
    Ok(final_path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            player_info,
            open_in_player,
            check_update,
            local_file,
            download_to_pc
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Film Index desktop app");
}
