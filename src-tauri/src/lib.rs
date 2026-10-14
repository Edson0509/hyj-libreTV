use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// 保存内置 Next.js 服务子进程，退出时回收
struct ServerChild(Mutex<Option<CommandChild>>);

/// 用户可编辑的配置（首次运行自动生成到 应用配置目录/config.json）
#[derive(Serialize, Deserialize)]
struct AppConfig {
    /// 访问密码，改完重启应用生效
    password: String,
    /// 0 = 每次启动自动挑选空闲端口
    port: u16,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            password: "libretv-local".into(),
            port: 0,
        }
    }
}

/// 探测一个本机空闲端口
fn find_free_port() -> u16 {
    if let Ok(listener) = TcpListener::bind("127.0.0.1:0") {
        if let Ok(addr) = listener.local_addr() {
            return addr.port();
        }
    }
    38080
}

/// 读取（或生成）配置文件
fn load_config(app: &tauri::App) -> AppConfig {
    let mut cfg = AppConfig::default();
    let Ok(dir) = app.path().app_config_dir() else {
        return cfg;
    };
    let path = dir.join("config.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<AppConfig>(&text) {
            cfg = parsed;
        }
    } else {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap_or_default());
    }
    cfg
}

/// 打包进应用的内置服务目录（standalone server）
///
/// 打包布局（deb/AppImage 等）：`../server` 资源会映射为 `<resource_dir>/_up_/server`；
/// 开发布局：资源直接复制在可执行文件旁。逐个探测含 server.js 的路径。
fn server_dir(app: &tauri::App) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve("../server", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
    if let Ok(p) = app.path().resource_dir() {
        candidates.push(p.join("server"));
    }
    for p in &candidates {
        if p.join("server.js").exists() {
            return p.clone();
        }
    }
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("server"))
}

/// 简单 HTTP GET，探测服务是否就绪
fn server_ready(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(addr) = addr.parse() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(600)) else {
        return false;
    };
    let req = format!(
        "GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200")
}

/// SIGTERM/SIGINT 时回收内置服务（避免系统终止应用时残留孤儿进程）
fn install_signal_handler(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        eprintln!("[libretv] installing signal handler");
        let res = ctrlc::set_handler(move || {
            eprintln!("[libretv] signal received, killing bundled server");
            let killed = match handle.state::<ServerChild>().0.lock() {
                Ok(mut guard) => {
                    if let Some(child) = guard.take() {
                        child.kill().is_ok()
                    } else {
                        false
                    }
                }
                Err(_) => false,
            };
            eprintln!("[libretv] server killed: {killed}");
            std::process::exit(0);
        });
        eprintln!("[libretv] ctrlc set_handler result: {res:?}");
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerChild(Mutex::new(None)))
        .setup(|app| {
            let cfg = load_config(app);
            let port = if cfg.port == 0 {
                find_free_port()
            } else {
                cfg.port
            };
            let srv_dir = server_dir(app);
            let app_url = format!("http://127.0.0.1:{port}");

            // 1. 拉起内置 Node 服务（standalone server.js）
            let sidecar = app
                .shell()
                .sidecar("libretv-node")
                .map_err(|e| e.to_string())?;
            let (mut rx, child) = sidecar
                .args(["server.js"])
                .env("PORT", port.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .env("PASSWORD", &cfg.password)
                .current_dir(&srv_dir)
                .spawn()
                .map_err(|e| format!("内置服务启动失败: {e}"))?;

            *app.state::<ServerChild>().0.lock().unwrap() = Some(child);

            // 2. 服务输出转发到 stderr，便于排查
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                            eprintln!("[libretv] {}", String::from_utf8_lossy(&line));
                        }
                        tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                            eprintln!("[libretv] {}", String::from_utf8_lossy(&line));
                        }
                        _ => {}
                    }
                }
            });

            // 3. 等待服务就绪后打开主窗口（最多 60s）
            let handle = app.handle().clone();
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(60);
                while Instant::now() < deadline {
                    if server_ready(port) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(400));
                }
                let url = url::Url::parse(&app_url).expect("valid url");
                let _ = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                    .title("LibreTV")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(900.0, 600.0)
                    .build();
            });

            // 5. 信号处理：SIGTERM/SIGINT 时同样回收内置服务
            install_signal_handler(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 4. 应用退出时回收内置服务进程（Exit 与 ExitRequested 双保险）
            let kill_server = || {
                if let Some(child) = app_handle.state::<ServerChild>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            };
            match event {
                RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                    eprintln!("[libretv] app exiting, cleaning up bundled server");
                    kill_server();
                }
                _ => {}
            }
        });
}
