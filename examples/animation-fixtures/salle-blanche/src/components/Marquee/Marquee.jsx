"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

import "./Marquee.css";

const MARQUEE_TEXT = "Enduring Taste";
const MARQUEE_REPEAT_COUNT = 12;

const Marquee = () => {
  const trackRef = useRef(null);

  useEffect(() => {
    const track = trackRef.current;
    const items = track.querySelectorAll(".marquee-item");
    if (!items.length) return;

    const itemWidth = items[0].offsetWidth;
    const halfLoopWidth = itemWidth * (MARQUEE_REPEAT_COUNT / 2);

    const scrollTween = gsap.to(track, {
      x: -halfLoopWidth,
      duration: 30,
      ease: "none",
      repeat: -1,
      modifiers: {
        x: gsap.utils.unitize((x) => parseFloat(x) % halfLoopWidth),
      },
    });

    const pill = track.parentElement;

    const handleMouseEnter = () =>
      gsap.to(scrollTween, { timeScale: 0, duration: 0.5 });
    const handleMouseLeave = () =>
      gsap.to(scrollTween, { timeScale: 1, duration: 0.5 });

    pill.addEventListener("mouseenter", handleMouseEnter);
    pill.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      pill.removeEventListener("mouseenter", handleMouseEnter);
      pill.removeEventListener("mouseleave", handleMouseLeave);
      scrollTween.kill();
    };
  }, []);

  return (
    <section className="marquee">
      <div className="container">
        <div className="marquee-content">
          <h1>Since 1984</h1>
          <h3>Art of Stillness</h3>
        </div>

        <div className="marquee-pill">
          <div className="marquee-track" ref={trackRef}>
            {Array.from({ length: MARQUEE_REPEAT_COUNT }, (_, index) => (
              <span className="marquee-item" key={index}>
                {MARQUEE_TEXT}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default Marquee;
