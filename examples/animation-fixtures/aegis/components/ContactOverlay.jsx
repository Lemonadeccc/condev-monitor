"use client";

import { useCallback, useEffect, useRef } from "react";
import { FlickerText, RiseText } from "./AnimatedText";
import { HudOrnament } from "./HudOrnament";
import { gsap, useGSAP } from "@/lib/gsapClient";
import { useReducedMotion } from "@/lib/useReducedMotion";

function TwitterIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
        fill="currentColor"
      />
    </svg>
  );
}

function SocialLink({ social }) {
  return (
    <a
      aria-label={social.label}
      className="contact-overlay__social hud-btn"
      href={social.href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span
        aria-hidden="true"
        className="hud-button__surface contact-overlay__social-surface"
      >
        <span className="hud-button__dotgrid" />
        <span className="hud-button__scan hud-scan" />
      </span>
      <span className="contact-overlay__social-icon">
        <TwitterIcon />
      </span>
      <svg
        aria-hidden="true"
        className="contact-overlay__social-border"
        width="44"
        height="44"
      >
        <path
          className="hud-btn-border"
          d="M 0.625 0.625 L 35 0.625 L 43.375 9 L 43.375 43.375 L 9 43.375 L 0.625 35 Z"
          fill="none"
          strokeWidth="1.25"
        />
      </svg>
    </a>
  );
}

export function ContactOverlay({ copy, onClose }) {
  const overlayRef = useRef(null);
  const closingRef = useRef(false);
  const reduceMotion = useReducedMotion();

  useGSAP(
    () => {
      if (reduceMotion) {
        return;
      }

      gsap.fromTo(
        overlayRef.current,
        { opacity: 0 },
        {
          opacity: 1,
          duration: 0.6,
          ease: "power2.out",
        }
      );
    },
    { dependencies: [reduceMotion], scope: overlayRef }
  );

  const handleClose = useCallback(() => {
    if (closingRef.current) {
      return;
    }

    closingRef.current = true;

    if (reduceMotion) {
      onClose();
      return;
    }

    gsap.to(overlayRef.current, {
      opacity: 0,
      duration: 0.4,
      ease: "power2.in",
      onComplete: onClose,
    });
  }, [onClose, reduceMotion]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleClose]);

  return (
    <div
      ref={overlayRef}
      className="contact-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="contact-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
    >
      <HudOrnament
        bevels
        className="contact-overlay__frame"
        corners={false}
      />
      <div className="contact-overlay__content">
        <RiseText
          as="p"
          className="contact-overlay__kicker"
          delay={0.25}
          y={8}
        >
          {copy.kicker}
        </RiseText>
        <FlickerText
          as="h2"
          className="contact-overlay__title"
          delay={0.4}
          text={copy.title}
        />
        <div className="contact-overlay__body">
          <RiseText as="p" delay={1}>
            {copy.body}
          </RiseText>
          <RiseText
            as="p"
            className="contact-overlay__body-secondary"
            delay={1.25}
          >
            {copy.body2}
          </RiseText>
        </div>
        <RiseText
          as="div"
          className="contact-overlay__socials"
          delay={1.5}
        >
          {copy.socials.map((social) => (
            <SocialLink key={social.label} social={social} />
          ))}
        </RiseText>
      </div>
      <button
        className="contact-overlay__dismiss"
        type="button"
        onClick={handleClose}
      >
        <RiseText as="span" delay={1.6} y={6}>
          {copy.dismiss}
        </RiseText>
      </button>
    </div>
  );
}
