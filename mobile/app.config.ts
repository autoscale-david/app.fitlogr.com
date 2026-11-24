import type { ExpoConfig } from "expo/config";

const EAS_PROJECT_ID = "1964593c-a6a0-49e5-a35b-240cf2bf254e";
const PHOTO_LIBRARY =
  "fitlogr looks through photos from the days you choose to find meals and estimate calories. A photo is compressed and sent only after you agree.";
const CAMERA = "fitlogr uses the camera so you can photograph a meal and estimate its calories.";
const HEALTH_SHARE =
  "fitlogr reads your weight, workouts, calories burned, steps, and heart rate from Apple Health to fill in your daily log.";
const HEALTH_UPDATE = "fitlogr reads Apple Health for your daily log and keeps those records in your fitlogr account.";

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
      NSPhotoLibraryUsageDescription: PHOTO_LIBRARY,
      NSCameraUsageDescription: CAMERA,
      NSPhotoLibraryAddUsageDescription: "fitlogr does not add photos to your library.",
      NSHealthShareUsageDescription: HEALTH_SHARE,
      NSHealthUpdateUsageDescription: HEALTH_UPDATE,
    },
    entitlements: {
      "com.apple.developer.healthkit": true,
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
    "expo-sharing",
    "expo-status-bar",
    [
      "expo-image-picker",
      {
        photosPermission: PHOTO_LIBRARY,
        cameraPermission: CAMERA,
        microphonePermission: false,
      },
    ],
    [
      "expo-media-library",
      {
        photosPermission: PHOTO_LIBRARY,
        savePhotosPermission: false,
        isAccessMediaLocationEnabled: false,
        granularPermissions: ["photo"],
      },
    ],
    [
      "@kingstinct/react-native-healthkit",
      {
        NSHealthShareUsageDescription: HEALTH_SHARE,
        NSHealthUpdateUsageDescription: HEALTH_UPDATE,
        background: false,
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
