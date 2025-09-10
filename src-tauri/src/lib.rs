use log::{info, warn};
use rayon::prelude::*;
use rusqlite::{params, Connection, Result};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::path::BaseDirectory;
use tauri::Manager;
use zip::ZipArchive;

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
fn get_db_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .resolve("cache", BaseDirectory::AppData)
        .map_err(|_| "Failed to resolve app data directory".to_string())?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    Ok(app_data_dir.join("cache.sqlite"))
}

#[tauri::command]
async fn build_cache(app_handle: tauri::AppHandle, zip_dir_path: String) -> Result<(), String> {
    info!("Starting cache build from path: {}", zip_dir_path);
    let db_path = get_db_path(&app_handle)?;
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
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_name ON files (file_name)",
        [],
    )
    .map_err(|e| e.to_string())?;

    // --- PERBAIKAN: Hapus data lama sebelum memasukkan yang baru ---
    info!("Clearing old cache data...");
    conn.execute("DELETE FROM files", [])
        .map_err(|e| e.to_string())?;

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
async fn search_files(
    app_handle: tauri::AppHandle,
    query: String,
    page: u32,
    limit: u32,
    exclude: Option<Vec<String>>,
    search_depth: Option<u32>,
    unique: bool,
) -> Result<SearchResult, String> {
    info!(
        "Searching for: '{}', excluding: {:?}, depth: {:?}, unique: {}",
        query,
        exclude,
        search_depth,
        unique
    );
    let db_path = get_db_path(&app_handle)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let search_query = format!("%{}%", query);
    let offset = (page - 1) * limit;

    let mut where_clauses: Vec<String> = vec!["file_name LIKE ?".to_string()];
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(search_query)];

    if let Some(exclude_patterns) = exclude {
        for pattern in exclude_patterns.iter() {
            if !pattern.trim().is_empty() {
                where_clauses.push("file_name NOT LIKE ?".to_string());
                params.push(Box::new(format!("%{}%", pattern)));
            }
        }
    }

    if let Some(depth) = search_depth {
        where_clauses.push("(LENGTH(file_name) - LENGTH(REPLACE(file_name, '/', ''))) <= ?".to_string());
        params.push(Box::new(depth));
    }

    let where_sql = where_clauses.join(" AND ");
    let group_by_sql = if unique { "GROUP BY file_name" } else { "" };

    // Get total count
    let count_sql = format!("SELECT COUNT(*) FROM (SELECT 1 FROM files WHERE {} {})", where_sql, group_by_sql);
    let total_count: u64 = conn
        .query_row(
            &count_sql,
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    // Get entries
    let select_sql = if unique {
        "MIN(id) as id, archive_name, file_name, file_size, compressed_size, zip_path"
    } else {
        "id, archive_name, file_name, file_size, compressed_size, zip_path"
    };

    let query_sql = format!(
        "SELECT {} FROM files WHERE {} {} ORDER BY file_name ASC LIMIT ? OFFSET ?",
        select_sql, where_sql, group_by_sql
    );
    let mut stmt = conn.prepare(&query_sql).map_err(|e| e.to_string())?;

    let mut query_params: Vec<Box<dyn rusqlite::ToSql>> = params;
    query_params.push(Box::new(limit));
    query_params.push(Box::new(offset));

    let entries = stmt
        .query_map(
            rusqlite::params_from_iter(query_params.iter().map(|p| p.as_ref())),
            |row| {
                Ok(FileEntry {
                    id: row.get(0)?,
                    archive_name: row.get(1)?,
                    file_name: row.get(2)?,
                    file_size: row.get(3)?,
                    compressed_size: row.get(4)?,
                    zip_path: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for entry in entries {
        result.push(entry.map_err(|e| e.to_string())?);
    }

    info!("Found {} results (total: {}).", result.len(), total_count);
    Ok(SearchResult {
        entries: result,
        total_count,
    })
}

#[tauri::command]
fn extract_file(
    zip_path: String,
    file_name: String,
    destination: String,
) -> Result<String, String> {
    info!(
        "Extracting \"{}\" from \"{}\" to \"{}\"",
        file_name, zip_path, destination
    );

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
            .arg(
                Path::new(&path)
                    .parent()
                    .unwrap_or_else(|| Path::new(&path)),
            ) // xdg-open opens directory, not selects item
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn extract_files(
    app_handle: tauri::AppHandle,
    ids: Vec<i64>,
    destination: String,
) -> Result<String, String> {
    info!("Extracting {} files to \"{}\"", ids.len(), destination);

    let db_path = get_db_path(&app_handle)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    // Create destination directory if it doesn't exist
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;

    // 1. Fetch all file data at once
    let ids_str: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
    let query = format!(
        "SELECT zip_path, file_name FROM files WHERE id IN ({})",
        ids_str.join(",")
    );

    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let file_iter = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;

    // 2. Group files by archive
    let mut files_by_archive: HashMap<String, Vec<String>> = HashMap::new();
    for result in file_iter {
        let (zip_path, file_name): (String, String) = result.map_err(|e| e.to_string())?;
        files_by_archive
            .entry(zip_path)
            .or_default()
            .push(file_name);
    }

    // 3. Parallel extraction
    let extraction_results: Vec<Result<(), String>> = files_by_archive
        .par_iter()
        .map(|(zip_path, file_names)| {
            info!(
                "Processing archive: \"{}\" for {} files",
                zip_path,
                file_names.len()
            );
            let zip_file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
            let mut archive = ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

            for file_name in file_names {
                let mut file_to_extract = archive.by_name(file_name).map_err(|e| e.to_string())?;
                let outpath = Path::new(&destination).join(file_to_extract.name());

                if let Some(p) = outpath.parent() {
                    if !p.exists() {
                        fs::create_dir_all(p).map_err(|e| e.to_string())?;
                    }
                }

                let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
                io::copy(&mut file_to_extract, &mut outfile).map_err(|e| e.to_string())?;
                info!("Extracted \"{}\"", file_name);
            }
            Ok(())
        })
        .collect();

    // Check for errors during parallel extraction
    for result in extraction_results {
        if let Err(e) = result {
            return Err(e);
        }
    }

    info!("Successfully extracted all files to: {}", destination);
    Ok(destination)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            build_cache,
            search_files,
            extract_file,
            show_item_in_folder_custom,
            extract_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
