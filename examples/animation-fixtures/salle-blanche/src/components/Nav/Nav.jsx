"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useLenis } from "lenis/react";
import gsap from "gsap";

import { useViewTransition } from "@/hooks/useViewTransition";

import "./Nav.css";

const NAV_LINKS = [
  { label: "Home", href: "/", img: "/menu/menu-home.jpg" },
  { label: "Essence", href: "/about", img: "/menu/menu-essence.jpg" },
  { label: "Carte", href: "/menu", img: "/menu/menu-carte.jpg" },
  { label: "Book", href: "/reservation", img: "/menu/menu-book.jpg" },
];

const SOCIAL_LINKS = [
  { label: "Instagram", href: "#" },
  { label: "Google", href: "#" },
  { label: "OpenTable", href: "#" },
];

const LINK_TEXT_SELECTORS = [".nav-link a", ".nav-social a"];
const FOOTER_TEXT_SELECTORS = [".nav-menu-footer p span"];
const ALL_TEXT_SELECTORS = [...LINK_TEXT_SELECTORS, ...FOOTER_TEXT_SELECTORS];

export default function Nav({ pageRef }) {
  const pathname = usePathname();
  const lenis = useLenis();
  const { navigateWithTransition } = useViewTransition();

  const lenisInstanceRef = useRef(null);
  const isMenuOpenRef = useRef(false);
  const isMenuAnimatingRef = useRef(false);
  const previewImageRef = useRef(null);

  useEffect(() => {
    lenisInstanceRef.current = lenis;
  }, [lenis]);

  useEffect(() => {
    if (isMenuOpenRef.current) forceCloseMenu();
  }, [pathname]);

  function lockScroll() {
    if (lenisInstanceRef.current) lenisInstanceRef.current.stop();
    document.body.style.overflow = "hidden";
  }

  function unlockScroll() {
    document.body.style.overflow = "";
    if (lenisInstanceRef.current) lenisInstanceRef.current.start();
  }

  function prunePreviewImages() {
    const container = previewImageRef.current;
    if (!container) return;
    const images = container.querySelectorAll("img");
    if (images.length > 3) {
      for (let i = 0; i < images.length - 3; i++) {
        container.removeChild(images[i]);
      }
    }
  }

  function resetPreviewImage() {
    const container = previewImageRef.current;
    if (!container) return;
    container.innerHTML = "";
    const defaultImg = document.createElement("img");
    defaultImg.src = NAV_LINKS[0].img;
    container.appendChild(defaultImg);
  }

  function killMenuTextTweens() {
    gsap.killTweensOf(ALL_TEXT_SELECTORS);
  }

  function resetMenuTextToHidden() {
    gsap.set(LINK_TEXT_SELECTORS, { y: "140%", opacity: 0.25 });
    gsap.set(FOOTER_TEXT_SELECTORS, { y: "120%", opacity: 0.25 });
  }

  function animateToggleLabel(isOpening) {
    const openLabel = document.querySelector("#nav-toggle-open");
    const closeLabel = document.querySelector("#nav-toggle-close");

    gsap.to(isOpening ? openLabel : closeLabel, {
      x: -5,
      y: isOpening ? -10 : 10,
      rotation: isOpening ? -5 : 5,
      opacity: 0,
      delay: 0.25,
      duration: 0.5,
      ease: "power2.out",
    });

    gsap.to(isOpening ? closeLabel : openLabel, {
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      delay: 0.5,
      duration: 0.5,
      ease: "power2.out",
    });
  }

  function openMenu() {
    if (isMenuAnimatingRef.current || isMenuOpenRef.current) return;
    isMenuAnimatingRef.current = true;

    const page = pageRef?.current;
    const scrollY = window.scrollY;

    lockScroll();

    if (page) {
      page.style.transformOrigin = `right ${scrollY}px`;

      gsap.to(page, {
        rotation: 10,
        x: 300,
        y: 450,
        scale: 1.5,
        duration: 1.25,
        ease: "power4.inOut",
      });
    }

    animateToggleLabel(true);
    killMenuTextTweens();
    resetMenuTextToHidden();

    gsap.to(".nav-menu-content", {
      rotation: 0,
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
      duration: 1.25,
      ease: "power4.inOut",
    });

    gsap.to(ALL_TEXT_SELECTORS, {
      y: "0%",
      opacity: 1,
      delay: 0.75,
      duration: 1,
      ease: "power3.out",
      stagger: 0.1,
    });

    gsap.to(".nav-menu-overlay", {
      clipPath: "polygon(0% 0%, 100% 0%, 100% 175%, 0% 100%)",
      duration: 1.25,
      ease: "power4.inOut",
      onComplete: () => {
        isMenuOpenRef.current = true;
        isMenuAnimatingRef.current = false;
      },
    });
  }

  function closeMenu() {
    if (isMenuAnimatingRef.current || !isMenuOpenRef.current) return;
    isMenuAnimatingRef.current = true;

    const page = pageRef?.current;

    if (page) {
      gsap.to(page, {
        rotation: 0,
        x: 0,
        y: 0,
        scale: 1,
        duration: 1.25,
        ease: "power4.inOut",
        onComplete: () => {
          gsap.set(page, { clearProps: "all" });
          page.style.transformOrigin = "";
        },
      });
    }

    animateToggleLabel(false);
    killMenuTextTweens();

    gsap.to(".nav-menu-content", {
      rotation: -15,
      x: -100,
      y: -100,
      scale: 1.5,
      opacity: 0.25,
      duration: 1.25,
      ease: "power4.inOut",
    });

    gsap.to(".nav-menu-overlay", {
      clipPath: "polygon(0% 0%, 100% 0%, 100% 0%, 0% 0%)",
      duration: 1.25,
      ease: "power4.inOut",
      onComplete: () => {
        isMenuOpenRef.current = false;
        isMenuAnimatingRef.current = false;
        resetMenuTextToHidden();
        resetPreviewImage();
        unlockScroll();
      },
    });
  }

  function forceCloseMenu() {
    const page = pageRef?.current;
    if (page) {
      gsap.set(page, { clearProps: "all" });
      page.style.transformOrigin = "";
    }

    killMenuTextTweens();

    gsap.set(".nav-menu-overlay", {
      clipPath: "polygon(0% 0%, 100% 0%, 100% 0%, 0% 0%)",
    });
    gsap.set(".nav-menu-content", {
      rotation: -15,
      x: -100,
      y: -100,
      scale: 1.5,
      opacity: 0.25,
    });

    resetMenuTextToHidden();

    gsap.set("#nav-toggle-open", { x: 0, y: 0, rotation: 0, opacity: 1 });
    gsap.set("#nav-toggle-close", { x: -5, y: 10, rotation: 5, opacity: 0 });

    isMenuOpenRef.current = false;
    isMenuAnimatingRef.current = false;
    resetPreviewImage();
    unlockScroll();
  }

  function handleToggle() {
    if (!isMenuOpenRef.current) openMenu();
    else closeMenu();
  }

  function handleLinkHover(imageSrc) {
    if (!isMenuOpenRef.current || isMenuAnimatingRef.current) return;
    const container = previewImageRef.current;
    if (!container || !imageSrc) return;

    const currentImages = container.querySelectorAll("img");
    if (
      currentImages.length > 0 &&
      currentImages[currentImages.length - 1].src.endsWith(imageSrc)
    )
      return;

    const newImg = document.createElement("img");
    newImg.src = imageSrc;
    newImg.style.opacity = "0";
    newImg.style.transform = "scale(1.25) rotate(10deg)";
    container.appendChild(newImg);
    prunePreviewImages();

    gsap.to(newImg, {
      opacity: 1,
      scale: 1,
      rotation: 0,
      duration: 0.75,
      ease: "power2.out",
    });
  }

  return (
    <>
      <nav className="nav-bar">
        <div className="nav-logo">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigateWithTransition("/");
            }}
          >
            <svg
              width="771"
              height="336"
              viewBox="0 0 771 336"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M101.2 111.802C101.2 138.802 83.0002 160.602 48.6002 160.602C32.2002 160.602 13.0002 156.402 0.000194997 152.002L16.4002 107.202H17.4002C25.4002 134.002 37.4002 152.602 58.2002 152.602C73.4002 152.602 81.8002 141.002 81.8002 129.202C81.8002 113.602 66.6002 107.202 50.2002 99.4016C31.4002 90.4016 11.2002 79.4016 11.2002 50.2016C11.2002 25.2016 29.0002 4.60155 59.4002 4.60155C71.4002 4.60155 83.6002 6.20156 94.4002 8.60155L83.4002 47.8016H82.4002C76.0002 28.0016 63.6002 12.6016 49.2002 12.6016C39.0002 12.6016 31.0002 21.0016 31.0002 32.6016C31.0002 50.0016 49.6002 56.0016 67.8002 65.2016C84.8002 73.8016 101.2 85.4016 101.2 111.802ZM130.424 157.002V157.602H94.6236V157.002C100.224 154.402 107.424 144.402 111.624 132.402L155.424 6.60155H157.824L203.024 132.002C208.624 147.602 213.024 154.002 218.824 157.002V157.602H160.424V157.002C166.624 153.802 171.624 145.402 167.024 131.802L161.024 113.802H126.024L119.824 132.202C115.624 144.802 124.424 153.802 130.424 157.002ZM128.624 105.802H158.224L143.424 62.0016L128.624 105.802ZM280.227 157.602H213.027V157.002C219.227 153.802 224.427 148.202 224.427 136.402V28.8016C224.427 19.0016 220.627 11.6016 213.027 8.20155V7.60155H267.827V8.20155C260.227 11.6016 256.427 19.0016 256.427 28.8016V136.602C256.427 147.202 260.427 152.002 267.027 152.002C278.427 152.002 294.227 131.602 308.427 112.402L309.227 112.802L299.027 165.202H298.427C294.027 160.202 288.027 157.602 280.227 157.602ZM376.516 157.602H309.316V157.002C315.516 153.802 320.716 148.202 320.716 136.402V28.8016C320.716 19.0016 316.916 11.6016 309.316 8.20155V7.60155H364.116V8.20155C356.516 11.6016 352.716 19.0016 352.716 28.8016V136.602C352.716 147.202 356.716 152.002 363.316 152.002C374.716 152.002 390.516 131.602 404.716 112.402L405.516 112.802L395.316 165.202H394.716C390.316 160.202 384.316 157.602 376.516 157.602ZM405.605 7.60155H481.605C489.405 7.60155 496.205 5.00156 500.005 0.00155306H500.605L508.005 49.4016L507.205 49.8016C493.605 29.8016 480.805 13.2016 462.005 13.2016C453.605 13.2016 448.805 18.0016 448.805 28.6016V72.6016H466.205C477.205 72.6016 487.005 68.0016 495.205 54.0016H495.805V98.8016H495.205C486.405 86.8016 477.205 79.6016 466.405 79.6016H448.805V136.602C448.805 147.202 453.605 152.002 462.005 152.002C482.205 152.002 496.605 134.002 511.805 112.602L512.405 112.802L502.205 165.202H501.205C497.005 160.202 491.205 157.602 483.405 157.602H405.605V157.002C411.805 153.802 417.005 148.202 417.005 136.402V28.8016C417.005 19.0016 413.205 11.6016 405.605 8.20155V7.60155ZM117.6 288.002C117.6 312.602 97.0002 329.602 58.0002 329.602C39.8002 329.602 23.0002 328.202 5.8002 325.602V325.002C13.4002 321.602 17.2002 314.202 17.2002 304.402V200.602C17.2002 190.802 13.4002 183.602 5.8002 180.202V179.602C22.0002 177.002 38.2002 175.602 55.4002 175.602C90.8002 175.602 109 188.402 109 207.202C109 227.202 92.2002 239.202 73.6002 243.402C96.2002 248.002 117.6 262.802 117.6 288.002ZM49.0002 196.602V239.802H53.2002C67.6002 239.802 75.8002 228.802 75.8002 210.202C75.8002 192.802 69.0002 182.002 58.2002 182.002C52.2002 182.002 49.0002 187.202 49.0002 196.602ZM49.0002 308.602C49.0002 318.002 53.0002 323.202 60.6002 323.202C73.8002 323.202 82.4002 307.602 82.4002 283.402C82.4002 260.402 72.0002 247.202 53.2002 247.202H49.0002V308.602ZM188.039 327.602H120.839V327.002C127.039 323.802 132.239 318.202 132.239 306.402V198.802C132.239 189.002 128.439 181.602 120.839 178.202V177.602H175.639V178.202C168.039 181.602 164.239 189.002 164.239 198.802V306.602C164.239 317.202 168.239 322.002 174.839 322.002C186.239 322.002 202.039 301.602 216.239 282.402L217.039 282.802L206.839 335.202H206.239C201.839 330.202 195.839 327.602 188.039 327.602ZM243.705 327.002V327.602H207.905V327.002C213.505 324.402 220.705 314.402 224.905 302.402L268.705 176.602H271.105L316.305 302.002C321.905 317.602 326.305 324.002 332.105 327.002V327.602H273.705V327.002C279.905 323.802 284.905 315.402 280.305 301.802L274.305 283.802H239.305L233.105 302.202C228.905 314.802 237.705 323.802 243.705 327.002ZM241.905 275.802H271.505L256.705 232.002L241.905 275.802ZM423.308 204.802V331.602H422.908L345.708 219.402V300.402C345.708 312.802 350.508 323.202 357.908 327.002V327.602H325.708V327.002C332.908 323.202 337.708 312.802 337.708 300.402V198.802C337.708 191.002 333.908 181.602 326.308 178.202V177.602H358.708L415.308 262.002V204.802C415.308 195.602 412.308 182.202 403.508 178.202V177.602H433.908V178.202C426.108 181.802 423.308 195.602 423.308 204.802ZM499.278 174.602C514.478 174.602 527.478 177.602 535.878 181.402L516.878 230.202H516.478C510.078 200.802 500.478 183.402 487.278 183.402C472.878 183.402 464.278 205.402 464.278 235.402C464.278 276.402 479.078 302.202 502.878 302.202C517.078 302.202 528.278 293.202 534.478 275.202L535.478 275.402C532.078 313.202 511.078 330.602 488.478 330.602C460.878 330.602 437.878 301.602 437.878 255.202C437.878 210.002 465.878 174.602 499.278 174.602ZM592.631 327.002V327.602H537.831V327.002C544.031 323.802 549.231 316.202 549.231 306.402V198.802C549.231 191.002 545.431 181.602 537.831 178.202V177.602H592.631V178.202C585.031 181.602 581.231 191.002 581.231 198.802V230.802H616.631V198.802C616.631 191.002 612.631 181.602 605.231 178.202V177.602H660.231V178.202C652.631 181.602 648.631 191.002 648.631 198.802V306.402C648.631 316.202 653.831 323.802 660.231 327.002V327.602H605.231V327.002C611.231 323.802 616.631 316.202 616.631 306.402V237.802H581.231V306.402C581.231 316.202 586.231 323.802 592.631 327.002ZM663.417 177.602H739.417C747.217 177.602 754.017 175.002 757.817 170.002H758.417L765.817 219.402L765.017 219.802C751.417 199.802 738.617 183.202 719.817 183.202C711.417 183.202 706.617 188.002 706.617 198.602V242.602H724.017C735.017 242.602 744.817 238.002 753.017 224.002H753.617V268.802H753.017C744.217 256.802 735.017 249.602 724.217 249.602H706.617V306.602C706.617 317.202 711.417 322.002 719.817 322.002C740.017 322.002 754.417 304.002 769.617 282.602L770.217 282.802L760.017 335.202H759.017C754.817 330.202 749.017 327.602 741.217 327.602H663.417V327.002C669.617 323.802 674.817 318.202 674.817 306.402V198.802C674.817 189.002 671.017 181.602 663.417 178.202V177.602Z"
                fill="#E0DED1"
              />
            </svg>
          </a>
        </div>

        <div className="nav-toggle" onClick={handleToggle}>
          <p id="nav-toggle-open">Menu</p>
          <p id="nav-toggle-close">Close</p>
        </div>
      </nav>

      <div className="nav-menu-overlay">
        <div className="nav-menu-content">
          <div className="nav-menu-items">
            <div className="nav-col-lg">
              <div className="nav-preview-img" ref={previewImageRef}>
                <img src={NAV_LINKS[0].img} alt="" />
              </div>
            </div>

            <div className="nav-col-sm">
              <div className="nav-menu-links">
                {NAV_LINKS.map((link) => (
                  <div className="nav-link" key={link.label}>
                    <a
                      href={link.href}
                      data-img={link.img}
                      onMouseOver={() => handleLinkHover(link.img)}
                      onClick={(e) => {
                        e.preventDefault();
                        navigateWithTransition(link.href);
                      }}
                    >
                      {link.label}
                    </a>
                  </div>
                ))}
              </div>

              <div className="nav-menu-socials">
                {SOCIAL_LINKS.map((social) => (
                  <div className="nav-social" key={social.label}>
                    <a href={social.href}>{social.label}</a>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="nav-menu-footer">
            <p className="sm">
              <span>Since 1984</span>
            </p>
            <p className="sm">
              <span>Florence, IT</span>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
