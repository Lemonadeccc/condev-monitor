"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import "./StickyCards.css";

gsap.registerPlugin(ScrollTrigger);

const MOBILE_BREAKPOINT = 1000;

const CARDS = [
  {
    title: "The Craft",
    description:
      "Guided by quiet precision, each plate is shaped with intention, allowing technique and creativity to meet in a calm balance.",
    image: "/about/sticky-card-1.jpg",
  },
  {
    title: "The Beginning",
    description:
      "What started as a simple pursuit of honesty in cooking became a space where detail, warmth, and restraint define every moment.",
    image: "/about/sticky-card-2.jpg",
  },
  {
    title: "The Experience",
    description:
      "An atmosphere composed of light, texture, and stillness invites every sense to settle in, creating a presence that lingers.",
    image: "/about/sticky-card-3.jpg",
  },
  {
    title: "The Flavors",
    description:
      "Seasonal ingredients are treated with clarity and respect, forming subtle layers that reveal themselves slowly with each bite.",
    image: "/about/sticky-card-4.jpg",
  },
  {
    title: "The Future",
    description:
      "With curiosity as its compass, the kitchen continues to evolve, exploring new ideas while honoring the foundations that shaped it.",
    image: "/about/sticky-card-5.jpg",
  },
  {
    title: "The Legacy",
    description:
      "Built one dish at a time, the restaurant's story reflects years of dedication, forming a quiet tradition that endures with grace.",
    image: "/about/sticky-card-6.jpg",
  },
];

const StickyCards = () => {
  const sectionRef = useRef(null);

  useEffect(() => {
    let ctx;
    const section = sectionRef.current;

    const buildScrollAnimation = () => {
      if (ctx) ctx.revert();

      const cardElements = section.querySelectorAll(".sticky-card");
      cardElements.forEach((card) => gsap.set(card, { clearProps: "all" }));

      if (window.innerWidth < MOBILE_BREAKPOINT) {
        section.classList.add("sticky-cards-mobile");
        return;
      }

      section.classList.remove("sticky-cards-mobile");

      requestAnimationFrame(() => {
        ctx = gsap.context(() => {
          const cards = gsap.utils.toArray(".sticky-card");
          const totalCards = cards.length;

          const lastLeftColumnIndex =
            totalCards % 2 === 0 ? totalCards - 2 : totalCards - 1;
          const lastRightColumnIndex =
            totalCards % 2 === 0 ? totalCards - 1 : totalCards - 2;

          cards.forEach((card, index) => {
            const isLastInColumn =
              index === lastLeftColumnIndex || index === lastRightColumnIndex;
            if (isLastInColumn) return;

            gsap
              .timeline({
                scrollTrigger: {
                  trigger: card,
                  start: "bottom top",
                  end: "+=100%",
                  scrub: true,
                },
              })
              .to(card, {
                yPercent: -100,
                ease: "none",
              });
          });

          ScrollTrigger.refresh();
        }, sectionRef);
      });
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
    <div className="sticky-cards" ref={sectionRef}>
      {CARDS.map((card, index) => (
        <div className="sticky-card" key={index}>
          <div className="sticky-card-img">
            <img src={card.image} alt={card.title} />
          </div>
          <h3>{card.title}</h3>
          <p>{card.description}</p>
        </div>
      ))}
    </div>
  );
};

export default StickyCards;
