use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Point {
    x_pos: i32,
    y_pos: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("bad point {0:?}")]
    Bad(Point),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

fn check(p: Point) -> Result<String, AppError> {
    if p.x_pos < 0 { return Err(AppError::Bad(p)); }
    Ok(serde_json::to_string(&p)?)
}

fn main() {
    println!("{}", check(Point { x_pos: 1, y_pos: 2, label: None }).unwrap());
    let back: Point = serde_json::from_str(r#"{"xPos":3,"yPos":4,"label":"z"}"#).unwrap();
    println!("{back:?}");
    println!("{}", check(Point { x_pos: -1, y_pos: 0, label: None }).unwrap_err());
    let e: AppError = serde_json::from_str::<Point>("{").unwrap_err().into();
    println!("{e}");
}
