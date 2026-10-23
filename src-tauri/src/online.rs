//! 在线壁纸适配：仅调用公开接口，不加载网页、不接受任意下载地址。
use std::io::Read;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::library::{Library, Wallpaper};

const PAGE_SIZE: usize = 24;
const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineWallpaper {
    pub id: String,
    pub source: String,
    pub title: String,
    pub thumbnail_url: String,
    pub page_url: String,
    pub width: u32,
    pub height: u32,
    pub author: String,
    pub license: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub items: Vec<OnlineWallpaper>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub wallpaper: Wallpaper,
    pub added: bool,
}

fn allowed_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some(
                "wallhaven.cc"
                    | "w.wallhaven.cc"
                    | "th.wallhaven.cc"
                    | "images-api.nasa.gov"
                    | "images-assets.nasa.gov"
                    | "commons.wikimedia.org"
                    | "upload.wikimedia.org"
                    | "thumb.wikimedia.org"
            )
        )
}

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent("DesktopWallDeck/0.1 (personal desktop wallpaper manager)")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 4 || !allowed_url(attempt.url()) {
                attempt.error("图片来源跳转到了未支持的地址")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("创建网络连接失败：{e}"))
}

fn read_limited(reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取在线资源失败：{e}"))?;
    if bytes.len() as u64 > limit {
        return Err("在线资源过大，请换一张图片".into());
    }
    Ok(bytes)
}

fn get_bytes(client: &Client, url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let url = Url::parse(url).map_err(|_| "图片来源地址无效")?;
    if !allowed_url(&url) {
        return Err("不支持此图片来源地址".into());
    }
    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("连接来源失败，请检查网络后重试：{e}"))?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            429 => "来源请求频率受限，请稍后重试".into(),
            403 => "来源暂时拒绝访问，可切换其他来源或稍后重试".into(),
            code => format!("来源服务返回 HTTP {code}，请稍后重试"),
        });
    }
    if response.content_length().is_some_and(|n| n > limit) {
        return Err("在线资源过大，请换一张图片".into());
    }
    read_limited(response, limit)
}

fn json(client: &Client, endpoint: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let mut url = Url::parse(endpoint).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
    let bytes = get_bytes(client, url.as_str(), 4 * 1024 * 1024)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "来源返回了无法识别的数据，请稍后重试")?;
    if value.get("error").is_some() {
        return Err("来源无法完成搜索，请换个关键词重试".into());
    }
    Ok(value)
}

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}
fn dimension(v: &Value, key: &str) -> u32 {
    v[key].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32
}
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn plain_credit(value: &str) -> String {
    let mut inside_tag = false;
    value
        .chars()
        .filter(|c| match c {
            '<' => {
                inside_tag = true;
                false
            }
            '>' => {
                inside_tag = false;
                false
            }
            _ => !inside_tag,
        })
        .collect::<String>()
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .trim()
        .chars()
        .take(240)
        .collect()
}

// NASA 官方接口仍会返回旧 HTTP 图片地址；只升级其确切的图片域名。
fn normalize_asset_url(value: &str) -> String {
    if let Ok(mut url) = Url::parse(value) {
        if url.scheme() == "http" && url.host_str() == Some("images-assets.nasa.gov") {
            let _ = url.set_scheme("https");
            return url.into();
        }
    }
    value.to_string()
}

fn wallhaven_item(v: &Value) -> Option<OnlineWallpaper> {
    let id = text(v, "id");
    let thumbnail_url = text(&v["thumbs"], "large");
    if id.is_empty() || thumbnail_url.is_empty() || v["purity"].as_str() != Some("sfw") {
        return None;
    }
    Some(OnlineWallpaper {
        title: format!("Wallhaven · {id}"),
        id,
        source: "wallhaven".into(),
        thumbnail_url,
        page_url: text(v, "url"),
        width: dimension(v, "dimension_x"),
        height: dimension(v, "dimension_y"),
        author: v["uploader"]["username"]
            .as_str()
            .map(|u| format!("上传者：{u}"))
            .unwrap_or_default(),
        license: "版权依单图来源，供个人壁纸选用".into(),
    })
}

