use rusqlite::{params, Connection, Result};
use std::fs;
use std::io;
use std::path::Path;
use zip::ZipArchive;
use log::{info, warn};

// Struct untuk menampung data yang akan dikirim ke frontend
#[derive(serde::Serialize, Debug)]
struct FileEntry {
    id: i64,
    archive_name: String,
    file_name: String,
    file_size: u64,
    compressed_size: u64,
    zip_path: String, // Tambahkan path zip
}

// Fungsi untuk mendapatkan path database
fn get_db_path() -> String {
    "cache.sqlite".to_string()
}

#[tauri::command]
async fn build_cache(zip_dir_path: String) -> Result<(), String> {
    info!("Starting cache build from path: {}", zip_dir_path);
    let db_path = get_db_path();
    let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS files (
            id              INTEGER PRIMARY KEY,
            archive_name    TEXT NOT NULL,
            file_name       TEXT NOT NULL,
            file_size       INTEGER,
            compressed_size INTEGER,
            zip_path        TEXT NOT NULL
        )",
        [],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_name ON files (file_name)",
        [],
    ).map_err(|e| e.to_string())?;

    // --- PERBAIKAN: Hapus data lama sebelum memasukkan yang baru ---
    info!("Clearing old cache data...");
    conn.execute("DELETE FROM files", []).map_err(|e| e.to_string())?;

    let paths = fs::read_dir(zip_dir_path).map_err(|e| e.to_string())?;

    for path in paths {
        let path = path.map_err(|e| e.to_string())?.path();
        if path.is_file() && path.extension().and_then(std::ffi::OsStr::to_str) == Some("zip") {
            let archive_name = path.file_name().unwrap().to_str().unwrap().to_string();
            let zip_path_str = path.to_str().unwrap_or("").to_string(); // Dapatkan full path
            info!("Processing archive: {}", archive_name);

            let file = match fs::File::open(&path) {
                Ok(f) => f,
                Err(e) => {
                    warn!("Could not open file {}: {}. Skipping.", path.display(), e);
                    continue;
                }
            };

            let mut archive = match ZipArchive::new(file) {
                Ok(a) => a,
                Err(e) => {
                    warn!("Failed to read ZIP archive '{}': {}. It might be corrupted or not a valid ZIP. Skipping.", &archive_name, e);
                    continue;
                }
            };
            
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for i in 0..archive.len() {
                let file_in_zip = archive.by_index(i).map_err(|e| e.to_string())?;
                if !file_in_zip.is_dir() {
                    let file_name = file_in_zip.name().to_string();
                    tx.execute(
                        "INSERT INTO files (archive_name, file_name, file_size, compressed_size, zip_path) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![&archive_name, &file_name, file_in_zip.size(), file_in_zip.compressed_size(), &zip_path_str],
                    ).map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            info!("Finished processing archive: {}", archive_name);
        }
    }

    info!("Cache build finished successfully.");
    Ok(())
}

#[derive(serde::Serialize, Debug)]
struct SearchResult {
    entries: Vec<FileEntry>,
    total_count: u64,
}

#[tauri::command]
async fn search_files(query: String, page: u32, limit: u32) -> Result<SearchResult, String> {
    info!("Searching for: {}", query);
    let db_path = get_db_path();
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let search_query = format!("%{}%", query);
    let offset = (page - 1) * limit;

    // Get total count
    let total_count: u64 = conn.query_row(
        "SELECT COUNT(*) FROM files WHERE file_name LIKE ?1",
        params![search_query],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "SELECT id, archive_name, file_name, file_size, compressed_size, zip_path FROM files WHERE file_name LIKE ?1 LIMIT ?2 OFFSET ?3"
    ).map_err(|e| e.to_string())?;
    
    let entries = stmt.query_map(params![search_query, limit, offset], |row| {
        Ok(FileEntry {
            id: row.get(0)?,
            archive_name: row.get(1)?,
            file_name: row.get(2)?,
            file_size: row.get(3)?,
            compressed_size: row.get(4)?,
            zip_path: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for entry in entries {
        result.push(entry.map_err(|e| e.to_string())?);
    }
    
    info!("Found {} results (total: {}).", result.len(), total_count);
    Ok(SearchResult { entries: result, total_count })
}

#[tauri::command]
fn extract_file(zip_path: String, file_name: String, destination: String) -> Result<String, String> {
    info!("Extracting '{}' from '{}' to '{}'", file_name, zip_path, destination);

    let zip_file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    let mut file_to_extract = archive.by_name(&file_name).map_err(|e| e.to_string())?;

    let outpath = Path::new(&destination).join(file_to_extract.name());

    if let Some(p) = outpath.parent() {
        if !p.exists() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
    }

    let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
    io::copy(&mut file_to_extract, &mut outfile).map_err(|e| e.to_string())?;
    
    info!("Successfully extracted file to: {}", outpath.display());
    Ok(outpath.display().to_string())
}

#[tauri::command]
fn show_item_in_folder_custom(path: String) -> Result<(), String> {
    info!("Attempting to show item in folder: {}", path);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(Path::new(&path).parent().unwrap_or_else(|| Path::new(&path))) // xdg-open opens directory, not selects item
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }
    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![build_cache, search_files, extract_file, show_item_in_folder_custom])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}