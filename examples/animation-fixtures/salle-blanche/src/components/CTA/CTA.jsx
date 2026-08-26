"use client";

import { useRef, useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import Copy from "@/components/Copy/Copy";

import "./CTA.css";

gsap.registerPlugin(ScrollTrigger);

const CTA = () => {
  const sectionRef = useRef(null);
  const circleButtonRef = useRef(null);
  const circlePathRef = useRef(null);

  /* svg circle stroke reveal + image entrance on scroll */
  useEffect(() => {
    const section = sectionRef.current;
    const circlePath = circlePathRef.current;
    if (!section || !circlePath) return;

    const pathLength = circlePath.getTotalLength();
    const image = section.querySelector(".cta-image");

    gsap.set(circlePath, {
      strokeDasharray: pathLength,
      strokeDashoffset: pathLength,
      rotation: -90,
      transformOrigin: "center center",
    });

    gsap.set(image, { autoAlpha: 0, scale: 0.75 });

    const scrollTrigger = ScrollTrigger.create({
      trigger: section,
      start: "top 75%",
      once: true,
      onEnter: () => {
        gsap.to(circlePath, {
          strokeDashoffset: 0,
          duration: 1.2,
          delay: 0.6,
          ease: "power2.inOut",
        });

        gsap.to(image, {
          autoAlpha: 1,
          scale: 1,
          duration: 1,
          ease: "power3.out",
        });
      },
    });

    return () => scrollTrigger.kill();
  }, []);

  /* svg circle stroke hover animation */
  useEffect(() => {
    const button = circleButtonRef.current;
    const circlePath = circlePathRef.current;
    if (!button || !circlePath) return;

    const pathLength = circlePath.getTotalLength();
    let hoverTimeline = null;

    const handleMouseEnter = () => {
      if (hoverTimeline) hoverTimeline.kill();

      hoverTimeline = gsap.timeline();
      hoverTimeline
        .set(circlePath, {
          strokeDashoffset: 0,
          strokeDasharray: pathLength,
          scale: 1,
        })
        .to(circlePath, {
          strokeDashoffset: -pathLength,
          duration: 0.75,
          ease: "power2.inOut",
        })
        .set(circlePath, {
          strokeDashoffset: pathLength,
        })
        .to(circlePath, {
          strokeDashoffset: 0,
          duration: 0.75,
          ease: "power2.inOut",
        });
    };

    button.addEventListener("mouseenter", handleMouseEnter);

    return () => {
      button.removeEventListener("mouseenter", handleMouseEnter);
      if (hoverTimeline) hoverTimeline.kill();
    };
  }, []);

  return (
    <section className="cta" ref={sectionRef}>
      <div className="container">
        <div className="cta-content">
          <Copy type="lines" animateOnScroll trigger=".cta" start="top 80%">
            <h6>A table awaits</h6>
          </Copy>

          <Copy type="lines" animateOnScroll trigger=".cta" start="top 80%">
            <h5>
              Settle into a space where the pace softens and each course arrives
              with quiet intention.
            </h5>
          </Copy>

          <div className="cta-details">
            <div className="cta-address">
              <Copy
                type="lines"
                animateOnScroll
                trigger=".cta"
                start="top 80%"
                delay={0.3}
              >
                <p className="mono">Piazza Santo Spirito 8</p>
                <p className="mono">Firenze, IT 50125</p>
              </Copy>
            </div>
            <div className="cta-hours">
              <Copy
                type="lines"
                animateOnScroll
                trigger=".cta"
                start="top 80%"
                delay={0.3}
              >
                <p className="mono">LUN–VEN 19:00–23:00</p>
                <p className="mono">SAB–DOM 18:30–23:30</p>
              </Copy>
            </div>
          </div>

          <div className="cta-circle-button" ref={circleButtonRef}>
            <a href="#" className="cta-button">
              <svg
                className="cta-button-svg"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 100 100"
              >
                <path
                  ref={circlePathRef}
                  d="M50,10 A40,40 0 1,1 49.9999,10"
                  stroke="currentColor"
                  strokeWidth="0.75"
                  fill="none"
                />
              </svg>
              <Copy
                type="lines"
                animateOnScroll
                trigger=".cta"
                start="top 80%"
                delay={0.5}
              >
                <span>Take a Table</span>
              </Copy>
            </a>
          </div>
        </div>

        <div className="cta-image">
          <img src="/cta/cta-img.jpg" alt="Restaurant interior" />
        </div>
      </div>
    </section>
  );
};

export default CTA;
