"use client";

import { useEffect, useState, useRef } from "react";
import { usePathname } from "next/navigation";
import { ReactLenis } from "lenis/react";
import { ViewTransitions } from "next-view-transitions";

import Nav from "@/components/Nav/Nav";
import Footer from "@/components/Footer/Footer";

const MOBILE_BREAKPOINT = 1000;
const VIEW_TRANSITION_SETTLE_MS = 1600;

const LENIS_EASING = (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t));

const LENIS_SHARED = {
  easing: LENIS_EASING,
  direction: "vertical",
  gestureDirection: "vertical",
  smooth: true,
  infinite: false,
  wheelMultiplier: 1,
  orientation: "vertical",
  smoothWheel: true,
  syncTouch: true,
};

const LENIS_MOBILE = {
  ...LENIS_SHARED,
  duration: 0.8,
  smoothTouch: true,
  touchMultiplier: 1.5,
  lerp: 0.09,
};

const LENIS_DESKTOP = {
  ...LENIS_SHARED,
  duration: 1.2,
  smoothTouch: false,
  touchMultiplier: 2,
  lerp: 0.1,
};

export default function ClientLayout({ children }) {
  const pageRef = useRef(null);
  const pageWrapperRef = useRef(null);
  const isFirstNavigation = useRef(true);
  const pathname = usePathname();

  const [isMobile, setIsMobile] = useState(false);

  /* track breakpoint changes */
  useEffect(() => {
    const handleResize = () =>
      setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  /* reset scroll and notify pages after view transitions */
  useEffect(() => {
    window.scrollTo(0, 0);

    if (isFirstNavigation.current) {
      isFirstNavigation.current = false;
      return;
    }

    // after a view transition completes, clear flag and dispatch event
    // so destination pages can (re)build ScrollTriggers with settled layout
    const transitionTimer = setTimeout(() => {
      window.__viewTransitioning = false;
      window.dispatchEvent(new Event("viewTransitionComplete"));
    }, VIEW_TRANSITION_SETTLE_MS);

    return () => clearTimeout(transitionTimer);
  }, [pathname]);

  const lenisOptions = isMobile ? LENIS_MOBILE : LENIS_DESKTOP;

  return (
    <ViewTransitions>
      <ReactLenis root options={lenisOptions}>
        <Nav pageRef={pageWrapperRef} />
        <div className="page" ref={pageRef}>
          <div className="page-wrapper" ref={pageWrapperRef}>
            {children}
            <Footer />
          </div>
        </div>
      </ReactLenis>
    </ViewTransitions>
  );
}