fn nasa_item(v: &Value) -> Option<OnlineWallpaper> {
    let data = v["data"].get(0)?;
    let id = text(data, "nasa_id");
    let thumbnail_url = list(&v["links"])
        .iter()
        .find_map(|link| (link["rel"].as_str() == Some("preview")).then(|| text(link, "href")))?;
    if id.is_empty() || thumbnail_url.is_empty() {
        return None;
    }
    let mut url = Url::parse("https://images.nasa.gov/details/").ok()?;
    url.path_segments_mut().ok()?.pop_if_empty().push(&id);
    Some(OnlineWallpaper {
        title: text(data, "title"),
        source: "nasa".into(),
        id,
        thumbnail_url: normalize_asset_url(&thumbnail_url),
        page_url: url.into(),
        width: 0,
        height: 0,
        author: data["photographer"]
            .as_str()
            .or(data["secondary_creator"].as_str())
            .or(data["center"].as_str())
            .unwrap_or("NASA")
            .to_string(),
        license: "NASA 媒体使用规范，第三方素材以原页说明为准".into(),
    })
}

fn commons_item(v: &Value) -> Option<OnlineWallpaper> {
    let info = v["imageinfo"].get(0)?;
    if !matches!(
        info["mime"].as_str(),
        Some("image/jpeg" | "image/png" | "image/webp")
    ) {
        return None;
    }
    let title = text(v, "title");
    let thumbnail_url = text(info, "thumburl");
    if thumbnail_url.is_empty() {
        return None;
    }
    Some(OnlineWallpaper {
        id: title.clone(),
        source: "wikimedia".into(),
        title: title.trim_start_matches("File:").to_string(),
        thumbnail_url,
        page_url: text(info, "descriptionurl"),
        width: dimension(info, "width"),
        height: dimension(info, "height"),
        // Artist 常含链接 HTML，只保留署名文本；上传者不一定是作品作者。
        author: plain_credit(
            info["extmetadata"]["Artist"]["value"]
                .as_str()
                .unwrap_or("作者见原图页面"),
        ),
        license: info["extmetadata"]["LicenseShortName"]["value"]
            .as_str()
            .unwrap_or("许可与署名要求见原图页面")
            .to_string(),
    })
}

pub fn search(source: &str, query: &str, page: u32) -> Result<SearchResult, String> {
    if page == 0 || page > 1000 || query.chars().count() > 160 {
        return Err("搜索页码或关键词无效".into());
    }
    let client = client()?;
    let (items, has_more) = match source {
        "wallhaven" => {
            let v = json(
                &client,
                "https://wallhaven.cc/api/v1/search",
                &[
                    ("q", query.trim().into()),
                    ("page", page.to_string()),
                    ("purity", "100".into()),
                    ("categories", "111".into()),
                    ("atleast", "1920x1080".into()),
                    (
                        "sorting",
                        if query.trim().is_empty() {
                            "toplist"
                        } else {
                            "relevance"
                        }
                        .into(),
                    ),
                ],
            )?;
            (
                list(&v["data"]).iter().filter_map(wallhaven_item).collect(),
                page < dimension(&v["meta"], "last_page"),
            )
        }
        "nasa" => {
            let v = json(
                &client,
                "https://images-api.nasa.gov/search",
                &[
                    (
                        "q",
                        if query.trim().is_empty() {
                            "nebula"
                        } else {
                            query.trim()
                        }
                        .into(),
                    ),
                    ("media_type", "image".into()),
                    ("page", page.to_string()),
                    ("page_size", PAGE_SIZE.to_string()),
                ],
            )?;
            (
                list(&v["collection"]["items"])
                    .iter()
                    .filter_map(nasa_item)
                    .collect(),
                list(&v["collection"]["links"])
                    .iter()
                    .any(|l| l["rel"].as_str() == Some("next")),
            )
        }
        "wikimedia" => {
            let v = commons_query(
                &client,
                &[
                    ("generator", "search".into()),
                    ("gsrnamespace", "6".into()),
                    ("gsrlimit", PAGE_SIZE.to_string()),
                    ("gsroffset", ((page - 1) * PAGE_SIZE as u32).to_string()),
                    (
                        "gsrsearch",
                        format!(
                            "{} filetype:bitmap",
                            if query.trim().is_empty() {
                                "landscape"
                            } else {
                                query.trim()
                            }
                        ),
                    ),
                ],
            )?;
            let mut pages: Vec<_> = v["query"]["pages"]
                .as_object()
                .map(|o| o.values().collect())
                .unwrap_or_default();
            pages.sort_by_key(|v| dimension(v, "index"));
            (
                pages.into_iter().filter_map(commons_item).collect(),
                v["continue"]["gsroffset"].is_number(),
            )
        }
        _ => return Err("该来源暂未接入在线图库".into()),
    };
    Ok(SearchResult {
        items,
        page,
        has_more,
    })
}

