//! 壁纸库错误类型。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum LibError {
    #[error("文件不存在：{0}")]
    NotFound(String),

    #[error("不支持的图片格式：{0}")]
    Unsupported(String),

    #[error("图片解码失败：{0}")]
    Decode(String),

    #[error("图片编码失败：{0}")]
    Encode(String),

    #[error("文件读写失败：{0}")]
    Io(String),

    #[error("数据库操作失败：{0}")]
    Db(String),
}

pub type LibResult<T> = Result<T, LibError>;

impl From<std::io::Error> for LibError {
    fn from(e: std::io::Error) -> Self { LibError::Io(e.to_string()) }
}

impl From<rusqlite::Error> for LibError {
    fn from(e: rusqlite::Error) -> Self {
        LibError::Db(e.to_string())
    }
}
