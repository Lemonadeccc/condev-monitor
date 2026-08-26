"use client";

import { useState, useRef, useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { HiOutlineArrowUp, HiOutlineArrowDown } from "react-icons/hi";

import { diningMenu } from "./diningMenu-data";
import Copy from "@/components/Copy/Copy";

import "./DiningMenu.css";

gsap.registerPlugin(ScrollTrigger);

const DiningMenu = () => {
  const sectionRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const isFirstCategory = activeIndex === 0;
  const isLastCategory = activeIndex === diningMenu.length - 1;
  const activeMenu = diningMenu[activeIndex];

  const handlePrev = () => {
    if (!isFirstCategory) setActiveIndex((prev) => prev - 1);
  };

  const handleNext = () => {
    if (!isLastCategory) setActiveIndex((prev) => prev + 1);
  };

  /* entrance animations on scroll */
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const navButtons = section.querySelectorAll(".dining-nav-button-wrapper");
    const previewCard = section.querySelector(".dining-preview-card");
    const minimapItems = section.querySelectorAll(".dining-minimap-item");

    gsap.set(navButtons, { scale: 0 });
    gsap.set(previewCard, { autoAlpha: 0, y: 50 });
    gsap.set(minimapItems, { autoAlpha: 0, y: 30 });

    const scrollTrigger = ScrollTrigger.create({
      trigger: section,
      start: "top 30%",
      once: true,
      onEnter: () => {
        gsap.to(navButtons, {
          scale: 1,
          duration: 1,
          ease: "power3.out",
          stagger: 0.1,
        });

        gsap.to(previewCard, {
          autoAlpha: 1,
          scale: 1,
          y: 0,
          duration: 1,
          ease: "power3.out",
        });

        gsap.to(minimapItems, {
          autoAlpha: 1,
          y: 0,
          duration: 1,
          ease: "power3.out",
          stagger: 0.1,
        });
      },
    });

    return () => scrollTrigger.kill();
  }, []);

  return (
    <section className="dining-menu" ref={sectionRef}>
      <div className="dining-menu-bg">
        <img src="/dining-menu/dining-menu.jpg" alt="" />
      </div>

      <div className="container">
        <div className="dining-menu-header">
          <Copy type="words" animateOnScroll>
            <h3>Our Menu</h3>
          </Copy>
        </div>

        <div className="dining-menu-content">
          <div className="dining-nav">
            <div className="dining-nav-button-wrapper">
              <button
                className={`dining-nav-button ${isFirstCategory ? "disabled" : ""}`}
                disabled={isFirstCategory}
                onClick={handlePrev}
              >
                <HiOutlineArrowUp />
              </button>
            </div>

            <div className="dining-nav-button-wrapper">
              <button
                className={`dining-nav-button ${isLastCategory ? "disabled" : ""}`}
                disabled={isLastCategory}
                onClick={handleNext}
              >
                <HiOutlineArrowDown />
              </button>
            </div>
          </div>

          <div className="dining-preview">
            <div className="dining-preview-card">
              <h6>{activeMenu.category}</h6>

              {activeMenu.items &&
                activeMenu.items.map((item, index) => (
                  <div key={index} className="dining-preview-item">
                    <div className="dining-preview-item-row">
                      <p>
                        {item.name} {item.weight}
                      </p>
                      <p>{item.price}</p>
                    </div>
                    {item.description && (
                      <p className="dining-preview-item-description">
                        {item.description}
                      </p>
                    )}
                  </div>
                ))}

              {activeMenu.groups &&
                activeMenu.groups.map((group, groupIndex) => (
                  <div key={groupIndex} className="dining-preview-group">
                    <div className="dining-preview-group-header">
                      <span></span>
                      <p className="mono">{group.title}</p>
                      <span></span>
                    </div>

                    {group.items.map((item, itemIndex) => (
                      <div key={itemIndex} className="dining-preview-item-row">
                        <p>
                          {item.name} {item.size || ""}
                        </p>
                        <p>{item.price}</p>
                      </div>
                    ))}
                  </div>
                ))}

              <div className="dining-preview-footer">
                <p>Salle Blanche</p>
              </div>
            </div>
          </div>

          <div className="dining-minimap">
            {diningMenu.map((menu, index) => (
              <div
                key={index}
                className={`dining-minimap-item ${index === activeIndex ? "active" : ""}`}
                onClick={() => setActiveIndex(index)}
              >
                <div className="dining-minimap-img">
                  <img
                    src={`/dining-menu/dining-menu-${menu.category
                      .toLowerCase()
                      .replaceAll(" ", "-")}.jpg`}
                    alt={menu.category}
                  />
                </div>
                <p>{menu.category}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default DiningMenu;
