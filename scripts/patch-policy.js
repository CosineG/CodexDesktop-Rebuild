// Keep functional patches required. Only presentation changes may fall back to
// the upstream files; add optional entries only when that fallback is usable.
const PATCH_POLICY = [
  { script: "patch-i18n.js", feature: "界面语言开关" },
  {
    script: "patch-reasoning-effort-labels.js",
    feature: "推理强度中文名称",
    optional: true,
    rollback: "translations",
  },
  {
    script: "patch-copyright.js",
    feature: "版权署名",
    optional: true,
    rollback: "main-bundles",
  },
  { script: "patch-devtools.js", feature: "开发者工具" },
  { script: "patch-fast-mode.js", feature: "API-key Fast 模式" },
  { script: "patch-realtime-voice-auth.js", feature: "API-key 实时语音" },
  { script: "patch-codex-home-env.js", feature: "用户配置目录传递" },
  { script: "patch-image-generation-auth.js", feature: "API-key 图片生成" },
  { script: "patch-windows-portable-runtime.js", feature: "Windows 便携运行时" },
  { script: "patch-model-catalog-filter.js", feature: "模型目录过滤" },
  { script: "patch-model-picker-submenu.js", feature: "模型选择器子菜单" },
  { script: "patch-thread-file-manager-action.js", feature: "会话文件管理器入口" },
  { script: "patch-browser-auth.js", feature: "API-key 浏览器认证" },
  { script: "patch-plugin-auth.js", feature: "插件认证与功能开关" },
  { script: "patch-remote-control.js", feature: "远程控制" },
  { script: "patch-composer-workspace-root.js", feature: "会话工作目录传递" },
  { script: "patch-updater.js", feature: "禁用上游自动更新" },
  { script: "patch-archive-delete.js", feature: "归档会话删除" },
  { script: "patch-crash-forensics.js", feature: "主进程崩溃诊断" },
  { script: "patch-worker-forensics.js", feature: "Worker 崩溃诊断" },
  { script: "patch-worker-limits.js", feature: "Worker 内存限制" },
  { script: "patch-diff-limits.js", feature: "Diff 输出限制" },
  { script: "patch-git-output-cap.js", feature: "Git 输出限制" },
  { script: "patch-sentry-scope.js", feature: "Sentry 内存保护" },
  { script: "patch-cdp-screenshot.js", feature: "浏览器截图管线" },
];

module.exports = { PATCH_POLICY };
