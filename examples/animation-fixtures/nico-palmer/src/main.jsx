import { CondevAnimationProfiler } from "@condev-monitor/react/animation";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import { condevClient } from "./condev-monitor.js";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <CondevAnimationProfiler client={condevClient}>
      <Router>
        <Routes>
          <Route path="/*" element={<App />} />
        </Routes>
      </Router>
    </CondevAnimationProfiler>
  </StrictMode>
);
