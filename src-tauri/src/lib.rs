// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::path::PathBuf;
use std::fs;
use std::io::{BufReader, BufRead};
use std::thread;
use std::sync::mpsc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State, Runtime,
};
use std::sync::Arc;
use regex::Regex;
use std::process::Command;
use std::time::Duration;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct MCPServerConfig {
    command: String,
    args: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Config {
    mcp_servers: HashMap<String, MCPServerConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            mcp_servers: HashMap::new(),
        }
    }
}

// Store for running processes and their info
struct ProcessStore {
    inner: Arc<Mutex<HashMap<String, (Child, CommandInfo)>>>
}

impl ProcessStore {
    fn new() -> Self {
        ProcessStore {
            inner: Arc::new(Mutex::new(HashMap::new()))
        }
    }
}

// Store for process output
struct OutputStore {
    inner: Arc<Mutex<HashMap<String, Vec<String>>>>
}

impl OutputStore {
    fn new() -> Self {
        OutputStore {
            inner: Arc::new(Mutex::new(HashMap::new()))
        }
    }
}

// Store for configuration
struct ConfigStore(Mutex<Config>);

#[derive(Debug, Clone, serde::Serialize)]
struct CommandInfo {
    id: String,
    is_running: bool,
    port: Option<u16>,
    has_error: bool,
}

