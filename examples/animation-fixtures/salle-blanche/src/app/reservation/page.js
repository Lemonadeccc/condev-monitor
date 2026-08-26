"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { HiBolt, HiSparkles, HiMoon } from "react-icons/hi2";

import Copy from "@/components/Copy/Copy";
import Button from "@/components/Button/Button";
import CTA from "@/components/CTA/CTA";

import "./reservation.css";

gsap.registerPlugin(ScrollTrigger, useGSAP);

const MOBILE_BREAKPOINT = 1000;

const INFO_CARDS = [
  {
    icon: HiBolt,
    title: "Menu",
    description:
      "Discover a focused selection of crafted plates, refined pours, and seasonal flavors shaped with quiet intention.",
    items: [
      "Small Plates",
      "Cellar Wines",
      "Signature Spirits",
      "Chef's Picks",
    ],
  },
  {
    icon: HiSparkles,
    title: "Hours",
    description:
      "Our space is prepared for evenings shaped around ease, warmth, and unhurried conversation.",
    items: [
      "Mon – Tue: 5pm – 12am",
      "Wed – Thu: 5pm – 12am",
      "Fri – Sat: 4pm – 1am",
      "Sunday: 4pm – 11pm",
    ],
  },
  {
    icon: HiMoon,
    title: "Contact",
    description:
      "Contact our team for questions or arrangements. We respond with care, clarity, and attention to every visit.",
    items: [
      "+39 055 398 2417",
      "hello@salleblanche.com",
      "press@salleblanche.com",
      "Guest Services",
    ],
  },
];

export default function Reservation() {
  const heroSectionRef = useRef(null);
  const infoSectionRef = useRef(null);
  const heroButtonRef = useRef(null);
  const [isDesktop, setIsDesktop] = useState(true);
  const [rebuildKey, setRebuildKey] = useState(0);

  /* track breakpoint changes */
  useEffect(() => {
    const handleResize = () =>
      setIsDesktop(window.innerWidth >= MOBILE_BREAKPOINT);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  /* rebuild after view transition settles */
  useEffect(() => {
    const handleTransitionComplete = () => setRebuildKey((prev) => prev + 1);
    window.addEventListener("viewTransitionComplete", handleTransitionComplete);
    return () =>
      window.removeEventListener(
        "viewTransitionComplete",
        handleTransitionComplete,
      );
  }, []);

  /* hero button entrance animation */
  useEffect(() => {
    const buttonWrapper = heroButtonRef.current;
    if (!buttonWrapper) return;

    gsap.fromTo(
      buttonWrapper,
      { autoAlpha: 0, y: 40 },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.9,
        delay: 1.55,
        ease: "power3.out",
      },
    );
  }, []);

  useGSAP(
    () => {
      const infoSection = infoSectionRef.current;
      if (!infoSection) return;

      infoSection.classList.remove("reservation-info-mobile");

      if (window.__viewTransitioning) return;

      if (!isDesktop) {
        infoSection.classList.add("reservation-info-mobile");
        return;
      }

      const panels = gsap.utils.toArray(
        infoSection.querySelectorAll(".info-panel"),
      );
      const cards = gsap.utils.toArray(
        infoSection.querySelectorAll(".info-card"),
      );

      /* panels slide up with icon scale-in */
      ScrollTrigger.create({
        trigger: infoSection,
        start: "top bottom",
        end: "top top",
        scrub: 1,
        onUpdate: (self) => {
          const progress = self.progress;

          panels.forEach((panel, index) => {
            const staggerDelay = 0.15;
            const duration = 0.7;
            const start = index * staggerDelay;
            const end = start + duration;

            if (progress >= start && progress <= end) {
              const normalised = (progress - start) / duration;
              gsap.set(panel, { y: `${125 - normalised * 125}%` });

              const icon = panel.querySelector(".info-panel-icon");
              const iconThreshold = 0.4;
              const iconProgress = Math.max(
                0,
                (normalised - iconThreshold) / (1 - iconThreshold),
              );
              gsap.set(icon, { scale: iconProgress });
            } else if (progress > end) {
              gsap.set(panel, { y: "0%" });
              gsap.set(panel.querySelector(".info-panel-icon"), { scale: 1 });
            }
          });
        },
      });

      /* cards fan in from right, then scale up */
      ScrollTrigger.create({
        trigger: infoSection,
        start: "top top",
        end: `+=${window.innerHeight * 3}`,
        pin: true,
        scrub: 1,
        onUpdate: (self) => {
          const progress = self.progress;

          cards.forEach((card, index) => {
            const slideStagger = 0.075;
            const slideDuration = 0.4;
            const slideStart = index * slideStagger;
            const slideEnd = slideStart + slideDuration;

            if (progress >= slideStart && progress <= slideEnd) {
              const normalised = (progress - slideStart) / slideDuration;
              const initialX = 350 - index * 100;
              const targetX = -50;
              const currentX = initialX + normalised * (targetX - initialX);
              const currentRotation = 20 - normalised * 20;
              gsap.set(card, { x: `${currentX}%`, rotation: currentRotation });
            } else if (progress > slideEnd) {
              gsap.set(card, { x: "-50%", rotation: 0 });
            }

            const scaleStagger = 0.12;
            const scaleStart = 0.4 + index * scaleStagger;
            const scaleEnd = 1;

            if (progress >= scaleStart && progress <= scaleEnd) {
              const normalised =
                (progress - scaleStart) / (scaleEnd - scaleStart);
              gsap.set(card, { scale: 0.75 + normalised * 0.25 });
            } else if (progress > scaleEnd) {
              gsap.set(card, { scale: 1 });
            }
          });
        },
      });
    },
    {
      scope: infoSectionRef,
      dependencies: [isDesktop, rebuildKey],
      revertOnUpdate: true,
    },
  );

  return (
    <>
      <section className="reservation-hero" ref={heroSectionRef}>
        <div className="container">
          <Copy type="words" animateOnScroll={false} delay={0.85}>
            <h2>Set the Evening in Motion</h2>
          </Copy>

          <Copy type="lines" animateOnScroll={false} delay={1.35}>
            <p className="lg">
              Reserve your place for an evening of attentive service, thoughtful
              plates, and an atmosphere made to linger in.
            </p>
          </Copy>

          <div className="reservation-hero-button" ref={heroButtonRef}>
            <Button href="/reservation">Reserve Your Evening</Button>
          </div>

          <Copy type="lines" animateOnScroll={false} delay={1.65}>
            <p className="mono">( +39 055 398 2417 )</p>
          </Copy>
        </div>
      </section>

      <section className="reservation-info" ref={infoSectionRef}>
        <div className="container">
          {INFO_CARDS.map(({ icon: Icon, title, description, items }) => (
            <div className="info-panel" key={title}>
              <div className="info-panel-icon">
                <Icon />
              </div>
              <div className="info-card">
                <Icon className="info-card-icon" />
                <h5>{title}</h5>
                <p>{description}</p>
                <div className="info-card-items">
                  {items.map((item) => (
                    <p className="mono" key={item}>
                      {item}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <CTA />
    </>
  );
}
