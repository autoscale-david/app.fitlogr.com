import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (name: string) => fileURLToPath(new URL(`./test/stubs/${name}.ts`, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
  resolve: {
    alias: {
      "expo-media-library": stub("expo-media-library"),
      "expo-constants": stub("expo-constants"),
      "photo-classifier-native": stub("photo-classifier"),
    },
  },
});