fn commons_query(client: &Client, extra: &[(&str, String)]) -> Result<Value, String> {
    let mut params = vec![
        ("action", "query".into()),
        ("format", "json".into()),
        ("prop", "imageinfo".into()),
        ("iiprop", "url|size|mime|user|extmetadata".into()),
        ("iiurlwidth", "640".into()),
        ("iiextmetadatafilter", "LicenseShortName|Artist".into()),
    ];
    params.extend_from_slice(extra);
    json(client, "https://commons.wikimedia.org/w/api.php", &params)
}

fn resolve(client: &Client, source: &str, id: &str) -> Result<(OnlineWallpaper, String), String> {
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        return Err("图片标识无效".into());
    }
    match source {
        "wallhaven" => {
            if id.len() != 6 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Err("壁纸标识无效".into());
            }
            let v = json(client, &format!("https://wallhaven.cc/api/v1/w/{id}"), &[])?;
            let item = wallhaven_item(&v["data"]).ok_or("来源图片不可用")?;
            Ok((item, text(&v["data"], "path")))
        }
        "nasa" => {
            let v = json(
                client,
                "https://images-api.nasa.gov/search",
                &[("nasa_id", id.into()), ("media_type", "image".into())],
            )?;
            let item = list(&v["collection"]["items"])
                .iter()
                .filter_map(nasa_item)
                .find(|item| item.id == id)
                .ok_or("来源图片不存在")?;
            let mut endpoint =
                Url::parse("https://images-api.nasa.gov/asset/").map_err(|e| e.to_string())?;
            endpoint
                .path_segments_mut()
                .map_err(|_| "图片地址无效")?
                .pop_if_empty()
                .push(id);
            let assets = json(client, endpoint.as_str(), &[])?;
            let urls: Vec<_> = list(&assets["collection"]["items"])
                .iter()
                .filter_map(|i| i["href"].as_str())
                .filter(|url| {
                    url.to_ascii_lowercase().ends_with(".jpg")
                        || url.to_ascii_lowercase().ends_with(".png")
                })
                .collect();
            let image_url = urls
                .iter()
                .find(|u| u.contains("~orig."))
                .or_else(|| urls.iter().find(|u| u.contains("~large.")))
                .or_else(|| urls.first())
                .ok_or("来源未提供可下载图片")?
                .to_string();
            Ok((item, normalize_asset_url(&image_url)))
        }
        "wikimedia" => {
            if !id.starts_with("File:") {
                return Err("维基图片标识无效".into());
            }
            let v = commons_query(client, &[("titles", id.into())])?;
            let page = v["query"]["pages"]
                .as_object()
                .and_then(|o| o.values().next())
                .ok_or("来源图片不存在")?;
            let item = commons_item(page).ok_or("来源图片格式不受支持")?;
            Ok((item, text(&page["imageinfo"][0], "url")))
        }
        _ => Err("该来源暂不支持下载".into()),
    }
}

