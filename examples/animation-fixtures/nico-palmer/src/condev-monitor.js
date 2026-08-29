import { init } from "@condev-monitor/react/animation";

const dsn = import.meta.env.VITE_MONITOR_DSN?.trim();

export const condevClient = init({
  dsn,
  animation: {
    autoStart: import.meta.env.DEV || Boolean(dsn),
    devtools: import.meta.env.DEV,
    rum: dsn ? { contractVersion: 2, sampleRate: 1 } : false,
    context: {
      routeKey: "nico-palmer.home",
      environment: import.meta.env.MODE,
      runtimeFamily: "react",
    },
  },
});
