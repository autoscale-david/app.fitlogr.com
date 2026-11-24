import type { ExpoConfig } from "expo/config";

const EAS_PROJECT_ID = "1964593c-a6a0-49e5-a35b-240cf2bf254e";

const config: ExpoConfig = {
  name: "fitlogr",
  slug: "fitlogr",
  owner: "davidcgweb",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "fitlogr",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "com.fitlogr.app",
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "com.fitlogr.app",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0F172A",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#0F172A",
        image: "./assets/splash-icon.png",
        imageWidth: 160,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  runtimeVersion: {
    policy: "appVersion",
  },
  updates: {
    url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
  },
  extra: {
    apiBaseUrl:
      process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fitlogr.com/api",
    eas: {
      projectId: EAS_PROJECT_ID,
    },
  },
};

export default config;
