import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 设置层依赖 localStorage / document(jsdom 提供)
    environment: "jsdom",
  },
});
