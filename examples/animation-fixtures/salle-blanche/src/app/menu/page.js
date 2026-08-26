"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { diningMenu } from "@/components/DiningMenu/diningMenu-data";
import Copy from "@/components/Copy/Copy";
import Testimonials from "@/components/Testimonials/Testimonials";

import "./menu.css";

gsap.registerPlugin(ScrollTrigger);

const CATEGORY_TAGLINES = {
  Breakfast: "A gentle start, crafted with care",
  Foodsharing: "Plates meant to be passed and savoured together",
  Pizza: "Wood-fired, hand-stretched, classically inspired",
  Drinks: "From bean to glass, every sip considered",
  "Ice Cream": "Small indulgences to end on a sweet note",
};

function flattenCategoryItems(category) {
  if (category.items) return category.items;
  if (category.groups) {
    return category.groups.flatMap((group) =>
      group.items.map((item) => ({ ...item, group: group.title })),
    );
  }
  return [];
}

export default function Menu() {
  const menuListRef = useRef(null);

  /* stagger-reveal menu cards as each grid enters the viewport */
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.utils.toArray(".menu-grid").forEach((grid) => {
        const cards = grid.querySelectorAll(".menu-grid-card");

        gsap.set(cards, { opacity: 0, y: 30, scale: 0.75 });

        ScrollTrigger.create({
          trigger: grid,
          start: "top 70%",
          once: true,
          onEnter: () => {
            gsap.to(cards, {
              opacity: 1,
              y: 0,
              scale: 1,
              duration: 0.6,
              ease: "power2.out",
              stagger: 0.08,
            });
          },
        });
      });
    }, menuListRef);

    return () => ctx.revert();
  }, []);

  return (
    <>
      <section className="menu-hero">
        <div className="container">
          <Copy type="words" animateOnScroll={false} delay={0.85}>
            <h2>A Menu Guided by Taste and Time</h2>
          </Copy>
        </div>

        <div className="section-footer">
          <Copy type="lines" animateOnScroll={false} delay={1.1}>
            <p className="sm">The Carte</p>
          </Copy>
          <Copy type="lines" animateOnScroll={false} delay={1.2}>
            <p className="sm">Selected Courses</p>
          </Copy>
        </div>
      </section>

      <section className="menu-list" ref={menuListRef}>
        <div className="container">
          {diningMenu.map((category, categoryIndex) => {
            const items = flattenCategoryItems(category);
            const tagline = CATEGORY_TAGLINES[category.category];

            return (
              <div className="menu-category" key={categoryIndex}>
                <div className="menu-category-header">
                  <Copy type="words" animateOnScroll>
                    <h3>{category.category}</h3>
                  </Copy>
                  {tagline && (
                    <Copy type="lines" animateOnScroll>
                      <p className="md">{tagline}</p>
                    </Copy>
                  )}
                </div>

                <div className="menu-grid">
                  {items.map((item, itemIndex) => (
                    <div
                      className={`menu-grid-card ${itemIndex % 2 !== 0 ? "alt" : ""}`}
                      key={itemIndex}
                    >
                      <div className="menu-grid-card-top">
                        <h6>{item.name}</h6>
                        {item.weight && <p className="mono">{item.weight}</p>}
                      </div>

                      {(item.description || item.size) && (
                        <p>{item.description || item.size}</p>
                      )}

                      <p className="menu-grid-card-price">{item.price}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <Testimonials />
    </>
  );
}
