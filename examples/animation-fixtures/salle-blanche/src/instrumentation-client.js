import { init } from "@condev-monitor/monitor-sdk-browser/animation";

const development = process.env.NODE_ENV !== "production";
const dsn = process.env.NEXT_PUBLIC_CONDEV_DSN?.trim();

init({
  dsn,
  animation: {
    autoStart: development || Boolean(dsn),
    devtools: development,
    rum: dsn ? { sampleRate: 1 } : false,
    context: {
      routeKey: "salle-blanche",
      environment: development ? "development" : "production",
      runtimeFamily: "react",
    },
  },
});
