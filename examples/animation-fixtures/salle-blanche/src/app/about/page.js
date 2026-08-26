"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import Copy from "@/components/Copy/Copy";
import ImageBanner from "@/components/ImageBanner/ImageBanner";
import Marquee from "@/components/Marquee/Marquee";
import StickyCards from "@/components/StickyCards/StickyCards";
import Chefs from "@/components/Chefs/Chefs";
import CTA from "@/components/CTA/CTA";

import "./about.css";

gsap.registerPlugin(ScrollTrigger);

const MOBILE_BREAKPOINT = 1000;

export default function About() {
  const heroSectionRef = useRef(null);

  /* fade in the hero image on mount */
  useEffect(() => {
    const heroImage = heroSectionRef.current?.querySelector(".hero-image");
    if (!heroImage) return;

    gsap.fromTo(
      heroImage,
      { autoAlpha: 0, scale: 0.75, y: 50 },
      {
        autoAlpha: 1,
        scale: 1,
        y: 0,
        duration: 1,
        delay: 1.25,
        ease: "power3.out",
      },
    );
  }, []);

  /* scroll-driven parallax for hero header and image */
  useEffect(() => {
    let ctx;

    const buildScrollAnimation = () => {
      if (ctx) ctx.revert();

      const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      const headerOffsetY = isMobile ? "200vh" : "175vh";
      const headerOffsetX = isMobile ? -100 : -150;

      ctx = gsap.context(() => {
        const heroParallaxTimeline = gsap.timeline({
          scrollTrigger: {
            trigger: ".about-hero",
            start: "top top",
            end: "bottom +=1200%",
            scrub: true,
          },
        });

        heroParallaxTimeline
          .to(
            [".hero-heading .heading-line-1", ".hero-heading .heading-line-3"],
            {
              scale: 2,
              y: headerOffsetY,
              xPercent: headerOffsetX,
            },
            "scroll",
          )
          .to(
            ".hero-heading .heading-line-2",
            {
              scale: 2,
              y: headerOffsetY,
              xPercent: -headerOffsetX,
            },
            "scroll",
          )
          .to(
            ".hero-image",
            {
              scaleY: 2.5,
              yPercent: 300,
            },
            "scroll",
          )
          .to(
            ".hero-image img",
            {
              scaleX: 2.5,
            },
            "scroll",
          );
      }, heroSectionRef);
    };

    let wasMobile = window.innerWidth < MOBILE_BREAKPOINT;
    buildScrollAnimation();

    const handleResize = () => {
      const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      if (isMobile !== wasMobile) {
        wasMobile = isMobile;
        buildScrollAnimation();
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (ctx) ctx.revert();
    };
  }, []);

  return (
    <>
      <section className="about-hero" ref={heroSectionRef}>
        <div className="about-hero-pin">
          <div className="hero-heading">
            <Copy animateOnScroll={false} delay={0.85}>
              <h1 className="heading-line-1">Salle</h1>
              <h1 className="heading-line-2">Blanche</h1>
              <h1 className="heading-line-3">Story</h1>
            </Copy>
          </div>

          <div className="hero-image">
            <img src="/about/about-hero.jpg" alt="About Salle Blanche" />
          </div>
        </div>
      </section>

      <section className="about-info">
        <div className="container">
          <Copy>
            <p className="mono">Defined by Balance and Restraint</p>
            <h3>
              Salle Blanche is an exercise in quiet composition, where space,
              light, and material come together with deliberate restraint.
            </h3>
            <h3>
              In the same spirit, the menu follows a measured approach, guided
              by balance, clarity, and precision. Each element is considered,
              each plate composed to feel complete yet effortless.
            </h3>
          </Copy>
        </div>
      </section>

      <ImageBanner image="/about/about-image-banner.jpg" />
      <Marquee />
      <StickyCards />
      <Chefs />
      <CTA />
    </>
  );
}
