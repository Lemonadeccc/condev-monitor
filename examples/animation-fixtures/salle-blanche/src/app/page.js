"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import Preloader, { isInitialLoad } from "@/components/Preloader/Preloader";
import Copy from "@/components/Copy/Copy";
import DiningMenu from "@/components/DiningMenu/DiningMenu";
import Testimonials from "@/components/Testimonials/Testimonials";
import CTA from "@/components/CTA/CTA";
import ImageBanner from "@/components/ImageBanner/ImageBanner";

import "./home.css";

gsap.registerPlugin(ScrollTrigger);

const ABOUT_IMAGE_COUNT = 6;

export default function Home() {
  const aboutSectionRef = useRef(null);
  const isInitialPageLoad = useRef(isInitialLoad).current;
  const [preloaderDelay, setPreloaderDelay] = useState(
    isInitialPageLoad ? 9999 : 0,
  );

  const handlePreloaderEnter = () => {
    if (isInitialPageLoad) setPreloaderDelay(0.2);
  };

  useEffect(() => {
    const ctx = gsap.context(() => {
      const aboutImages = gsap.utils.toArray(".about-img");

      /* scale each about image in and out as it scrolls through the viewport */
      aboutImages.forEach((image) => {
        const imageScaleTimeline = gsap.timeline({
          scrollTrigger: {
            trigger: image,
            start: "top bottom",
            end: "bottom top",
            scrub: true,
          },
        });

        imageScaleTimeline
          .fromTo(image, { scale: 0.5 }, { scale: 1.25, ease: "none" })
          .to(image, { scale: 0.5, ease: "none" });
      });

      /* fade out the about header as the image gallery scrolls away */
      gsap.to(".about-header h3", {
        opacity: 0,
        ease: "power1.out",
        scrollTrigger: {
          trigger: ".about-imgs",
          start: "bottom bottom",
          end: "bottom 30%",
          scrub: true,
        },
      });
    }, aboutSectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <>
      <Preloader onEnter={handlePreloaderEnter} />

      <section className="hero">
        <div className="hero-img">
          <img src="/home/hero.jpg" alt="" />
        </div>

        <div className="container">
          <Copy
            type="words"
            animateOnScroll={false}
            delay={isInitialPageLoad ? preloaderDelay : 0.85}
          >
            <h1>
              Salle <br /> Blanche
            </h1>
          </Copy>

          <div className="section-footer">
            <Copy
              type="lines"
              animateOnScroll={false}
              delay={isInitialPageLoad ? preloaderDelay + 0.15 : 1.1}
            >
              <p className="sm">Since 1984</p>
            </Copy>
            <Copy
              type="lines"
              animateOnScroll={false}
              delay={isInitialPageLoad ? preloaderDelay + 0.25 : 1.2}
            >
              <p className="sm">Florence, IT</p>
            </Copy>
          </div>
        </div>
      </section>

      <section className="about" ref={aboutSectionRef}>
        <div className="about-header">
          <div className="container">
            <Copy type="lines">
              <h3>
                An environment built on balance and subtlety, where materials,
                light, and presence create something that feels effortless.
              </h3>
            </Copy>

            <div className="section-footer">
              <Copy type="lines" trigger=".about" start="top 50%" delay={0.5}>
                <p className="sm">Maison Dining</p>
              </Copy>
              <Copy type="lines" trigger=".about" start="top 50%" delay={0.6}>
                <p className="sm">Fine Setting</p>
              </Copy>
            </div>
          </div>
        </div>

        <div className="about-imgs">
          <div className="container">
            {Array.from({ length: ABOUT_IMAGE_COUNT }, (_, index) => (
              <div
                key={index + 1}
                className="about-img"
                id={`about-img-${index + 1}`}
              >
                <img src={`/home/about-${index + 1}.jpg`} alt="" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <DiningMenu />
      <Testimonials />
      <CTA />
      <ImageBanner />
    </>
  );
}
