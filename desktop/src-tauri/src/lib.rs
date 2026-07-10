use std::process::Command;
use serde::Serialize;

#[derive(Serialize)]
struct PlayerInfo {
    os: String,
    arch: String,
    mpv: bool,
}

/// Is a command available on PATH?
fn have(cmd: &str) -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    Command::new(probe)
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Info the UI can show about this device's playback capabilities.
#[tauri::command]
fn player_info() -> PlayerInfo {
    PlayerInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        mpv: have("mpv"),
    }
}

/// Open a stream URL in the best available player: mpv if present, else the
/// operating system's default handler. Returns which one was used.
#[tauri::command]
fn open_in_player(url: String, title: Option<String>) -> Result<String, String> {
    if have("mpv") {
        let mut c = Command::new("mpv");
        if let Some(t) = title {
            c.arg(format!("--force-media-title={t}"));
        }
        c.arg(&url);
        c.spawn().map_err(|e| e.to_string())?;
        return Ok("mpv".to_string());
    }

    #[cfg(target_os = "macos")]
    Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;

    Ok("system default".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![player_info, open_in_player])
        .run(tauri::generate_context!())
        .expect("error while running the Film Index desktop app");
}
