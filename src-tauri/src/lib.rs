use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.center()?;
                window.show()?;
                window.set_focus()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Scout SEO");
}
