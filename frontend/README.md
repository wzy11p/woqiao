# 卧巧 Web 工作台

Next.js / React 前端。完整安装、模型配置和功能边界见[仓库说明](../README.md)。

```bash
npm ci
npm run dev -- --hostname 127.0.0.1
```

后端默认运行在 `http://127.0.0.1:8000`；前端通过 Next.js rewrites 转发 API 与媒体请求。需要更改地址时，在启动或构建前设置 `BACKEND_API_URL`。

```bash
npm run build
npm start -- --hostname 127.0.0.1
```

人物动作工作台入口为 `/pipelines/action-transfer`，供应商设置入口为 `/settings`。不要把带有私人素材与生成权限的本地服务直接暴露到公网。
