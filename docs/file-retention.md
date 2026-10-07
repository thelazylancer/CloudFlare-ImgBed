# 文件有效期

所有渠道的新上传默认保存 24 小时，可指定 1–604800 秒（最多 7 天）。有效期从上传完成时开始，到期前可重复读取；没有一次性模式。默认上传渠道仍为 Telegram。旧文件没有 `ExpiresAt`，继续按永久文件处理，不批量迁移或删除。

## 上传接口

站内 `/api-docs.html` 提供上传、鉴权、访问、列表、删除和清理接口说明，源码在 [API 文档](api.html)。上传页面桌面端和移动端的“API 文档”菜单均打开站内说明。

仍使用 `POST /upload`，原有鉴权方式不变。以下示例中的 Token 至少需要 `upload` 权限：

```sh
# 默认 24 小时
curl -H "Authorization: Bearer $IMGBED_UPLOAD_TOKEN" -F file=@image.jpg https://img.example.com/upload

# 最长 7 天；expiresIn 的单位为秒
curl -H "Authorization: Bearer $IMGBED_UPLOAD_TOKEN" -F file=@image.jpg 'https://img.example.com/upload?expiresIn=604800'

# 显式永久：Token 必须同时有 upload 和 manage 权限
curl -H "Authorization: Bearer $IMGBED_ADMIN_TOKEN" -F file=@image.jpg 'https://img.example.com/upload?permanent=true'
```

`permanent=true` 不能与 `expiresIn` 同时使用。非法值返回 400；普通上传身份申请永久返回 403。参数重复也返回 400。管理员未指定参数时仍为 24 小时，不会自动永久保存。

普通上传和分块合并返回：

```json
[{ "src": "/file/example.jpg", "expiresAt": 1791421200000 }]
```

`expiresAt` 是 Unix 毫秒时间戳，永久文件为 `null`。数据库中对应字段为 `metadata.ExpiresAt`。API Token 自己的 `expiresAt` 仍为 ISO 日期，控制凭据有效期，和文件有效期独立。

分块上传在 `initChunked=true` 时固定有效期；合并时不能更改，永久合并会再次验证权限。HuggingFace 直传在 `POST /upload/huggingface/commitUpload` 上使用同样的查询参数，响应对象也包含 `expiresAt`。

## 管理员使用

在管理设置中配置管理员用户名和密码，经 `/adminLogin` 登录，然后回到上传页面，在“上传设置 → 保存时间”选择“永久保存”。没有配置管理员凭据、普通用户会话、过期会话均不能申请永久。API 使用同时带 `upload`、`manage` 权限的 Token；没有新增每个 Token 的有效期设置。

## 到期访问与清理

`/file/` 每次读取都会检查有效期；临时文件使用 `no-store`，到期后 GET、HEAD、Range 和图片处理请求均返回 404。管理列表、公开图库及随机图过滤已到期记录。存储渠道自己的公开直链，以及已下载或被第三方保存的副本，独立于图床链接。

- Worker：每分钟 Cron 自动清理。
- Docker：服务每分钟自动清理，避免同一进程重叠执行。
- Pages：没有 Cron，需外部定时任务以 `manage` Token 或管理员会话调用 `POST /api/manage/cleanupExpired`。到期访问也会触发该文件清理。

每次清理最多扫描 5 条记录并保存游标，完整扫描后从头开始；响应包含 `scanned`、`deleted`、`failed`、`hasMore`。到期访问立即拒绝，物理清理可能滞后。大规模存储需改成按到期时间索引；外部任务也可在 `hasMore=true` 时继续调用。远端删除或索引写入失败时保留数据库记录，后续重试；不使用数据库 TTL 丢弃删除所需的信息。

```sh
curl -X POST -H "Authorization: Bearer $IMGBED_ADMIN_TOKEN" https://img.example.com/api/manage/cleanupExpired
```

Telegram Bot API 只能删除发送后不足 48 小时的消息。24 小时文件可自动删除消息；保存 2–7 天需要在 Telegram 聊天中配置原生自动删除才能清理聊天中的媒体。超过 48 小时的记录到期仍会失效并清理本地引用，远端媒体依赖聊天自动删除。临时文件与永久文件建议使用不同聊天，避免自动删除永久媒体。

Worker 的 IMAGES 和 Docker 的原生图片处理支持临时文件。Pages 若仅依赖 `/cdn-cgi/image`，临时文件的图片处理会返回 400，使用 `fallback=original` 可返回原图，避免生成绕过有效期的缓存地址。

通过 Buffer 排期时，有效期要覆盖实际发布时间；24 小时以后发布的任务应显式延长，最多 7 天，或由管理员选择永久。

## 本地验证与前端来源

执行 `npm run test:retention` 检查权限、上传、访问和清理逻辑，使用本地 KV/D1 与模拟存储请求，不接触真实文件。

本仓库只包含 `frontend-dist`。前端改动保存在 `deploy/frontend/retention.patch`，基于 `MarSeventh/Sanyue-ImgHub` 的 `c969a6629dba610edfa6f4a9a28765b0e3d0dca1`。执行 `bash deploy/frontend/build.sh` 可从固定版本重新构建；升级上游前端时先合并该补丁，再生成静态资源。
