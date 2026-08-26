import { init } from "@condev-monitor/monitor-sdk-browser/animation";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";

const dsn = import.meta.env.VITE_MONITOR_DSN?.trim();

init({
  dsn,
  animation: {
    autoStart: import.meta.env.DEV || Boolean(dsn),
    devtools: import.meta.env.DEV,
    rum: dsn ? { sampleRate: 1 } : false,
    context: {
      routeKey: "nico-palmer",
      environment: import.meta.env.MODE,
      runtimeFamily: "react",
    },
  },
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Router>
      <Routes>
        <Route path="/*" element={<App />} />
      </Routes>
    </Router>
  </StrictMode>
);
