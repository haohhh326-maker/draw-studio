use std::{fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{LogicalPosition, LogicalSize, Manager, Rect, Url, WebviewUrl, webview::{Webview, WebviewBuilder, cookie::{Cookie, SameSite, time::OffsetDateTime}}};
use serde::{Deserialize, Serialize};
use rusqlite::{Connection, params, OptionalExtension};
struct Storage { database: Mutex<Connection>, assets: PathBuf }
fn error(e: impl std::fmt::Display) -> String { e.to_string() }
fn asset_path(state: &Storage, id: &str) -> Result<PathBuf, String> {
 if id.is_empty() || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
  return Err("Invalid asset identifier".into());
 }
 Ok(state.assets.join(id))
}
#[tauri::command]
fn read_record(state: tauri::State<Storage>, key: String) -> Result<Option<String>, String> {
 let db = state.database.lock().map_err(error)?;
 db.query_row("SELECT value FROM records WHERE key = ?1", params![key], |row| row.get(0)).optional().map_err(error)
}
#[tauri::command]
fn write_record(state: tauri::State<Storage>, key: String, value: String) -> Result<(), String> {
 let db = state.database.lock().map_err(error)?;
 db.execute("INSERT INTO records(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value]).map_err(error)?;
 Ok(())
}
#[tauri::command]
fn write_asset(state: tauri::State<Storage>, id: String, bytes: Vec<u8>) -> Result<(), String> {
 let path=asset_path(&state,&id)?;
 let tmp=path.with_extension("tmp");
 fs::write(&tmp,bytes).map_err(error)?;
 if path.exists() { fs::remove_file(&tmp).map_err(error)?; } else { fs::rename(&tmp,path).map_err(error)?; }
 Ok(())
}
#[tauri::command]
fn read_asset(state: tauri::State<Storage>, id: String) -> Result<Vec<u8>, String> {
 fs::read(asset_path(&state,&id)?).map_err(error)
}
#[tauri::command]
fn choose_project_directory() -> Option<String> {
 rfd::FileDialog::new().set_title("选择项目存放目录").pick_folder().map(|p| p.to_string_lossy().into_owned())
}
#[tauri::command]
fn save_project_archive(directory: String, project_id: String, bytes: Vec<u8>) -> Result<(), String> {
 if project_id.is_empty() || !project_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') { return Err("Invalid project identifier".into()); }
 let root = PathBuf::from(directory).canonicalize().map_err(error)?;
 if !root.is_dir() { return Err("Storage path is not a directory".into()); }
 let dest = root.join(format!("project-{}.aicanvas", project_id));
 let temp = root.join(format!("project-{}.aicanvas.tmp", project_id));
 fs::write(&temp, bytes).map_err(error)?;
 fs::rename(&temp, &dest).map_err(error)?;
 Ok(())
}
fn service_webview(service: &str) -> Result<(&'static str, &'static str), String> {
 match service {
  "muse" => Ok(("service-muse", "https://muse.ai/")),
  "deepseek" => Ok(("service-deepseek", "https://chat.deepseek.com/")),
  _ => Err("Unknown browser service".into()),
 }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceAuthSnapshot { cookies: Vec<ServiceCookie>, origins: Vec<ServiceOriginStorage> }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceCookie {
 name: String, value: String, domain: String, path: String,
 expires: Option<f64>, http_only: Option<bool>, secure: Option<bool>, same_site: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceOriginStorage { origin: String, local_storage: Vec<ServiceStorageItem> }
#[derive(Serialize, Deserialize)]
struct ServiceStorageItem { name: String, value: String }

fn service_origin(service: &str) -> Result<&'static str, String> {
 match service {
  "muse" => Ok("https://muse.ai"),
  "deepseek" => Ok("https://chat.deepseek.com"),
  _ => Err("Unknown browser service".into()),
 }
}
fn permitted_cookie_domain(service: &str, domain: &str) -> bool {
 let normalized = domain.trim_start_matches('.').to_ascii_lowercase();
 match service {
  "muse" => normalized == "muse.ai",
  "deepseek" => normalized == "deepseek.com" || normalized == "chat.deepseek.com",
  _ => false,
 }
}
async fn evaluate_storage(view: &Webview, script: String) -> Result<serde_json::Value, String> {
 let (sender, receiver) = std::sync::mpsc::sync_channel::<String>(1);
 view.eval_with_callback(script, move |result| { let _ = sender.send(result); })
  .map_err(|_| "Browser storage cannot be read".to_string())?;
 let raw = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(8)))
  .await.map_err(|_| "Browser storage is unavailable".to_string())?
  .map_err(|_| "Browser storage is unavailable".to_string())?;
 serde_json::from_str(&raw).map_err(|_| "Browser storage response is invalid".to_string())
}
async fn wait_for_service_origin(view: &Webview, origin: &str) -> Result<(), String> {
 for _ in 0..40 {
  if view.url().map(|url| url.origin().ascii_serialization() == origin).unwrap_or(false) {
   return Ok(());
  }
  tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
   .await.map_err(|_| "Browser page is unavailable".to_string())?;
 }
 Err("Browser page is not on the expected site".into())
}
#[tauri::command]
async fn export_service_webview_auth(app: tauri::AppHandle, service: String) -> Result<ServiceAuthSnapshot, String> {
 let (label, _) = service_webview(&service)?;
 let origin = service_origin(&service)?;
 let Some(view) = app.get_webview(label) else { return Ok(ServiceAuthSnapshot::default()); };
 let url = Url::parse(origin).map_err(error)?;
 // Tauri's asynchronous command avoids WebView2's synchronous cookie deadlock.
 let cookies = view.cookies_for_url(url).map_err(|_| "Browser cookies are unavailable".to_string())?
  .into_iter().filter(|cookie| cookie.domain().map(|domain| permitted_cookie_domain(&service, domain)).unwrap_or(true))
  .map(|cookie| ServiceCookie {
   name: cookie.name().to_owned(), value: cookie.value().to_owned(),
   domain: cookie.domain().map(str::to_owned).unwrap_or_else(|| origin.trim_start_matches("https://").to_owned()),
   path: cookie.path().unwrap_or("/").to_owned(),
   expires: Some(cookie.expires_datetime().map(|date| date.unix_timestamp() as f64).unwrap_or(-1.0)),
   http_only: Some(cookie.http_only().unwrap_or(false)), secure: Some(cookie.secure().unwrap_or(false)),
   same_site: cookie.same_site().map(|site| match site { SameSite::Strict => "Strict", SameSite::Lax => "Lax", SameSite::None => "None" }.to_owned()),
  }).collect();
 let script = format!(r#"(() => {{ try {{ if (location.origin !== {origin}) return null; return {{ origin: location.origin, localStorage: Object.keys(localStorage).map(name => ({{name, value: localStorage.getItem(name) || ''}})) }}; }} catch {{ return null; }} }})()"#,
  origin = serde_json::to_string(origin).map_err(error)?);
 let mut origins = Vec::new();
 if let Ok(value) = evaluate_storage(&view, script).await {
  if let Ok(Some(storage)) = serde_json::from_value::<Option<ServiceOriginStorage>>(value) {
   if storage.origin == origin { origins.push(storage); }
  }
 }
 Ok(ServiceAuthSnapshot { cookies, origins })
}
#[tauri::command]
async fn import_service_webview_auth(app: tauri::AppHandle, service: String, snapshot: ServiceAuthSnapshot) -> Result<(), String> {
 let (label, _) = service_webview(&service)?;
 let origin = service_origin(&service)?;
 let Some(view) = app.get_webview(label) else { return Ok(()); };
 if snapshot.cookies.len() > 500 || snapshot.origins.len() > 1 { return Err("Browser session is invalid".into()); }
 if snapshot.cookies.is_empty() && snapshot.origins.is_empty() { return Ok(()); }
 wait_for_service_origin(&view, origin).await?;
 for source in snapshot.cookies {
  if source.name.is_empty() || source.name.len() > 256 || source.value.len() > 16384 ||
   source.path.is_empty() || !source.path.starts_with('/') ||
   !permitted_cookie_domain(&service, &source.domain) { return Err("Browser cookie is invalid".into()); }
  let mut builder = Cookie::build((source.name, source.value)).path(source.path)
   .secure(source.secure.unwrap_or(true)).http_only(source.http_only.unwrap_or(false));
  // A leading dot denotes a domain cookie. Apex DeepSeek cookies also need a
  // Domain attribute when imported into chat.deepseek.com.
  if source.domain.starts_with('.') || source.domain != origin.trim_start_matches("https://") {
   builder = builder.domain(source.domain);
  }
  if let Some(site) = source.same_site {
   let parsed = match site.as_str() { "Strict" => SameSite::Strict, "Lax" => SameSite::Lax, "None" => SameSite::None,
    _ => return Err("Browser cookie SameSite is invalid".into()) };
   builder = builder.same_site(parsed);
  }
  if let Some(expires) = source.expires {
   if !expires.is_finite() { return Err("Browser cookie expiration is invalid".into()); }
   if expires > 0.0 {
    builder = builder.expires(OffsetDateTime::from_unix_timestamp(expires as i64).map_err(|_| "Browser cookie expiration is invalid".to_string())?);
   }
  }
  view.set_cookie(builder.build()).map_err(|_| "Browser cookie cannot be imported".to_string())?;
 }
 for storage in snapshot.origins {
  if storage.origin != origin || storage.local_storage.len() > 1000 ||
   storage.local_storage.iter().any(|item| item.name.len() > 1024 || item.value.len() > 1_000_000) {
    return Err("Browser storage origin is invalid".into());
  }
  let entries = serde_json::to_string(&storage.local_storage).map_err(error)?;
  let origin_json = serde_json::to_string(origin).map_err(error)?;
  let script = format!(r#"(() => {{ try {{ if (location.origin !== {origin}) return false; for (const item of {entries}) localStorage.setItem(item.name, item.value); return true; }} catch {{ return false; }} }})()"#,
   origin = origin_json, entries = entries);
  let mut saved = false;
  for _ in 0..3 {
   if evaluate_storage(&view, script.clone()).await? == serde_json::Value::Bool(true) { saved = true; break; }
   tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
    .await.map_err(|_| "Browser storage is unavailable".to_string())?;
  }
  if !saved { return Err("Browser storage is not on the expected site".into()); }
 }
 view.reload().map_err(|_| "Browser session reload failed".to_string())?;
 Ok(())
}
fn service_bounds(x: f64, y: f64, width: f64, height: f64) -> Result<Rect, String> {
 if ![x, y, width, height].iter().all(|value| value.is_finite()) || width <= 0.0 || height <= 0.0 {
  return Err("Invalid browser bounds".into());
 }
 Ok(Rect {
  position: LogicalPosition::new(x, y).into(),
  size: LogicalSize::new(width, height).into(),
 })
}
#[tauri::command]
async fn show_service_webview(app: tauri::AppHandle, service: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
 let (label, url) = service_webview(&service)?;
 let bounds = service_bounds(x, y, width, height)?;
 let other = if label == "service-muse" { "service-deepseek" } else { "service-muse" };
 if let Some(view) = app.get_webview(other) { view.hide().map_err(error)?; }
 if let Some(view) = app.get_webview(label) {
  view.set_bounds(bounds).map_err(error)?;
  view.show().map_err(error)?;
  view.set_focus().map_err(error)?;
  return Ok(());
 }
 let window = app.get_window("main").ok_or("Canvas window is unavailable")?;
 let data_dir = app.path().app_data_dir().map_err(error)?.join("service-webviews").join(label);
 fs::create_dir_all(&data_dir).map_err(error)?;
 let view = window.add_child(
  WebviewBuilder::new(label, WebviewUrl::External(url.parse().map_err(error)?))
   .data_directory(data_dir)
   .enable_clipboard_access(),
  LogicalPosition::new(x, y),
  LogicalSize::new(width, height),
 ).map_err(error)?;
 view.set_focus().map_err(error)?;
 Ok(())
}
#[tauri::command]
async fn set_service_webview_bounds(app: tauri::AppHandle, service: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
 let (label, _) = service_webview(&service)?;
 let bounds = service_bounds(x, y, width, height)?;
 if let Some(view) = app.get_webview(label) { view.set_bounds(bounds).map_err(error)?; }
 Ok(())
}
#[tauri::command]
async fn hide_service_webview(app: tauri::AppHandle, service: String) -> Result<(), String> {
 let (label, _) = service_webview(&service)?;
 if let Some(view) = app.get_webview(label) { view.hide().map_err(error)?; }
 Ok(())
}
#[tauri::command]
async fn reload_service_webview(app: tauri::AppHandle, service: String) -> Result<(), String> {
 let (label, _) = service_webview(&service)?;
 let view = app.get_webview(label).ok_or("Browser is not open")?;
 view.reload().map_err(error)
}
#[tauri::command]
async fn set_service_webview_zoom(app: tauri::AppHandle, service: String, zoom: f64) -> Result<(), String> {
 let (label, _) = service_webview(&service)?;
 if !zoom.is_finite() || !(0.5..=2.5).contains(&zoom) { return Err("Invalid browser zoom".into()); }
 let view = app.get_webview(label).ok_or("Browser is not open")?;
 view.set_zoom(zoom).map_err(error)
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
 tauri::Builder::default()
 .plugin(tauri_plugin_http::init())
 .plugin(tauri_plugin_websocket::init())
 .setup(|app| {
  let root=app.path().app_data_dir()?;
  fs::create_dir_all(root.join("assets"))?;
  let db=Connection::open(root.join("workspace.sqlite"))?;
  db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
  app.manage(Storage{database:Mutex::new(db),assets:root.join("assets")});
  Ok(())
 })
 .invoke_handler(tauri::generate_handler![read_record,write_record,write_asset,read_asset,choose_project_directory,save_project_archive,show_service_webview,set_service_webview_bounds,hide_service_webview,reload_service_webview,set_service_webview_zoom,export_service_webview_auth,import_service_webview_auth])
 .run(tauri::generate_context!())
 .expect("Unable to start Draw studio");
}
