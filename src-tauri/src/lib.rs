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
    name: String,
    path: String,
    full_path: String,
    is_folder: bool,
    zip_path: String,
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
        "CREATE TABLE IF NOT EXISTS zip_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            full_path TEXT NOT NULL,
            is_folder BOOLEAN NOT NULL,
            zip_path TEXT NOT NULL,
            source_zip_file_path TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_full_path ON zip_entries (full_path)",
        [],
    )
    .map_err(|e| e.to_string())?;

    // --- PERBAIKAN: Hapus data lama sebelum memasukkan yang baru ---
    info!("Clearing old cache data...");
    conn.execute("DELETE FROM zip_entries", [])
        .map_err(|e| e.to_string())?;

    let paths = fs::read_dir(zip_dir_path).map_err(|e| e.to_string())?;

    for path in paths {
        let path = path.map_err(|e| e.to_string())?.path();
        if path.is_file() && path.extension().and_then(std::ffi::OsStr::to_str) == Some("zip") {
            let archive_name = path.file_name().unwrap().to_str().unwrap().to_string();
            let zip_file_path_str = path.to_str().unwrap_or("").to_string(); // Dapatkan full path file zip
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
                let full_path = file_in_zip.name().to_string();
                let is_folder = file_in_zip.is_dir();

                let name = Path::new(&full_path)
                    .file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new(""))
                    .to_str()
                    .unwrap_or("")
                    .to_string();

                let parent_path = Path::new(&full_path)
                    .parent()
                    .unwrap_or_else(|| Path::new("/"))
                    .to_str()
                    .unwrap_or("")
                    .to_string();

                tx.execute(
                    "INSERT INTO zip_entries (name, path, full_path, is_folder, zip_path, source_zip_file_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![&name, &parent_path, &full_path, is_folder as i32, &full_path, &zip_file_path_str],
                ).map_err(|e| e.to_string())?;
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
    entry_type: Option<String>,
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

    let mut where_clauses: Vec<String> = vec!["full_path LIKE ?".to_string()];
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(search_query)];

    if let Some(exclude_patterns) = exclude {
        for pattern in exclude_patterns.iter() {
            if !pattern.trim().is_empty() {
                where_clauses.push("full_path NOT LIKE ?".to_string());
                params.push(Box::new(format!("%{}%", pattern)));
            }
        }
    }

    if let Some(depth) = search_depth {
        where_clauses.push("(LENGTH(full_path) - LENGTH(REPLACE(full_path, '/', ''))) <= ?".to_string());
        params.push(Box::new(depth));
    }

    if let Some(et) = entry_type {
        match et.as_str() {
            "file" => where_clauses.push("is_folder = 0".to_string()),
            "folder" => where_clauses.push("is_folder = 1".to_string()),
            "all" => { /* do nothing, search both files and folders */ },
            _ => {},
        }
    }

    let where_sql = where_clauses.join(" AND ");
    let group_by_sql = if unique { "GROUP BY full_path" } else { "" };

    // Get total count
    let count_sql = format!("SELECT COUNT(*) FROM (SELECT 1 FROM zip_entries WHERE {} {})", where_sql, group_by_sql);
    let total_count: u64 = conn
        .query_row(
            &count_sql,
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    // Get entries
    let select_sql = if unique {
        "MIN(id) as id, name, path, full_path, is_folder, zip_path"
    } else {
        "id, name, path, full_path, is_folder, zip_path"
    };

    let query_sql = format!(
        "SELECT {} FROM zip_entries WHERE {} {} ORDER BY full_path ASC LIMIT ? OFFSET ?",
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
                    name: row.get(1)?,
                    path: row.get(2)?,
                    full_path: row.get(3)?,
                    is_folder: row.get(4)?,
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
    app_handle: tauri::AppHandle,
    id: i64,
    destination: String,
) -> Result<String, String> {
    info!("Extracting entry with ID: {} to \"{}\"", id, destination);

    let db_path = get_db_path(&app_handle)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let (source_zip_file_path, entry_zip_path, is_folder): (String, String, bool) = conn
        .query_row(
            "SELECT source_zip_file_path, zip_path, is_folder FROM zip_entries WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("Failed to find entry with ID {}: {}", id, e.to_string()))?;

    let mut files_to_extract: Vec<String> = Vec::new();

    if is_folder {
        // If it's a folder, get all files within that folder
        let folder_prefix = format!("{}/", entry_zip_path.trim_end_matches('/'));
        let mut stmt = conn
            .prepare(
                "SELECT zip_path FROM zip_entries WHERE zip_path LIKE ?1 AND is_folder = 0",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![format!("{}%", folder_prefix)], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        for file_path_result in rows {
            files_to_extract.push(file_path_result.map_err(|e| e.to_string())?);
        }
    } else {
        // If it's a file, just add itself
        files_to_extract.push(entry_zip_path);
    }

    if files_to_extract.is_empty() {
        return Err(format!("No files found to extract for ID {}", id));
    }

    let zip_file = fs::File::open(&source_zip_file_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

    let mut extracted_paths = Vec::new();

    for file_name_in_zip in files_to_extract {
        let mut file_to_extract = archive
            .by_name(&file_name_in_zip)
            .map_err(|e| format!("File not found in zip: {}: {}", file_name_in_zip, e.to_string()))?;

        let outpath = Path::new(&destination).join(file_to_extract.name());

        if let Some(p) = outpath.parent() {
            if !p.exists() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
        }

        // --- Zip Slip Security Check ---
        let canonical_destination = fs::canonicalize(&destination)
            .map_err(|e| format!("Failed to canonicalize destination path: {}", e))?;
        let canonical_outpath = fs::canonicalize(outpath.parent().unwrap_or(Path::new("/")))
            .map_err(|e| format!("Failed to canonicalize output path: {}", e))?;

        if !canonical_outpath.starts_with(&canonical_destination) {
            return Err(format!("Zip Slip detected! Attempt to write outside destination: {}", outpath.display()));
        }
        // ---

        let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
        io::copy(&mut file_to_extract, &mut outfile).map_err(|e| e.to_string())?;
        info!("Extracted \"{}\"", file_name_in_zip);
        extracted_paths.push(outpath.display().to_string());
    }

    let final_path = extracted_paths.first().unwrap_or(&destination.to_string()).to_string();
    info!("Successfully extracted to: {}", final_path);
    Ok(final_path)
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
    info!("Extracting {} entries to \"{}\"", ids.len(), destination);

    let db_path = get_db_path(&app_handle)?;
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    // Create destination directory if it doesn't exist
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;

    let mut all_files_to_extract: HashMap<String, Vec<String>> = HashMap::new(); // source_zip_file_path -> list of files in that zip

    for id in ids {
        let (source_zip_file_path, entry_zip_path, is_folder): (String, String, bool) = conn
            .query_row(
                "SELECT source_zip_file_path, zip_path, is_folder FROM zip_entries WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| format!("Failed to find entry with ID {}: {}", id, e.to_string()))?;

        if is_folder {
            let folder_prefix = format!("{}/", entry_zip_path.trim_end_matches('/'));
            let mut stmt = conn
                .prepare(
                    "SELECT zip_path FROM zip_entries WHERE zip_path LIKE ?1 AND is_folder = 0",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![format!("{}%", folder_prefix)], |row| row.get(0))
                .map_err(|e| e.to_string())?;

            for file_path_result in rows {
                all_files_to_extract
                    .entry(source_zip_file_path.clone())
                    .or_default()
                    .push(file_path_result.map_err(|e| e.to_string())?);
            }
        } else {
            all_files_to_extract
                .entry(source_zip_file_path.clone())
                .or_default()
                .push(entry_zip_path);
        }
    }

    let extraction_results: Vec<Result<(), String>> = all_files_to_extract
        .par_iter()
        .map(|(source_zip_file_path, files_in_zip)| {
            info!(
                "Processing archive: \"{}\" for {} files",
                source_zip_file_path,
                files_in_zip.len()
            );
            let zip_file = fs::File::open(source_zip_file_path).map_err(|e| e.to_string())?;
            let mut archive = ZipArchive::new(zip_file).map_err(|e| e.to_string())?;

            let canonical_destination = fs::canonicalize(&destination)
                .map_err(|e| format!("Failed to canonicalize destination path: {}", e))?;

            for file_name_in_zip in files_in_zip {
                let mut file_to_extract = archive
                    .by_name(file_name_in_zip)
                    .map_err(|e| format!("File not found in zip: {}: {}", file_name_in_zip, e.to_string()))?;

                let outpath = Path::new(&destination).join(file_to_extract.name());

                // --- Zip Slip Security Check ---
                if let Some(p) = outpath.parent() {
                    if !p.exists() {
                        fs::create_dir_all(p).map_err(|e| e.to_string())?;
                    }
                }

                let canonical_outpath = fs::canonicalize(outpath.parent().unwrap_or(Path::new("/")))
                    .map_err(|e| format!("Failed to canonicalize output path: {}", e))?;

                if !canonical_outpath.starts_with(&canonical_destination) {
                    return Err(format!("Zip Slip detected! Attempt to write outside destination: {}", outpath.display()));
                }
                // ---

                let mut outfile = fs::File::create(&outpath).map_err(|e| e.to_string())?;
                io::copy(&mut file_to_extract, &mut outfile).map_err(|e| e.to_string())?;
                info!("Extracted \"{}\"", file_name_in_zip);
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
