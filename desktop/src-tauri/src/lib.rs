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
fn open_in_player(url: String, title: Option<String>, prefer: Option<String>) -> Result<String, String> {
    if prefer.as_deref() == Some("default") {
        return open_default(&url);
    }
    match find_mpv() {
        Some(mpv) => {
            let mut c = Command::new(&mpv);
            if let Some(t) = title {
                c.arg(format!("--force-media-title={t}"));
            }
            c.arg("--force-window=immediate");
            c.arg(&url);
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
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
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
async fn download_to_pc(app: AppHandle, url: String, id: i64, ext: Option<String>) -> Result<String, String> {
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
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Download failed (HTTP {})", resp.status()));
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
