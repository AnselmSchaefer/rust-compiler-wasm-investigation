pub fn info() -> String {
    format!("{} (include dir: {}, linka cwd: {})", env!("LINKB_GREETING"), env!("LINKB_INCLUDE_DIR"), linka::cwd())
}
