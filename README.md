# 记饮食

前端 demo：饮食记录 + AI 解析（Supabase）

## 安全边界（前端）

- 允许公开：`SUPABASE_URL` 与 `SUPABASE_ANON_KEY`（浏览器公开键）。
- 严禁放入前端：`service_role`、任何私钥、测试账号真实邮箱/密码、内部运维 token。
- 解析失败时，UI 只展示通用错误文案，不透传后端内部细节。

## 本地调试开关

- 本地可选自动登录仅在以下条件同时满足时开启：
  - 域名是 `localhost` 或 `127.0.0.1`
  - URL 包含 `?devAuthBypass=1`
- 默认关闭远程时区探测（`worldtimeapi`），使用本机 `Intl` 时区。
