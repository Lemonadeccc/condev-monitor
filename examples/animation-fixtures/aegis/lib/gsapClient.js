"use client";

import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { SplitText } from "gsap/SplitText";

if (typeof window !== "undefined") {
  useGSAP.register(gsap);
  gsap.registerPlugin(ScrambleTextPlugin, SplitText);
}

export { gsap, ScrambleTextPlugin, SplitText, useGSAP };
