// The app's entry point. expo-router loads route files (including app/_layout.tsx) lazily, during the
// first render. iOS can start the app in the background with nothing on screen, for an Apple Health
// update or a background task, and those wake-ups need their handlers registered as soon as the
// JavaScript loads, not when a screen first draws. So they are imported here.
import "expo-router/entry";
import "./services/crashLog";
import "./services/engine/background";