pub fn import(
    library: &Library,
    source: &str,
    id: &str,
    folder_id: Option<&str>,
) -> Result<ImportResult, String> {
    let client = client()?;
    let (item, image_url) = resolve(&client, source, id)?;
    // 使用原页地址去重并保留来源；下载地址每次由官方接口重新解析。
    if let Some(wallpaper) = library
        .db()
        .find_by_source(&item.page_url)
        .map_err(|e| e.to_string())?
    {
        library
            .db()
            .save_online_origin(
                &wallpaper.id,
                &serde_json::to_string(&item).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        return Ok(ImportResult {
            wallpaper: wallpaper.into(),
            added: false,
        });
    }
    let bytes = get_bytes(&client, &image_url, MAX_IMAGE_BYTES)?;
    let (wallpaper, added) = library
        .import_online(&item.page_url, &item.title, &bytes, folder_id)
        .map_err(|e| e.to_string())?;
    library
        .db()
        .save_online_origin(
            &wallpaper.id,
            &serde_json::to_string(&item).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    Ok(ImportResult { wallpaper, added })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 下载白名单拒绝本机和伪造域名() {
        for url in [
            "http://w.wallhaven.cc/x",
            "https://127.0.0.1/x",
            "https://w.wallhaven.cc.evil.test/x",
            "file:///C:/x",
            "https://user@w.wallhaven.cc/x",
            "https://w.wallhaven.cc:8443/x",
        ] {
            assert!(!allowed_url(&Url::parse(url).unwrap()), "{url}");
        }
        assert!(allowed_url(
            &Url::parse("https://w.wallhaven.cc/full/ab/a.jpg").unwrap()
        ));
    }

    #[test]
    fn 流式下载也遵守大小上限() {
        assert!(read_limited(&b"12345"[..], 4).is_err());
        assert_eq!(read_limited(&b"1234"[..], 4).unwrap(), b"1234");
    }

    #[test]
    fn 只升级官方旧版图片地址() {
        let url = normalize_asset_url("http://images-assets.nasa.gov/image/id/id~orig.jpg");
        assert_eq!(url, "https://images-assets.nasa.gov/image/id/id~orig.jpg");
        assert!(allowed_url(&Url::parse(&url).unwrap()));
        assert_eq!(
            normalize_asset_url("http://evil.test/a.jpg"),
            "http://evil.test/a.jpg"
        );
    }

    #[test]
    fn 维基署名只显示文本不混淆上传者() {
        let item = commons_item(&serde_json::json!({"title":"File:Landscape.jpg", "imageinfo":[{
            "mime":"image/jpeg", "thumburl":"https://upload.wikimedia.org/a.jpg", "user":"Uploader",
            "extmetadata":{"Artist":{"value":"<a href=\"https://example.test\">Photo &amp; Art</a>"}}
        }]})).unwrap();
        assert_eq!(item.author, "Photo & Art");
    }

    #[test]
    fn 仅解析安全级别壁纸和支持的图片() {
        let mut v = serde_json::json!({"id":"abc123", "purity":"sfw", "thumbs":{"large":"https://th.wallhaven.cc/a.jpg"}});
        assert!(wallhaven_item(&v).is_some());
        v["purity"] = "nsfw".into();
        assert!(wallhaven_item(&v).is_none());
        assert!(
            commons_item(&serde_json::json!({"imageinfo":[{"mime":"image/svg+xml"}]})).is_none()
        );
    }

    #[test]
    #[ignore = "访问公开网络并下载图片，仅手动运行"]
    fn 真实在线来源搜索与导入() {
        let root = std::env::temp_dir().join(format!("dwd-online-{}", uuid::Uuid::new_v4()));
        let library = Library::open(root.clone()).unwrap();
        for source in ["wallhaven", "nasa", "wikimedia"] {
            let results = search(source, "", 1).unwrap();
            let item = results.items.first().expect("在线来源应返回图片");
            println!("{source}: {} 条，首张 {}", results.items.len(), item.title);
            let imported = import(&library, source, &item.id, None).unwrap();
            assert!(std::path::Path::new(&imported.wallpaper.file_path).is_file());
            assert!(std::path::Path::new(&imported.wallpaper.thumb_path).is_file());
            assert!(!import(&library, source, &item.id, None).unwrap().added);
        }
        drop(library);
        std::fs::remove_dir_all(root).unwrap();
    }
}
