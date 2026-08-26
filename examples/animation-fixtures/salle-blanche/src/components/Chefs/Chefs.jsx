"use client";

import { useRef, useEffect } from "react";
import gsap from "gsap";

import "./Chefs.css";

const MOBILE_BREAKPOINT = 1000;

const CHEFS = [
  { name: "Laurent", image: "/chefs/avatar1.jpg" },
  { name: "Camille", image: "/chefs/avatar2.jpg" },
  { name: "Nicolas", image: "/chefs/avatar3.jpg" },
  { name: "Isabelle", image: "/chefs/avatar4.jpg" },
  { name: "Matthieu", image: "/chefs/avatar5.jpg" },
  { name: "Colette", image: "/chefs/avatar6.jpg" },
  { name: "Olivier", image: "/chefs/avatar7.jpg" },
  { name: "Juliette", image: "/chefs/avatar8.jpg" },
];

const SplitChars = ({ text, headingRef }) => (
  <h1 ref={headingRef}>
    {text.split("").map((char, index) => (
      <span className="letter" key={index}>
        {char === " " ? "\u00A0" : char}
      </span>
    ))}
  </h1>
);

const Chefs = () => {
  const sectionRef = useRef(null);
  const avatarContainerRef = useRef(null);
  const avatarRefs = useRef([]);
  const chefNameRefs = useRef([]);
  const defaultHeadingRef = useRef(null);

  useEffect(() => {
    const avatarContainer = avatarContainerRef.current;
    const avatars = avatarRefs.current.filter(Boolean);
    const chefNames = chefNameRefs.current.filter(Boolean);
    const defaultHeading = defaultHeadingRef.current;

    if (!defaultHeading || !avatars.length) return;

    const defaultLetters = defaultHeading.querySelectorAll(".letter");
    gsap.set(defaultLetters, { y: "0%" });

    let avatarHandlers = [];
    let handleContainerEnter = null;
    let handleContainerLeave = null;

    const enableHoverInteractions = () => {
      avatars.forEach((avatar, index) => {
        const nameElement = chefNames[index];
        if (!nameElement) return;

        const nameLetters = nameElement.querySelectorAll(".letter");

        const handleAvatarEnter = () => {
          gsap.to(avatar, {
            width: 120,
            height: 120,
            duration: 0.5,
            ease: "power4.out",
          });

          gsap.to(defaultLetters, {
            y: "-110%",
            duration: 0.75,
            ease: "power4.out",
            stagger: { each: 0.025, from: "center" },
          });

          gsap.to(nameLetters, {
            y: "0%",
            duration: 0.75,
            ease: "power4.out",
            stagger: { each: 0.025, from: "center" },
          });
        };

        const handleAvatarLeave = () => {
          gsap.to(avatar, {
            width: 70,
            height: 70,
            duration: 0.5,
            ease: "power4.out",
          });

          gsap.to(nameLetters, {
            y: "110%",
            duration: 0.75,
            ease: "power4.out",
            stagger: { each: 0.025, from: "center" },
          });
        };

        avatar.addEventListener("mouseenter", handleAvatarEnter);
        avatar.addEventListener("mouseleave", handleAvatarLeave);
        avatarHandlers.push({
          element: avatar,
          onEnter: handleAvatarEnter,
          onLeave: handleAvatarLeave,
        });
      });

      handleContainerEnter = () => {
        gsap.to(defaultLetters, {
          y: "-110%",
          duration: 0.75,
          ease: "power4.out",
          stagger: { each: 0.025, from: "center" },
        });
      };

      handleContainerLeave = () => {
        chefNames.forEach((name) => {
          const letters = name.querySelectorAll(".letter");
          gsap.to(letters, {
            y: "110%",
            duration: 0.75,
            ease: "power4.out",
            stagger: { each: 0.025, from: "center" },
          });
        });

        gsap.to(defaultLetters, {
          y: "0%",
          duration: 0.75,
          ease: "power4.out",
          stagger: { each: 0.025, from: "center" },
        });
      };

      avatarContainer.addEventListener("mouseenter", handleContainerEnter);
      avatarContainer.addEventListener("mouseleave", handleContainerLeave);
    };

    const disableHoverInteractions = () => {
      avatarHandlers.forEach(({ element, onEnter, onLeave }) => {
        element.removeEventListener("mouseenter", onEnter);
        element.removeEventListener("mouseleave", onLeave);
      });
      avatarHandlers = [];

      if (handleContainerEnter) {
        avatarContainer.removeEventListener("mouseenter", handleContainerEnter);
        handleContainerEnter = null;
      }
      if (handleContainerLeave) {
        avatarContainer.removeEventListener("mouseleave", handleContainerLeave);
        handleContainerLeave = null;
      }

      // Reset all letters and avatar sizes to default state
      gsap.set(defaultLetters, { y: "0%" });
      chefNames.forEach((name) => {
        const letters = name.querySelectorAll(".letter");
        gsap.set(letters, { y: "110%" });
      });
      avatars.forEach((avatar) => {
        gsap.set(avatar, { clearProps: "width,height" });
      });
    };

    let wasDesktop = window.innerWidth >= MOBILE_BREAKPOINT;

    const handleResize = () => {
      const isDesktop = window.innerWidth >= MOBILE_BREAKPOINT;
      if (isDesktop !== wasDesktop) {
        wasDesktop = isDesktop;
        if (isDesktop) {
          enableHoverInteractions();
        } else {
          disableHoverInteractions();
        }
      }
    };

    if (wasDesktop) {
      enableHoverInteractions();
    }

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      disableHoverInteractions();
    };
  }, []);

  return (
    <section className="chefs" ref={sectionRef}>
      <div className="chefs-avatars" ref={avatarContainerRef}>
        {CHEFS.map((chef, index) => (
          <div
            className="chefs-avatar"
            key={index}
            ref={(el) => (avatarRefs.current[index] = el)}
          >
            <img src={chef.image} alt={chef.name} />
          </div>
        ))}
      </div>

      <div className="chefs-names">
        <div className="chefs-name chefs-name--default" ref={defaultHeadingRef}>
          <SplitChars text="The Chefs" />
        </div>
        {CHEFS.map((chef, index) => (
          <div
            className="chefs-name"
            key={index}
            ref={(el) => (chefNameRefs.current[index] = el)}
          >
            <SplitChars text={chef.name} />
          </div>
        ))}
      </div>

      <div className="section-footer">
        <p className="sm">Craft & Technique</p>
        <p className="sm">Fire & Form</p>
      </div>
    </section>
  );
};

export default Chefs;
