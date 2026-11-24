import type { ExpoConfig } from "expo/config";

const EAS_PROJECT_ID = "1964593c-a6a0-49e5-a35b-240cf2bf254e";

const config: ExpoConfig = {
  name: "fitlogr",
  slug: "fitlogr",
  owner: "davidcgweb",
  scheme: "fitlogr",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/logo.png",
  userInterfaceStyle: "dark",
  backgroundColor: "#000000",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.fitlogr.app",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "com.fitlogr.app",
    adaptiveIcon: {
      foregroundImage: "./assets/logo.png",
      backgroundColor: "#000000",
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-sqlite",
    "expo-status-bar",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#000000",
        image: "./assets/logo.png",
        resizeMode: "contain",
        imageWidth: 200,
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
