pub fn describe() -> String {
    let v = serde_json::json!({ "n": util::twice(2), "h": helper::NAME });
    v.to_string()
}
