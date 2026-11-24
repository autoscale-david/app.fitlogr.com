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
      NSPhotoLibraryUsageDescription:
        "fitlogr looks at recent photos to find meals and estimate calories. A photo is compressed and sent only after you agree.",
      NSCameraUsageDescription: "fitlogr uses the camera so you can photograph a meal and estimate its calories.",
      NSPhotoLibraryAddUsageDescription: "fitlogr does not add photos to your library.",
    },
  },
  android: {
    package: "com.fitlogr.app",
    permissions: ["android.permission.CAMERA", "android.permission.READ_MEDIA_IMAGES"],
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
    "expo-web-browser",
    "expo-status-bar",
    [
      "expo-image-picker",
      {
        photosPermission:
          "fitlogr looks at recent photos to find meals and estimate calories. A photo is compressed and sent only after you agree.",
        cameraPermission: "fitlogr uses the camera so you can photograph a meal and estimate its calories.",
        microphonePermission: false,
      },
    ],
    [
      "expo-media-library",
      {
        photosPermission:
          "fitlogr looks at recent photos to find meals and estimate calories. A photo is compressed and sent only after you agree.",
        savePhotosPermission: false,
        isAccessMediaLocationEnabled: false,
        granularPermissions: ["photo"],
      },
    ],
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