fn detect_process_ports(pid: u32) -> Option<u16> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("netstat")
            .args(["-ano"])
            .output()
            .ok()?;
        
        let output_str = String::from_utf8_lossy(&output.stdout);
        for line in output_str.lines() {
            if line.contains(&pid.to_string()) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Some(port_str) = parts[1].split(':').last() {
                        if let Ok(port) = port_str.parse::<u16>() {
                            return Some(port);
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("lsof")
            .args(["-P", "-p", &pid.to_string(), "-i", "4TCP"])
            .output()
            .ok()?;
        
        let output_str = String::from_utf8_lossy(&output.stdout);
        for line in output_str.lines() {
            if line.contains("LISTEN") {
                if let Some(addr) = line.split_whitespace().last() {
                    if let Some(port_str) = addr.split(':').last() {
                        if let Ok(port) = port_str.parse::<u16>() {
                            return Some(port);
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let output = Command::new("lsof")
            .args(["-P", "-p", &pid.to_string(), "-i", "4TCP"])
            .output()
            .ok()?;
        
        let output_str = String::from_utf8_lossy(&output.stdout);
        for line in output_str.lines() {
            if line.contains("LISTEN") {
                if let Some(addr) = line.split_whitespace().last() {
                    if let Some(port_str) = addr.split(':').last() {
                        if let Ok(port) = port_str.parse::<u16>() {
                            return Some(port);
                        }
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
async fn load_config<R: Runtime>(
    config_path: Option<String>,
    config_store: State<'_, ConfigStore>,
    app: tauri::AppHandle<R>,
) -> Result<Config, String> {
    let config = if let Some(path) = config_path {
        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read config file: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config file: {}", e))?
    } else {
        // Try to load from default location
        let app_dir = app.path().app_config_dir()
            .map_err(|_| "Failed to get app config directory".to_string())?;
        let config_path = app_dir.join("mcp-config.json");
        
        if config_path.exists() {
            let content = fs::read_to_string(config_path)
                .map_err(|e| format!("Failed to read config file: {}", e))?;
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config file: {}", e))?
        } else {
            Config::default()
        }
    };

    let mut store = config_store.0.lock().map_err(|e| e.to_string())?;
    *store = config.clone();
    Ok(config)
}

#[tauri::command]
async fn save_config<R: Runtime>(
    config: Config,
    config_path: Option<String>,
    config_store: State<'_, ConfigStore>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    // Update the config store with the new configuration
    {
        let mut store = config_store.0.lock().map_err(|e| e.to_string())?;
        *store = config.clone();
    }
    
    let config_path = if let Some(path) = config_path {
        PathBuf::from(path)
    } else {
        let app_dir = app.path().app_config_dir()
            .map_err(|_| "Failed to get app config directory".to_string())?;
        fs::create_dir_all(&app_dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
        app_dir.join("mcp-config.json")
    };

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    fs::write(config_path, content)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    
    Ok(())
}

#[tauri::command]
async fn add_server<R: Runtime>(
    name: String,
    command: String,
    args: Vec<String>,
    config_store: State<'_, ConfigStore>,
    app: tauri::AppHandle<R>,
) -> Result<Config, String> {
    let mut store = config_store.0.lock().map_err(|e| e.to_string())?;
    
    store.mcp_servers.insert(name, MCPServerConfig { command, args });
    
    // Ensure config directory exists and save the updated config
    let app_dir = app.path().app_config_dir()
        .map_err(|_| "Failed to get app config directory".to_string())?;
    fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    
    let config_path = app_dir.join("mcp-config.json");
    let content = serde_json::to_string_pretty(&*store)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    fs::write(config_path, content)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    
    Ok(store.clone())
}

#[tauri::command]
async fn start_command(
    id: String,
    process_store: State<'_, ProcessStore>,
    config_store: State<'_, ConfigStore>,
    output_store: State<'_, OutputStore>,
) -> Result<CommandInfo, String> {
    let mut store = process_store.inner.lock().map_err(|e| e.to_string())?;
    let config = config_store.0.lock().map_err(|e| e.to_string())?;
    
    if store.contains_key(&id) {
        return Err("Command is already running".to_string());
    }

    let server_config = config.mcp_servers.get(&id)
        .ok_or_else(|| format!("Server '{}' not found in configuration", id))?;

    // Use the system shell to run the command
    #[cfg(target_os = "windows")]
    let (shell, shell_arg) = ("cmd", "/C");
    #[cfg(not(target_os = "windows"))]
    let (shell, shell_arg) = ("sh", "-c");

    // Construct the full command string
    let full_command = format!("{} {}", server_config.command, server_config.args.join(" "));

    // Clear previous output
    {
        let mut output_map = output_store.inner.lock().map_err(|e| e.to_string())?;
        output_map.insert(id.clone(), Vec::new());
    }

    // Create command info
    let command_info = CommandInfo {
        id: id.clone(),
        is_running: true,
        port: None,
        has_error: false,
    };

    // Create a channel for port updates
    let (port_tx, port_rx) = mpsc::channel();

    // Spawn the process with piped output
    let mut child = std::process::Command::new(shell)
        .arg(shell_arg)
        .arg(&full_command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start command: {}. Full command: {}", e, full_command))?;

    // Port detection patterns
    let port_patterns = vec![
        Regex::new(r"listening on .*:(\d+)").unwrap(),
        Regex::new(r"server started .*:(\d+)").unwrap(),
        Regex::new(r"running at .*:(\d+)").unwrap(),
        Regex::new(r"started server on .*:(\d+)").unwrap(),
        Regex::new(r"localhost:(\d+)").unwrap(),
    ];

    // Capture output in background threads
    if let Some(stdout) = child.stdout.take() {
        let id_clone = id.clone();
        let output_store = Arc::clone(&output_store.inner);
        let port_patterns = port_patterns.clone();
        let port_tx = port_tx.clone();
        
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("STDOUT: {}", line);
                    // Check for port numbers in the output
                    for pattern in &port_patterns {
                        if let Some(cap) = pattern.captures(&line.to_lowercase()) {
                            if let Some(port_str) = cap.get(1) {
                                if let Ok(port) = port_str.as_str().parse::<u16>() {
                                    let _ = port_tx.send(port);
                                    break;
                                }
                            }
                        }
                    }

                    if let Ok(mut store) = output_store.lock() {
                        if let Some(output) = store.get_mut(&id_clone) {
                            output.push(line);
                            println!("Added stdout line to output store. Total lines: {}", output.len());
                        } else {
                            println!("No output vector found for command {}", id_clone);
                        }
                    }
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let id_clone = id.clone();
        let output_store = Arc::clone(&output_store.inner);
        let process_store = Arc::clone(&process_store.inner);
        let port_patterns = port_patterns;
        let port_tx = port_tx;
        
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("STDERR: {}", line);
                    
                    // Set error flag in process store
                    if let Ok(mut store) = process_store.lock() {
                        if let Some((_, info)) = store.get_mut(&id_clone) {
                            info.has_error = true;
                        }
                    }

                    // Check for port numbers in the output
                    for pattern in &port_patterns {
                        if let Some(cap) = pattern.captures(&line.to_lowercase()) {
                            if let Some(port_str) = cap.get(1) {
                                if let Ok(port) = port_str.as_str().parse::<u16>() {
                                    let _ = port_tx.send(port);
                                    break;
                                }
                            }
                        }
                    }

                    // Add error line to output store
                    if let Ok(mut store) = output_store.lock() {
                        if let Some(output) = store.get_mut(&id_clone) {
                            output.push(format!("ERROR: {}", line));
                            println!("Added stderr line to output store. Total lines: {}", output.len());
                        } else {
                            println!("No output vector found for command {}", id_clone);
                        }
                    }
                }
            }
        });
    }

    // Store the child process and initial command info
    let command_info = command_info.clone();
    store.insert(id.clone(), (child, command_info.clone()));

    // Wait for potential port in a separate thread
    let process_store_clone = process_store.inner.clone();
    let id_clone = id.clone();
    thread::spawn(move || {
        // Try to detect port for up to 30 seconds
        for _ in 0..30 {
            if let Ok(store) = process_store_clone.lock() {
                if let Some((child, info)) = store.get(&id_clone) {
                    // If we already found a port through log parsing, we can stop
                    if info.port.is_some() {
                        return;
                    }

                    // Try to get port from process
                    let pid = child.id();
                    if let Some(port) = detect_process_ports(pid) {
                        println!("Found port {} for process {} using OS detection", port, pid);
                        if let Ok(mut store) = process_store_clone.lock() {
                            if let Some((_, info)) = store.get_mut(&id_clone) {
                                info.port = Some(port);
                                return;
                            }
                        }
                    }
                }
            }
            
            // Sleep for a second before trying again
            thread::sleep(Duration::from_secs(1));
        }
    });

    // Wait for potential port in a separate thread (from log parsing)
    let process_store_clone = process_store.inner.clone();
    let id_clone = id.clone();
    thread::spawn(move || {
        if let Ok(port) = port_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            println!("Found port {} for command {} using log parsing", port, id_clone);
            if let Ok(mut store) = process_store_clone.lock() {
                if let Some((_, info)) = store.get_mut(&id_clone) {
                    info.port = Some(port);
                }
            }
        }
    });

    Ok(command_info)
}

#[tauri::command]
async fn stop_command(
    id: String,
    process_store: State<'_, ProcessStore>,
) -> Result<CommandInfo, String> {
    let mut store = process_store.inner.lock().map_err(|e| e.to_string())?;
    
    if let Some((mut child, mut info)) = store.remove(&id) {
        child.kill().map_err(|e| e.to_string())?;
        info.is_running = false;
        Ok(info)
    } else {
        Err("Command not found".to_string())
    }
}

#[tauri::command]
async fn get_command_info(
    id: String,
    process_store: State<'_, ProcessStore>,
) -> Result<CommandInfo, String> {
    let store = process_store.inner.lock().map_err(|e| e.to_string())?;
    if let Some((_, info)) = store.get(&id) {
        Ok(info.clone())
    } else {
        Err("Command not found".to_string())
    }
}

#[tauri::command]
async fn get_command_output(
    id: String,
    output_store: State<'_, OutputStore>,
) -> Result<Vec<String>, String> {
    let store = output_store.inner.lock().map_err(|e| e.to_string())?;
    if let Some(output) = store.get(&id) {
        println!("Retrieved {} lines of output for command {}", output.len(), id);
        Ok(output.clone())
    } else {
        println!("No output found for command {}", id);
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn remove_server<R: Runtime>(
    name: String,
    config_store: State<'_, ConfigStore>,
    app: tauri::AppHandle<R>,
) -> Result<Config, String> {
    let mut config = config_store.0.lock().map_err(|e| e.to_string())?;
    
    if config.mcp_servers.remove(&name).is_none() {
        return Err("Server not found".to_string());
    }

    // Save the updated config
    let app_dir = app.path().app_config_dir()
        .map_err(|_| "Failed to get app config directory".to_string())?;
    fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    
    let config_path = app_dir.join("mcp-config.json");
    let content = serde_json::to_string_pretty(&*config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    fs::write(config_path, content)
        .map_err(|e| format!("Failed to write config file: {}", e))?;

    Ok(config.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ProcessStore::new())
        .manage(ConfigStore(Mutex::new(Config::default())))
        .manage(OutputStore::new())
        .invoke_handler(tauri::generate_handler![
            start_command,
            stop_command,
            load_config,
            save_config,
            add_server,
            get_command_info,
            get_command_output,
            remove_server,
        ])
        .setup(|app| {
            // Create menu items
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            
            // Create the menu
            let menu = Menu::with_items(app, &[&show, &quit])?;

            // Create the tray icon
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
